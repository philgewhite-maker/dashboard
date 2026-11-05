// Today queue (Dating tab): three buckets that turn "who should I deal with
// now" into a short list with one-tap actions.
//   1. Priority -- pinned / far-along people past their reach-out time.
//   2. Recent matches -- matched in the last 14 days, and either never
//      messaged by you or waiting on YOUR reply.
//   3. Offboard -- a daily quota of old / expired-timer people to mark
//      Faded or Archived (or keep).
// Actions reuse the existing mutations (logContactNow, priorityFlag, stage,
// attentionSnoozedUntil); the only new state is c.chaseUntil / c.sentAt and
// data.dayQueue (the daily offboard counter).
import { data, queueSave, isDormantStage, isTravelPaused, reachOutThreshold } from '../state.js';
import { todayStr, daysSince, escapeHtml, hydratePhotoBackgrounds } from '../utils.js';
import { liveChat, chatTarget } from './chatlinks.js';
import { isPriorityConnection, connectionChipHtml, bindConnectionChips, logContactNow, renderConnections, CONN_STAGES } from './connections.js';

const OFFBOARD_PER_DAY = 5;
const RECENT_DAYS = 14;
const CHASE_DAYS = 14;
const SHOW_CAP = 8;
const NEW_STAGES = new Set(['Superswiped', 'Matched', 'Chatting in app']);
const LINE_RE = /^\[(?:\d{4}-\d{2}-\d{2}\s+)?\d{1,2}:\d{2}\]\s*([^:]+):/;

function plusDays(n) {
const d = new Date();
d.setDate(d.getDate() + n);
return d.toISOString().slice(0, 10);
}

function logFor(c, platform) {
// The newest thread on that app with text. A row the data-model migration made
// for an older chat (id ending -legacy-<app>) only counts when it is the only one.
const rows = (c.identities || []).filter((r) => r.platform === platform && String(r.chatLog || '').trim());
const live = rows.filter((r) => !/-legacy-/.test(r.id || ''));
const row = (live.length ? live : rows).slice(-1)[0];
return row ? row.chatLog : '';
}

// { hasYou, last } from one chat log; last is 'you' | 'them' | ''.
function chatTurn(log) {
let hasYou = false;
let last = '';
String(log || '').split('\n').forEach((line) => {
const m = line.match(LINE_RE);
if (!m) return;
const you = m[1].trim() === 'You';
if (you) hasYou = true;
last = you ? 'you' : 'them';
});
return { hasYou, last };
}

function activeFor(c) {
return !c.isFamily && !isDormantStage(c.stage) && !isTravelPaused(c) && c.stage !== 'Backlog review';
}
function chasing(c) { return !!(c.chaseUntil && c.chaseUntil > todayStr()); }
function snoozed(c) { return !!(c.attentionSnoozedUntil && c.attentionSnoozedUntil > todayStr()); }

// Whether the chat on file says the next move is yours, discounting a read
// that predates your last "Sent".
function yourMove(c) {
const { hasYou, last } = chatTurn(logFor(c, liveChat(c)));
const answeredSinceRead = !!c.sentAt && (!c.tinderLastScrapedAt || String(c.tinderLastScrapedAt) <= c.sentAt);
if (answeredSinceRead) return { yours: false, why: '' };
if (!hasYou) return { yours: true, why: 'not messaged yet' };
if (last === 'them') return { yours: true, why: 'their message is last' };
return { yours: false, why: '' };
}

function matchAge(c) {
const t = Date.parse(c.matchedOn || '');
if (isNaN(t)) return null;
return Math.floor((Date.now() - t) / 864e5);
}

function buckets() {
const today = todayStr();
const priority = data.connections
.filter((c) => activeFor(c) && isPriorityConnection(c) && !snoozed(c) && !chasing(c))
.map((c) => ({ c, over: daysSince(c.lastContact) - reachOutThreshold(c.priority, c.stage) }))
.filter((x) => x.over >= 0)
.sort((a, b) => b.over - a.over)
.map((x) => ({ c: x.c, note: `${daysSince(x.c.lastContact)}d since contact` }));
const inPriority = new Set(priority.map((x) => x.c.id));
const recent = data.connections
.filter((c) => activeFor(c) && NEW_STAGES.has(c.stage) && !inPriority.has(c.id) && !chasing(c) && !snoozed(c))
.map((c) => ({ c, age: matchAge(c), turn: yourMove(c) }))
.filter((x) => x.age !== null && x.age <= RECENT_DAYS && x.turn.yours)
.sort((a, b) => b.age - a.age)
.map((x) => ({ c: x.c, note: `matched ${x.age}d ago · ${x.turn.why}` }));
const done = data.dayQueue.date === today ? data.dayQueue.offboarded : 0;
const offAll = data.connections
.filter((c) => !c.isFamily && !isPriorityConnection(c) && !isTravelPaused(c) && !chasing(c)
&& (c.stage === 'Backlog review'
|| (c.chaseUntil && c.chaseUntil <= today && !isDormantStage(c.stage))
|| (!isDormantStage(c.stage) && daysSince(c.lastContact) >= 180)))
.map((c) => ({ c, expired: !!(c.chaseUntil && c.chaseUntil <= today), quiet: daysSince(c.lastContact) }))
.sort((a, b) => (b.expired - a.expired) || (b.quiet - a.quiet))
.map((x) => ({ c: x.c, note: x.expired ? `no answer after the ${CHASE_DAYS}-day wait` : `${x.quiet}d quiet` }));
return { priority, recent, offAll, done, remaining: Math.max(0, OFFBOARD_PER_DAY - done) };
}

function chatLinkHtml(c) {
const t = chatTarget(c);
return t.url
? `<a class="overview-chip dq-chat" href="${escapeHtml(t.url)}" target="_blank" rel="noopener noreferrer" title="Opens the ${escapeHtml(t.label)} chat in a new tab (you need to be signed in)">${escapeHtml(t.label)} chat &#8599;</a>`
: `<span class="settings-note dq-nochat" style="margin:0;">no chat link: ${escapeHtml(t.why)}</span>`;
}

function stageSelect(c) {
return `<select class="mini" data-dq-stage="${c.id}" title="Change stage">${CONN_STAGES.map((s) => `<option${s === c.stage ? ' selected' : ''}>${escapeHtml(s)}</option>`).join('')}</select>`;
}
function prioSelect(c) {
return `<select class="mini" data-dq-prio="${c.id}" title="Change priority (1 low, 5 high)">${[1, 2, 3, 4, 5].map((n) => `<option value="${n}"${n === (c.priority || 3) ? ' selected' : ''}>P${n}</option>`).join('')}</select>`;
}

function actionRowHtml(c) {
return `${chatLinkHtml(c)}
<button type="button" class="overview-chip" data-dq-act="sent" data-id="${c.id}" title="You messaged them. Marks contacted today.">Sent</button>
<button type="button" class="overview-chip" data-dq-act="sent14" data-id="${c.id}" title="Marks contacted and waits ${CHASE_DAYS} days. No answer by then and they move to the offboard bucket.">Sent + ${CHASE_DAYS}d</button>
<button type="button" class="planner-priority-btn${c.priorityFlag ? ' active' : ''}" data-dq-act="pin" data-id="${c.id}" title="${c.priorityFlag ? 'Priority for the Planner, click to unset' : 'Mark as a priority for the Planner tab'}">&#128204;</button>
${prioSelect(c)}${stageSelect(c)}`;
}

function offboardActionsHtml(c) {
return `${chatLinkHtml(c)}
<button type="button" class="overview-chip" data-dq-act="faded" data-id="${c.id}">Faded</button>
<button type="button" class="overview-chip" data-dq-act="archived" data-id="${c.id}">Archived</button>
<button type="button" class="overview-chip" data-dq-act="keep" data-id="${c.id}" title="Keep them and hide from this list for 30 days">Keep 30d</button>`;
}

function rowHtml(item, actionsHtml) {
const c = item.c;
return `<div class="dq-row" data-dq-row="${c.id}">
<div class="dq-who">${connectionChipHtml(c)}<span class="settings-note dq-note">${escapeHtml(c.stage)} &middot; ${escapeHtml(item.note)}</span></div>
<div class="dq-actions">${actionsHtml}</div>
</div>`;
}

function sectionHtml(title, hint, items, actions, extraHead = '') {
const shown = items.slice(0, SHOW_CAP);
const more = items.length - shown.length;
return `<div class="dq-section">
<div class="dq-head"><strong>${escapeHtml(title)}</strong><span class="count-badge">${items.length}</span>${extraHead}</div>
<p class="settings-note dq-hint">${hint}</p>
${shown.length ? shown.map((i) => rowHtml(i, actions(i.c))).join('') : '<div class="nudge-empty">Nothing here right now.</div>'}
${more > 0 ? `<p class="settings-note">+${more} more, shown as these are cleared.</p>` : ''}
</div>`;
}

function renderDayQueue() {
const host = document.getElementById('day-queue-content');
if (!host) return;
const b = buckets();
const waiting = data.connections.filter((c) => activeFor(c) && chasing(c)).length;
const offShown = b.offAll.slice(0, b.remaining);
const offHead = `<span class="settings-note" style="margin:0;">${b.done} of ${OFFBOARD_PER_DAY} done today</span>${b.remaining === 0 && b.offAll.length ? ' <button type="button" class="overview-chip" data-dq-act="more">5 more</button>' : ''}`;
const offHint = b.remaining === 0
? (b.offAll.length ? `Today's ${OFFBOARD_PER_DAY} are done. ${b.offAll.length} still waiting for another day.` : 'No one left to offboard.')
: `Oldest or expired-timer first. Faded and Archived are hidden from the Connections list.`;
const offHtml = `<div class="dq-section">
<div class="dq-head"><strong>Offboard</strong><span class="count-badge">${b.offAll.length}</span>${offHead}</div>
<p class="settings-note dq-hint">${offHint}</p>
${offShown.map((i) => rowHtml(i, offboardActionsHtml(i.c))).join('')}
</div>`;
host.innerHTML = `
${sectionHtml('Priority', 'Pinned or far-along people past their reach-out time. The pin also puts them in the Planner pool.', b.priority, actionRowHtml)}
${sectionHtml('Recent matches', `Matched in the last ${RECENT_DAYS} days and waiting on you: not messaged yet, or their message is last. Based on the last chat read, so it can be a little behind.`, b.recent, actionRowHtml)}
${offHtml}
${waiting ? `<p class="settings-note">${waiting} waiting out a ${CHASE_DAYS}-day timer, not shown.</p>` : ''}`;
// Avatars are placeholders until their photo blobs are filled in.
hydratePhotoBackgrounds(host);
}

function refresh() {
queueSave();
renderDayQueue();
renderConnections();
}

function bumpOffboard() {
const today = todayStr();
if (data.dayQueue.date !== today) data.dayQueue = { date: today, offboarded: 0 };
data.dayQueue.offboarded += 1;
}

function handle(act, id) {
if (act === 'more') {
const today = todayStr();
data.dayQueue = { date: today, offboarded: Math.max(0, (data.dayQueue.date === today ? data.dayQueue.offboarded : 0) - OFFBOARD_PER_DAY) };
return refresh();
}
const c = data.connections.find((x) => x.id === id);
if (!c) return;
if (act === 'sent' || act === 'sent14') {
logContactNow(c.id);
c.sentAt = new Date().toISOString();
c.chaseUntil = act === 'sent14' ? plusDays(CHASE_DAYS) : '';
} else if (act === 'pin') {
c.priorityFlag = !c.priorityFlag;
} else if (act === 'faded' || act === 'archived') {
c.stage = act === 'faded' ? 'Faded' : 'Archived';
c.chaseUntil = '';
bumpOffboard();
} else if (act === 'keep') {
c.attentionSnoozedUntil = plusDays(30);
c.chaseUntil = '';
bumpOffboard();
}
refresh();
}

let bound = false;
function initDayQueue() {
if (bound) return;
bound = true;
bindConnectionChips();
const host = document.getElementById('day-queue-content');
if (!host) return;
host.addEventListener('click', (e) => {
const btn = e.target.closest('[data-dq-act]');
if (btn) handle(btn.dataset.dqAct, btn.dataset.id);
});
host.addEventListener('change', (e) => {
const stageSel = e.target.closest('[data-dq-stage]');
const prioSel = e.target.closest('[data-dq-prio]');
if (stageSel) {
const c = data.connections.find((x) => x.id === stageSel.dataset.dqStage);
if (c) { c.stage = stageSel.value; c.chaseUntil = ''; refresh(); }
} else if (prioSel) {
const c = data.connections.find((x) => x.id === prioSel.dataset.dqPrio);
if (c) { c.priority = parseInt(prioSel.value, 10) || 3; refresh(); }
}
});
renderDayQueue();
}

export { renderDayQueue, initDayQueue };
