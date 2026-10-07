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
// `links` is only populated when the task was created "from" something
// -- most commonly Gmail's own "Add to Tasks" -- and holds a URL back
// to it. Worth carrying through on import (see googletasksfeed.js)
// rather than silently dropping it.
fields: 'items(id,title,notes,due,updated,status,links)',
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
links: t.links || [],
tasklistId,
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

// The one write call in this file, guarded entirely by the caller: only
// reached once hasTasksWrite() is true (js/sync/googleauth.js), since the
// scope requested by default (tasks.readonly) can't authorize this at all
// -- Google just 403s. Only ever called for a task that's already safely
// captured into the dashboard (googletasksfeed.js), since this is a real
// deletion with no undo.
async function deleteTask(tasklistId, taskId) {
const res = await googleFetch(`${TASKS_API}/lists/${encodeURIComponent(tasklistId)}/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
if (!res.ok && res.status !== 404) throw new Error(`Task delete failed: ${res.status}`);
}

export { listTaskLists, listTasks, listAllTasks, deleteTask };
