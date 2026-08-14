// Health Connect data, via a bridge app on your phone (e.g. "HC Webhook")
// posting to server/health.php rather than this app reading Health Connect
// directly — a browser page has no way to do that at all, native-only API,
// see the "Health data" README section for why.
//
// This is deliberately just a raw viewer for now, not a parser: the real
// shape of what the bridge app posts is unverified, so rather than guess at
// field names, this shows exactly what arrived. Once a real payload is seen,
// the actual parsing into Habits/Goals happens as a follow-up, the same
// build-then-verify-then-parse order as every other import built tonight.
import { getConfig } from '../sync/selfhost.js';
import { escapeHtml } from '../utils.js';

const REQUEST_TIMEOUT_MS = 15000;

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

export { initHealthSync, fetchHealthEntries };
