import { data, queueSave, getLocalSettings, setLocalSetting, exportBackup, importBackup, MAIL_SEARCH_KINDS, MEDIA_KINDS, blankMailSearch, blankMailTopic, blankMailRule } from '../state.js';
import { renderAll } from '../render-all.js';
import { escapeHtml, uid } from '../utils.js';
import { renderCalendarLimits } from './calendars.js';
import { renderPackingModules, bindPackingModules } from './packing.js';
import { renderTagCleanup } from './tagcleanup.js';
import { testConnection, resolveDataSourceId } from '../notion.js';
import { summarizeUsage, currentMonthKey } from '../ai.js';
import { setShowSensitiveFields } from './connections.js';
import { pullRemote } from '../sync/selfhost.js';
import { restartAutoSync } from '../sync/autosync.js';
import { canAttemptGoogleAction, refreshScopes } from '../sync/googleauth.js';
import { getRemoteInfo, getRemoteCounts, countsOf, pushToGoogleDrive, pullFromGoogleDrive } from '../sync/googledrive.js';
import { phoneKey, emailKey, nameKey } from '../googlecontacts.js';
import { CAPTURE_OUTCOMES, outcomeLabelWithCost } from './captureOutcomes.js';
import { MAIL_ACTIONS } from './mailActions.js';

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

const tmdbInput = document.getElementById('tmdb-key-input');
if (tmdbInput) {
tmdbInput.value = settings.tmdbApiKey || '';
let tmdbTimer = null;
tmdbInput.addEventListener('input', () => {
clearTimeout(tmdbTimer);
tmdbTimer = setTimeout(() => setLocalSetting('tmdbApiKey', tmdbInput.value.trim()), 400);
});
}

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
initTelegramBotUrl(settings);
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

// Same shape again -- lets "Pull from Google Tasks" clean up after
// itself (delete a task once it's safely captured here) instead of
// leaving a stray duplicate in Google Tasks forever.
const tasksWrite = document.getElementById('tasks-write-toggle');
const tasksWriteNote = document.getElementById('tasks-write-note');
tasksWrite.checked = !!settings.tasksWriteEnabled;
tasksWrite.addEventListener('change', async () => {
await setLocalSetting('tasksWriteEnabled', tasksWrite.checked);
await refreshScopes();
tasksWriteNote.textContent = tasksWrite.checked
? 'Sign out and back in to grant the write permission — Google won\'t widen a token that\'s already been issued.'
: 'Sign out and back in to drop the write permission.';
});

const sensitiveToggle = document.getElementById('sensitive-fields-toggle');
sensitiveToggle.checked = !!settings.showSensitiveFields;
sensitiveToggle.addEventListener('change', async () => {
await setLocalSetting('showSensitiveFields', sensitiveToggle.checked);
setShowSensitiveFields(sensitiveToggle.checked);
// The Shopping tab's inventory panel respects the same gate but
// isn't part of renderAll, so it needs telling directly.
import("./shopping.js").then((m) => m.renderInventory());
renderAll();
});

document.getElementById('refresh-usage-btn').addEventListener('click', renderUsage);
await renderUsage();

initDriveBackup();
initPairing();
initEncryption();
initTickerSettings();
initDocSize();
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
renderPackingModules();
bindPackingModules();
renderMailTopics();
document.getElementById('add-mail-topic-btn').addEventListener('click', () => {
data.mailTopics.push(blankMailTopic());
renderMailTopics();
renderMailSearches(); // new topic needs to show up in every search's <select>
queueSave();
});
renderMailSearches();
document.getElementById('add-mail-search-btn').addEventListener('click', () => {
data.mailSearches.push(blankMailSearch({ kind: 'from' }));
renderMailSearches();
queueSave();
});

renderMailRules();
const addMailRuleBtn = document.getElementById('add-mail-rule-btn');
if (addMailRuleBtn) addMailRuleBtn.addEventListener('click', () => {
data.mailRules.push(blankMailRule());
renderMailRules();
queueSave();
});

renderMailBin();
const emptyBinBtn = document.getElementById('empty-mail-bin-btn');
if (emptyBinBtn) emptyBinBtn.addEventListener('click', () => {
if (!data.mailDismissed.length) return;
if (!confirm(`Empty the bin? This removes the record of ${data.mailDismissed.length} dismissed message${data.mailDismissed.length === 1 ? '' : 's'} -- next time you refresh Mail, any still within a search's own limits will show up again.`)) return;
data.mailDismissed = [];
renderMailBin();
queueSave();
});

renderShareUrlRules();
renderMediaRoutes();
const addRuleBtn = document.getElementById('add-share-rule-btn');
if (addRuleBtn) addRuleBtn.addEventListener('click', () => {
data.prefs.shareUrlRules = data.prefs.shareUrlRules || [];
data.prefs.shareUrlRules.push({ id: uid(), host: '', path: '', action: Object.keys(CAPTURE_OUTCOMES)[0] });
renderShareUrlRules();
queueSave();
});

renderCaptureRules();
const addCaptureRuleBtn = document.getElementById('add-capture-rule-btn');
if (addCaptureRuleBtn) addCaptureRuleBtn.addEventListener('click', () => {
data.prefs.captureRules = data.prefs.captureRules || [];
data.prefs.captureRules.push({ id: uid(), inputMethod: 'imageMarker', trigger: '', outcome: Object.keys(CAPTURE_OUTCOMES)[0] });
renderCaptureRules();
queueSave();
});
}

const CAPTURE_INPUT_METHODS = [
{ value: 'imageMarker', label: 'Image marker' },
{ value: 'urlSuffix', label: 'URL suffix' },
{ value: 'emailSubject', label: 'Email subject' },
];

// ✨ = this outcome always calls AI when it runs; 🪄 = it tries something
// One editable row per explicit capture trigger. See captureOutcomes.js's
// matchCaptureRule -- reads as "when [input method] shows [trigger],
// create a [outcome]." A bare letter, not a "#letter" or a colour: the
// URL parser strips the "#" itself, and the vision scan is asked for
// the letter alone (see ai.js's scanForCaptureMarker), so one trigger
// value works for both input methods without translation.
function renderCaptureRules() {
const el = document.getElementById('capture-rules');
if (!el) return;
const rules = data.prefs.captureRules || [];
const outcomeKeys = Object.keys(CAPTURE_OUTCOMES);
const rowsHtml = rules.map((r) => `<tr>
<td><select data-capture-rule-field="inputMethod" data-capture-rule-id="${r.id}">
${CAPTURE_INPUT_METHODS.map((m) => `<option value="${m.value}"${m.value === r.inputMethod ? ' selected' : ''}>${escapeHtml(m.label)}</option>`).join('')}
</select></td>
<td><input type="text" autocomplete="off" maxlength="1" style="width:44px;text-align:center;text-transform:uppercase;" data-capture-rule-field="trigger" data-capture-rule-id="${r.id}" value="${escapeHtml(r.trigger || '')}" placeholder="T"></td>
<td><select data-capture-rule-field="outcome" data-capture-rule-id="${r.id}">
${outcomeKeys.map((k) => `<option value="${k}"${k === r.outcome ? ' selected' : ''}>${escapeHtml(outcomeLabelWithCost(CAPTURE_OUTCOMES[k]))}</option>`).join('')}
</select></td>
<td><span class="del-x" style="opacity:1;" data-del-capture-rule="${r.id}">&times;</span></td>
</tr>`).join('');
el.innerHTML = `${rules.length ? `<table class="limits-table">
<thead><tr><th>Input method</th><th>Trigger</th><th>Creates</th><th></th></tr></thead>
<tbody>${rowsHtml}</tbody>
</table>` : '<div class="settings-note" style="margin:0;">No triggers set — markers and suffixes are ignored.</div>'}
<div class="settings-note" style="margin:6px 0 0;">Image marker: before sharing a photo, draw or highlight the trigger letter somewhere in it (any colour, any corner) — a lone photo with a recognised letter and no other signal (not a dating screenshot, not a health chart) is routed instead of landing in Capture Inbox. URL suffix: add "#" + the trigger letter to the end of a link before sharing it, e.g. "https://example.com/article#R" — this always wins over the domain rules above. Email subject: put "zxc" + the trigger letter in the subject before forwarding/replying (e.g. "zxc D") — space between them, since Mail's own search needs a row that finds the whole word "zxc" for the message to ever reach this app (one row searching for "zxc" catches every marker at once); "Refresh mail" is what actually processes them. Event/Trip leg queue a reviewable draft (Tasks tab, Smart capture) rather than creating anything outright.</div>`;

el.querySelectorAll('[data-capture-rule-field]').forEach((input) => {
input.addEventListener('change', () => {
const rule = (data.prefs.captureRules || []).find((r) => r.id === input.dataset.captureRuleId);
if (!rule) return;
const field = input.dataset.captureRuleField;
rule[field] = field === 'trigger' ? input.value.trim().toUpperCase().slice(0, 1) : input.value;
input.value = rule[field];
queueSave();
});
});
el.querySelectorAll('[data-del-capture-rule]').forEach((x) => {
x.addEventListener('click', () => {
data.prefs.captureRules = (data.prefs.captureRules || []).filter((r) => r.id !== x.dataset.delCaptureRule);
renderCaptureRules();
queueSave();
});
});
}

// Pastes of a full URL are common here -- pull the bits the matcher
// actually uses (host without www., pathname) out of one, so a rule
// entered by pasting "https://www.airbnb.co.uk/rooms/123?x=1" ends up as
// host "airbnb.co.uk" + path "/rooms/".
function normaliseRuleHost(value) {
const v = String(value || '').trim();
try {
const u = new URL(v.includes('://') ? v : `https://${v}`);
return u.hostname.replace(/^www\./, '').toLowerCase();
} catch (e) {
return v.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].toLowerCase();
}
}

// One editable row per shared-link auto-route rule. See
// captureOutcomes.js's CAPTURE_OUTCOMES and sharetarget.js's own
// matchShareRule.
function renderShareUrlRules() {
const el = document.getElementById('share-url-rules');
if (!el) return;
const rules = data.prefs.shareUrlRules || [];
const actionKeys = Object.keys(CAPTURE_OUTCOMES);
const rowsHtml = rules.map((r) => `<tr>
<td><input type="text" autocomplete="off" data-share-rule-field="host" data-share-rule-id="${r.id}" value="${escapeHtml(r.host || '')}" placeholder="example.com"></td>
<td><input type="text" autocomplete="off" data-share-rule-field="path" data-share-rule-id="${r.id}" value="${escapeHtml(r.path || '')}" placeholder="any"></td>
<td><select data-share-rule-field="action" data-share-rule-id="${r.id}">
${actionKeys.map((k) => `<option value="${k}"${k === r.action ? ' selected' : ''}>${escapeHtml(CAPTURE_OUTCOMES[k].label)}</option>`).join('')}
</select></td>
<td><span class="del-x" style="opacity:1;" data-del-share-rule="${r.id}">&times;</span></td>
</tr>`).join('');
el.innerHTML = `${rules.length ? `<table class="limits-table">
<thead><tr><th>Host</th><th>Path contains</th><th>Action</th><th></th></tr></thead>
<tbody>${rowsHtml}</tbody>
</table>` : '<div class="settings-note" style="margin:0;">No rules — every shared link becomes a task.</div>'}
<div class="settings-note" style="margin:6px 0 0;">A link shared to the app whose host (and "path contains", if set) matches runs that action instead of filing a task. Anything that then fails falls back to a task carrying the link and the error.</div>`;

el.querySelectorAll('[data-share-rule-field]').forEach((input) => {
input.addEventListener('change', () => {
const rule = (data.prefs.shareUrlRules || []).find((r) => r.id === input.dataset.shareRuleId);
if (!rule) return;
const field = input.dataset.shareRuleField;
rule[field] = field === 'host' ? normaliseRuleHost(input.value) : input.value.trim();
input.value = rule[field];
queueSave();
});
});
el.querySelectorAll('[data-del-share-rule]').forEach((x) => {
x.addEventListener('click', () => {
data.prefs.shareUrlRules = (data.prefs.shareUrlRules || []).filter((r) => r.id !== x.dataset.delShareRule);
renderShareUrlRules();
queueSave();
});
});
}

// One table per media kind: the ordered list of ways a want can be
// satisfied. Mirrors renderShareUrlRules above -- same edit-in-place
// table, same change-to-save, same delete cross -- rather than a second
// style of rules editor.
function renderMediaRoutes() {
const el = document.getElementById('media-routes-editor');
if (!el) return;
const routes = data.prefs.mediaRoutes || {};
const TYPES = [
{ type: 'stream', label: 'Watch on a subscribed service' },
{ type: 'buy', label: 'Buy (adds a shopping item)' },
{ type: 'search', label: 'Search somewhere' },
{ type: 'download', label: 'Request a download' },
];
el.innerHTML = MEDIA_KINDS.map((k) => {
const list = routes[k.kind] || [];
const rows = list.map((r) => `<tr>
<td><input type="text" autocomplete="off" data-route-field="label" data-route-kind="${k.kind}" data-route-id="${r.id}" value="${escapeHtml(r.label || '')}" placeholder="What this offers"></td>
<td><select data-route-field="type" data-route-kind="${k.kind}" data-route-id="${r.id}">
${TYPES.map((t) => `<option value="${t.type}"${t.type === r.type ? ' selected' : ''}>${escapeHtml(t.label)}</option>`).join('')}
</select></td>
<td><input type="text" autocomplete="off" data-route-field="${r.type === 'download' ? 'profile' : r.type === 'buy' ? 'context' : 'urlTemplate'}" data-route-kind="${k.kind}" data-route-id="${r.id}" value="${escapeHtml(r.urlTemplate || r.profile || r.context || '')}" placeholder="${r.type === 'download' ? 'quality profile name' : r.type === 'buy' ? 'shopping context' : 'https://…/search?q={q}'}"></td>
<td><span class="del-x" style="opacity:1;" data-del-route="${r.id}" data-route-kind="${k.kind}">&times;</span></td>
</tr>`).join('');
return `<h4 style="margin:12px 0 4px;font-size:14px;">${escapeHtml(k.label)}</h4>
${list.length ? `<table class="limits-table">
<thead><tr><th>Offers</th><th>Does what</th><th>Where / profile</th><th></th></tr></thead>
<tbody>${rows}</tbody></table>` : '<div class="settings-note" style="margin:0;">No routes — the Get… button will say so.</div>'}
<button class="todo-add-btn" type="button" data-add-route="${k.kind}">+ Add a route</button>`;
}).join('');

el.querySelectorAll('[data-route-field]').forEach((input) => {
input.addEventListener('change', () => {
const list = (data.prefs.mediaRoutes || {})[input.dataset.routeKind] || [];
const route = list.find((r) => r.id === input.dataset.routeId);
if (!route) return;
route[input.dataset.routeField] = input.value.trim();
queueSave();
// A type change swaps which third column applies, so the table is
// rebuilt rather than left showing the previous type's field.
if (input.dataset.routeField === 'type') renderMediaRoutes();
});
});
el.querySelectorAll('[data-del-route]').forEach((x) => {
x.addEventListener('click', () => {
const kind = x.dataset.routeKind;
data.prefs.mediaRoutes[kind] = (data.prefs.mediaRoutes[kind] || []).filter((r) => r.id !== x.dataset.delRoute);
queueSave();
renderMediaRoutes();
});
});
el.querySelectorAll('[data-add-route]').forEach((btn) => {
btn.addEventListener('click', () => {
const kind = btn.dataset.addRoute;
if (!Array.isArray(data.prefs.mediaRoutes[kind])) data.prefs.mediaRoutes[kind] = [];
data.prefs.mediaRoutes[kind].push({ id: uid(), type: 'search', label: '', urlTemplate: '' });
queueSave();
renderMediaRoutes();
});
});
}

// One editable row per mail topic: a label, and up to 3 ticked "preferred"
// actions from MAIL_ACTIONS (js/features/mailActions.js) -- what a mail
// search's topicId (set in the Mail searches table below) actually buys
// it. Same "table row = record, del-x per row, one generic change-
// listener" shape as renderShareUrlRules/renderCaptureRules above.
function renderMailTopics() {
const el = document.getElementById('mail-topics');
if (!el) return;
if (data.mailTopics.length === 0) {
el.innerHTML = '<div class="settings-note" style="margin:0;">No topics yet — every mail search renders on its own, same as before topics existed.</div>';
return;
}
// 'addRule' is deliberately excluded here -- "create a rule" isn't a
// sensible thing to promote to a topic's own quick-action row; it still
// shows in every message's "Other actions" regardless (mail.js).
const actionKeys = Object.keys(MAIL_ACTIONS).filter((k) => k !== 'addRule');
el.innerHTML = `<table class="limits-table">
<thead><tr><th>Topic</th><th>Preferred actions (up to 3)</th><th></th></tr></thead>
<tbody>${data.mailTopics.map((t) => `<tr>
<td><input type="text" autocomplete="off" data-topic-field="label" data-topic-id="${t.id}" value="${escapeHtml(t.label || '')}" placeholder="e.g. Travel"></td>
<td>${actionKeys.map((k) => `<label style="display:inline-flex;align-items:center;gap:4px;margin-right:10px;font-size:12px;font-weight:400;">
<input type="checkbox" data-topic-action="${k}" data-topic-id="${t.id}"${t.preferredActionIds.includes(k) ? ' checked' : ''}>
${escapeHtml(MAIL_ACTIONS[k].label)}
</label>`).join('')}</td>
<td><span class="del-x" style="opacity:1;" data-del-topic="${t.id}">&times;</span></td>
</tr>`).join('')}</tbody>
</table>`;

el.querySelectorAll('[data-topic-field]').forEach((input) => {
input.addEventListener('change', () => {
const topic = data.mailTopics.find((t) => t.id === input.dataset.topicId);
if (!topic) return;
topic[input.dataset.topicField] = input.value.trim();
queueSave();
renderMailSearches(); // topic <select> options show its label
});
});
el.querySelectorAll('[data-topic-action]').forEach((cb) => {
cb.addEventListener('change', () => {
const topic = data.mailTopics.find((t) => t.id === cb.dataset.topicId);
if (!topic) return;
const actionId = cb.dataset.topicAction;
if (cb.checked) {
// Silently revert rather than a popup -- the box itself unticking
// again is feedback enough for "no, that's the 3rd already".
if (topic.preferredActionIds.length >= 3) { cb.checked = false; return; }
topic.preferredActionIds.push(actionId);
} else {
topic.preferredActionIds = topic.preferredActionIds.filter((id) => id !== actionId);
}
queueSave();
});
});
el.querySelectorAll('[data-del-topic]').forEach((x) => {
x.addEventListener('click', () => {
const id = x.dataset.delTopic;
data.mailTopics = data.mailTopics.filter((t) => t.id !== id);
// A search pointed at the deleted topic falls back to rendering on
// its own, same as it would for a topic it was never assigned.
data.mailSearches.forEach((s) => { if (s.topicId === id) s.topicId = ''; });
renderMailTopics();
renderMailSearches();
queueSave();
});
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
<thead><tr><th>Search</th><th></th><th>Topic</th><th>Max days</th><th>Max results</th><th></th></tr></thead>
<tbody>${data.mailSearches.map((s) => {
const needsValue = MAIL_SEARCH_KINDS.find((k) => k.kind === s.kind)?.needsValue;
return `<tr>
<td><select data-search-field="kind" data-search-id="${s.id}">
${MAIL_SEARCH_KINDS.map((k) => `<option value="${k.kind}"${k.kind === s.kind ? ' selected' : ''}>${escapeHtml(k.label)}</option>`).join('')}
</select></td>
<td><input type="text" autocomplete="off" data-search-field="value" data-search-id="${s.id}" value="${escapeHtml(s.value)}" placeholder="${needsValue ? 'e.g. a@gmail.com' : '—'}"${needsValue ? '' : ' disabled'}></td>
<td><select data-search-field="topicId" data-search-id="${s.id}">
<option value=""${s.topicId ? '' : ' selected'}>— none —</option>
${data.mailTopics.map((t) => `<option value="${t.id}"${t.id === s.topicId ? ' selected' : ''}>${escapeHtml(t.label || 'Untitled topic')}</option>`).join('')}
</select></td>
<td><input type="number" min="0" max="365" data-search-field="maxDays" data-search-id="${s.id}" value="${s.maxDays || ''}" placeholder="any"></td>
<td><input type="number" min="0" max="50" data-search-field="maxEvents" data-search-id="${s.id}" value="${s.maxEvents || ''}" placeholder="${data.prefs.mailResultCount}"></td>
<td><span class="del-x" style="opacity:1;" data-del-search="${s.id}">&times;</span></td>
</tr>`;
}).join('')}</tbody>
</table>
<div class="settings-note" style="margin:6px 0 0;">Blank means no day limit, and the default result count. Topic groups this search with any others sharing it in the Mail panel and picks its preferred action buttons (set topics above) — leave as "— none —" for a search to keep rendering on its own. A message already turned into a task/trip leg/date event doesn't count against the max — it's tucked into a collapsed "already processed" list under the heading instead. Applies next time you press "Refresh mail".</div>`;

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

// One editable row per mail rule (js/state.js's blankMailRule) -- same
// shape as renderCaptureRules above, but matched on from/subject
// substrings rather than a marker/suffix trigger. Normally created from
// a real email via the Mail panel's own "Add rule" action (mail.js); this
// table is for loosening/retiring one afterward without having to find
// that email again.
function renderMailRules() {
const el = document.getElementById('mail-rules');
if (!el) return;
if (data.mailRules.length === 0) {
el.innerHTML = '<div class="settings-note" style="margin:0;">No rules yet — create one from a real email via Mail\'s own "⋯ Other actions" → "+ rule".</div>';
return;
}
const outcomeKeys = Object.keys(CAPTURE_OUTCOMES);
const rowsHtml = data.mailRules.map((r) => `<tr>
<td><input type="text" autocomplete="off" data-mailrule-field="label" data-mailrule-id="${r.id}" value="${escapeHtml(r.label || '')}" placeholder="Label"></td>
<td><input type="text" autocomplete="off" data-mailrule-field="from" data-mailrule-id="${r.id}" value="${escapeHtml(r.from || '')}" placeholder="From contains…"></td>
<td><input type="text" autocomplete="off" data-mailrule-field="subject" data-mailrule-id="${r.id}" value="${escapeHtml(r.subject || '')}" placeholder="Subject contains…"></td>
<td><select data-mailrule-field="outcome" data-mailrule-id="${r.id}">
${outcomeKeys.map((k) => `<option value="${k}"${k === r.outcome ? ' selected' : ''}>${escapeHtml(outcomeLabelWithCost(CAPTURE_OUTCOMES[k]))}</option>`).join('')}
</select></td>
<td><span class="del-x" style="opacity:1;" data-del-mailrule="${r.id}">&times;</span></td>
</tr>`).join('');
el.innerHTML = `<table class="limits-table">
<thead><tr><th>Label</th><th>From contains</th><th>Subject contains</th><th>Creates</th><th></th></tr></thead>
<tbody>${rowsHtml}</tbody>
</table>
<div class="settings-note" style="margin:6px 0 0;">Runs automatically on every "Refresh mail" against every open (not yet processed) message — both From and Subject must match when both are set; leave one blank to match on the other alone. Event/Trip leg queue a reviewable draft (Tasks tab, Smart capture) rather than creating anything outright.</div>`;

el.querySelectorAll('[data-mailrule-field]').forEach((input) => {
input.addEventListener('change', () => {
const rule = data.mailRules.find((r) => r.id === input.dataset.mailruleId);
if (!rule) return;
rule[input.dataset.mailruleField] = input.value;
queueSave();
});
});
el.querySelectorAll('[data-del-mailrule]').forEach((x) => {
x.addEventListener('click', () => {
data.mailRules = data.mailRules.filter((r) => r.id !== x.dataset.delMailrule);
renderMailRules();
queueSave();
});
});
}

// Read-only -- no per-item restore (see the "Mail bin" settings-note: the
// real email still exists, and a search's own window may have moved past
// it by now anyway), just a record of what's already been looked at and
// skipped. "Empty bin" (wired in initSettings) is the only way anything
// leaves this list.
function renderMailBin() {
const el = document.getElementById('mail-bin');
if (!el) return;
if (!data.mailDismissed.length) {
el.innerHTML = '<div class="settings-note" style="margin:0;">Nothing dismissed yet.</div>';
return;
}
const rows = [...data.mailDismissed].sort((a, b) => new Date(b.dismissedAt) - new Date(a.dismissedAt));
el.innerHTML = `<table class="limits-table">
<thead><tr><th>Subject</th><th>From</th><th>Dismissed</th></tr></thead>
<tbody>${rows.map((d) => `<tr>
<td><a href="${escapeHtml(d.url)}" target="_blank" rel="noopener">${escapeHtml(d.subject || '(no subject)')}</a></td>
<td>${escapeHtml(d.from || '')}</td>
<td>${escapeHtml(new Date(d.dismissedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }))}</td>
</tr>`).join('')}</tbody>
</table>`;
}

// The URL/secret pair is saved as you type (debounced), but syncing only
// (re)starts when you press Test — otherwise a half-typed URL would fire a
// stream of failing requests on every keystroke.
// Just the URL -- the secret is the same one Live sync above already
// stores/saves, see telegramfamily.js's own botConfig().
function initTelegramBotUrl(settings) {
const urlInput = document.getElementById('telegrambot-url-input');
if (!urlInput) return;
urlInput.value = settings.telegramBotUrl || '';
let saveTimer = null;
urlInput.addEventListener('input', () => {
clearTimeout(saveTimer);
saveTimer = setTimeout(() => setLocalSetting('telegramBotUrl', urlInput.value.trim()), 400);
});
}

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

// Hands the pair to the Dashboard Capture Android app (android-relay/).
// package= pins the intent to that one app, so nothing else registering
// the same scheme can receive the secret; the app only prefills its form,
// and saving there is a separate tap.
document.getElementById('relay-setup-btn').addEventListener('click', () => {
const url = urlInput.value.trim();
const secret = secretInput.value.trim();
if (!url || !secret) {
say('Fill in the sync URL and secret first.', 'error');
return;
}
const q = new URLSearchParams({ sync: url, secret, dashboard: new URL('index.html', location.href).href });
say('Opening Dashboard Capture — check the server there and tap Save. (Only works on Android with the app installed.)');
location.href = `intent://setup?${q}#Intent;scheme=dashboardcapture;package=com.philgewhite.dashboardcapture;end`;
});

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


// ---- Devices --------------------------------------------------------------

function pairAgoText(iso) {
if (!iso) return 'never';
const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
if (mins < 2) return 'just now';
if (mins < 60) return `${mins} min ago`;
const hours = Math.round(mins / 60);
if (hours < 48) return `${hours}h ago`;
return `${Math.round(hours / 24)}d ago`;
}

async function renderDevices(message = '') {
const box = document.getElementById('pair-devices');
const status = document.getElementById('pair-status');
if (!box) return;
if (status && message) status.textContent = message;
let res;
try {
const pairing = await import('../pairing.js');
res = await pairing.listDevices();
} catch (err) {
box.innerHTML = '';
if (status) status.textContent = err.message || String(err);
return;
}
if (status && !message) status.textContent = '';
const settings = await getLocalSettings();
const mine = settings.deviceId || '';
const live = (res.devices || []).filter((d) => !d.revoked);
// The redeem box said "this device hasn't been paired yet" whatever the
// truth was, so a paired device read as both paired and not paired at
// once -- its own row said "(this one)" directly above it. The box still
// has a use once paired (re-pairing after a revoke), so it is reworded
// rather than hidden.
const summary = document.getElementById('pair-redeem-summary');
if (summary) {
summary.textContent = mine
? 'Re-pair this device with a new code'
: 'This device hasn’t been paired yet — enter a code';
}
const rows = (res.devices || []).map((d) => {
const here = d.id === mine;
return `<tr${d.revoked ? ' style="opacity:.55;"' : ''}>
<td>${escapeHtml(d.label || 'A device')}${here ? ' <span class="settings-note" style="display:inline;margin:0;">(this one)</span>' : ''}</td>
<td>${escapeHtml(d.revoked ? 'revoked' : pairAgoText(d.lastSeen))}</td>
<td>${d.revoked ? '' : `<button class="sync-btn sm" type="button" data-revoke-device="${escapeHtml(d.id)}">${here ? 'Sign this device out' : 'Revoke'}</button>`}</td>
</tr>`;
}).join('');
// Whether the shared secret is still a way in is the whole question this
// feature exists to answer, so it is stated rather than left to infer
// from a list of devices.
const secretLine = res.masterSecretAllowed
? `<div class="settings-note" style="margin:6px 0 0;">The shared secret still works${live.length ? ' — once every device you use is listed above, set <code>$DASH_ALLOW_MASTER_SECRET = false</code> in auth.php and any old copy of it stops being a way in' : ''}.</div>`
: '<div class="settings-note" style="margin:6px 0 0;color:var(--sage);">The shared secret has been retired — only the devices above can get in.</div>';
box.innerHTML = `${rows
? `<table class="limits-table"><thead><tr><th>Device</th><th>Last used</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
: '<div class="settings-note" style="margin:0;">No devices paired yet — everything is still using the shared secret.</div>'}
${secretLine}
${(res.devices || []).some((d) => d.revoked) ? '<div class="sync-row" style="margin-top:6px;"><button class="sync-btn sm" type="button" id="pair-forget-btn">Clear revoked rows</button></div>' : ''}`;

box.querySelectorAll('[data-revoke-device]').forEach((btn) => {
btn.addEventListener('click', async () => {
const id = btn.dataset.revokeDevice;
const self = id === mine;
// Revoking the device you are sitting at cuts off your own data,
// which is a reasonable thing to want and a terrible thing to do by
// accident on a list of similar-looking rows.
if (self && !confirm('This is the device you are using. It will stop syncing immediately and will need a new code to pair again. Continue?')) return;
btn.disabled = true;
try {
const pairing = await import('../pairing.js');
await pairing.revokeDevice(id);
if (self) {
await setLocalSetting('syncSecret', '');
await setLocalSetting('deviceId', '');
const secretInput = document.getElementById('sync-secret-input');
if (secretInput) secretInput.value = '';
// Nothing left to ask the server WITH, so re-listing here would
// replace "signed out" with "bad or missing sync secret" -- which is
// true, and reads like a failure rather than the thing you just did.
box.innerHTML = '';
if (status) status.textContent = 'Signed out. Pair this device again with a fresh code from another one.';
return;
}
await renderDevices('Revoked.');
} catch (err) {
if (status) status.textContent = err.message || String(err);
btn.disabled = false;
}
});
});
box.querySelector('#pair-forget-btn')?.addEventListener('click', async () => {
const pairing = await import('../pairing.js');
await pairing.forgetRevoked();
renderDevices('Cleared.');
});
}


// ---- Encryption -----------------------------------------------------------

async function renderEncryption(message = '') {
const status = document.getElementById('encrypt-status');
const onBtn = document.getElementById('encrypt-on-btn');
if (!status || !onBtn) return;
const crypt = await import('../synccrypto.js');
const on = await crypt.isEncrypted();
const keyed = await crypt.hasKey();
onBtn.textContent = on ? 'Encryption is on' : 'Turn on encryption';
onBtn.disabled = on;
// Three states, not two, and the middle one is the one that matters:
// "on but this device can't read it" is what a device looks like after
// pairing by typed code, and it needs the recovery key rather than
// reassurance.
status.textContent = message || (on
? (keyed ? 'On — the server holds ciphertext it cannot read.' : 'On, but this device has no key. Paste the recovery key below.')
: 'Off — the document is stored as readable JSON.');
}


// ---- Overview ticker ------------------------------------------------------

function renderTickerItems() {
const box = document.getElementById('ticker-items');
if (!box) return;
const items = data.ticker.items || [];
if (!items.length) {
box.innerHTML = '<div class="settings-note" style="margin:0;">Nothing on the strip — it stays hidden until you add something.</div>';
return;
}
box.innerHTML = `<table class="limits-table"><thead><tr><th>Shows</th><th>What</th><th></th></tr></thead><tbody>${
items.map((item, i) => `<tr>
<td>${escapeHtml(TICKER_KIND[item.kind] || item.kind)}</td>
<td>${escapeHtml(tickerLabel(item))}</td>
<td style="white-space:nowrap;">
<button class="sync-btn sm" type="button" data-ticker-up="${i}"${i === 0 ? ' disabled' : ''} title="Move earlier">&uarr;</button>
<button class="sync-btn sm" type="button" data-ticker-down="${i}"${i === items.length - 1 ? ' disabled' : ''} title="Move later">&darr;</button>
<span class="del-x" data-ticker-del="${i}" title="Remove">&times;</span>
</td>
</tr>`).join('')}</tbody></table>`;

const move = (from, to) => {
const list = data.ticker.items;
if (to < 0 || to >= list.length) return;
// Order on the strip is the order here, so the two must not drift:
// a splice pair rather than a sort key nobody else knows about.
const [row] = list.splice(from, 1);
list.splice(to, 0, row);
queueSave();
renderTickerItems();
refreshStrip();
};
box.querySelectorAll('[data-ticker-up]').forEach((b) => b.addEventListener('click', () => move(Number(b.dataset.tickerUp), Number(b.dataset.tickerUp) - 1)));
box.querySelectorAll('[data-ticker-down]').forEach((b) => b.addEventListener('click', () => move(Number(b.dataset.tickerDown), Number(b.dataset.tickerDown) + 1)));
box.querySelectorAll('[data-ticker-del]').forEach((b) => b.addEventListener('click', () => {
data.ticker.items.splice(Number(b.dataset.tickerDel), 1);
queueSave();
renderTickerItems();
refreshStrip();
}));
}

const TICKER_KIND = { fx: 'Currency', quote: 'Share', weather: 'Weather', sonia: 'Swap rate', holding: 'Holding' };

function tickerLabel(item) {
switch (item.kind) {
case 'fx': return `${item.base || 'GBP'} / ${item.quote}`;
case 'quote': return `${item.label || item.symbol} (${item.symbol})`;
case 'weather': return item.city;
case 'sonia': return '2-year SONIA, from Chatham';
case 'holding': return `${data.ticker.shares || 0} shares, valued in GBP`;
default: return item.kind;
}
}

async function refreshStrip() {
const t = await import('../features/ticker.js');
await t.refreshTicker();
}


// ---- What the document is made of -----------------------------------------
//
// Every save re-uploads the whole document and, since v416, re-encrypts
// it first. Whether that matters depends entirely on what the thing is
// made of, which nobody had ever measured -- so the question "should
// finished records move to a separate archive?" was being answered by
// instinct. This turns it into a reading.
//
// The second column is the one that decides it: how much of each section
// is records that are FINISHED. A section that is large but all live is
// not an archiving problem, and a section that is small but entirely
// finished is not worth a second document either.

function bytesOf(value) {
try { return new Blob([JSON.stringify(value ?? null)]).size; } catch (e) { return 0; }
}

function human(n) {
if (n < 1024) return `${n} B`;
if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

// What counts as "finished" per section -- deliberately per-type rather
// than a generic `done` flag, because each of these decided its own
// wording long before this readout existed.
const FINISHED = {
tasks: (t) => t.bucket === 'done',
mediaItems: (m) => m.status === 'done' || m.status === 'dropped',
readingList: (r) => r.status === 'done' || r.status === 'dropped',
mailDismissed: () => true,
captureDrafts: () => true,
captureBatches: () => true,
switchOffers: (o) => !!o.dismissed,
airbnbReservations: (r) => (r.checkOut || r.end || '') && (r.checkOut || r.end) < new Date().toISOString().slice(0, 10),
trips: (t) => (t.endDate || '') && t.endDate < new Date().toISOString().slice(0, 10),
};

function renderDocSize() {
const box = document.getElementById('doc-size');
if (!box) return;
const total = bytesOf(data);
const rows = Object.keys(data)
.map((key) => {
const value = data[key];
const size = bytesOf(value);
const list = Array.isArray(value) ? value : null;
const test = FINISHED[key];
const done = list && test ? list.filter((r) => { try { return test(r); } catch (e) { return false; } }) : null;
return {
key, size,
count: list ? list.length : null,
doneCount: done ? done.length : null,
doneBytes: done && done.length ? bytesOf(done) : 0,
};
})
.filter((r) => r.size > 64)
.sort((a, b) => b.size - a.size)
.slice(0, 14);

const reclaimable = rows.reduce((n, r) => n + r.doneBytes, 0);
box.innerHTML = `<div class="settings-note" style="margin:0 0 8px;">Whole document: <strong>${human(total)}</strong>, re-encrypted and re-uploaded on every save. Of that, <strong>${human(reclaimable)}</strong> (${total ? Math.round((reclaimable / total) * 100) : 0}%) is records that are finished.</div>
<table class="limits-table">
<thead><tr><th>Section</th><th style="text-align:right;">Size</th><th style="text-align:right;">Share</th><th style="text-align:right;">Records</th><th style="text-align:right;">Finished</th></tr></thead>
<tbody>${rows.map((r) => `<tr>
<td>${escapeHtml(r.key)}</td>
<td style="text-align:right;font-variant-numeric:tabular-nums;">${escapeHtml(human(r.size))}</td>
<td style="text-align:right;font-variant-numeric:tabular-nums;">${total ? Math.round((r.size / total) * 100) : 0}%</td>
<td style="text-align:right;font-variant-numeric:tabular-nums;">${r.count === null ? '—' : r.count}</td>
<td style="text-align:right;font-variant-numeric:tabular-nums;">${r.doneCount === null ? '—' : `${r.doneCount}${r.doneBytes ? ` · ${human(r.doneBytes)}` : ''}`}</td>
</tr>`).join('')}</tbody>
</table>
<div class="settings-note" style="margin:8px 0 0;">&ldquo;Finished&rdquo; means done or dropped tasks and media, dismissed mail and switch offers, spent capture drafts, and trips and stays whose end date has passed. Everything else is counted as live.</div>
${fieldBreakdownHtml('connections', total)}`;
}

// One level down, for whichever section dominates. The top table said
// connections was 85% of the document; it could not say whether that is
// 528 people or three fields holding whole chat transcripts. Those have
// completely different answers — the first is an architecture problem,
// the second is a line of code — so the drill-down is what decides it.
function fieldBreakdownHtml(section, docTotal) {
const list = data[section];
if (!Array.isArray(list) || list.length < 2) return '';
const totals = new Map();
list.forEach((record) => {
Object.keys(record || {}).forEach((field) => {
totals.set(field, (totals.get(field) || 0) + bytesOf(record[field]));
});
});
const rows = [...totals.entries()]
.map(([field, size]) => ({ field, size, per: Math.round(size / list.length) }))
.filter((r) => r.size > 256)
.sort((a, b) => b.size - a.size)
.slice(0, 12);
if (!rows.length) return '';
const sectionBytes = bytesOf(list);
return `<div class="settings-note" style="margin:14px 0 6px;"><strong>Inside ${escapeHtml(section)}</strong> — ${list.length} records, ${human(sectionBytes)} in total, by field.</div>
<table class="limits-table">
<thead><tr><th>Field</th><th style="text-align:right;">Size</th><th style="text-align:right;">Of section</th><th style="text-align:right;">Of document</th><th style="text-align:right;">Average each</th></tr></thead>
<tbody>${rows.map((r) => `<tr>
<td>${escapeHtml(r.field)}</td>
<td style="text-align:right;font-variant-numeric:tabular-nums;">${escapeHtml(human(r.size))}</td>
<td style="text-align:right;font-variant-numeric:tabular-nums;">${sectionBytes ? Math.round((r.size / sectionBytes) * 100) : 0}%</td>
<td style="text-align:right;font-variant-numeric:tabular-nums;">${docTotal ? Math.round((r.size / docTotal) * 100) : 0}%</td>
<td style="text-align:right;font-variant-numeric:tabular-nums;">${escapeHtml(human(r.per))}</td>
</tr>`).join('')}</tbody>
</table>`;
}

function initDocSize() {
const btn = document.getElementById('doc-size-btn');
if (!btn) return; // not in this build's DOM
btn.addEventListener('click', renderDocSize);
}
function initTickerSettings() {
const addBtn = document.getElementById('ticker-add-btn');
if (!addBtn) return; // not in this build's DOM
const kindEl = document.getElementById('ticker-add-kind');
const valueEl = document.getElementById('ticker-add-value');
const say = (text) => { const el = document.getElementById('ticker-add-status'); if (el) el.textContent = text; };

// The placeholder is the only hint about what each kind wants, so it
// changes with the kind rather than describing one of the three.
const PLACEHOLDER = { weather: 'Lisbon', fx: 'USD', quote: 'AAPL' };
kindEl.addEventListener('change', () => { valueEl.placeholder = PLACEHOLDER[kindEl.value] || ''; });

addBtn.addEventListener('click', async () => {
const kind = kindEl.value;
const raw = (valueEl.value || '').trim();
if (!raw) { say('Type something to add first.'); return; }
addBtn.disabled = true;
say('Checking…');
try {
const ticker = await import('../features/ticker.js');
let item;
if (kind === 'weather') {
// Resolved now rather than at render time, so a city that doesn't
// exist fails HERE, where you can see it and fix the spelling.
const geo = await ticker.geocode(raw);
item = { id: uid(), kind: 'weather', city: geo.city, lat: geo.lat, lon: geo.lon, tz: geo.tz };
say(`Added ${geo.city}, ${geo.country}.`);
} else if (kind === 'fx') {
const code = raw.toUpperCase().replace(/[^A-Z]/g, '');
if (code.length !== 3) { say('A currency is a three-letter code, like USD.'); addBtn.disabled = false; return; }
item = { id: uid(), kind: 'fx', base: 'GBP', quote: code };
say(`Added GBP/${code}.`);
} else {
item = { id: uid(), kind: 'quote', symbol: raw.toUpperCase(), label: raw.toUpperCase().split('.')[0] };
say(`Added ${item.symbol}. If it shows as failed, the symbol isn't one Yahoo knows.`);
}
data.ticker.items = [...(data.ticker.items || []), item];
queueSave();
valueEl.value = '';
renderTickerItems();
await refreshStrip();
} catch (err) {
say(err.message || String(err));
} finally {
addBtn.disabled = false;
}
});

renderTickerItems();
}
function initEncryption() {
const onBtn = document.getElementById('encrypt-on-btn');
if (!onBtn) return; // not in this build's DOM
const keyBox = document.getElementById('encrypt-key-box');

const showKey = async (intro) => {
const crypt = await import('../synccrypto.js');
const key = await crypt.exportKey();
if (!key) { keyBox.hidden = true; return; }
keyBox.hidden = false;
keyBox.innerHTML = `<div class="settings-note" style="margin:10px 0 4px;">${escapeHtml(intro)}</div>
<div style="font-family:monospace;font-size:15px;word-break:break-all;user-select:all;">${escapeHtml(crypt.formatKey(key))}</div>
<div class="sync-row" style="margin-top:6px;">
<button class="sync-btn sm" type="button" id="encrypt-copy-key">Copy</button>
<button class="sync-btn sm" type="button" id="encrypt-hide-key">Hide</button>
</div>
<div class="settings-note" style="margin:6px 0 0;">Put it in your password manager. It is the only copy that does not live on a device you own, and nothing can reissue it.</div>`;
keyBox.querySelector('#encrypt-copy-key').addEventListener('click', async () => {
try {
await navigator.clipboard.writeText(key);
renderEncryption('Recovery key copied.');
} catch (err) {
// Clipboard access is refused often enough that failing silently
// would just look broken; the key is already on screen to select.
renderEncryption('Couldn\'t reach the clipboard — select the key above instead.');
}
});
keyBox.querySelector('#encrypt-hide-key').addEventListener('click', () => { keyBox.hidden = true; });
};

onBtn.addEventListener('click', async () => {
const crypt = await import('../synccrypto.js');
if (await crypt.isEncrypted()) return;
// Said plainly and once, because this is the only irreversible thing
// in the app: there is no reset link for a key the server never had.
if (!confirm('Turn on encryption?\n\nThe server will no longer be able to read your data — and neither will any device without the key. There is no way to recover it if you lose every copy.\n\nThe next screen shows the recovery key. Save it before closing.')) return;
onBtn.disabled = true;
try {
await crypt.generateKey();
await showKey('Your recovery key — save this NOW:');
// Pushed straight away rather than waiting for the next edit, so the
// readable copy on the server is replaced now and not at some
// unpredictable later moment.
const { push } = await import('../sync/autosync.js');
await push({ force: true });
await renderEncryption('On. The copy on the server has been replaced with ciphertext.');
} catch (err) {
await renderEncryption(err.message || String(err));
} finally {
onBtn.disabled = false;
}
});

document.getElementById('encrypt-show-key-btn')?.addEventListener('click', async () => {
const crypt = await import('../synccrypto.js');
if (!(await crypt.hasKey())) { renderEncryption('No key on this device yet.'); return; }
showKey('Recovery key:');
});

document.getElementById('encrypt-adopt-btn')?.addEventListener('click', async () => {
const input = document.getElementById('encrypt-key-input');
const say = (t) => { const el = document.getElementById('encrypt-adopt-status'); if (el) el.textContent = t; };
const raw = (input.value || '').trim();
if (!raw) { say('Paste the recovery key first.'); return; }
try {
const crypt = await import('../synccrypto.js');
await crypt.adoptKey(raw);
input.value = '';
// Proved against the real document rather than just accepted: a key
// of the right LENGTH that doesn't open anything is the failure most
// worth catching here, while the person is still looking at it.
const { pullRemote } = await import('../sync/selfhost.js');
await pullRemote();
say('Key accepted — this device can read the server copy now.');
await renderEncryption();
} catch (err) {
say(err.message || String(err));
}
});

renderEncryption();
}
function initPairing() {
// Held from the pairing link until Pair is pressed, rather than written
// to settings on arrival: a link someone sent you should not install a
// key on this device before you have agreed to anything.
let pendingKey = '';
const startBtn = document.getElementById('pair-start-btn');
if (!startBtn) return; // not in this build's DOM
const codeBox = document.getElementById('pair-code-box');
const status = document.getElementById('pair-status');
let countdown = null;

startBtn.addEventListener('click', async () => {
clearInterval(countdown);
startBtn.disabled = true;
status.textContent = 'Asking the server for a code…';
try {
const pairing = await import('../pairing.js');
const res = await pairing.startPairing();
const settings = await getLocalSettings();
const crypt = await import('../synccrypto.js');
// The key travels only in the link's fragment, which browsers never send
// to a server -- so a device paired by TYPED code gets a token but no key,
// and the Encryption block above tells it to paste the recovery key.
const link = pairing.pairingLink(settings.syncUrl, res.code, await crypt.exportKey());
const expires = new Date(res.expiresAt).getTime();
codeBox.hidden = false;
codeBox.innerHTML = `<div class="settings-note" style="margin:10px 0 4px;">On the other device, open this link — or go to its Settings and type the code.</div>
<div style="font-size:26px;font-weight:600;letter-spacing:3px;font-family:monospace;">${escapeHtml(res.code)}</div>
<div class="sync-row" style="margin-top:6px;">
<button class="sync-btn sm" type="button" id="pair-copy-link">Copy link</button>
<span class="sync-status" id="pair-countdown"></span>
</div>
<div class="settings-note" style="margin:6px 0 0;">Safe to message to yourself: it works once and then expires. The link carries the sync URL too, which isn't secret.</div>`;
// A visible clock, because "it expires in ten minutes" is useless
// once you've walked to the other room and forgotten when you started.
const tick = () => {
const el = document.getElementById('pair-countdown');
if (!el) return;
const left = Math.max(0, Math.round((expires - Date.now()) / 1000));
if (!left) {
el.textContent = 'Expired — press Add a device for a new one.';
clearInterval(countdown);
return;
}
el.textContent = `Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
};
tick();
countdown = setInterval(tick, 1000);
codeBox.querySelector('#pair-copy-link').addEventListener('click', async () => {
try {
await navigator.clipboard.writeText(link);
status.textContent = 'Link copied.';
} catch (err) {
// Clipboard access is refused often enough — insecure context, a
// permission, an embedded webview — that failing silently would
// just look broken. Showing the link is the usable fallback.
status.textContent = link;
}
});
status.textContent = '';
await renderDevices();
} catch (err) {
status.textContent = err.message || String(err);
} finally {
startBtn.disabled = false;
}
});

document.getElementById('pair-refresh-btn')?.addEventListener('click', () => renderDevices('Checking…'));

const redeemBtn = document.getElementById('pair-redeem-btn');
redeemBtn?.addEventListener('click', async () => {
const urlEl = document.getElementById('pair-redeem-url');
const codeEl = document.getElementById('pair-redeem-code');
const labelEl = document.getElementById('pair-redeem-label');
const say = (t) => { const el = document.getElementById('pair-redeem-status'); if (el) el.textContent = t; };
const url = urlEl.value.trim();
const code = codeEl.value.trim();
if (!url || !code) { say('Both the sync URL and the code are needed.'); return; }
redeemBtn.disabled = true;
say('Pairing…');
try {
const pairing = await import('../pairing.js');
const res = await pairing.redeemPairing(url, code, labelEl.value.trim() || pairing.guessLabel(), pendingKey);
const urlInput = document.getElementById('sync-url-input');
const secretInput = document.getElementById('sync-secret-input');
if (urlInput) urlInput.value = url;
if (secretInput) secretInput.value = res.token;
codeEl.value = '';
say(`Paired as "${res.label}". This device has its own token${pendingKey ? ' and the encryption key' : ''} now.`);
pendingKey = '';
await restartAutoSync();
await renderDevices();
} catch (err) {
say(err.message || String(err));
} finally {
redeemBtn.disabled = false;
}
});

// A link opened on the new device fills the boxes in, leaving only the
// name to confirm. Deliberately NOT automatic: redeeming writes a
// credential and replaces this device's sync settings, which is not
// something a URL someone sent you should be able to do on its own.
(async () => {
const pairing = await import('../pairing.js');
const found = pairing.takePendingPairing();
if (!found) return;
// Taken out of the address bar straight away, so the code isn't left
// in history, in a bookmark, or in whatever the next screenshot shows.
history.replaceState(null, '', `${location.pathname}${location.search}#settings`);
const codeEl = document.getElementById('pair-redeem-code');
const details = codeEl?.closest('details');
if (details) details.open = true;
const urlEl = document.getElementById('pair-redeem-url');
const labelEl = document.getElementById('pair-redeem-label');
if (urlEl) urlEl.value = found.url;
if (codeEl) codeEl.value = found.code;
if (labelEl && !labelEl.value) labelEl.value = pairing.guessLabel();
pendingKey = found.key || '';
const el = document.getElementById('pair-redeem-status');
if (el) el.textContent = 'Code read from the link — check the name, then press Pair this device.';
})().catch((err) => console.error('Pairing link:', err));

renderDevices();
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
