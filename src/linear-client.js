/**
 * Linear GraphQL API client.
 *
 * Uses the Linear API key from LINEAR_API_KEY env var.
 * Docs: https://developers.linear.app/docs/graphql/working-with-the-graphql-api
 */

const LINEAR_BASE = 'https://api.linear.app/graphql';
const TOKEN = process.env.LINEAR_API_KEY;

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

const knownIds = (await import('../knowledge-base/known-ids.json', { assert: { type: 'json' } })).default;
const { labels, states } = knownIds.linear;

/** Fetch open tickets eligible for processing. */
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
        nodes {
          id
          identifier
          title
          description
          state { id name }
          labels { nodes { id name } }
          parent { id identifier }
          children { nodes { id identifier } }
        }
      }
    }
  `, { stateId, labelId, limit });

  return data.issues.nodes;
}

/** Fetch a single issue by identifier (e.g. "BUGHERD-50309"). */
export async function getIssue(identifier) {
  const data = await linearQuery(`
    query GetIssue($identifier: String!) {
      issue(id: $identifier) {
        id
        identifier
        title
        description
        state { id name }
        labels { nodes { id name } }
        parent { id identifier }
        children { nodes { id identifier title description state { id name } labels { nodes { id name } } } }
      }
    }
  `, { identifier });

  return data.issue;
}

/** Fetch all subissues for a parent issue. */
export async function listSubissues(parentId) {
  const data = await linearQuery(`
    query ListSubissues($parentId: String!) {
      issues(filter: { parent: { id: { eq: $parentId } } }) {
        nodes {
          id
          identifier
          title
          description
          state { id name }
          labels { nodes { id name } }
        }
      }
    }
  `, { parentId });

  return data.issues.nodes;
}

/**
 * Update a ticket: move to QA, add ai:edited label, remove assignee.
 * existingLabelIds must be passed to avoid accidentally stripping labels.
 */
export async function passToQA(issueId, existingLabelIds, dryRun = false) {
  const labelIds = [...new Set([...existingLabelIds, labels.aiEdited])];

  if (dryRun) {
    console.log(`[DRY RUN] Would update issue ${issueId} → Edit - Pass to QA, labels: ${labelIds}`);
    return;
  }

  await linearQuery(`
    mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
      }
    }
  `, {
    id: issueId,
    input: {
      stateId: states.editPassToQA,
      labelIds,
      assigneeId: null,
    },
  });
}

/** Apply skip treatment: remove ai:available and ai:text-change labels. */
export async function applySkipTreatment(issueId, existingLabelIds, dryRun = false) {
  const removeSet = new Set([labels.aiAvailable, labels.aiTextChange]);
  const labelIds = existingLabelIds.filter((id) => !removeSet.has(id));

  if (dryRun) {
    console.log(`[DRY RUN] Would apply skip treatment to ${issueId}, remaining labels: ${labelIds}`);
    return;
  }

  await linearQuery(`
    mutation SkipIssue($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
      }
    }
  `, {
    id: issueId,
    input: { labelIds },
  });
}

/** Post a comment on a ticket. */
export async function postComment(issueId, body, dryRun = false) {
  if (dryRun) {
    console.log(`[DRY RUN] Would post comment on ${issueId}:\n${body}`);
    return;
  }

  await linearQuery(`
    mutation PostComment($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) {
        success
      }
    }
  `, { issueId, body });
}
