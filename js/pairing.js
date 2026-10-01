// Getting a credential onto a new device without posting it to yourself.
//
// The old way was to type the shared secret into each phone and laptop,
// which meant first sending it somewhere -- and every channel that can
// carry a secret to your other device also keeps a copy of it. A message
// to yourself, an email draft, clipboard history, a photo of a screen:
// the secret outlives the ten seconds it was needed for, somewhere nobody
// is looking.
//
// So the thing that travels is a code that expires in ten minutes and
// works once. Paste it into whatever chat app is convenient -- by the
// time it could be found, it is already worthless. The server hands the
// new device a token of its own in exchange, and that token never leaves
// the device it was issued to.
//
// See server/auth.php for the other half.
import { getLocalSettings, setLocalSetting } from './state.js';

// pair.php sits beside sync.php, so there is nothing new to configure:
// a second URL field would be a second thing to get wrong, and it is
// always the same directory.
function pairEndpoint(syncUrl) {
const url = String(syncUrl || '').trim();
if (!url) return '';
return url.replace(/[^/]*$/, 'pair.php');
}

async function call(action, { url = '', secret = '', body = null, method = 'POST' } = {}) {
const settings = await getLocalSettings();
const endpoint = pairEndpoint(url || settings.syncUrl);
if (!endpoint) throw new Error('No sync URL set, so there is no server to pair with.');
const auth = secret || settings.syncSecret || '';
const res = await fetch(`${endpoint}?action=${encodeURIComponent(action)}`, {
method,
headers: {
...(body ? { 'Content-Type': 'application/json' } : {}),
// Redeeming is the one call with nothing to authenticate WITH --
// the code in the body is the credential.
...(auth ? { 'X-Sync-Secret': auth } : {}),
},
...(body ? { body: JSON.stringify(body) } : {}),
});
const text = await res.text();
let parsed = null;
try { parsed = JSON.parse(text); } catch (e) { /* non-JSON: handled below */ }
if (!res.ok) {
// A 404 here almost always means one specific thing, and saying so
// saves working through the general case.
if (res.status === 404) throw new Error('pair.php isn\'t on the server yet — upload it next to sync.php.');
throw new Error((parsed && parsed.error) || `Pairing failed (HTTP ${res.status}).`);
}
if (!parsed) throw new Error('The server answered, but not with JSON — check the URL points at pair.php.');
return parsed;
}

// ---- From the device that is already paired -------------------------------

function startPairing() { return call('start'); }
function listDevices() { return call('devices', { method: 'GET' }); }
function revokeDevice(id) { return call('revoke', { body: { id } }); }
function forgetRevoked() { return call('forget', { body: {} }); }

// What travels. The URL is in it because a brand-new device doesn't know
// which server to ask -- and the URL isn't the secret, the code is, so
// carrying it costs nothing. Base64 so the whole thing is one string to
// copy rather than two fields to transcribe.
// The encryption key rides along when there is one, and this is the only
// place it ever travels. It is safe HERE and nowhere else for one
// mechanical reason: everything after the # is never sent to a server,
// so the key stays between the two browsers even though the link looks
// like a URL. The same fact is why the code must still expire -- a link
// pasted into a chat is readable by whoever can read that chat.
function pairingLink(syncUrl, code, key = '') {
const payload = btoa(JSON.stringify({ u: syncUrl, c: code, ...(key ? { k: key } : {}) }))
.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
return `${new URL('index.html', location.href).href}#pair=${payload}`;
}

// The hash is consumed by app.js before the tab router rewrites the URL,
// and parked in sessionStorage until Settings is wired -- several hundred
// milliseconds later, by which time location.hash says "#settings".
// Taken rather than read: a pairing code should not survive a refresh.
function takePendingPairing() {
let stored = '';
try {
stored = sessionStorage.getItem('pendingPairing') || '';
sessionStorage.removeItem('pendingPairing');
} catch (e) { /* private mode, blocked storage: nothing to resume */ }
return readPairingLink(stored || location.hash);
}

function readPairingLink(hash) {
const m = /[#&]pair=([A-Za-z0-9_-]+)/.exec(String(hash || ''));
if (!m) return null;
try {
const json = atob(m[1].replace(/-/g, '+').replace(/_/g, '/'));
const payload = JSON.parse(json);
if (!payload || !payload.c) return null;
return { url: String(payload.u || ''), code: String(payload.c), key: String(payload.k || '') };
} catch (e) {
return null;
}
}

// ---- On the new device ----------------------------------------------------

// A name you'll recognise in the device list months later, when the only
// question that matters is "do I still have that one". Guessed rather
// than asked, and editable before you commit.
function guessLabel() {
const ua = navigator.userAgent || '';
if (/iPhone/i.test(ua)) return 'iPhone';
if (/iPad/i.test(ua)) return 'iPad';
if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'Android phone' : 'Android tablet';
if (/Macintosh/i.test(ua)) return 'Mac';
if (/Windows/i.test(ua)) return 'Windows PC';
if (/Linux/i.test(ua)) return 'Linux PC';
return 'A device';
}

async function redeemPairing(syncUrl, code, label, key = '') {
const res = await call('redeem', { url: syncUrl, secret: '', body: { code, label } });
if (!res.token) throw new Error('The server did not return a token.');
// Adopted before the sync settings are written, so the first pull this
// device makes can already read an encrypted document rather than
// failing once and looking broken.
if (key) {
const crypt = await import('./synccrypto.js');
await crypt.adoptKey(key);
}
// The token goes in the same box the shared secret used to, and is sent
// in the same header, so nothing else in the app has to know that
// anything changed.
await setLocalSetting('syncUrl', syncUrl);
await setLocalSetting('syncSecret', res.token);
await setLocalSetting('deviceId', res.id || '');
await setLocalSetting('deviceLabel', res.label || label || '');
return res;
}

export { startPairing, listDevices, revokeDevice, forgetRevoked, redeemPairing, pairingLink, readPairingLink, takePendingPairing, guessLabel, pairEndpoint };
