// Pulls items in from Google Tasks — a work web filter that allows
// Calendar/Tasks but little else, or a quick voice-add on a phone, land
// there; this brings them into the dashboard's real Inbox. One-directional:
// nothing here ever writes back to Google.
import { data } from '../state.js';
import { escapeHtml } from '../utils.js';
import { canAttemptGoogleAction } from '../sync/googleauth.js';
import { listAllTasks } from '../googletasks.js';
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
list.innerHTML = '<div class="empty">Nothing pulled yet — click Load.</div>';
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
btn.addEventListener('click', () => {
const item = fetched.find((i) => i.sourceKey === btn.dataset.gtaskCapture);
if (!item) return;
captureTask({
title: item.title,
notes: item.notes,
due: item.due,
source: { kind: 'googletask', label: item.tasklistTitle, url: item.sourceKey },
});
render();
});
});
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
fetched = await listAllTasks();
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
document.getElementById('gtasks-capture-all-btn').addEventListener('click', () => {
const pending = fetched.filter((i) => !existingTaskFor(i));
pending.forEach((item) => {
captureTask({
title: item.title,
notes: item.notes,
due: item.due,
source: { kind: 'googletask', label: item.tasklistTitle, url: item.sourceKey },
});
});
if (pending.length) status.textContent = `Captured ${pending.length} to Inbox.`;
render();
});

render();
}

export { initGoogleTasksFeed };
