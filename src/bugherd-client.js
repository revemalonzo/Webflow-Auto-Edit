/**
 * BugHerd API client — used as a fallback to fetch missing selectors/HTML
 * when a Linear ticket is missing the Path or HTML fields.
 *
 * Docs: https://www.bugherd.com/api_v2
 */

const BUGHERD_BASE = 'https://www.bugherd.com/api_v2';
const KEY = process.env.BUGHERD_API_KEY;

async function bugherdFetch(path) {
  const credentials = Buffer.from(`${KEY}:x`).toString('base64');
  const res = await fetch(`${BUGHERD_BASE}${path}`, {
    headers: {
      Authorization: `Basic ${credentials}`,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`BugHerd API ${res.status}: ${body}`);
  }

  return res.json();
}

/**
 * Fetch a task from BugHerd to retrieve selector, HTML snapshot, and page URL.
 * projectId and taskId come from the ticket's Admin Link field.
 *
 * Returns: { selector, htmlSnapshot, pageUrl } — any may be null if not available.
 */
export async function getTaskDetails(projectId, taskId) {
  try {
    const data = await bugherdFetch(`/projects/${projectId}/tasks/${taskId}.json`);
    const task = data.task ?? data;

    return {
      selector: task.selectors?.[0] ?? task.selector ?? null,
      htmlSnapshot: task.screenshot_url ?? task.meta?.html ?? null,
      pageUrl: task.site ?? task.requester_url ?? null,
    };
  } catch (err) {
    console.warn(`BugHerd fallback failed for task ${taskId}: ${err.message}`);
    return { selector: null, htmlSnapshot: null, pageUrl: null };
  }
}
