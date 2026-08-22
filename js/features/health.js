// Health Connect data, via a bridge app on your phone (e.g. "HC Webhook",
// or the Life Dashboard Companion app) posting to server/health.php rather
// than this app reading Health Connect directly — a browser page has no
// way to do that at all, native-only API, see the "Health data" README
// section for why.
//
// Two things live here: the raw-payload viewer (Settings) that's been here
// since before a real payload had ever been seen, kept as-is for
// inspecting exactly what arrived when something looks wrong; and the real
// parse-and-store pipeline (the Health tab) that turns the server's whole
// log into one row per day via healthparse.js, now that a real payload's
// shape is confirmed.
import { data, queueSave } from '../state.js';
import { getConfig } from '../sync/selfhost.js';
import { escapeHtml } from '../utils.js';
import { parseHealthPayloads } from './healthparse.js';

const REQUEST_TIMEOUT_MS = 15000;
// health.php's own GET cap (server/health.php.example: $DEFAULT_LIMIT is
// 500, but ?limit= is honoured up to this) -- asking for the max every
// parse means the daily rollup is only ever missing data health.php itself
// has already trimmed off the end of its log, not data this app chose not
// to ask for.
const PARSE_FETCH_LIMIT = 2000;

// health.php sits next to sync.php, same reasoning as files.php/
// image-proxy.php/recipe-fetch.php — one URL configured once, every server
// endpoint derived from it rather than entered separately per feature.
async function healthEndpoint() {
const { url, secret, configured } = await getConfig();
if (!configured) throw new Error("Health sync needs live sync set up first — add your sync URL and secret in Settings.");
const endpoint = url.replace(/sync\.php(?=$|\?)/, 'health.php');
if (endpoint === url) {
throw new Error(`Couldn't work out the health-data URL from "${url}" — it should end in sync.php.`);
}
return { endpoint, secret };
}

async function fetchHealthEntries(limit) {
const { endpoint, secret } = await healthEndpoint();
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
let res;
try {
res = await fetch(`${endpoint}?limit=${limit || 20}&secret=${encodeURIComponent(secret)}`, {
headers: { 'X-Sync-Secret': secret },
signal: controller.signal,
});
} catch (networkErr) {
clearTimeout(timer);
if (networkErr.name === 'AbortError') throw new Error(`No reply within ${REQUEST_TIMEOUT_MS / 1000}s — check health.php is uploaded.`);
throw new Error(`Couldn't reach the health endpoint: ${networkErr.message}`);
}
clearTimeout(timer);
if (!res.ok) {
if (res.status === 401) throw new Error('The health endpoint rejected the secret — check health.php uses the same one as sync.php.');
let detail = `HTTP ${res.status}`;
try { detail = (await res.json()).error || detail; } catch (e) { /* not JSON, keep the status */ }
throw new Error(detail);
}
const body = await res.json();
return Array.isArray(body.entries) ? body.entries : [];
}

async function render() {
const el = document.getElementById('health-sync-body');
if (!el) return;
el.innerHTML = '<div class="settings-note" style="margin:0;">Checking…</div>';
try {
const entries = await fetchHealthEntries(20);
if (entries.length === 0) {
el.innerHTML = '<div class="settings-note" style="margin:0;">Nothing received yet — once the bridge app on your phone is configured and sends its first sync, it\'ll show up here.</div>';
return;
}
const latest = entries[0];
el.innerHTML = `<div class="settings-note" style="margin:0 0 8px;">${entries.length} recent entr${entries.length === 1 ? 'y' : 'ies'} &mdash; latest received ${escapeHtml(latest.receivedAt || '')}.</div>
<pre style="white-space:pre-wrap;font-size:11px;background:var(--paper);border:1px solid var(--line);border-radius:8px;padding:10px;max-height:300px;overflow:auto;">${escapeHtml(JSON.stringify(entries.slice(0, 5), null, 1))}</pre>`;
} catch (err) {
el.innerHTML = `<div class="settings-note" style="margin:0;color:var(--red,#b5443a);">${escapeHtml(err.message || String(err))}</div>`;
}
}

function initHealthSync() {
const btn = document.getElementById('health-sync-refresh');
if (!btn) return;
btn.addEventListener('click', render);
render();
}

function formatMinutes(mins) {
if (!mins) return '—';
const h = Math.floor(mins / 60), m = Math.round(mins % 60);
return h ? `${h}h ${m}m` : `${m}m`;
}

function formatKm(meters) {
if (!meters) return '—';
return `${(meters / 1000).toFixed(meters >= 10000 ? 0 : 1)}km`;
}

function formatDate(iso) {
const d = new Date(`${iso}T00:00:00`);
return isNaN(d) ? iso : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

function dayRowHtml(d) {
const hr = d.heartRate ? `${d.heartRate.avg} <span class="settings-note" style="display:inline;">(${d.heartRate.min}–${d.heartRate.max})</span>` : '—';
const o2 = d.oxygenSaturation ? `${d.oxygenSaturation.avg}%` : '—';
const sleepDetail = d.sleepMinutes
? `${Object.entries(d.sleepStages).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${formatMinutes(v)}`).join(', ')}`
: '';
const exerciseDetail = d.exerciseSessions.length
? d.exerciseSessions.map((s) => `${escapeHtml(s.label)} (${formatMinutes(s.minutes)})`).join(', ')
: '—';
return `<tr>
<td>${escapeHtml(formatDate(d.date))}</td>
<td>${d.steps ? d.steps.toLocaleString() : '—'}</td>
<td title="${escapeHtml(sleepDetail)}">${formatMinutes(d.sleepMinutes)}</td>
<td>${hr}</td>
<td>${o2}</td>
<td>${formatKm(d.distanceMeters)}</td>
<td>${d.totalCalories ? d.totalCalories.toLocaleString() : '—'}</td>
<td>${d.weightKg != null ? `${d.weightKg}kg` : '—'}</td>
<td>${d.bodyFatPct != null ? `${d.bodyFatPct}%` : '—'}</td>
<td>${exerciseDetail}</td>
</tr>`;
}

function renderHealthDaily() {
const el = document.getElementById('health-daily-body');
if (!el) return;
if (!data.healthDaily.length) {
el.innerHTML = '<tr><td colspan="10" class="empty">Nothing parsed yet — click "Sync &amp; parse" once the bridge app has sent at least one sync.</td></tr>';
return;
}
el.innerHTML = data.healthDaily.map(dayRowHtml).join('');
}

// The one place a sync fetch turns into data.healthDaily. Fully re-fetches
// and re-derives every time (see healthparse.js's own header comment on
// why that's simpler and safer than incremental merging) rather than only
// pulling what's new since the last parse.
async function parseAndStoreHealthData(statusEl) {
if (statusEl) statusEl.textContent = 'Fetching…';
const entries = await fetchHealthEntries(PARSE_FETCH_LIMIT);
data.healthDaily = parseHealthPayloads(entries);
queueSave();
renderHealthDaily();
const msg = data.healthDaily.length
? `Parsed ${entries.length} synced entr${entries.length === 1 ? 'y' : 'ies'} into ${data.healthDaily.length} day${data.healthDaily.length === 1 ? '' : 's'}.`
: 'Nothing to parse yet.';
if (statusEl) statusEl.textContent = msg;
return { entryCount: entries.length, dayCount: data.healthDaily.length };
}

function initHealthDaily() {
const btn = document.getElementById('health-parse-btn');
const status = document.getElementById('health-parse-status');
if (btn) {
btn.addEventListener('click', async () => {
try {
await parseAndStoreHealthData(status);
} catch (err) {
if (status) status.textContent = err.message || String(err);
}
});
}
renderHealthDaily();
}

export { initHealthSync, fetchHealthEntries, initHealthDaily, renderHealthDaily, parseAndStoreHealthData };
