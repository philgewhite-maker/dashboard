// Pulls items in from Google Tasks — a work web filter that allows
// Calendar/Tasks but little else, or a quick voice-add on a phone, land
// there; this brings them into the dashboard's real Inbox.
//
// Only lists whose NAME matches one of this dashboard's own Contexts
// (data.taskContexts -- Office, Home, DIY, ...) are pulled at all, exactly
// as typed (case-insensitive) -- a list named something else is never
// offered, rather than guessing at a mapping. A matched item is tagged
// with that Context on capture, same as any other task.
//
// Deleting the Google Task once it's safely captured here is opt-in
// (hasTasksWrite(), the "Allow deleting from Google Tasks" toggle in
// Settings) -- without it this stays exactly as one-directional as
// before: nothing here writes back to Google.
import { data } from '../state.js';
import { escapeHtml } from '../utils.js';
import { canAttemptGoogleAction, hasTasksWrite } from '../sync/googleauth.js';
import { listTaskLists, listTasks, deleteTask } from '../googletasks.js';
import { captureTask, revealTask } from './tasks.js';

let fetched = []; // last pull, so "capture all" doesn't need a re-fetch

function statusEl() { return document.getElementById('gtasks-status'); }

// Matched on the synthetic sourceKey (googletask:<id>), which is stable
// across devices — the same item pulled again on a different device is
// recognised as already captured, exactly like the Mail "+ task" buttons.
function existingTaskFor(item) {
return data.tasks.find((t) => t.source && t.source.kind === 'googletask' && t.source.url === item.sourceKey && t.bucket !== 'done');
}

function rowHtml(item) {
const existing = existingTaskFor(item);
return `<div class="mail-row">
<span class="mail-from">${escapeHtml(item.tasklistTitle)}</span>
<span class="mail-subject">${escapeHtml(item.title)}</span>
<span class="mail-date">${item.due ? escapeHtml(item.due) : ''}</span>
${existing
? `<button class="mini-task-btn done" type="button" data-goto-gtask="${escapeHtml(existing.id)}" title="Already captured — go to it">✓ task</button>`
: `<button class="mini-task-btn" type="button" title="Capture as a task" data-gtask-capture="${escapeHtml(item.sourceKey)}">+ task</button>`}
</div>`;
}

function render() {
const list = document.getElementById('gtasks-list');
if (!list) return;
const count = document.getElementById('gtasks-count');
const pending = fetched.filter((i) => !existingTaskFor(i)).length;
if (count) count.textContent = fetched.length ? `${fetched.length} shown · ${pending} not yet captured` : '';
if (fetched.length === 0) {
list.innerHTML = '<div class="empty">Nothing pulled yet — click Load. Only a Google Tasks list whose name matches one of your own Contexts is offered.</div>';
return;
}
list.innerHTML = fetched.map(rowHtml).join('');

list.querySelectorAll('[data-goto-gtask]').forEach((btn) => {
btn.addEventListener('click', async () => {
const { switchTab } = await import('../tabs.js');
switchTab('tasks');
revealTask(btn.dataset.gotoGtask);
});
});
list.querySelectorAll('[data-gtask-capture]').forEach((btn) => {
btn.addEventListener('click', async () => {
const item = fetched.find((i) => i.sourceKey === btn.dataset.gtaskCapture);
if (!item) return;
await captureAndMaybeDelete(item);
render();
});
});
}

// The one `title`/`notes`/`due`/`contexts`/`link` shape both the per-row
// button and "Capture all shown" build -- `links` is only ever populated
// when the Google Task was created "from" something (most commonly
// Gmail's own "Add to Tasks"), so this is often empty, same as `due`.
function captureFieldsFor(item) {
return {
title: item.title,
notes: item.notes,
due: item.due,
link: (item.links && item.links[0] && item.links[0].link) || '',
contexts: [item.tasklistTitle],
source: { kind: 'googletask', label: item.tasklistTitle, url: item.sourceKey },
};
}

// Deletion only ever follows a SUCCESSFUL capture, and only when write
// access has actually been granted (hasTasksWrite()) -- otherwise this is
// exactly the capture-only behaviour from before. A delete failure is
// logged and left alone rather than surfaced as the capture itself
// failing: the task is already safely in the dashboard either way, and a
// stray leftover row in Google Tasks is a much smaller problem than an
// item silently not making it into the dashboard at all.
async function captureAndMaybeDelete(item) {
captureTask(captureFieldsFor(item));
if (!hasTasksWrite()) return;
try {
await deleteTask(item.tasklistId, item.id);
} catch (err) {
console.error(`Couldn't delete "${item.title}" from Google Tasks (already captured here, so nothing lost):`, err);
}
}

// Only a list whose name matches one of this dashboard's own Contexts,
// case-insensitively -- see this file's header comment for why there's no
// manual mapping fallback.
async function listContextMatchedTasks() {
const lists = await listTaskLists();
const matched = lists.filter((l) => data.taskContexts.some((c) => c.toLowerCase() === (l.title || '').trim().toLowerCase()));
const perList = await Promise.all(matched.map((l) => listTasks(l.id, l.title)));
return perList.flat();
}

function initGoogleTasksFeed() {
const btn = document.getElementById('gtasks-load-btn');
if (!btn) return;
const status = statusEl();

btn.addEventListener('click', async () => {
if (!(await canAttemptGoogleAction())) {
status.textContent = 'Sign in to Google at the top of Overview first.';
return;
}
btn.disabled = true;
status.textContent = 'Loading…';
try {
fetched = await listContextMatchedTasks();
status.textContent = `Loaded ${new Date().toLocaleTimeString()}.`;
render();
} catch (err) {
status.textContent = `Couldn't load Google Tasks: ${err.message || err}`;
console.error('Google Tasks pull failed:', err);
} finally {
btn.disabled = false;
}
});

// For a one-off migration out of Google Tasks rather than the day-to-day
// trickle: capture everything not already in the dashboard in one go,
// instead of clicking "+ task" dozens of times.
document.getElementById('gtasks-capture-all-btn').addEventListener('click', async () => {
const pending = fetched.filter((i) => !existingTaskFor(i));
for (const item of pending) await captureAndMaybeDelete(item);
if (pending.length) status.textContent = `Captured ${pending.length} to Inbox.`;
render();
});

render();
}

export { initGoogleTasksFeed };
