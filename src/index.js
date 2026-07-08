/**
 * Entry point — mirrors the SKILL.md run flow.
 *
 * Usage:
 *   node src/index.js                     # normal run (polls Linear)
 *   BATCH_URL=https://linear.app/...      # manual override for a specific batch
 *   DRY_RUN=true node src/index.js        # read-only test run
 */

import 'dotenv/config';
import { pollTickets, getIssue, listSubissues } from './linear-client.js';
import { resolveSite, publishToStaging } from './webflow-client.js';
import { processTicket } from './ticket-processor.js';
import knownIds from '../knowledge-base/known-ids.json' assert { type: 'json' };

const { labels, states } = knownIds.linear;
const DRY_RUN = process.env.DRY_RUN === 'true';
const BATCH_URL = process.env.BATCH_URL ?? null;

async function main() {
  console.log(`[${new Date().toISOString()}] webflow-text-updater starting${DRY_RUN ? ' (DRY RUN)' : ''}`);

  // ── Step 1 / Manual override: build work set ───────────────────────────────
  let workSet = [];

  if (BATCH_URL) {
    // Manual override
    const identifier = BATCH_URL.match(/\/([A-Z]+-\d+)/)?.[1];
    if (!identifier) throw new Error(`Could not extract issue ID from BATCH_URL: ${BATCH_URL}`);

    const issue = await getIssue(identifier);
    const isParent = issue.labels?.nodes?.some((l) => l.id === labels.parentIssue) || !issue.description?.includes('**Page URL**');

    if (isParent) {
      const subissues = await listSubissues(issue.id);
      workSet = subissues;
    } else {
      workSet = [issue];
    }

    // Relaxed filter: exclude only ai:edited
    workSet = workSet.filter((t) => !t.labels?.nodes?.some((l) => l.id === labels.aiEdited));
  } else {
    // Normal run: poll all six state+label combos in parallel
    const validStates = [states.newEdit, /* add Live Edits Queue / Not Live Edits Queue IDs here if known */];
    const validLabels = [labels.aiAvailable, labels.aiTextChange];

    const polls = await Promise.all(
      validStates.flatMap((stateId) =>
        validLabels.map((labelId) => pollTickets({ stateId, labelId }))
      )
    );

    const all = polls.flat();
    const seen = new Set();
    workSet = all.filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return !t.labels?.nodes?.some((l) => l.id === labels.aiEdited);
    });
  }

  if (workSet.length === 0) {
    console.log('No eligible tickets found. Exiting.');
    return;
  }

  console.log(`Work set: ${workSet.length} ticket(s) — ${workSet.map((t) => t.identifier).join(', ')}`);

  // ── Step 1.5: Resolve Webflow site ─────────────────────────────────────────
  const sampleTicket = workSet[0];
  const pageUrlMatch = sampleTicket.description?.match(/\*\*Page URL\*\*[:\s]+(\S+)/i);
  if (!pageUrlMatch) throw new Error(`No Page URL found on sample ticket ${sampleTicket.identifier}`);

  const pageUrl = pageUrlMatch[1];
  const shortName = new URL(pageUrl).hostname.replace('.webflow.io', '').split('.')[0];

  let siteInfo;
  try {
    siteInfo = await resolveSite(shortName);
  } catch (err) {
    console.error(`Site resolution failed: ${err.message}`);
    // Post blocked comment on all tickets
    for (const ticket of workSet) {
      const { postComment, applySkipTreatment } = await import('./linear-client.js');
      const existingLabelIds = ticket.labels?.nodes?.map((l) => l.id) ?? [];
      await postComment(ticket.id, `⚠️ Blocked — Inaccessible Workspace\nThe Page URL is \`${pageUrl}\`. Site \`${shortName}\` not found in any connected Webflow workspace.\n\nLabels \`ai:available\` and \`ai:text-change\` have been removed. This ticket requires manual action or workspace reconnection.`, DRY_RUN);
      await applySkipTreatment(ticket.id, existingLabelIds, DRY_RUN);
    }
    return;
  }

  console.log(`Site resolved: ${shortName} → siteId=${siteInfo.siteId} (token #${siteInfo.tokenIndex})`);

  // ── Steps 5–8: Process tickets (shared caches per run) ─────────────────────
  const collectionsCache = new Map();
  const pagesCache = new Map();
  const results = [];

  for (const ticket of workSet) {
    console.log(`Processing ${ticket.identifier}...`);
    try {
      const result = await processTicket(ticket, siteInfo.siteId, siteInfo.token, collectionsCache, pagesCache);
      results.push(result);
      console.log(`  → ${result.outcome}${result.reason ? ': ' + result.reason.slice(0, 80) : ''}`);
    } catch (err) {
      console.error(`  ✗ Unexpected error on ${ticket.identifier}: ${err.message}`);
      results.push({ outcome: 'error', ticket, reason: err.message });
    }
  }

  // ── Step 7: Publish to staging (once per run) ──────────────────────────────
  const anyUpdated = results.some((r) => r.outcome === 'updated');
  if (anyUpdated) {
    console.log(`Publishing ${shortName} to staging...`);
    await publishToStaging(siteInfo.siteId, siteInfo.token, DRY_RUN);
    console.log('  ✓ Published');
  }

  // ── Final report ───────────────────────────────────────────────────────────
  const updated = results.filter((r) => r.outcome === 'updated').length;
  const skipped = results.filter((r) => r.outcome === 'skipped').length;
  const errors  = results.filter((r) => r.outcome === 'error').length;

  console.log(`\nRun complete. Processed ${results.length} tickets: ${updated} updated + staged, ${skipped} skipped, ${errors} errors.`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
