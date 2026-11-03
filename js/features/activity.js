// The Activity tray: one place that says what is running, how long it has
// taken and is likely to take, whether you can leave this tab, how it ended
// (done / nothing new / failed) and WHERE the result was posted, with a real
// link when that is somewhere other than the panel you are looking at.
//
// Replaces the private "Checking… / Synced just now." text each feature kept
// for itself, which could not tell "finished with nothing" from "died", never
// said where results landed, and was wiped whenever a sync re-rendered the page.
//
//   const t = track({ id: 'loyalty-scan', label: 'Loyalty check', hint: '1-3 min',
//                     leave: 'continues', mirror: 'loyalty-scan-status' });
//   t.step(2, 15, 'Checking BA Club…');
//   t.done({ detail: '3 readings', where: [{ tab: 'finances', target: '#loyalty-balances-panel', label: 'Loyalty' }] });
//   t.zero('Nothing new in 14 emails');   t.fail(err);
//
// `leave`: 'continues' = keeps running if you switch tabs (panels stay mounted);
// 'stops' = also dies on reload/close, so reloading mid-run warns first.
// `mirror`: id of an existing status element in the originating panel; it gets
// the same text and a .busy/.ok/.zero/.error class (see .sync-status in the CSS).
import { escapeHtml } from '../utils.js';

const DURATIONS_KEY = 'dashboard-activity-durations';
const KEEP_RUNS = 5;
const AUTO_DISMISS_MS = 90000;

const tasks = new Map(); // id -> task
let tray = null;
let ticker = null;

function readDurations() {
try { return JSON.parse(localStorage.getItem(DURATIONS_KEY)) || {}; } catch (e) { return {}; }
}
function writeDuration(id, ms) {
try {
const all = readDurations();
all[id] = [...(all[id] || []), Math.round(ms)].slice(-KEEP_RUNS);
localStorage.setItem(DURATIONS_KEY, JSON.stringify(all));
} catch (e) { /* private window: the tray still works, just without an ETA */ }
}
function expectedMs(id) {
const runs = (readDurations()[id] || []).slice().sort((a, b) => a - b);
return runs.length ? { ms: runs[Math.floor(runs.length / 2)], runs: runs.length } : null;
}

function secs(ms) {
const s = Math.max(0, Math.round(ms / 1000));
if (s < 60) return `${s}s`;
return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

// A link to wherever the result went. Falls back when the target is empty or
// absent right now (e.g. #voucher-review-section is cleared when nothing is
// waiting), so the link always lands somewhere real.
function whereHtml(where) {
if (!where || !where.length) return '';
return where.map((w) => {
const target = (w.target && document.querySelector(w.target)) ? w.target : (w.fallback || w.target || '');
return `<span class="inline-goto-link" data-goto-tab="${escapeHtml(w.tab)}"${target ? ` data-goto-target="${escapeHtml(target)}"` : ''}>${escapeHtml(w.label)} &#8599;</span>`;
}).join(' · ');
}

function ensureTray() {
if (tray && tray.isConnected) return tray;
tray = document.createElement('div');
tray.className = 'activity-tray';
tray.setAttribute('role', 'status');
tray.setAttribute('aria-live', 'polite');
document.body.appendChild(tray);
tray.addEventListener('click', (e) => {
const x = e.target.closest('[data-activity-dismiss]');
if (x) { dismiss(x.dataset.activityDismiss); return; }
const retry = e.target.closest('[data-activity-retry]');
if (retry) {
const t = tasks.get(retry.dataset.activityRetry);
if (t && t.retry) { dismiss(t.id); t.retry(); }
}
});
return tray;
}

function dismiss(id) {
const t = tasks.get(id);
if (t && t.state === 'running') return;
tasks.delete(id);
render();
}

function timingLine(t) {
const elapsed = (t.endedAt || Date.now()) - t.startedAt;
if (t.state !== 'running') return `took ${secs(elapsed)}`;
const exp = expectedMs(t.id);
let tail = '';
if (t.total && t.index > 0) {
const projected = (elapsed / t.index) * t.total;
tail = ` · about ${secs(Math.max(0, projected - elapsed))} left`;
} else if (exp) {
tail = elapsed > exp.ms * 2
? ` · taking longer than usual (usually ~${secs(exp.ms)})`
: ` · about ${secs(Math.max(0, exp.ms - elapsed))} left (from your last ${exp.runs} run${exp.runs === 1 ? '' : 's'})`;
} else if (t.hint) {
tail = ` · first run, usually ${t.hint}`;
}
return `${secs(elapsed)} so far${tail}`;
}

const STATE_LABEL = { running: 'Running', done: 'Done', zero: 'Nothing new', fail: 'Failed' };

// Wording that stays true for the link: results go somewhere while running,
// were posted there when done, and on failure the link is where to fix it.
function whereVerb(t) {
return t.state === 'running' ? 'Results will be posted to' : t.state === 'fail' ? 'Go to' : 'Posted to';
}

function cardHtml(t) {
const pct = t.total ? Math.min(100, Math.round((t.index / t.total) * 100)) : null;
const bar = t.state === 'running'
? `<div class="activity-bar${pct === null ? ' indeterminate' : ''}"><span style="width:${pct === null ? 40 : pct}%"></span></div>`
: '';
const leave = t.state === 'running'
? `<div class="activity-leave">${t.leave === 'stops' ? 'Stops if you reload or close this page.' : 'Safe to switch tabs. Keep this page open.'}</div>`
: '';
const where = whereHtml(t.where);
return `<div class="activity-card ${t.state}" data-activity-card="${escapeHtml(t.id)}">
<div class="activity-head">
<span class="activity-state">${STATE_LABEL[t.state]}</span>
<span class="activity-label">${escapeHtml(t.label)}</span>
${t.state === 'running' ? '' : `<span class="activity-x" data-activity-dismiss="${escapeHtml(t.id)}" title="Dismiss">&times;</span>`}
</div>
${t.message ? `<div class="activity-msg">${t.messageHtml ? t.message : escapeHtml(t.message)}</div>` : ''}
${bar}
<div class="activity-time">${escapeHtml(timingLine(t))}</div>
${leave}
${where ? `<div class="activity-where">${whereVerb(t)} ${where}</div>` : ''}
${t.state === 'fail' && t.retry ? `<button class="sync-btn sm inline" type="button" data-activity-retry="${escapeHtml(t.id)}">Try again</button>` : ''}
</div>`;
}

function mirrorTo(t) {
if (!t.mirror) return;
const el = document.getElementById(t.mirror);
if (!el) return;
el.classList.remove('busy', 'ok', 'zero', 'error');
el.classList.add(t.state === 'running' ? 'busy' : t.state === 'fail' ? 'error' : t.state === 'zero' ? 'zero' : 'ok');
const where = whereHtml(t.where);
el.innerHTML = `${t.messageHtml ? (t.message || '') : escapeHtml(t.message || '')}${where ? ` ${whereVerb(t)} ${where}` : ''}`;
}

function render() {
const root = ensureTray();
const all = [...tasks.values()];
root.innerHTML = all.map(cardHtml).join('');
root.style.display = all.length ? '' : 'none';
all.forEach(mirrorTo);
const anyRunning = all.some((t) => t.state === 'running');
if (anyRunning && !ticker) ticker = setInterval(render, 1000);
if (!anyRunning && ticker) { clearInterval(ticker); ticker = null; }
}

function finish(t, state, message, opts = {}) {
if (t.state !== 'running') return;
t.state = state;
t.endedAt = Date.now();
t.message = message || '';
t.messageHtml = !!opts.html;
if (opts.where) t.where = opts.where;
// Only genuine completions teach the ETA; a failure's duration says nothing about a normal run.
if (state === 'done' || state === 'zero') writeDuration(t.id, t.endedAt - t.startedAt);
// A background run (scheduled on open) that found nothing should not put a
// card in front of you; one that found something or failed still does.
if (state === 'zero' && t.quiet) { tasks.delete(t.id); render(); return; }
render();
if (state !== 'fail') setTimeout(() => { if (tasks.get(t.id) === t) dismiss(t.id); }, AUTO_DISMISS_MS);
}

function track({ id, label, hint = '', leave = 'continues', where = [], mirror = '', retry = null, quiet = false }) {
const t = {
id, label, hint, leave, where, mirror, retry, quiet,
state: 'running', startedAt: Date.now(), endedAt: 0, index: 0, total: 0, message: 'Starting…', messageHtml: false,
};
tasks.set(id, t);
render();
return {
step(i, n, msg) { t.index = i; t.total = n; if (msg) t.message = msg; t.messageHtml = false; render(); },
note(msg) { t.message = msg; t.messageHtml = false; render(); },
done(msg, opts) { finish(t, 'done', msg, opts); },
zero(msg, opts) { finish(t, 'zero', msg, opts); },
fail(err, opts) { finish(t, 'fail', `${(err && err.message) || err || 'Something went wrong.'}`, opts); },
get running() { return t.state === 'running'; },
};
}

// Runs `work(handle)` and guarantees the card never stays "Running": an
// exception becomes a Failed card instead of a stuck button and blank status.
async function runTracked(options, work) {
const handle = track(options);
try {
return await work(handle);
} catch (err) {
console.error(`${options.label} failed:`, err);
handle.fail(err);
return undefined;
} finally {
// A work function that returned without calling done/zero/fail still ends the card.
if (handle.running) handle.done('Finished.');
}
}

function anyRunningStops() {
return [...tasks.values()].some((t) => t.state === 'running' && t.leave === 'stops');
}

function initActivity() {
ensureTray();
render();
window.addEventListener('beforeunload', (e) => {
if (!anyRunningStops()) return;
e.preventDefault();
e.returnValue = '';
});
}

export { track, runTracked, initActivity, whereHtml };
