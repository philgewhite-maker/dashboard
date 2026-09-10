// Lets family members be messaged directly via a Telegram bot ("For trip
// X, does this flight work?"), reply on their own time, and have that
// reply land back here against the record it was about. See
// server/telegram-bot.php.example for the server half of this loop.
//
// A family member is a REAL data.connections record (isFamily: true), not
// a separate registry -- confirmed with the user, since "add them anyway
// as some kind of connection so they can join trips" is exactly how
// trip.people's connectionId link (state.js's blankTrip) already works.
// Reusing `connections` means trip pairing, chip rendering, and every
// other "reference a person" surface in this app works for a family
// member with zero new plumbing -- see connections.js's renderConnections
// and overview.js's own isFamily exclusion, which keep them out of the
// dating-pipeline views this reuse would otherwise clutter.
//
// v1 scope is deliberately just the ask -> reply -> review loop -- a
// reply never auto-applies to a trip/task, and nothing auto-fires a
// follow-up. Both are natural additions once this has been used for
// real; the `context` on every thread is the seam they'd hook into.
import { data, queueSave, blankConnection, blankTelegramThread, getLocalSettings, setLocalSetting } from '../state.js';
import { escapeHtml, scrollAndFlash } from '../utils.js';

function familyConnections() {
return data.connections.filter((c) => c.isFamily);
}

// Only these can actually be messaged -- a family member added but never
// yet linked to a real Telegram chat (see the unclaimed-contact linking
// flow below) has nothing to send to.
function reachableFamilyConnections() {
return familyConnections().filter((c) => c.telegramChatId);
}

// ---- talking to server/telegram-bot.php --------------------------------

async function botConfig() {
const settings = await getLocalSettings();
return {
url: (settings.telegramBotUrl || '').trim(),
// Same secret as Live sync -- see telegram-bot.php.example's own header
// comment for why this is safe to share (it only ever proves "this
// request came from my own signed-in device", same job it already does
// for sync.php/health.php/notion.php).
secret: (settings.syncSecret || '').trim(),
};
}

async function botRequest(method, query, body) {
const { url, secret } = await botConfig();
if (!url || !secret) throw new Error('Set the Telegram bot URL in Settings (Account & sync) first, and make sure your sync secret is entered.');
const res = await fetch(url + (query || ''), {
method,
headers: { 'Content-Type': 'application/json', 'X-Sync-Secret': secret },
body: body === undefined ? undefined : JSON.stringify(body),
});
if (!res.ok) {
let detail = `HTTP ${res.status}`;
try { detail = (await res.json()).error || detail; } catch (e) { /* not JSON, keep the status */ }
throw new Error(detail);
}
return res.json();
}

// Sends `question` to `connectionId` over Telegram and records a new
// 'sent' thread against `context` ({kind:'trip'|'task'|'general', tripId,
// legId, taskId}) so the reply, once it arrives, can be matched back to
// what was actually asked.
async function askQuestion(connectionId, question, context) {
const conn = data.connections.find((c) => c.id === connectionId);
if (!conn || !conn.telegramChatId) throw new Error('That person has no linked Telegram chat yet.');
await botRequest('POST', '?action=send', { chatId: conn.telegramChatId, text: question });
const thread = blankTelegramThread({ connectionId, question, context, status: 'sent' });
data.telegramThreads.push(thread);
queueSave();
return thread;
}

// Absorbs new entries from the bot's append-only inbox log (GET, no
// ?action -- see telegram-bot.php.example). Matches each one's chatId to
// an isFamily connection and attaches it as the reply to that person's
// oldest still-open ('sent') thread; a message from an unrecognized chat
// id is filed under telegramUnclaimed instead of being dropped, since
// that's the only way a chat id is ever learned at all (Telegram never
// exposes a phone number, only whoever DMs the bot first). A message from
// a KNOWN person with no open thread (they messaged out of the blue,
// rather than replying to something asked) still becomes a 'replied'
// thread with no question, so it surfaces in the review queue instead of
// silently vanishing.
async function pollTelegramInbox() {
const { url, secret } = await botConfig();
if (!url || !secret) return; // not configured yet -- nothing to poll
let result;
try {
result = await botRequest('GET', '');
} catch (err) {
console.error('Telegram inbox poll failed:', err);
return;
}
const entries = (result.entries || []).slice().reverse(); // oldest first, so threads attach in the order they were actually sent
const settings = await getLocalSettings();
const lastSeen = settings.telegramInboxLastAt || '';
let changed = false;
let newestSeen = lastSeen;
for (const entry of entries) {
if (!entry || !entry.receivedAt || entry.receivedAt <= lastSeen) continue;
changed = true;
if (entry.receivedAt > newestSeen) newestSeen = entry.receivedAt;
const conn = data.connections.find((c) => c.isFamily && c.telegramChatId === entry.chatId);
if (!conn) {
if (!data.telegramUnclaimed.some((u) => u.chatId === entry.chatId && u.receivedAt === entry.receivedAt)) {
data.telegramUnclaimed.push({ chatId: entry.chatId, fromName: entry.fromName || '', text: entry.text || '', receivedAt: entry.receivedAt });
}
continue;
}
const openThread = data.telegramThreads.find((t) => t.connectionId === conn.id && t.status === 'sent');
if (openThread) {
openThread.replyText = entry.text || '';
openThread.repliedAt = entry.receivedAt;
openThread.status = 'replied';
} else {
data.telegramThreads.push(blankTelegramThread({
connectionId: conn.id, question: '', status: 'replied',
replyText: entry.text || '', repliedAt: entry.receivedAt, sentAt: entry.receivedAt,
}));
}
}
if (changed) {
await setLocalSetting('telegramInboxLastAt', newestSeen);
queueSave();
renderTelegramFamily();
}
}

// ---- rendering -----------------------------------------------------------

function familyMemberRowHtml(c) {
return `<tr>
<td><input type="text" data-telegramfamily-field="name" data-telegramfamily-id="${c.id}" value="${escapeHtml(c.name)}" placeholder="Name"></td>
<td><input type="text" data-telegramfamily-field="telegramUsername" data-telegramfamily-id="${c.id}" value="${escapeHtml(c.telegramUsername)}" placeholder="@username (label only)"></td>
<td>${c.telegramChatId ? '<span class="settings-note" style="margin:0;">Linked &#10003;</span>' : '<span class="settings-note" style="margin:0;">Not linked — see below once they\'ve messaged the bot</span>'}</td>
<td><span class="del-x" style="opacity:1;" data-telegramfamily-remove="${c.id}" title="Remove from Family (keeps their history)">&times;</span></td>
</tr>`;
}

function familyTableHtml() {
const members = familyConnections();
return `<table class="limits-table">
<thead><tr><th>Name</th><th>Telegram username</th><th>Status</th><th></th></tr></thead>
<tbody>${members.length ? members.map(familyMemberRowHtml).join('') : '<tr><td colspan="4" class="settings-note">Nobody added yet.</td></tr>'}</tbody>
</table>
<div class="add-form" id="telegramfamily-add-form" style="margin-top:8px;padding-top:0;border-top:none;">
<input type="text" autocomplete="off" id="telegramfamily-add-name" placeholder="Name">
<button class="add-btn" type="button" id="telegramfamily-add-btn">Add family member</button>
</div>`;
}

function unclaimedHtml() {
if (!data.telegramUnclaimed.length) return '';
const members = familyConnections();
return `<div class="settings-block">
<h3>Unrecognized Telegram contacts</h3>
<div class="settings-note" style="margin:0 0 8px;">Someone has messaged the bot from a chat that isn't linked to anyone yet. Link it to a family member (or add a new one from it) so their replies attach properly.</div>
${data.telegramUnclaimed.map((u, i) => `<div class="alloc-card" style="margin-top:6px;">
<div class="alloc-title">${escapeHtml(u.fromName || 'Unknown')}</div>
<div class="alloc-notes">${escapeHtml(u.text || '')}</div>
<div class="alloc-controls">
<select data-telegramfamily-link-idx="${i}">
<option value="">Link to…</option>
<option value="__new__">+ New family member${u.fromName ? ` (${escapeHtml(u.fromName)})` : ''}</option>
${members.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('')}
</select>
</div>
</div>`).join('')}
</div>`;
}

// Every trip leg and every non-done task, as one flat option list -- kept
// deliberately simple (a plain <select>, not the full searchable
// conn-picker widget) since this list is realistically short.
function contextOptionsHtml() {
let html = '<option value="general|">General question</option>';
data.trips.forEach((t) => {
const label = t.title || t.destinations.join(', ') || 'Trip';
html += `<option value="trip|${t.id}|">${escapeHtml(label)} (whole trip)</option>`;
(t.legs || []).forEach((l) => {
html += `<option value="trip|${t.id}|${l.id}">${escapeHtml(label)} — ${escapeHtml(l.label || l.kind)}</option>`;
});
});
data.tasks.filter((t) => t.bucket !== 'done').forEach((t) => {
html += `<option value="task|${t.id}|">${escapeHtml(t.title || '(untitled task)')}</option>`;
});
return html;
}

// Pre-selects a context option built by the "Ask via Telegram" buttons on
// a trip leg (travel.js) / task (tasks.js) -- see bindGlobalAskButton.
let pendingContextValue = '';

// A one-off status message survives exactly one renderTelegramFamily()
// call -- handleSend sets it, then calls render; render consumes and
// clears it. Without this, the confirm/error text set via textContent
// after a successful send was immediately overwritten by that same
// success handler's own re-render, which rebuilds this span empty
// (confirmed live: "Sent." flashed and vanished before ever painting).
let composerStatusMsg = '';

function composerHtml() {
const people = reachableFamilyConnections();
if (!people.length) {
return '<div class="settings-note">Add a family member below, then have them message the bot once so their chat links — the "Unrecognized Telegram contacts" list above (once they\'ve done that) is how you link it.</div>';
}
const status = composerStatusMsg;
composerStatusMsg = '';
return `<h3>Ask a question</h3>
<select id="telegramfamily-person">${people.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}</select>
<select id="telegramfamily-context" style="margin-top:6px;">${contextOptionsHtml()}</select>
<textarea id="telegramfamily-question" placeholder="e.g. Does this flight work for you?" rows="2" style="width:100%;margin-top:6px;box-sizing:border-box;font-family:'Inter',sans-serif;font-size:13px;border:1px solid var(--line);border-radius:7px;padding:7px 9px;background:var(--paper);color:var(--ink);resize:vertical;"></textarea>
<div class="sync-row" style="margin-top:8px;">
<button class="sync-btn" id="telegramfamily-send" type="button">Send</button>
<span class="sync-status" id="telegramfamily-send-status">${escapeHtml(status)}</span>
</div>`;
}

function threadContextLabel(t) {
const ctx = t.context || {};
if (ctx.kind === 'trip') {
const trip = data.trips.find((x) => x.id === ctx.tripId);
if (!trip) return 'a trip (deleted)';
const label = trip.title || trip.destinations.join(', ') || 'Trip';
if (ctx.legId) {
const leg = trip.legs.find((l) => l.id === ctx.legId);
return leg ? `${label} — ${leg.label || leg.kind}` : label;
}
return label;
}
if (ctx.kind === 'task') {
const task = data.tasks.find((x) => x.id === ctx.taskId);
return task ? task.title : 'a task (deleted)';
}
return 'General';
}

function threadCardHtml(t) {
const conn = data.connections.find((c) => c.id === t.connectionId);
const name = conn ? conn.name : '(deleted)';
return `<div class="alloc-card" data-telegramfamily-thread="${t.id}">
<div class="alloc-title">${escapeHtml(name)} <span class="settings-note" style="margin:0;">&mdash; ${escapeHtml(threadContextLabel(t))}</span></div>
${t.question ? `<div class="alloc-notes">Asked: ${escapeHtml(t.question)}</div>` : '<div class="alloc-notes">(message sent out of the blue, not a reply to a question)</div>'}
<div class="alloc-notes" style="font-weight:500;color:var(--ink);">${escapeHtml(t.replyText)}</div>
<div class="alloc-controls">
<button class="add-btn" type="button" data-telegramfamily-resolve="${t.id}">Mark resolved</button>
</div>
</div>`;
}

function reviewQueueHtml() {
const replied = data.telegramThreads.filter((t) => t.status === 'replied');
const sentCount = data.telegramThreads.filter((t) => t.status === 'sent').length;
return `<h3>Replies to review${replied.length ? ` <span class="count-badge">${replied.length}</span>` : ''}</h3>
${replied.length ? replied.map(threadCardHtml).join('') : '<div class="settings-note">Nothing waiting.</div>'}
${sentCount ? `<div class="settings-note" style="margin-top:8px;">${sentCount} question${sentCount === 1 ? '' : 's'} sent, awaiting reply.</div>` : ''}`;
}

function renderTelegramFamily() {
const el = document.getElementById('telegramfamily-body');
if (!el) return; // tab not in this build's DOM
el.innerHTML = `<div class="settings-block"><h3>Family members</h3>${familyTableHtml()}</div>
${unclaimedHtml()}
<div class="settings-block">${composerHtml()}</div>
<div class="settings-block">${reviewQueueHtml()}</div>`;
const ctxSel = document.getElementById('telegramfamily-context');
if (ctxSel && pendingContextValue) { ctxSel.value = pendingContextValue; pendingContextValue = ''; }
bindTelegramFamilyEvents(el);
}

// ---- event wiring ----

async function handleSend() {
const personSel = document.getElementById('telegramfamily-person');
const status = document.getElementById('telegramfamily-send-status');
const questionEl = document.getElementById('telegramfamily-question');
if (!personSel || !questionEl) return;
const personId = personSel.value;
const question = questionEl.value.trim();
if (!personId || !question) { status.textContent = 'Pick someone and enter a question first.'; return; }
const [kind, a, b] = document.getElementById('telegramfamily-context').value.split('|');
const context = kind === 'trip' ? { kind: 'trip', tripId: a, legId: b || '', taskId: '' }
: kind === 'task' ? { kind: 'task', taskId: a, tripId: '', legId: '' }
: { kind: 'general', tripId: '', legId: '', taskId: '' };
status.textContent = 'Sending…';
try {
await askQuestion(personId, question, context);
composerStatusMsg = 'Sent.';
renderTelegramFamily();
} catch (err) {
composerStatusMsg = err.message || String(err);
console.error('Telegram send failed:', err);
renderTelegramFamily();
}
}

function bindTelegramFamilyEvents(root) {
root.querySelectorAll('[data-telegramfamily-field]').forEach((input) => {
input.addEventListener('change', () => {
const c = data.connections.find((x) => x.id === input.dataset.telegramfamilyId);
if (!c) return;
c[input.dataset.telegramfamilyField] = input.value.trim();
queueSave();
});
});
root.querySelectorAll('[data-telegramfamily-remove]').forEach((btn) => {
btn.addEventListener('click', () => {
if (!confirm("Remove this family member? Trip placements and past questions stay on record, but they can no longer be messaged.")) return;
// Un-flag rather than delete -- keeps trip.people/telegramThreads
// history intact, same "don't destroy history" bias the rest of the
// app already follows (e.g. removePlannerActivity's own comment).
const c = data.connections.find((x) => x.id === btn.dataset.telegramfamilyRemove);
if (c) { c.isFamily = false; c.telegramChatId = ''; }
queueSave();
renderTelegramFamily();
});
});
const addBtn = document.getElementById('telegramfamily-add-btn');
if (addBtn) addBtn.addEventListener('click', () => {
const input = document.getElementById('telegramfamily-add-name');
const name = input.value.trim();
if (!name) return;
data.connections.push(blankConnection({ name, isFamily: true }));
queueSave();
input.value = '';
renderTelegramFamily();
});
root.querySelectorAll('[data-telegramfamily-link-idx]').forEach((sel) => {
sel.addEventListener('change', () => {
if (!sel.value) return;
const idx = parseInt(sel.dataset.telegramfamilyLinkIdx, 10);
const u = data.telegramUnclaimed[idx];
if (!u) return;
let conn;
if (sel.value === '__new__') {
conn = blankConnection({ name: u.fromName || 'New family member', isFamily: true });
data.connections.push(conn);
} else {
conn = data.connections.find((x) => x.id === sel.value);
}
if (conn) conn.telegramChatId = u.chatId;
data.telegramUnclaimed.splice(idx, 1);
queueSave();
renderTelegramFamily();
});
});
const sendBtn = document.getElementById('telegramfamily-send');
if (sendBtn) sendBtn.addEventListener('click', handleSend);
root.querySelectorAll('[data-telegramfamily-resolve]').forEach((btn) => {
btn.addEventListener('click', () => {
const t = data.telegramThreads.find((x) => x.id === btn.dataset.telegramfamilyResolve);
if (!t) return;
t.status = 'resolved';
t.resolvedAt = new Date().toISOString();
queueSave();
renderTelegramFamily();
});
});
}

// One delegated handler for every "Ask via Telegram" button anywhere in
// the app (travel.js's leg cards, tasks.js's task detail) -- same
// bound-once-on-document pattern as connections.js's bindConnectionChips.
// Neither travel.js nor tasks.js imports this file at all: they just
// render the data-ask-telegram-* markup, decoupled the same way
// app.js's global [data-goto-tab] handler works.
let askButtonBound = false;
function bindGlobalAskButton() {
if (askButtonBound) return;
askButtonBound = true;
document.addEventListener('click', (e) => {
const btn = e.target.closest('[data-ask-telegram]');
if (!btn) return;
const kind = btn.dataset.askTelegram;
pendingContextValue = kind === 'trip'
? `trip|${btn.dataset.askTelegramTrip}|${btn.dataset.askTelegramLeg || ''}`
: kind === 'task'
? `task|${btn.dataset.askTelegramTask}|`
: '';
import('../tabs.js').then(({ switchTab }) => {
switchTab('datingadmin');
setTimeout(() => { renderTelegramFamily(); scrollAndFlash('#telegramfamily-panel'); }, 60);
});
});
}

// ---- polling ----

const POLL_MS = 45000;
let pollTimer = null;

function startPolling() {
clearInterval(pollTimer);
pollTimer = setInterval(() => { if (document.visibilityState === 'visible') pollTelegramInbox(); }, POLL_MS);
}

async function initTelegramFamily() {
bindGlobalAskButton();
document.addEventListener('visibilitychange', () => {
if (document.visibilityState === 'visible') pollTelegramInbox();
});
await pollTelegramInbox();
startPolling();
}

export { initTelegramFamily, renderTelegramFamily, askQuestion, pollTelegramInbox };
