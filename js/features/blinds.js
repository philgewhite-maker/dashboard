// Blinds: the Somfy TaHoma's blinds through the home agent (agent 1.21+,
// blinds.list / blinds.command, see home-agent/somfy.py). The box only
// answers on the LAN, so every read and press is the usual "leave a note,
// check back" round trip, a few seconds each way.
//
// Nothing is stored in the synced document: positions change every time
// someone uses a wall switch, so a saved reading would mostly be wrong.
// The panel reads the box when it opens and after every press.
//
// io motors report a position (closure 0 = open .. 100 = closed) and take
// a percentage; RTS motors only listen, so they show "position unknown"
// and get open / my / stop / close only.
import { run, AgentNotConfiguredError } from '../homeagent.js';
import { getConfig } from '../sync/selfhost.js';
import { escapeHtml } from '../utils.js';

const REREAD_AFTER_MS = 25 * 1000; // most blinds finish travelling within this
const OPEN_REFRESH_MS = 5 * 60 * 1000;

let blinds = null; // last list from the agent, or null before the first read
let readAt = 0;
let busy = false;
let lastError = '';
const rowUi = {}; // id -> {pending, msg, msgCls, pos}
const uiOf = (id) => (rowUi[id] ||= { pending: false, msg: '', msgCls: '', pos: null });
let rereadTimer = null;

const clock = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

function shortReason(err) {
const m = (err && err.message) || String(err);
if (err instanceof AgentNotConfiguredError) return 'set up sync in Settings first';
if (/doesn't know the verb|Unknown verb/i.test(m)) return 'the home agent needs updating to 1.21';
if (/not configured|aren't configured/i.test(m)) return 'the home agent has no TaHoma details yet (SOMFY_HOST / SOMFY_TOKEN)';
if (/hadn't finished/i.test(m)) return 'the home agent was busy — try again shortly';
if (/never picked that up/i.test(m)) return "the home agent didn't respond";
const first = m.split(/(?<=[.!?])\s|\s[—–-]{1,2}\s/)[0].trim();
return first.length > 90 ? `${first.slice(0, 87)}…` : first;
}

function positionWords(b) {
if (!b.available) return 'unavailable';
if (b.closure == null) return 'position unknown';
if (b.closure <= 0) return 'open';
if (b.closure >= 100) return 'closed';
return `${100 - Math.round(b.closure)}% open`;
}

function rowHtml(b) {
const ui = uiOf(b.id);
const id = escapeHtml(b.id);
const has = (c) => b.commands.includes(c);
const lock = ui.pending || !b.available ? ' disabled' : '';
const btn = (cmd, label) => (has(cmd) ? `<button class="sync-btn sm inline" type="button" data-blind="${cmd}" data-id="${id}"${lock}>${label}</button>` : '');
const openPct = b.closure == null ? 50 : 100 - Math.round(b.closure);
const pos = ui.pos == null ? openPct : ui.pos;
const slider = has('setClosure')
? `<label class="blind-slide">Open <input type="range" min="0" max="100" step="5" value="${pos}" data-blind-pos data-id="${id}"${lock}> <span class="blind-pct">${pos}%</span></label>
<button class="sync-btn sm inline" type="button" data-blind="set" data-id="${id}"${lock}>Set</button>`
: '';
const meter = b.closure == null ? '' : `<span class="blind-meter" aria-hidden="true"><span style="width:${openPct}%"></span></span>`;
return `<div class="blind-item" data-blind-row="${id}">
<div class="blind-row"><span class="blind-name">${escapeHtml(b.name)}</span>
${b.protocol === 'rts' ? '<span class="heat-flag" title="RTS motors only receive commands, so the position isn\'t known">RTS</span>' : ''}
${meter}<span class="blind-pos${b.available ? '' : ' bad'}">${b.moving ? 'moving' : positionWords(b)}</span></div>
<div class="heat-ctl">${btn('open', 'Open')}${btn('my', 'My')}${btn('stop', 'Stop')}${btn('close', 'Close')}${slider}
${ui.pending ? '<span class="sync-status busy">Sending…</span>' : ''}</div>
${ui.msg ? `<div class="heat-msg ${ui.msgCls}" role="status">${escapeHtml(ui.msg)}</div>` : ''}
</div>`;
}

function render(statusText, statusClass = '') {
const list = document.getElementById('blinds-list');
const status = document.getElementById('blinds-status');
const count = document.getElementById('blinds-count');
if (!list || !status) return;
const a = document.activeElement;
if (a && list.contains(a) && a.type === 'range') return; // don't rebuild under a slider being dragged
list.innerHTML = blinds && blinds.length
? blinds.map(rowHtml).join('')
: `<div class="empty">${blinds ? 'The TaHoma lists no blinds.' : 'Not read yet.'}</div>`;
if (count) count.textContent = blinds && blinds.length ? String(blinds.length) : '';
let text = statusText;
let cls = statusClass;
if (text == null) {
const at = readAt ? `Read ${clock(readAt)}` : '';
text = lastError ? `${at ? `${at} · ` : ''}couldn't refresh: ${lastError}` : at;
cls = lastError ? 'zero' : '';
}
status.textContent = text;
status.className = `sync-status ${cls}`.trim();
}

async function refreshBlinds({ quiet = false } = {}) {
if (busy) return;
busy = true;
if (!quiet) render('Asking the home agent…', 'busy');
try {
const res = await run('blinds.list', {}, { timeoutMs: 30000 });
blinds = Array.isArray(res && res.blinds) ? res.blinds : [];
readAt = Date.now();
lastError = '';
try { localStorage.setItem('dash-blinds-ok', '1'); } catch (e) { /* private mode */ }
} catch (err) {
lastError = shortReason(err);
} finally {
busy = false;
}
render();
}

function scheduleReread() {
clearTimeout(rereadTimer);
rereadTimer = setTimeout(() => refreshBlinds({ quiet: true }), REREAD_AFTER_MS);
}

async function send(id, command, position) {
const ui = uiOf(id);
ui.pending = true;
ui.msg = '';
render();
try {
const args = { id, command };
if (command === 'setClosure') args.position = position;
const res = await run('blinds.command', args, { timeoutMs: 45000 });
if (res && res.blind && blinds) {
const i = blinds.findIndex((b) => b.id === id);
if (i >= 0) blinds[i] = res.blind;
}
ui.msg = command === 'stop' ? 'Stopped' : 'Sent — rereading in a moment';
ui.msgCls = 'ok';
ui.pos = null;
setTimeout(() => { if (ui.msg && ui.msgCls === 'ok') { ui.msg = ''; render(); } }, REREAD_AFTER_MS + 5000);
scheduleReread();
} catch (err) {
ui.msg = `Couldn't send it: ${shortReason(err)}`;
ui.msgCls = 'zero';
} finally {
ui.pending = false;
}
render();
}

function bind(list) {
list.addEventListener('input', (e) => {
const r = e.target.closest('input[data-blind-pos]');
if (!r) return;
uiOf(r.dataset.id).pos = Number(r.value);
const pct = r.parentElement.querySelector('.blind-pct');
if (pct) pct.textContent = `${r.value}%`;
});
list.addEventListener('click', (e) => {
const b = e.target.closest('button[data-blind]');
if (!b) return;
const id = b.dataset.id;
const ui = uiOf(id);
if (ui.pending) return;
const kind = b.dataset.blind;
if (kind === 'set') {
const blind = blinds && blinds.find((x) => x.id === id);
const openPct = ui.pos != null ? ui.pos : blind && blind.closure != null ? 100 - Math.round(blind.closure) : null;
if (openPct == null) return;
send(id, 'setClosure', 100 - openPct);
return;
}
send(id, kind);
});
}

function initBlinds() {
const btn = document.getElementById('blinds-refresh-btn');
const list = document.getElementById('blinds-list');
if (!btn || !list) return;
btn.addEventListener('click', () => refreshBlinds());
bind(list);
render();
const due = async () => {
if (busy || document.hidden || Date.now() - readAt < OPEN_REFRESH_MS) return;
// Only once this device has had one good read, so an agent without blinds
// set up isn't asked on every app open.
try { if (localStorage.getItem('dash-blinds-ok') !== '1') return; } catch (e) { return; }
try { if (!(await getConfig()).configured) return; } catch (e) { return; }
refreshBlinds({ quiet: true });
};
setTimeout(due, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) due(); });
}

export { initBlinds, refreshBlinds };
