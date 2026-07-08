/**
 * Webflow REST API client.
 *
 * Handles multi-token auth: tries WEBFLOW_API_TOKEN_1 through _4 in order,
 * using the first one that can see the target site.
 *
 * API base: https://api.webflow.com/v2
 * Docs: https://developers.webflow.com/data/reference
 */

const WEBFLOW_BASE = 'https://api.webflow.com/v2';

const TOKENS = [
  process.env.WEBFLOW_API_TOKEN_1,
  process.env.WEBFLOW_API_TOKEN_2,
  process.env.WEBFLOW_API_TOKEN_3,
  process.env.WEBFLOW_API_TOKEN_4,
].filter(Boolean);

const DISQUALIFIED_FOLDERS = ['67d8911fb1abf593c188531d'];

async function wfFetch(token, path, options = {}) {
  const url = `${WEBFLOW_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'accept-version': '1.0.0',
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`Webflow API ${res.status}: ${body}`);
    err.status = res.status;
    throw err;
  }

  return res.json();
}

/**
 * Find the site and working token for a given shortName.
 * Returns { siteId, token, tokenIndex } or throws if not found.
 */
export async function resolveSite(shortName) {
  for (let i = 0; i < TOKENS.length; i++) {
    const token = TOKENS[i];
    try {
      const data = await wfFetch(token, '/sites');
      const sites = data.sites ?? data;
      const match = sites.find((s) => s.shortName === shortName);
      if (!match) continue;
      if (DISQUALIFIED_FOLDERS.includes(match.parentFolderId)) {
        throw new Error(
          `Site "${shortName}" is in a disqualified folder and cannot be processed automatically.`
        );
      }
      return { siteId: match.id, token, tokenIndex: i + 1 };
    } catch (err) {
      if (err.status === 401 || err.status === 403) continue; // wrong workspace token
      throw err;
    }
  }
  throw new Error(
    `Site "${shortName}" not found in any connected Webflow workspace (tried ${TOKENS.length} token(s)).`
  );
}

/** List all collections for a site. */
export async function listCollections(siteId, token) {
  const data = await wfFetch(token, `/sites/${siteId}/collections`);
  return data.collections ?? data;
}

/** List items in a collection, with optional slug filter. */
export async function listCollectionItems(collectionId, token, { slug } = {}) {
  let path = `/collections/${collectionId}/items?limit=100`;
  if (slug) path += `&slug=${encodeURIComponent(slug)}`;
  const data = await wfFetch(token, path);
  return data.items ?? data;
}

/** Update a single CMS item field. */
export async function updateCollectionItem(collectionId, itemId, fields, token, dryRun = false) {
  if (dryRun) {
    console.log(`[DRY RUN] Would PATCH /collections/${collectionId}/items/${itemId}`, fields);
    return { id: itemId, ...fields };
  }
  return wfFetch(token, `/collections/${collectionId}/items/${itemId}`, {
    method: 'PATCH',
    body: JSON.stringify({ fields }),
  });
}

/** Publish a site to its webflow.io staging subdomain only. */
export async function publishToStaging(siteId, token, dryRun = false) {
  if (dryRun) {
    console.log(`[DRY RUN] Would publish site ${siteId} to staging`);
    return;
  }
  await wfFetch(token, `/sites/${siteId}/publish`, {
    method: 'POST',
    body: JSON.stringify({
      publishToWebflowSubdomain: true,
      customDomains: [], // NEVER publish to custom domains
    }),
  });
}

// ─── Data API — static elements ───────────────────────────────────────────────

/** List pages for a site. */
export async function listPages(siteId, token) {
  const data = await wfFetch(token, `/sites/${siteId}/pages`);
  return data.pages ?? data;
}

/** Query elements on a page. */
export async function queryElements(siteId, pageId, token, { text, cssClass, type, scopeComponentId } = {}) {
  const params = new URLSearchParams({ siteId, pageId });
  if (text) params.set('text', text);
  if (cssClass) params.set('cssClass', cssClass);
  if (type) params.set('type', type);
  if (scopeComponentId) params.set('scopeComponentId', scopeComponentId);

  return wfFetch(token, `/pages/${pageId}/elements?${params}`);
}

/** Get all elements in a component definition. */
export async function getAllComponentElements(componentId, token) {
  return wfFetch(token, `/components/${componentId}/elements`);
}

/** Set text on a static element. */
export async function setElementText(pageId, elementId, text, token, { scopeComponentId } = {}, dryRun = false) {
  if (dryRun) {
    console.log(`[DRY RUN] Would set text on element ${elementId} → "${text}"`);
    return;
  }
  const body = { text };
  if (scopeComponentId) body.scopeComponentId = scopeComponentId;

  return wfFetch(token, `/pages/${pageId}/elements/${elementId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}
