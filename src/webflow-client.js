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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Confirmed real crash: a single 429 (rate limit) during a live 40-batch run took
// down the entire process uncaught, mid-batch -- losing all remaining discovery
// progress for that run. Retry transient failures (429, and 5xx which are usually
// momentary) with backoff before giving up; anything else still throws immediately.
async function wfFetch(token, path, options = {}, attempt = 1) {
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
    const isTransient = res.status === 429 || res.status >= 500;
    if (isTransient && attempt <= 4) {
      const retryAfterHeader = Number(res.headers.get('retry-after'));
      const delayMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
        ? retryAfterHeader * 1000
        : 1000 * 2 ** (attempt - 1); // 1s, 2s, 4s, 8s
      console.warn(`  Webflow API ${res.status} on ${path} -- retrying in ${delayMs}ms (attempt ${attempt}/4)...`);
      await sleep(delayMs);
      return wfFetch(token, path, options, attempt + 1);
    }
    const body = await res.text();
    const err = new Error(`Webflow API ${res.status}: ${body}`);
    err.status = res.status;
    throw err;
  }

  return res.json();
}

/**
 * Normalize a domain string: strip www. prefix and lowercase.
 * e.g. "www.MyGym.com" => "mygym.com"
 */
function normalizeDomain(d) {
  return d?.replace(/^www\./i, '').toLowerCase() ?? '';
}

/**
 * Find the site and working token for a given shortName or customDomain.
 *
 * Pass exactly one of:
 *   shortName   - the webflow.io subdomain (e.g. "my-gym")
 *   customDomain - a custom domain WITHOUT www. prefix (e.g. "mygym.com")
 *
 * Always returns { siteId, token, tokenIndex, shortName } where shortName
 * is the webflow.io subdomain — use this for staging URLs regardless of
 * whether the ticket URL was a custom domain.
 *
 * Throws if not found in any workspace or if site is in a disqualified folder.
 */
export async function resolveSite(shortName, customDomain = null) {
  const normalizedCustom = customDomain ? normalizeDomain(customDomain) : null;

  for (let i = 0; i < TOKENS.length; i++) {
    const token = TOKENS[i];
    try {
      const data = await wfFetch(token, '/sites');
      const sites = data.sites ?? data;

      let match;
      if (normalizedCustom) {
        // Custom domain: check each site's customDomains list
        match = sites.find((s) =>
          s.customDomains?.some((d) => normalizeDomain(d.url) === normalizedCustom)
        );
      } else {
        // Standard webflow.io subdomain: exact match only (no fuzzy matching)
        match = sites.find((s) => s.shortName === shortName);
      }

      if (!match) continue;

      if (DISQUALIFIED_FOLDERS.includes(match.parentFolderId)) {
        throw new Error(
          `Site "${match.shortName}" is in a disqualified folder and cannot be processed automatically.`
        );
      }

      return {
        siteId: match.id,
        token,
        tokenIndex: i + 1,
        shortName: match.shortName, // always the webflow.io subdomain
        displayName: match.displayName ?? match.shortName, // human-readable site/gym name, e.g. for alt text
      };
    } catch (err) {
      if (err.status === 401 || err.status === 403) continue; // wrong workspace token
      throw err;
    }
  }

  const identifier = normalizedCustom ?? shortName;
  throw new Error(
    `Site "${identifier}" not found in any connected Webflow workspace (tried ${TOKENS.length} token(s)).`
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

/**
 * Update a single CMS item's fields. Webflow v2 wraps fields under fieldData;
 * itemLevelFields (e.g. { isDraft: false }) are item-level properties and go
 * alongside fieldData, not inside it.
 */
export async function updateCollectionItem(collectionId, itemId, fields, token, dryRun = false, itemLevelFields = {}) {
  const body = { ...itemLevelFields, fieldData: fields };
  if (dryRun) {
    console.log(`[DRY RUN] Would PATCH /collections/${collectionId}/items/${itemId}`, body);
    return { id: itemId, ...itemLevelFields, fieldData: fields };
  }
  return wfFetch(token, `/collections/${collectionId}/items/${itemId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

/** Get field definitions for a collection -- used when field slug is not in KB. */
export async function getCollectionFields(collectionId, token) {
  const data = await wfFetch(token, `/collections/${collectionId}`);
  return data.fields ?? data.collection?.fields ?? [];
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

// --- Data API -- static elements ---

/** List pages for a site. */
export async function listPages(siteId, token) {
  const data = await wfFetch(token, `/sites/${siteId}/pages`);
  return data.pages ?? data;
}

/**
 * Get all static DOM nodes for a page (client-side filtering only).
 * Webflow Data API: GET /v2/pages/{pageId}/dom
 *
 * The API does NOT support server-side cssClass/text/type filtering —
 * callers must filter the returned nodes themselves.
 * Returns { nodes: [...] } or null on error.
 */
export async function queryElements(siteId, pageId, token, _filters = {}) {
  try {
    return await wfFetch(token, `/pages/${pageId}/dom`);
  } catch (err) {
    console.warn(`  queryElements failed for page ${pageId}: ${err.message}`);
    return null;
  }
}

/**
 * Get all static DOM nodes for a component definition.
 * Webflow Data API: GET /v2/sites/{siteId}/components/{componentId}/dom
 */
export async function getAllComponentElements(siteId, componentId, token) {
  try {
    return await wfFetch(token, `/sites/${siteId}/components/${componentId}/dom`);
  } catch (err) {
    console.warn(`  getAllComponentElements failed for ${componentId}: ${err.message}`);
    return null;
  }
}

// NOTE: there is no setElementText/write-via-REST function here. Webflow's Data API
// v2 (POST /pages/{id}/dom) can only write to a SECONDARY locale -- primary-locale
// static content can never be written this way, confirmed against Webflow's own
// docs and via live testing. See static-updater.js's module comment for the actual
// mechanism (Designer/App API via MCP) and its own limits (component-scoped text
// still needs a live Designer session).
