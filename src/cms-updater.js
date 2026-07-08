/**
 * CMS path executor.
 *
 * Given a routed ticket (collection known), finds the CMS item and updates the field.
 * Implements Pattern A (slug-based) and Pattern B (text-match for static pages with w-dyn-item).
 */

import {
  listCollections,
  listCollectionItems,
  updateCollectionItem,
} from './webflow-client.js';
import { lookupFieldSlug } from './field-mapper.js';

/**
 * Update a CMS field for a ticket.
 *
 * @param {object} opts
 * @param {string} opts.siteId
 * @param {string} opts.token
 * @param {string} opts.collectionName
 * @param {string} opts.urlPath          - e.g. "/programs/yoga-flow"
 * @param {string} opts.selector         - CSS selector from ticket
 * @param {string} opts.htmlSnapshot     - HTML snapshot from ticket
 * @param {string} opts.newValue         - New text to write
 * @param {Map}    opts.collectionsCache - Shared cache: collectionName → collectionId
 * @param {boolean} opts.dryRun
 * @returns {{ success: boolean, oldValue: string|null, itemName: string|null, fieldSlug: string|null, error?: string }}
 */
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
  // 1. Resolve collection ID (cached)
  if (!collectionsCache.has(collectionName)) {
    const all = await listCollections(siteId, token);
    for (const c of all) {
      collectionsCache.set(c.displayName, c.id);
      collectionsCache.set(c.slug, c.id); // also index by slug
    }
  }

  const collectionId = collectionsCache.get(collectionName);
  if (!collectionId) {
    return { success: false, error: `Collection "${collectionName}" not found in site.` };
  }

  // 2. Determine field slug
  const elementId = extractElementId(htmlSnapshot);
  let fieldSlug = lookupFieldSlug(collectionName, selector, elementId);

  // If not in knowledge base, we'd need to call get_collection_details.
  // For now, flag as requiring a knowledge base update.
  if (!fieldSlug) {
    return {
      success: false,
      error: `Field slug not found in knowledge base for collection "${collectionName}" + selector "${selector}". Add a mapping to knowledge-base/field-mappings.json.`,
    };
  }

  // 3. Find the CMS item
  const slug = extractSlugFromPath(urlPath);
  let item = null;

  if (slug) {
    // Pattern A: slug-based lookup
    const items = await listCollectionItems(collectionId, token, { slug });
    item = items[0] ?? null;
  }

  if (!item) {
    // Pattern B: text-match against current HTML snapshot text
    const currentText = extractTextFromSnapshot(htmlSnapshot);
    if (currentText) {
      const items = await listCollectionItems(collectionId, token);
      item = items.find((i) => {
        const fieldVal = i.fieldData?.[fieldSlug] ?? i[fieldSlug];
        return typeof fieldVal === 'string' && fieldVal.includes(currentText);
      }) ?? null;
    }
  }

  if (!item) {
    return { success: false, error: `CMS item not found in "${collectionName}" for path "${urlPath}".` };
  }

  const oldValue = item.fieldData?.[fieldSlug] ?? item[fieldSlug] ?? null;

  // 4. Update
  await updateCollectionItem(collectionId, item.id, { [fieldSlug]: newValue }, token, dryRun);

  return {
    success: true,
    oldValue,
    itemName: item.fieldData?.name ?? item.name ?? item.id,
    fieldSlug,
    collectionId,
    itemId: item.id,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractSlugFromPath(urlPath) {
  const parts = urlPath.split('/').filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 1] : null;
}

function extractElementId(htmlSnapshot) {
  if (!htmlSnapshot) return null;
  const match = htmlSnapshot.match(/id="([^"]+)"/);
  return match ? match[1] : null;
}

function extractTextFromSnapshot(htmlSnapshot) {
  if (!htmlSnapshot) return null;
  // Strip tags, collapse whitespace
  return htmlSnapshot
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || null;
}
