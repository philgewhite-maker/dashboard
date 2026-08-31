import { data, queueSave, getLocalSettings, setLocalSetting, exportBackup, importBackup, MAIL_SEARCH_KINDS } from '../state.js';
import { renderAll } from '../render-all.js';
import { escapeHtml, uid } from '../utils.js';
import { renderCalendarLimits } from './calendars.js';
import { renderTagCleanup } from './tagcleanup.js';
import { testConnection, resolveDataSourceId } from '../notion.js';
import { summarizeUsage, currentMonthKey } from '../ai.js';
import { setShowSensitiveFields } from './connections.js';
import { pullRemote } from '../sync/selfhost.js';
import { restartAutoSync } from '../sync/autosync.js';
import { canAttemptGoogleAction, refreshScopes } from '../sync/googleauth.js';
import { getRemoteInfo, getRemoteCounts, countsOf, pushToGoogleDrive, pullFromGoogleDrive } from '../sync/googledrive.js';
import { phoneKey, emailKey, nameKey } from '../googlecontacts.js';

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

// Finds connections that ended up holding YOUR OWN details instead of the
// match's -- confirmed live as a real bug: a phone number typed in chat to
// arrange a date got saved as the match's phone, which then auto-linked
// the connection to the user's own Google Contact on the next sync,
// pulling in their own name (as an alias) and address too. Only ever
// checks fields you've actually filled in above -- an empty myPhone can't
// false-positive-match a connection with no phone either, both keys
// non-empty already, but this keeps the intent explicit.
function findSelfInfoLeaks() {
const myPhone = phoneKey(data.myPhone);
const myEmail = emailKey(data.myEmail);
const myAddress = String(data.myAddress || '').trim().toLowerCase();
const myName = nameKey(data.myName);
if (!myPhone && !myEmail && !myAddress && !myName) return [];
const hits = [];
data.connections.forEach((c) => {
const fields = new Set();
if (myPhone && phoneKey(c.phone) === myPhone) fields.add('phone');
if (myEmail && emailKey(c.email) === myEmail) fields.add('email');
if (myAddress && String(c.address || '').trim().toLowerCase() === myAddress) fields.add('address');
if (myName && (c.aliases || []).some((a) => nameKey(a) === myName)) fields.add('aliases');
// contactConflicts is a snapshot taken at match/sync time -- a field can
// already have been cleared or overwritten since, while the leak is
// still sitting in the "mine" side of a pending conflict, invisible to
// the checks above (confirmed live: a connection's phone no longer held
// the user's own number, but its stale conflict box still offered
// "Keep <the leaked number>").
(c.contactConflicts || []).forEach((k) => {
if (k.field === 'phone' && myPhone && phoneKey(k.mine) === myPhone) fields.add('phone');
if (k.field === 'email' && myEmail && emailKey(k.mine) === myEmail) fields.add('email');
});
if (fields.size) hits.push({ conn: c, fields: [...fields] });
});
return hits;
}

function renderSelfInfoCheck() {
const el = document.getElementById('self-info-check');
if (!el) return;
const hits = findSelfInfoLeaks();
if (!hits.length) {
el.innerHTML = '<div class="settings-note" style="margin:0;">Nothing found.</div>';
return;
}
el.innerHTML = hits.map(({ conn, fields }) => `<div class="cleanup-section" style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
<span><strong>${escapeHtml(conn.name)}</strong> &mdash; ${fields.map(escapeHtml).join(', ')}</span>
<button class="sync-btn sm" type="button" data-clear-selfinfo="${escapeHtml(conn.id)}" data-clear-fields="${escapeHtml(fields.join(','))}">Clear</button>
</div>`).join('');
el.querySelectorAll('[data-clear-selfinfo]').forEach((btn) => {
btn.addEventListener('click', () => {
const conn = data.connections.find((c) => c.id === btn.dataset.clearSelfinfo);
if (!conn) return;
btn.dataset.clearFields.split(',').forEach((f) => {
if (f === 'aliases') {
const myName = nameKey(data.myName);
conn.aliases = (conn.aliases || []).filter((a) => nameKey(a) !== myName);
} else {
conn[f] = '';
}
});
// The auto-link itself is how the alias/address got here in the first
// place, not just the field that seeded it -- resetting it means a
// re-sync looks for the real match instead of re-applying the same
// wrong one straight back.
conn.contactStatus = '';
conn.contactResourceName = '';
conn.contactEtag = '';
conn.contactMatchedBy = '';
// The link that produced these is what's just been reset — any pending
// conflicts against it are moot, and left alone they'd keep showing a
// "Differs from Google Contacts" prompt for a link that no longer exists.
conn.contactConflicts = [];
queueSave();
renderSelfInfoCheck();
Promise.all([import('./connections.js'), import('./overview.js')]).then(([c, o]) => { c.renderConnections(); o.renderOverview(); });
});
});
}

async function initSettings() {
// Same debounced-save pattern for every "my own info" field -- one loop
// instead of five near-identical listener blocks.
[
['my-city-input', 'myCity'],
['my-name-input', 'myName'],
['my-phone-input', 'myPhone'],
['my-email-input', 'myEmail'],
['my-address-input', 'myAddress'],
].forEach(([id, key]) => {
const input = document.getElementById(id);
if (!input) return;
input.value = data[key] || '';
let timer = null;
input.addEventListener('input', () => {
clearTimeout(timer);
timer = setTimeout(() => { data[key] = input.value.trim(); queueSave(); renderSelfInfoCheck(); }, 400);
});
});
renderSelfInfoCheck();
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
initNotion(settings);
initFetchPrefs();
renderTagCleanup();

// Changing the Contacts scope invalidates the current token, so this can't
// take effect until you sign in again — say so rather than leaving you to
// wonder why the write button still isn't there.
const contactsWrite = document.getElementById('contacts-write-toggle');
const contactsWriteNote = document.getElementById('contacts-write-note');
contactsWrite.checked = !!settings.contactsWriteEnabled;
contactsWrite.addEventListener('change', async () => {
await setLocalSetting('contactsWriteEnabled', contactsWrite.checked);
await refreshScopes();
contactsWriteNote.textContent = contactsWrite.checked
? 'Sign out and back in to grant the write permission — Google won\'t widen a token that\'s already been issued.'
: 'Sign out and back in to drop the write permission.';
});

// Same shape as Contacts write above -- see its own comment for why
// changing this can't take effect until a fresh sign-in.
const calendarWrite = document.getElementById('calendar-write-toggle');
const calendarWriteNote = document.getElementById('calendar-write-note');
calendarWrite.checked = !!settings.calendarWriteEnabled;
calendarWrite.addEventListener('change', async () => {
await setLocalSetting('calendarWriteEnabled', calendarWrite.checked);
await refreshScopes();
calendarWriteNote.textContent = calendarWrite.checked
? 'Sign out and back in to grant the write permission — Google won\'t widen a token that\'s already been issued.'
: 'Sign out and back in to drop the write permission.';
});

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

// The Notion proxy URL and database id, and a test that proves all three
// links in the chain — this device reaching your host, your host holding a
// valid token, and the database actually being shared with the integration.
function initNotion(settings) {
const urlInput = document.getElementById('notion-url-input');
const dbInput = document.getElementById('notion-db-input');
const testBtn = document.getElementById('notion-test-btn');
const status = document.getElementById('notion-test-status');
urlInput.value = settings.notionProxyUrl || '';
dbInput.value = settings.notionDatabaseId || '';

const say = (text, kind) => {
status.textContent = text;
status.className = `sync-result${kind ? ' ' + kind : ''}`;
};

let timer = null;
const queueFieldSave = () => {
clearTimeout(timer);
timer = setTimeout(async () => {
await setLocalSetting('notionProxyUrl', urlInput.value.trim());
const db = dbInput.value.trim();
const prev = (await getLocalSettings()).notionDatabaseId || '';
await setLocalSetting('notionDatabaseId', db);
// The data source id is derived from the database, so a new database
// invalidates it — otherwise pages would keep going to the old one.
if (db !== prev) await setLocalSetting('notionDataSourceId', '');
}, 400);
};
urlInput.addEventListener('input', queueFieldSave);
dbInput.addEventListener('input', queueFieldSave);

testBtn.addEventListener('click', async () => {
clearTimeout(timer);
await setLocalSetting('notionProxyUrl', urlInput.value.trim());
await setLocalSetting('notionDatabaseId', dbInput.value.trim());
await setLocalSetting('notionDataSourceId', '');
testBtn.disabled = true;
say('Testing…');
try {
const who = await testConnection();
if (dbInput.value.trim()) {
await resolveDataSourceId();
say(`Connected as "${who}", and the database is reachable.`, 'ok');
} else {
say(`Connected as "${who}". Add a database ID to create pages.`, 'ok');
}
} catch (err) {
say(err.message || String(err), 'error');
console.error('Notion test failed:', err);
} finally {
testBtn.disabled = false;
}
});
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
<td><input type="text" autocomplete="off" data-search-field="value" data-search-id="${s.id}" value="${escapeHtml(s.value)}" placeholder="${needsValue ? 'e.g. a@gmail.com' : '—'}"${needsValue ? '' : ' disabled'}></td>
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
