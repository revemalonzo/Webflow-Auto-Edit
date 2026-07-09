/**
 * Linear GraphQL API client.
 *
 * Reads LINEAR_API_KEY from env.
 * Docs: https://developers.linear.app/docs/graphql/working-with-the-graphql-api
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const knownIds = require('../knowledge-base/known-ids.json');

const LINEAR_BASE = 'https://api.linear.app/graphql';
const TOKEN = process.env.LINEAR_API_KEY;
const { labels, states } = knownIds.linear;

async function linearQuery(query, variables = {}) {
  const res = await fetch(LINEAR_BASE, {
    method: 'POST',
    headers: {
      Authorization: TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();
  if (json.errors) throw new Error(`Linear GraphQL error: ${JSON.stringify(json.errors)}`);
  return json.data;
}

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  createdAt
  state { id name }
  labels { nodes { id name } }
  parent { id identifier }
  children { nodes { id identifier title description createdAt state { id name } labels { nodes { id name } } } }
`;

/** Poll tickets by state + label. */
export async function pollTickets({ stateId, labelId, limit = 100 }) {
  const data = await linearQuery(`
    query PollTickets($stateId: String!, $labelId: String!, $limit: Int!) {
      issues(
        filter: {
          state: { id: { eq: $stateId } }
          labels: { id: { eq: $labelId } }
        }
        first: $limit
        orderBy: createdAt
      ) {
        nodes { ${ISSUE_FIELDS} }
      }
    }
  `, { stateId, labelId, limit });

  return data.issues.nodes;
}

/** Fetch a single issue by identifier (e.g. "BUGHERD-50309") or UUID. */
export async function getIssue(id) {
  const data = await linearQuery(`
    query GetIssue($id: String!) {
      issue(id: $id) { ${ISSUE_FIELDS} }
    }
  `, { id });
  return data.issue;
}

/** Fetch all subissues for a parent issue ID (UUID). */
export async function listSubissues(parentId) {
  const data = await linearQuery(`
    query ListSubissues($parentId: String!) {
      issues(
        filter: { parent: { id: { eq: $parentId } } }
        orderBy: createdAt
      ) {
        nodes { ${ISSUE_FIELDS} }
      }
    }
  `, { parentId });
  return data.issues.nodes;
}

/**
 * Move ticket to Edit - Pass to QA, add ai:edited, remove assignee.
 * existingLabelIds must include all current label IDs to avoid stripping them.
 */
export async function passToQA(issueId, existingLabelIds, dryRun = false) {
  const labelIds = [...new Set([...existingLabelIds, labels.aiEdited])];
  if (dryRun) {
    console.log(`[DRY RUN] passToQA ${issueId} labels=${labelIds}`);
    return;
  }
  await linearQuery(`
    mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }
  `, { id: issueId, input: { stateId: states.editPassToQA, labelIds, assigneeId: null } });
}

/** Remove ai:available and ai:text-change labels (skip treatment). */
export async function applySkipTreatment(issueId, existingLabelIds, dryRun = false) {
  const removeSet = new Set([labels.aiAvailable, labels.aiTextChange]);
  const labelIds = existingLabelIds.filter((id) => !removeSet.has(id));
  if (dryRun) {
    console.log(`[DRY RUN] skipTreatment ${issueId} labels=${labelIds}`);
    return;
  }
  await linearQuery(`
    mutation SkipIssue($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }
  `, { id: issueId, input: { labelIds } });
}

/** Post a comment on a ticket. */
export async function postComment(issueId, body, dryRun = false) {
  if (dryRun) {
    console.log(`[DRY RUN] comment on ${issueId}:\n${body.slice(0, 120)}`);
    return;
  }
  await linearQuery(`
    mutation PostComment($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success }
    }
  `, { issueId, body });
}

/** Set or clear an issue's parent. Pass null to detach. */
export async function setParent(issueId, parentId, dryRun = false) {
  if (dryRun) {
    console.log(`[DRY RUN] setParent ${issueId} → ${parentId}`);
    return;
  }
  await linearQuery(`
    mutation SetParent($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }
  `, { id: issueId, input: { parentId: parentId ?? null } });
}

/** Add labels to an issue (merges with existing). */
export async function addLabels(issueId, existingLabelIds, newLabelIds, dryRun = false) {
  const labelIds = [...new Set([...existingLabelIds, ...newLabelIds])];
  if (dryRun) {
    console.log(`[DRY RUN] addLabels ${issueId} → ${labelIds}`);
    return;
  }
  await linearQuery(`
    mutation AddLabels($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }
  `, { id: issueId, input: { labelIds } });
}
