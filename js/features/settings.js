import { data, getLocalSettings, setLocalSetting, exportBackup, importBackup, loadData } from '../state.js';
import { renderAll } from '../render-all.js';
import { NotConfiguredError, isSignedIn, wasConnectedBefore, tryReconnectSilently, signIn, signOut } from '../sync/googleauth.js';
import { getRemoteInfo, getRemoteCounts, countsOf, pushToGoogleDrive, pullFromGoogleDrive } from '../sync/googledrive.js';

async function initSettings() {
const keyInput = document.getElementById('anthropic-key-input');
const settings = await getLocalSettings();
keyInput.value = settings.anthropicApiKey || '';
let saveTimer = null;
keyInput.addEventListener('input', () => {
clearTimeout(saveTimer);
saveTimer = setTimeout(() => setLocalSetting('anthropicApiKey', keyInput.value.trim()), 400);
});

const exportBtn = document.getElementById('export-btn');
let exportHandledByPointer = false;
exportBtn.addEventListener('pointerdown', (e) => {
e.preventDefault();
exportHandledByPointer = true;
exportBackup();
document.getElementById('backup-status').textContent = 'Backup downloaded.';
});
exportBtn.addEventListener('click', () => {
if (exportHandledByPointer) { exportHandledByPointer = false; return; }
exportBackup();
document.getElementById('backup-status').textContent = 'Backup downloaded.';
});

document.getElementById('import-backup-input').addEventListener('change', async (e) => {
const file = e.target.files[0];
if (!file) return;
const status = document.getElementById('backup-status');
if (!confirm('Import this backup? It will replace all data currently in the app.')) {
e.target.value = '';
return;
}
try {
await importBackup(file);
renderAll();
status.textContent = 'Backup restored.';
} catch (err) {
status.textContent = "Couldn't read that file — make sure it's a dashboard backup JSON.";
}
e.target.value = '';
});

await initSync();
}

function summarizeCounts(d) {
return `${d.connections.length} connection${d.connections.length === 1 ? '' : 's'}, ${d.habits.length} habit${d.habits.length === 1 ? '' : 's'}, ${d.goals.length} goal${d.goals.length === 1 ? '' : 's'}, ${d.jobs.length} job${d.jobs.length === 1 ? '' : 's'}, ${d.vouchers.length} voucher${d.vouchers.length === 1 ? '' : 's'}, ${d.businessIdeas.length} idea${d.businessIdeas.length === 1 ? '' : 's'}`;
}

async function initSync() {
const signedOutBox = document.getElementById('sync-signed-out');
const signedInBox = document.getElementById('sync-signed-in');
const accountEl = document.getElementById('sync-account');
const statusEl = document.getElementById('sync-status');
const signinBtn = document.getElementById('sync-signin-btn');
const signoutBtn = document.getElementById('sync-signout-btn');
const pushBtn = document.getElementById('sync-push-btn');
const pullBtn = document.getElementById('sync-pull-btn');

async function refresh() {
const signedIn = isSignedIn(); // fast, local-only — never blocks or opens anything
signedOutBox.style.display = signedIn ? 'none' : 'block';
signedInBox.style.display = signedIn ? 'block' : 'none';
if (signedIn) {
const settings = await getLocalSettings();
const parts = ['Connected to Google (Drive sync + Calendar)'];
if (settings.lastPushedAt) parts.push(`last pushed ${new Date(settings.lastPushedAt).toLocaleString()}`);
if (settings.lastPulledAt) parts.push(`last pulled ${new Date(settings.lastPulledAt).toLocaleString()}`);
accountEl.textContent = parts.join(' — ');
} else if (await wasConnectedBefore()) {
signinBtn.textContent = 'Reconnect to Google';
} else {
signinBtn.textContent = 'Sign in to Google';
}
}

signinBtn.addEventListener('click', async () => {
statusEl.textContent = 'Opening Google sign-in…';
try {
await signIn();
statusEl.textContent = 'Signed in.';
await refresh();
} catch (err) {
statusEl.textContent = err instanceof NotConfiguredError
? err.message
: `Sign-in failed: ${err.message || err}`;
console.error('Google sign-in failed:', err);
}
});

signoutBtn.addEventListener('click', async () => {
try {
await signOut();
statusEl.textContent = 'Signed out.';
await refresh();
} catch (err) {
statusEl.textContent = `Sign-out failed: ${err.message || err}`;
console.error('Google sign-out failed:', err);
}
});

pushBtn.addEventListener('click', async () => {
statusEl.textContent = 'Checking what\'s already in Google Drive…';
let remoteCounts;
try {
remoteCounts = await getRemoteCounts();
} catch (err) {
statusEl.textContent = `Couldn't check Google Drive: ${err.message || err}`;
console.error('Google Drive check failed:', err);
return;
}

const localCounts = countsOf(data);
const shrinking = remoteCounts && Object.keys(localCounts).filter((k) => localCounts[k] < remoteCounts[k]);

let message = `Push to Google Drive?\n\nThis uploads: ${summarizeCounts(data)}\n\nIt will overwrite whatever's currently in your Google Drive backup — not your local data, that stays as-is.`;
if (shrinking && shrinking.length > 0) {
const detail = shrinking.map((k) => `${k}: Drive has ${remoteCounts[k]}, this device only has ${localCounts[k]}`).join('\n');
message = `⚠️ WARNING — Google Drive has MORE data than this device in some places:\n\n${detail}\n\nPushing now will PERMANENTLY DELETE the extra records in Drive — they are not on this device to fall back on. This is exactly what caused a real data loss before. If this device hasn't pulled recently, cancel and Pull first instead.\n\nPush anyway?`;
}

const ok = confirm(message);
if (!ok) return;
pushBtn.disabled = true;
try {
await pushToGoogleDrive((msg) => { statusEl.textContent = msg; });
statusEl.textContent = 'Pushed to Google Drive.';
await refresh();
} catch (err) {
statusEl.textContent = `Push failed: ${err.message || err}`;
console.error('Google Drive push failed:', err);
} finally {
pushBtn.disabled = false;
}
});

pullBtn.addEventListener('click', async () => {
statusEl.textContent = 'Checking what\'s in Google Drive…';
let info;
try {
info = await getRemoteInfo();
} catch (err) {
statusEl.textContent = `Couldn't check Google Drive: ${err.message || err}`;
console.error('Google Drive check failed:', err);
return;
}
if (!info) {
statusEl.textContent = 'No backup found in Google Drive yet — push from a device with your data first.';
return;
}
const ok = confirm(`Pull from Google Drive?\n\nThe Google Drive backup was last saved ${new Date(info.lastModified).toLocaleString()}.\n\nThis REPLACES all local data on this device with that backup. Your current local data (${summarizeCounts(data)}) will be downloaded as a safety-net backup file first — check your downloads if you need to recover anything after.`);
if (!ok) return;
pullBtn.disabled = true;
try {
await pullFromGoogleDrive((msg) => { statusEl.textContent = msg; });
renderAll();
statusEl.textContent = 'Pulled from Google Drive.';
await refresh();
} catch (err) {
statusEl.textContent = `Pull failed: ${err.message || err}`;
console.error('Google Drive pull failed:', err);
} finally {
pullBtn.disabled = false;
}
});

await refresh();

// Opportunistic, silent, and entirely best-effort: try to reconnect
// without asking, but never show an error or change the button state if
// it doesn't work — it commonly won't, since browsers block popups that
// aren't a direct result of a click, which this isn't. Success upgrades
// the UI to "Connected"; failure just leaves the normal Sign In / Reconnect
// button as the fallback, silently.
tryReconnectSilently().then((reconnected) => { if (reconnected) refresh(); });
}

export { initSettings };
