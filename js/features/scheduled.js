// Presses the Sync buttons for you.
//
// That is meant literally, and is the reason this file is 150 lines rather
// than a refactor of six others: each task names an existing button, and
// running it dispatches a click. Every sync keeps its own code path, its
// own status line and its own error handling, unchanged -- nothing here
// can make a sync behave differently from how it behaves when you press
// it yourself, because it IS you pressing it. The cost is that a button
// renamed without updating BUTTON_ID here silently stops being scheduled,
// which is what the Settings panel's "never run" line is for.
//
// WHEN THIS RUNS: on app open, and on returning to the tab. Not while the
// app is closed -- for that see js/bgsync.js, which covers the two tasks
// that need no Google sign-in. The split isn't arbitrary: Google's token
// client (js/sync/googleauth.js) issues a ~1 hour access token with no
// refresh token, so Calendar, Mail, Contacts and Google Tasks physically
// cannot run without a signed-in page.
import { data, queueSave } from '../state.js';
import { escapeHtml } from '../utils.js';
import { canAttemptGoogleAction } from '../sync/googleauth.js';

// Long enough that opening the app twice in a morning doesn't re-run
// everything, short enough that once a day is comfortably covered.
const DEFAULT_INTERVAL_HOURS = 6;

const SCHEDULED_TASKS = [
{
id: 'health', label: 'Health data', buttonId: 'health-sync-refresh', needsGoogle: false,
note: 'Re-parses what your phone has already sent to health.php.',
},
{
id: 'airbnb', label: 'Airbnb calendars', buttonId: 'airbnb-sync-btn', needsGoogle: false,
note: 'The ICS feeds always run; the external-booking and cleaner scans need Google.',
},
{
id: 'calendar', label: 'Calendars', buttonId: 'sync-cal-btn', needsGoogle: true,
note: 'Upcoming events for each tracked calendar.',
},
{
id: 'mail', label: 'Mail', buttonId: 'sync-mail-btn', needsGoogle: true,
note: 'Re-runs your configured Gmail searches.',
},
];

function runs() {
if (!data.scheduledRuns || typeof data.scheduledRuns !== 'object') data.scheduledRuns = {};
return data.scheduledRuns;
}

function isEnabled(task) {
const off = data.prefs.scheduledOff || [];
return !off.includes(task.id);
}

function intervalHours() {
const n = Number(data.prefs.scheduledIntervalHours);
return Number.isFinite(n) && n > 0 ? n : DEFAULT_INTERVAL_HOURS;
}

function isDue(task) {
const last = runs()[task.id]?.at;
if (!last) return true;
return Date.now() - new Date(last).getTime() >= intervalHours() * 3600000;
}

// A click is fire-and-forget -- the handler behind it is async and this
// has no handle on its promise. Waiting for the button to come back from
// disabled covers the ones that disable themselves (Airbnb does); for the
// rest this just paces the queue so four syncs don't all hit Google at
// once. Either way the run is recorded as attempted, not as succeeded:
// the truth about whether it worked is in each panel's own status line,
// which is exactly where it already was.
const SETTLE_TIMEOUT_MS = 30000;
function clickAndWait(btn) {
btn.click();
return new Promise((resolve) => {
const started = Date.now();
const check = () => {
if (!btn.disabled || Date.now() - started > SETTLE_TIMEOUT_MS) resolve();
else setTimeout(check, 400);
};
setTimeout(check, 300);
});
}

let running = false;

// `trigger` is recorded so the Settings panel can say whether a task last
// ran because you opened the app or because you pressed Run now -- when a
// scheduled run hasn't happened for days, knowing which is the difference
// between "it's broken" and "you haven't opened the app".
async function runDueTasks(trigger = 'open') {
if (running) return;
running = true;
try {
const signedIn = await canAttemptGoogleAction().catch(() => false);
for (const task of SCHEDULED_TASKS) {
if (!isEnabled(task) || !isDue(task)) continue;
if (task.needsGoogle && !signedIn) continue;
const btn = document.getElementById(task.buttonId);
if (!btn) {
runs()[task.id] = { at: new Date().toISOString(), trigger, skipped: 'no button' };
continue;
}
await clickAndWait(btn);
runs()[task.id] = { at: new Date().toISOString(), trigger };
}
queueSave();
renderScheduled();
} finally {
running = false;
}
}

// ---- Background refresh registration --------------------------------------

// Chrome only grants this to an INSTALLED app, and then decides the cadence
// itself from how much you use it -- roughly daily at best, never on
// demand. So this is a bonus on top of run-on-open, not a replacement for
// it: if it never fires, nothing is lost, the syncs just happen when you
// next open the app.
const PERIODIC_TAG = 'dashboard-refresh';
const PERIODIC_MIN_MS = 12 * 3600000;

async function registerPeriodicSync() {
if (!('serviceWorker' in navigator)) return { ok: false, why: 'no service worker' };
const reg = await navigator.serviceWorker.ready;
if (!reg.periodicSync) return { ok: false, why: 'not supported by this browser' };
try {
const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
if (status.state !== 'granted') return { ok: false, why: `permission ${status.state}` };
await reg.periodicSync.register(PERIODIC_TAG, { minInterval: PERIODIC_MIN_MS });
return { ok: true };
} catch (err) {
return { ok: false, why: err.message || String(err) };
}
}

// ---- Settings panel -------------------------------------------------------

function agoLabel(iso) {
if (!iso) return 'never run';
const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
if (mins < 1) return 'just now';
if (mins < 60) return `${mins} min ago`;
const hours = Math.round(mins / 60);
if (hours < 48) return `${hours}h ago`;
return `${Math.round(hours / 24)}d ago`;
}

function renderScheduled() {
const el = document.getElementById('scheduled-tasks');
if (!el) return;
el.innerHTML = `<table class="limits-table">
<thead><tr><th>Task</th><th>Last run</th><th title="Google-backed syncs can't run in the background at all — the sign-in issues a one-hour token with no way to renew it unattended." style="cursor:help;text-decoration:underline dotted;">Needs sign-in</th><th>On</th></tr></thead>
<tbody>${SCHEDULED_TASKS.map((t) => {
const r = runs()[t.id];
return `<tr>
<td>${escapeHtml(t.label)}<div class="settings-note" style="margin:0;">${escapeHtml(t.note)}</div></td>
<td>${escapeHtml(agoLabel(r?.at))}${r?.skipped ? ` <span class="settings-note" style="display:inline;margin:0;">(${escapeHtml(r.skipped)})</span>` : ''}</td>
<td>${t.needsGoogle ? 'Yes' : 'No'}</td>
<td><input type="checkbox" data-scheduled-toggle="${t.id}" ${isEnabled(t) ? 'checked' : ''}></td>
</tr>`;
}).join('')}</tbody>
</table>
<div class="sync-row" style="margin-top:8px;">
<label style="font-size:12px;">Run at most every
<input type="number" min="1" max="168" id="scheduled-interval" value="${escapeHtml(String(intervalHours()))}" style="width:60px;"> hours</label>
<button class="sync-btn sm" type="button" id="scheduled-run-now">Run due tasks now</button>
<span class="sync-status" id="scheduled-status"></span>
</div>`;

el.querySelectorAll('[data-scheduled-toggle]').forEach((cb) => {
cb.addEventListener('change', () => {
const off = new Set(data.prefs.scheduledOff || []);
if (cb.checked) off.delete(cb.dataset.scheduledToggle);
else off.add(cb.dataset.scheduledToggle);
data.prefs.scheduledOff = [...off];
queueSave();
});
});
const interval = el.querySelector('#scheduled-interval');
if (interval) interval.addEventListener('change', () => {
data.prefs.scheduledIntervalHours = Math.max(1, Number(interval.value) || DEFAULT_INTERVAL_HOURS);
queueSave();
renderScheduled();
});
const runNow = el.querySelector('#scheduled-run-now');
if (runNow) runNow.addEventListener('click', async () => {
const status = document.getElementById('scheduled-status');
if (status) status.textContent = 'Running…';
// "Now" means now: clears the clock so everything enabled runs, rather
// than quietly doing nothing because nothing happens to be due.
SCHEDULED_TASKS.forEach((t) => { if (isEnabled(t)) delete runs()[t.id]; });
await runDueTasks('manual');
const after = document.getElementById('scheduled-status');
if (after) after.textContent = 'Done — see each panel for what it found.';
});
}

function initScheduled() {
renderScheduled();
// Deferred so the first paint, the initial document pull and the Google
// sign-in restore all land first -- a sync fired into a half-loaded app
// would just fail and burn its interval.
setTimeout(() => runDueTasks('open'), 8000);
document.addEventListener('visibilitychange', () => {
if (document.visibilityState === 'visible') runDueTasks('open');
});
registerPeriodicSync();
}

export { initScheduled, renderScheduled, runDueTasks, SCHEDULED_TASKS, registerPeriodicSync };
