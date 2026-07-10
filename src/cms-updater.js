/**
 * CMS path executor.
 *
 * Field slug resolution order (stops at first success):
 *   1. KB cache (field-mappings.json)        -- instant, no API
 *   2. Heuristic (class/id vs field slugs)   -- one Webflow API call
 *   3. Text-value match against CMS item     -- compare HTML snapshot text to every text field
 *      (tries item by URL slug first; falls back to full collection scan)
 *   4. AI resolver (Claude Haiku)            -- only if ANTHROPIC_API_KEY is set
 *
 * After step 3 or 4 resolves a slug it is saved back to the KB automatically.
 */

import {
  listCollections,
  listCollectionItems,
  updateCollectionItem,
  getCollectionFields,
} from './webflow-client.js';
import { lookupFieldSlug } from './field-mapper.js';
import { resolveFieldWithAI, learnFieldMapping } from './ai-resolver.js';

/**
 * Resolve the CMS field slug + item for a ticket, WITHOUT writing anything.
 * Shared by updateCmsField (applies the write) and conflict detection
 * (needs the real target identity, not a guess, to know if two tickets
 * truly collide on the same item+field).
 */
export async function resolveCmsTarget({
  siteId,
  token,
  collectionName,
  urlPath,
  selector,
  htmlSnapshot,
  newValue,
  collectionsCache,
  fieldsCache = null,
  itemsCache = null,
}) {
  // 1. Resolve collection ID (cached). Case-insensitive: real collection names can
  // differ in casing from what's hardcoded in url-routes.json (confirmed on the
  // image pipeline's side: "Main templates" vs the expected "Main Templates" --
  // same risk applies here since both pipelines hit the same sites' collections).
  const collectionKey = collectionName.toLowerCase();
  if (!collectionsCache.has(collectionKey)) {
    const all = await listCollections(siteId, token);
    for (const c of all) {
      collectionsCache.set(c.displayName.toLowerCase(), c.id);
      collectionsCache.set(c.slug, c.id);
    }
  }

  const collectionId = collectionsCache.get(collectionKey);
  if (!collectionId) {
    return { success: false, error: `Collection "${collectionName}" not found in site.` };
  }

  const fetchFields = async () => {
    if (fieldsCache?.has(collectionId)) return fieldsCache.get(collectionId);
    const fields = await getCollectionFields(collectionId, token);
    fieldsCache?.set(collectionId, fields);
    return fields;
  };
  const fetchAllItems = async () => {
    if (itemsCache?.has(collectionId)) return itemsCache.get(collectionId);
    const items = await listCollectionItems(collectionId, token);
    itemsCache?.set(collectionId, items);
    return items;
  };

  // 2. KB cache -- field-mappings.json is intentionally shared ACROSS sites (these
  // are templated gym sites with consistent collection/field naming), but that
  // breaks down on older/drifted sites whose schema no longer matches the template
  // exactly (confirmed live: a KB-cached "faq-heading" slug from one site does not
  // exist on another site's FAQs collection, and Webflow rejects the PATCH with
  // "Field not described in schema"). Verify the cached slug actually exists in
  // THIS collection's real fields before trusting it; otherwise treat it as a miss.
  const elementId = extractElementId(htmlSnapshot);
  let fieldSlug = lookupFieldSlug(collectionName, selector, elementId);
  let collectionFields = null;
  if (fieldSlug) {
    collectionFields = await fetchFields();
    if (!collectionFields.some((f) => f.slug === fieldSlug)) {
      console.log(`  KB hit "${fieldSlug}" does not exist on this site's "${collectionName}" collection -- discarding, re-resolving.`);
      fieldSlug = null;
    }
  }

  // 3. Heuristic: match CSS class names / element ID against field slugs
  if (!fieldSlug) {
    console.log(`KB miss for "${collectionName}" + "${selector}" -- fetching collection fields...`);
    collectionFields = collectionFields ?? await fetchFields();
    fieldSlug = matchFieldBySelector(collectionFields, selector, elementId);
    if (fieldSlug) console.log(`  Heuristic match: "${fieldSlug}"`);
  }

  // 4. Find the CMS item (needed for text-value match; also used for the actual update)
  //    Pattern A: slug from URL path
  const urlSlug = extractSlugFromPath(urlPath);
  let item = null;
  if (urlSlug) {
    const items = await listCollectionItems(collectionId, token, { slug: urlSlug });
    item = items[0] ?? null;
  }

  // 5. Text-value match: scan item fields for the text in the HTML snapshot.
  //    If Pattern A found the item, scan only that item.
  //    If not, scan the full collection — handles cross-collection cases where
  //    the FAQ slug differs from the program URL slug.
  if (!fieldSlug) {
    if (!collectionFields) collectionFields = await fetchFields();
    const currentText = extractTextFromSnapshot(htmlSnapshot)?.toLowerCase() ?? '';
    console.log(`  Text-value match: scanning for "${currentText.slice(0, 60)}"`);

    if (currentText) {
      const textFields = collectionFields.filter((f) =>
        ['PlainText', 'RichText'].includes(f.type)
      );
      const scanItems = item ? [item] : await fetchAllItems();
      console.log(`  Scanning ${scanItems.length} item(s), ${textFields.length} text field(s)`);

      outer:
      for (const scanItem of scanItems) {
        for (const f of textFields) {
          const rawVal = String(scanItem.fieldData?.[f.slug] ?? scanItem[f.slug] ?? '');
          const val = rawVal.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
          if (val && val.includes(currentText.slice(0, 40))) {
            fieldSlug = f.slug;
            item = scanItem; // lock in the matched item
            console.log(`  Text-value match: "${fieldSlug}" in item "${scanItem.fieldData?.name ?? scanItem.id}"`);
            learnFieldMapping(collectionName, selector, fieldSlug);
            break outer;
          }
        }
      }
      if (!fieldSlug) console.log(`  Text-value match: no match found`);
    } else {
      console.log(`  Text-value match: skipped (no text extracted from snapshot)`);
    }
  }

  // 6. AI resolver -- only runs if ANTHROPIC_API_KEY is set
  if (!fieldSlug && (process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY)) {
    if (!collectionFields) collectionFields = await fetchFields();
    fieldSlug = await resolveFieldWithAI(collectionName, collectionFields, selector, htmlSnapshot, newValue);
    if (fieldSlug) learnFieldMapping(collectionName, selector, fieldSlug);
  }

  if (!fieldSlug) {
    // The AI resolver only ever uses OPENAI_API_KEY -- if that's set, AI fallback
    // was already attempted and simply found no match; don't tell the caller to
    // set a key that resolveFieldWithAI() doesn't actually check.
    const hint = process.env.OPENAI_API_KEY ? '' : ' Set OPENAI_API_KEY to enable AI fallback.';
    return {
      success: false,
      error: `Field slug not found for collection "${collectionName}" + selector "${selector}".${hint}`,
    };
  }

  // 7. If item still not pinned, try Pattern B: text-match against the resolved field
  if (!item) {
    const currentText = extractTextFromSnapshot(htmlSnapshot);
    console.log(`  Pattern B item search: fieldSlug="${fieldSlug}" currentText="${(currentText ?? '').slice(0, 60)}"`);
    if (currentText) {
      const items = await fetchAllItems();
      const needle = currentText.toLowerCase();
      item = items.find((i) => {
        const rawVal = String(i.fieldData?.[fieldSlug] ?? i[fieldSlug] ?? '');
        const val = rawVal.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
        return val && val.includes(needle.slice(0, 40));
      }) ?? null;
      if (item) console.log(`  Pattern B found item: "${item.fieldData?.name ?? item.id}"`);
      else console.log(`  Pattern B: no item matched`);
    }
  }

  if (!item) {
    return { success: false, error: `CMS item not found in "${collectionName}" for path "${urlPath}".` };
  }

  const oldValue = item.fieldData?.[fieldSlug] ?? item[fieldSlug] ?? null;

  // Scope-mismatch guard: confirmed real, REPEATED damage (same ticket corrupted
  // this way three separate times across this session) -- a short literal value
  // matched against a RichText field that holds a much longer, multi-section
  // block silently overwrote the whole block instead of the one sub-heading/
  // sentence actually intended. This pipeline has no way to edit PART of a
  // RichText field, so when the size mismatch is this large, fail safe instead
  // of guessing which part the client meant.
  collectionFields = collectionFields ?? await fetchFields();
  const fieldDef = collectionFields.find((f) => f.slug === fieldSlug);
  if (fieldDef?.type === 'RichText' && typeof oldValue === 'string') {
    const oldPlainLength = oldValue.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
    if (oldPlainLength > 250 && newValue.length < oldPlainLength * 0.3) {
      return {
        success: false,
        error: `Field "${fieldSlug}" is a rich-text block (${oldPlainLength} chars) far longer than the new value (${newValue.length} chars) -- this looks like a partial edit (one heading/sentence within a larger block), which this pipeline cannot safely apply. Requires manual edit.`,
      };
    }
  }

  return {
    success: true,
    oldValue,
    itemName: item.fieldData?.name ?? item.name ?? item.id,
    fieldSlug,
    collectionId,
    item,
    itemId: item.id,
  };
}

/**
 * Resolve + write a CMS Link-type field for a "change where this button/link
 * points" request. Separate from resolveCmsTarget/updateCmsField because Link
 * fields need a different match strategy (compare the OLD href, not text
 * content) and were previously excluded from field resolution entirely --
 * confirmed real gap: link-target-change requests had no path to a genuine
 * CMS Link field and were always classified "ambiguous" and skipped, even
 * when the target was an ordinary, safely-writable field like
 * `program-cta-external-url`.
 *
 * @param {string} oldHref - the current link target, extracted from the
 *   ticket's htmlSnapshot (href="..."). Used to identify WHICH Link field on
 *   the item to write -- an item can have several (e.g. `program-cta-external-url`,
 *   `-2`, `-3`), so matching by current value is the only reliable signal.
 * @param {string} newHref - the new destination URL to write.
 */
export async function updateCmsLinkTarget({
  siteId,
  token,
  collectionName,
  urlPath,
  selector,
  htmlSnapshot,
  oldHref,
  newHref,
  collectionsCache,
  dryRun = false,
}) {
  const collectionKey = collectionName.toLowerCase();
  if (!collectionsCache.has(collectionKey)) {
    const all = await listCollections(siteId, token);
    for (const c of all) {
      collectionsCache.set(c.displayName.toLowerCase(), c.id);
      collectionsCache.set(c.slug, c.id);
    }
  }
  const collectionId = collectionsCache.get(collectionKey);
  if (!collectionId) {
    return { success: false, error: `Collection "${collectionName}" not found in site.` };
  }

  const collectionFields = await getCollectionFields(collectionId, token);
  const linkFields = collectionFields.filter((f) => f.type === 'Link');
  if (linkFields.length === 0) {
    return { success: false, error: `No Link-type fields on collection "${collectionName}" -- this is likely a static (non-CMS) link. Requires manual Webflow Designer edit.` };
  }

  const urlSlug = extractSlugFromPath(urlPath);
  let items;
  if (urlSlug) {
    const bySlug = await listCollectionItems(collectionId, token, { slug: urlSlug });
    items = bySlug.length ? bySlug : await listCollectionItems(collectionId, token);
  } else {
    items = await listCollectionItems(collectionId, token);
  }

  // Match by the OLD href value -- the only reliable signal when an item has
  // multiple Link fields (confirmed live: a Programs item can have 3 parallel
  // CTA link fields, only one of which has the value the ticket is pointing at).
  let item = null, fieldSlug = null;
  outer:
  for (const scanItem of items) {
    for (const f of linkFields) {
      const val = String(scanItem.fieldData?.[f.slug] ?? '');
      if (val && oldHref && val === oldHref) {
        item = scanItem;
        fieldSlug = f.slug;
        break outer;
      }
    }
  }

  // Fallback: if there's exactly ONE non-null Link field across the matched-by-slug
  // item, and no exact old-href match was found (stale snapshot), use it -- same
  // confidence tier as the text pipeline's single-field fallbacks.
  if (!fieldSlug && urlSlug) {
    const bySlug = items.find((i) => i.fieldData?.slug === urlSlug);
    if (bySlug) {
      const populated = linkFields.filter((f) => bySlug.fieldData?.[f.slug]);
      if (populated.length === 1) {
        item = bySlug;
        fieldSlug = populated[0].slug;
      }
    }
  }

  if (!item || !fieldSlug) {
    return { success: false, error: `Could not identify which Link field on "${collectionName}" this ticket targets (old href "${oldHref ?? '(none)'}" didn't match any field, and more than one candidate field exists). Requires manual review.` };
  }

  const oldValue = item.fieldData?.[fieldSlug] ?? null;
  await updateCollectionItem(collectionId, item.id, { [fieldSlug]: newHref }, token, dryRun);

  return {
    success: true,
    oldValue,
    itemName: item.fieldData?.name ?? item.id,
    fieldSlug,
    collectionId,
    itemId: item.id,
  };
}

export async function updateCmsField({
  siteId,
  token,
  collectionName,
  urlPath,
  selector,
  htmlSnapshot,
  newValue,
  collectionsCache,
  dryRun = false,
}) {
  const target = await resolveCmsTarget({
    siteId, token, collectionName, urlPath, selector, htmlSnapshot, newValue, collectionsCache,
  });
  if (!target.success) return target;

  // 8. Update
  await updateCollectionItem(target.collectionId, target.itemId, { [target.fieldSlug]: newValue }, token, dryRun);

  return target;
}

// --- Helpers ---

function extractSlugFromPath(urlPath) {
  // Last segment regardless of depth -- covers both /programs/{slug} (2 segments)
  // and single-segment "Pages - Hero Sections" pages like /after-school-pick-up,
  // where the whole path IS the slug.
  const parts = urlPath.split('/').filter(Boolean);
  return parts.length >= 1 ? parts[parts.length - 1] : null;
}

function extractElementId(htmlSnapshot) {
  if (!htmlSnapshot) return null;
  const match = htmlSnapshot.match(/id="([^"]+)"/);
  return match ? match[1] : null;
}

function extractTextFromSnapshot(htmlSnapshot) {
  if (!htmlSnapshot) return null;
  return htmlSnapshot
    .replace(/^`+|`+$/g, '')      // strip Markdown code backtick wrapper
    .replace(/<[^>]+>/g, ' ')        // strip HTML tags
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || null;
}

function matchFieldBySelector(fields, selector, elementId) {
  if (!fields?.length) return null;

  if (elementId) {
    const byId = fields.find((f) => f.slug === elementId || f.id === elementId);
    if (byId) return byId.slug;
  }

  const classes = (selector.match(/\.([\w-]+)/g) ?? []).map((c) => c.slice(1));
  for (const cls of classes) {
    const byClass = fields.find(
      (f) => f.slug === cls || f.slug?.replace(/-/g, '') === cls.replace(/-/g, '')
    );
    if (byClass) return byClass.slug;
  }

  return null;
}
