// Per-record storage, SHADOW MODE: copies the five core tabs' data
// (js/sync/collections.js) into server/records.php one row per record,
// alongside the whole-document sync, which stays the source of truth.
// Nothing here ever changes `data` -- it only writes to the store and keeps
// track of what the store holds, so the "Record store check" in Settings can
// show whether the two copies agree before any collection is switched over.
//
// Inactive until records.php answers its ping, so shipping this changes
// nothing for a server that doesn't have the file yet.
import { data, setLocalChangeHandler } from '../state.js';
import { kvGet, kvSet } from '../db.js';
import { isConfigured, getConfig } from './selfhost.js';
import { COLLECTIONS, rowsOf, hashValue, rowLabel } from './collections.js';

const PUSH_DEBOUNCE_MS = 5000;
const POLL_MS = 120000;
const BATCH = 200;
const STATE_KEY = 'recsync-state';
const SEP = '\u0001';

let active = false;
let checkedServer = false;
let serverInfo = null; // {ok, version, user} once pinged
let lastError = '';
let running = null;
let pushTimer = null;

async function recordsUrl() {
const { url } = await getConfig();
if (!/\/sync\.php(\?.*)?$/.test(url || '')) return '';
return url.replace(/\/sync\.php(\?.*)?$/, '/records.php');
}

async function request(method, query, body) {
const url = await recordsUrl();
const { secret } = await getConfig();
const res = await fetch(`${url}${query}`, {
method,
headers: { 'Content-Type': 'application/json', 'X-Sync-Secret': secret },
body: body === undefined ? undefined : JSON.stringify(body),
});
if (!res.ok) {
let detail = `HTTP ${res.status}`;
try { detail = (await res.json()).error || detail; } catch (e) { /* not JSON */ }
const err = new Error(`Record store: ${detail}`);
err.status = res.status;
throw err;
}
return res.json();
}

// State: {cursor, user, rows: {"coll\u0001id": [rev, hashOfServerCopy|null, deleted]}}
async function getState() {
const s = await kvGet(STATE_KEY);
return s && typeof s === 'object' && s.rows ? s : { cursor: 0, user: '', rows: {} };
}

async function crypt() {
return import('../synccrypto.js');
}

async function sealRow(value) {
const c = await crypt();
return (await c.isEncrypted()) ? c.encryptDocument(value) : value;
}

async function openRow(payload) {
const c = await crypt();
return c.isEnvelope(payload) ? c.decryptDocument(payload) : payload;
}

// Every local row of every collection: Map(stateKey -> {entry, id, value, hash}).
function localRows() {
const out = new Map();
COLLECTIONS.forEach((entry) => {
rowsOf(entry, data[entry.key]).forEach((value, id) => {
out.set(`${entry.key}${SEP}${id}`, { entry, id, value, hash: hashValue(value) });
});
});
return out;
}

async function remember(state, coll, id, rev, deleted, payload) {
let hash = null;
if (!deleted && payload !== null && payload !== undefined) hash = hashValue(await openRow(payload));
state.rows[`${coll}${SEP}${id}`] = [rev, hash, !!deleted];
}

// Brings the local picture of the store up to date (one page at a time).
async function pull(state) {
for (let guard = 0; guard < 200; guard++) {
const page = await request('GET', `?since=${state.cursor}`);
for (const ch of page.changes) await remember(state, ch.coll, ch.id, ch.rev, ch.deleted, ch.data);
state.cursor = page.seq;
if (!page.more) break;
}
}

// Sends every row whose content differs from the store's copy, and a
// tombstone for every row the store has that this document no longer does.
async function push(state) {
const local = localRows();
const writes = [];
for (const [key, row] of local) {
const known = state.rows[key];
if (known && !known[2] && known[1] === row.hash) continue;
writes.push({ key, hash: row.hash, w: { coll: row.entry.key, id: row.id, rev: known ? known[0] : 0, data: await sealRow(row.value) } });
}
const tracked = new Set(COLLECTIONS.map((e) => e.key));
Object.keys(state.rows).forEach((key) => {
const [coll, id] = key.split(SEP);
const known = state.rows[key];
if (!tracked.has(coll) || known[2] || local.has(key)) return;
writes.push({ key, hash: null, w: { coll, id, rev: known[0], deleted: true } });
});
let sent = 0, conflicts = 0;
for (let i = 0; i < writes.length; i += BATCH) {
const chunk = writes.slice(i, i + BATCH);
const res = await request('POST', '', { writes: chunk.map((x) => x.w) });
for (let j = 0; j < res.results.length; j++) {
const r = res.results[j], x = chunk[j];
if (r.ok) { state.rows[x.key] = [r.rev, x.hash, !!x.w.deleted]; sent++; }
else if (r.conflict) {
// Another device wrote this row first. The whole document is still
// the source of truth and is reconciled by autosync's merge, so just
// learn the store's revision; the next run sends this device's copy
// if it still differs.
await remember(state, x.w.coll, x.w.id, r.conflict.rev, r.conflict.deleted, r.conflict.data);
conflicts++;
}
}
}
return { sent, conflicts };
}

async function ping() {
checkedServer = true;
if (!(await isConfigured()) || !(await recordsUrl())) { active = false; return false; }
try {
serverInfo = await request('GET', '?ping');
active = !!serverInfo.ok;
} catch (err) {
active = false;
lastError = err.status === 404 ? '' : (err.message || String(err));
}
return active;
}

// One pull + push. Runs are serialised; a run asked for while one is in
// flight waits for it rather than overlapping.
async function runOnce() {
if (!active) return null;
if (running) return running;
running = (async () => {
try {
const state = await getState();
if (serverInfo && state.user && state.user !== serverInfo.user) {
// A different user's credential on this device: start the picture
// afresh rather than mix two users' revisions.
state.cursor = 0; state.rows = {};
}
state.user = serverInfo ? serverInfo.user : '';
await pull(state);
// Encryption switched on (or off) since the store was filled: rows sent
// before are still in the old form, so send every row again.
const enc = await (await crypt()).isEncrypted();
if (state.enc !== undefined && state.enc !== enc) Object.values(state.rows).forEach((row) => { row[1] = null; });
state.enc = enc;
const result = await push(state);
await kvSet(STATE_KEY, state);
lastError = '';
return result;
} catch (err) {
lastError = err.message || String(err);
console.warn('Record store shadow sync failed:', err);
return null;
} finally {
running = null;
}
})();
return running;
}

function schedule() {
if (!active) return;
clearTimeout(pushTimer);
pushTimer = setTimeout(runOnce, PUSH_DEBOUNCE_MS);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function listHtml(items) {
const shown = items.slice(0, 8).map(esc).join(', ');
return items.length > 8 ? `${shown} and ${items.length - 8} more` : shown;
}

// Settings -> Sync -> Record store: one button, one report per collection.
// Each collection names its tab as a link, and lists the records that
// differ by name, so a mismatch can be found rather than just counted.
function bindRecordStoreCheck() {
const btn = document.getElementById('record-store-check-btn');
const out = document.getElementById('record-store-status');
if (!btn || !out) return;
btn.addEventListener('click', async () => {
btn.disabled = true;
out.textContent = 'Checking…';
try {
if (active) await runOnce();
const r = await compareWithStore();
if (!r.active) {
out.textContent = `Not active: ${r.reason}.${r.error ? ` (${r.error})` : ''} The whole-document sync carries on as before.`;
return;
}
const rows = r.collections.map((c) => {
const bad = c.differ.length + c.missing.length + c.extra.length;
const tab = `<span class="inline-goto-link" data-goto-tab="${c.entry.tab}">${esc(c.entry.label)}</span>`;
if (!bad) return `<li>${tab}: ${c.local ? `all ${c.local} match` : 'nothing to store yet'}</li>`;
const parts = [];
if (c.missing.length) parts.push(`not in the store yet: ${listHtml(c.missing)}`);
if (c.differ.length) parts.push(`different in the store: ${listHtml(c.differ)}`);
if (c.extra.length) parts.push(`only in the store: ${listHtml(c.extra)}`);
return `<li>${tab}: ${bad} of ${c.local} need attention &mdash; ${parts.join('; ')}</li>`;
});
const allGood = r.collections.every((c) => !c.differ.length && !c.missing.length && !c.extra.length);
out.innerHTML = `<div>${allGood ? 'The record store matches this device exactly.' : 'Differences found. They usually clear on the next sync; if one stays, that record is worth a look.'} Signed in to the store as <strong>${esc(r.user || '?')}</strong>.</div><ul style="margin:6px 0 0 18px;padding:0;">${rows.join('')}</ul>`;
} catch (err) {
out.textContent = `Check failed: ${err.message || err}`;
} finally {
btn.disabled = false;
}
});
}

async function initRecordSync() {
bindRecordStoreCheck();
if (!(await ping())) return;
setLocalChangeHandler(schedule);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(); });
setInterval(() => { if (document.visibilityState === 'visible') runOnce(); }, POLL_MS);
// Deferred so the first paint and the whole-document pull land first.
setTimeout(runOnce, 15000);
}

// For the Settings check: does the store hold exactly what this document
// holds? Pulls first (no push), then compares row by row.
async function compareWithStore() {
if (!checkedServer) await ping();
if (!active) {
return { active: false, error: lastError, reason: (await recordsUrl()) ? 'records.php is not on the server yet' : 'live sync is not set up with a sync.php URL' };
}
await running;
const state = await getState();
await pull(state);
await kvSet(STATE_KEY, state);
const local = localRows();
const byColl = new Map(COLLECTIONS.map((e) => [e.key, { entry: e, local: 0, differ: [], missing: [], extra: [] }]));
for (const [key, row] of local) {
const bucket = byColl.get(row.entry.key);
bucket.local++;
const known = state.rows[key];
if (!known || known[2]) bucket.missing.push(rowLabel(row.entry, row.id, row.value));
else if (known[1] !== row.hash) bucket.differ.push(rowLabel(row.entry, row.id, row.value));
}
Object.keys(state.rows).forEach((key) => {
const [coll, id] = key.split(SEP);
const bucket = byColl.get(coll);
if (bucket && !state.rows[key][2] && !local.has(key)) bucket.extra.push(id);
});
return { active: true, user: serverInfo && serverInfo.user, collections: [...byColl.values()] };
}

export { initRecordSync, runOnce as syncRecordsNow, compareWithStore };
