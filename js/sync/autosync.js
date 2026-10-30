// Keeps this device's document and the server's in step without you pressing
// anything. Pushes shortly after you stop editing, and pulls on load, on
// returning to the tab, and on a slow poll while the tab is visible.
//
// The safety model is unchanged from the manual flows: the server refuses a
// write whose revision is stale (see server/sync.php), so a save here can
// never silently erase a save made on another device. When that happens the
// newer document wins and a backup of what this device had is downloaded
// first, matching what "Pull from Google Drive" already does.
import { data, replaceData, exportBackup, setLocalChangeHandler, hasPendingSave, flushSave } from '../state.js';
import { kvGet, kvSet } from '../db.js';
import { mergeDocuments } from './merge.js';
import { renderAll } from '../render-all.js';
import { ConflictError, NotConfiguredError, isConfigured, pullRemote, pushRemote, setKnownRev, getKnownRev } from './selfhost.js';
import { LockedError } from '../synccrypto.js';
import { drainAgentStaging } from './agentstaging.js';

const PUSH_DEBOUNCE_MS = 2500;
// Only fires while the tab is visible (see the visibilitychange handler), so
// a backgrounded phone isn't polling all day.
const POLL_MS = 45000;
// drainAgentStaging() used to ride this same 45s timer -- confirmed live as
// the actual cause of agent-write.php's own 60/hour rate limit getting
// permanently maxed out: 3600/45 = 80 requests/hour from ONE open tab alone,
// already over the ceiling before counting a second device or tab. Agent
// proposals aren't time-critical to the second the way multi-device sync is,
// so this gets its own, much slower timer instead of a faster shared one.
const DRAIN_MS = 300000;

let pushTimer = null;
let pollTimer = null;
let drainTimer = null;
let busy = false;
let statusEl = null;

// `html` defaults off -- this is the one status line shown on EVERY tab
// (the global page header), fed by plain strings from several call sites
// (some built from raw err.message/server text), so blanket-switching to
// innerHTML would be fragile. Only a call site that KNOWS it's passing
// safe, deliberately-authored markup (the LockedError branches below)
// opts in.
function setStatus(text, kind, { html = false } = {}) {
if (!statusEl) statusEl = document.getElementById('live-sync-status');
if (!statusEl) return;
if (html) statusEl.innerHTML = text; else statusEl.textContent = text;
statusEl.className = `live-sync-status${kind ? ' ' + kind : ''}`;
}

// A locked document (this device has no key, or the wrong one) names a
// real next step -- the recovery-key paste field in Settings -- so it
// gets a link rather than joining the generic plain-text error path
// every other failure here uses.
const LOCKED_STATUS_HTML = 'This device can\'t read the encrypted copy. If you have the recovery key, paste it in <span class="inline-goto-link" data-goto-tab="settings" data-goto-target="#encrypt-key-input">Settings</span>.';

// Does this device hold anything worth preserving? A brand-new install
// carries the sample habits and goals, so this errs towards "yes" and an
// occasional pointless backup file — much the better mistake to make than
// skipping the backup on a device that did have real data.
function hasLocalContent() {
return ['connections', 'habits', 'goals', 'jobs', 'vouchers', 'businessIdeas',
'subscriptions', 'financeAccounts', 'enhancementIdeas', 'calendars']
.some((key) => Array.isArray(data[key]) && data[key].length > 0);
}

function describeError(err) {
if (err instanceof NotConfiguredError) return '';
return err.message || String(err);
}

// The document as it was at the last successful sync with the server --
// the "base" a three-way merge needs to tell what THIS device changed from
// what the SERVER changed. Kept in IndexedDB so it survives a reload.
const BASE_KEY = 'sync-base';
// Caches and last-run stamps each device refreshes for itself: never a reason
// to push on their own, and never a merge conflict worth a backup file.
const VOLATILE_KEYS = ['tickerCache', 'airbnbSyncStatus', 'airbnbCleanerSyncStatus', 'siteHealth'];
async function saveBase(jsonText) {
try { await kvSet(BASE_KEY, jsonText); } catch (err) { console.warn('Could not store the sync baseline:', err); }
}

// A short, local-only trail of the moments this device's document was
// replaced or merged by the server's -- so a "my edit vanished" report can
// be checked against what actually happened. Read it in the console with
// JSON.parse(localStorage['dash-sync-log']).
function syncLog(event, detail) {
console.warn(`Live sync: ${event}`, detail || '');
try {
const log = JSON.parse(localStorage.getItem('dash-sync-log') || '[]');
log.push({ at: new Date().toISOString(), event, detail: detail || '' });
localStorage.setItem('dash-sync-log', JSON.stringify(log.slice(-40)));
} catch (err) { /* storage unavailable: the console line above still stands */ }
}

// Another device may have carried a setting (js/settingsvault.js) in the copy
// just taken; imported on demand so autosync doesn't depend on it loading.
function settingsAfterRemote() {
import('../settingsvault.js').then((m) => m.reconcileSyncedSettings()).catch(() => {});
}

// Adopts the server's copy: keeps a local safety backup first, then replaces
// and re-renders. `fromRemote` stops this write from being treated as a local
// edit and bounced straight back up.
async function adoptRemote(remote, { backupFirst }) {
if (backupFirst) await exportBackup();
await replaceData(remote.data, { fromRemote: true });
await setKnownRev(remote.rev);
await saveBase(JSON.stringify(data));
renderAll();
settingsAfterRemote();
}

// This device has edits the server hasn't seen and the server moved on.
// Rather than throwing the local edits away, merge both: what only this
// device changed is kept, what only the server changed is taken, and only
// a field both sides changed differently goes to the server's value (with
// a backup downloaded first). Returns whether a merge happened; with no
// baseline to merge against it falls back to adopting the server's copy.
async function mergeWithRemote(remote) {
const baseText = await kvGet(BASE_KEY);
const ours = JSON.parse(JSON.stringify(data));
if (!baseText) {
syncLog('no baseline, took the server copy', `rev ${remote.rev}`);
await adoptRemote(remote, { backupFirst: true });
return { merged: false, conflicts: [] };
}
await replaceData(remote.data, { fromRemote: true });
const theirs = JSON.parse(JSON.stringify(data));
const { merged, conflicts } = mergeDocuments(JSON.parse(baseText), ours, theirs, VOLATILE_KEYS);
if (conflicts.length) {
// Same field changed on both sides: keep a file of this device's version.
await replaceData(ours, { fromRemote: true });
await exportBackup();
}
await replaceData(merged, { fromRemote: true });
await setKnownRev(remote.rev);
renderAll();
settingsAfterRemote();
syncLog(conflicts.length ? 'merged, server value kept for' : 'merged cleanly', conflicts.length ? conflicts.slice(0, 8).join(', ') : `rev ${remote.rev}`);
return { merged: true, conflicts };
}

async function pull({ announce } = {}) {
if (busy || !(await isConfigured())) return;
busy = true;
try {
const remote = await pullRemote();
if (remote.data === null) {
// Server has never been written to — seed it from this device rather
// than wiping this device with an empty document.
await setKnownRev(remote.rev);
await push({ force: true });
return;
}
const knownRev = await getKnownRev();
if (remote.rev !== knownRev) {
// A device that has never synced before, but already holds data of its
// own, is about to have all of it replaced by the server's copy. That
// one deserves the same safety net "Pull from Google Drive" gives.
// Later pulls skip it: by then this device's own edits have been pushed
// up, so there's nothing unique left to lose, and a download on every
// remote change would be unbearable.
const firstAdoption = knownRev === 0 && hasLocalContent();
if (!firstAdoption && (hasPendingSave() || pushTimer)) {
// An edit is still on its way up. Replacing the document now would
// silently drop it, so send it first; if the server has moved on the
// push's conflict path merges the two.
await flushSave();
clearTimeout(pushTimer);
pushTimer = null;
busy = false;
if ((await push()) !== 'skipped') return;
}
await adoptRemote(remote, { backupFirst: firstAdoption });
if (!firstAdoption) syncLog('adopted newer server copy', `rev ${remote.rev}`);
setStatus(firstAdoption
? 'Loaded from server — previous data on this device saved to Downloads'
: `Updated from server ${new Date().toLocaleTimeString()}`, 'ok');
} else {
// Same revision as the server: its copy IS the last synced state, so it
// is the right baseline for any later merge. Stored once, not per poll.
if (!hasPendingSave() && !pushTimer && !(await kvGet(BASE_KEY))) await saveBase(JSON.stringify(remote.data));
if (announce) setStatus('Up to date', 'ok');
}
} catch (err) {
if (err instanceof LockedError) {
setStatus(LOCKED_STATUS_HTML, 'error', { html: true });
} else {
const msg = describeError(err);
if (msg) setStatus(msg, 'error');
}
console.error('Live sync pull failed:', err);
} finally {
busy = false;
}
}

async function push({ force, attempt = 0 } = {}) {
if ((busy && !force) || !(await isConfigured())) return;
const wasBusy = busy;
busy = true;
try {
setStatus('Saving…');
const sent = JSON.stringify(data);
// Which top-level sections this push actually changed, kept in the local
// sync log so a chatty writer (a poll, a scheduled task, another open
// device) can be identified from the keys that keep appearing here.
try {
const baseText = await kvGet(BASE_KEY);
if (baseText) {
const base = JSON.parse(baseText), now = JSON.parse(sent);
const changed = Object.keys(now).filter((k) => JSON.stringify(now[k]) !== JSON.stringify(base[k]));
const meaningful = changed.filter((k) => !VOLATILE_KEYS.includes(k));
if (!meaningful.length && Object.keys(base).length === Object.keys(now).length) {
// Nothing worth sending. A pull's re-render can queue a save that changes
// nothing, and a quote/weather refresh or sync-status stamp changes only
// per-device caches; pushing either bumped the server revision, which
// made every other open device pull and do the same -- a ping-pong.
setStatus(`Synced ${new Date().toLocaleTimeString()}`, 'ok');
return 'skipped';
}
syncLog('pushing changes to', changed.slice(0, 12).join(', '));
}
} catch (err) { /* diagnostic only */ }
await pushRemote(data);
await saveBase(sent);
setStatus(`Synced ${new Date().toLocaleTimeString()}`, 'ok');
} catch (err) {
if (err instanceof ConflictError) {
// Someone else saved between our last pull and this push. Merge their
// changes with ours instead of discarding either; the merged document
// is then pushed again (a couple of tries, in case it moves again).
const result = await mergeWithRemote(err.remote);
if (!result.merged) {
setStatus('Another device had newer data — took theirs, saved yours to Downloads', 'error');
} else if (result.conflicts.length) {
setStatus('Merged with another device — one field changed on both sides, theirs kept, yours saved to Downloads', 'error');
} else {
setStatus('Merged with changes from another device', 'ok');
}
if (result.merged && attempt < 2) await push({ force: true, attempt: attempt + 1 });
} else if (err instanceof LockedError) {
setStatus(LOCKED_STATUS_HTML, 'error', { html: true });
console.error('Live sync push failed:', err);
} else {
const msg = describeError(err);
if (msg) setStatus(msg, 'error');
console.error('Live sync push failed:', err);
}
} finally {
busy = wasBusy ? busy : false;
}
}

function schedulePush() {
clearTimeout(pushTimer);
pushTimer = setTimeout(() => push(), PUSH_DEBOUNCE_MS);
}

function startPolling() {
clearInterval(pollTimer);
pollTimer = setInterval(() => {
if (document.visibilityState !== 'visible') return;
pull();
}, POLL_MS);
// drainAgentStaging() is independently gated (its own agentWriteUrl/
// agentSecret config check, its own try/catch) -- its own slower timer,
// not the main sync poll above (see DRAIN_MS's own comment on why).
clearInterval(drainTimer);
drainTimer = setInterval(() => {
if (document.visibilityState !== 'visible') return;
drainAgentStaging();
}, DRAIN_MS);
}

async function initAutoSync() {
if (!(await isConfigured())) return;

setLocalChangeHandler(schedulePush);

document.addEventListener('visibilitychange', () => {
if (document.visibilityState === 'visible') { pull(); drainAgentStaging(); }
});
// A pending debounce would be cancelled by the page tearing down, losing
// the last few seconds of edits — same gap flushSave() closes locally.
window.addEventListener('pagehide', () => {
if (pushTimer) { clearTimeout(pushTimer); push(); }
});

await pull({ announce: true });
settingsAfterRemote();
drainAgentStaging();
startPolling();
}

// Used by Settings after the URL/secret are entered, so sync starts working
// immediately instead of only after a reload.
async function restartAutoSync() {
clearTimeout(pushTimer);
clearInterval(pollTimer);
clearInterval(drainTimer);
await initAutoSync();
}

export { initAutoSync, restartAutoSync, pull, push };
