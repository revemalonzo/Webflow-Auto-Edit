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
  getCollectionFields,
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
 * @param {Map}    opts.collectionsCache - Shared cache: collectionName -> collectionId
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

  // 2. Determine field slug -- check KB first, fall back to API discovery
  const elementId = extractElementId(htmlSnapshot);
  let fieldSlug = lookupFieldSlug(collectionName, selector, elementId);

  if (!fieldSlug) {
    // KB miss -- discover fields from Webflow API and try to match by class or element ID
    console.log(`KB miss for "${collectionName}" + "${selector}" -- fetching collection fields...`);
    fieldSlug = await discoverFieldSlug(collectionId, selector, elementId, htmlSnapshot, token);
    if (fieldSlug) {
      console.log(`  Discovered field: "${fieldSlug}" -- add to field-mappings.json to cache for future runs`);
    }
  }

  if (!fieldSlug) {
    return {
      success: false,
      error: `Field slug not found for collection "${collectionName}" + selector "${selector}". Not in knowledge base and could not be discovered automatically.`,
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

// --- Helpers ---

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
  return htmlSnapshot
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || null;
}

/**
 * Attempt to discover the correct field slug by fetching collection field definitions
 * and matching against the CSS selector, element ID, or current text from HTML snapshot.
 */
async function discoverFieldSlug(collectionId, selector, elementId, htmlSnapshot, token) {
  try {
    const fields = await getCollectionFields(collectionId, token);
    const currentText = extractTextFromSnapshot(htmlSnapshot)?.toLowerCase() ?? '';

    // Try to match by element ID
    if (elementId) {
      const byId = fields.find((f) => f.slug === elementId || f.id === elementId);
      if (byId) return byId.slug;
    }

    // Try to match field slug against CSS class names in selector
    const classes = (selector.match(/\.([\w-]+)/g) ?? []).map((c) => c.slice(1));
    for (const cls of classes) {
      const byClass = fields.find(
        (f) => f.slug === cls || f.slug?.replace(/-/g, '') === cls.replace(/-/g, '')
      );
      if (byClass) return byClass.slug;
    }

    // Try to match by current text content against field display names
    if (currentText) {
      const byText = fields.find(
        (f) => f.displayName?.toLowerCase().includes(currentText.slice(0, 20))
      );
      if (byText) return byText.slug;
    }

    return null;
  } catch (err) {
    console.warn(`discoverFieldSlug failed: ${err.message}`);
    return null;
  }
}
