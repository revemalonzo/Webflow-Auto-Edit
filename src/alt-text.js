/**
 * Alt text generation for the image updater. Ported from wf-image-updaterSKILL.md
 * Steps 4 and 8.
 */

import { listCollections, listCollectionItems } from './webflow-client.js';

const CITY_KEYS = ['city'];
const STATE_KEYS = ['state'];
// Confirmed real-world field: "address-city" holds a combined "City, State" string
// (e.g. "Houston, TX") on Main templates -- not separate city/state fields.
const LOCATION_KEYS = ['address-city', 'location', 'city-state', 'address'];

/**
 * Fetch site context (company name + city/state) from the "Main templates"
 * collection's first item. Cache the result per site in the caller (mirrors
 * collectionsCache/pagesCache). "company-name" is the real public-facing gym
 * name used in site copy -- prefer it over the site's raw Webflow displayName.
 *
 * @returns {Promise<{ companyName: string|null, cityState: string|null }>}
 */
export async function getSiteContext(siteId, token, collectionsCache) {
  if (!collectionsCache.has('main templates')) {
    const all = await listCollections(siteId, token);
    for (const c of all) {
      collectionsCache.set(c.displayName, c.id);
      collectionsCache.set(c.displayName.toLowerCase(), c.id);
      collectionsCache.set(c.slug, c.id);
    }
  }
  // Collection is named "Main templates" (lowercase t) on real sites -- match case-insensitively.
  const collectionId = collectionsCache.get('main templates');
  if (!collectionId) return { companyName: null, cityState: null };

  const items = await listCollectionItems(collectionId, token);
  const item = items[0];
  if (!item) return { companyName: null, cityState: null };

  const fieldData = item.fieldData ?? {};
  // Confirmed real bug: on some sites the "location" key is a Reference field
  // (points to a Locations collection item), not plain text -- Webflow's API
  // returns the raw 24-char hex object id as the field's string value in that
  // case, which was leaking straight into alt text as if it were a city name.
  const looksLikeObjectId = (s) => /^[a-f0-9]{24}$/i.test(s);
  const findField = (keys) => {
    for (const key of keys) {
      const v = fieldData[key];
      if (typeof v === 'string' && v.trim() && !looksLikeObjectId(v.trim())) return v.trim();
    }
    return null;
  };

  const companyName = findField(['company-name']);

  const combined = findField(LOCATION_KEYS);
  if (combined) return { companyName, cityState: combined };

  const city = findField(CITY_KEYS);
  const state = findField(STATE_KEYS);
  const cityState = city && state ? `${city}, ${state}` : city ?? state ?? null;
  return { companyName, cityState };
}

const TEMPLATES = {
  'programs-hero': (ctx) => `${ctx.itemName ?? 'Programs'} at ${ctx.gymName} in ${ctx.cityState}`,
  'programs-home': (ctx) => `${ctx.itemName ?? 'Programs'} at ${ctx.gymName} in ${ctx.cityState}`,
  'header-sections': () => null, // uses hero/header template below
  coaches: (ctx) => `${ctx.itemName ?? 'Coach'}, coach at ${ctx.gymName} in ${ctx.cityState}`,
  community: (ctx) => `Community members at ${ctx.gymName} in ${ctx.cityState}`,
  about: (ctx) => `${ctx.gymName} fitness facility in ${ctx.cityState}`,
  'final-cta': (ctx) => `${ctx.gymName} fitness facility in ${ctx.cityState}`,
  amenities: (ctx) => `${ctx.itemName ?? 'Amenity'} at ${ctx.gymName} in ${ctx.cityState}`,
  'blog-thumbnail': (ctx) => `${ctx.itemName ?? 'Blog post'} — ${ctx.gymName}`,
  'blog-header': (ctx) => `${ctx.itemName ?? 'Blog post'} — ${ctx.gymName}`,
  'chat-widget-logo': (ctx) => `${ctx.gymName} chat support`,
};

const HERO_TEMPLATE = (ctx) => `${ctx.gymName} fitness facility in ${ctx.cityState}`;

/**
 * @param {string} imageType
 * @param {{ gymName: string, cityState: string|null, itemName?: string }} ctx
 * @returns {string}
 */
export function generateAltText(imageType, ctx) {
  const cityState = ctx.cityState ?? 'the area';
  const build = TEMPLATES[imageType] ?? HERO_TEMPLATE;
  let text = build({ ...ctx, cityState }) ?? HERO_TEMPLATE({ ...ctx, cityState });
  text = text.replace(/\b(image of|photo of)\b/gi, '').replace(/\s+/g, ' ').trim();
  if (text.length > 120) text = text.slice(0, 117).trimEnd() + '...';
  return text;
}
