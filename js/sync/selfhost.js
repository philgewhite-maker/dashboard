// Talks to your own sync.php (see server/sync.php). Unlike the Google Drive
// path this needs no OAuth, so there's no hourly token to re-request and no
// popup to be blocked — the URL and secret are configured once per device
// and just work from then on.
//
// The secret lives in device-local settings, never in the repo (which is
// public) and never in a backup export.
import { getLocalSettings, setLocalSetting } from '../state.js';

class NotConfiguredError extends Error {
constructor() {
super('Live sync isn\'t set up on this device yet — add your sync URL and secret in Settings.');
this.name = 'NotConfiguredError';
}
}

// Thrown when the server rejected our write because someone else saved
// first. Carries the newer document so the caller can adopt it.
class ConflictError extends Error {
constructor(remote) {
super('Another device saved a newer version.');
this.name = 'ConflictError';
this.remote = remote;
}
}

async function getConfig() {
const settings = await getLocalSettings();
const url = (settings.syncUrl || '').trim();
const secret = (settings.syncSecret || '').trim();
return { url, secret, configured: !!(url && secret) };
}

async function isConfigured() {
return (await getConfig()).configured;
}

// The last revision this device knows about. Sent on every write so the
// server can tell whether we're writing on top of what we last saw.
async function getKnownRev() {
const settings = await getLocalSettings();
return Number(settings.syncKnownRev || 0);
}

async function setKnownRev(rev) {
await setLocalSetting('syncKnownRev', Number(rev) || 0);
}

// Without this a stalled connection (bad DNS, a host that accepts the TCP
// connection then never replies, a captive portal) leaves the request
// pending forever, and the UI sits on "Testing…" with no explanation. A
// definite failure you can act on beats an indefinite wait.
const REQUEST_TIMEOUT_MS = 15000;

async function request(method, body) {
const { url, secret, configured } = await getConfig();
if (!configured) throw new NotConfiguredError();

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
let res;
try {
res = await fetch(url, {
method,
headers: { 'Content-Type': 'application/json', 'X-Sync-Secret': secret },
body: body === undefined ? undefined : JSON.stringify(body),
signal: controller.signal,
});
} catch (networkErr) {
clearTimeout(timer);
if (networkErr.name === 'AbortError') {
throw new Error(`No reply from ${url} within ${REQUEST_TIMEOUT_MS / 1000}s — check the URL is right and the file is uploaded.`);
}
// fetch() rejects (rather than returning a non-ok response) for offline,
// DNS failure, mixed content, and CORS rejection. Those are wildly
// different problems from a 4xx, so they get their own message.
throw new Error(`Couldn't reach the sync server — check the URL, that it's https, and that you're online. (${networkErr.message})`);
}

clearTimeout(timer);

if (res.status === 409) {
// The 409 body carries the newer document, which the caller adopts —
// so it needs unsealing exactly like a pull. Missed, this is the path
// that writes an envelope into the app as if it were the data.
throw new ConflictError(await unseal(await res.json()));
}
if (!res.ok) {
let detail = `HTTP ${res.status}`;
try { detail = (await res.json()).error || detail; } catch (e) { /* not JSON, keep the status */ }
if (res.status === 401) throw new Error(`Sync server rejected the secret — check it matches sync.php exactly.`);
throw new Error(`Sync server error: ${detail}`);
}
return res.json();
}

// Encryption sits at these two functions and nowhere else: they are the
// only places a document crosses between this app and the network, so
// putting it here means nothing else — autosync, Settings, the conflict
// path — has to know the document is ever ciphertext. See synccrypto.js.
async function unseal(payload) {
if (!payload || payload.data === null || payload.data === undefined) return payload;
const crypt = await import('../synccrypto.js');
if (!crypt.isEnvelope(payload.data)) return payload;
// Seeing ciphertext is how a device learns the rule, rather than from a
// setting it might not have been told about. Set BEFORE the decrypt can
// throw, so a device that cannot read the document still knows not to
// push plaintext over it.
await crypt.setEncrypted(true);
return { ...payload, data: await crypt.decryptDocument(payload.data) };
}

// Returns {rev, updatedAt, data}. `data` is null when the server has never
// been written to, which the caller treats as "seed me from this device".
// Throws LockedError if the server's copy is encrypted and this device
// hasn't got the key — deliberately a throw rather than a null, because
// every caller treats null as "seed me", and seeding over an encrypted
// document would destroy it.
async function pullRemote() {
return unseal(await request('GET'));
}

// Writes `data`, but only if the server is still at the revision we last
// saw. Throws ConflictError (carrying the newer document) if not.
async function pushRemote(data) {
const crypt = await import('../synccrypto.js');
let payload = data;
if (await crypt.isEncrypted()) {
// Refusing is the whole safety property. A device that has lost its
// key would otherwise quietly replace an encrypted document with a
// plaintext one — readable by the host again, and unreadable by every
// other device.
if (!(await crypt.hasKey())) {
throw new crypt.LockedError('This device has no encryption key, so it won\'t overwrite the encrypted copy on the server. Paste the recovery key in Settings.');
}
payload = await crypt.encryptDocument(data);
}
const rev = await getKnownRev();
const result = await request('POST', { rev, data: payload });
await setKnownRev(result.rev);
return result;
}

export {
NotConfiguredError, ConflictError,
getConfig, isConfigured, getKnownRev, setKnownRev, pullRemote, pushRemote,
};
