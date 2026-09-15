import { data, queueSave, mailSearchLabel, blankPlannerActivity, blankMailDismissal } from '../state.js';
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

// Same source-url matching as existingTaskFor, for the other two
// committing actions -- applyLegExtraction (travel.js) already stores
// `source` on the leg it creates, same shape/reasoning.
function existingTripLegFor(m) {
for (const trip of data.trips) {
const leg = trip.legs.find((l) => l.source && l.source.kind === 'mail' && l.source.url === m.link);
if (leg) return { trip, leg };
}
return null;
}
function existingDateEventFor(m) {
return data.plannerActivities.find((a) => a.source && a.source.kind === 'mail' && a.source.url === m.link);
}
// A message explicitly binned (see the ✕ dismiss button in messageRowHtml)
// without ever becoming a task/trip-leg/date-event -- keyed by url, same
// identity every existingXFor above already matches on.
function existingDismissalFor(m) {
return data.mailDismissed.find((d) => d.url === m.link);
}

// 'dismissed' beats 'processed' beats 'open' -- realistically a given
// email only ever reaches one of the two closed states, but a dismissal
// is the more deliberate, more recent signal if both somehow apply.
// Drives both the collapsed "already processed" bucket and (separately)
// which messages disappear from Mail entirely in sectionHtml/renderMail
// below -- not any individual action button's own state, which stays
// per-action regardless (a message already turned into a trip leg still
// shows a live "+ task" if you also want one).
function messageStatus(m) {
if (existingDismissalFor(m)) return 'dismissed';
if (existingTaskFor(m) || existingTripLegFor(m) || existingDateEventFor(m)) return 'processed';
return 'open';
}

// Shared shape for every "✨ Use AI" button (aiTask, dateEvent's own fill,
// improveTask) -- read the full email body, run the named ai.js export on
// it, report a MissingKeyError distinctly (same message every other
// AI-assisted flow in this file already uses) instead of a raw error dump.
// Returns null on any failure, having already reported it via `say`.
async function runAiExtraction(extractFnName, id, subject, from, say) {
say('Reading the email…');
try {
const [aiMod, body] = await Promise.all([import('../ai.js'), getMessageBody(id)]);
say('Pulling out the details…');
return await aiMod[extractFnName](subject, from, body);
} catch (err) {
console.error('Mail AI extraction failed:', err);
say(err?.name === 'MissingKeyError' ? 'Add an Anthropic API key in Settings to use AI here.' : `Couldn't read that: ${err.message || err}`);
return null;
}
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
if (existing) {
// "Improve" is deliberately NOT a MAIL_ACTIONS entry -- it only ever
// makes sense once a task already exists for this message, so it
// rides along with the ✓ state here rather than being a 4th
// catalog entry that would need its own preferred/other placement.
return `<button class="mini-task-btn done" type="button" data-goto-task="${escapeHtml(existing.id)}" title="Already captured — go to it">✓ task</button>
<button class="mini-task-btn" type="button" title="Read the email and propose a better title/notes/due for this task" data-mail-action-toggle="improveTask:${escapeHtml(m.id)}">✨ Improve</button>`;
}
return `<button class="mini-task-btn" type="button" title="${escapeHtml(MAIL_ACTIONS.task.title)}"
data-mail-task="${escapeHtml(m.id)}"
data-mail-subject="${escapeHtml(m.subject)}"
data-mail-from="${escapeHtml(displayName(m.from))}"
data-mail-url="${escapeHtml(m.link)}">+ task</button>`;
}
const action = MAIL_ACTIONS[actionId];
if (!action) return '';
return `<button class="mini-task-btn" type="button" title="${escapeHtml(action.title)}" data-mail-action-toggle="${actionId}:${escapeHtml(m.id)}">${escapeHtml(action.label)}</button>`;
}

// A "✨ Use AI" button shared by every AI-assisted picker below -- same
// subject/from dataset trip-leg's own extract button already carries, so
// the click handler can read the email without needing the original `m`.
function useAiButtonHtml(fillAttr, m) {
return `<button class="mini-task-btn" type="button" ${fillAttr}="${escapeHtml(m.id)}"
data-mail-subject="${escapeHtml(m.subject)}" data-mail-from="${escapeHtml(displayName(m.from))}">✨ Use AI</button>`;
}

// The revealed panel for one picker-kind action on one message — always
// rendered (hidden) regardless of whether this action is preferred for the
// row's topic, since it can also be reached from "Other actions".
// `improveTask` is the one exception rendered outside MAIL_ACTIONS
// entirely (see actionTriggerHtml's 'task' branch) -- included here too
// since messageRowHtml appends it the same way.
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
${useAiButtonHtml('data-mail-date-event-fill', m)}
<button class="todo-add-btn" type="button" data-mail-date-event-add="${escapeHtml(m.id)}" data-mail-snippet="${escapeHtml(m.snippet || '')}" data-mail-url="${escapeHtml(m.link)}">Add idea</button>
<span class="sync-status" data-mail-date-event-status="${escapeHtml(m.id)}"></span>
</div>`;
}
if (actionId === 'aiTask') {
// Prefilled with the SAME deterministic default plain "+ task"
// produces -- "Use AI" is what replaces it, not the starting point.
return `<div class="mail-action-picker" data-mail-action-picker="aiTask:${escapeHtml(m.id)}" hidden>
<input type="text" class="settings-input" data-mail-ai-task-title="${escapeHtml(m.id)}" value="${escapeHtml(`Reply: ${m.subject}`)}" placeholder="Task title">
<textarea class="settings-input" data-mail-ai-task-notes="${escapeHtml(m.id)}" rows="2" placeholder="Notes">${escapeHtml(`From ${displayName(m.from)}`)}</textarea>
<input type="date" class="settings-input" data-mail-ai-task-due="${escapeHtml(m.id)}">
${useAiButtonHtml('data-mail-ai-task-fill', m)}
<button class="todo-add-btn" type="button" data-mail-ai-task-add="${escapeHtml(m.id)}" data-mail-url="${escapeHtml(m.link)}">Add task</button>
<span class="sync-status" data-mail-ai-task-status="${escapeHtml(m.id)}"></span>
</div>`;
}
if (actionId === 'improveTask') {
const existing = existingTaskFor(m);
if (!existing) return ''; // only ever offered alongside an already-captured task
return `<div class="mail-action-picker" data-mail-action-picker="improveTask:${escapeHtml(m.id)}" hidden>
<input type="text" class="settings-input" data-mail-improve-task-title="${escapeHtml(m.id)}" value="${escapeHtml(existing.title)}" placeholder="Task title">
<textarea class="settings-input" data-mail-improve-task-notes="${escapeHtml(m.id)}" rows="2" placeholder="Notes">${escapeHtml(existing.notes)}</textarea>
<input type="date" class="settings-input" data-mail-improve-task-due="${escapeHtml(m.id)}" value="${escapeHtml(existing.due || '')}">
${useAiButtonHtml('data-mail-improve-task-fill', m)}
<button class="todo-add-btn" type="button" data-mail-improve-task-apply="${escapeHtml(m.id)}" data-mail-improve-task-id="${escapeHtml(existing.id)}">Apply</button>
<span class="sync-status" data-mail-improve-task-status="${escapeHtml(m.id)}"></span>
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
.map((id) => actionPickerHtml(id, m)).join('')
+ (existingTaskFor(m) ? actionPickerHtml('improveTask', m) : '');
return `<div class="mail-row">
<a class="mail-link" href="${escapeHtml(affiliateLink(m.link))}" target="_blank" rel="noopener">
<span class="mail-from">${escapeHtml(displayName(m.from))}</span>
<span class="mail-subject">${escapeHtml(m.subject)}</span>
<span class="mail-date">${escapeHtml(formatDate(m.date))}</span>
</a>
${preferredIds.map((id) => actionTriggerHtml(id, m)).join('')}${otherHtml}
<button class="mail-dismiss-btn" type="button" title="Dismiss — not turning this into anything, just stop showing it"
data-mail-dismiss="${escapeHtml(m.id)}" data-mail-url="${escapeHtml(m.link)}" data-mail-subject="${escapeHtml(m.subject)}" data-mail-from="${escapeHtml(displayName(m.from))}">&times;</button>
</div>
${pickersHtml}`;
}

// A digest row for a subject that appeared more than once (some senders
// blast the identical subject repeatedly) -- one row + count instead of N
// near-identical ones. `group` is every message sharing this subject,
// already date-sorted (sectionHtml sorts before grouping), so group[0] is
// the most recent. `visibleGroup` (open + processed, never dismissed --
// nothing dismissed is ever individually re-shown here) expands under a
// "Show all" toggle using the SAME messageRowHtml every other row uses,
// so each one keeps its own full, independent set of action/dismiss
// controls -- consolidation is purely a display grouping, never a
// shortcut that acts on more than one message at once.
function consolidatedRowHtml(group, byStatus, topic) {
const latest = group[0];
const parts = [];
if (byStatus.open.length) parts.push(`${byStatus.open.length} open`);
if (byStatus.processed.length) parts.push(`${byStatus.processed.length} actioned`);
if (byStatus.dismissed.length) parts.push(`${byStatus.dismissed.length} binned`);
const visibleGroup = [...byStatus.open, ...byStatus.processed];
const toggleHtml = visibleGroup.length
? `<button class="mini-task-btn" type="button" data-mail-group-toggle="${escapeHtml(latest.id)}">Show all</button>`
: '';
const detailHtml = visibleGroup.length
? `<div class="mail-group-detail" data-mail-group-detail="${escapeHtml(latest.id)}" hidden>${visibleGroup.map((m) => messageRowHtml(m, topic)).join('')}</div>`
: '';
return `<div class="mail-row mail-row-group">
<span class="mail-from">${escapeHtml(displayName(latest.from))}</span>
<span class="mail-subject">${escapeHtml(latest.subject)} <span class="mail-group-count">&times;${group.length}</span></span>
<span class="mail-group-breakdown">${escapeHtml(parts.join(' · '))}</span>
${toggleHtml}
</div>
${detailHtml}`;
}

// `limit` is how many ACTIONABLE (open) messages this heading should show
// before the rest -- a processed or dismissed one never counts against
// it. A dismissed message is never rendered anywhere in Mail at all (see
// Settings' "Mail bin" for that); a processed one lands in the collapsed
// "already processed" details regardless of how many there are. Same
// subject appearing more than once collapses to one row (consolidatedRowHtml)
// wherever it lands -- the open/closed split happens first, by group, so
// a group with even one open message still surfaces in the visible list.
// Returns {html, openCount} -- openCount lets renderMail total up "N
// shown" by actual open MESSAGE count, not by row (a consolidated row is
// one row representing several).
function sectionHtml(title, messages, topic, limit) {
if (messages.length === 0) return { html: '', openCount: 0 };

const groups = new Map(); // subject -> messages[], insertion order == messages' own date-desc order
messages.forEach((m) => {
const key = m.subject || '';
if (!groups.has(key)) groups.set(key, []);
groups.get(key).push(m);
});

const openRows = []; // [{html, openCount}], budget-capped below
const closedRows = []; // fully-closed groups/singles, always all shown (collapsed)
for (const group of groups.values()) {
const byStatus = { open: [], processed: [], dismissed: [] };
group.forEach((m) => byStatus[messageStatus(m)].push(m));
if (byStatus.open.length) {
openRows.push({
html: group.length === 1 ? messageRowHtml(group[0], topic) : consolidatedRowHtml(group, byStatus, topic),
openCount: byStatus.open.length,
});
continue;
}
// No open messages left in this subject -- fully closed. A dismissed-
// only subject (byStatus.processed.length === 0 too) has nothing left
// worth a summary line at all; skip it entirely rather than cluttering
// "already processed" with something that was actually binned.
if (!byStatus.processed.length) continue;
closedRows.push(group.length === 1 ? messageRowHtml(group[0], topic) : consolidatedRowHtml(group, byStatus, topic));
}

let budget = limit || Infinity;
const shownOpenHtml = [];
let shownOpenCount = 0;
for (const row of openRows) {
if (budget <= 0) break;
shownOpenHtml.push(row.html);
shownOpenCount += row.openCount;
budget -= row.openCount;
}

if (!shownOpenHtml.length && !closedRows.length) return { html: '', openCount: 0 };
const actionableHtml = shownOpenHtml.length ? `<div class="mail-section">${shownOpenHtml.join('')}</div>` : '';
// A native <details> -- no custom hidden-attribute toggle needed, the
// browser already handles its own open/collapsed state.
const processedHtml = closedRows.length
? `<details class="mail-processed"><summary>&#10003; ${closedRows.length} already processed</summary><div class="mail-section">${closedRows.join('')}</div></details>`
: '';
return { html: `<div class="overview-group"><h3>${escapeHtml(title)}</h3>${actionableHtml}${processedHtml}</div>`, openCount: shownOpenCount };
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

// A topic-assigned search merges into one shared heading per topic
// (dropping its own "last N days" sub-label -- a heading combining
// several searches with different maxDays can't summarise that in one
// number). Its actionable cap is the SUM of every search feeding that
// topic's own configured limit -- each search still gets to contribute
// up to what it was set up for. A search with NO topic renders exactly
// as it always has, one heading per search with its own sectionTitle --
// so a panel with no topics configured yet looks completely unchanged.
const byTopic = new Map(); // topicId -> { messages: [], limit: 0 }
const untopicked = [];
sections.forEach((s) => {
if (s.search.topicId) {
if (!byTopic.has(s.search.topicId)) byTopic.set(s.search.topicId, { messages: [], limit: 0 });
const bucket = byTopic.get(s.search.topicId);
bucket.messages.push(...s.messages);
bucket.limit += s.limit;
} else {
untopicked.push(s);
}
});
const topicSections = data.mailTopics
.filter((t) => byTopic.has(t.id))
.map((t) => {
const { messages, limit } = byTopic.get(t.id);
return sectionHtml(t.label || 'Untitled topic', messages.sort((a, b) => new Date(b.date) - new Date(a.date)), t, limit);
});
const untopickedSections = untopicked.map((s) => sectionHtml(sectionTitle(s.search), s.messages, null, s.limit));

const rendered = [...topicSections, ...untopickedSections].filter((r) => r.html);
const html = rendered.map((r) => r.html).join('');
list.innerHTML = html || (data.mailSearches.length === 0
? '<div class="empty">No mail searches set up — add some in <span class="inline-goto-link" data-goto-tab="settings" data-goto-target="#mail-searches-block">Settings</span>.</div>'
: '<div class="empty">Nothing matched your mail searches.</div>');

// Counted from the actual openCount each section computed, not by
// querying the DOM for .mail-row -- a consolidated row is one row
// representing several open messages, which a DOM count would undercount.
const shown = rendered.reduce((n, r) => n + r.openCount, 0);
document.getElementById('mail-count').textContent = `${shown} shown`;

list.querySelectorAll('[data-mail-group-toggle]').forEach((btn) => {
btn.addEventListener('click', (e) => {
e.preventDefault();
const detail = list.querySelector(`[data-mail-group-detail="${CSS.escape(btn.dataset.mailGroupToggle)}"]`);
if (detail) detail.hidden = !detail.hidden;
});
});

list.querySelectorAll('[data-mail-dismiss]').forEach((btn) => {
btn.addEventListener('click', (e) => {
e.preventDefault();
const url = btn.dataset.mailUrl;
if (!data.mailDismissed.some((d) => d.url === url)) {
data.mailDismissed.push(blankMailDismissal({ url, subject: btn.dataset.mailSubject, from: btn.dataset.mailFrom }));
queueSave();
}
// Re-render from the same fetched data rather than re-fetching Gmail
// -- dismissing is purely a local view change, nothing new to pull.
renderMail(lastSections);
});
});

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

list.querySelectorAll('[data-mail-date-event-fill]').forEach((btn) => {
btn.addEventListener('click', async (e) => {
e.preventDefault();
const id = btn.dataset.mailDateEventFill;
const status = list.querySelector(`[data-mail-date-event-status="${CSS.escape(id)}"]`);
const say = (msg) => { if (status) status.textContent = msg; };
btn.disabled = true;
const result = await runAiExtraction('extractDateEventFromEmail', id, btn.dataset.mailSubject, btn.dataset.mailFrom, say);
btn.disabled = false;
if (!result) return;
const titleInput = list.querySelector(`[data-mail-date-event-title="${CSS.escape(id)}"]`);
const addBtn = list.querySelector(`[data-mail-date-event-add="${CSS.escape(id)}"]`);
if (titleInput && result.title) titleInput.value = result.title;
// Stashed on the Add button itself rather than a hidden input -- the
// same place its deterministic default (data-mail-snippet) already
// lives, and the only thing that reads either is the Add handler below.
if (addBtn) {
if (result.notes) addBtn.dataset.mailSnippet = result.notes;
addBtn.dataset.mailDateEventDate = result.date || '';
}
say(result.date ? `Found a date: ${result.date}.` : 'No specific date found — will stay an undated idea.');
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
const activity = blankPlannerActivity({
title, notes: btn.dataset.mailSnippet || '', connectionId,
source: { kind: 'mail', label: title, url: btn.dataset.mailUrl },
});
data.plannerActivities.push(activity);
// Only ever set by a successful "✨ Use AI" fill above -- absent (the
// deterministic default never sets it) means stay an undated pool
// idea, same as today.
const date = btn.dataset.mailDateEventDate;
const planner = await import('./planner.js');
if (date) planner.placeEntry('activity', activity.id, date, '');
queueSave();
say(date ? `Added to Planner, placed on ${date}.` : 'Added to Planner’s Activities pool.');
btn.disabled = true;
// Planner renders itself only from its own actions -- without this, a
// tab already open on Planner (or switched to right after, no reload)
// wouldn't show the new idea until something else happened to trigger
// a re-render, same cross-tab-refresh convention captureTask() callers
// elsewhere already follow for Connections/Overview.
planner.renderPlanner();
});
});

list.querySelectorAll('[data-mail-ai-task-fill]').forEach((btn) => {
btn.addEventListener('click', async (e) => {
e.preventDefault();
const id = btn.dataset.mailAiTaskFill;
const status = list.querySelector(`[data-mail-ai-task-status="${CSS.escape(id)}"]`);
const say = (msg) => { if (status) status.textContent = msg; };
btn.disabled = true;
const result = await runAiExtraction('extractTaskFromEmail', id, btn.dataset.mailSubject, btn.dataset.mailFrom, say);
btn.disabled = false;
if (!result) return;
const titleInput = list.querySelector(`[data-mail-ai-task-title="${CSS.escape(id)}"]`);
const notesInput = list.querySelector(`[data-mail-ai-task-notes="${CSS.escape(id)}"]`);
const dueInput = list.querySelector(`[data-mail-ai-task-due="${CSS.escape(id)}"]`);
if (titleInput && result.title) titleInput.value = result.title;
if (notesInput && result.notes) notesInput.value = result.notes;
if (dueInput) dueInput.value = result.due || '';
say('Filled in — review, then Add task.');
});
});

list.querySelectorAll('[data-mail-ai-task-add]').forEach((btn) => {
btn.addEventListener('click', (e) => {
e.preventDefault();
const id = btn.dataset.mailAiTaskAdd;
const title = (list.querySelector(`[data-mail-ai-task-title="${CSS.escape(id)}"]`)?.value || '').trim();
const notes = list.querySelector(`[data-mail-ai-task-notes="${CSS.escape(id)}"]`)?.value || '';
const due = list.querySelector(`[data-mail-ai-task-due="${CSS.escape(id)}"]`)?.value || '';
const status = list.querySelector(`[data-mail-ai-task-status="${CSS.escape(id)}"]`);
const say = (msg) => { if (status) status.textContent = msg; };
if (!title) { say('Give the task a title first.'); return; }
captureTask({ title, notes, due, source: { kind: 'mail', label: title, url: btn.dataset.mailUrl } });
say('Task added.');
btn.disabled = true;
});
});

list.querySelectorAll('[data-mail-improve-task-fill]').forEach((btn) => {
btn.addEventListener('click', async (e) => {
e.preventDefault();
const id = btn.dataset.mailImproveTaskFill;
const status = list.querySelector(`[data-mail-improve-task-status="${CSS.escape(id)}"]`);
const say = (msg) => { if (status) status.textContent = msg; };
btn.disabled = true;
const result = await runAiExtraction('extractTaskFromEmail', id, btn.dataset.mailSubject, btn.dataset.mailFrom, say);
btn.disabled = false;
if (!result) return;
const titleInput = list.querySelector(`[data-mail-improve-task-title="${CSS.escape(id)}"]`);
const notesInput = list.querySelector(`[data-mail-improve-task-notes="${CSS.escape(id)}"]`);
const dueInput = list.querySelector(`[data-mail-improve-task-due="${CSS.escape(id)}"]`);
if (titleInput && result.title) titleInput.value = result.title;
if (notesInput && result.notes) notesInput.value = result.notes;
if (dueInput && result.due) dueInput.value = result.due;
say('Filled in — review, then Apply.');
});
});

list.querySelectorAll('[data-mail-improve-task-apply]').forEach((btn) => {
btn.addEventListener('click', async (e) => {
e.preventDefault();
const id = btn.dataset.mailImproveTaskApply;
const taskId = btn.dataset.mailImproveTaskId;
const status = list.querySelector(`[data-mail-improve-task-status="${CSS.escape(id)}"]`);
const say = (msg) => { if (status) status.textContent = msg; };
const task = data.tasks.find((t) => t.id === taskId);
if (!task) { say('That task no longer exists.'); return; }
const title = (list.querySelector(`[data-mail-improve-task-title="${CSS.escape(id)}"]`)?.value || '').trim();
if (!title) { say('Give the task a title first.'); return; }
task.title = title;
task.notes = list.querySelector(`[data-mail-improve-task-notes="${CSS.escape(id)}"]`)?.value || '';
task.due = list.querySelector(`[data-mail-improve-task-due="${CSS.escape(id)}"]`)?.value || '';
queueSave();
say('Task updated.');
btn.disabled = true;
(await import('./tasks.js')).renderTasks();
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

// The last fetched result, kept purely so a dismiss (a local view change,
// nothing new from Gmail) can re-render without a full refetch.
let lastSections = [];

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
lastSections = await fetchMailSearches(data.mailSearches, data.prefs.mailResultCount);
renderMail(lastSections);
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
