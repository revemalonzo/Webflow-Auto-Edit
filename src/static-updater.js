/**
 * Static element path executor.
 *
 * Resolves text updates on non-CMS elements using the Webflow Data API (read-only
 * for this purpose) but does NOT attempt to write via it -- see the note below.
 *
 * Resolution order:
 *   Page: exact slug → collectionId template → AI picks from full page list
 *   Element: CSS class → text match → component scan → AI picks from full element list
 */

import {
  listPages,
  queryElements,
  getAllComponentElements,
} from './webflow-client.js';
import { resolveTemplatePageWithAI, resolveElementWithAI, learnElementMapping } from './ai-resolver.js';
import { lookupElementId } from './element-mapper.js';

// Webflow's Data API v2 (POST /pages/{id}/dom) can only write static page/component
// content to a SECONDARY locale -- writes to a site's primary (default) locale
// ALWAYS fail regardless of what locale/localeId value is passed. Confirmed against
// Webflow's own docs ("API-based updates to page and component content are limited
// to secondary locales... requests to update primary locale content will fail") and
// via live testing across multiple locale-id variants. This is universal (every
// site, every element) -- it is never worth attempting this REST call for a write.
//
// There IS a working mechanism: Webflow's Designer/App API (reached via an MCP
// connection, e.g. data_element_tool.set_text) writes plain page-level static text
// headlessly, with NO locale restriction -- confirmed live. It cannot, however,
// write text nested inside a Component definition (scopeComponentId set) without
// first opening that component's canvas in an actual live Designer session
// (designer_tool.open_component_view errors "Unable to connect to Webflow Designer"
// otherwise) -- this is the client's own "bridge app" workflow. Since MCP tools are
// only reachable from an interactive Claude session (not from this standalone Node
// script), this pipeline cannot perform either write itself -- it resolves the
// target and returns needsMcpWrite so the caller can complete it via the MCP
// element tool (component-scoped targets still can't be completed headlessly).
export const BRIDGE_APP_REQUIRED_MSG =
  '⚠️ Automation skipped — this text lives inside a Webflow Component definition. Writing it requires ' +
  'a live Webflow Designer session for that component (the "bridge app"). Needs manual Designer edit.';

/**
 * Resolve (but do not write) a static element's text target.
 *
 * @param {object} opts
 * @param {string} opts.siteId
 * @param {string} opts.token
 * @param {string} opts.urlPath       - Page path (e.g. "/about")
 * @param {string} opts.selector      - CSS selector from ticket
 * @param {string} opts.htmlSnapshot  - HTML snapshot (used to find current text)
 * @param {string} opts.newValue      - New text to write
 * @param {Map}    opts.pagesCache    - Shared cache: urlPath → pageId
 * @param {string} opts.collectionId  - Pass when falling back from a CMS route
 * @param {boolean} opts.dryRun       - Unused (write is never attempted here); kept for call-site compatibility
 * @returns {{ success: boolean, needsMcpWrite?: boolean, pageId?: string, elementId?: string|null,
 *             scopeComponentId?: string|null, oldValue?: string|null, error?: string }}
 */
export async function updateStaticElement({
  siteId,
  token,
  urlPath,
  selector,
  htmlSnapshot,
  newValue,
  pagesCache,
  collectionId = null,
  dryRun = false,
}) {
  // 1. Resolve page ID
  let allPages = null;
  if (!pagesCache.has(urlPath)) {
    allPages = await listPages(siteId, token);
    for (const p of allPages) {
      const slug = p.slug ?? '';
      pagesCache.set(slug ? `/${slug}` : '/', p.id);
      if (p.collectionId) {
        pagesCache.set(`__collection__${p.collectionId}`, p.id);
      }
    }
    if (!pagesCache.has('/')) {
      const home = allPages.find((p) => !p.slug || p.slug === 'index');
      if (home) pagesCache.set('/', home.id);
    }
    pagesCache.set('__all__', allPages); // cache for AI fallback
  }

  let pageId = pagesCache.get(urlPath);

  // Fallback 1: collectionId → template page
  if (!pageId && collectionId) {
    pageId = pagesCache.get(`__collection__${collectionId}`) ?? null;
    if (pageId) console.log(`  Static: resolved "${urlPath}" via collectionId template`);
  }

  // Fallback 2: AI picks template page from full page list
  if (!pageId && process.env.OPENAI_API_KEY) {
    const pages = allPages ?? pagesCache.get('__all__') ?? null;
    if (pages) {
      const aiPageId = await resolveTemplatePageWithAI(urlPath, pages);
      if (aiPageId) {
        pageId = aiPageId;
        pagesCache.set(urlPath, pageId); // learn for future tickets on same path
      }
    }
  }

  if (!pageId) {
    return { success: false, error: `Page not found for path "${urlPath}".` };
  }

  // 1.5. KB cache -- if we've resolved this exact site + page + selector before,
  // skip the DOM fetch, matching, and AI entirely.
  const cached = lookupElementId(siteId, urlPath, selector);
  if (cached) {
    console.log(`  Static: KB hit for "${urlPath}" + selector -- using cached element ${cached.elementId}`);
    return resolvedResult({ pageId, elementId: cached.elementId, scopeComponentId: cached.scopeComponentId, oldValue: null });
  }

  // 2. Fetch all page DOM nodes once, then filter client-side
  //    Webflow GET /pages/{pageId}/dom returns { nodes: [...] } — flat list
  const cssClass = extractPrimaryClass(selector);
  const currentText = extractTextFromSnapshot(htmlSnapshot);

  let elementId = null;
  let scopeComponentId = null;
  let oldValue = null;

  const domResult = await queryElements(siteId, pageId, token);
  const allNodes = getNodes(domResult);
  console.log(`  Static: fetched ${allNodes.length} DOM nodes from page ${pageId}`);

  // 2a. By CSS class
  if (cssClass) {
    const byClass = allNodes.filter((n) =>
      (n.classNames ?? n.classes ?? []).includes(cssClass)
    );
    const match = findBestMatchFromNodes(byClass, selector);
    if (match) {
      elementId = match.nodeId ?? match.id;
      oldValue = extractNodeText(match) || null;
    }
  }

  // 2b. By current text
  if (!elementId && currentText) {
    const needle = currentText.toLowerCase();
    const match = allNodes.find((n) => {
      const t = extractNodeText(n).toLowerCase();
      return t && t.includes(needle);
    });
    if (match) {
      elementId = match.nodeId ?? match.id;
      oldValue = extractNodeText(match) || null;
    }
  }

  // 2c. Component instances — scan component DOM
  if (!elementId) {
    const componentNodes = allNodes.filter(
      (n) => n.type === 'ComponentInstance' || n.type === 'component-instance'
    );
    for (const comp of componentNodes) {
      // Webflow's page DOM returns the component definition id as `componentId` on
      // the instance node -- NOT componentDefinitionId/nodeId. Using the wrong field
      // here silently queries the instance's own id instead of its definition,
      // which always fails to find anything.
      const compDefId = comp.componentId ?? comp.componentDefinitionId ?? comp.id;
      const compDom = await getAllComponentElements(siteId, compDefId, token);
      const compNodes = getNodes(compDom);
      const match = findInNodes(compNodes, cssClass, currentText);
      if (match) {
        elementId = match.nodeId ?? match.id;
        scopeComponentId = compDefId;
        oldValue = extractNodeText(match) || currentText;
        break;
      }
    }
  }

  // 2d. AI picks element from full node list
  if (!elementId && process.env.OPENAI_API_KEY) {
    console.log(`  Static element not found via normal lookup — asking AI...`);
    const aiNodes = allNodes.map((n) => ({
      id: n.nodeId ?? n.id,
      text: extractNodeText(n),
      classNames: n.classNames ?? n.classes ?? [],
    }));
    const aiElementId = await resolveElementWithAI(selector, htmlSnapshot, aiNodes);
    if (aiElementId) {
      elementId = aiElementId;
      const matched = allNodes.find((n) => (n.nodeId ?? n.id) === aiElementId);
      oldValue = matched ? extractNodeText(matched) : null;
    }
  }

  if (!elementId) {
    return {
      success: false,
      error: '⚠️ Automation skipped — static element not found via Designer API or AI. Needs manual Webflow Designer edit.',
    };
  }

  // Learn the mapping as soon as it's resolved -- this is a pure lookup fact
  // (site + page + selector -> element id), independent of how/when it gets written.
  learnElementMapping(siteId, urlPath, selector, elementId, scopeComponentId);

  return resolvedResult({ pageId, elementId, scopeComponentId, oldValue });
}

/**
 * A resolved (page, element) target is never written by this script -- see the
 * module note above. Component-scoped targets are a hard dead-end here (need a
 * live Designer session); plain page targets can be completed via the MCP
 * element tool by whatever's orchestrating this run.
 */
function resolvedResult({ pageId, elementId, scopeComponentId, oldValue }) {
  if (scopeComponentId) {
    return { success: false, error: BRIDGE_APP_REQUIRED_MSG, pageId, elementId, scopeComponentId, oldValue };
  }
  return { success: false, needsMcpWrite: true, pageId, elementId, scopeComponentId: null, oldValue };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Normalise API response — handles both { nodes } and { elements } shapes */
function getNodes(result) {
  if (!result) return [];
  return result.nodes ?? result.elements ?? [];
}

function extractPrimaryClass(selector) {
  if (!selector) return null;
  const matches = selector.match(/\.([\w-]+)/g);
  return matches ? matches[matches.length - 1].slice(1) : null;
}

function findBestMatchFromNodes(nodes, selector) {
  if (!nodes?.length) return null;
  if (nodes.length === 1) return nodes[0];
  // Prefer nodes whose classNames contain more classes from the selector
  const selectorClasses = (selector.match(/\.([\w-]+)/g) ?? []).map((c) => c.slice(1));
  return nodes.reduce((best, n) => {
    const nodeClasses = n.classNames ?? n.classes ?? [];
    const score = selectorClasses.filter((c) => nodeClasses.includes(c)).length;
    const bestScore = selectorClasses.filter((c) => (best.classNames ?? best.classes ?? []).includes(c)).length;
    return score > bestScore ? n : best;
  });
}

function findInNodes(nodes, cssClass, currentText) {
  for (const n of nodes) {
    if (currentText && extractNodeText(n).includes(currentText)) return n;
    if (cssClass && (n.classNames ?? n.classes ?? []).includes(cssClass)) return n;
  }
  return null;
}

/**
 * Extract plain text from a Webflow DOM node.
 * The Webflow API returns `text` as either a plain string OR a rich-text object
 * (e.g. { type: 'plain', value: '...' } or { children: [...] }).
 * Always returns a string.
 */
function extractNodeText(n) {
  const t = n.text;
  if (!t) return '';
  if (typeof t === 'string') return t;
  if (typeof t === 'object') {
    // Common Webflow shapes: { value }, { text }, { plain }, or nested { children }
    if (typeof t.value === 'string') return t.value;
    if (typeof t.text === 'string') return t.text;
    if (typeof t.plain === 'string') return t.plain;
    if (Array.isArray(t.children)) {
      return t.children.map((c) => (typeof c === 'string' ? c : c.value ?? c.text ?? '')).join('');
    }
    // Last resort: stringify so we can at least log/compare
    return JSON.stringify(t);
  }
  return String(t);
}

function extractTextFromSnapshot(htmlSnapshot) {
  if (!htmlSnapshot) return null;
  return htmlSnapshot
    .replace(/^`+|`+$/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || null;
}
