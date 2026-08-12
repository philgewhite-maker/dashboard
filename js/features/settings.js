import { data, queueSave, getLocalSettings, setLocalSetting, exportBackup, importBackup, MAIL_SEARCH_KINDS } from '../state.js';
import { renderAll } from '../render-all.js';
import { escapeHtml, uid } from '../utils.js';
import { renderCalendarLimits } from './calendars.js';
import { summarizeUsage, currentMonthKey } from '../ai.js';
import { setShowSensitiveFields } from './connections.js';
import { pullRemote } from '../sync/selfhost.js';
import { restartAutoSync } from '../sync/autosync.js';
import { canAttemptGoogleAction } from '../sync/googleauth.js';
import { getRemoteInfo, getRemoteCounts, countsOf, pushToGoogleDrive, pullFromGoogleDrive } from '../sync/googledrive.js';

// Spend is only ever an estimate: it's computed from the token counts the
// API reports multiplied by list prices baked into ai.js, so it ignores
// discounts, batch pricing, and any price change since. Good enough to spot
// "nudges are costing more than I thought", not an invoice.
async function renderUsage() {
const el = document.getElementById('usage-summary');
if (!el) return;
const settings = await getLocalSettings();
const month = currentMonthKey();
const { rows, totalCost, anyUnpriced } = summarizeUsage(settings.apiUsage, month);
if (rows.length === 0) {
el.innerHTML = '<div class="settings-note" style="margin:0;">No API calls yet this month.</div>';
return;
}
const fmt = (n) => n.toLocaleString();
el.innerHTML = `<table class="usage-table">
<thead><tr><th>What</th><th>Calls</th><th>In</th><th>Out</th><th>Est. cost</th></tr></thead>
<tbody>
${rows.map((r) => `<tr>
<td>${escapeHtml(r.purpose)}<span class="usage-model">${escapeHtml(r.model)}</span></td>
<td>${fmt(r.calls)}</td>
<td>${fmt(r.input)}</td>
<td>${fmt(r.output)}</td>
<td>${r.cost === null ? '&mdash;' : '$' + r.cost.toFixed(2)}</td>
</tr>`).join('')}
</tbody>
<tfoot><tr><td>Total, ${escapeHtml(month)}</td><td></td><td></td><td></td><td>$${totalCost.toFixed(2)}${anyUnpriced ? '+' : ''}</td></tr></tfoot>
</table>
<div class="settings-note" style="margin:6px 0 0;">Estimated from reported token counts at list prices${anyUnpriced ? ', excluding models with no price on file' : ''}. Counted on this device only.</div>`;
}

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

initLiveSync(settings);
initFetchPrefs();

const sensitiveToggle = document.getElementById('sensitive-fields-toggle');
sensitiveToggle.checked = !!settings.showSensitiveFields;
sensitiveToggle.addEventListener('change', async () => {
await setLocalSetting('showSensitiveFields', sensitiveToggle.checked);
setShowSensitiveFields(sensitiveToggle.checked);
renderAll();
});

document.getElementById('refresh-usage-btn').addEventListener('click', renderUsage);
await renderUsage();

initDriveBackup();
}

// These live in the synced document rather than device settings, so they go
// through queueSave() like any other data edit.
function initFetchPrefs() {
[['pref-cal-count', 'calendarEventCount'], ['pref-mail-count', 'mailResultCount']].forEach(([id, key]) => {
const el = document.getElementById(id);
el.value = data.prefs[key];
el.addEventListener('change', () => {
// A blank or nonsense entry falls back to 1 rather than writing NaN
// into the document and breaking the next fetch.
const parsed = parseInt(el.value, 10);
const value = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
data.prefs[key] = value;
el.value = value;
renderCalendarLimits(); // its placeholder shows the default
queueSave();
});
});

renderCalendarLimits();
renderMailSearches();
document.getElementById('add-mail-search-btn').addEventListener('click', () => {
data.mailSearches.push({ id: uid(), kind: 'from', value: '', maxDays: 0, maxEvents: 0 });
renderMailSearches();
queueSave();
});
}

// One editable row per mail search: what to look for, and its own caps.
function renderMailSearches() {
const el = document.getElementById('mail-searches');
if (!el) return;
if (data.mailSearches.length === 0) {
el.innerHTML = '<div class="settings-note" style="margin:0;">No searches yet — the Mail panel will be empty until you add one.</div>';
return;
}
el.innerHTML = `<table class="limits-table">
<thead><tr><th>Search</th><th></th><th>Max days</th><th>Max results</th><th></th></tr></thead>
<tbody>${data.mailSearches.map((s) => {
const needsValue = MAIL_SEARCH_KINDS.find((k) => k.kind === s.kind)?.needsValue;
return `<tr>
<td><select data-search-field="kind" data-search-id="${s.id}">
${MAIL_SEARCH_KINDS.map((k) => `<option value="${k.kind}"${k.kind === s.kind ? ' selected' : ''}>${escapeHtml(k.label)}</option>`).join('')}
</select></td>
<td><input type="text" data-search-field="value" data-search-id="${s.id}" value="${escapeHtml(s.value)}" placeholder="${needsValue ? 'e.g. a@gmail.com' : '—'}"${needsValue ? '' : ' disabled'}></td>
<td><input type="number" min="0" max="365" data-search-field="maxDays" data-search-id="${s.id}" value="${s.maxDays || ''}" placeholder="any"></td>
<td><input type="number" min="0" max="50" data-search-field="maxEvents" data-search-id="${s.id}" value="${s.maxEvents || ''}" placeholder="${data.prefs.mailResultCount}"></td>
<td><span class="del-x" style="opacity:1;" data-del-search="${s.id}">&times;</span></td>
</tr>`;
}).join('')}</tbody>
</table>
<div class="settings-note" style="margin:6px 0 0;">Blank means no day limit, and the default result count. Applies next time you press "Refresh mail".</div>`;

el.querySelectorAll('[data-search-field]').forEach((input) => {
input.addEventListener('change', () => {
const search = data.mailSearches.find((s) => s.id === input.dataset.searchId);
if (!search) return;
const field = input.dataset.searchField;
if (field === 'maxDays' || field === 'maxEvents') {
const parsed = parseInt(input.value, 10);
search[field] = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
input.value = search[field] || '';
} else {
search[field] = input.value;
// Switching kind changes whether the value box applies at all.
if (field === 'kind') renderMailSearches();
}
queueSave();
});
});
el.querySelectorAll('[data-del-search]').forEach((x) => {
x.addEventListener('click', () => {
data.mailSearches = data.mailSearches.filter((s) => s.id !== x.dataset.delSearch);
renderMailSearches();
queueSave();
});
});
}

// The URL/secret pair is saved as you type (debounced), but syncing only
// (re)starts when you press Test — otherwise a half-typed URL would fire a
// stream of failing requests on every keystroke.
function initLiveSync(settings) {
const urlInput = document.getElementById('sync-url-input');
const secretInput = document.getElementById('sync-secret-input');
const testBtn = document.getElementById('sync-test-btn');
const status = document.getElementById('sync-test-status');
urlInput.value = settings.syncUrl || '';
secretInput.value = settings.syncSecret || '';

let saveTimer = null;
const queueFieldSave = () => {
clearTimeout(saveTimer);
saveTimer = setTimeout(() => {
setLocalSetting('syncUrl', urlInput.value.trim());
setLocalSetting('syncSecret', secretInput.value.trim());
}, 400);
};
urlInput.addEventListener('input', queueFieldSave);
secretInput.addEventListener('input', queueFieldSave);

const say = (text, kind) => {
status.textContent = text;
status.className = `sync-result${kind ? ' ' + kind : ''}`;
};

testBtn.addEventListener('click', async () => {
clearTimeout(saveTimer);
const url = urlInput.value.trim();
const secret = secretInput.value.trim();
await setLocalSetting('syncUrl', url);
await setLocalSetting('syncSecret', secret);
if (!url || !secret) {
say('Live sync turned off — both boxes need a value.', 'error');
return;
}
if (!url.startsWith('https://') && !url.startsWith('http://localhost')) {
say('Use an https:// URL — browsers block insecure requests from the hosted app.', 'error');
return;
}
testBtn.disabled = true;
say('Testing…');
try {
const remote = await pullRemote();
say(remote.data === null
? 'Connected. Server is empty — this device\'s data will be uploaded now.'
: `Connected. Server has revision ${remote.rev}, last saved ${remote.updatedAt ? new Date(remote.updatedAt).toLocaleString() : 'unknown'}.`, 'ok');
await restartAutoSync();
} catch (err) {
say(err.message || String(err), 'error');
console.error('Live sync test failed:', err);
} finally {
testBtn.disabled = false;
}
});
}

function summarizeCounts(d) {
return `${d.connections.length} connection${d.connections.length === 1 ? '' : 's'}, ${d.habits.length} habit${d.habits.length === 1 ? '' : 's'}, ${d.goals.length} goal${d.goals.length === 1 ? '' : 's'}, ${d.jobs.length} job${d.jobs.length === 1 ? '' : 's'}, ${d.vouchers.length} voucher${d.vouchers.length === 1 ? '' : 's'}, ${d.businessIdeas.length} idea${d.businessIdeas.length === 1 ? '' : 's'}`;
}

// Sign in/out lives in features/googleaccount.js (top of Overview) — this
// just does the Drive-specific data actions, checking canAttemptGoogleAction()
// itself so clicking Push/Pull with no prior connection at all fails with a
// clear message, while a merely-expired token still gets a real attempt
// (see that function's comment for why).
function initDriveBackup() {
const statusEl = document.getElementById('drive-sync-status');
const pushBtn = document.getElementById('sync-push-btn');
const pullBtn = document.getElementById('sync-pull-btn');

pushBtn.addEventListener('click', async () => {
if (!(await canAttemptGoogleAction())) { statusEl.textContent = 'Sign in to Google at the top of Overview first.'; return; }
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
} catch (err) {
statusEl.textContent = `Push failed: ${err.message || err}`;
console.error('Google Drive push failed:', err);
} finally {
pushBtn.disabled = false;
}
});

pullBtn.addEventListener('click', async () => {
if (!(await canAttemptGoogleAction())) { statusEl.textContent = 'Sign in to Google at the top of Overview first.'; return; }
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
} catch (err) {
statusEl.textContent = `Pull failed: ${err.message || err}`;
console.error('Google Drive pull failed:', err);
} finally {
pullBtn.disabled = false;
}
});
}

export { initSettings };
