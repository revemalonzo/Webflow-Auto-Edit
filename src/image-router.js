/**
 * Routes an image-swap ticket's page URL + selector to a (collection, imageType) pair.
 * Ported from wf-image-updaterSKILL.md Step 5, with the same URL table as router.js
 * where it overlaps, but image-specific disambiguation (a page can host several
 * different image-bearing sections -- hero, coaches list, amenities, CTA, etc.).
 *
 * Unlike the text router, there is no static-DOM fallback for images -- if nothing
 * matches, the ticket is genuinely out of scope (no CMS image field to target).
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const imageRoutes = require('../knowledge-base/image-routes.json');

/**
 * @param {string} pageUrl
 * @param {string} selector
 * @returns {{ collection: string, imageType: string } | null}
 */
export function routeImageTicket(pageUrl, selector) {
  const urlPath = new URL(pageUrl).pathname;
  const sel = (selector ?? '').toLowerCase();

  // Universal overrides -- these sections can appear on any page, so selector wins over URL.
  for (const override of imageRoutes.universalSelectorOverrides) {
    if (override.signals.some((s) => sel.includes(s))) {
      return { collection: override.collection, imageType: override.imageType };
    }
  }

  // Homepage disambiguation. Hero checked first and specifically -- a hero section's
  // own collection-list binding uses the same generic w-dyn-item/w-dyn-items classes
  // as every other dynamic list on the page, so a broad "is this any dynamic list"
  // signal isn't enough to tell hero apart from programs/community. Confirmed bug:
  // a homepage hero overlay ticket was mis-routed to Programs because its selector
  // (like every w-dyn-list) contained "w-dyn-items".
  if (urlPath === '/') {
    const hp = imageRoutes.homepage;
    if (hp.heroSignals.some((s) => sel.includes(s))) {
      return { collection: hp.heroCollection, imageType: hp.heroImageType };
    }
    if (hp.programsSignals.some((s) => sel.includes(s))) {
      return { collection: hp.programsCollection, imageType: hp.programsImageType };
    }
    if (hp.communitySignals.some((s) => sel.includes(s))) {
      return { collection: hp.communityCollection, imageType: hp.communityImageType };
    }
    return { collection: hp.heroCollection, imageType: hp.heroImageType };
  }

  // /about disambiguation
  if (urlPath === '/about') {
    const ab = imageRoutes.about;
    if (ab.coachesSignals.some((s) => sel.includes(s))) {
      return { collection: ab.coachesCollection, imageType: ab.coachesImageType };
    }
    if (ab.headerSignals.some((s) => sel.includes(s))) {
      return { collection: ab.headerCollection, imageType: ab.headerImageType };
    }
    return { collection: ab.bodyCollection, imageType: ab.bodyImageType };
  }

  // Prefix routes (e.g. /programs/slug, /coaches/slug, /blog/slug)
  for (const route of imageRoutes.prefixRoutes) {
    if (urlPath.startsWith(route.prefix)) {
      if (route.prefix === '/blog/') {
        const bl = imageRoutes.blog;
        if (bl.bodySignals.some((s) => sel.includes(s))) {
          return { collection: route.collection, imageType: bl.bodyImageType };
        }
        if (bl.headerSignals.some((s) => sel.includes(s))) {
          return { collection: route.collection, imageType: bl.headerImageType };
        }
        return { collection: route.collection, imageType: bl.defaultImageType };
      }
      return { collection: route.collection, imageType: route.imageType };
    }
  }

  // Exact routes (simple named static pages)
  if (imageRoutes.exactRoutes[urlPath]) {
    return imageRoutes.exactRoutes[urlPath];
  }

  // Generic fallback: same insight as router.js's text-side fix -- "Pages - Hero
  // Sections" is a one-item-per-static-page collection shared across every site
  // template. A single-segment path that matched nothing above is very likely
  // another page's hero image in that same collection.
  const segments = urlPath.split('/').filter(Boolean);
  if (segments.length === 1) {
    return { collection: 'Pages - Hero Sections', imageType: 'header-sections' };
  }

  return null;
}
