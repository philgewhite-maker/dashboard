import { data, queueSave, mailSearchLabel, blankPlannerActivity } from '../state.js';
import { escapeHtml, affiliateLink } from '../utils.js';
import { canAttemptGoogleAction } from '../sync/googleauth.js';
import { fetchMailSearches, getMessageBody } from '../googlemail.js';
import { captureTask } from './tasks.js';
import { legTargetPickerHtml, bindLegTargetPicker, readLegTargetPicker, applyLegExtraction } from './travel.js';
import { connectionPickerHtml, bindConnPickers } from './connections.js';
import { MAIL_ACTIONS } from './mailActions.js';

// "Tamara White" <tamara.anna.white@gmail.com> -> "Tamara White"; falls
// back to the raw email if there's no display name on the header.
function displayName(fromHeader) {
const match = fromHeader.match(/^"?([^"<]+?)"?\s*<[^>]+>$/);
return (match ? match[1] : fromHeader).trim();
}

function formatDate(dateStr) {
const d = new Date(dateStr);
if (isNaN(d)) return '';
return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// A task already captured from this email, if there is one. Compared on the
// message link, which is stable across devices — the button state then
// follows the synced data rather than what this browser happens to remember.
function existingTaskFor(m) {
return data.tasks.find((t) => t.source && t.source.kind === 'mail' && t.source.url === m.link && t.bucket !== 'done');
}

// The clickable control for one action on one message — a plain button for
// 'task' (its own always-live ✓-already-captured swap, unchanged from
// before this file had topics at all), a toggle for anything picker-kind
// (tripLeg, dateEvent) that reveals actionPickerHtml's matching container.
// Used identically whether this action is one of the topic's preferred 1-3
// or sitting in the "Other actions" list — same control, different place.
function actionTriggerHtml(actionId, m) {
if (actionId === 'task') {
const existing = existingTaskFor(m);
// Tasks are synced, so a task made on the desktop must be recognised
// when the same mail is re-read on the phone. Matching on the source
// URL rather than on anything session-local is what makes that work.
return existing
? `<button class="mini-task-btn done" type="button" data-goto-task="${escapeHtml(existing.id)}" title="Already captured — go to it">✓ task</button>`
: `<button class="mini-task-btn" type="button" title="${escapeHtml(MAIL_ACTIONS.task.title)}"
data-mail-task="${escapeHtml(m.id)}"
data-mail-subject="${escapeHtml(m.subject)}"
data-mail-from="${escapeHtml(displayName(m.from))}"
data-mail-url="${escapeHtml(m.link)}">+ task</button>`;
}
const action = MAIL_ACTIONS[actionId];
if (!action) return '';
return `<button class="mini-task-btn" type="button" title="${escapeHtml(action.title)}" data-mail-action-toggle="${actionId}:${escapeHtml(m.id)}">${escapeHtml(action.label)}</button>`;
}

// The revealed panel for one picker-kind action on one message — always
// rendered (hidden) regardless of whether this action is preferred for the
// row's topic, since it can also be reached from "Other actions".
function actionPickerHtml(actionId, m) {
if (actionId === 'tripLeg') {
return `<div class="mail-action-picker" data-mail-action-picker="tripLeg:${escapeHtml(m.id)}" hidden>
${legTargetPickerHtml(m.id)}
<button class="todo-add-btn" type="button" data-mail-trip-extract="${escapeHtml(m.id)}"
data-mail-subject="${escapeHtml(m.subject)}" data-mail-from="${escapeHtml(displayName(m.from))}" data-mail-url="${escapeHtml(m.link)}">Read email &amp; add</button>
<span class="sync-status" data-mail-trip-status="${escapeHtml(m.id)}"></span>
</div>`;
}
if (actionId === 'dateEvent') {
return `<div class="mail-action-picker" data-mail-action-picker="dateEvent:${escapeHtml(m.id)}" hidden>
${connectionPickerHtml(`mail-date-event-conn-${m.id}`, 'Link a connection (optional)…')}
<input type="text" class="settings-input" data-mail-date-event-title="${escapeHtml(m.id)}" value="${escapeHtml(m.subject)}" placeholder="Idea title">
<button class="todo-add-btn" type="button" data-mail-date-event-add="${escapeHtml(m.id)}" data-mail-snippet="${escapeHtml(m.snippet || '')}">Add idea</button>
<span class="sync-status" data-mail-date-event-status="${escapeHtml(m.id)}"></span>
</div>`;
}
return '';
}

// `topic`, when given, supplies up to 3 preferred action ids (in configured
// order); everything else registered in MAIL_ACTIONS still shows, under
// "Other actions" — a booking email can always be taken as a plain task
// even when Task isn't Travel's own preferred pick. `topic` is null for a
// message from a search with no topic assigned, which shows every action
// under "Other actions" (nothing preferred) rather than guessing.
function messageRowHtml(m, topic) {
const preferredIds = ((topic && topic.preferredActionIds) || []).filter((id) => MAIL_ACTIONS[id]).slice(0, 3);
const otherIds = Object.keys(MAIL_ACTIONS).filter((id) => !preferredIds.includes(id));
const otherHtml = otherIds.length
? `<span class="mail-other-actions">
<button class="mini-task-btn" type="button" data-mail-other-toggle="${escapeHtml(m.id)}">&#8943; Other actions</button>
<span class="mail-other-menu" data-mail-other-menu="${escapeHtml(m.id)}" hidden>${otherIds.map((id) => actionTriggerHtml(id, m)).join('')}</span>
</span>`
: '';
const pickersHtml = Object.keys(MAIL_ACTIONS)
.filter((id) => MAIL_ACTIONS[id].kind === 'picker')
.map((id) => actionPickerHtml(id, m)).join('');
return `<div class="mail-row">
<a class="mail-link" href="${escapeHtml(affiliateLink(m.link))}" target="_blank" rel="noopener">
<span class="mail-from">${escapeHtml(displayName(m.from))}</span>
<span class="mail-subject">${escapeHtml(m.subject)}</span>
<span class="mail-date">${escapeHtml(formatDate(m.date))}</span>
</a>
${preferredIds.map((id) => actionTriggerHtml(id, m)).join('')}${otherHtml}
</div>
${pickersHtml}`;
}

function sectionHtml(title, messages, topic) {
if (messages.length === 0) return '';
return `<div class="overview-group"><h3>${escapeHtml(title)}</h3><div class="mail-section">${messages.map((m) => messageRowHtml(m, topic)).join('')}</div></div>`;
}

// A section heading says what the row searched for and, when it's limited to
// a window, how far back — otherwise "From: x (3)" is ambiguous about
// whether that's all of them or just the recent ones.
function sectionTitle(search) {
const label = mailSearchLabel(search);
const days = Math.max(0, Number(search.maxDays) || 0);
return days > 0 ? `${label} — last ${days} day${days === 1 ? '' : 's'}` : label;
}

function renderMail(sections) {
const list = document.getElementById('mail-list');
const total = sections.reduce((n, s) => n + s.messages.length, 0);
document.getElementById('mail-count').textContent = `${total} shown`;

// A topic-assigned search merges into one shared heading per topic
// (dropping its own "last N days" sub-label -- a heading combining
// several searches with different maxDays can't summarise that in one
// number). A search with NO topic renders exactly as it always has, one
// heading per search with its own sectionTitle -- so a panel with no
// topics configured yet looks completely unchanged.
const byTopic = new Map();
const untopicked = [];
sections.forEach((s) => {
if (s.search.topicId) {
if (!byTopic.has(s.search.topicId)) byTopic.set(s.search.topicId, []);
byTopic.get(s.search.topicId).push(...s.messages);
} else {
untopicked.push(s);
}
});
const topicSections = data.mailTopics
.filter((t) => byTopic.has(t.id))
.map((t) => sectionHtml(t.label || 'Untitled topic', byTopic.get(t.id).sort((a, b) => new Date(b.date) - new Date(a.date)), t));
const untopickedSections = untopicked.map((s) => sectionHtml(sectionTitle(s.search), s.messages, null));

const html = [...topicSections, ...untopickedSections].filter(Boolean).join('');
list.innerHTML = html || (data.mailSearches.length === 0
? '<div class="empty">No mail searches set up — add some in <span class="inline-goto-link" data-goto-tab="settings" data-goto-target="#mail-searches-block">Settings</span>.</div>'
: '<div class="empty">Nothing matched your mail searches.</div>');

list.querySelectorAll('[data-goto-task]').forEach((btn) => {
btn.addEventListener('click', async (e) => {
e.preventDefault();
const [{ switchTab }, tasks] = await Promise.all([import('../tabs.js'), import('./tasks.js')]);
switchTab('tasks');
tasks.revealTask(btn.dataset.gotoTask);
});
});

list.querySelectorAll('[data-mail-task]').forEach((btn) => {
btn.addEventListener('click', (e) => {
e.preventDefault();
captureTask({
title: `Reply: ${btn.dataset.mailSubject}`,
notes: `From ${btn.dataset.mailFrom}`,
source: { kind: 'mail', label: btn.dataset.mailSubject, url: btn.dataset.mailUrl },
});
btn.textContent = '✓ captured';
btn.disabled = true;
});
});

list.querySelectorAll('[data-mail-other-toggle]').forEach((btn) => {
btn.addEventListener('click', (e) => {
e.preventDefault();
const menu = list.querySelector(`[data-mail-other-menu="${CSS.escape(btn.dataset.mailOtherToggle)}"]`);
if (menu) menu.hidden = !menu.hidden;
});
});

list.querySelectorAll('[data-mail-action-toggle]').forEach((btn) => {
btn.addEventListener('click', (e) => {
e.preventDefault();
const [actionId, id] = btn.dataset.mailActionToggle.split(':');
const picker = list.querySelector(`[data-mail-action-picker="${CSS.escape(actionId)}:${CSS.escape(id)}"]`);
if (!picker) return;
picker.hidden = !picker.hidden;
if (!picker.hidden && actionId === 'tripLeg') bindLegTargetPicker(picker, id);
});
});

list.querySelectorAll('[data-mail-date-event-add]').forEach((btn) => {
btn.addEventListener('click', async (e) => {
e.preventDefault();
const id = btn.dataset.mailDateEventAdd;
const titleInput = list.querySelector(`[data-mail-date-event-title="${CSS.escape(id)}"]`);
const status = list.querySelector(`[data-mail-date-event-status="${CSS.escape(id)}"]`);
const say = (msg) => { if (status) status.textContent = msg; };
const title = (titleInput?.value || '').trim();
if (!title) { say('Give the idea a title first.'); return; }
const connectionId = document.getElementById(`mail-date-event-conn-${id}`)?.value || '';
data.plannerActivities.push(blankPlannerActivity({ title, notes: btn.dataset.mailSnippet || '', connectionId }));
queueSave();
say('Added to Planner’s Activities pool.');
btn.disabled = true;
// Planner renders itself only from its own actions -- without this, a
// tab already open on Planner (or switched to right after, no reload)
// wouldn't show the new idea until something else happened to trigger
// a re-render, same cross-tab-refresh convention captureTask() callers
// elsewhere already follow for Connections/Overview.
(await import('./planner.js')).renderPlanner();
});
});

list.querySelectorAll('[data-mail-trip-extract]').forEach((btn) => {
btn.addEventListener('click', async (e) => {
e.preventDefault();
const id = btn.dataset.mailTripExtract;
const picker = list.querySelector(`[data-mail-action-picker="tripLeg:${CSS.escape(id)}"]`);
const status = list.querySelector(`[data-mail-trip-status="${CSS.escape(id)}"]`);
if (!picker) return;
const say = (msg) => { if (status) status.textContent = msg; };
btn.disabled = true;
say('Reading the email…');
try {
const [{ extractTripLegFromEmail }, body] = await Promise.all([import('../ai.js'), getMessageBody(id)]);
say('Pulling out the details…');
const extraction = await extractTripLegFromEmail(btn.dataset.mailSubject, btn.dataset.mailFrom, body);
if (!extraction.kind && Object.keys(extraction.fields).length === 0) {
say("Didn't recognise this as travel logistics.");
return;
}
const picked = readLegTargetPicker(picker, id);
const { trip, leg, filled } = await applyLegExtraction({
...picked,
extraction,
source: { kind: 'mail', label: btn.dataset.mailSubject, url: btn.dataset.mailUrl },
});
say(`Added ${filled} field${filled === 1 ? '' : 's'} to "${trip.title}" — ${leg.kind}.`);
} catch (err) {
console.error('Trip email extraction failed:', err);
say(err?.name === 'MissingKeyError' ? 'Add an Anthropic API key in Settings to read trip details from email.' : `Couldn't read that: ${err.message || err}`);
} finally {
btn.disabled = false;
}
});
});
}

function initMail() {
bindConnPickers(); // Mail can render (and its "+ date event" picker with it) before Dating/Planner ever do
const btn = document.getElementById('sync-mail-btn');
const status = document.getElementById('mail-sync-status');
btn.addEventListener('click', async () => {
if (!(await canAttemptGoogleAction())) {
status.textContent = 'Sign in to Google at the top of Overview first.';
return;
}
btn.disabled = true;
status.textContent = 'Loading…';
try {
renderMail(await fetchMailSearches(data.mailSearches, data.prefs.mailResultCount));
status.textContent = `Updated ${new Date().toLocaleTimeString()}.`;
} catch (err) {
status.textContent = `Couldn't load mail: ${err.message || err}`;
console.error('Mail refresh failed:', err);
} finally {
btn.disabled = false;
}
});
}

export { initMail };
