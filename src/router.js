/**
 * Routes a ticket's page URL + selector to a Webflow collection name.
 * Logic ported directly from SKILL.md Step 2 / Step 4.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const urlRoutes = require('../knowledge-base/url-routes.json');

/**
 * Determine routing path and collection for a ticket.
 *
 * @param {string} pageUrl   - Full page URL (e.g. "https://foo.webflow.io/programs/yoga")
 * @param {string} selector  - CSS selector path from the ticket
 * @returns {{ path: 'cms'|'static', collection: string|null, urlPath: string }}
 */
export function routeTicket(pageUrl, selector) {
  const url = new URL(pageUrl);
  const urlPath = url.pathname;

  // CMS signal: selector contains w-dyn-item regardless of URL
  if (selector && selector.includes('w-dyn-item')) {
    const collection = resolveCollectionFromUrl(urlPath, selector);
    return { path: 'cms', collection, urlPath };
  }

  // Check if URL is a known CMS template route
  const collection = resolveCollectionFromUrl(urlPath, selector);
  if (collection) {
    return { path: 'cms', collection, urlPath };
  }

  // No CMS match -- static path
  return { path: 'static', collection: null, urlPath };
}

function resolveCollectionFromUrl(urlPath, selector) {
  // Exact routes
  if (urlRoutes.exactRoutes[urlPath]) {
    return urlRoutes.exactRoutes[urlPath];
  }

  // Homepage programs section: / + selector contains w-dyn-items in programs section
  if (urlPath === '/' && selector && selector.includes('w-dyn-items')) {
    return 'Programs';
  }

  // Prefix routes (e.g. /programs/slug)
  for (const route of urlRoutes.prefixRoutes) {
    if (urlPath.startsWith(route.prefix)) {
      // Cross-collection overrides for /programs/{slug}
      if (route.prefix === '/programs/' && selector) {
        const overrides = urlRoutes.crossCollectionOverrides['/programs/{slug}'];
        for (const [sectionSelector, overrideCollection] of Object.entries(overrides)) {
          if (selector.includes(sectionSelector.replace('section.', ''))) {
            return overrideCollection;
          }
        }
      }
      return route.collection;
    }
  }

  return null;
}

/**
 * Extract the slug from a URL path given a prefix.
 * e.g. "/programs/yoga-flow" => "yoga-flow"
 */
export function extractSlug(urlPath, prefix) {
  if (!urlPath.startsWith(prefix)) return null;
  return urlPath.slice(prefix.length).replace(/\/$/, '') || null;
}
