/**
 * BugHerd API client — used as a fallback to fetch missing selectors/HTML
 * when a Linear ticket is missing the Path or HTML fields.
 *
 * Docs: https://www.bugherd.com/api_v2
 */

const BUGHERD_BASE = 'https://www.bugherd.com/api_v2';
const KEY = process.env.BUGHERD_API_KEY;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Same retry-on-transient-failure treatment as webflow-client.js/linear-client.js
// -- a bare network error or 429/5xx here previously crashed the whole run uncaught.
async function bugherdFetch(path, attempt = 1) {
  const credentials = Buffer.from(`${KEY}:x`).toString('base64');
  let res;
  try {
    res = await fetch(`${BUGHERD_BASE}${path}`, {
      headers: {
        Authorization: `Basic ${credentials}`,
      },
    });
  } catch (err) {
    if (attempt <= 4) {
      const delayMs = 1000 * 2 ** (attempt - 1);
      console.warn(`  BugHerd API network error (${err.message}) -- retrying in ${delayMs}ms (attempt ${attempt}/4)...`);
      await sleep(delayMs);
      return bugherdFetch(path, attempt + 1);
    }
    throw err;
  }

  if (!res.ok) {
    if ((res.status === 429 || res.status >= 500) && attempt <= 4) {
      const delayMs = 1000 * 2 ** (attempt - 1);
      console.warn(`  BugHerd API ${res.status} -- retrying in ${delayMs}ms (attempt ${attempt}/4)...`);
      await sleep(delayMs);
      return bugherdFetch(path, attempt + 1);
    }
    const body = await res.text();
    throw new Error(`BugHerd API ${res.status}: ${body}`);
  }

  return res.json();
}

// projectId -> full task list (BugHerd has no lookup-by-local_task_id endpoint,
// so we page through the project once and reuse it for every ticket in that project).
const taskListCache = new Map();

async function findTaskByLocalId(projectId, localTaskId) {
  if (!taskListCache.has(projectId)) {
    const all = [];
    for (let page = 1; page <= 50; page++) {
      const data = await bugherdFetch(`/projects/${projectId}/tasks.json?page=${page}`);
      const tasks = data.tasks ?? [];
      if (tasks.length === 0) break;
      all.push(...tasks);
    }
    taskListCache.set(projectId, all);
  }
  return taskListCache.get(projectId).find((t) => String(t.local_task_id) === String(localTaskId)) ?? null;
}

/**
 * Fetch a task from BugHerd to retrieve selector, HTML snapshot, and page URL.
 * projectId and taskId come from the ticket's Admin Link field -- taskId there
 * is BugHerd's per-project `local_task_id` (what shows in the BugHerd UI URL),
 * NOT its internal `id`. The single-task endpoint requires the internal id,
 * so we look it up via the project's task list first.
 *
 * Returns: { selector, htmlSnapshot, pageUrl, attachments } — any may be null/empty if not available.
 * attachments is [{ filename, url }] (confirmed shape: BugHerd returns { id, name, url }).
 */
export async function getTaskDetails(projectId, taskId) {
  try {
    const match = await findTaskByLocalId(projectId, taskId);
    if (!match) throw new Error(`local_task_id ${taskId} not found in project ${projectId}`);

    const data = await bugherdFetch(`/projects/${projectId}/tasks/${match.id}.json`);
    const task = data.task ?? data;

    return {
      selector: task.selector_info?.path ?? null,
      htmlSnapshot: task.selector_info?.html ?? null,
      pageUrl: task.site && task.url ? `${task.site.replace(/\/$/, '')}${task.url}` : (task.site ?? null),
      attachments: (task.attachments ?? []).map((a) => ({ filename: a.name, url: a.url })),
    };
  } catch (err) {
    console.warn(`BugHerd fallback failed for task ${taskId}: ${err.message}`);
    return { selector: null, htmlSnapshot: null, pageUrl: null, attachments: [] };
  }
}
