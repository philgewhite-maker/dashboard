// Reads (never writes) Google Tasks, so items jotted somewhere with no
// other access — a work web filter that allows Calendar/Tasks but not much
// else, a quick voice-add on a phone — can be pulled into the dashboard's
// own GTD inbox. One-directional on purpose: the dashboard is the real
// system here, Google Tasks is just a capture inbox with wider reach.
import { googleFetch } from './sync/googleauth.js';

const TASKS_API = 'https://www.googleapis.com/tasks/v1';

async function listTaskLists() {
const res = await googleFetch(`${TASKS_API}/users/@me/lists?fields=items(id,title)`);
if (!res.ok) throw new Error(`Task list fetch failed: ${res.status}`);
const json = await res.json();
return json.items || [];
}

// Google's `due` is a full RFC3339 timestamp at midnight UTC regardless of
// what the user actually picked — only the date part means anything.
function dueDate(task) {
return task.due ? task.due.slice(0, 10) : '';
}

async function listTasks(tasklistId, tasklistTitle) {
const params = new URLSearchParams({
showCompleted: 'false',
showHidden: 'false',
fields: 'items(id,title,notes,due,updated,status)',
});
const res = await googleFetch(`${TASKS_API}/lists/${encodeURIComponent(tasklistId)}/tasks?${params}`);
if (!res.ok) throw new Error(`Tasks fetch failed for "${tasklistTitle}": ${res.status}`);
const json = await res.json();
return (json.items || [])
.map((t) => ({
id: t.id,
title: t.title || '(untitled)',
notes: t.notes || '',
due: dueDate(t),
tasklistTitle,
// Not a page you can open — the Tasks API has no per-task web URL —
// but stable and unique, which is all dedup needs it for.
sourceKey: `googletask:${t.id}`,
}));
}

// Every list's tasks, flattened. A work migration or a daily catch-up both
// want "everything not done yet" rather than picking a list first.
async function listAllTasks() {
const lists = await listTaskLists();
const perList = await Promise.all(lists.map((l) => listTasks(l.id, l.title)));
return perList.flat();
}

export { listTaskLists, listTasks, listAllTasks };
