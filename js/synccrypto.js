// End-to-end encryption for the synced document.
//
// WHAT THIS CHANGES. Until now dashboard-data.json sat on shared hosting
// as readable JSON: connections, finances, health, mail. It was outside
// public_html and TLS covered the wire, which protects it from the
// internet but not from the host -- their staff, their backups, their
// next misconfiguration, and anyone who ever gets hold of a credential.
// The sensitive-fields toggle never helped here; it only ever controlled
// what was drawn on screen.
//
// WHY IT IS POSSIBLE AT ALL. sync.php never looks inside `data`: it
// reads `rev`, writes `updatedAt`, and stores the value whole. So the
// value can be ciphertext and the server needs no changes and no
// knowledge of it. Everything here runs in the browser, at the two
// functions in sync/selfhost.js that already stood on that boundary.
//
// WHAT IT DOES NOT COVER. Attachments (files.php), the health log and
// the Telegram log are separate stores and are still plain. Settings
// says so, rather than implying a blanket that isn't there.
//
// THE TRADE. A key the server never sees is a key the server cannot
// reissue. Lose it from every device and the document is gone -- not
// locked out of, gone. That is what end-to-end means, and the recovery
// key exists so that "every device" can also mean "and one password
// manager".
import { getLocalSettings, setLocalSetting } from './state.js';
import { seal, open, isEnvelope, newKeyB64, keyBytesFrom, toBase64 } from './cryptobox.js';

// Thrown when the server's copy is encrypted and this device cannot read
// it. Deliberately its own type: callers have to choose between "say so
// and stop" and "overwrite the server", and those must never be confused.
class LockedError extends Error {
constructor(message) {
super(message || 'This device doesn\'t have the key for the encrypted copy on the server.');
this.name = 'LockedError';
}
}

// The key as held on this device, in the same device-local settings the
// sync secret uses: never in a backup export, never in the repo, and
// never sent to the server.
async function storedKey() {
const settings = await getLocalSettings();
const raw = (settings.syncKey || '').trim();
return keyBytesFrom(raw) ? raw : '';
}

async function hasKey() {
return (await storedKey()) !== '';
}

// Whether THIS device believes the document is encrypted. Set when you
// turn it on, and also set by any pull that sees ciphertext -- so a
// device that is behind learns the rule from the data rather than from a
// setting nobody told it about, and stops itself pushing plaintext over
// an encrypted document.
async function isEncrypted() {
return !!(await getLocalSettings()).syncEncrypted;
}

async function setEncrypted(on) {
await setLocalSetting('syncEncrypted', !!on);
}

async function generateKey() {
const b64 = newKeyB64();
await setLocalSetting('syncKey', b64);
await setEncrypted(true);
return b64;
}

async function adoptKey(input) {
const cleaned = String(input || '').replace(/\s+/g, '');
const bytes = keyBytesFrom(cleaned);
if (!bytes) throw new Error('That isn\'t a recovery key — it should be 44 characters, usually ending in "=".');
const b64 = toBase64(bytes);
await setLocalSetting('syncKey', b64);
await setEncrypted(true);
return b64;
}

async function exportKey() {
return storedKey();
}

async function forgetKey() {
await setLocalSetting('syncKey', '');
}

async function encryptDocument(doc) {
const key = await storedKey();
if (!key) throw new LockedError('No encryption key on this device, so there is nothing to encrypt with.');
return seal(key, doc);
}

async function decryptDocument(envelope) {
const key = await storedKey();
if (!key) throw new LockedError();
try {
return await open(key, envelope);
} catch (e) {
throw new LockedError('The key on this device doesn\'t open the copy on the server. If you have the recovery key, paste it in Settings.');
}
}

// Grouped for copying into a password manager, which is the only place
// this should ever end up.
function formatKey(b64) {
return String(b64 || '').replace(/(.{11})/g, '$1 ').trim();
}

export {
LockedError, isEnvelope, encryptDocument, decryptDocument,
hasKey, isEncrypted, setEncrypted, generateKey, adoptKey, exportKey, forgetKey, formatKey,
};
