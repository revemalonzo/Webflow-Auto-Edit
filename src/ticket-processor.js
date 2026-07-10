/**
 * Core orchestration -- processes a single ticket end-to-end.
 *
 * Steps mirror SKILL.md:
 *   Step 2  -- extract fields, BugHerd fallback
 *   Step 2b -- pre-flight skip checks
 *   Router  -- CMS or static path
 *   Step 5/5b/6 -- update
 *   Step 8  -- Linear update
 */

import { getTaskDetails } from './bugherd-client.js';
import { routeTicket, resolvePageTemplateCollection } from './router.js';
import { checkSkipConditions } from './skip-checker.js';
import { isStaticSkip } from './field-mapper.js';
import { updateCmsField, updateCmsLinkTarget } from './cms-updater.js';
import { updateStaticElement, BRIDGE_APP_REQUIRED_MSG } from './static-updater.js';
import { diagnoseRequest } from './ai-resolver.js';
import { passToQA, applySkipTreatment, postComment, postCommentIfNew } from './linear-client.js';

const DRY_RUN = process.env.DRY_RUN === 'true';

/**
 * Strip a single matching pair of leading/trailing quote marks. Requesters
 * commonly wrap literal replacement text in quotes as a delineation convention
 * (e.g. "Join us for..."); confirmed real damage from writing those quote
 * characters verbatim into live CMS fields. This is a cheap fallback for when
 * diagnoseRequest (AI) is unavailable -- when it IS available, its cleanValue
 * already has this handled.
 */
function stripWrappingQuotes(s) {
  if (!s) return s;
  const trimmed = s.trim();
  const m = trimmed.match(/^["“](.*)["”]$/s);
  return m ? m[1].trim() : trimmed;
}

/**
 * Extract structured fields from a Linear ticket's description (markdown).
 * Fields are formatted as: **Field Name**: value (possibly multi-line until next **Field**)
 */
function extractTicketFields(description = '') {
  const get = (label) => {
    const re = new RegExp(
      `\\*\\*${label}\\*\\*[:\\s]+(.*?)(?=\\n\\*\\*[^*]+\\*\\*[:\\s]|\\n#{1,6}\\s|$)`,
      'si'
    );
    const m = description.match(re);
    return m ? m[1].trim() : null;
  };

  // Strip Markdown link format [text](<url>) or [text](url) → bare URL
  const getUrl = (label) => {
    const raw = get(label);
    if (!raw) return null;
    const m = raw.match(/(https?:\/\/[^\s\]>)]+)/);
    return m ? m[1] : null;
  };

  const adminLink = get('Admin Link') ?? '';
  const bhMatch = adminLink.match(/projects\/(\d+)\/tasks\/(\d+)/);

  return {
    pageUrl: getUrl('Page URL'),
    // Raw as submitted -- diagnoseRequest (AI) below decides whether this is
    // literal replacement text (and cleans it) or something else entirely.
    newValue: get('Description') ?? get('New Value') ?? get('New Text'),
    selector: (get('Path') ?? '').replace(/^`+|`+$/g, '').trim() || null,
    // Some Linear tickets embed the HTML with backslash-escaped quotes
    // (src=\"...\" instead of src="...") -- normalize before any attribute regex runs.
    htmlSnapshot: get('HTML')?.replace(/\\"/g, '"') ?? null,
    bugherdProjectId: bhMatch?.[1] ?? null,
    bugherdTaskId: bhMatch?.[2] ?? null,
  };
}

/**
 * Process one ticket.
 *
 * @param {object} ticket          - Linear issue object
 * @param {string} siteId
 * @param {string} wfToken         - Webflow token that can access the site
 * @param {string} wfShortName     - webflow.io subdomain (for staging URLs)
 * @param {Map}    collectionsCache
 * @param {Map}    pagesCache
 * @returns {{ outcome: 'updated'|'skipped'|'error', ticket, details }}
 */
export async function processTicket(ticket, siteId, wfToken, wfShortName, collectionsCache, pagesCache) {
  const existingLabelIds = ticket.labels?.nodes?.map((l) => l.id) ?? [];
  let fields = extractTicketFields(ticket.description);

  // BugHerd fallback for missing data
  if ((!fields.selector || !fields.htmlSnapshot || !fields.pageUrl) && fields.bugherdProjectId) {
    const bh = await getTaskDetails(fields.bugherdProjectId, fields.bugherdTaskId);
    fields.selector = fields.selector || bh.selector;
    fields.htmlSnapshot = fields.htmlSnapshot || bh.htmlSnapshot;
    fields.pageUrl = fields.pageUrl || bh.pageUrl;
  }

  // Bail if still missing critical data
  if (!fields.pageUrl) {
    return await skip(ticket, existingLabelIds, `Warning: Automation skipped -- no Page URL found on ticket even after BugHerd fallback.`);
  }
  if (!fields.newValue) {
    return await skip(ticket, existingLabelIds, `Warning: Automation skipped -- no new value found on ticket.`);
  }

  // AI diagnosis: confirm the raw description is genuinely literal replacement
  // text before anything downstream treats it as such. Confirmed real, repeated
  // damage this session from skipping this step: instructions ("remove this
  // FAQ"), partial-edit requests ("add a sentence after 'mood.'"), quote-wrapped
  // text, and "add a new item" requests all got written verbatim into unrelated
  // fields. This also replaces the old H1-specific AI rewriter, which fabricated
  // a city/state when the ticket didn't provide one (confirmed live, more than
  // once) -- non-conforming H1 requests now correctly fall through to the
  // skip-checker's format check below instead of being "fixed" by guessing.
  const currentText = extractPlainText(fields.htmlSnapshot);
  const diagnosis = await diagnoseRequest({ description: fields.newValue, currentText, htmlSnapshot: fields.htmlSnapshot });
  if (diagnosis) {
    if (diagnosis.type === 'literal') {
      fields.newValue = diagnosis.cleanValue ?? fields.newValue;
    } else if (diagnosis.type === 'link_swap') {
      // Link-target changes have their own resolution path (match by current
      // href, not text content) -- confirmed real gap: these always fell into
      // "ambiguous" and got skipped, even when the target was an ordinary,
      // safely-writable CMS Link field (e.g. program-cta-external-url).
      return await handleLinkSwap(ticket, existingLabelIds, fields, diagnosis.cleanValue, siteId, wfToken, wfShortName, collectionsCache);
    } else {
      return await skip(ticket, existingLabelIds, `Warning: Automation skipped -- AI diagnosed this as a "${diagnosis.type}" request, not literal replacement text. ${diagnosis.reason}`);
    }
  } else {
    // AI unavailable/failed -- fall back to the cheap regex-based quote strip;
    // skip-checker's instructionSignals below is the remaining safety net.
    fields.newValue = stripWrappingQuotes(fields.newValue);
  }

  // Pre-flight skip checks
  const skipCheck = checkSkipConditions({
    selector: fields.selector ?? '',
    htmlSnapshot: fields.htmlSnapshot ?? '',
    newValue: fields.newValue,
  });
  if (skipCheck.skip) {
    return await skip(ticket, existingLabelIds, skipCheck.reason);
  }

  // Static FAQ heading check
  const staticSkip = isStaticSkip(fields.selector ?? '', fields.htmlSnapshot ?? '');
  if (staticSkip) {
    return await skip(ticket, existingLabelIds, `Warning: Automation skipped -- ${staticSkip}`);
  }

  // Route the ticket
  const route = routeTicket(fields.pageUrl, fields.selector ?? '');

  let updateResult;

  let usedPath = route.path;

  if (route.path === 'cms') {
    updateResult = await updateCmsField({
      siteId,
      token: wfToken,
      collectionName: route.collection,
      urlPath: route.urlPath,
      selector: fields.selector ?? '',
      htmlSnapshot: fields.htmlSnapshot ?? '',
      newValue: fields.newValue,
      collectionsCache,
      dryRun: DRY_RUN,
    });

    // CMS failed -- if the selector is confirmed CMS-bound (w-dyn-item) but the
    // URL-based collection guess was wrong, retry against other real collections
    // this site actually has, using keyword hints from the selector/HTML to pick
    // candidates. Confirmed real bug: url-routes.json's generic single-segment
    // fallback ("Pages - Hero Sections") -- and its static "/contact" mapping --
    // are cross-site guesses, right for some sites but wrong for others (e.g. a
    // phone number or coach bio living in "Locations"/"Coaches" instead, on a
    // site that doesn't even have a "Pages - Hero Sections" collection at all).
    if (!updateResult.success && (fields.selector ?? '').includes('w-dyn-item')) {
      const hints = [
        { test: /\baddress\b|paragraph-cta|contact-item|contact-right|\bphone\b/i, collection: 'Locations' },
        { test: /\bcoach\b/i, collection: 'Coaches' },
        { test: /step-card|steps-card/i, collection: '3 Steps' },
      ];
      for (const { test, collection } of hints) {
        if (updateResult.success) break;
        if (collection.toLowerCase() === route.collection.toLowerCase()) continue;
        if (!collectionsCache.has(collection.toLowerCase())) continue;
        if (!test.test(fields.selector ?? '') && !test.test(fields.htmlSnapshot ?? '')) continue;
        console.log(`  CMS path failed on "${route.collection}" -- selector hints at "${collection}", retrying`);
        const retryResult = await updateCmsField({
          siteId, token: wfToken, collectionName: collection, urlPath: route.urlPath,
          selector: fields.selector ?? '', htmlSnapshot: fields.htmlSnapshot ?? '', newValue: fields.newValue,
          collectionsCache, dryRun: DRY_RUN,
        });
        if (retryResult.success) updateResult = retryResult;
      }
    }

    // CMS failed -- fall back to static updater (handles template-static elements
    // inside CMS collection lists, e.g. hardcoded CTAs within w-dyn-item)
    if (!updateResult.success) {
      console.log(`  CMS path failed ("${updateResult.error}") -- falling back to static updater`);
      // Use the URL-based page template collection (e.g. "Programs" for /programs/*)
      // not the selector-derived nested collection (e.g. "FAQs") — the template page
      // hosts the static element we need to update.
      const templateCollectionName = resolvePageTemplateCollection(route.urlPath) ?? route.collection;
      // collectionsCache keys are lowercased in resolveCmsTarget (case-insensitive lookup).
      const fallbackCollectionId = collectionsCache.get(templateCollectionName.toLowerCase()) ?? collectionsCache.get(route.collection.toLowerCase()) ?? null;
      const staticResult = await updateStaticElement({
        siteId,
        token: wfToken,
        urlPath: route.urlPath,
        selector: fields.selector ?? '',
        htmlSnapshot: fields.htmlSnapshot ?? '',
        newValue: fields.newValue,
        pagesCache,
        collectionId: fallbackCollectionId,
        dryRun: DRY_RUN,
      });
      if (staticResult.success) {
        updateResult = staticResult;
        usedPath = 'static';
      } else if (staticResult.needsMcpWrite || staticResult.error === BRIDGE_APP_REQUIRED_MSG) {
        // The static resolution is the true, more actionable outcome -- surface it
        // instead of the CMS-side "item not found" error, which is a red herring here
        // (this element was never going to be a CMS field).
        updateResult = staticResult;
        usedPath = 'static';
      }
      // otherwise keep the original CMS error so the skip message is informative
    }
  } else {
    updateResult = await updateStaticElement({
      siteId,
      token: wfToken,
      urlPath: route.urlPath,
      selector: fields.selector ?? '',
      htmlSnapshot: fields.htmlSnapshot ?? '',
      newValue: fields.newValue,
      pagesCache,
      dryRun: DRY_RUN,
    });
  }

  // Resolved to a plain (non-component) static element -- the write itself can only
  // be completed via the MCP element tool (see static-updater.js), not by this
  // script. Report it distinctly rather than posting a premature skip comment.
  if (updateResult.needsMcpWrite) {
    return {
      outcome: 'needs-mcp-write',
      ticket,
      details: { ...updateResult, siteId, wfShortName, urlPath: route.urlPath, newValue: fields.newValue },
      route,
      fields,
    };
  }

  if (!updateResult.success) {
    return await skip(ticket, existingLabelIds, updateResult.error);
  }

  // Update succeeded -- build comment and pass to QA
  const method = usedPath === 'cms' ? 'CMS update' : 'Designer element update';
  const location = usedPath === 'cms'
    ? `Collection -> Field: ${route.collection} -> ${updateResult.fieldSlug}\nItem: ${updateResult.itemName}`
    : `Page -> Element: ${route.urlPath} -> ${updateResult.elementId}`;

  // wfShortName is the webflow.io subdomain, always correct for staging URL
  const comment = [
    'Automated Update Applied',
    `Method: ${method}`,
    location,
    `Old value: ${updateResult.oldValue ?? '(unknown)'}`,
    `New value: ${fields.newValue}`,
    `Staging URL: https://${wfShortName}.webflow.io${route.urlPath}`,
    `Published to: Staging (webflow.io subdomain only)`,
    `Applied at: ${new Date().toISOString()}`,
    '',
    'Please verify on staging before publishing to live.',
  ].join('\n');

  await postComment(ticket.id, comment, DRY_RUN);
  await passToQA(ticket.id, existingLabelIds, DRY_RUN);

  return { outcome: 'updated', ticket, details: updateResult, route, fields };
}

/**
 * Handle a diagnosed "link_swap" request -- change WHERE a button/link points,
 * not its display text. Only CMS-bound Link fields are reachable this way; a
 * static (non-CMS) link's href can't be written via the REST Data API at all
 * (confirmed: Webflow's public API has no link-write node type), so this
 * always ends in either a CMS write or a clear skip, never a static attempt.
 */
async function handleLinkSwap(ticket, existingLabelIds, fields, newHref, siteId, wfToken, wfShortName, collectionsCache) {
  const oldHref = fields.htmlSnapshot?.match(/href=\\?"([^"\\]+)\\?"/)?.[1] ?? null;
  const route = routeTicket(fields.pageUrl, fields.selector ?? '');

  if (route.path !== 'cms') {
    return await skip(ticket, existingLabelIds, `Warning: Automation skipped -- this is a link-target change on a static (non-CMS) element. This pipeline can only write CMS Link fields via the Data API; static link hrefs require a Webflow Designer session. Old link: ${oldHref ?? '(unknown)'}, requested new link: ${newHref}.`);
  }

  const result = await updateCmsLinkTarget({
    siteId, token: wfToken, collectionName: route.collection, urlPath: route.urlPath,
    selector: fields.selector ?? '', htmlSnapshot: fields.htmlSnapshot ?? '',
    oldHref, newHref, collectionsCache, dryRun: DRY_RUN,
  });

  if (!result.success) {
    return await skip(ticket, existingLabelIds, `Warning: Automation skipped -- link-target change, but ${result.error}`);
  }

  const comment = [
    'Automated Update Applied',
    'Method: CMS update (Link field, Data API)',
    `Collection -> Field: ${route.collection} -> ${result.fieldSlug}`,
    `Item: ${result.itemName}`,
    `Old value: ${result.oldValue ?? '(unknown)'}`,
    `New value: ${newHref}`,
    `Staging URL: https://${wfShortName}.webflow.io${route.urlPath}`,
    `Published to: Staging (webflow.io subdomain only)`,
    `Applied at: ${new Date().toISOString()}`,
    '',
    'Please verify on staging before publishing to live.',
  ].join('\n');

  await postComment(ticket.id, comment, DRY_RUN);
  await passToQA(ticket.id, existingLabelIds, DRY_RUN);

  return { outcome: 'updated', ticket, details: result, route, fields };
}

function extractPlainText(htmlSnapshot) {
  if (!htmlSnapshot) return null;
  return htmlSnapshot
    .replace(/^`+|`+$/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200) || null;
}

async function skip(ticket, existingLabelIds, reason) {
  // A skip never earns ai:edited, so label-agnostic batch discovery can rediscover
  // and reprocess the same ticket on a later run -- use the dedup-aware poster so
  // that doesn't produce duplicate comments (confirmed real, repeated live).
  await postCommentIfNew(ticket.id, reason, DRY_RUN);
  await applySkipTreatment(ticket.id, existingLabelIds, DRY_RUN);
  return { outcome: 'skipped', ticket, reason };
}
