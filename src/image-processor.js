/**
 * Core orchestration for one image-swap ticket -- mirrors ticket-processor.js's
 * shape, adapted for wf-image-updaterSKILL.md's flow (Steps 2-12).
 */

import { getTaskDetails } from './bugherd-client.js';
import { routeImageTicket } from './image-router.js';
import { resolveImageItem } from './image-item-resolver.js';
import { getImageUrls, isCloudinaryFetchFailure } from './cloudinary.js';
import { getSiteContext, generateAltText } from './alt-text.js';
import { resolveImageFieldWithAI, learnImageFieldMapping, diagnoseRequest } from './ai-resolver.js';
import { lookupImageFieldSlug } from './image-field-mapper.js';
import { listCollections, listCollectionItems, getCollectionFields, updateCollectionItem } from './webflow-client.js';
import { passToQA, postComment, postCommentIfNew, applyImageSkipTreatment } from './linear-client.js';

const DRY_RUN = process.env.DRY_RUN === 'true';
const SUPPORTED_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
const DUAL_FIELD_TYPES = new Set(['programs-hero', 'header-sections']);
const ORIENTATION_TYPES = new Set(['programs-home']);
const TWO_STEP_TYPES = new Set(['coaches', 'chat-widget-logo']);
// One item per SITE (not per page) -- confirmed real shape: holds company info,
// about-us copy, images, etc. URL-slug/position/fileId matching don't apply here;
// there is only ever one item to target.
const SINGLETON_COLLECTIONS = new Set(['main templates']);

export function extractImageTicketFields(description = '') {
  const get = (label) => {
    const re = new RegExp(
      `\\*\\*${label}\\*\\*[:\\s]+(.*?)(?=\\n\\*\\*[^*]+\\*\\*[:\\s]|\\n#{1,6}\\s|$)`,
      'si'
    );
    const m = description.match(re);
    return m ? m[1].trim() : null;
  };
  const getUrl = (label) => {
    const raw = get(label);
    if (!raw) return null;
    const m = raw.match(/(https?:\/\/[^\s\]>)]+)/);
    return m ? m[1] : null;
  };

  const attachmentsSection = description.match(/###\s*Attachments\s*\n([\s\S]*?)(?=\n###\s|\n\*\*[^*]+\*\*[:\s]|$)/i);
  const attachmentsRaw = attachmentsSection?.[1] ?? '';
  const attachments = [...attachmentsRaw.matchAll(/\[([^\]]+)\]\(<?([^)>]+)>?\)/g)].map((m) => ({
    filename: m[1],
    url: m[2],
  }));

  const adminLink = get('Admin Link') ?? '';
  const bhMatch = adminLink.match(/projects\/(\d+)\/tasks\/(\d+)/);

  return {
    pageUrl: getUrl('Page URL'),
    description: get('Description') ?? '',
    selector: (get('Path') ?? '').replace(/^`+|`+$/g, '').trim() || null,
    // Some Linear tickets embed the HTML with backslash-escaped quotes
    // (src=\"...\" instead of src="...") -- normalize before any attribute regex runs.
    htmlSnapshot: get('HTML')?.replace(/\\"/g, '"') ?? null,
    attachments,
    bugherdProjectId: bhMatch?.[1] ?? null,
    bugherdTaskId: bhMatch?.[2] ?? null,
  };
}

export function isSupportedFormat(filename) {
  const ext = filename.split('.').pop()?.toLowerCase();
  return SUPPORTED_FORMATS.includes(ext);
}

function extractPrimaryClass(selector) {
  const matches = (selector ?? '').match(/\.([\w-]+)/g);
  return matches ? matches[matches.length - 1].slice(1) : null;
}

/** Match an image field by CSS class heuristic, mirroring cms-updater's matchFieldBySelector. */
function matchImageFieldBySelector(imageFields, selector) {
  const cssClass = extractPrimaryClass(selector);
  if (!cssClass) return null;
  const stripped = cssClass.replace(/-(wrapper|wrap|div|overlay)$/, '');
  return imageFields.find(
    (f) => f.slug === cssClass || f.slug === stripped || f.slug.replace(/-/g, '') === stripped.replace(/-/g, '')
  )?.slug ?? null;
}

function parseHelpTextDimensions(field) {
  const text = field?.helpText ?? field?.validations?.helpText ?? '';
  const m = text.match(/(\d+)\s*x\s*(\d+)/i);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

async function skip(ticket, existingLabelIds, reason) {
  // A skip never earns ai:edited, so label-agnostic batch discovery can rediscover
  // and reprocess the same ticket on a later run -- use the dedup-aware poster so
  // that doesn't produce duplicate comments (confirmed real, repeated live).
  await postCommentIfNew(ticket.id, reason, DRY_RUN);
  await applyImageSkipTreatment(ticket.id, existingLabelIds, DRY_RUN);
  return { outcome: 'skipped', ticket, reason };
}

/**
 * @param {object} ticket - Linear issue
 * @param {string} siteId
 * @param {string} wfToken
 * @param {string} wfShortName
 * @param {string} siteDisplayName - Webflow site display name, used as gymName fallback
 *   if the "Main templates" collection's company-name field isn't found
 * @param {Map} collectionsCache
 * @param {Map} fieldsCache - collectionId -> fields[]
 * @param {{ value: {companyName:string|null, cityState:string|null}|null }} siteContextCache - simple box, one per run
 */
export async function processImageTicket(ticket, siteId, wfToken, wfShortName, siteDisplayName, collectionsCache, fieldsCache, siteContextCache) {
  const existingLabelIds = ticket.labels?.nodes?.map((l) => l.id) ?? [];
  let fields = extractImageTicketFields(ticket.description ?? '');

  if ((!fields.selector || !fields.htmlSnapshot || !fields.pageUrl || fields.attachments.length === 0) && fields.bugherdProjectId) {
    const bh = await getTaskDetails(fields.bugherdProjectId, fields.bugherdTaskId);
    fields.selector = fields.selector || bh.selector;
    fields.htmlSnapshot = fields.htmlSnapshot || bh.htmlSnapshot;
    fields.pageUrl = fields.pageUrl || bh.pageUrl;
    if (fields.attachments.length === 0 && bh.attachments?.length) fields.attachments = bh.attachments;
  }

  if (!fields.pageUrl) {
    return skip(ticket, existingLabelIds, 'Warning: Automation skipped -- no Page URL found on ticket even after BugHerd fallback.');
  }

  const validAttachments = fields.attachments.filter((a) => isSupportedFormat(a.filename ?? a.url ?? ''));
  if (fields.attachments.length === 0) {
    return skip(ticket, existingLabelIds, 'Warning: Automation skipped -- no image attachment found on ticket.');
  }
  if (validAttachments.length === 0) {
    return skip(ticket, existingLabelIds, 'Warning: Automation skipped -- attachment is not a supported image format (jpg/jpeg/png/webp/gif).');
  }

  // AI diagnosis: confirm this is a genuine image swap on an EXISTING item --
  // not a request to add a brand-new program/item with its own photo (confirmed
  // real: "Add another service here called 'Hyrox'. Use the picture I have
  // attached." got matched to the closest existing item and overwrote its real
  // photo), and not an unrelated request that merely has a file attached for
  // reference (confirmed real, more damaging: "How do I change the Meta
  // description that shows up when I search on Google? See attached [screenshot]"
  // got its screenshot swapped in as the literal new homepage hero photo).
  // Allow-list, not deny-list: only proceed when the AI is confident this is a
  // genuine image swap ("literal") or when it's unavailable (falls through to
  // the existing selector/logo/embed heuristics below). Any other classification
  // (new_item, structural, not_visual, partial, ambiguous) means the description
  // doesn't actually describe a specific new photo to insert -- confirmed real
  // damage from letting anything but a clean "literal" through: bug reports,
  // SEO questions, and "add a new item" requests all got a random existing
  // item's photo silently overwritten.
  if (fields.description) {
    const diagnosis = await diagnoseRequest({ description: fields.description, htmlSnapshot: fields.htmlSnapshot, hasImageAttachment: true });
    if (diagnosis && diagnosis.type !== 'literal') {
      return skip(ticket, existingLabelIds, `⚠️ Automation skipped -- AI diagnosed this as a "${diagnosis.type}" request, not a genuine image swap. ${diagnosis.reason} Requires manual review.`);
    }
  }

  const selLower = (fields.selector ?? '').toLowerCase();
  const descLower = (fields.description ?? '').toLowerCase();
  if (descLower.includes('logo') || selLower.includes('nav-logo') || selLower.includes('navbar-brand')) {
    return skip(ticket, existingLabelIds, '⚠️ Automation skipped -- logo changes are not automatable. Requires manual Webflow Designer edit.');
  }
  if (selLower.includes('img-embed') && selLower.includes('w-embed')) {
    return skip(ticket, existingLabelIds, '⚠️ Automation skipped -- this image is rendered via a static HTML embed block (div.img-embed.w-embed) and is not connected to the Webflow CMS. Requires manual Designer edit.');
  }

  const route = routeImageTicket(fields.pageUrl, fields.selector ?? '');
  if (!route) {
    return skip(ticket, existingLabelIds, '⚠️ Automation skipped -- static element, not a CMS-bound image field. Requires manual Designer edit.');
  }

  const collectionKey = route.collection.toLowerCase();
  if (!collectionsCache.has(collectionKey)) {
    const all = await listCollections(siteId, wfToken);
    for (const c of all) {
      collectionsCache.set(c.displayName.toLowerCase(), c.id);
      collectionsCache.set(c.slug, c.id);
    }
  }
  // Case-insensitive: real collection names sometimes differ in casing from the
  // routing table (confirmed: "Main templates" vs the expected "Main Templates").
  const collectionId = collectionsCache.get(collectionKey);
  if (!collectionId) {
    return skip(ticket, existingLabelIds, `Collection "${route.collection}" not found in site.`);
  }

  const urlPath = new URL(fields.pageUrl).pathname;
  let item, method, detail;
  if (SINGLETON_COLLECTIONS.has(collectionKey)) {
    const items = await listCollectionItems(collectionId, wfToken);
    item = items[0] ?? null;
    method = 'singleton';
    detail = 'one item per site';
    if (!item) {
      return skip(ticket, existingLabelIds, `⚠️ Automation skipped -- no item found in singleton collection "${route.collection}".`);
    }
  } else {
    const resolved = await resolveImageItem({
      collectionId,
      token: wfToken,
      urlPath,
      selector: fields.selector ?? '',
      htmlSnapshot: fields.htmlSnapshot ?? '',
    });
    if (!resolved.item) {
      return skip(ticket, existingLabelIds, `⚠️ Automation skipped -- ${resolved.reason}`);
    }
    ({ item, method, detail } = resolved);
  }

  if (!item.lastPublished) {
    return skip(ticket, existingLabelIds, `⚠️ Automation skipped -- target item "${item.fieldData?.name ?? item.id}" has never been published (isDraft=true, no lastPublished). It should not appear in the live DOM. Requires manual review.`);
  }

  if (!fieldsCache.has(collectionId)) {
    fieldsCache.set(collectionId, await getCollectionFields(collectionId, wfToken));
  }
  const allFields = fieldsCache.get(collectionId);
  const imageFields = allFields.filter((f) => f.type === 'Image');

  const needsMobile = DUAL_FIELD_TYPES.has(route.imageType);

  // KB cache first -- skip class heuristic/AI entirely if we've resolved this exact
  // collection + image type + selector before. This cache is intentionally shared
  // ACROSS sites (templated gym sites, consistent field naming), which breaks down
  // on older/drifted sites whose schema no longer matches the template -- verify
  // the cached slug actually exists on THIS site's collection before trusting it
  // (same class of bug confirmed live in the text pipeline's field-mappings.json).
  let kbMatch = lookupImageFieldSlug(route.collection, route.imageType, fields.selector);
  if (kbMatch && !imageFields.some((f) => f.slug === kbMatch.primary)) {
    console.log(`  KB hit "${kbMatch.primary}" does not exist on this site's "${route.collection}" collection -- discarding, re-resolving.`);
    kbMatch = null;
  }
  let primarySlug = kbMatch?.primary ?? matchImageFieldBySelector(imageFields, fields.selector);
  let mobileSlug = kbMatch?.mobile ?? (needsMobile
    ? imageFields.find((f) => f.slug !== primarySlug && f.slug.includes('mobile'))?.slug ?? null
    : null);

  // Programs collections commonly have 3 image-ish fields (image, image-mobile,
  // program-image-home) that the class/id heuristic can't reliably tell apart from
  // selector alone -- confirmed the AI fallback is inconsistent here too (picks the
  // hero's own image/image-mobile instead). The homepage grid display field always
  // signals "home" in its slug -- prefer that deterministically for this image type.
  if (!kbMatch && !primarySlug && route.imageType === 'programs-home') {
    primarySlug = imageFields.find((f) => f.slug.includes('home'))?.slug ?? null;
  }

  if (!primarySlug) {
    const aiResult = await resolveImageFieldWithAI(
      route.collection, allFields, fields.selector ?? '', fields.htmlSnapshot ?? '', fields.description, needsMobile
    );
    if (!aiResult) {
      return skip(ticket, existingLabelIds, `⚠️ Automation skipped -- could not identify target image field with sufficient confidence for collection "${route.collection}" + selector "${fields.selector}".`);
    }
    primarySlug = aiResult.primary;
    mobileSlug = aiResult.mobile ?? mobileSlug;
  }

  if (!kbMatch) {
    learnImageFieldMapping(route.collection, route.imageType, fields.selector, primarySlug, mobileSlug);
  }

  let orientation;
  if (ORIENTATION_TYPES.has(route.imageType)) {
    const targetField = allFields.find((f) => f.slug === primarySlug);
    const dims = parseHelpTextDimensions(targetField);
    orientation = dims && dims.height > dims.width ? 'portrait' : 'landscape';
  }

  const attachmentUrl = validAttachments[0].url;
  if (!siteContextCache.value) {
    siteContextCache.value = await getSiteContext(siteId, wfToken, collectionsCache).catch(() => ({ companyName: null, cityState: null }));
  }
  const { companyName, cityState } = siteContextCache.value;
  const gymName = companyName ?? siteDisplayName;
  const altText = generateAltText(route.imageType, { gymName, cityState, itemName: item.fieldData?.name });

  const helpTextDimensions = parseHelpTextDimensions(allFields.find((f) => f.slug === primarySlug));
  const urls = getImageUrls(attachmentUrl, route.imageType, { orientation, helpTextDimensions });

  const oldValues = {
    primary: item.fieldData?.[primarySlug] ?? null,
    mobile: mobileSlug ? item.fieldData?.[mobileSlug] ?? null : null,
  };

  const queuedComment = [
    '🤖 **Image Swap Queued**',
    `**Page:** ${fields.pageUrl}`,
    `**Collection:** ${route.collection} → **Field(s):** ${primarySlug}${mobileSlug ? `, ${mobileSlug}` : ''}`,
    `**Item:** ${item.fieldData?.name ?? item.id}`,
    method === 'position' || method === 'fileId' || method === 'context' ? `**Identified by:** ${detail}` : null,
    `**Image type:** ${route.imageType}`,
    `**Alt text:** ${altText}`,
    'Applying now...',
  ].filter(Boolean).join('\n');
  await postComment(ticket.id, queuedComment, DRY_RUN);

  const itemLevel = { isDraft: false };
  let updateResult;
  let fetchFailed = false;

  if (route.imageType === 'blog-rich-text') {
    const richField = allFields.find((f) => f.type === 'RichText');
    if (!richField) {
      return skip(ticket, existingLabelIds, '⚠️ Automation skipped -- no rich text field found for blog body image replacement.');
    }
    const currentHtml = item.fieldData?.[richField.slug] ?? '';
    const newHtml = currentHtml.replace(/<img[^>]+src=["'][^"']+["']/i, (m) => m.replace(/src=["'][^"']+["']/i, `src="${urls.single}"`));
    updateResult = await updateCollectionItem(collectionId, item.id, { [richField.slug]: newHtml }, wfToken, DRY_RUN, itemLevel);
  } else if (needsMobile) {
    updateResult = await updateCollectionItem(
      collectionId, item.id,
      { [primarySlug]: { url: urls.desktop, alt: altText }, [mobileSlug]: { url: urls.mobile, alt: altText } },
      wfToken, DRY_RUN, itemLevel
    );
    if (!DRY_RUN) {
      fetchFailed = isCloudinaryFetchFailure(updateResult.fieldData?.[primarySlug], updateResult.fieldData?.[mobileSlug]);
    }
  } else {
    updateResult = await updateCollectionItem(
      collectionId, item.id, { [primarySlug]: { url: urls.single, alt: altText } }, wfToken, DRY_RUN, itemLevel
    );
  }

  if (fetchFailed) {
    return skip(ticket, existingLabelIds, [
      '⚠️ Automation skipped -- Cloudinary fetch failed for BugHerd source URL.',
      'The file may be too large (>15MB), access-restricted, or blocked for Cloudinary\'s servers.',
      'Manual fix required: download the attachment from BugHerd and upload directly in the Webflow CMS editor.',
      `old image url: ${oldValues.primary?.url ?? '(none)'}`,
    ].join('\n'));
  }

  // Two-step types: patch the paired display text/link field with the resulting CDN URL.
  if (TWO_STEP_TYPES.has(route.imageType)) {
    const srcField = allFields.find((f) => ['PlainText', 'Link'].includes(f.type) && /src|url/i.test(f.slug) && f.slug !== primarySlug);
    if (srcField) {
      const cdnUrl = DRY_RUN ? '[dry-run: no real CDN url yet]' : updateResult.fieldData?.[primarySlug]?.url;
      await updateCollectionItem(collectionId, item.id, { [srcField.slug]: cdnUrl }, wfToken, DRY_RUN);
    } else {
      console.warn(`  Two-step type "${route.imageType}" but no paired src/url field found on collection "${route.collection}" -- skipping step 2.`);
    }
  }

  // New URLs come from Webflow's own response after it ingests the Cloudinary URL --
  // that's where the real, final hosted CDN URL lives (Webflow auto-fetches and
  // hosts external image URLs on PATCH; no separate upload step needed).
  const oldUrlLine = needsMobile
    ? `**Old image URL(s):** desktop: ${oldValues.primary?.url ?? '(none)'} | mobile: ${oldValues.mobile?.url ?? '(none)'}`
    : `**Old image URL:** ${oldValues.primary?.url ?? '(none)'}`;
  const newUrlLine = needsMobile
    ? `**New image URL(s):** desktop: ${updateResult.fieldData?.[primarySlug]?.url ?? urls.desktop} | mobile: ${updateResult.fieldData?.[mobileSlug]?.url ?? urls.mobile}`
    : `**New image URL:** ${updateResult.fieldData?.[primarySlug]?.url ?? urls.single}`;

  const resultComment = [
    '✅ **Image Swap Applied**',
    `**Collection:** ${route.collection} → **Field(s):** ${primarySlug}${mobileSlug ? `, ${mobileSlug}` : ''}`,
    `**Item:** ${item.fieldData?.name ?? item.id}`,
    `**Alt text:** ${altText}`,
    oldUrlLine,
    newUrlLine,
    '(Revert by pasting the old image URL back into the field in the Webflow CMS editor if needed.)',
    `**Staging URL:** https://${wfShortName}.webflow.io${urlPath}`,
    '**Published to:** Staging (webflow.io subdomain only)',
    `**Applied at:** ${new Date().toISOString()}`,
    '',
    'Please verify crops on staging before publishing to live.',
  ].join('\n');
  await postComment(ticket.id, resultComment, DRY_RUN);
  await passToQA(ticket.id, existingLabelIds, DRY_RUN);

  return { outcome: 'updated', ticket, details: { route, item, primarySlug, mobileSlug, urls, updateResult, oldValues }, fields };
}
