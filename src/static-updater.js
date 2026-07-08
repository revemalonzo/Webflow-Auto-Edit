/**
 * Static element path executor.
 *
 * Handles text updates on non-CMS elements using the Webflow Data API.
 * Supports both page-level elements and elements inside component definitions.
 */

import {
  listPages,
  queryElements,
  getAllComponentElements,
  setElementText,
} from './webflow-client.js';

/**
 * Update a static element's text.
 *
 * @param {object} opts
 * @param {string} opts.siteId
 * @param {string} opts.token
 * @param {string} opts.urlPath       - Page path (e.g. "/about")
 * @param {string} opts.selector      - CSS selector from ticket
 * @param {string} opts.htmlSnapshot  - HTML snapshot (used to find current text)
 * @param {string} opts.newValue      - New text to write
 * @param {Map}    opts.pagesCache    - Shared cache: urlPath → pageId
 * @param {boolean} opts.dryRun
 * @returns {{ success: boolean, elementId: string|null, oldValue: string|null, error?: string }}
 */
export async function updateStaticElement({
  siteId,
  token,
  urlPath,
  selector,
  htmlSnapshot,
  newValue,
  pagesCache,
  dryRun = false,
}) {
  // 1. Resolve page ID
  if (!pagesCache.has(urlPath)) {
    const pages = await listPages(siteId, token);
    for (const p of pages) {
      pagesCache.set(p.slug ? `/${p.slug}` : '/', p.id);
    }
    // Normalize root
    if (!pagesCache.has('/')) {
      const home = pages.find((p) => !p.slug || p.slug === 'index');
      if (home) pagesCache.set('/', home.id);
    }
  }

  const pageId = pagesCache.get(urlPath);
  if (!pageId) {
    return { success: false, error: `Page not found for path "${urlPath}".` };
  }

  // 2. Try to find the element — first by CSS class, then by current text
  const cssClass = extractPrimaryClass(selector);
  const currentText = extractTextFromSnapshot(htmlSnapshot);

  let elementId = null;
  let scopeComponentId = null;
  let oldValue = null;

  // Try direct page query first
  const byClass = cssClass
    ? await queryElements(siteId, pageId, token, { cssClass })
    : null;

  const directMatch = findBestMatch(byClass, selector);

  if (directMatch) {
    elementId = directMatch.id;
    oldValue = directMatch.text ?? directMatch.children?.[0]?.text ?? null;
  } else {
    // Try text-based search
    if (currentText) {
      const byText = await queryElements(siteId, pageId, token, { text: currentText });
      const textMatch = byText?.elements?.[0] ?? null;
      if (textMatch) {
        elementId = textMatch.id;
        oldValue = textMatch.text ?? currentText;
      }
    }
  }

  // 3. If not found on page directly, check component instances
  if (!elementId) {
    const components = await queryElements(siteId, pageId, token, { type: 'ComponentInstance' });
    for (const comp of (components?.elements ?? [])) {
      const compDefId = comp.componentDefinitionId ?? comp.id;
      const allElements = await getAllComponentElements(compDefId, token);
      const match = findInComponentElements(allElements?.elements ?? [], selector, currentText);
      if (match) {
        elementId = match.id;
        scopeComponentId = compDefId;
        oldValue = match.text ?? currentText;
        break;
      }
    }
  }

  if (!elementId) {
    return {
      success: false,
      error: '⚠️ Automation skipped — static element not found via Designer API. Needs manual Webflow Designer edit.',
    };
  }

  // 4. Apply update
  await setElementText(pageId, elementId, newValue, token, { scopeComponentId }, dryRun);

  return { success: true, elementId, scopeComponentId, oldValue, pageId };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractPrimaryClass(selector) {
  if (!selector) return null;
  // Last class in the selector chain is usually most specific
  const matches = selector.match(/\.([\w-]+)/g);
  return matches ? matches[matches.length - 1].slice(1) : null;
}

function findBestMatch(queryResult, selector) {
  const elements = queryResult?.elements ?? [];
  if (elements.length === 0) return null;
  if (elements.length === 1) return elements[0];
  // Multiple matches — pick the one whose selector best matches
  return elements[0]; // TODO: improve disambiguation if needed
}

function findInComponentElements(elements, selector, currentText) {
  for (const el of elements) {
    if (currentText && el.text && el.text.includes(currentText)) return el;
    if (selector && el.classNames?.some((c) => selector.includes(c))) return el;
    if (el.children) {
      const found = findInComponentElements(el.children, selector, currentText);
      if (found) return found;
    }
  }
  return null;
}

function extractTextFromSnapshot(htmlSnapshot) {
  if (!htmlSnapshot) return null;
  return htmlSnapshot
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || null;
}
