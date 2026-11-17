// Heating: room temperatures from the Heatmiser neoHub, and (agent 1.19+) a
// few controls per zone: standby on/off and a timed boost/hold with cancel.
//
// The hub only answers on the LAN, so this asks the home agent
// (heating.live / heating.standby / heating.hold / heating.cancelHold, see
// home-agent/neohub.py) and waits for its reply, the same "leave a note,
// check back" round trip as every other agent verb. Every change goes
// through an inline confirm row first, and the agent re-reads the hub
// afterwards so this can say "Done" or that the hub still shows something else.
//
// The last SUCCESSFUL reading lives in the synced document as
// data.heatingReading = {fetchedAt, zones}, so any device (and the ticker's
// alerts) sees it, not just the one that opened this panel. A failed refresh
// never touches it: the panel keeps showing it, dated, under the error.
import { run, AgentNotConfiguredError } from '../homeagent.js';
import { getConfig } from '../sync/selfhost.js';
import { data, queueSave, onDataChange } from '../state.js';
import { escapeHtml } from '../utils.js';

// Ticker alert thresholds (degrees C). See heatingAlerts().
const HEAT_LOW_C = 18; // any zone colder than this
const HEAT_HIGH_WHILE_HEATING_C = 25; // warmer than this while the zone is calling for heat
const HEAT_HIGH_C = 28; // warmer than this, whatever the heating is doing

// Refresh cadence and freshness limits.
const AUTO_REFRESH_MS = 15 * 60 * 1000; // while the app is open and visible
const OPEN_REFRESH_MS = 10 * 60 * 1000; // refresh when the panel opens if older than this
const STALE_MS = 30 * 60 * 1000; // panel readings shown muted beyond this
const ALERT_AS_OF_MS = 2 * 60 * 60 * 1000; // alerts from an older reading say "(as of HH:MM)"
const ALERT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // ...and are dropped entirely beyond this

let busy = false; // one refresh at a time, manual or automatic
let lastAttemptAt = 0; // an automatic retry waits a full interval after a failure too
let lastError = null; // {message} of the most recent failed refresh, for the status line
let lastAlertSig = '';

const clock = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const dayClock = (ms) => new Date(ms).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const fmt = (n) => (n == null ? '–' : `${n.toFixed(1)}°`);

function currentReading() {
const r = data.heatingReading;
return r && Array.isArray(r.zones) && r.fetchedAt ? r : null;
}
const ageOf = (r) => (r ? Date.now() - r.fetchedAt : Infinity);

// Alerts for the ticker, from a reading. Pure: pass `now` to test it.
//   cold          actual < HEAT_LOW_C            (every zone, standby/away included: the alert is on the
//                                                 room's actual temperature, e.g. a window left open; the
//                                                 frost setpoint is only the hub's backstop)
//   hot           actual > HEAT_HIGH_C
//   hot+heating   actual > HEAT_HIGH_WHILE_HEATING_C while heating is on
// One alert per zone, the 28 C one winning over the 25 C one. Offline zones
// and zones with no temperature are skipped. A reading older than
// ALERT_AS_OF_MS gets asOf set ("as of 04:12"); older than ALERT_MAX_AGE_MS
// gives no alerts at all.
function heatingAlerts(reading, now = Date.now()) {
if (!reading || !Array.isArray(reading.zones) || !reading.fetchedAt) return [];
const age = now - reading.fetchedAt;
if (age > ALERT_MAX_AGE_MS) return [];
const asOf = age > ALERT_AS_OF_MS
? (new Date(reading.fetchedAt).toDateString() === new Date(now).toDateString() ? clock(reading.fetchedAt) : dayClock(reading.fetchedAt))
: '';
const out = [];
reading.zones.forEach((z, i) => {
const t = z && typeof z.actual === 'number' && Number.isFinite(z.actual) ? z.actual : null;
if (t == null || z.offline) return;
let kind = '';
if (t > HEAT_HIGH_C) kind = 'hot';
else if (t > HEAT_HIGH_WHILE_HEATING_C && z.heating) kind = 'hot-heating';
else if (t < HEAT_LOW_C) kind = 'cold';
if (!kind) return;
const zone = z.zone || 'Zone';
const word = kind === 'cold' ? 'below 18°' : kind === 'hot' ? 'above 28°' : 'above 25° and heating';
out.push({ id: `heat-${i}-${kind}`, kind, zone, temp: t, asOf, text: `${zone} ${t.toFixed(1)}°, ${word}${asOf ? ` (as of ${asOf})` : ''}` });
});
return out;
}

// The agent's own errors are written for a console reader; this panel needs
// a few words.
function shortReason(err) {
const m = (err && err.message) || String(err);
if (/hadn't finished/i.test(m)) return 'the home agent was busy — try again shortly';
if (/never picked that up/i.test(m)) return "the home agent didn't respond";
if (/command server didn't respond|Couldn't reach the command queue/i.test(m)) return "couldn't reach the command server";
const first = m.split(/(?<=[.!?])\s|\s[—–-]{1,2}\s/)[0].trim();
return first.length > 90 ? `${first.slice(0, 87)}…` : first;
}

const FLAME = '<svg class="heat-flame" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" role="img" aria-label="Calling for heat"><title>Calling for heat</title><path d="M12.6 2.2c.3 2.6-.7 4.2-2.2 5.9C8.7 9.9 7 11.8 7 14.7 7 18.2 9.2 21 12.2 21s5.3-2.4 5.3-5.6c0-2.1-1-3.6-2-4.8-.3 1.3-.9 2.1-1.8 2.5.5-3.9-.1-8.2-1.1-10.9Z"/></svg>';

// Per-zone control state, kept outside the DOM because the list is rebuilt
// every minute and on every synced change:
//   zoneUi[name] = {mode: null | 'boost' | 'confirm', action, temp, minutes,
//                   pending, msg, msgCls}
const zoneUi = {};
const uiOf = (name) => (zoneUi[name] ||= { mode: null, pending: false, msg: '', msgCls: '' });
const BOOST_TEMPS = Array.from({ length: 19 }, (_, i) => 16 + i * 0.5); // 16 .. 25
const BOOST_MINUTES = [[30, '30 min'], [60, '1 h'], [120, '2 h'], [180, '3 h']];
const minutesLabel = (m) => (BOOST_MINUTES.find((b) => b[0] === m) || [0, `${m} min`])[1];
const degLabel = (t) => `${Number.isInteger(t) ? t : t.toFixed(1)}°`;

function defaultBoostTemp(z) {
if (z.standby || z.target == null) return 21;
return Math.min(25, Math.max(16, Math.round((z.target + 1) * 2) / 2));
}

// "0:58" from the hub -> "58 min left". Anything unparseable -> ''.
function holdLeft(holdTime) {
const m = /^(\d+):(\d{2})/.exec(String(holdTime || ''));
if (!m) return '';
const mins = Number(m[1]) * 60 + Number(m[2]);
if (!mins) return '';
return mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60 ? `${mins % 60} min ` : ''}left` : `${mins} min left`;
}

function confirmText(name, ui) {
if (ui.action === 'on') return `Switch ${name} on?`;
if (ui.action === 'off') return `Switch ${name} off?`;
if (ui.action === 'hold') return `Hold ${name} at ${degLabel(ui.temp)} for ${minutesLabel(ui.minutes)}?`;
return `Cancel the boost on ${name}?`;
}

function controlsHtml(z) {
const name = z.zone || '';
const ui = uiOf(name);
const zAttr = escapeHtml(name);
const off = z.offline || !name;
const lock = off || ui.pending ? ' disabled' : '';
let html = '';
if (z.hold) {
const left = holdLeft(z.holdTime);
html += `<div class="heat-holdline">Boost to ${degLabel(z.holdTemp != null ? z.holdTemp : z.target)}${left ? ` · ${left}` : ''}</div>`;
}
if (ui.pending) {
html += '<div class="heat-ctl"><span class="sync-status busy">Sending…</span></div>';
} else if (ui.mode === 'confirm') {
html += `<div class="heat-ctl heat-confirm"><span>${escapeHtml(confirmText(name, ui))}</span>
<button class="sync-btn sm inline" type="button" data-heat="yes" data-zone="${zAttr}">Yes</button>
<button class="sync-btn sm inline" type="button" data-heat="no" data-zone="${zAttr}">Cancel</button></div>`;
} else if (ui.mode === 'boost') {
const tOpts = BOOST_TEMPS.map((t) => `<option value="${t}"${t === ui.temp ? ' selected' : ''}>${degLabel(t)}</option>`).join('');
const mOpts = BOOST_MINUTES.map(([m, l]) => `<option value="${m}"${m === ui.minutes ? ' selected' : ''}>${l}</option>`).join('');
html += `<div class="heat-ctl"><label>Hold at <select data-heat-temp data-zone="${zAttr}">${tOpts}</select></label>
<label>for <select data-heat-mins data-zone="${zAttr}">${mOpts}</select></label>
<button class="sync-btn sm inline" type="button" data-heat="boost-go" data-zone="${zAttr}">Next</button>
<button class="sync-btn sm inline" type="button" data-heat="no" data-zone="${zAttr}">Cancel</button></div>`;
} else {
html += `<div class="heat-ctl"><span class="heat-ctl-label">Heating</span>
<button class="sync-btn sm inline" type="button" data-heat="on" data-zone="${zAttr}"${z.standby ? lock : ' disabled'}>On</button>
<button class="sync-btn sm inline" type="button" data-heat="off" data-zone="${zAttr}"${z.standby ? ' disabled' : lock}>Off</button>
<button class="sync-btn sm inline" type="button" data-heat="boost" data-zone="${zAttr}"${lock}>Boost</button>
${z.hold ? `<button class="sync-btn sm inline" type="button" data-heat="cancel-hold" data-zone="${zAttr}"${lock}>Cancel boost</button>` : ''}
${off ? '<span class="heat-ctl-note">offline</span>' : ''}</div>`;
}
if (ui.msg) html += `<div class="heat-msg ${ui.msgCls}" role="status">${escapeHtml(ui.msg)}</div>`;
return html;
}

function zoneRowHtml(z) {
const flags = [];
if (z.offline) flags.push('<span class="heat-flag bad">offline</span>');
if (z.standby) flags.push('<span class="heat-flag">standby</span>');
if (z.away) flags.push('<span class="heat-flag">away</span>');
if (z.hold) flags.push('<span class="heat-flag">hold</span>');
const diff = z.actual != null && z.target != null ? z.actual - z.target : 0;
const tone = z.heating ? 'heating' : diff >= 2 ? 'warm' : diff <= -1 ? 'cool' : '';
return `<div class="heat-item" data-heat-zone="${escapeHtml(z.zone || '')}"><div class="heat-row ${tone}">
<span class="heat-zone">${escapeHtml(z.zone || 'Zone')}</span>
<span class="heat-flags">${flags.join('')}</span>
${z.heating ? `<span class="heat-on">${FLAME}</span>` : ''}
<span class="heat-actual">${fmt(z.actual)}</span>
<span class="heat-target" title="Target">→ ${fmt(z.target)}</span>
</div>${controlsHtml(z)}</div>`;
}

const findZone = (name) => (currentReading() ? currentReading().zones.find((z) => z.zone === name) : null);

// What the hub shows now, for the mismatch message.
function stateWords(z) {
if (!z) return 'nothing for this zone';
return `${z.standby ? 'standby on' : 'standby off'} and ${z.hold ? `a hold at ${degLabel(z.holdTemp != null ? z.holdTemp : z.target)}` : 'no hold'}`;
}

async function applyAction(name) {
const ui = uiOf(name);
const { action, temp, minutes } = ui;
ui.mode = null;
ui.pending = true;
ui.msg = '';
render();
let verb = 'heating.cancelHold';
let args = { zone: name };
// "Off" means standby ON; "On" means standby off (back to its schedule).
if (action === 'on' || action === 'off') { verb = 'heating.standby'; args = { zone: name, on: action === 'off' }; }
if (action === 'hold') { verb = 'heating.hold'; args = { zone: name, temp, minutes }; }
try {
const res = await run(verb, args, { timeoutMs: 45000 });
const r = currentReading();
if (r && res && res.zone) {
const i = r.zones.findIndex((z) => z.zone === name);
if (i >= 0) r.zones[i] = res.zone;
queueSave();
}
if (res && res.matched) {
ui.msg = 'Done';
ui.msgCls = 'ok';
setTimeout(() => { if (ui.msg === 'Done') { ui.msg = ''; render(); } }, 8000);
} else {
ui.msg = `The hub accepted it but still shows ${stateWords(res && res.zone)}.`;
ui.msgCls = 'zero';
}
} catch (err) {
const m = (err && err.message) || String(err);
ui.msg = /doesn't know the verb|Unknown verb/i.test(m)
? 'Agent 1.19 needed to change heating'
: `Couldn't change it: ${err instanceof AgentNotConfiguredError ? 'set up sync in Settings first' : shortReason(err)}`;
ui.msgCls = 'zero';
} finally {
ui.pending = false;
}
render();
notifyAlerts();
}

// One delegated handler for every zone control (the list is rebuilt
// wholesale, so per-button listeners would be lost).
function bindControls(list) {
list.addEventListener('change', (e) => {
const sel = e.target.closest('select[data-zone]');
if (!sel) return;
const ui = uiOf(sel.dataset.zone);
if (sel.hasAttribute('data-heat-temp')) ui.temp = Number(sel.value);
if (sel.hasAttribute('data-heat-mins')) ui.minutes = Number(sel.value);
});
list.addEventListener('click', (e) => {
const btn = e.target.closest('button[data-heat]');
if (!btn) return;
const name = btn.dataset.zone;
const ui = uiOf(name);
if (ui.pending) return;
const kind = btn.dataset.heat;
const z = findZone(name);
if (kind === 'yes') { applyAction(name); return; }
if (kind === 'no') ui.mode = null;
else if (kind === 'boost') { ui.mode = 'boost'; ui.msg = ''; if (!ui.temp) ui.temp = z ? defaultBoostTemp(z) : 21; if (!ui.minutes) ui.minutes = 60; }
else if (kind === 'boost-go') { ui.mode = 'confirm'; ui.action = 'hold'; }
else if (kind === 'on' || kind === 'off' || kind === 'cancel-hold') { ui.mode = 'confirm'; ui.action = kind; ui.msg = ''; }
render();
});
}

function render(statusText, statusClass = '') {
const list = document.getElementById('heating-list');
const status = document.getElementById('heating-status');
const count = document.getElementById('heating-count');
if (!list || !status) return;
const reading = currentReading();
const zones = reading ? reading.zones : [];
// Don't rebuild under a select the user has open (the minute timer would close it).
if (list.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return;
list.innerHTML = zones.length
? zones.map(zoneRowHtml).join('')
: '<div class="empty">No reading yet.</div>';
list.classList.toggle('is-stale', !!reading && ageOf(reading) > STALE_MS);
if (count) count.textContent = zones.length ? String(zones.length) : '';
const at = reading ? dayClock(reading.fetchedAt) : '';
let text = statusText;
let cls = statusClass;
if (text == null) {
if (lastError) {
text = `${at ? `Read ${at} · ` : ''}couldn't refresh: ${lastError.message}`;
cls = 'zero';
} else {
text = at ? `Read ${at}` : '';
}
}
status.textContent = text;
status.className = `sync-status ${cls}`.trim();
}

// Tell the ticker when what it would show has changed (a new reading, here
// or pulled from another device, or a reading ageing past the "as of"
// line). Compared by content, so an unchanged minute never rebuilds the
// strip and restarts its marquee.
function notifyAlerts() {
const sig = JSON.stringify(heatingAlerts(currentReading()).map((a) => [a.id, a.temp, a.asOf]));
if (sig === lastAlertSig) return;
lastAlertSig = sig;
window.dispatchEvent(new CustomEvent('heating-updated'));
}

async function refreshHeating({ auto = false } = {}) {
if (busy) return;
busy = true;
lastAttemptAt = Date.now();
if (!auto) render('Asking the home agent…', 'busy');
try {
const result = await run('heating.live', {}, { timeoutMs: 30000 });
data.heatingReading = { fetchedAt: Date.now(), zones: result.zones || [] };
lastError = null;
queueSave();
} catch (err) {
lastError = { message: err instanceof AgentNotConfiguredError ? 'set up sync in Settings first' : shortReason(err) };
} finally {
busy = false;
}
render();
notifyAlerts();
}

// Automatic refresh: only while the app is visible, only when the home
// agent is configured, never overlapping, and not more often than the
// interval even after a failure.
async function autoRefreshIfDue(maxAgeMs) {
if (busy || document.hidden) return;
if (Date.now() - lastAttemptAt < Math.min(maxAgeMs, AUTO_REFRESH_MS)) return;
if (ageOf(currentReading()) <= maxAgeMs) return;
try { if (!(await getConfig()).configured) return; } catch (e) { return; }
refreshHeating({ auto: true });
}

function initHeating() {
const btn = document.getElementById('heating-refresh-btn');
if (!btn) return;
btn.addEventListener('click', () => refreshHeating());
bindControls(document.getElementById('heating-list'));
render();
lastAlertSig = JSON.stringify(heatingAlerts(currentReading()).map((a) => [a.id, a.temp, a.asOf]));
// A reading synced in from another device updates the panel and the ticker.
onDataChange(() => { render(); notifyAlerts(); });
// On open (after the first document pull, which can replace the reading).
setTimeout(() => autoRefreshIfDue(OPEN_REFRESH_MS), 4000);
// Once a minute: re-age the muted state, refresh when due.
setInterval(() => { render(); notifyAlerts(); autoRefreshIfDue(AUTO_REFRESH_MS); }, 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); autoRefreshIfDue(AUTO_REFRESH_MS); } });
}

export { initHeating, refreshHeating, heatingAlerts, HEAT_LOW_C, HEAT_HIGH_C, HEAT_HIGH_WHILE_HEATING_C };
