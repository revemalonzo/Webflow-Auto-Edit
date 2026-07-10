/**
 * Batch-level conflict detection.
 *
 * Checks for the Shared Locations item conflict: all program pages on a
 * Webflow site reference the same single Locations CMS item. If a batch
 * contains multiple tickets that each want to set a different value for
 * the same Locations field, they collide on the exact same underlying
 * (collection, item, field) — editing it for one program page overwrites
 * it for every other program page.
 *
 * Rather than skipping every ticket in the collision, we resolve the REAL
 * target (collection id + item id + field slug, via the same resolution
 * logic cms-updater.js uses) to confirm they truly collide, then let the
 * most-recently-created ticket win — it reflects the latest request from
 * the client — and skip the rest with a comment pointing at the winner.
 *
 * This is a batch-level check — single-ticket skip-checker.js cannot
 * catch it because the collision only emerges when comparing tickets.
 */

import { routeTicket } from './router.js';
import { resolveCmsTarget } from './cms-updater.js';

/**
 * Lightweight field extractor — Page URL, Path, HTML, and Description.
 * Avoids importing the full ticket-processor parseTicketFields which also
 * resolves BugHerd, etc.
 */
function extractLightFields(description = '') {
  const get = (label) => {
    const re = new RegExp(
      `\\*\\*${label}\\*\\*[:\\s]+(.*?)(?=\\n\\*\\*[^*]+\\*\\*[:\\s]|\\n#{1,6}\\s|$)`,
      'si'
    );
    const m = description.match(re);
    return m ? m[1].trim() : null;
  };

  // Strip Markdown link format [text](<url>) or [text](url) → bare URL
  const getUrl = (label) => {
    const raw = get(label);
    if (!raw) return null;
    const m = raw.match(/(https?:\/\/[^\s\]>)]+)/);
    return m ? m[1] : null;
  };

  return {
    pageUrl: getUrl('Page URL'),
    selector: (get('Path') ?? '').replace(/^`+|`+$/g, '').trim(),
    // Some Linear tickets embed the HTML with backslash-escaped quotes
    // (src=\"...\" instead of src="...") -- normalize before any attribute regex runs.
    htmlSnapshot: get('HTML')?.replace(/\\"/g, '"') ?? null,
    newValue: get('Description') ?? get('New Value') ?? get('New Text') ?? '',
  };
}

/**
 * Scan the work set for Shared Locations item collisions and pick a winner
 * for each one.
 *
 * @param {object[]} tickets - Linear issue objects with .id, .identifier, .createdAt, .description
 * @param {object} ctx - { siteId, token, collectionsCache }
 * @returns {Promise<{ winners: Set<string>, skips: Map<string, string> }>}
 *   winners - ticket IDs that should proceed to normal processing despite being part of a collision
 *   skips   - ticket ID -> skip reason, for tickets that lost a collision
 */
export async function resolveLocationsConflicts(tickets, { siteId, token, collectionsCache }) {
  // Shared across every resolveCmsTarget call in this pass -- these tickets almost always
  // land on the same one or two collections, so this avoids re-fetching fields/items per ticket.
  const fieldsCache = new Map();
  const itemsCache = new Map();

  // Map: "collectionId:itemId:fieldSlug" -> [{ ticket, newValue }]
  const targets = new Map();
  // Tickets we could not positively verify -- fail safe, keep the old "manual review" behavior
  // rather than let them through with no collision protection.
  const unverified = [];

  for (const ticket of tickets) {
    const { pageUrl, selector, htmlSnapshot, newValue } = extractLightFields(ticket.description ?? '');
    if (!pageUrl || !newValue) continue;

    let route;
    try {
      route = routeTicket(pageUrl, selector);
    } catch {
      continue;
    }
    if (route.collection !== 'Locations') continue;

    let resolved;
    try {
      resolved = await resolveCmsTarget({
        siteId,
        token,
        collectionName: route.collection,
        urlPath: route.urlPath,
        selector,
        htmlSnapshot,
        newValue,
        collectionsCache,
        fieldsCache,
        itemsCache,
      });
    } catch {
      resolved = { success: false };
    }

    if (!resolved.success) {
      // Can't confirm what this ticket actually targets -- can't safely verify a collision either way.
      unverified.push(ticket);
      continue;
    }

    const key = `${resolved.collectionId}:${resolved.itemId}:${resolved.fieldSlug}`;
    if (!targets.has(key)) targets.set(key, []);
    targets.get(key).push({ ticket, newValue: newValue.trim().toLowerCase() });
  }

  const winners = new Set();
  const skips = new Map();

  for (const entries of targets.values()) {
    if (entries.length < 2) continue;

    const uniqueValues = new Set(entries.map((e) => e.newValue));
    if (uniqueValues.size < 2) continue; // same value requested everywhere -- no real conflict

    // Most-recently-created ticket wins.
    entries.sort((a, b) => new Date(b.ticket.createdAt) - new Date(a.ticket.createdAt));
    const [winner, ...losers] = entries;
    winners.add(winner.ticket.id);

    for (const loser of losers) {
      skips.set(
        loser.ticket.id,
        `Warning: Automation skipped -- this Locations field was also requested by a more recent ticket (${winner.ticket.identifier}), which will be applied instead since it reflects the latest request. If this ticket's value should win instead, flag ${winner.ticket.identifier} for manual review.`
      );
    }
  }

  // Tickets whose real target we couldn't verify: fall back to the conservative
  // architectural-conflict skip rather than risk an unverified shared write.
  for (const ticket of unverified) {
    if (skips.has(ticket.id) || winners.has(ticket.id)) continue;
    skips.set(
      ticket.id,
      'Warning: Automation skipped -- architectural conflict. The Locations item is shared across all program pages, and this ticket\'s exact target field/item could not be positively verified. Needs manual review.'
    );
  }

  return { winners, skips };
}
