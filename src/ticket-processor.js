/**
 * Core orchestration -- processes a single ticket end-to-end.
 *
 * Steps mirror SKILL.md:
 *   Step 2  -- extract fields, BugHerd fallback
 *   Step 2b -- pre-flight skip checks
 *   Router  -- CMS or static path
 *   Step 5/5b/6 -- update
 *   Step 8  -- Linear update
 */

import { getTaskDetails } from './bugherd-client.js';
import { routeTicket } from './router.js';
import { checkSkipConditions } from './skip-checker.js';
import { isStaticSkip } from './field-mapper.js';
import { updateCmsField } from './cms-updater.js';
import { updateStaticElement } from './static-updater.js';
import { passToQA, applySkipTreatment, postComment } from './linear-client.js';

const DRY_RUN = process.env.DRY_RUN === 'true';

/**
 * Extract structured fields from a Linear ticket's description (markdown).
 * Fields are formatted as: **Field Name**: value (possibly multi-line until next **Field**)
 */
function extractTicketFields(description = '') {
  const get = (label) => {
    const re = new RegExp(
      `\\*\\*${label}\\*\\*[:\\s]+(.*?)(?=\\n\\*\\*[^*]+\\*\\*[:\\s]|$)`,
      'si'
    );
    const m = description.match(re);
    return m ? m[1].trim() : null;
  };

  const adminLink = get('Admin Link') ?? '';
  const bhMatch = adminLink.match(/projects\/(\d+)\/tasks\/(\d+)/);

  return {
    pageUrl: get('Page URL'),
    newValue: get('Description') ?? get('New Value') ?? get('New Text'),
    selector: get('Path'),
    htmlSnapshot: get('HTML'),
    bugherdProjectId: bhMatch?.[1] ?? null,
    bugherdTaskId: bhMatch?.[2] ?? null,
  };
}

/**
 * Process one ticket.
 *
 * @param {object} ticket          - Linear issue object
 * @param {string} siteId
 * @param {string} wfToken         - Webflow token that can access the site
 * @param {string} wfShortName     - webflow.io subdomain (for staging URLs)
 * @param {Map}    collectionsCache
 * @param {Map}    pagesCache
 * @returns {{ outcome: 'updated'|'skipped'|'error', ticket, details }}
 */
export async function processTicket(ticket, siteId, wfToken, wfShortName, collectionsCache, pagesCache) {
  const existingLabelIds = ticket.labels?.nodes?.map((l) => l.id) ?? [];
  let fields = extractTicketFields(ticket.description);

  // BugHerd fallback for missing data
  if ((!fields.selector || !fields.htmlSnapshot || !fields.pageUrl) && fields.bugherdProjectId) {
    const bh = await getTaskDetails(fields.bugherdProjectId, fields.bugherdTaskId);
    fields.selector = fields.selector || bh.selector;
    fields.htmlSnapshot = fields.htmlSnapshot || bh.htmlSnapshot;
    fields.pageUrl = fields.pageUrl || bh.pageUrl;
  }

  // Bail if still missing critical data
  if (!fields.pageUrl) {
    return await skip(ticket, existingLabelIds, `Warning: Automation skipped -- no Page URL found on ticket even after BugHerd fallback.`);
  }
  if (!fields.newValue) {
    return await skip(ticket, existingLabelIds, `Warning: Automation skipped -- no new value found on ticket.`);
  }

  // Pre-flight skip checks
  const skipCheck = checkSkipConditions({
    selector: fields.selector ?? '',
    htmlSnapshot: fields.htmlSnapshot ?? '',
    newValue: fields.newValue,
  });
  if (skipCheck.skip) {
    return await skip(ticket, existingLabelIds, skipCheck.reason);
  }

  // Static FAQ heading check
  const staticSkip = isStaticSkip(fields.selector ?? '', fields.htmlSnapshot ?? '');
  if (staticSkip) {
    return await skip(ticket, existingLabelIds, `Warning: Automation skipped -- ${staticSkip}`);
  }

  // Route the ticket
  const route = routeTicket(fields.pageUrl, fields.selector ?? '');

  let updateResult;

  if (route.path === 'cms') {
    updateResult = await updateCmsField({
      siteId,
      token: wfToken,
      collectionName: route.collection,
      urlPath: route.urlPath,
      selector: fields.selector ?? '',
      htmlSnapshot: fields.htmlSnapshot ?? '',
      newValue: fields.newValue,
      collectionsCache,
      dryRun: DRY_RUN,
    });
  } else {
    updateResult = await updateStaticElement({
      siteId,
      token: wfToken,
      urlPath: route.urlPath,
      selector: fields.selector ?? '',
      htmlSnapshot: fields.htmlSnapshot ?? '',
      newValue: fields.newValue,
      pagesCache,
      dryRun: DRY_RUN,
    });
  }

  if (!updateResult.success) {
    return await skip(ticket, existingLabelIds, updateResult.error);
  }

  // Update succeeded -- build comment and pass to QA
  const method = route.path === 'cms' ? 'CMS update' : 'Designer element update';
  const location = route.path === 'cms'
    ? `Collection -> Field: ${route.collection} -> ${updateResult.fieldSlug}\nItem: ${updateResult.itemName}`
    : `Page -> Element: ${route.urlPath} -> ${updateResult.elementId}`;

  // wfShortName is the webflow.io subdomain, always correct for staging URL
  const comment = [
    'Automated Update Applied',
    `Method: ${method}`,
    location,
    `Old value: ${updateResult.oldValue ?? '(unknown)'}`,
    `New value: ${fields.newValue}`,
    `Staging URL: https://${wfShortName}.webflow.io${route.urlPath}`,
    `Published to: Staging (webflow.io subdomain only)`,
    `Applied at: ${new Date().toISOString()}`,
    '',
    'Please verify on staging before publishing to live.',
  ].join('\n');

  await postComment(ticket.id, comment, DRY_RUN);
  await passToQA(ticket.id, existingLabelIds, DRY_RUN);

  return { outcome: 'updated', ticket, details: updateResult, route, fields };
}

async function skip(ticket, existingLabelIds, reason) {
  await postComment(ticket.id, reason, DRY_RUN);
  await applySkipTreatment(ticket.id, existingLabelIds, DRY_RUN);
  return { outcome: 'skipped', ticket, reason };
}
