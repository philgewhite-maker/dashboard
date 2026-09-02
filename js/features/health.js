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
import { escapeHtml, todayStr } from '../utils.js';
import { parseHealthPayloads } from './healthparse.js';
import { tieredRowsForDisplay, flattenHealthDailyRow, isFullHistoryMode, setFullHistoryMode, isPeriodRow, periodLabel } from './healthrollup.js';
import { HEALTH_METRICS, metricByKey, createHealthChart, isoDaysAgo } from './healthchart.js';

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

// Handles both a raw day (fields directly on it, plus the original nested
// heartRate/oxygenSaturation/sleepStages/exerciseSessions detail) and an
// aggregated period row (only the flat numeric averages under .metrics --
// the aggregator only ever averages numbers, so per-stage/per-session
// detail is naturally unavailable once folded into a period, same as it's
// unavailable for any average).
function healthRowHtml(r) {
const period = isPeriodRow(r);
const get = (key) => (period ? r.metrics[key] : r[key]);
// Three separate columns rather than one "avg (min–max)" cell -- min and
// max are now flattened the same way avg always was (see
// flattenHealthDailyRow), so a period row shows a real, if averaged,
// figure in all three rather than leaving two of them blank.
const heartRateMin = get('heartRateMin');
const heartRateAvg = get('heartRateAvg');
const heartRateMax = get('heartRateMax');
const hrMinCell = heartRateMin == null ? '—' : Math.round(heartRateMin);
const hrAvgCell = heartRateAvg == null ? '—' : Math.round(heartRateAvg);
const hrMaxCell = heartRateMax == null ? '—' : Math.round(heartRateMax);
const o2Avg = get('oxygenSaturationAvg');
const o2 = o2Avg != null ? `${Math.round(o2Avg)}%` : '—';
const sleepMinutes = get('sleepMinutes') || 0;
const sleepDetail = (!period && r.sleepMinutes)
? Object.entries(r.sleepStages || {}).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${formatMinutes(v)}`).join(', ')
: '';
const exerciseDetail = (!period && r.exerciseSessions && r.exerciseSessions.length)
? r.exerciseSessions.map((s) => `${escapeHtml(s.label)} (${formatMinutes(s.minutes)})`).join(', ')
: (get('exerciseMinutes') ? formatMinutes(get('exerciseMinutes')) : '—');
const steps = get('steps');
const totalCalories = get('totalCalories');
const weightKg = get('weightKg');
const bodyFatPct = get('bodyFatPct');
const label = period ? periodLabel(r) : formatDate(r.date);
return `<tr${period ? ' class="health-row-summary"' : ''}>
<td>${escapeHtml(label)}</td>
<td>${steps ? Math.round(steps).toLocaleString() : '—'}</td>
<td>${formatKm(get('distanceMeters'))}</td>
<td>${totalCalories ? Math.round(totalCalories).toLocaleString() : '—'}</td>
<td>${exerciseDetail}</td>
<td title="${escapeHtml(sleepDetail)}">${formatMinutes(sleepMinutes)}</td>
<td>${hrMinCell}</td>
<td>${hrAvgCell}</td>
<td>${hrMaxCell}</td>
<td>${o2}</td>
<td>${weightKg != null ? `${weightKg}kg` : '—'}</td>
<td>${bodyFatPct != null ? `${bodyFatPct}%` : '—'}</td>
</tr>`;
}

function renderHealthDaily() {
const el = document.getElementById('health-daily-body');
if (!el) return;
if (!data.healthDaily.length) {
el.innerHTML = '<tr><td colspan="12" class="empty">Nothing parsed yet — click "Sync &amp; parse" once the bridge app has sent at least one sync.</td></tr>';
renderHealthChart();
return;
}
const flat = data.healthDaily.map(flattenHealthDailyRow);
if (isFullHistoryMode()) {
el.innerHTML = flat.map(healthRowHtml).join('');
} else {
const { daily, monthly, quarterly, annual } = tieredRowsForDisplay(flat, todayStr());
el.innerHTML = [...daily, ...monthly, ...quarterly, ...annual].map(healthRowHtml).join('');
}
renderHealthChart();
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

// One toggle switches all three Health tab tables (this one, plus renpho.js
// and wellness.js's own) between the tiered summary and the full raw
// history -- see isFullHistoryMode's own comment in healthrollup.js for why
// it's one shared flag rather than three.
function initHealthHistoryToggle() {
const toggle = document.getElementById('health-history-toggle');
if (!toggle) return;
toggle.checked = isFullHistoryMode();
toggle.addEventListener('change', async () => {
setFullHistoryMode(toggle.checked);
renderHealthDaily();
const [{ renderRenphoDaily }, { renderWellnessDaily }] = await Promise.all([
import('./renpho.js'), import('./wellness.js'),
]);
renderRenphoDaily();
renderWellnessDaily();
});
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
initHealthHistoryToggle();
renderHealthDaily();
}

// ---- Trends chart ----
//
// One chart, any number of overlaid metrics spanning all three sources --
// see healthchart.js's own header for the axis/scaling design. `chart` is
// null until initHealthChart() runs (the canvas only exists once the Health
// tab's markup is in the DOM), so renderHealthChart() is a safe no-op
// before then -- called from renderHealthDaily() above (and, symmetrically,
// from renpho.js/wellness.js's own render functions) so the chart always
// reflects whichever table last changed, with no separate refresh wiring
// needed at each data-mutation call site.
let chart = null;
let selectedMetricKeys = [];

const RANGE_PRESETS = [
{ label: '1M', days: 31 },
{ label: '3M', days: 92 },
{ label: '6M', days: 183 },
{ label: '1Y', days: 365 },
{ label: '5Y', days: 365 * 5 },
{ label: 'All', days: null },
];

function chartRowsForSource(source) {
if (source === 'health') return data.healthDaily.map(flattenHealthDailyRow);
if (source === 'renpho') return data.renphoDaily;
if (source === 'wellness') return data.wellnessDaily;
return [];
}

function earliestDataDate() {
const dates = [...data.healthDaily, ...data.renphoDaily, ...data.wellnessDaily].map((d) => d.date).filter(Boolean);
return dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : isoDaysAgo(todayStr(), 365);
}

function legendHtml() {
if (!selectedMetricKeys.length) {
return '<span class="settings-note" style="margin:0;">No metrics selected — add one below.</span>';
}
return selectedMetricKeys.map((key) => {
const m = metricByKey(key);
if (!m) return '';
return `<span class="chart-legend-chip"><span class="chart-legend-swatch" style="background:var(${m.colorVar})"></span>${escapeHtml(m.label)}<button type="button" class="chart-legend-remove" data-chart-remove-metric="${key}" title="Remove from chart">&times;</button></span>`;
}).join('');
}

function pickerHtml() {
return HEALTH_METRICS.filter((m) => !selectedMetricKeys.includes(m.key)).map((m) => `<button type="button" class="todo-add-btn" data-chart-add-metric="${m.key}">+ ${escapeHtml(m.label)}</button>`).join('');
}

function rangeControlsHtml() {
const active = chart ? chart.getRange() : null;
return RANGE_PRESETS.map((p) => `<button type="button" class="todo-add-btn" data-chart-range="${p.days == null ? 'all' : p.days}">${p.label}</button>`).join('')
+ (active ? '<button type="button" class="todo-add-btn" data-chart-reset-zoom>Reset zoom</button>' : '');
}

function renderChartControls() {
const legendEl = document.getElementById('health-chart-legend');
const pickerEl = document.getElementById('health-chart-picker');
const rangeEl = document.getElementById('health-chart-range');
if (legendEl) legendEl.innerHTML = legendHtml();
if (pickerEl) pickerEl.innerHTML = pickerHtml();
if (rangeEl) rangeEl.innerHTML = rangeControlsHtml();
}

function applyRangePreset(days) {
if (!chart) return;
const end = todayStr();
chart.setRange({ start: days == null ? earliestDataDate() : isoDaysAgo(end, days), end });
renderChartControls();
}

// Delegated click handling on the whole controls container -- the legend/
// picker/range buttons all get rebuilt on every selection change (they're
// small, cheap HTML strings), so one listener here avoids re-binding after
// every rebuild, same reasoning travel.js/captureinbox.js use root-level
// delegation for their own repeatedly-rebuilt lists.
function initHealthChartControls() {
const root = document.getElementById('health-chart-controls');
if (!root || !chart) return;
root.addEventListener('click', (e) => {
const add = e.target.closest('[data-chart-add-metric]');
if (add) { selectedMetricKeys.push(add.dataset.chartAddMetric); chart.setMetrics(selectedMetricKeys); renderChartControls(); return; }
const remove = e.target.closest('[data-chart-remove-metric]');
if (remove) { selectedMetricKeys = selectedMetricKeys.filter((k) => k !== remove.dataset.chartRemoveMetric); chart.setMetrics(selectedMetricKeys); renderChartControls(); return; }
const rangeBtn = e.target.closest('[data-chart-range]');
if (rangeBtn) { applyRangePreset(rangeBtn.dataset.chartRange === 'all' ? null : Number(rangeBtn.dataset.chartRange)); return; }
if (e.target.closest('[data-chart-reset-zoom]')) { chart.resetZoom(); renderChartControls(); }
});
}

function initHealthChart() {
const canvas = document.getElementById('health-chart');
if (!canvas) return;
chart = createHealthChart(canvas, {
getRows: chartRowsForSource,
onRangeChange: renderChartControls,
});
// Weight + HRV as a default pairing -- the example given when this chart
// was requested, and a sensible first thing to look at either way.
selectedMetricKeys = ['health.weightKg', 'wellness.hrvMs'].filter((k) => metricByKey(k));
chart.setMetrics(selectedMetricKeys);
initHealthChartControls();
renderChartControls();
}

function renderHealthChart() {
if (chart) chart.render();
}

export {
initHealthSync, fetchHealthEntries, initHealthDaily, renderHealthDaily, parseAndStoreHealthData,
initHealthChart, renderHealthChart,
};
