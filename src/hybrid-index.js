/**
 * Hybrid entry point -- polls/accepts a batch (parent issue + subissues, or a
 * single new-edit ticket) and routes EACH ticket to whichever pipeline actually
 * applies (image swap, CMS text, or static-element resolution), instead of
 * running two separate label-filtered pipelines against the same batch.
 *
 * Ignores ai:* routing labels entirely -- eligibility is decided per-ticket by
 * each specialist (does it have an image attachment? does the CMS/static router
 * find a target?), same as the manual "run image pipeline, then text pipeline"
 * workflow this replaces.
 *
 * Usage:
 *   HYBRID_BATCH_URLS="https://linear.app/...,https://linear.app/..." node src/hybrid-index.js
 *   DISCOVER_BATCH_LIMIT=10 node src/hybrid-index.js   # also auto-discover N more batches from the backlog
 *   DRY_RUN=true node src/hybrid-index.js
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DISCOVERY_SEEN_PATH = path.join(__dirname, '..', 'progress', 'discovery-seen.json');

/**
 * Tickets that were already diagnosed and correctly skipped (structural/new_item/
 * ambiguous/etc) never earn ai:edited, so label-agnostic discovery re-selects them
 * on every run -- they're always "oldest" and block real progress through the
 * backlog. Track them locally (not a Linear label -- no new label plumbing needed)
 * and exclude on subsequent discovery calls within/across runs.
 */
function loadDiscoverySeen() {
  try {
    return new Set(JSON.parse(fs.readFileSync(DISCOVERY_SEEN_PATH, 'utf8')));
  } catch {
    return new Set();
  }
}
function saveDiscoverySeen(seenSet) {
  fs.mkdirSync(path.dirname(DISCOVERY_SEEN_PATH), { recursive: true });
  fs.writeFileSync(DISCOVERY_SEEN_PATH, JSON.stringify([...seenSet]));
}

import { pollTicketsByState, getIssue, listSubissues, postComment, postCommentIfNew, applySkipTreatment } from './linear-client.js';
import { resolveSite, publishToStaging } from './webflow-client.js';
import { processTicket } from './ticket-processor.js';
import { processImageTicket, extractImageTicketFields, isSupportedFormat } from './image-processor.js';
import { getTaskDetails } from './bugherd-client.js';

/**
 * Find a usable Page URL across a whole batch, trying each ticket's raw
 * description first, then its BugHerd fallback. Confirmed real gap: tickets
 * with no existing target element (e.g. "add a new program" requests) often
 * lack a **Page URL** field entirely since there's no element to point at --
 * previously this silently skipped the WHOLE batch with no ticket ever seeing
 * a comment, even when a sibling ticket (or the same ticket via BugHerd) did
 * have a resolvable URL.
 */
async function findBatchPageUrl(workSet) {
  for (const ticket of workSet) {
    const m = ticket.description?.match(/\*\*Page URL\*\*[:\s]*\[?(https?:\/\/[^\s\]>)]+)/i);
    if (m) return m[1];
  }
  for (const ticket of workSet) {
    const adminLink = ticket.description?.match(/\*\*Admin Link\*\*[:\s]*\[?[^\]]*\]?\(<?([^)>]+)>?\)/i)?.[1] ?? '';
    const bhMatch = adminLink.match(/projects\/(\d+)\/tasks\/(\d+)/);
    if (!bhMatch) continue;
    try {
      const bh = await getTaskDetails(bhMatch[1], bhMatch[2]);
      if (bh.pageUrl) return bh.pageUrl;
    } catch {
      // try the next ticket
    }
  }
  return null;
}
import { resolveLocationsConflicts } from './conflicts.js';
import { runGroupingStep } from './grouping.js';

const require = createRequire(import.meta.url);
const knownIds = require('../knowledge-base/known-ids.json');
const { labels, states } = knownIds.linear;

const DRY_RUN = process.env.DRY_RUN === 'true';
const BATCH_URLS = (process.env.HYBRID_BATCH_URLS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const DISCOVER_LIMIT = Number(process.env.DISCOVER_BATCH_LIMIT ?? 0);

function parseSiteFromUrl(pageUrl) {
  const hostname = new URL(pageUrl).hostname;
  if (hostname.endsWith('.webflow.io')) {
    const shortName = hostname.replace(/\.webflow\.io$/, '').split('.')[0];
    return { shortName, customDomain: null };
  }
  const customDomain = hostname.replace(/^www\./i, '');
  return { shortName: null, customDomain };
}

const AUTOMATABLE_STATE_IDS = new Set([states.newEdit, states.liveEditsQueue, states.notLiveEditsQueue]);

// "Ignore ai:* labels" means ignore the ROUTING labels (ai:available/ai:text-change)
// that an upstream classifier may have failed to apply -- it does NOT mean ignore
// explicit prior judgment calls. Confirmed real, serious damage: 4 duplicate Linear
// tickets for the same underlying BugHerd task already carried ai:out-of-scope /
// ai:duplicate from an earlier human/upstream pass, and label-agnostic discovery
// blindly reprocessed all 4 anyway, cascading the same screenshot into a hero image
// field four times. These labels are a hard exclusion, same as ai:edited.
function isExcludedFromAutomation(ticket) {
  const excludedIds = new Set([labels.aiEdited, labels.aiOutOfScope, labels.aiDuplicate]);
  return ticket.labels?.nodes?.some((l) => excludedIds.has(l.id)) ?? false;
}

async function buildWorkSetForIssue(identifier) {
  const issue = await getIssue(identifier);
  const isParent =
    issue.labels?.nodes?.some((l) => l.id === labels.parentIssue) ||
    !issue.description?.includes('**Page URL**');

  let workSet, batchType, parentTicket = null;
  if (isParent) {
    parentTicket = issue;
    const subissues = await listSubissues(issue.id);
    workSet = [issue, ...subissues];
    batchType = 'queue';
  } else {
    workSet = [issue];
    batchType = 'newEdit';
  }

  workSet = workSet.filter((t) => !isExcludedFromAutomation(t));
  workSet = workSet.filter((t) => AUTOMATABLE_STATE_IDS.has(t.state?.id));
  return { workSet, batchType, parentTicket };
}

/** Discover up to `limit` additional batches from the backlog, ignoring ai:* labels entirely. */
async function discoverBatches(limit, discoverySeen) {
  const queueStateIds = [states.liveEditsQueue, states.notLiveEditsQueue, states.newEdit];
  const sweeps = await Promise.all(queueStateIds.map((stateId) => pollTicketsByState({ stateId })));
  const all = sweeps.flat();

  const dedupe = new Set();
  const eligible = all.filter((t) => {
    if (dedupe.has(t.id)) return false;
    dedupe.add(t.id);
    if (discoverySeen.has(t.id)) return false;
    return !isExcludedFromAutomation(t);
  });

  const byParent = new Map();
  const solo = [];
  for (const t of eligible) {
    if (t.parent?.id) {
      if (!byParent.has(t.parent.id)) byParent.set(t.parent.id, []);
      byParent.get(t.parent.id).push(t);
    } else if (t.children?.nodes?.length > 0) {
      if (!byParent.has(t.id)) byParent.set(t.id, [t]);
      else byParent.get(t.id).unshift(t);
    } else {
      solo.push(t);
    }
  }

  // Solo tickets (no Linear parent/child link) with matching titles are almost
  // always the same site-edit request split into separate BugHerd tasks --
  // group them so they get processed together with full conflict context, same
  // as the original text updater's newEdit batching.
  const byTitle = new Map();
  const trulySolo = [];
  for (const t of solo) {
    const key = t.title?.trim().toLowerCase();
    if (!key) { trulySolo.push(t); continue; }
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(t);
  }

  const batches = [];
  for (const [parentId, tickets] of byParent) batches.push({ parentId, tickets, batchType: 'queue' });
  for (const [, tickets] of byTitle) {
    if (tickets.length >= 2) batches.push({ parentId: null, tickets, batchType: 'newEdit' });
    else trulySolo.push(...tickets);
  }
  for (const t of trulySolo) batches.push({ parentId: null, tickets: [t], batchType: 'newEdit' });

  batches.sort(
    (a, b) => Math.min(...a.tickets.map((t) => new Date(t.createdAt))) - Math.min(...b.tickets.map((t) => new Date(t.createdAt)))
  );
  return batches.slice(0, limit);
}

async function processBatch(workSet, batchType, parentTicket) {
  if (workSet.length === 0) return null;

  const pageUrl = await findBatchPageUrl(workSet);
  if (!pageUrl) {
    console.error(`  No Page URL found on any ticket in this batch (including via BugHerd fallback). Skipping.`);
    for (const t of workSet) {
      const existingLabelIds = t.labels?.nodes?.map((l) => l.id) ?? [];
      await postCommentIfNew(t.id, 'Warning: Automation skipped -- could not determine which site/page this batch targets (no Page URL found on any ticket, including via BugHerd fallback).', DRY_RUN);
      await applySkipTreatment(t.id, existingLabelIds, DRY_RUN);
    }
    return null;
  }
  let parsedSite;
  try {
    parsedSite = parseSiteFromUrl(pageUrl);
  } catch {
    console.error(`  Invalid Page URL: ${pageUrl}. Skipping batch.`);
    return null;
  }

  const { shortName: parsedShortName, customDomain } = parsedSite;
  const siteLabel = customDomain ?? parsedShortName;

  let siteInfo;
  try {
    siteInfo = await resolveSite(parsedShortName, customDomain);
  } catch (err) {
    const blockedMsg = [
      'Blocked -- Inaccessible Workspace',
      `The Page URL is ${pageUrl}. Site "${siteLabel}" not found in any connected Webflow workspace.`,
      'This ticket requires manual action or workspace reconnection.',
    ].join('\n');
    for (const t of workSet) {
      const existingLabelIds = t.labels?.nodes?.map((l) => l.id) ?? [];
      await postComment(t.id, blockedMsg, DRY_RUN);
      await applySkipTreatment(t.id, existingLabelIds, DRY_RUN);
    }
    console.error(`  Site blocked: ${err.message}`);
    return null;
  }

  const { shortName } = siteInfo;
  console.log(`  Site: ${siteLabel} -> ${siteInfo.siteId} (token #${siteInfo.tokenIndex})`);

  const collectionsCache = new Map();
  const pagesCache = new Map();
  const fieldsCache = new Map();
  const siteContextCache = { value: null };
  const results = [];

  const { skips: locationsSkips } = await resolveLocationsConflicts(workSet, {
    siteId: siteInfo.siteId,
    token: siteInfo.token,
    collectionsCache,
  });
  if (locationsSkips.size > 0) {
    console.log(`  Locations conflicts detected for ${locationsSkips.size} ticket(s) -- honoring the most recent request.`);
    for (const ticket of workSet) {
      const reason = locationsSkips.get(ticket.id);
      if (reason) {
        const existingLabelIds = ticket.labels?.nodes?.map((l) => l.id) ?? [];
        await postComment(ticket.id, reason, DRY_RUN);
        await applySkipTreatment(ticket.id, existingLabelIds, DRY_RUN);
      }
    }
    workSet = workSet.filter((t) => !locationsSkips.has(t.id));
  }

  for (const ticket of workSet) {
    console.log(`  Processing ${ticket.identifier}...`);
    try {
      // Peek for an IMAGE attachment specifically (not just any attachment --
      // confirmed real misroute: a ticket with a PDF attachment (source copy for
      // a text change, not an image to swap in) got sent to the image pipeline
      // and skipped with a misleading "unsupported format" reason instead of
      // going through the text pipeline it actually needed).
      const imgFields = extractImageTicketFields(ticket.description ?? '');
      let hasImageAttachment = imgFields.attachments.some((a) => isSupportedFormat(a.filename ?? a.url ?? ''));
      if (!hasImageAttachment && imgFields.bugherdProjectId) {
        try {
          const bh = await getTaskDetails(imgFields.bugherdProjectId, imgFields.bugherdTaskId);
          hasImageAttachment = (bh.attachments ?? []).some((a) => isSupportedFormat(a.filename ?? a.url ?? ''));
        } catch {
          // BugHerd fallback failure here is non-fatal -- fall through to text path,
          // which has its own independent BugHerd fallback and will report clearly.
        }
      }

      const result = hasImageAttachment
        ? await processImageTicket(ticket, siteInfo.siteId, siteInfo.token, shortName, siteInfo.displayName, collectionsCache, fieldsCache, siteContextCache)
        : await processTicket(ticket, siteInfo.siteId, siteInfo.token, shortName, collectionsCache, pagesCache);

      results.push(result);
      console.log(`    -> ${result.outcome}${result.reason ? ': ' + result.reason.slice(0, 80) : ''}`);
    } catch (err) {
      console.error(`    x ${ticket.identifier}: ${err.message}`);
      results.push({ outcome: 'error', ticket, reason: err.message });
    }
  }

  const anyUpdated = results.some((r) => r.outcome === 'updated');
  if (anyUpdated) {
    console.log(`  Publishing ${shortName} to staging...`);
    // A publish failure (confirmed real: repeated 429s on a site hit by several
    // batches back-to-back) must not crash the whole run -- main()'s only
    // top-level catch calls process.exit(1), which previously killed every
    // remaining batch/ticket even though their CMS writes had already succeeded
    // and just weren't pushed to the staging preview yet. Log loudly and move on;
    // a later run (or a manual publish) will catch the site up.
    try {
      await publishToStaging(siteInfo.siteId, siteInfo.token, DRY_RUN);
    } catch (err) {
      console.error(`  ⚠️ Publish to staging failed for ${shortName}: ${err.message} -- CMS writes above were still applied, just not yet published. Continuing with remaining batches.`);
    }
  }

  console.log('  Running grouping/deconsolidation...');
  await runGroupingStep(results, parentTicket, batchType);

  return { results, siteInfo };
}

async function main() {
  console.log(`[${new Date().toISOString()}] webflow-hybrid-updater starting${DRY_RUN ? ' (DRY RUN)' : ''}`);

  const allResults = [];

  for (const url of BATCH_URLS) {
    const identifier = url.match(/\/([A-Z]+-\d+)/)?.[1];
    if (!identifier) {
      console.error(`Could not extract issue ID from URL: ${url}`);
      continue;
    }
    console.log(`\n=== Batch: ${identifier} ===`);
    const { workSet, batchType, parentTicket } = await buildWorkSetForIssue(identifier);
    if (workSet.length === 0) {
      console.log('Empty work set after filtering (already past queue / already edited). Skipping.');
      continue;
    }
    console.log(`Work set: [${batchType}] ${workSet.map((t) => t.identifier).join(', ')}`);
    const outcome = await processBatch(workSet, batchType, parentTicket);
    if (outcome) allResults.push(...outcome.results);
  }

  if (DISCOVER_LIMIT > 0) {
    const discoverySeen = loadDiscoverySeen();
    console.log(`\n=== Discovering up to ${DISCOVER_LIMIT} additional batch(es) from the backlog (${discoverySeen.size} already seen, excluded) ===`);
    const batches = await discoverBatches(DISCOVER_LIMIT, discoverySeen);
    console.log(`Found ${batches.length} candidate batch(es).`);
    for (const b of batches) {
      console.log(`\n=== Discovered batch: ${b.tickets.map((t) => t.identifier).join(', ')} ===`);
      const parentTicket = b.parentId ? await getIssue(b.parentId) : null;
      const outcome = await processBatch(b.tickets, b.batchType, parentTicket);
      if (outcome) allResults.push(...outcome.results);
      for (const t of b.tickets) discoverySeen.add(t.id);
      saveDiscoverySeen(discoverySeen);
    }
  }

  const updated = allResults.filter((r) => r.outcome === 'updated').length;
  const skipped = allResults.filter((r) => r.outcome === 'skipped').length;
  const errors = allResults.filter((r) => r.outcome === 'error').length;
  const needsMcp = allResults.filter((r) => r.outcome === 'needs-mcp-write');

  console.log(`\n=== HYBRID RUN COMPLETE ===`);
  console.log(`Total: ${allResults.length} tickets -- ${updated} updated, ${skipped} skipped, ${errors} errors, ${needsMcp.length} need an MCP-completed static write.`);

  if (needsMcp.length > 0) {
    console.log('\nTickets needing MCP static write (site/page/element resolved, write must be completed via the Webflow Designer/App MCP tool):');
    for (const r of needsMcp) {
      console.log(`  ${r.ticket.identifier}: site=${r.details.siteId} page=${r.details.pageId} element=${r.details.elementId} newValue=${JSON.stringify(r.details.newValue)}`);
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
