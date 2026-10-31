// Per-record storage. Every collection starts in SHADOW MODE: copies the five
// core tabs' data (js/sync/collections.js) into server/records.php one row per
// record, alongside the whole-document sync, which stays the source of truth.
// In shadow mode nothing here changes `data` -- it only writes to the store
// and keeps track of what the store holds, so the "Record store check" in
// Settings can show whether the two copies agree.
//
// A collection that agrees can then be SWITCHED OVER from the same panel. The
// switch is one row in the store (meta/flipped), so every device follows it.
// A switched-over collection is read from the store: rows other devices wrote
// are merged into `data` (three-way, against the copy last seen from the
// store), and autosync.js stops letting the whole document overwrite it. The
// whole document still receives it on the pushes it makes anyway, so
// switching back needs no data recovery.
//
// Inactive until records.php answers its ping, so shipping this changes
// nothing for a server that doesn't have the file yet.
import { data, setLocalChangeHandler } from '../state.js';
import { kvGet, kvSet } from '../db.js';
import { isConfigured, getConfig } from './selfhost.js';
import { COLLECTIONS, rowsOf, rowIndex, rowId, hashValue, rowLabel } from './collections.js';
import { mergeValue } from './merge.js';

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
const state = s && typeof s === 'object' && s.rows ? s : { cursor: 0, user: '', rows: {} };
if (!state.base) state.base = {};
return state;
}

// Which collections are read from the store. Mirrored in localStorage so
// autosync can ask synchronously on boot, before anything has been fetched.
const FLIP_LS = 'recsync-flipped';
const tracked = () => new Set(COLLECTIONS.map((e) => e.key));
function readFlipped() {
try { return new Set((JSON.parse(localStorage.getItem(FLIP_LS) || '[]') || []).filter((k) => tracked().has(k))); } catch (e) { return new Set(); }
}
let flipped = readFlipped();
function setFlippedLocal(keys) {
flipped = new Set([...keys].filter((k) => tracked().has(k)));
try { localStorage.setItem(FLIP_LS, JSON.stringify([...flipped])); } catch (e) { /* the store row still holds it */ }
}
function flippedKeys() { return [...flipped]; }

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

const hashOf = (v) => (v === undefined ? null : hashValue(v));

function sortDir(arr, field) {
if (arr.length < 2) return 1;
let asc = true, desc = true;
for (let i = 1; i < arr.length; i++) {
const c = String((arr[i - 1] || {})[field] || '').localeCompare(String((arr[i] || {})[field] || ''));
if (c > 0) asc = false;
if (c < 0) desc = false;
}
return asc ? 1 : desc ? -1 : 0;
}

// Writes one row into the live document (value undefined removes it).
function putRow(entry, id, value) {
const k = entry.key;
if (entry.kind === 'singleton') { if (value !== undefined) data[k] = value; return; }
if (entry.kind === 'prefs') {
if (!data.prefs || typeof data.prefs !== 'object') data.prefs = {};
const name = Object.keys(data.prefs).find((n) => rowId(n) === id) || id;
if (value === undefined) delete data.prefs[name]; else data.prefs[name] = value;
return;
}
if (!Array.isArray(data[k])) data[k] = [];
const arr = data[k];
const idx = rowIndex(entry, arr).get(id);
const dir = entry.kind === 'dated' ? sortDir(arr, entry.dateField) : 0;
if (value === undefined) { if (idx !== undefined) arr.splice(idx, 1); return; }
if (idx !== undefined) arr[idx] = value; else arr.push(value);
if (dir) arr.sort((a, b) => dir * String(a[entry.dateField] || '').localeCompare(String(b[entry.dateField] || '')));
}

// When a collection is switched over, the copy this device holds is the
// agreed starting point for later three-way merges.
function seedBase(state, key) {
const entry = COLLECTIONS.find((e) => e.key === key);
if (!entry) return;
rowsOf(entry, data[key]).forEach((value, id) => {
const k = `${key}${SEP}${id}`;
const known = state.rows[k];
if (known && !known[2] && known[1] === hashValue(value)) state.base[k] = value;
});
}

function dropBase(state, key) {
Object.keys(state.base).forEach((k) => { if (k.startsWith(`${key}${SEP}`)) delete state.base[k]; });
}

function adoptFlipSet(state, keys) {
const next = new Set(keys.filter((k) => tracked().has(k)));
[...next].filter((k) => !flipped.has(k)).forEach((k) => seedBase(state, k));
[...flipped].filter((k) => !next.has(k)).forEach((k) => dropBase(state, k));
setFlippedLocal(next);
}

// Takes one row received from the store. A collection still in shadow mode
// just notes the store's revision. A switched-over one also brings the row
// into `data`: straight in if this device hasn't touched it since the last
// sync, otherwise merged with what this device changed. Returns whether
// `data` changed.
async function absorb(state, ch) {
const entry = COLLECTIONS.find((e) => e.key === ch.coll);
if (!entry || !flipped.has(ch.coll)) {
await remember(state, ch.coll, ch.id, ch.rev, ch.deleted, ch.data);
return false;
}
const key = `${ch.coll}${SEP}${ch.id}`;
const known = state.rows[key];
const theirs = ch.deleted ? undefined : await openRow(ch.data);
const ours = rowsOf(entry, data[ch.coll]).get(ch.id);
const dirty = ours === undefined ? !!(known && !known[2]) : (!known || known[1] !== hashValue(ours));
const base = state.base[key];
let result;
if (!dirty) result = theirs;
else if (ours === undefined) result = (base !== undefined && theirs !== undefined && hashOf(theirs) === hashOf(base)) ? undefined : theirs;
else if (theirs === undefined) result = (base !== undefined && hashOf(ours) === hashOf(base)) ? undefined : ours;
else {
const conflicts = [];
result = mergeValue(base, ours, theirs, key, conflicts);
if (conflicts.length) console.warn(`Record store: ${key} changed on two devices, store value kept for`, conflicts);
}
const changed = hashOf(result) !== hashOf(ours);
if (changed) putRow(entry, ch.id, result);
await remember(state, ch.coll, ch.id, ch.rev, ch.deleted, ch.data);
if (theirs === undefined) delete state.base[key]; else state.base[key] = theirs;
return changed;
}

async function rerender() {
try { (await import('../render-all.js')).renderAll(); } catch (err) { console.warn('Record store: re-render failed', err); }
}

// Brings the local picture of the store up to date (one page at a time), and
// applies what arrived to every switched-over collection. Returns whether
// `data` changed.
async function pull(state) {
const incoming = [];
let cursor = state.cursor;
for (let guard = 0; guard < 200; guard++) {
const page = await request('GET', `?since=${cursor}`);
incoming.push(...page.changes);
cursor = page.seq;
if (!page.more) break;
}
// The switch-over setting first, so rows in the same batch are treated by
// the rules that now apply to them.
const isFlag = (ch) => ch.coll === 'meta' && ch.id === 'flipped';
const flag = incoming.filter(isFlag).pop();
if (flag) {
await remember(state, flag.coll, flag.id, flag.rev, flag.deleted, flag.data);
adoptFlipSet(state, flag.deleted ? [] : (((await openRow(flag.data)) || {}).keys || []));
}
let changed = false;
for (const ch of incoming) {
if (isFlag(ch)) continue;
if (await absorb(state, ch)) changed = true;
}
state.cursor = cursor;
if (changed) await rerender();
return changed;
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
const trackedKeys = tracked();
// A collection that is empty here while the store holds several rows has
// most likely not been loaded yet, not been emptied on purpose.
const liveKnown = new Map(), liveLocal = new Map();
Object.keys(state.rows).forEach((key) => { if (!state.rows[key][2]) { const c = key.split(SEP)[0]; liveKnown.set(c, (liveKnown.get(c) || 0) + 1); } });
local.forEach((row) => liveLocal.set(row.entry.key, (liveLocal.get(row.entry.key) || 0) + 1));
Object.keys(state.rows).forEach((key) => {
const [coll, id] = key.split(SEP);
const known = state.rows[key];
if (!trackedKeys.has(coll) || known[2] || local.has(key)) return;
if (!liveLocal.get(coll) && (liveKnown.get(coll) || 0) >= 5) return;
writes.push({ key, hash: null, w: { coll, id, rev: known[0], deleted: true } });
});
let sent = 0, conflicts = 0, changed = false;
for (let i = 0; i < writes.length; i += BATCH) {
const chunk = writes.slice(i, i + BATCH);
const res = await request('POST', '', { writes: chunk.map((x) => x.w) });
for (let j = 0; j < res.results.length; j++) {
const r = res.results[j], x = chunk[j];
if (r.ok) { state.rows[x.key] = [r.rev, x.hash, !!x.w.deleted]; sent++; }
else if (r.conflict) {
// Another device wrote this row first. A collection in shadow mode
// just learns the store's revision (the whole document is still its
// source of truth); a switched-over one merges the store's copy with
// this device's. Either way the next run sends this device's copy if
// it still differs.
if (await absorb(state, { coll: x.w.coll, id: x.w.id, rev: r.conflict.rev, deleted: r.conflict.deleted, data: r.conflict.data })) changed = true;
conflicts++;
}
}
}
return { sent, conflicts, changed };
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
state.cursor = 0; state.rows = {}; state.base = {};
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
if (result.changed) await rerender();
if (result.conflicts) schedule();
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

// Switches one collection over to (or back from) the store. Only allowed when
// this device's copy and the store agree row for row, so nothing is lost by
// changing which side is read. The setting is a row in the store, so the
// other devices pick it up on their next pull.
async function setCollectionFlipped(key, on) {
if (!active) throw new Error('the record store is not reachable');
const entry = COLLECTIONS.find((e) => e.key === key);
if (!entry) throw new Error('unknown collection');
await running;
const job = (async () => {
const state = await getState();
await pull(state);
if (on) {
const stale = [...rowsOf(entry, data[key])].filter(([id, value]) => { const known = state.rows[`${key}${SEP}${id}`]; return !known || known[2] || known[1] !== hashValue(value); });
if (stale.length) throw new Error(`${entry.label}: ${stale.length} row${stale.length === 1 ? '' : 's'} differ from the store, run the check and let it settle first`);
}
const next = new Set(flipped);
if (on) next.add(key); else next.delete(key);
const metaKey = `meta${SEP}flipped`;
const known = state.rows[metaKey];
const res = await request('POST', '', { writes: [{ coll: 'meta', id: 'flipped', rev: known ? known[0] : 0, data: await sealRow({ keys: [...next] }) }] });
const r = res.results[0];
if (!r.ok) {
if (r.conflict) await remember(state, 'meta', 'flipped', r.conflict.rev, r.conflict.deleted, r.conflict.data);
await kvSet(STATE_KEY, state);
throw new Error('another device changed this setting at the same moment, try again');
}
state.rows[metaKey] = [r.rev, hashValue({ keys: [...next] }), false];
if (on) seedBase(state, key); else dropBase(state, key);
setFlippedLocal(next);
await kvSet(STATE_KEY, state);
})();
running = job;
try { await job; } finally { if (running === job) running = null; }
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
out.addEventListener('click', async (ev) => {
const t = ev.target.closest('[data-flip-on],[data-flip-off],[data-flip-clear]');
if (!t) return;
t.disabled = true;
try {
if (t.dataset.flipClear) setFlippedLocal([]);
else await setCollectionFlipped(t.dataset.flipOn || t.dataset.flipOff, !!t.dataset.flipOn);
btn.click();
} catch (err) {
out.textContent = `Could not change that: ${err.message || err}`;
}
});
btn.addEventListener('click', async () => {
btn.disabled = true;
out.textContent = 'Checking…';
try {
if (active) await runOnce();
const r = await compareWithStore();
if (!r.active) {
const stuck = flippedKeys();
out.innerHTML = `${esc(`Not active: ${r.reason}.${r.error ? ` (${r.error})` : ''}`)} The whole-document sync carries on as before.${stuck.length ? ` <button class="sync-btn sm inline" type="button" data-flip-clear="1">Stop reading ${stuck.length} collection${stuck.length === 1 ? '' : 's'} from the store on this device</button>` : ''}`;
return;
}
const rows = r.collections.map((c) => {
const bad = c.differ.length + c.missing.length + c.extra.length;
const tab = `<span class="inline-goto-link" data-goto-tab="${c.entry.tab}">${esc(c.entry.label)}</span>`;
const isOn = r.flipped.includes(c.entry.key);
const flipBtn = isOn
? ` <span class="settings-note" style="margin:0;">read from the store</span> <button class="sync-btn sm inline" type="button" data-flip-off="${c.entry.key}">Switch back</button>`
: (!bad && c.local ? ` <button class="sync-btn sm inline" type="button" data-flip-on="${c.entry.key}">Read from the store</button>` : '');
if (!bad) return `<li>${tab}: ${c.local ? `all ${c.local} match` : 'nothing to store yet'}${flipBtn}</li>`;
const parts = [];
if (c.missing.length) parts.push(`not in the store yet: ${listHtml(c.missing)}`);
if (c.differ.length) parts.push(`different in the store: ${listHtml(c.differ)}`);
if (c.extra.length) parts.push(`only in the store: ${listHtml(c.extra)}`);
return `<li>${tab}: ${bad} of ${c.local} need attention &mdash; ${parts.join('; ')}${flipBtn}</li>`;
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
return { active: true, user: serverInfo && serverInfo.user, collections: [...byColl.values()], flipped: flippedKeys() };
}

export { initRecordSync, runOnce as syncRecordsNow, compareWithStore, flippedKeys, setCollectionFlipped };
