// Heating: room temperatures from the Heatmiser neoHub, read-only.
//
// The hub only answers on the LAN, so this asks the home agent
// (heating.live, see home-agent/neohub.py) and waits for its reply, the
// same "leave a note, check back" round trip as every other agent verb.
// Nothing here can change a setpoint: the agent verb only ever reads.
//
// The last reading is kept in localStorage purely so the panel opens with
// numbers instead of a blank while a fresh one is fetched -- a per-device
// convenience, not data the app tracks.
import { run, AgentNotConfiguredError } from '../homeagent.js';
import { escapeHtml } from '../utils.js';

const CACHE_KEY = 'heating.lastReading';
const STALE_MS = 10 * 60 * 1000;
let busy = false;

function readCache() {
try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (e) { return null; }
}
function writeCache(reading) {
try { localStorage.setItem(CACHE_KEY, JSON.stringify(reading)); } catch (e) { /* private mode */ }
}

const fmt = (n) => (n == null ? '–' : `${n.toFixed(1)}°`);

function zoneRowHtml(z) {
const flags = [];
if (z.offline) flags.push('<span class="heat-flag bad">offline</span>');
if (z.standby) flags.push('<span class="heat-flag">standby</span>');
if (z.away) flags.push('<span class="heat-flag">away</span>');
if (z.hold) flags.push('<span class="heat-flag">hold</span>');
const diff = z.actual != null && z.target != null ? z.actual - z.target : 0;
const tone = z.heating ? 'heating' : diff >= 2 ? 'warm' : diff <= -1 ? 'cool' : '';
return `<div class="heat-row ${tone}">
<span class="heat-zone">${escapeHtml(z.zone || 'Zone')}</span>
<span class="heat-flags">${flags.join('')}</span>
${z.heating ? '<span class="heat-on" title="Calling for heat">heating</span>' : ''}
<span class="heat-actual">${fmt(z.actual)}</span>
<span class="heat-target" title="Target">→ ${fmt(z.target)}</span>
</div>`;
}

function render(reading, statusText, statusClass = '') {
const list = document.getElementById('heating-list');
const status = document.getElementById('heating-status');
const count = document.getElementById('heating-count');
if (!list || !status) return;
const zones = (reading && reading.zones) || [];
list.innerHTML = zones.length
? zones.map(zoneRowHtml).join('')
: '<div class="empty">No reading yet.</div>';
if (count) count.textContent = zones.length ? String(zones.length) : '';
const at = reading && reading.fetchedAt
? new Date(reading.fetchedAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
: null;
status.textContent = statusText || (at ? `Read ${at}` : '');
status.className = `sync-status ${statusClass}`.trim();
}

async function refreshHeating() {
if (busy) return;
busy = true;
const cached = readCache();
render(cached, 'Asking the home agent…', 'busy');
try {
const result = await run('heating.live', {}, { timeoutMs: 30000 });
const reading = { zones: result.zones || [], fetchedAt: Date.now() };
writeCache(reading);
render(reading);
} catch (err) {
const msg = err instanceof AgentNotConfiguredError
? err.message
: `Couldn't read the heating: ${err.message}`;
render(cached, msg, 'zero');
} finally {
busy = false;
}
}

function initHeating() {
const btn = document.getElementById('heating-refresh-btn');
if (!btn) return;
btn.addEventListener('click', refreshHeating);
const cached = readCache();
render(cached);
// Fetch on open only when the last reading is old, so reloading the page
// doesn't queue a command every time.
if (!cached || Date.now() - (cached.fetchedAt || 0) > STALE_MS) refreshHeating();
}

export { initHeating, refreshHeating };
