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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Confirmed real crash: a bare network hiccup (ConnectTimeoutError, no HTTP
// response at all) during a live discovery run took down the entire process
// uncaught -- same class of fragility already fixed for Webflow's client.
// Retry transient failures (network-level errors, and HTTP 429/5xx) with backoff.
async function linearQuery(query, variables = {}, attempt = 1) {
  let res;
  try {
    res = await fetch(LINEAR_BASE, {
      method: 'POST',
      headers: {
        Authorization: TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    if (attempt <= 4) {
      const delayMs = 1000 * 2 ** (attempt - 1);
      console.warn(`  Linear API network error (${err.message}) -- retrying in ${delayMs}ms (attempt ${attempt}/4)...`);
      await sleep(delayMs);
      return linearQuery(query, variables, attempt + 1);
    }
    throw err;
  }

  if (!res.ok && (res.status === 429 || res.status >= 500) && attempt <= 4) {
    const delayMs = 1000 * 2 ** (attempt - 1);
    console.warn(`  Linear API ${res.status} -- retrying in ${delayMs}ms (attempt ${attempt}/4)...`);
    await sleep(delayMs);
    return linearQuery(query, variables, attempt + 1);
  }

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
    query PollTickets($stateId: ID!, $labelId: ID!, $limit: Int!) {
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

/**
 * Poll tickets by state alone, no label filter. Used to catch tickets that were
 * never tagged ai:available/ai:text-change by the upstream classifier -- our own
 * skip-checker/router decides automatability instead of trusting that label.
 *
 * Paginates internally -- confirmed real gap: a single unpaginated `first: 250`
 * silently truncated "Live Edits Queue" (330 real tickets) to just the first 250,
 * meaning 80 tickets were never even seen by discovery. `limit` is now a soft
 * cap on the TOTAL returned across all pages, not a single query's page size.
 */
export async function pollTicketsByState({ stateId, limit = 1000 }) {
  const all = [];
  let after = null;
  while (all.length < limit) {
    const data = await linearQuery(`
      query PollTicketsByState($stateId: ID!, $first: Int!, $after: String) {
        issues(
          filter: { state: { id: { eq: $stateId } } }
          first: $first
          after: $after
          orderBy: createdAt
        ) {
          nodes { ${ISSUE_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }
    `, { stateId, first: Math.min(100, limit - all.length), after });

    all.push(...data.issues.nodes);
    if (!data.issues.pageInfo.hasNextPage) break;
    after = data.issues.pageInfo.endCursor;
  }
  return all;
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
    query ListSubissues($parentId: ID!) {
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

/** Remove ai:image-swap label only (image updater skip treatment) -- keeps ai:reviewed and all others. */
export async function applyImageSkipTreatment(issueId, existingLabelIds, dryRun = false) {
  const labelIds = existingLabelIds.filter((id) => id !== labels.aiImageSwap);
  if (dryRun) {
    console.log(`[DRY RUN] imageSkipTreatment ${issueId} labels=${labelIds}`);
    return;
  }
  await linearQuery(`
    mutation SkipImageIssue($id: String!, $input: IssueUpdateInput!) {
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

/**
 * Post a comment only if an identical one doesn't already exist on the ticket.
 * Confirmed real problem: tickets that get correctly skipped but never earn
 * ai:edited (e.g. AI-diagnosed structural/new-item requests) keep getting
 * rediscovered by label-agnostic batch polling and re-commented with the exact
 * same message every run. Use this for skip-path comments specifically.
 */
export async function postCommentIfNew(issueId, body, dryRun = false) {
  if (dryRun) {
    console.log(`[DRY RUN] comment (if new) on ${issueId}:\n${body.slice(0, 120)}`);
    return;
  }
  const data = await linearQuery(`
    query($id: String!) { issue(id: $id) { comments(first: 50) { nodes { body } } } }
  `, { id: issueId });
  const alreadyPosted = data.issue.comments.nodes.some((c) => c.body === body);
  if (alreadyPosted) {
    console.log(`  Skipping duplicate comment on ${issueId} (identical comment already posted).`);
    return;
  }
  await postComment(issueId, body, dryRun);
}

/** Set or clear an issue's parent. Pass null to detach. */
export async function setParent(issueId, parentId, dryRun = false) {
  if (dryRun) {
    console.log(`[DRY RUN] setParent ${issueId} -> ${parentId}`);
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
    console.log(`[DRY RUN] addLabels ${issueId} -> ${labelIds}`);
    return;
  }
  await linearQuery(`
    mutation AddLabels($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }
  `, { id: issueId, input: { labelIds } });
}
