/**
 * Entry point for the image updater -- mirrors index.js's flow, adapted for
 * wf-image-updaterSKILL.md. Separate pipeline from the text updater for now
 * (shares webflow-client.js, linear-client.js, grouping.js).
 *
 * Usage:
 *   node src/image-index.js                                # normal polling run
 *   IMAGE_BATCH_URL=https://linear.app/... node src/image-index.js   # manual override
 *   DRY_RUN=true node src/image-index.js                    # read-only test
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

import { pollTickets, pollTicketsByState, getIssue, listSubissues, postComment, applyImageSkipTreatment } from './linear-client.js';
import { resolveSite, publishToStaging } from './webflow-client.js';
import { processImageTicket } from './image-processor.js';
import { runGroupingStep } from './grouping.js';

const require = createRequire(import.meta.url);
const knownIds = require('../knowledge-base/known-ids.json');

const { labels, states } = knownIds.linear;
const DRY_RUN = process.env.DRY_RUN === 'true';
const IMAGE_BATCH_URL = process.env.IMAGE_BATCH_URL ?? null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROGRESS_FILE = path.join(__dirname, '..', 'progress', 'image-run-progress.json');

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

function pickBatch(tickets) {
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

  solo.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return { batch: solo.slice(0, 5), type: 'newEdit' };
}

function parseSiteFromUrl(pageUrl) {
  const hostname = new URL(pageUrl).hostname;
  if (hostname.endsWith('.webflow.io')) {
    const shortName = hostname.replace(/\.webflow\.io$/, '').split('.')[0];
    return { shortName, customDomain: null };
  }
  const customDomain = hostname.replace(/^www\./i, '');
  return { shortName: null, customDomain };
}

async function main() {
  console.log(`[${new Date().toISOString()}] webflow-image-updater starting${DRY_RUN ? ' (DRY RUN)' : ''}`);

  const resumeData = readProgress();
  if (resumeData) {
    console.log(`Resuming mid-run from progress file. Already processed: ${resumeData.processed?.join(', ')}`);
  }

  let workSet = [];
  let batchType = 'newEdit';
  let parentTicket = null;

  if (IMAGE_BATCH_URL) {
    const identifier = IMAGE_BATCH_URL.match(/\/([A-Z]+-\d+)/)?.[1];
    if (!identifier) throw new Error(`Could not extract issue ID from IMAGE_BATCH_URL: ${IMAGE_BATCH_URL}`);

    const issue = await getIssue(identifier);
    const isParent =
      issue.labels?.nodes?.some((l) => l.id === labels.parentIssue) ||
      !issue.description?.includes('**Page URL**');

    if (isParent) {
      parentTicket = issue;
      const subissues = await listSubissues(issue.id);
      // Batch = parent + sub-issues -- include the parent in processing (see text
      // updater's index.js for why this matters: Step 13's "Scenario 1: parent was
      // edited" only ever fires if the parent actually goes through the pipeline).
      workSet = [issue, ...subissues];
      batchType = 'queue';
    } else {
      workSet = [issue];
      batchType = 'newEdit';
    }

    workSet = workSet.filter((t) => !t.labels?.nodes?.some((l) => l.id === labels.aiEdited));

    const automatableStateIds = new Set([states.newEdit, states.liveEditsQueue, states.notLiveEditsQueue]);
    const beforeStateFilter = workSet.length;
    workSet = workSet.filter((t) => automatableStateIds.has(t.state?.id));
    const excludedByState = beforeStateFilter - workSet.length;
    if (excludedByState > 0) {
      console.log(`Excluded ${excludedByState} ticket(s) already past the queue stage.`);
    }
  } else if (resumeData) {
    workSet = await Promise.all(resumeData.workSet.map((id) => getIssue(id)));
    workSet = workSet.filter(Boolean);
    batchType = resumeData.batchType ?? 'newEdit';
    if (resumeData.parentId) parentTicket = await getIssue(resumeData.parentId);
  } else {
    const pollCombos = [
      { stateId: states.liveEditsQueue,    labelId: labels.aiImageSwap },
      { stateId: states.notLiveEditsQueue, labelId: labels.aiImageSwap },
      { stateId: states.newEdit,           labelId: labels.aiImageSwap },
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
      console.log('No pending image swap tickets this run.');
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

  const sampleTicket = workSet.find((t) => t.description?.includes('**Page URL**')) ?? workSet[0];
  const pageUrlMatch = sampleTicket.description?.match(/\*\*Page URL\*\*[:\s]*\[?(https?:\/\/[^\s\]>)]+)/i);

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
  const siteLabel = customDomain ?? parsedShortName;

  let siteInfo;
  try {
    siteInfo = await resolveSite(parsedShortName, customDomain);
  } catch (err) {
    const blockedMsg = [
      '⚠️ Blocked — Inaccessible Workspace',
      `The Page URL is ${pageUrl}. Site "${siteLabel}" not found in any connected Webflow workspace.`,
      '',
      `Label ${'`ai:image-swap`'} has been removed. This ticket requires manual action or workspace reconnection.`,
    ].join('\n');
    for (const t of workSet) {
      const existingLabelIds = t.labels?.nodes?.map((l) => l.id) ?? [];
      await postComment(t.id, blockedMsg, DRY_RUN);
      await applyImageSkipTreatment(t.id, existingLabelIds, DRY_RUN);
    }
    console.error(`Site blocked: ${err.message}`);
    return;
  }

  const { shortName } = siteInfo;
  console.log(`Site: ${siteLabel} -> ${siteInfo.siteId} (shortName: ${shortName}, token #${siteInfo.tokenIndex})`);

  const progress = {
    runStarted: new Date().toISOString(),
    runComplete: false,
    batchType,
    parentId: parentTicket?.id ?? null,
    workSet: workSet.map((t) => t.id),
    processed: resumeData?.processed ?? [],
    skipped: resumeData?.skipped ?? [],
    errors: resumeData?.errors ?? [],
    step12Done: false,
  };
  writeProgress(progress);

  const collectionsCache = new Map();
  const fieldsCache = new Map();
  const siteContextCache = { value: null };
  const results = [];
  const alreadyDone = new Set(resumeData?.processed ?? []);

  for (const ticket of workSet) {
    if (alreadyDone.has(ticket.id)) {
      console.log(`Skipping ${ticket.identifier} (already processed in prior run)`);
      continue;
    }

    console.log(`Processing ${ticket.identifier}...`);
    try {
      const result = await processImageTicket(
        ticket, siteInfo.siteId, siteInfo.token, shortName, siteInfo.displayName, collectionsCache, fieldsCache, siteContextCache
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

  const anyUpdated = results.some((r) => r.outcome === 'updated');
  if (anyUpdated) {
    console.log(`Publishing ${shortName} to staging...`);
    await publishToStaging(siteInfo.siteId, siteInfo.token, DRY_RUN);
    console.log('  Published to staging');
  }

  console.log('Running Step 13 (grouping/deconsolidation)...');
  await runGroupingStep(results, parentTicket, batchType);
  progress.step12Done = true;
  writeProgress(progress);

  const updated = results.filter((r) => r.outcome === 'updated').length;
  const skipped = results.filter((r) => r.outcome === 'skipped').length;
  const errors  = results.filter((r) => r.outcome === 'error').length;

  console.log(`\nRun complete. Processed ${results.length} image swap tickets: ${updated} updated + staged, ${skipped} skipped, ${errors} errors.`);

  progress.runComplete = true;
  writeProgress(progress);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
