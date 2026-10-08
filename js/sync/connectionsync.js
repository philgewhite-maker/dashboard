// Per-record sync for Connections, additive to autosync.js's existing
// whole-document sync -- see server/sync-connections.php's own header for
// the full "why" (the whole-doc push re-encrypts and re-uploads the
// entire document, 2+ MB, on every save, with several clients/the NAS/the
// relay app all writing — a growing truncation/conflict risk).
//
// Deliberately NOT a replacement yet: data.connections keeps syncing via
// the whole document exactly as before (zero changes to connections.js,
// tinderimport.js, or any of the many other places that mutate a
// connection — this file hooks the SAME queueSave()/onLocalChange signal
// everything else already triggers, not each mutation site individually).
// This is a second, smaller, lower-stakes path running alongside the
// first: if this file has a bug, nothing regresses, since the whole-doc
// copy is still syncing everything as the source of truth.
//
// Conflict handling reuses js/features/connections.js's own
// mergeConnectionInto (fill-gaps + array-union) -- the same merge this
// app already trusts for "two records about the same person, reconcile
// them" (duplicate-merge, CSV import), applied here to "the same
// connection edited on two devices since they last agreed."
import { data, queueSave, getLocalSettings, setLocalSetting, setLocalChangeHandler } from '../state.js';
import { isConfigured, getConfig } from './selfhost.js';

const PUSH_DEBOUNCE_MS = 2500; // matches autosync.js's own debounce
const POLL_MS = 45000; // matches autosync.js's own poll cadence
const STATE_KEY = 'connSyncState'; // local-settings key: {[id]: {rev, snapshot}}

let pushTimer = null;
let pollTimer = null;
let pushing = false;
let pulling = false;
let statusEl = null;

function setStatus(text, kind) {
if (!statusEl) statusEl = document.getElementById('conn-sync-status');
if (!statusEl) return;
statusEl.textContent = text;
statusEl.className = `live-sync-status${kind ? ' ' + kind : ''}`;
}

// This endpoint is deployed "next to sync.php" (server/sync-connections
// .php's own header) -- derived from the already-configured sync URL
// rather than a second Settings field to fill in, so turning this on
// needs zero new setup for anyone who's already got live sync working.
// Returns '' (feature silently inactive) if the configured URL doesn't
// end in exactly "sync.php", e.g. a custom filename -- this never guesses
// at a URL that might be wrong.
async function connSyncUrl() {
const { url } = await getConfig();
if (!/\/sync\.php(\?.*)?$/.test(url)) return '';
return url.replace(/\/sync\.php(\?.*)?$/, '/sync-connections.php');
}

async function getState() {
const settings = await getLocalSettings();
return settings[STATE_KEY] || {};
}

async function setState(state) {
await setLocalSetting(STATE_KEY, state);
}

async function secretHeader() {
const { secret } = await getConfig();
return secret;
}

async function apiRequest(url, secret, method, body) {
const res = await fetch(url, {
method,
headers: { 'Content-Type': 'application/json', 'X-Sync-Secret': secret },
body: body === undefined ? undefined : JSON.stringify(body),
});
if (res.status === 409) {
const err = new Error('conflict');
err.conflict = await res.json();
throw err;
}
if (!res.ok) {
let detail = `HTTP ${res.status}`;
try { detail = (await res.json()).error || detail; } catch (e) { /* not JSON */ }
throw new Error(`Connection sync error: ${detail}`);
}
return res.json();
}

// Same per-record envelope encryptDocument/decryptDocument already
// handle for the whole document (js/synccrypto.js) -- both take
// arbitrary data, not hardcoded to the whole doc, so calling them on one
// connection's own object is exactly the same call shape, just smaller.
async function encryptIfNeeded(conn) {
const crypt = await import('../synccrypto.js');
if (!(await crypt.isEncrypted())) return conn;
return crypt.encryptDocument(conn);
}
async function decryptIfNeeded(payload) {
const crypt = await import('../synccrypto.js');
if (!crypt.isEnvelope(payload)) return payload;
return crypt.decryptDocument(payload);
}

function snapshotOf(conn) { return JSON.stringify(conn); }

// Pushes every connection whose current JSON differs from its last-synced
// snapshot (new, edited, or -- via the delete branch -- removed). A 409
// means someone else changed this record since this device last saw it:
// merge their copy INTO this device's local copy (mergeConnectionInto
// already fills gaps and unions arrays rather than picking a side), then
// push the merged result as the next revision on top of theirs.
async function pushDirty() {
if (pushing) return;
const url = await connSyncUrl();
if (!url || !(await isConfigured())) return;
pushing = true;
try {
const secret = await secretHeader();
const state = await getState();
const liveIds = new Set(data.connections.map((c) => c.id));

for (const id of Object.keys(state)) {
if (liveIds.has(id)) continue;
// Deleted locally since last sync -- tell the server, same rev check.
try {
await apiRequest(`${url}?delete=1`, secret, 'POST', { id, rev: state[id].rev });
} catch (err) {
if (!err.conflict) { console.error(`Connection sync: delete failed for ${id}:`, err); continue; }
// Someone else edited it after we deleted locally -- their edit
// wins (nothing to merge INTO, since our side has nothing left);
// leave it out of state so the next pull re-adopts it.
}
delete state[id];
}

for (const conn of data.connections) {
const known = state[conn.id];
const snap = snapshotOf(conn);
if (known && known.snapshot === snap) continue; // unchanged since last sync
try {
const payload = await encryptIfNeeded(conn);
const result = await apiRequest(url, secret, 'POST', { id: conn.id, rev: known ? known.rev : 0, data: payload });
state[conn.id] = { rev: result.rev, snapshot: snap };
} catch (err) {
if (!err.conflict) { console.error(`Connection sync: push failed for ${conn.id}:`, err); continue; }
// Remote changed since our last known rev -- merge theirs into ours
// (fills gaps, unions arrays/photos/identities -- never silently
// drops either side's edit), then push the merged record as the
// next revision on top of what they have.
const remote = await decryptIfNeeded(err.conflict.data);
const { mergeConnectionInto } = await import('../features/connections.js');
mergeConnectionInto(conn, remote);
try {
const payload = await encryptIfNeeded(conn);
const retry = await apiRequest(url, secret, 'POST', { id: conn.id, rev: err.conflict.rev, data: payload });
state[conn.id] = { rev: retry.rev, snapshot: snapshotOf(conn) };
} catch (err2) {
console.error(`Connection sync: merge-and-retry failed for ${conn.id}:`, err2);
}
}
}
await setState(state);
setStatus(`Connections synced ${new Date().toLocaleTimeString()}`, 'ok');
} catch (err) {
console.error('Connection sync push failed:', err);
setStatus(err.message || String(err), 'error');
} finally {
pushing = false;
}
}

// Pulls the id+rev index (cheap -- no record bodies), fetches only the
// records whose rev moved past what this device last knew, and either
// adopts them outright (nothing changed here since the last common rev)
// or merges (this device ALSO changed it -- same fill-gaps/union rule as
// the push-side conflict, just reached from the pull direction) before
// re-pushing the merged result so the server ends up with the union too.
async function pullChanged() {
if (pulling) return;
const url = await connSyncUrl();
if (!url || !(await isConfigured())) return;
pulling = true;
try {
const secret = await secretHeader();
const index = await apiRequest(`${url}?index=1`, secret, 'GET');
const state = await getState();
const byId = new Map(data.connections.map((c) => [c.id, c]));
let changed = 0;

for (const row of index) {
const known = state[row.id];
if (known && known.rev >= row.rev) continue; // already have this revision
const full = await apiRequest(`${url}?id=${encodeURIComponent(row.id)}`, secret, 'GET');
const remote = await decryptIfNeeded(full.data);
const local = byId.get(row.id);
if (local && known && snapshotOf(local) !== known.snapshot) {
// Locally edited since we last agreed with the server AND the
// server has a newer revision too -- genuine concurrent edit,
// merge both ways so neither side's change is lost.
const { mergeConnectionInto } = await import('../features/connections.js');
mergeConnectionInto(local, remote);
state[row.id] = { rev: full.rev, snapshot: snapshotOf(local) };
} else if (local) {
Object.assign(local, remote);
state[row.id] = { rev: full.rev, snapshot: snapshotOf(local) };
} else {
data.connections.push(remote);
state[row.id] = { rev: full.rev, snapshot: snapshotOf(remote) };
}
changed++;
}
await setState(state);
if (changed) {
queueSave();
const { renderConnections } = await import('../features/connections.js');
renderConnections();
setStatus(`Pulled ${changed} connection${changed === 1 ? '' : 's'} ${new Date().toLocaleTimeString()}`, 'ok');
}
} catch (err) {
console.error('Connection sync pull failed:', err);
setStatus(err.message || String(err), 'error');
} finally {
pulling = false;
}
}

function schedulePush() {
clearTimeout(pushTimer);
pushTimer = setTimeout(() => pushDirty(), PUSH_DEBOUNCE_MS);
}

async function initConnectionSync() {
if (!(await isConfigured())) return;
if (!(await connSyncUrl())) return; // sync.php under a non-default name -- stays off rather than guessing
// setLocalChangeHandler (state.js) now fans out to every registered
// handler -- autosync.js's whole-document push keeps firing exactly as
// before, this is a second, independent listener on the same signal.
setLocalChangeHandler(schedulePush);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pullChanged(); });
await pullChanged();
clearInterval(pollTimer);
pollTimer = setInterval(() => { if (document.visibilityState === 'visible') pullChanged(); }, POLL_MS);
}

export { initConnectionSync, pushDirty, pullChanged };
