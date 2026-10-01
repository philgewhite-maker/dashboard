// The actual AES-GCM, with no idea where keys or documents come from.
//
// Separate from synccrypto.js for one concrete reason: js/bgsync.js runs
// inside the service worker and is deliberately dependency-free, so it
// cannot import anything that reaches state.js. Without this split the
// background refresh would need its own copy of the cipher -- and two
// copies of a rule is exactly how the duplicate-streaming-providers bug
// got onto the screen. One implementation, two callers.
//
// Takes and returns the key as base64 text. Nothing here reads settings,
// touches the DOM, or knows what a document is.

const ALG = 'AES-GCM';
const KEY_BYTES = 32;
// 96 bits is the size AES-GCM is specified around, and the size at which
// a randomly generated IV per message is the recommended construction
// rather than a counter.
const IV_BYTES = 12;

function toBase64(bytes) {
let binary = '';
// String.fromCharCode spreads its argument, and a whole document's worth
// at once overflows the call stack.
const chunk = 0x8000;
for (let i = 0; i < bytes.length; i += chunk) {
binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
}
return btoa(binary);
}

function fromBase64(text) {
const binary = atob(String(text || ''));
const out = new Uint8Array(binary.length);
for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
return out;
}

function keyBytesFrom(b64) {
try {
const bytes = fromBase64(String(b64 || '').replace(/\s+/g, ''));
return bytes.length === KEY_BYTES ? bytes : null;
} catch (e) {
return null;
}
}

function newKeyB64() {
return toBase64(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}

function importKey(bytes) {
return crypto.subtle.importKey('raw', bytes, { name: ALG }, true, ['encrypt', 'decrypt']);
}

// The shape that goes in `data`. `_enc` is what every reader checks
// before assuming it has a document; the version is there so a future
// change of cipher is distinguishable from corruption rather than
// guessed at.
function isEnvelope(value) {
return !!value && typeof value === 'object' && value._enc === 1 && typeof value.ct === 'string';
}

async function seal(keyB64, doc) {
const bytes = keyBytesFrom(keyB64);
if (!bytes) throw new Error('No usable encryption key.');
const key = await importKey(bytes);
const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
const ct = await crypto.subtle.encrypt(
{ name: ALG, iv }, key, new TextEncoder().encode(JSON.stringify(doc)),
);
return { _enc: 1, alg: 'A256GCM', iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
}

async function open(keyB64, envelope) {
const bytes = keyBytesFrom(keyB64);
if (!bytes) throw new Error('No usable encryption key.');
const key = await importKey(bytes);
// AES-GCM fails closed and says nothing about why: a wrong key and a
// document someone has altered raise the same error, which is the point
// of using an authenticated cipher rather than a bare one.
const plaintext = await crypto.subtle.decrypt(
{ name: ALG, iv: fromBase64(envelope.iv) }, key, fromBase64(envelope.ct),
);
return JSON.parse(new TextDecoder().decode(plaintext));
}

export { seal, open, isEnvelope, newKeyB64, keyBytesFrom, toBase64, fromBase64, KEY_BYTES };
