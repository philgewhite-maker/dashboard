// A plain-text report of what this device is doing, for when something fails
// somewhere there is no DevTools (a phone) or no Claude (another PC): one
// button in Settings copies it, and it can be pasted into any chat.
//
// The capture half runs from the very first import in app.js, with no
// imports of its own, so an error thrown while the rest of the app is still
// loading is kept too. It remembers the last few errors and failed requests
// in localStorage, so they survive a reload and don't need DevTools open at
// the time. Nothing leaves the device unless the report is pasted somewhere.

const LOG_KEY = 'dash-diag-errors';
const MAX_ENTRIES = 50;
const MAX_MSG = 500;

// Anything shaped like a credential is removed before it is stored, so a
// report is safe to paste: long hex/base64 tokens, bearer/API-key strings
// and the secret/token/key query parameters some endpoints accept.
function redact(text) {
return String(text)
.replace(/(secret|token|key|password|authorization)=([^&\s"']+)/gi, '$1=[redacted]')
.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 [redacted]')
.replace(/\b(sk-ant-|AIza|ya29\.|gh[pousr]_)[A-Za-z0-9._-]{8,}/g, '[redacted]')
.replace(/\b[A-Fa-f0-9]{40,}\b/g, '[redacted]')
.replace(/\b[A-Za-z0-9+/_-]{60,}={0,2}/g, '[redacted]');
}

function readLog() {
try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch (e) { return []; }
}

function record(kind, message) {
try {
const msg = redact(message).slice(0, MAX_MSG);
const log = readLog();
const last = log[log.length - 1];
if (last && last.kind === kind && last.msg === msg) {
last.n = (last.n || 1) + 1;
last.at = new Date().toISOString();
} else {
log.push({ at: new Date().toISOString(), kind, msg });
}
localStorage.setItem(LOG_KEY, JSON.stringify(log.slice(-MAX_ENTRIES)));
} catch (e) { /* storage unavailable: nothing to keep it in */ }
}

function describe(arg) {
if (arg instanceof Error) return `${arg.name}: ${arg.message}${arg.stack ? `\n${arg.stack.split('\n').slice(1, 4).join('\n')}` : ''}`;
if (typeof arg === 'string') return arg;
try { return JSON.stringify(arg); } catch (e) { return String(arg); }
}

// A request's URL without its query string: enough to see WHICH endpoint
// failed, without ever recording what was sent to it.
function plainUrl(input) {
try {
const u = new URL(typeof input === 'string' ? input : input.url, location.href);
return `${u.origin}${u.pathname}`;
} catch (e) { return 'unknown url'; }
}

function installCapture() {
if (window.__dashDiagInstalled) return;
window.__dashDiagInstalled = true;

window.addEventListener('error', (e) => {
record('error', `${e.message || 'Script error'} (${(e.filename || '').split('/').slice(-2).join('/')}:${e.lineno || 0})`);
});
window.addEventListener('unhandledrejection', (e) => {
record('promise', describe(e.reason));
});

['error', 'warn'].forEach((level) => {
const original = console[level];
console[level] = function (...args) {
try {
const text = args.map(describe).join(' ');
// The sync trail has its own log in the report; keeping those
// warnings here too would crowd the real errors out of 50 entries.
if (!text.startsWith('Live sync:')) record(level, text);
} catch (e) { /* never let logging break the app */ }
return original.apply(this, args);
};
});

// Failed requests never reach console.error from app code (the browser
// logs them itself), so they are noted here: status and endpoint only.
const nativeFetch = window.fetch;
window.fetch = function (input, init) {
const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
const promise = nativeFetch.apply(this, arguments);
promise.then((res) => {
if (!res.ok && !(res.status === 404 && /\/records\.php$/.test(plainUrl(input)))) record('http', `${res.status} ${method} ${plainUrl(input)}`);
}, (err) => {
if (!(err && err.name === 'AbortError')) record('network', `${method} ${plainUrl(input)} failed: ${err && err.message ? err.message : err}`);
});
return promise;
};
}

installCapture();

// ---- The report ----------------------------------------------------------

function yesNo(v) { return v ? 'yes' : 'no'; }

async function section(title, build) {
try {
const lines = await build();
return `== ${title} ==\n${lines.filter((l) => l !== null && l !== undefined).join('\n')}`;
} catch (err) {
return `== ${title} ==\n(could not read: ${err && err.message ? err.message : err})`;
}
}

async function buildReport() {
const parts = [];

parts.push(await section('This device', async () => [
`Time: ${new Date().toString()}`,
`Build: ${(document.getElementById('build-stamp') || {}).textContent || 'unknown'}`,
`Page: ${location.origin}${location.pathname}${location.hash}`,
`Browser: ${navigator.userAgent}`,
`Screen: ${innerWidth}x${innerHeight} @${devicePixelRatio}x, installed app: ${yesNo(matchMedia('(display-mode: standalone)').matches)}`,
`Online: ${yesNo(navigator.onLine)}`,
`Service worker: ${navigator.serviceWorker && navigator.serviceWorker.controller ? 'controlling this page' : 'not controlling'}`,
]));

parts.push(await section('Sync', async () => {
const { getConfig, getKnownRev } = await import('./sync/selfhost.js');
const { isEncrypted, hasKey } = await import('./synccrypto.js');
const { hasPendingSave } = await import('./state.js');
const cfg = await getConfig();
let host = '(not set)';
try { host = new URL(cfg.url).host; } catch (e) { /* leave as not set */ }
return [
`Server: ${host}, secret set: ${yesNo(cfg.secret)}`,
`Known revision: ${await getKnownRev()}`,
`Encrypted: ${yesNo(await isEncrypted())}, key on this device: ${yesNo(await hasKey())}`,
`Unsaved edit waiting: ${yesNo(hasPendingSave())}`,
`Status line: ${((document.getElementById('live-sync-status') || {}).textContent || '').trim() || '(empty)'}`,
];
}));

parts.push(await section('Record store (preview)', async () => {
const { compareWithStore } = await import('./sync/recordsync.js');
const r = await compareWithStore();
if (!r.active) return [`Not active: ${r.reason}${r.error ? ` (${r.error})` : ''}`];
const bad = r.collections.filter((c) => c.differ.length || c.missing.length || c.extra.length);
return [`Active as user ${r.user}`, bad.length ? `Differences in: ${bad.map((c) => c.entry.key).join(', ')}` : 'Matches this device exactly'];
}));

parts.push(await section('Google', async () => {
const g = await import('./sync/googleauth.js');
return [
`Signed in now: ${yesNo(g.isSignedIn())}`,
`Connected before: ${yesNo(await g.wasConnectedBefore())}`,
`Calendar write allowed: ${yesNo(g.hasCalendarWrite())}`,
];
}));

parts.push(await section('Data counts', async () => {
const { data } = await import('./state.js');
return ['tasks', 'trips', 'plannerEntries', 'financeAccounts', 'lettingLedger', 'healthDaily', 'airbnbReservations', 'connections']
.map((k) => `${k}: ${Array.isArray(data[k]) ? data[k].length : '-'}`);
}));

parts.push(await section('Sync trail (newest last)', async () => {
const log = JSON.parse(localStorage.getItem('dash-sync-log') || '[]');
return log.length ? log.slice(-20).map((e) => `${e.at.slice(11, 19)} ${e.event}${e.detail ? ` — ${e.detail}` : ''}`) : ['(empty)'];
}));

parts.push(await section('Recent errors and failed requests (newest last)', async () => {
const log = readLog();
return log.length
? log.slice(-30).map((e) => `${e.at.slice(5, 19).replace('T', ' ')} [${e.kind}]${e.n > 1 ? ` x${e.n}` : ''} ${e.msg}`)
: ['(none recorded)'];
}));

return parts.join('\n\n');
}

function initDiagnostics() {
const btn = document.getElementById('diagnostics-copy-btn');
const out = document.getElementById('diagnostics-status');
const area = document.getElementById('diagnostics-text');
const clear = document.getElementById('diagnostics-clear-btn');
if (btn && out) {
btn.addEventListener('click', async () => {
btn.disabled = true;
out.textContent = 'Gathering…';
try {
const report = await buildReport();
if (area) { area.value = report; area.hidden = false; }
try {
await navigator.clipboard.writeText(report);
out.textContent = `Copied ${report.length.toLocaleString()} characters. Paste it into your message.`;
} catch (e) {
// Some browsers refuse clipboard writes outside a plain click; the
// text is on screen below to select and copy by hand.
if (area) { area.focus(); area.select(); }
out.textContent = 'Could not copy automatically — the report is below; select it and copy.';
}
} catch (err) {
out.textContent = `Could not build the report: ${err && err.message ? err.message : err}`;
} finally {
btn.disabled = false;
}
});
}
if (clear && out) {
clear.addEventListener('click', () => {
try { localStorage.removeItem(LOG_KEY); } catch (e) { /* nothing to clear */ }
out.textContent = 'Error history cleared.';
});
}
}

export { initDiagnostics, buildReport, redact };
