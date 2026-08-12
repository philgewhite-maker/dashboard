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
throw new ConflictError(await res.json());
}
if (!res.ok) {
let detail = `HTTP ${res.status}`;
try { detail = (await res.json()).error || detail; } catch (e) { /* not JSON, keep the status */ }
if (res.status === 401) throw new Error(`Sync server rejected the secret — check it matches sync.php exactly.`);
throw new Error(`Sync server error: ${detail}`);
}
return res.json();
}

// Returns {rev, updatedAt, data}. `data` is null when the server has never
// been written to, which the caller treats as "seed me from this device".
async function pullRemote() {
return request('GET');
}

// Writes `data`, but only if the server is still at the revision we last
// saw. Throws ConflictError (carrying the newer document) if not.
async function pushRemote(data) {
const rev = await getKnownRev();
const result = await request('POST', { rev, data });
await setKnownRev(result.rev);
return result;
}

export {
NotConfiguredError, ConflictError,
getConfig, isConfigured, getKnownRev, setKnownRev, pullRemote, pushRemote,
};
