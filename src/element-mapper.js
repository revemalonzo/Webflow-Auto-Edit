/**
 * Maps page URL + CSS selector to Webflow static Designer element IDs.
 * When a known mapping exists, returns the element ID directly without
 * needing to fetch the page DOM or ask the AI resolver.
 */

import { createRequire } from 'module';
import { pickCacheableClass } from './ai-resolver.js';
const require = createRequire(import.meta.url);
const elementMappings = require('../knowledge-base/element-mappings.json');

/**
 * Look up a known element ID for a given site + page path + selector.
 * Returns { elementId, scopeComponentId } or null if not in the knowledge base.
 *
 * Element IDs are Webflow-internal GUIDs unique to one site's DOM -- siteId is a
 * required part of the key. Many client sites share the same template (identical
 * class names across different businesses), so matching on urlPath+selector alone
 * risks returning another site's element ID entirely.
 *
 * @param {string} siteId
 * @param {string} urlPath  - Page path (e.g. "/programs/drop-in")
 * @param {string} selector - Full CSS selector path from ticket
 */
export function lookupElementId(siteId, urlPath, selector) {
  const cssClass = pickCacheableClass(selector);
  if (!cssClass) return null;

  const match = elementMappings.mappings.find(
    (m) => m.siteId === siteId && m.urlPath === urlPath && m.cssClass === cssClass
  );

  return match ? { elementId: match.elementId, scopeComponentId: match.scopeComponentId ?? null } : null;
}
