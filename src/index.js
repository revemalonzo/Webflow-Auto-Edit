/**
 * Entry point -- mirrors SKILL.md run flow exactly.
 *
 * Usage:
 *   node src/index.js                          # normal polling run
 *   BATCH_URL=https://linear.app/... node src/index.js   # manual override
 *   DRY_RUN=true node src/index.js             # read-only test
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

import { pollTickets, getIssue, listSubissues, postComment, applySkipTreatment } from './linear-client.js';
import { resolveSite, publishToStaging } from './webflow-client.js';
import { processTicket } from './ticket-processor.js';
import { runGroupingStep } from './grouping.js';
import { detectLocationsConflicts } from './conflicts.js';

const require = createRequire(import.meta.url);
const knownIds = require('../knowledge-base/known-ids.json');

const { labels, states } = knownIds.linear;
const DRY_RUN   = process.env.DRY_RUN === 'true';
const BATCH_URL = process.env.BATCH_URL ?? null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROGRESS_FILE = path.join(__dirname, '..', 'progress', 'run-progress.json');

// --- Progress file helpers ---

function readProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      const p = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
      if (!p.runComplete) return p;
    }
  } catch (_) {}
  return null;
}

function writeProgress(data) {
  if (DRY_RUN) return;
  fs.mkdirSync(path.dirname(PROGRESS_FILE), { recursive: true });
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(data, null, 2));
}

// --- Batch detection helpers ---

function pickBatch(tickets) {
  // Group by parent ID -- pick oldest parent group
  const byParent = new Map();
  const solo = [];

  for (const t of tickets) {
    if (t.parent?.id) {
      const pid = t.parent.id;
      if (!byParent.has(pid)) byParent.set(pid, []);
      byParent.get(pid).push(t);
    } else if (t.children?.nodes?.length > 0) {
      const pid = t.id;
      if (!byParent.has(pid)) byParent.set(pid, [t]);
      else byParent.get(pid).unshift(t);
    } else {
      solo.push(t);
    }
  }

  if (byParent.size > 0) {
    let oldestParentTime = Infinity;
    let chosen = null;
    for (const [, group] of byParent) {
      const oldest = Math.min(...group.map((t) => new Date(t.createdAt).getTime()));
      if (oldest < oldestParentTime) {
        oldestParentTime = oldest;
        chosen = group;
      }
    }
    return { batch: chosen, type: 'queue' };
  }

  // New Edit batches: group by exact name match
  const byName = new Map();
  for (const t of solo) {
    const key = t.title.trim().toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(t);
  }
  for (const [, group] of byName) {
    if (group.length >= 2) {
      group.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      return { batch: group, type: 'newEdit' };
    }
  }

  // Fallback: 5 oldest solo tickets
  solo.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return { batch: solo.slice(0, 5), type: 'newEdit' };
}

/**
 * Parse the hostname from a page URL and determine whether it is a
 * webflow.io subdomain or a custom domain.
 *
 * Returns { shortName, customDomain } where exactly one is non-null:
 *   shortName    - webflow.io subdomain (e.g. "my-gym") if URL is *.webflow.io
 *   customDomain - bare hostname without www. (e.g. "mygym.com") if custom domain
 */
function parseSiteFromUrl(pageUrl) {
  const hostname = new URL(pageUrl).hostname;
  if (hostname.endsWith('.webflow.io')) {
    // Strip subdomain prefix only (handles "my-gym.webflow.io" correctly)
    const shortName = hostname.replace(/\.webflow\.io$/, '').split('.')[0];
    return { shortName, customDomain: null };
  }
  // Custom domain: strip www. for normalization
  const customDomain = hostname.replace(/^www\./i, '');
  return { shortName: null, customDomain };
}

// --- Main ---

async function main() {
  console.log(`[${new Date().toISOString()}] webflow-text-updater starting${DRY_RUN ? ' (DRY RUN)' : ''}`);

  // -- Recovery check --
  const resumeData = readProgress();
  if (resumeData) {
    console.log(`Resuming mid-run from progress file. Already processed: ${resumeData.processed?.join(', ')}`);
  }

  // -- Step 1: Build work set --
  let workSet = [];
  let batchType = 'newEdit';
  let parentTicket = null;

  if (BATCH_URL) {
    const identifier = BATCH_URL.match(/\/([A-Z]+-\d+)/)?.[1];
    if (!identifier) throw new Error(`Could not extract issue ID from BATCH_URL: ${BATCH_URL}`);

    const issue = await getIssue(identifier);
    const isParent =
      issue.labels?.nodes?.some((l) => l.id === labels.parentIssue) ||
      !issue.description?.includes('**Page URL**');

    if (isParent) {
      parentTicket = issue;
      const subissues = await listSubissues(issue.id);
      workSet = subissues;
      batchType = 'queue';
    } else {
      workSet = [issue];
      batchType = 'newEdit';
    }

    workSet = workSet.filter((t) => !t.labels?.nodes?.some((l) => l.id === labels.aiEdited));
  } else if (resumeData) {
    workSet = await Promise.all(resumeData.workSet.map((id) => getIssue(id)));
    workSet = workSet.filter(Boolean);
    batchType = resumeData.batchType ?? 'newEdit';
    if (resumeData.parentId) parentTicket = await getIssue(resumeData.parentId);
  } else {
    const pollCombos = [
      { stateId: states.liveEditsQueue,    labelId: labels.aiAvailable  },
      { stateId: states.notLiveEditsQueue, labelId: labels.aiAvailable  },
      { stateId: states.newEdit,           labelId: labels.aiAvailable  },
      { stateId: states.liveEditsQueue,    labelId: labels.aiTextChange },
      { stateId: states.notLiveEditsQueue, labelId: labels.aiTextChange },
      { stateId: states.newEdit,           labelId: labels.aiTextChange },
    ];

    const polls = await Promise.all(pollCombos.map((c) => pollTickets(c)));
    const all = polls.flat();

    const seen = new Set();
    const eligible = all.filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return !t.labels?.nodes?.some((l) => l.id === labels.aiEdited);
    });

    if (eligible.length === 0) {
      console.log('No eligible tickets found. Exiting.');
      return;
    }

    const queueTickets = eligible.filter(
      (t) => t.state.id === states.liveEditsQueue || t.state.id === states.notLiveEditsQueue
    );
    const newEditTickets = eligible.filter((t) => t.state.id === states.newEdit);

    if (queueTickets.length > 0) {
      const { batch } = pickBatch(queueTickets);
      workSet = batch;
      batchType = 'queue';
      const withParent = workSet.find((t) => t.parent?.id);
      if (withParent) parentTicket = await getIssue(withParent.parent.id);
    } else {
      const { batch, type } = pickBatch(newEditTickets);
      workSet = batch;
      batchType = type;
    }
  }

  if (workSet.length === 0) {
    console.log('Work set empty after filtering. Exiting.');
    return;
  }

  console.log(`Work set: [${batchType}] ${workSet.map((t) => t.identifier).join(', ')}`);

  // -- Step 1.5: Resolve Webflow site --
  // Use the first ticket that has a Page URL for site detection
  const sampleTicket = workSet.find((t) => t.description?.includes('**Page URL**')) ?? workSet[0];
  const pageUrlMatch = sampleTicket.description?.match(/\*\*Page URL\*\*[:\s]+(\S+)/i);

  if (!pageUrlMatch) {
    console.error(`No Page URL found on sample ticket ${sampleTicket.identifier}. Cannot resolve site.`);
    return;
  }

  const pageUrl = pageUrlMatch[1];
  let parsedSite;
  try {
    parsedSite = parseSiteFromUrl(pageUrl);
  } catch {
    console.error(`Invalid Page URL: ${pageUrl}`);
    return;
  }

  const { shortName: parsedShortName, customDomain } = parsedSite;
  const siteLabel = customDomain ?? parsedShortName; // for log messages

  let siteInfo;
  try {
    siteInfo = await resolveSite(parsedShortName, customDomain);
  } catch (err) {
    const blockedMsg = [
      'Blocked -- Inaccessible Workspace',
      `The Page URL is ${pageUrl}. Site "${siteLabel}" not found in any connected Webflow workspace.`,
      'Pending change: see ticket description.',
      '',
      'Labels ai:available and ai:text-change have been removed. This ticket requires manual action or workspace reconnection.',
    ].join('\n');
    for (const t of workSet) {
      const existingLabelIds = t.labels?.nodes?.map((l) => l.id) ?? [];
      await postComment(t.id, blockedMsg, DRY_RUN);
      await applySkipTreatment(t.id, existingLabelIds, DRY_RUN);
    }
    console.error(`Site blocked: ${err.message}`);
    return;
  }

  // siteInfo.shortName is ALWAYS the webflow.io subdomain -- use it for staging URLs
  const { shortName } = siteInfo;
  console.log(`Site: ${siteLabel} -> ${siteInfo.siteId} (shortName: ${shortName}, token #${siteInfo.tokenIndex})`);

  // Write initial progress file
  const progress = {
    runStarted: new Date().toISOString(),
    runComplete: false,
    batchType,
    parentId: parentTicket?.id ?? null,
    workSet: workSet.map((t) => t.id),
    processed: resumeData?.processed ?? [],
    skipped: resumeData?.skipped ?? [],
    errors: resumeData?.errors ?? [],
    step9Done: false,
  };
  writeProgress(progress);

  // -- Pre-flight: Shared Locations item conflict detection --
  const locationsConflicts = detectLocationsConflicts(workSet);
  if (locationsConflicts.size > 0) {
    console.log(`Locations conflicts detected for ${locationsConflicts.size} ticket(s) -- skipping all.`);
    const conflictMsg = 'Warning: Automation skipped -- architectural conflict. The Locations item is shared across all program pages. Setting this field to a program-specific value would overwrite it for every other program. Needs manual review.';
    for (const ticket of workSet) {
      if (locationsConflicts.has(ticket.id)) {
        const existingLabelIds = ticket.labels?.nodes?.map((l) => l.id) ?? [];
        await postComment(ticket.id, conflictMsg, DRY_RUN);
        await applySkipTreatment(ticket.id, existingLabelIds, DRY_RUN);
        progress.skipped.push(ticket.id);
      }
    }
    writeProgress(progress);
    // Remove conflicting tickets from the work set
    workSet = workSet.filter((t) => !locationsConflicts.has(t.id));
  }

  if (workSet.length === 0) {
    console.log('All tickets in work set were Locations conflicts. Exiting.');
    progress.runComplete = true;
    writeProgress(progress);
    return;
  }

  // -- Steps 5-8: Process tickets --
  const collectionsCache = new Map();
  const pagesCache = new Map();
  const results = [];

  const alreadyDone = new Set(resumeData?.processed ?? []);

  for (const ticket of workSet) {
    if (alreadyDone.has(ticket.id)) {
      console.log(`Skipping ${ticket.identifier} (already processed in prior run)`);
      continue;
    }

    console.log(`Processing ${ticket.identifier}...`);
    try {
      const result = await processTicket(
        ticket, siteInfo.siteId, siteInfo.token, shortName, collectionsCache, pagesCache
      );
      results.push(result);
      console.log(`  -> ${result.outcome}${result.reason ? ': ' + result.reason.slice(0, 80) : ''}`);

      if (result.outcome === 'updated') progress.processed.push(ticket.id);
      else progress.skipped.push(ticket.id);
    } catch (err) {
      console.error(`  x ${ticket.identifier}: ${err.message}`);
      results.push({ outcome: 'error', ticket, reason: err.message });
      progress.errors.push({ id: ticket.id, error: err.message });
    }

    writeProgress(progress);
  }

  // -- Step 7: Publish to staging once --
  const anyUpdated = results.some((r) => r.outcome === 'updated');
  if (anyUpdated) {
    console.log(`Publishing ${shortName} to staging...`);
    await publishToStaging(siteInfo.siteId, siteInfo.token, DRY_RUN);
    console.log('  Published to staging');
  }

  // -- Step 9: Grouping / deconsolidation --
  console.log('Running Step 9 (grouping/deconsolidation)...');
  await runGroupingStep(results, parentTicket, batchType);
  progress.step9Done = true;
  writeProgress(progress);

  // -- Step 10: Final report --
  const updated = results.filter((r) => r.outcome === 'updated').length;
  const skipped = results.filter((r) => r.outcome === 'skipped').length;
  const errors  = results.filter((r) => r.outcome === 'error').length;

  console.log(`\nRun complete. Processed ${results.length} tickets: ${updated} updated + staged, ${skipped} skipped, ${errors} errors.`);

  progress.runComplete = true;
  writeProgress(progress);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
