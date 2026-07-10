/**
 * Step 9 — Post-processing: grouping and deconsolidation.
 *
 * MANDATORY — mirrors SKILL.md Step 9 exactly.
 *
 * For New Edit batches:
 *   - 2+ edited → oldest becomes parent (Parent Issue label), rest attach as subissues
 *   - 1 edited  → solo, no parent needed
 *   - Skipped   → leave in New Edit
 *
 * For Live / Not Live Edits Queue batches:
 *   - Scenario 1: Parent WAS edited
 *       Edited group stays together.
 *       Skipped subissues → detach, oldest skipped becomes new parent, post deconsolidation comment.
 *   - Scenario 2: Parent was NOT edited
 *       Skipped group stays together.
 *       Edited subissues → detach, oldest edited becomes new parent, post deconsolidation comment.
 *
 * Edge cases — skip deconsolidation:
 *   - All edited, all skipped, or solo tickets with no batch structure
 */

import { setParent, addLabels, postComment, getIssue } from './linear-client.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const knownIds = require('../knowledge-base/known-ids.json');

const { labels } = knownIds.linear;
const DRY_RUN = process.env.DRY_RUN === 'true';

/**
 * Run Step 9 grouping/deconsolidation.
 *
 * @param {object[]} results        - Array of { outcome, ticket } from processTicket
 * @param {object|null} parentTicket - The batch parent ticket (null for solo/New Edit)
 * @param {'newEdit'|'queue'} batchType
 */
export async function runGroupingStep(results, parentTicket, batchType) {
  const edited  = results.filter((r) => r.outcome === 'updated').map((r) => r.ticket);
  // needs-mcp-write tickets haven't actually been edited yet (no state/label change
  // has happened) -- group them with skipped/error for deconsolidation purposes.
  const skipped = results.filter((r) => r.outcome === 'skipped' || r.outcome === 'error' || r.outcome === 'needs-mcp-write').map((r) => r.ticket);

  // Edge case: all same outcome or solo — nothing to restructure
  if (edited.length === 0 || skipped.length === 0) {
    console.log('Step 9: no mixed outcomes — skipping restructure.');
    return;
  }

  if (batchType === 'newEdit') {
    await handleNewEditGrouping(edited, skipped);
  } else {
    await handleQueueDeconsolidation(edited, skipped, parentTicket);
  }
}

// ─── New Edit grouping ────────────────────────────────────────────────────────

async function handleNewEditGrouping(edited, skipped) {
  if (edited.length < 2) {
    // Solo edited ticket — nothing to group
    console.log('Step 9 (New Edit): single edited ticket, no grouping needed.');
    return;
  }

  // Sort by createdAt — oldest first
  const sorted = [...edited].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const newParent = sorted[0];
  const children = sorted.slice(1);

  console.log(`Step 9 (New Edit): making ${newParent.identifier} the parent of ${children.map((c) => c.identifier).join(', ')}`);

  // Add Parent Issue label to the new parent. Refetch first -- newParent's labels
  // reflect the START of this run, before this same run's passToQA/skip treatment
  // added/removed labels on it. Using the stale snapshot here silently reverts
  // those changes (confirmed bug: a just-added ai:edited label got erased this way).
  const freshParent = await getIssue(newParent.id);
  const parentLabelIds = freshParent.labels?.nodes?.map((l) => l.id) ?? [];
  await addLabels(newParent.id, parentLabelIds, [labels.parentIssue], DRY_RUN);

  // Attach children
  for (const child of children) {
    await setParent(child.id, newParent.id, DRY_RUN);
  }

  // Skipped stay in New Edit — no action needed
  console.log(`Step 9 (New Edit): ${skipped.map((s) => s.identifier).join(', ')} left in New Edit.`);
}

// ─── Queue deconsolidation ────────────────────────────────────────────────────

async function handleQueueDeconsolidation(edited, skipped, originalParent) {
  // Determine which group needs to be split off
  // The group that does NOT match the parent's outcome gets detached and re-parented.

  const parentWasEdited = edited.some((t) => t.id === originalParent?.id);

  let groupToDetach, groupToStay;
  if (parentWasEdited) {
    // Scenario 1: parent edited → skipped get detached
    groupToDetach = skipped;
    groupToStay   = edited;
    console.log('Step 9 (Queue): Scenario 1 — parent was edited, deconsolidating skipped tickets.');
  } else {
    // Scenario 2: parent not edited → edited get detached
    groupToDetach = edited;
    groupToStay   = skipped;
    console.log('Step 9 (Queue): Scenario 2 — parent was NOT edited, deconsolidating edited tickets.');
  }

  if (groupToDetach.length === 0) return;

  // Sort detach group oldest first
  const sorted = [...groupToDetach].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const newParent = sorted[0];
  const children  = sorted.slice(1);

  // Detach all from original parent
  for (const ticket of sorted) {
    await setParent(ticket.id, null, DRY_RUN);
  }

  // Re-parent: oldest of detached group becomes new parent. Refetch first -- same
  // stale-snapshot issue as the New Edit path above.
  const freshParent = await getIssue(newParent.id);
  const newParentLabelIds = freshParent.labels?.nodes?.map((l) => l.id) ?? [];
  await addLabels(newParent.id, newParentLabelIds, [labels.parentIssue], DRY_RUN);

  for (const child of children) {
    await setParent(child.id, newParent.id, DRY_RUN);
  }

  // Post deconsolidation comment on new parent
  const deconsolidationComment = [
    '🔀 **Deconsolidated from batch**',
    parentWasEdited
      ? 'These tickets were separated because they could not be processed automatically.'
      : 'These tickets were separated because the parent was not automatable.',
    `**Original parent:** ${originalParent?.identifier ?? 'unknown'}`,
    `**Ticket count:** ${sorted.length}`,
  ].join('\n');

  await postComment(newParent.id, deconsolidationComment, DRY_RUN);

  console.log(`Step 9: deconsolidated ${sorted.map((t) => t.identifier).join(', ')} → new parent ${newParent.identifier}`);
}
