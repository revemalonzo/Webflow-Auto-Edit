/**
 * Resolves which CMS item an image-swap ticket targets, within a collection
 * already identified by image-router.js. Ported from wf-image-updaterSKILL.md Step 6.
 *
 * Method A -- URL contains a CMS slug (/programs/x, /coaches/x, /blog/x): filter by slug.
 * Method B -- dynamic list on a static page (no slug in URL), three tiers:
 *   1. Position index (collection-item-N in the selector, or BugHerd's #idN)
 *   2. Image src fileId match
 *   3. Contextual match: item name found in the <img> alt text or filename
 *
 * KNOWN LIMITATION (tier 1, #idN case only): BugHerd's #idN numbering is GLOBAL
 * across every w-dyn-item on the page, not per-collection -- if a page has more
 * than one dynamic list before this one, the raw #idN needs adjusting by how many
 * items precede it in OTHER lists first. This resolver currently treats #idN as
 * already local to the routed collection's own list. That is correct when this
 * collection's list is the only (or first) one on the page, but will be off by
 * an offset on pages with multiple dynamic lists above it. Flagging rather than
 * silently guessing wrong -- validate against a real multi-list page before trusting
 * this tier blindly; prefer the explicit `collection-item-N` class match when present,
 * since that one is already list-local.
 */

import { listCollectionItems } from './webflow-client.js';

function extractSlugFromPath(urlPath) {
  // Last segment regardless of depth -- covers both /programs/{slug} (2 segments)
  // and single-segment "Pages - Hero Sections" pages like /after-school-pick-up,
  // where the whole path IS the slug.
  const parts = urlPath.split('/').filter(Boolean);
  return parts.length >= 1 ? parts[parts.length - 1] : null;
}

/**
 * @returns {{ index: number, source: 'collection-item' } | null} 0-based index
 */
function extractPositionIndex(selector) {
  const explicit = selector?.match(/collection-item-(\d+)/);
  if (explicit) return { index: Number(explicit[1]), source: 'collection-item' };

  // BugHerd's #idN tier was REMOVED after confirmed live damage: it's 1-based and
  // GLOBAL across every w-dyn-item on the page (not local to this collection's own
  // list), and neither raw API order nor alphabetical order lined up with the
  // client's correction on the tickets that surfaced this (BUGHERD-51257/51258/
  // 51479/51480 all matched the wrong Amenities item). No reliable way to compute
  // the correct local offset without knowing exactly how many OTHER dynamic lists
  // precede this one on the page -- falling through to fileId/context tiers (or
  // manual review) is safer than guessing with a heuristic proven wrong in production.
  return null;
}

function extractImgSrcFileId(htmlSnapshot) {
  const srcMatch = htmlSnapshot?.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (!srcMatch) return null;
  // Webflow-hosted asset URLs have TWO 24-char hex segments: .../{siteAssetFolderId}/{fileId}_{name}.jpg
  // -- anchor to the one immediately before the filename (preceded by "/", followed by "_"),
  // not just the first 24-hex-char match anywhere in the URL (confirmed bug: that grabbed
  // the folder id instead of the actual per-file id).
  const fileIdMatch = srcMatch[1].match(/\/([a-f0-9]{24})_[^/]+$/i);
  return fileIdMatch ? { fileId: fileIdMatch[1], src: srcMatch[1] } : null;
}

function extractAltAndFilename(htmlSnapshot) {
  const altMatch = htmlSnapshot?.match(/<img[^>]+alt=["']([^"']*)["']/i);
  const srcMatch = htmlSnapshot?.match(/<img[^>]+src=["']([^"']+)["']/i);
  const filename = srcMatch ? decodeURIComponent(srcMatch[1].split('/').pop() ?? '') : null;
  return { alt: altMatch?.[1] ?? null, filename };
}

function fieldImageValues(item) {
  return Object.values(item.fieldData ?? {}).filter((v) => v && typeof v === 'object' && typeof v.url === 'string');
}

/**
 * @param {object} opts
 * @param {string} opts.collectionId
 * @param {string} opts.token
 * @param {string} opts.urlPath
 * @param {string} opts.selector
 * @param {string} opts.htmlSnapshot
 * @returns {Promise<{ item: object, method: string, detail: string } | { item: null, reason: string }>}
 */
export async function resolveImageItem({ collectionId, token, urlPath, selector, htmlSnapshot }) {
  // Method A: URL slug. The homepage ("/") has no path segment to derive a slug from,
  // but confirmed convention: one-item-per-page collections (Pages - Hero Sections,
  // etc.) consistently name the homepage's own item slug "homepage" -- try that
  // directly rather than falling through to position/fileId/context tiers that
  // don't apply to a singleton-per-page item anyway.
  const urlSlug = extractSlugFromPath(urlPath) ?? (urlPath === '/' ? 'homepage' : null);
  if (urlSlug) {
    const items = await listCollectionItems(collectionId, token, { slug: urlSlug });
    if (items[0]) return { item: items[0], method: 'urlSlug', detail: `slug="${urlSlug}"` };
  }

  // Method B, tier 1: position index
  const position = extractPositionIndex(selector);
  if (position) {
    const all = await listCollectionItems(collectionId, token);
    const published = all
      .filter((i) => i.isDraft === false && i.lastPublished)
      .sort((a, b) => {
        const sa = a.fieldData?.['sort-order'];
        const sb = b.fieldData?.['sort-order'];
        if (sa != null && sb != null) return sa - sb;
        return (a.fieldData?.name ?? '').localeCompare(b.fieldData?.name ?? '');
      });

    if (position.index >= 0 && position.index < published.length) {
      const item = published[position.index];
      return {
        item,
        method: 'position',
        detail: `${position.source}=${position.index} -> position ${position.index} of ${published.length} published items -> "${item.fieldData?.name ?? item.id}"`,
      };
    }
    if (position.index >= published.length) {
      return { item: null, reason: `Position index ${position.index} exceeds ${published.length} published items. Requires manual review.` };
    }
  }

  // Method B, tier 2: fileId match
  const fileIdInfo = extractImgSrcFileId(htmlSnapshot);
  if (fileIdInfo) {
    const all = await listCollectionItems(collectionId, token);
    const matches = all.filter((item) =>
      fieldImageValues(item).some((v) => v.url.includes(fileIdInfo.fileId))
    );
    if (matches.length === 1) {
      return { item: matches[0], method: 'fileId', detail: `fileId=${fileIdInfo.fileId} -> "${matches[0].fieldData?.name ?? matches[0].id}"` };
    }
    if (matches.length > 1) {
      // Real, confirmed case: two different items can share the exact same uploaded
      // asset (e.g. a client reused one photo across two programs). Before giving up,
      // try narrowing using alt-text/filename context -- but ONLY among these already-
      // tied candidates, not the whole collection, so this stays a safe disambiguation
      // of a short list rather than a broad, riskier guess.
      const { alt, filename } = extractAltAndFilename(htmlSnapshot);
      if (alt || filename) {
        const narrowed = matches.filter((item) => {
          const name = item.fieldData?.name;
          if (!name) return false;
          return (alt && alt.includes(name)) || (filename && filename.includes(name));
        });
        if (narrowed.length === 1) {
          return {
            item: narrowed[0],
            method: 'fileId+context',
            detail: `fileId=${fileIdInfo.fileId} matched ${matches.length} items (${matches.map((m) => m.fieldData?.name).join(', ')}) -- narrowed by alt/filename context to "${narrowed[0].fieldData?.name}"`,
          };
        }
      }
      return { item: null, reason: `fileId ${fileIdInfo.fileId} matched ${matches.length} items (${matches.map((m) => m.fieldData?.name).join(', ')}) and alt/filename context did not uniquely narrow it. Requires manual review.` };
    }
    // zero matches -- fall through to tertiary
  }

  // Method B, tier 3: contextual alt-text/filename match (fileId stale or absent)
  const { alt, filename } = extractAltAndFilename(htmlSnapshot);
  if (alt || filename) {
    const all = await listCollectionItems(collectionId, token);
    const matches = all.filter((item) => {
      const name = item.fieldData?.name;
      if (!name) return false;
      return (alt && alt.includes(name)) || (filename && filename.includes(name));
    });
    if (matches.length === 1) {
      return {
        item: matches[0],
        method: 'context',
        detail: `stale fileId -- identified by alt/filename context: alt="${alt}" file="${filename}" -> "${matches[0].fieldData?.name}"`,
      };
    }
    return {
      item: null,
      reason: `Could not uniquely identify item by alt text or filename (alt="${alt}", file="${filename}", matches=${matches.length}). Requires manual review.`,
    };
  }

  return { item: null, reason: 'No slug, position index, fileId, or alt/filename signal available to identify the target item.' };
}
