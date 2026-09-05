// Keeps this device's document and the server's in step without you pressing
// anything. Pushes shortly after you stop editing, and pulls on load, on
// returning to the tab, and on a slow poll while the tab is visible.
//
// The safety model is unchanged from the manual flows: the server refuses a
// write whose revision is stale (see server/sync.php), so a save here can
// never silently erase a save made on another device. When that happens the
// newer document wins and a backup of what this device had is downloaded
// first, matching what "Pull from Google Drive" already does.
import { data, replaceData, exportBackup, setLocalChangeHandler } from '../state.js';
import { renderAll } from '../render-all.js';
import { ConflictError, NotConfiguredError, isConfigured, pullRemote, pushRemote, setKnownRev, getKnownRev } from './selfhost.js';

const PUSH_DEBOUNCE_MS = 2500;
// Only fires while the tab is visible (see the visibilitychange handler), so
// a backgrounded phone isn't polling all day.
const POLL_MS = 45000;

let pushTimer = null;
let pollTimer = null;
let busy = false;
let statusEl = null;

function setStatus(text, kind) {
if (!statusEl) statusEl = document.getElementById('live-sync-status');
if (!statusEl) return;
statusEl.textContent = text;
statusEl.className = `live-sync-status${kind ? ' ' + kind : ''}`;
}

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

// Adopts the server's copy: keeps a local safety backup first, then replaces
// and re-renders. `fromRemote` stops this write from being treated as a local
// edit and bounced straight back up.
async function adoptRemote(remote, { backupFirst }) {
if (backupFirst) await exportBackup();
await replaceData(remote.data, { fromRemote: true });
await setKnownRev(remote.rev);
renderAll();
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
await adoptRemote(remote, { backupFirst: firstAdoption });
setStatus(firstAdoption
? 'Loaded from server — previous data on this device saved to Downloads'
: `Updated from server ${new Date().toLocaleTimeString()}`, 'ok');
} else if (announce) {
setStatus('Up to date', 'ok');
}
} catch (err) {
const msg = describeError(err);
if (msg) setStatus(msg, 'error');
console.error('Live sync pull failed:', err);
} finally {
busy = false;
}
}

async function push({ force } = {}) {
if ((busy && !force) || !(await isConfigured())) return;
const wasBusy = busy;
busy = true;
try {
setStatus('Saving…');
await pushRemote(data);
setStatus(`Synced ${new Date().toLocaleTimeString()}`, 'ok');
} catch (err) {
if (err instanceof ConflictError) {
// Someone else saved between our last pull and this push. Their copy
// is newer, so it wins — but this device's version is downloaded as a
// backup first, because the edit that just lost is the one you were
// most recently making.
console.warn('Live sync conflict — adopting the server copy.', err.remote);
await adoptRemote(err.remote, { backupFirst: true });
setStatus('Another device had newer data — took theirs, saved yours to Downloads', 'error');
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
pollTimer = setInterval(() => { if (document.visibilityState === 'visible') pull(); }, POLL_MS);
}

async function initAutoSync() {
if (!(await isConfigured())) return;

setLocalChangeHandler(schedulePush);

document.addEventListener('visibilitychange', () => {
if (document.visibilityState === 'visible') pull();
});
// A pending debounce would be cancelled by the page tearing down, losing
// the last few seconds of edits — same gap flushSave() closes locally.
window.addEventListener('pagehide', () => {
if (pushTimer) { clearTimeout(pushTimer); push(); }
});

await pull({ announce: true });
startPolling();
}

// Used by Settings after the URL/secret are entered, so sync starts working
// immediately instead of only after a reload.
async function restartAutoSync() {
clearTimeout(pushTimer);
clearInterval(pollTimer);
await initAutoSync();
}

export { initAutoSync, restartAutoSync, pull, push };
