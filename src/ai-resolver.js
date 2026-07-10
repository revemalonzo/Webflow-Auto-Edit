/**
 * AI-powered field slug resolver using OpenAI (gpt-4o-mini).
 *
 * Only runs if OPENAI_API_KEY is set. After resolving, writes the result
 * back to field-mappings.json so future runs hit the KB directly.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAPPINGS_PATH = path.join(__dirname, '..', 'knowledge-base', 'field-mappings.json');
const ELEMENT_MAPPINGS_PATH = path.join(__dirname, '..', 'knowledge-base', 'element-mappings.json');
const IMAGE_FIELD_MAPPINGS_PATH = path.join(__dirname, '..', 'knowledge-base', 'image-field-mappings.json');

/**
 * AI: diagnose what a ticket's raw "Description" field actually is, before any
 * field/element resolution runs. Confirmed real, repeated damage this session:
 * treating the raw description as literal replacement text caused instructions
 * ("remove this FAQ", "arrange the programs in this order"), partial-edit requests
 * ("add a sentence after 'mood.'"), quote-wrapped literal text, and "add a new
 * item" requests to all get written verbatim into unrelated CMS fields -- in one
 * case overwriting a whole 2-section rich-text block with a 2-word fragment.
 *
 * This replaces guessing with an explicit classification step:
 *   - "literal"     -- description IS the replacement text (verbatim or quote-wrapped).
 *                       cleanValue is the text to write, with wrapper quotes stripped.
 *   - "partial"      -- description asks to change PART of the existing content
 *                       (insert a sentence, swap one list/section, find-and-replace a
 *                       phrase) rather than replace the whole field. Too risky to
 *                       auto-apply generically (confirmed: naive full-field overwrites
 *                       destroyed unrelated content) -- always requires manual review.
 *   - "new_item"     -- description asks to add a new page/program/item, not edit an
 *                       existing one (confirmed real: got misapplied to an unrelated
 *                       existing item's image/fields).
 *   - "structural"   -- layout/removal/reordering request, no text field applies.
 *   - "not_visual"   -- (only offered when hasImageAttachment is true) the request
 *                       is NOT about swapping in specific new photo content -- the
 *                       attached file is reference/illustration material for
 *                       something else. This covers TWO confirmed-damaging patterns:
 *                       (1) an unrelated question (SEO/meta-tag, "how do I...") with
 *                       a screenshot attached -- e.g. a Google meta-description
 *                       question got its screenshot swapped in as the new homepage
 *                       hero photo; and (2) a BUG REPORT or bug-illustrating
 *                       screenshot describing something BROKEN (wrong content
 *                       showing, an element hidden/misaligned/missing on some
 *                       device, cropping issues) -- e.g. "the back button becomes
 *                       hidden on mobile" and "no hero image on mobile devices"
 *                       both had a screenshot of the BROKEN state, which got
 *                       swapped in as if it were the desired new photo, onto a
 *                       random unrelated item. The distinguishing question: does
 *                       the description name/describe a SPECIFIC NEW PHOTO to use
 *                       (a person, a scene, "this new picture"), or does it
 *                       describe a PROBLEM/BUG/behavior needing a fix? Only the
 *                       former is a genuine image swap.
 *   - "ambiguous"    -- can't confidently tell; needs a human.
 *
 * @param {boolean} hasImageAttachment - pass true when the caller is the image
 *   pipeline and a supported image attachment is present, to enable "not_visual".
 * @returns {Promise<{ type: string, cleanValue: string|null, reason: string } | null>}
 *   null only on AI/network failure (caller should fall back to conservative skip).
 */
export async function diagnoseRequest({ description, currentText, htmlSnapshot, hasImageAttachment = false }) {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!description) return null;

  const types = ['literal', 'partial', 'new_item', 'structural', 'link_swap', ...(hasImageAttachment ? ['not_visual'] : []), 'ambiguous'];

  const prompt = [
    `A client submitted this website-edit request (raw ticket description):`,
    `"""${description}"""`,
    ``,
    `The element currently targeted on the page has this text/HTML: ${(currentText ?? htmlSnapshot ?? '').slice(0, 300)}`,
    hasImageAttachment ? `\nNote: this ticket has an attached image file.` : '',
    ``,
    `Classify the request into exactly one type:`,
    `- literal: the description IS the intended final replacement text for this element (verbatim, or wrapped in quotes as a delineation convention).`,
    `- partial: the description asks to change only PART of the existing content (e.g. "add a sentence after X", "change the list to Y", "replace 'A' with 'B'"), not replace the whole thing.`,
    `- new_item: the description asks to add a brand-new page/program/item/section, not edit this existing one.`,
    `- structural: a layout/positioning/removal/reordering request with no literal text to write (e.g. "remove this FAQ", "center the buttons", "reorder the programs").`,
    `- link_swap: the request wants to change WHERE a link/button/CTA points to (a new destination URL is given), NOT the visible display text of the element. E.g. "use this link instead: <url>", "change the button link to <url>", "point this to <url>". The key signal: a URL is given as the new TARGET/DESTINATION, not as a source to copy text from. If the request ALSO asks to change the visible label/text (e.g. "call this 'Summer Special' and use this link: <url>"), still use link_swap -- VALUE should be the new URL only; the caller handles the text change separately from currentText/htmlSnapshot context.`,
    `- ambiguous: also use this if the description points to an EXTERNAL URL/page as the SOURCE of replacement content to copy/transcribe ("use the bio from X", "copy the text from our old site at Y") -- that requires fetching and transcribing content this pipeline cannot do; never write the instruction sentence itself as if it were the content. Do not confuse this with link_swap: if the URL is a new link DESTINATION (not something to read text from), use link_swap instead.`,
    hasImageAttachment ? `- not_visual: the request does NOT name/describe a specific new photo to swap in -- it either (a) asks something unrelated (SEO/meta, a general question) with a screenshot attached, or (b) reports a BUG or broken behavior (something hidden, misaligned, missing, wrong, not displaying correctly on some device) where the attachment is a screenshot ILLUSTRATING the problem, not new content to use. Ask yourself: does this describe a photo to insert, or a problem to fix? If it's a problem/bug report, use not_visual even if a file is attached.` : '',
    `- ambiguous: none of the above fit confidently.`,
    ``,
    `Reply in EXACTLY this format (3 lines, no extra commentary):`,
    `TYPE: <${types.join('|')}>`,
    `VALUE: <if TYPE is literal, the clean replacement text with any wrapping quotes removed and instruction-phrasing like "change this to say" stripped; if TYPE is link_swap, the bare new destination URL only; otherwise NONE>`,
    `REASON: <one short sentence explaining your classification, written for a human reviewer>`,
  ].join('\n');

  try {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const res = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = res.choices[0]?.message?.content ?? '';
    const type = raw.match(/^TYPE:\s*(\w+)/im)?.[1]?.toLowerCase() ?? 'ambiguous';
    const valueRaw = raw.match(/^VALUE:\s*(.*)$/im)?.[1]?.trim() ?? 'NONE';
    const reason = raw.match(/^REASON:\s*(.*)$/im)?.[1]?.trim() ?? '';

    const validTypes = ['literal', 'partial', 'new_item', 'structural', 'link_swap', 'not_visual', 'ambiguous'];
    const safeType = validTypes.includes(type) ? type : 'ambiguous';
    const cleanValue = ['literal', 'link_swap'].includes(safeType) && valueRaw && valueRaw.toUpperCase() !== 'NONE' ? valueRaw : null;

    // link_swap's VALUE must actually be a URL -- if the model didn't return one,
    // treat this as a failed link_swap rather than trusting garbage into a Link field.
    if (safeType === 'link_swap' && !/^https?:\/\//i.test(cleanValue ?? '')) {
      console.log(`  AI diagnosed request as "link_swap" but VALUE isn't a URL -- downgrading to "ambiguous"`);
      return { type: 'ambiguous', cleanValue: null, reason: reason || 'link_swap classification did not yield a usable destination URL.' };
    }

    console.log(`  AI diagnosed request as "${safeType}"${cleanValue ? `: "${cleanValue.slice(0, 60)}"` : ''}`);
    return { type: safeType, cleanValue, reason };
  } catch (err) {
    console.warn(`  AI request diagnosis failed: ${err.message}`);
    return null;
  }
}

export async function resolveFieldWithAI(collectionName, fields, selector, htmlSnapshot, newValue) {
  if (!process.env.OPENAI_API_KEY) return null;

  const editable = (fields ?? []).filter(
    (f) => !['Reference', 'MultiReference', 'Switch', 'Image', 'File', 'Link'].includes(f.type)
  );
  if (editable.length === 0) return null;

  const fieldList = editable
    .map((f) => `slug="${f.slug}" | name="${f.displayName}" | type=${f.type}`)
    .join('\n');

  const prompt = [
    `You are helping update a Webflow CMS item in the "${collectionName}" collection.`,
    `A content editor wants to change this element:`,
    `CSS selector: ${selector}`,
    `Current HTML: ${(htmlSnapshot ?? '').replace(/^`+|`+$/g, '').slice(0, 300)}`,
    `New value: ${newValue}`,
    ``,
    `Available fields:`,
    fieldList,
    ``,
    `Reply with ONLY the field slug string to update. If unknown, reply "unknown".`,
  ].join('\n');

  try {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const res = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 50,
      messages: [{ role: 'user', content: prompt }],
    });

    // Confirmed (image-field resolver hit this too): the model sometimes echoes the
    // prompt's own `slug="..."` field-list format back instead of the bare slug.
    const raw = res.choices[0]?.message?.content?.trim().replace(/['"]/g, '').replace(/^slug\s*=\s*/i, '') ?? '';
    if (!raw || raw === 'unknown') return null;

    const match = editable.find((f) => f.slug === raw);
    if (!match) {
      console.warn(`  AI returned "${raw}" — not a valid field slug, ignoring.`);
      return null;
    }

    console.log(`  AI resolved field slug: "${raw}"`);
    return raw;
  } catch (err) {
    console.warn(`  AI field resolution failed: ${err.message}`);
    return null;
  }
}

/**
 * AI: pick the Image-type field(s) a ticket's selector/description is targeting.
 * Used by the image updater -- restricted to Image-type fields only (the text
 * updater's resolveFieldWithAI explicitly excludes them).
 *
 * @param {boolean} needsMobile - true for dual desktop/mobile field types
 * @returns {Promise<{ primary: string, mobile: string|null } | null>}
 */
export async function resolveImageFieldWithAI(collectionName, fields, selector, htmlSnapshot, description, needsMobile) {
  if (!process.env.OPENAI_API_KEY) return null;

  const imageFields = (fields ?? []).filter((f) => f.type === 'Image');
  if (imageFields.length === 0) return null;

  const fieldList = imageFields
    .map((f) => `slug="${f.slug}" | name="${f.displayName}"`)
    .join('\n');

  const prompt = [
    `You are helping update an image field on a Webflow CMS item in the "${collectionName}" collection.`,
    `A content editor wants to swap this image:`,
    `CSS selector: ${selector}`,
    `Current HTML near the target: ${(htmlSnapshot ?? '').replace(/^`+|`+$/g, '').slice(0, 300)}`,
    `Request: ${description}`,
    ``,
    `Available image fields:`,
    fieldList,
    ``,
    needsMobile
      ? `Reply with the desktop field slug and mobile field slug, comma-separated (desktop first, e.g. "image-1,hero-image-3-mobile"). If there is no separate mobile field, reply with just the one slug. If unknown, reply "unknown".`
      : `Reply with ONLY the single field slug string to update. If unknown, reply "unknown".`,
  ].join('\n');

  try {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const res = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 50,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = res.choices[0]?.message?.content?.trim().replace(/['"]/g, '') ?? '';
    if (!raw || raw.toLowerCase() === 'unknown') return null;

    // Confirmed: the model sometimes echoes the prompt's own `slug="..."` field-list
    // format back (e.g. "slug=image-mobile") instead of the bare slug -- strip it.
    const stripPrefix = (s) => s.trim().replace(/^slug\s*=\s*/i, '');
    const [primaryRaw, mobileRaw] = raw.split(',').map(stripPrefix);
    const primary = imageFields.find((f) => f.slug === primaryRaw)?.slug ?? null;
    if (!primary) {
      console.warn(`  AI returned "${primaryRaw}" — not a valid image field slug, ignoring.`);
      return null;
    }
    const mobile = mobileRaw ? imageFields.find((f) => f.slug === mobileRaw)?.slug ?? null : null;

    console.log(`  AI resolved image field(s): "${primary}"${mobile ? ` + "${mobile}"` : ''}`);
    return { primary, mobile };
  } catch (err) {
    console.warn(`  AI image field resolution failed: ${err.message}`);
    return null;
  }
}

/**
 * AI: pick the best template page from the site's page list for a given URL path.
 * Returns the page id string, or null if unknown.
 */
export async function resolveTemplatePageWithAI(urlPath, pages) {
  if (!process.env.OPENAI_API_KEY || !pages?.length) return null;

  const pageList = pages
    .map((p) => `id="${p.id}" slug="${p.slug ?? ''}" title="${p.title ?? p.name ?? ''}" collectionId="${p.collectionId ?? ''}"`)
    .join('\n');

  const prompt = [
    `A Webflow site has the following pages:`,
    pageList,
    ``,
    `Which page is the CMS template that renders the URL path "${urlPath}"?`,
    `CMS template pages have titles like "Programs Template", "FAQs Template", etc. and a non-empty collectionId.`,
    `Reply with ONLY the page id string. If unknown, reply "unknown".`,
  ].join('\n');

  try {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const res = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 50,
      messages: [{ role: 'user', content: prompt }],
    });

    // Same echo-back risk as the field resolvers above (model returns "id=..." instead
    // of the bare id, copying the prompt's own list format).
    const raw = res.choices[0]?.message?.content?.trim().replace(/['"]/g, '').replace(/^id\s*=\s*/i, '') ?? '';
    if (!raw || raw === 'unknown') return null;

    const match = pages.find((p) => p.id === raw);
    if (!match) {
      console.warn(`  AI returned page id "${raw}" — not found in page list, ignoring.`);
      return null;
    }

    console.log(`  AI resolved template page: "${match.title ?? match.slug}" (${raw})`);
    return raw;
  } catch (err) {
    console.warn(`  AI template page resolution failed: ${err.message}`);
    return null;
  }
}

/**
 * AI: pick the best element from a list of page elements for a given selector + snapshot.
 * Returns the element id string, or null if unknown.
 */
export async function resolveElementWithAI(selector, htmlSnapshot, elements) {
  if (!process.env.OPENAI_API_KEY || !elements?.length) return null;

  const elementList = elements
    .slice(0, 80) // keep prompt bounded
    .map((e) => `id="${e.id}" text="${(e.text ?? '').slice(0, 80)}" classes="${(e.classNames ?? []).join(' ')}"`)
    .join('\n');

  const currentText = (htmlSnapshot ?? '')
    .replace(/^`+|`+$/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

  const prompt = [
    `A content editor wants to update the element matching this CSS selector on a Webflow page:`,
    `Selector: ${selector}`,
    `Current text on page: "${currentText}"`,
    ``,
    `Available page elements:`,
    elementList,
    ``,
    `Which element id should be updated? Reply with ONLY the element id string. If unknown, reply "unknown".`,
  ].join('\n');

  try {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const res = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 50,
      messages: [{ role: 'user', content: prompt }],
    });

    // Same echo-back risk as the field resolvers above.
    const raw = res.choices[0]?.message?.content?.trim().replace(/['"]/g, '').replace(/^id\s*=\s*/i, '') ?? '';
    if (!raw || raw === 'unknown') return null;

    const match = elements.find((e) => e.id === raw);
    if (!match) {
      console.warn(`  AI returned element id "${raw}" — not found in element list, ignoring.`);
      return null;
    }

    console.log(`  AI resolved element: id="${raw}" text="${(match.text ?? '').slice(0, 60)}"`);
    return raw;
  } catch (err) {
    console.warn(`  AI element resolution failed: ${err.message}`);
    return null;
  }
}

export function learnFieldMapping(collectionName, selector, fieldSlug) {
  try {
    const data = JSON.parse(fs.readFileSync(MAPPINGS_PATH, 'utf8'));

    const classes = selector.match(/\.([\w-]+)/g) ?? [];
    const cssClass = classes.at(-1) ?? null;
    if (!cssClass) return;

    const exists = data.mappings.some(
      (m) => m.collection === collectionName && m.cssClass === cssClass && m.fieldSlug === fieldSlug
    );
    if (exists) return;

    data.mappings.push({ collection: collectionName, cssClass, fieldSlug, _learnedAt: new Date().toISOString() });
    fs.writeFileSync(MAPPINGS_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
    console.log(`  Learned: "${collectionName}" + "${cssClass}" -> "${fieldSlug}"`);
  } catch (err) {
    console.warn(`  learnFieldMapping failed: ${err.message}`);
  }
}

/**
 * Persist a resolved static element ID so future tickets on the same SITE + page
 * path + selector skip the DOM fetch, matching, and AI resolution entirely.
 *
 * Element IDs are Webflow-internal GUIDs unique to one site's DOM tree -- they must
 * be keyed by siteId as well as urlPath/cssClass. Many client sites share the same
 * template (identical class names like ".h2-section", ".fc-white" across totally
 * different businesses), so without siteId, a ticket on Site B can get a false KB
 * "hit" for an element ID that only exists on Site A -- confirmed live: Rookies Kids
 * Fitness matched a cached ".fc-white" entry learned from an earlier, different site,
 * and that element ID does not exist on Rookies' page at all.
 */
export function learnElementMapping(siteId, urlPath, selector, elementId, scopeComponentId = null) {
  try {
    const data = JSON.parse(fs.readFileSync(ELEMENT_MAPPINGS_PATH, 'utf8'));

    const classes = (selector ?? '').match(/\.([\w-]+)/g) ?? [];
    const cssClass = classes.at(-1) ?? null;
    if (!cssClass) return;

    const exists = data.mappings.some(
      (m) => m.siteId === siteId && m.urlPath === urlPath && m.cssClass === cssClass && m.elementId === elementId
    );
    if (exists) return;

    data.mappings.push({ siteId, urlPath, cssClass, elementId, scopeComponentId, _learnedAt: new Date().toISOString() });
    fs.writeFileSync(ELEMENT_MAPPINGS_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
    console.log(`  Learned element: [${siteId}] "${urlPath}" + "${cssClass}" -> "${elementId}"`);
  } catch (err) {
    console.warn(`  learnElementMapping failed: ${err.message}`);
  }
}

/**
 * Persist a resolved image field slug (+ optional mobile pair) so future tickets
 * on the same collection + image type + selector skip the AI field resolver entirely.
 */
export function learnImageFieldMapping(collection, imageType, selector, fieldSlug, mobileFieldSlug = null) {
  try {
    const data = JSON.parse(fs.readFileSync(IMAGE_FIELD_MAPPINGS_PATH, 'utf8'));

    const classes = (selector ?? '').match(/\.([\w-]+)/g) ?? [];
    const cssClass = classes.at(-1) ?? null;
    if (!cssClass) return;

    const exists = data.mappings.some(
      (m) => m.collection === collection && m.imageType === imageType && m.cssClass === cssClass && m.fieldSlug === fieldSlug
    );
    if (exists) return;

    data.mappings.push({ collection, imageType, cssClass, fieldSlug, mobileFieldSlug, _learnedAt: new Date().toISOString() });
    fs.writeFileSync(IMAGE_FIELD_MAPPINGS_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
    console.log(`  Learned image field: "${collection}" + "${imageType}" + "${cssClass}" -> "${fieldSlug}"${mobileFieldSlug ? ` + "${mobileFieldSlug}"` : ''}`);
  } catch (err) {
    console.warn(`  learnImageFieldMapping failed: ${err.message}`);
  }
}
