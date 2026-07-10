/**
 * Maps CSS selectors/classes to Webflow CMS field slugs.
 * When a known mapping exists, returns the field slug directly
 * without needing to call get_collection_details.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const fieldMappings = require('../knowledge-base/field-mappings.json');

/**
 * Look up a known field slug for a given collection + selector.
 * Returns the field slug string, or null if not in the knowledge base.
 *
 * @param {string} collection  - Collection name (e.g. "Programs")
 * @param {string} selector    - Full CSS selector path from ticket
 * @param {string} elementId   - Element ID from HTML snapshot (optional)
 */
export function lookupFieldSlug(collection, selector, elementId = null) {
  for (const mapping of fieldMappings.mappings) {
    if (mapping.collection !== collection) continue;

    // ID-based match
    if (mapping.elementId && elementId && elementId === mapping.elementId) {
      return mapping.fieldSlug;
    }

    // Class-based match
    if (mapping.cssClass && selector) {
      const cls = mapping.cssClass.replace(/^\./, '');
      if (selector.includes(cls)) {
        // If mapping has a context hint, do a loose check
        if (mapping.context && !selector.toLowerCase().includes(mapping.context.split(' ')[0])) {
          continue;
        }
        return mapping.fieldSlug;
      }
    }
  }

  return null; // not in knowledge base -- caller must use get_collection_details
}

/**
 * Check if a selector/element is a known static skip (hardcoded non-editable).
 */
export function isStaticSkip(selector, htmlSnapshot) {
  // Static FAQ heading: h2 "Questions? We have the answers!" in faqs-section
  if (
    selector &&
    selector.includes('faqs-section') &&
    htmlSnapshot &&
    htmlSnapshot.includes('Questions? We have the answers!')
  ) {
    return 'Static FAQ heading is hardcoded -- not editable via API.';
  }

  return null;
}
