// Carries chosen device-only settings (the Anthropic key, the Notion link...)
// between your devices, so a new device doesn't need them retyped.
//
// They are device-only on purpose: local settings are never synced or
// exported. This module adds an opt-in exception that keeps that property
// where it matters. Each chosen setting goes into data.settingsVault as its
// OWN AES-GCM envelope, made with the same key that protects the synced
// document (js/synccrypto.js) -- not merely left to the document's own
// encryption, because backups export `data` and would otherwise write the
// key out in readable form. Nothing is bundled unless encryption is on and
// this device holds the key; the server only ever sees ciphertext.
//
// Each device keeps, per setting, what it last agreed with the vault
// ("meta": the entry's timestamp and a hash of the value). That is what
// tells "I changed it here" apart from "another device changed it", so a
// local edit is pushed, a remote one adopted, and neither is mistaken for
// the other.
import { data, queueSave, getLocalSettings, setLocalSetting, setLocalSettingHandler } from './state.js';
import { isEncrypted, hasKey, encryptDocument, decryptDocument } from './synccrypto.js';
import { hashValue } from './sync/collections.js';

// Which settings can be carried. `domId` is the Settings input to refresh
// when another device's value is adopted. The sync URL, sync login and
// encryption key are deliberately absent: a new device needs those FIRST,
// to be able to read the vault at all, and pairing already carries them.
const SYNCABLE = [
{ key: 'anthropicApiKey', label: 'Anthropic API key', domId: 'anthropic-key-input', secret: true, byDefault: true },
{ key: 'notionProxyUrl', label: 'Notion proxy URL', domId: 'notion-url-input', byDefault: true },
{ key: 'notionDatabaseId', label: 'Notion database id', domId: 'notion-db-input', byDefault: true },
{ key: 'telegramBotUrl', label: 'Telegram bot URL', domId: 'telegrambot-url-input' },
{ key: 'agentWriteUrl', label: 'Agent-write URL', domId: 'agent-write-url-input' },
{ key: 'agentSecret', label: 'Agent-write secret', domId: 'agent-secret-input', secret: true },
];
const KEYS = new Set(SYNCABLE.map((s) => s.key));
const OPTED_KEY = 'vaultKeys'; // local setting: which keys this device syncs
const META_KEY = 'vaultMeta'; // local setting: {key: {at, h}} last agreed state

let chain = Promise.resolve();
let lastResult = { ok: true, note: '' };

function entries() { return data.settingsVault.entries; }

async function ready() {
return (await isEncrypted()) && (await hasKey());
}

function optedIn(settings) {
return Array.isArray(settings[OPTED_KEY]) ? settings[OPTED_KEY] : SYNCABLE.filter((s) => s.byDefault).map((s) => s.key);
}

function refreshInput(item, value) {
const el = item.domId && document.getElementById(item.domId);
if (el && el.value !== value) el.value = value;
}

async function reconcileNow() {
lastResult = { ok: true, note: '' };
if (!(await ready())) { lastResult = { ok: true, note: 'off' }; return; }
const settings = await getLocalSettings();
let opted = optedIn(settings).slice();
const meta = { ...(settings[META_KEY] || {}) };
let vaultChanged = false, optedChanged = false, metaChanged = false;

for (const item of SYNCABLE) {
const key = item.key;
const entry = entries()[key];
const mine = opted.includes(key);

if (entry && entry.removed) {
// Another device stopped syncing this one: follow, keep the local value.
if (mine && (!meta[key] || entry.at > meta[key].at)) { opted = opted.filter((k) => k !== key); optedChanged = true; }
continue;
}
if (!mine) continue;

const localVal = String(settings[key] || '');
if (entry && entry.env) {
let vaultVal;
try { vaultVal = String(await decryptDocument(entry.env)); } catch (err) {
lastResult = { ok: false, note: `Could not read "${item.label}" from the vault: this device's key doesn't open it.` };
continue;
}
const agreed = meta[key];
const localChanged = agreed ? hashValue(localVal) !== agreed.h : !!localVal;
const vaultAdvanced = !agreed || entry.at > agreed.at;
if (vaultVal === localVal) {
if (!agreed || agreed.at !== entry.at || agreed.h !== hashValue(localVal)) { meta[key] = { at: entry.at, h: hashValue(localVal) }; metaChanged = true; }
continue;
}
if (vaultAdvanced && !localChanged) {
// Changed elsewhere, untouched here: take it.
await setLocalSetting(key, vaultVal);
settings[key] = vaultVal;
refreshInput(item, vaultVal);
meta[key] = { at: entry.at, h: hashValue(vaultVal) };
metaChanged = true;
continue;
}
if (!localVal && !agreed) {
// A device that has never agreed with this entry and has nothing of its own: take the vault's value. (A value cleared on purpose, after an earlier agreement, is not undone.)
await setLocalSetting(key, vaultVal);
settings[key] = vaultVal;
refreshInput(item, vaultVal);
meta[key] = { at: entry.at, h: hashValue(vaultVal) };
metaChanged = true;
continue;
}
// Changed here (and maybe elsewhere too): this device's edit wins,
// because an edit is pushed the moment it is made.
}
if (!localVal) continue;
const at = new Date().toISOString();
entries()[key] = { at, env: await encryptDocument(localVal) };
meta[key] = { at, h: hashValue(localVal) };
vaultChanged = true;
metaChanged = true;
}

if (optedChanged) await setLocalSetting(OPTED_KEY, opted);
if (metaChanged) await setLocalSetting(META_KEY, meta);
if (vaultChanged) queueSave();
}

// One at a time, so two triggers close together can't both write.
function reconcile() {
chain = chain.then(reconcileNow).catch((err) => { lastResult = { ok: false, note: err.message || String(err) }; console.warn('Synced settings:', err); });
return chain;
}

async function setSynced(key, on) {
if (!KEYS.has(key)) return;
const settings = await getLocalSettings();
const opted = optedIn(settings).filter((k) => k !== key);
if (on) opted.push(key);
await setLocalSetting(OPTED_KEY, opted);
if (!on && (await ready()) && entries()[key] && !entries()[key].removed) {
// Tell the other devices to stop too; the value stays wherever it is.
entries()[key] = { at: new Date().toISOString(), removed: true };
queueSave();
}
if (on && entries()[key] && entries()[key].removed) { delete entries()[key]; queueSave(); }
await reconcile();
}

// ---- Settings panel ----------------------------------------------------

async function renderPanel() {
const list = document.getElementById('synced-settings-list');
const note = document.getElementById('synced-settings-note');
if (!list || !note) return;
const enabled = await ready();
const settings = await getLocalSettings();
const opted = optedIn(settings);
note.innerHTML = enabled
? 'Encryption is on and this device holds the key, so ticked settings are carried to your other devices, encrypted. Unticking stops it everywhere; the value stays where it is.'
: 'Nothing is carried while this is off: turn on encryption under <span class="inline-goto-link" data-goto-tab="settings" data-goto-target="#encrypt-key-input">Settings &rarr; Live sync</span> first, so a key is never stored readable on the server.';
if (enabled && !lastResult.ok) note.innerHTML += ` <strong>${lastResult.note.replace(/</g, '&lt;')}</strong>`;
list.innerHTML = SYNCABLE.map((item) => {
const has = !!settings[item.key];
const on = opted.includes(item.key);
const entry = entries()[item.key];
const state = !has ? 'not set on this device' : on && entry && !entry.removed ? 'carried to other devices' : on ? 'will be carried once encryption is on' : 'this device only';
return `<label class="settings-note" style="display:flex;gap:8px;align-items:center;margin:4px 0;">
<input type="checkbox" data-synced-setting="${item.key}"${on ? ' checked' : ''}${enabled ? '' : ' disabled'}>
<span>${item.label}</span><span style="opacity:.7;">${state}</span></label>`;
}).join('');
list.querySelectorAll('[data-synced-setting]').forEach((box) => {
box.addEventListener('change', async () => { await setSynced(box.dataset.syncedSetting, box.checked); renderPanel(); });
});
}

function initSettingsVault() {
// A saved setting is carried the moment it changes; the bookkeeping keys
// are skipped or this would trigger itself.
setLocalSettingHandler((key) => { if (KEYS.has(key) || key === OPTED_KEY) reconcile().then(renderPanel); });
renderPanel();
document.getElementById('synced-settings-details')?.addEventListener('toggle', renderPanel);
reconcile().then(renderPanel);
}

export { initSettingsVault, reconcile as reconcileSyncedSettings, SYNCABLE };
