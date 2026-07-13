/**
 * Maps CSS selectors to Webflow image field slugs, per collection + image type.
 * Mirrors field-mapper.js's pattern for the text updater -- when a known mapping
 * exists, skip the AI field resolver entirely.
 */

import { createRequire } from 'module';
import { pickCacheableClass } from './ai-resolver.js';
const require = createRequire(import.meta.url);
const fieldMappings = require('../knowledge-base/image-field-mappings.json');

/**
 * @returns {{ primary: string, mobile: string|null } | null}
 */
export function lookupImageFieldSlug(collection, imageType, selector) {
  const cssClass = pickCacheableClass(selector);
  if (!cssClass) return null;

  const match = fieldMappings.mappings.find(
    (m) => m.collection === collection && m.imageType === imageType && m.cssClass === cssClass
  );
  return match ? { primary: match.fieldSlug, mobile: match.mobileFieldSlug ?? null } : null;
}
