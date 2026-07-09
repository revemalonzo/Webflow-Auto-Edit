/**
 * Batch-level conflict detection.
 *
 * Checks for the Shared Locations item conflict: all program pages on a
 * Webflow site reference the same single Locations CMS item. If a batch
 * contains multiple tickets that each want to set a different value for
 * the same Locations field, they are in conflict and ALL must be skipped.
 *
 * This is a batch-level check — single-ticket skip-checker.js cannot
 * catch it because the conflict only emerges when comparing tickets.
 */

import { routeTicket } from './router.js';
import { lookupFieldSlug } from './field-mapper.js';

/**
 * Lightweight field extractor — only needs Page URL, Path, and Description.
 * Avoids importing the full ticket-processor parseTicketFields which also
 * resolves BugHerd, etc.
 */
function extractLightFields(description = '') {
  const get = (label) => {
    const re = new RegExp(
      `\\*\\*${label}\\*\\*[:\\s]+(.*?)(?=\\n\\*\\*[^*]+\\*\\*[:\\s]|$)`,
      'si'
    );
    const m = description.match(re);
    return m ? m[1].trim() : null;
  };
  return {
    pageUrl: get('Page URL'),
    selector: get('Path') ?? '',
    newValue: get('Description') ?? get('New Value') ?? get('New Text') ?? '',
  };
}

/**
 * Scan the work set for Shared Locations item conflicts.
 *
 * Returns a Set of ticket IDs that must be skipped due to conflicting
 * Locations field updates. Empty Set = no conflicts.
 *
 * @param {object[]} tickets - Linear issue objects with .id and .description
 */
export function detectLocationsConflicts(tickets) {
  // Map: fieldSlug -> Map<ticketId, normalizedNewValue>
  const fieldValues = new Map();

  for (const ticket of tickets) {
    const { pageUrl, selector, newValue } = extractLightFields(ticket.description ?? '');
    if (!pageUrl || !newValue) continue;

    let route;
    try {
      route = routeTicket(pageUrl, selector);
    } catch {
      continue;
    }

    if (route.collection !== 'Locations') continue;

    // Determine field slug (KB lookup, fall back to '__unknown__')
    const fieldSlug = lookupFieldSlug('Locations', selector) ?? '__unknown__';

    if (!fieldValues.has(fieldSlug)) fieldValues.set(fieldSlug, new Map());
    // Normalize value for comparison: lowercase + trim
    fieldValues.get(fieldSlug).set(ticket.id, newValue.trim().toLowerCase());
  }

  // A conflict exists when the same fieldSlug has 2+ distinct values
  const conflictFields = new Set();
  for (const [fieldSlug, idToVal] of fieldValues) {
    const uniqueVals = new Set(idToVal.values());
    if (uniqueVals.size >= 2) conflictFields.add(fieldSlug);
  }

  if (conflictFields.size === 0) return new Set();

  // Collect all ticket IDs involved in any conflicted field
  const conflictIds = new Set();
  for (const [fieldSlug, idToVal] of fieldValues) {
    if (conflictFields.has(fieldSlug)) {
      for (const id of idToVal.keys()) conflictIds.add(id);
    }
  }

  return conflictIds;
}
