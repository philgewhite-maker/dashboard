// Shared Google sign-in for everything that needs it — Drive sync and
// Calendar reading both go through here, so one sign-in and one consent
// screen covers both instead of asking twice. Uses Google Identity
// Services (GIS), the browser-only token flow: no client secret (a public
// client can't keep one safe, so it doesn't get one), and no refresh
// token, so a session lasts about an hour before needing a quiet
// re-request — see the reconnect functions below for how that's handled
// without tripping browsers' popup blockers.
import { GOOGLE_CLIENT_ID } from './config.js';
import { getLocalSettings, setLocalSetting } from '../state.js';
import { getConfig as getSyncConfig } from './selfhost.js';

const BASE_SCOPES = [
'https://www.googleapis.com/auth/drive.appdata',
'https://www.googleapis.com/auth/calendar.readonly',
'https://www.googleapis.com/auth/gmail.readonly',
'https://www.googleapis.com/auth/contacts.readonly',
// Read-only pull-in of Google Tasks (a separate API from Calendar — no
// scope overlap) into the dashboard's own GTD inbox. One-directional: this
// dashboard is the real task system, Google Tasks is just where items land
// from places with no other access (work web filters, quick phone capture).
'https://www.googleapis.com/auth/tasks.readonly',
];

// Writing to Contacts is a much heavier permission than reading it — it can
// alter or clear fields in your real address book — so it is off unless you
// turn it on, and it replaces the read-only scope rather than adding to it.
// Changing this forces a fresh consent screen; Google won't widen an already
// issued token.
const CONTACTS_WRITE_SCOPE = 'https://www.googleapis.com/auth/contacts';

// Same reasoning, same off-by-default/replace-not-add shape, for the
// Planner tab's "push to Google Calendar" step (js/features/planner.js) --
// creating events is a heavier permission than just reading them.
const CALENDAR_WRITE_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

// Same again for deleting a Google Task once it's safely captured into the
// dashboard (js/features/googletasksfeed.js) -- Google has no narrower
// "delete only" scope for Tasks, so this is the full read/write scope,
// replacing tasks.readonly rather than adding to it.
const TASKS_WRITE_SCOPE = 'https://www.googleapis.com/auth/tasks';

// Sending mail from the signed-in Gmail account (the letting report's "Send via Gmail", js/features/lettingreport.js).
// Off unless turned on in Settings; unlike the others it ADDS to gmail.readonly rather than replacing it, since
// gmail.send can only send -- it cannot read -- and the app still needs to read.
const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

let scopesForSession = BASE_SCOPES.join(' ');

async function refreshScopes() {
const settings = await getLocalSettings();
let scopes = settings.contactsWriteEnabled
? BASE_SCOPES.filter((s) => s !== 'https://www.googleapis.com/auth/contacts.readonly').concat(CONTACTS_WRITE_SCOPE)
: BASE_SCOPES;
if (settings.calendarWriteEnabled) {
scopes = scopes.filter((s) => s !== 'https://www.googleapis.com/auth/calendar.readonly').concat(CALENDAR_WRITE_SCOPE);
}
if (settings.tasksWriteEnabled) {
scopes = scopes.filter((s) => s !== 'https://www.googleapis.com/auth/tasks.readonly').concat(TASKS_WRITE_SCOPE);
}
if (settings.gmailSendEnabled) scopes = scopes.concat(GMAIL_SEND_SCOPE);
const next = scopes.join(' ');
if (next !== scopesForSession) {
scopesForSession = next;
// The token client bakes in its scope at construction, so it has to be
// rebuilt, and any cached token is for the old scope set.
tokenClient = null;
cachedToken = null;
}
return scopesForSession;
}

class NotConfiguredError extends Error {
constructor() { super('Google sign-in needs an OAuth client ID first — see README.md.'); this.name = 'NotConfiguredError'; }
}

let tokenClient = null;
let cachedToken = null; // { accessToken, expiresAt }

function ensureConfigured() {
if (!GOOGLE_CLIENT_ID) throw new NotConfiguredError();
if (typeof window.google === 'undefined' || !window.google.accounts?.oauth2) {
throw new Error('Google Identity Services failed to load — check your internet connection and reload.');
}
}

function ensureTokenClient() {
ensureConfigured();
if (!tokenClient) {
tokenClient = window.google.accounts.oauth2.initTokenClient({
client_id: GOOGLE_CLIENT_ID,
scope: scopesForSession,
callback: () => {}, // replaced per-call in requestToken()
});
}
return tokenClient;
}

// Confirmed live as a real hang, desktop-only, same account that worked
// fine on mobile: a silent (prompt:'') token refresh calls back via an
// invisible iframe, and that iframe can just never call back at all --
// no error, no success -- most likely where third-party storage for
// accounts.google.com is partitioned or blocked, which desktop browsers
// enforce far more consistently than mobile ones. Nothing is on screen
// for the user to interact with either way, so a bounded wait plus a
// clear error beats "Loading…" sitting there forever with no signal at
// all. Interactive (prompt:'consent', a real popup someone's looking at)
// gets no such bound -- cutting off an actual human mid-decision would
// be actively wrong, not a safety net.
const SILENT_TOKEN_TIMEOUT_MS = 8000;

async function requestToken(prompt) {
await refreshScopes();
const attempt = new Promise((resolve, reject) => {
const client = ensureTokenClient();
client.callback = (resp) => {
if (resp.error) reject(new Error(`Google sign-in failed: ${resp.error}`));
else resolve(resp);
};
client.error_callback = (err) => reject(new Error(err?.message || 'Google sign-in was cancelled or failed.'));
client.requestAccessToken({ prompt });
});
if (prompt) return attempt;
return Promise.race([
attempt,
new Promise((_, reject) => setTimeout(
() => reject(new Error("Google's silent sign-in refresh didn't respond — try Sign In again, or check for anything (a privacy extension, a browser setting) blocking third-party cookies/storage for accounts.google.com.")),
SILENT_TOKEN_TIMEOUT_MS,
)),
]);
}

// Single-flight: GIS's token client is shared and requestAccessToken()
// overwrites client.callback, so two overlapping requests would strand the
// first caller (an 8s timeout / false "not reconnected"). Concurrent silent
// callers join one in-flight request; an interactive call waits for any
// silent one, reuses the token it produced if fresh, and is itself shared so
// two popups are never opened.
let pendingSilent = null;
let pendingInteractive = null;

function freshCached() {
return cachedToken && cachedToken.expiresAt > Date.now() + 30000 ? cachedToken.accessToken : null;
}

// No signal: never open Google's sign-in window (offline it just shows an error page over the app). A silent
// refresh is also skipped on a weak connection (bars showing, nothing getting through), which navigator.onLine
// can't see: a tiny probe to Google with a 3s cap decides. tryReconnectSilently runs again when the signal returns.
class OfflineError extends Error {
constructor() { super("You're offline, so Google can't be reached. Everything stored in the app still works; Google syncs resume when you're back online."); this.name = 'OfflineError'; }
}
const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;
async function googleReachable() {
if (isOffline()) return false;
const c = new AbortController();
const timer = setTimeout(() => c.abort(), 3000);
try { await fetch('https://www.gstatic.com/generate_204', { mode: 'no-cors', cache: 'no-store', signal: c.signal }); return true; } catch (e) { return false; } finally { clearTimeout(timer); }
}

// ---- Host-held sign-in (server/google-token.php) ----------------------------
// Once Google is linked to your web host, the host keeps the renewable sign-in and this asks it for each hourly
// token: no Google window, on any device, the NAS runner included. Anything that stops it working (the file not
// uploaded, nothing linked, a permission the link doesn't cover, this device opted out with Sign out) falls back to
// the browser sign-in below, exactly as before.
const STATUS_TTL_MS = 10 * 60000;
let hostedStatusCache = null; // {at, available, configured, linked, scopes, ...}
let pendingHosted = null;
let forceHostedNext = false;

async function hostedEndpoint() {
const { url, secret, configured } = await getSyncConfig();
if (!configured) return null;
const endpoint = url.replace(/sync\.php(?=$|\?)/, 'google-token.php');
return endpoint === url ? null : { endpoint, secret };
}

async function hostedCall(action, body) {
const ep = await hostedEndpoint();
if (!ep) return { status: 0, json: null };
const c = new AbortController();
const timer = setTimeout(() => c.abort(), 15000);
try {
const resp = await fetch(`${ep.endpoint}${ep.endpoint.includes('?') ? '&' : '?'}action=${action}`, {
method: body === undefined ? 'GET' : 'POST',
headers: { 'X-Sync-Secret': ep.secret, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
body: body === undefined ? undefined : JSON.stringify(body),
cache: 'no-store',
signal: c.signal,
});
let json = null;
try { json = await resp.json(); } catch (e) { json = null; }
return { status: resp.status, json };
} catch (err) {
if (err.name === 'AbortError') throw new Error("Your web host didn't answer the Google sign-in request within 15s.");
throw err;
} finally { clearTimeout(timer); }
}

// {available: google-token.php answered, configured, linked, scopes, linkedAt, lastRefreshAt, lastError, redirectUri}
async function hostedGoogleStatus(force) {
if (!force && hostedStatusCache && Date.now() - hostedStatusCache.at < STATUS_TTL_MS) return hostedStatusCache;
let st = { available: false, configured: false, linked: false, scopes: '' };
let answered = false;
try {
const { status, json } = await hostedCall('status');
answered = status !== 0;
if (status === 200 && json) st = { ...json, available: true };
} catch (e) { /* offline or unreachable: report unavailable, the browser sign-in still works */ }
// A host that answered is remembered for 10 minutes; a network blip only for 30 seconds, so one dropped request
// doesn't push every Google call back onto the browser sign-in for the next 10.
hostedStatusCache = { ...st, at: answered ? Date.now() : Date.now() - STATUS_TTL_MS + 30000 };
return hostedStatusCache;
}

const grantedCovers = (granted) => { const g = new Set(String(granted || '').split(/\s+/)); return scopesForSession.split(' ').every((s) => g.has(s)); };

async function hostedUsable() {
const settings = await getLocalSettings();
if (settings.googleHostedOff) return false;
await refreshScopes();
const st = await hostedGoogleStatus(false);
return !!(st.available && st.linked && grantedCovers(st.scopes));
}

// A token from the host, or null when the host has nothing to give (not linked / needs re-linking).
async function hostedToken() {
if (pendingHosted) return pendingHosted;
const force = forceHostedNext;
forceHostedNext = false;
pendingHosted = (async () => {
const { status, json } = await hostedCall('token', { force });
if (status === 200 && json && json.accessToken) {
if (hostedStatusCache && json.scopes) hostedStatusCache.scopes = json.scopes;
cachedToken = { accessToken: json.accessToken, expiresAt: Date.now() + (Number(json.expiresIn) || 3600) * 1000 };
await setLocalSetting('googleConnected', true);
return cachedToken.accessToken;
}
if (status === 404 || status === 409) { if (hostedStatusCache) hostedStatusCache.linked = false; return null; }
throw new Error((json && json.message) || `Your web host couldn't renew the Google sign-in (HTTP ${status}).`);
})().finally(() => { pendingHosted = null; });
return pendingHosted;
}

// Link once: asks the host for Google's consent address and opens it. Must be called straight from a click (the
// window is opened before anything is awaited, or the popup blocker stops it). Resolves when the host reports the
// link, by polling its status for up to 5 minutes.
async function linkGoogleToHost(onProgress = () => {}) {
const win = window.open('', 'dash-google-link', 'width=520,height=680');
try {
await refreshScopes();
const st = await hostedGoogleStatus(true);
if (!st.available) throw new Error("google-token.php isn't answering on your web host yet: upload it next to sync.php.");
if (!st.configured) throw new Error('Add google_client_id and google_client_secret to dashboard-config.php on your web host first.');
const { status, json } = await hostedCall('start', { scopes: scopesForSession });
if (status !== 200 || !json || !json.url) throw new Error((json && json.message) || `The host refused to start the link (HTTP ${status}).`);
if (win && !win.closed) win.location.href = json.url;
else window.location.assign(json.url); // popup blocked: same page, Google brings you back to the host's confirmation
onProgress('Waiting for you to finish in the Google window…');
const linkedBefore = st.linkedAt;
const until = Date.now() + 5 * 60000;
while (Date.now() < until) {
await new Promise((r) => setTimeout(r, 2500));
const now = await hostedGoogleStatus(true);
if (now.linked && now.linkedAt !== linkedBefore) {
await setLocalSetting('googleHostedOff', false);
cachedToken = null;
await getAccessToken(false);
return now;
}
if (win && win.closed && Date.now() > until - 4.5 * 60000) {
// Window closed without the link landing: one last look, then give up.
const last = await hostedGoogleStatus(true);
if (last.linked && last.linkedAt !== linkedBefore) { await setLocalSetting('googleHostedOff', false); cachedToken = null; await getAccessToken(false); return last; }
throw new Error('The Google window was closed before the link finished.');
}
}
throw new Error('Gave up waiting after 5 minutes. Press Link again to retry.');
} catch (err) {
if (win && !win.closed) win.close();
throw err;
}
}

// The permissions this device's settings currently ask for (Settings' write toggles widen them).
async function neededScopes() { await refreshScopes(); return scopesForSession.split(' '); }

async function unlinkGoogleFromHost() {
const { status, json } = await hostedCall('unlink', {});
if (status !== 200) throw new Error((json && json.message) || `HTTP ${status}`);
hostedStatusCache = null;
cachedToken = null;
}

async function getAccessToken(interactive) {
const hit = freshCached();
if (hit) return hit;
if (isOffline()) throw new OfflineError();
if (await hostedUsable()) {
// The host failing outright (Google down, a server error) falls back to the browser sign-in only for a click,
// where a window is expected; a background call reports the failure instead of opening one.
let tok = null;
try { tok = await hostedToken(); } catch (err) { if (!interactive) throw err; console.warn('Host-held Google sign-in failed, using the browser sign-in:', err); }
if (tok) return tok;
}
if (!interactive) {
if (!pendingSilent && !(await googleReachable())) throw new OfflineError();
if (pendingSilent) return pendingSilent;
// If an interactive request overwrote the shared callback meanwhile, this one times out:
// hand back the token the popup produced instead of failing.
const p = fetchNewToken(false)
.catch((err) => { const c = freshCached(); if (c) return c; throw err; })
.finally(() => { if (pendingSilent === p) pendingSilent = null; });
pendingSilent = p;
return p;
}
// Wait briefly for a silent request already in flight, but not past the click's user-activation
// window (~5s in Chrome) or the popup gets blocked: after 1.5s go interactive anyway.
if (pendingSilent) {
try { await Promise.race([pendingSilent, new Promise((r) => setTimeout(r, 1500))]); } catch (e) { /* fall through to the popup */ }
}
const again = freshCached();
if (again) return again;
if (pendingInteractive) return pendingInteractive;
const p = fetchNewToken(true).finally(() => { if (pendingInteractive === p) pendingInteractive = null; });
pendingInteractive = p;
return p;
}

async function fetchNewToken(interactive) {
let resp;
try {
resp = await requestToken(interactive ? 'consent' : '');
} catch (err) {
// A silent refresh that hung/got blocked (third-party storage for
// accounts.google.com partitioned or blocked -- see requestToken's own
// comment) is worth ONE retry as a real interactive popup, but only
// when the browser still considers this call within a trusted user
// gesture (navigator.userActivation.isActive) -- the same condition
// that lets a popup through at all. Outside that window (page load's
// own tryReconnectSilently, or a scheduled task auto-running because
// the app was just opened, not clicked) this must stay exactly as
// silent as before: attempting a popup there would either do nothing
// (blocked anyway) or surface a "popup blocked" browser indicator for
// something that's supposed to be invisible, so it's skipped rather
// than gambled on. If the interactive attempt ALSO fails (activation
// can lapse during the silent attempt's own wait), the original
// failure still surfaces as a normal error for the caller to show.
const canEscalate = !interactive && typeof navigator !== 'undefined' && navigator.userActivation?.isActive;
if (!canEscalate) throw err;
resp = await requestToken('consent');
}
cachedToken = { accessToken: resp.access_token, expiresAt: Date.now() + (resp.expires_in || 3600) * 1000 };
await setLocalSetting('googleConnected', true);
return cachedToken.accessToken;
}

// Fast, local-only check — never touches the network or opens anything, so
// it's safe to call during page load without tripping a popup blocker.
function isSignedIn() {
return !!(cachedToken && cachedToken.expiresAt > Date.now() + 30000);
}

async function wasConnectedBefore() {
const settings = await getLocalSettings();
return !!settings.googleConnected;
}

// isSignedIn() alone is too strict a gate for an action button: the ~hour-
// long token can quietly expire between page load and a much later click,
// without the header re-rendering to reflect that — so isSignedIn() can say
// "no" while the rest of the page still visually shows "connected." But
// that click is a trusted user gesture, the same kind a fresh sign-in
// needs, so the actual API call below (via googleFetch → getAccessToken)
// can often refresh the token silently right then. Gating on this instead
// of isSignedIn() means: only show "sign in first" when there's truly
// nothing to attempt a silent refresh from.
async function canAttemptGoogleAction() {
return isSignedIn() || (await wasConnectedBefore()) || (await hostedUsable().catch(() => false));
}

// Best-effort silent reconnect, meant to be called on page load. Must
// NEVER surface an error or block the UI on failure — Google's "silent"
// token renewal still opens (and usually auto-closes) a real popup window,
// and calling it outside a direct click handler means browsers' popup
// blockers treat it exactly like an unwanted popup and kill it. When that
// happens this should look like nothing happened, not like a sign-out —
// the caller falls back to the normal one-click Sign In button, which
// works reliably because a real click is a trusted gesture popup blockers
// let through.
async function tryReconnectSilently() {
try {
if (await hostedUsable()) { await getAccessToken(false); return true; } // no Google script or window needed
ensureConfigured();
if (!(await wasConnectedBefore())) return false;
await getAccessToken(false);
return true;
} catch (e) {
return false;
}
}

async function signIn() {
await setLocalSetting('googleHostedOff', false);
await getAccessToken(true);
}

// With the host-held sign-in, Sign out stops THIS device using it (it would otherwise just sign straight back in);
// the link itself stays for your other devices. Unlinking is in Settings → Google account.
async function signOut() {
if (await hostedUsable().catch(() => false)) {
await setLocalSetting('googleHostedOff', true);
cachedToken = null;
pendingSilent = null;
pendingInteractive = null;
for (const fn of signOutHooks) { try { fn(); } catch (e) { /* a hook must not block sign-out */ } }
await setLocalSetting('googleConnected', false);
return;
}
if (cachedToken && window.google?.accounts?.oauth2?.revoke) {
await new Promise((resolve) => window.google.accounts.oauth2.revoke(cachedToken.accessToken, resolve));
}
cachedToken = null;
pendingSilent = null;
pendingInteractive = null;
for (const fn of signOutHooks) { try { fn(); } catch (e) { /* a hook must not block sign-out */ } }
await setLocalSetting('googleConnected', false);
}

// Lets caches elsewhere (e.g. googlecalendar.js's calendarList) drop their
// contents on sign-out without googleauth importing them (circular).
const signOutHooks = [];
function onSignOut(fn) { signOutHooks.push(fn); }

// Same reasoning as SILENT_TOKEN_TIMEOUT_MS above, one layer further in --
// confirmed live, this can also hang on the actual API request itself
// (Gmail search/metadata, Calendar, Contacts, Tasks, a single Drive photo
// upload), not just the token step, with nothing thrown and nothing shown
// beyond whatever "Loading…" the caller already had up. 20s matches this
// codebase's own precedent for a bounded API call (selfhost.js's
// REQUEST_TIMEOUT_MS is 15s for a comparable JSON round-trip) with a
// little extra room for the heavier calls that go through here too (a
// Drive photo upload, one at a time -- files.js's own 120s is for that
// module's much larger multi-file transcription uploads specifically, not
// a fit for a single small API call sitting on "Loading…").
const GOOGLE_FETCH_TIMEOUT_MS = 20000;

// Authenticated fetch helper for any Google API — Drive, Calendar, etc.
async function googleFetch(url, options = {}, interactive) {
const token = await getAccessToken(interactive);
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), GOOGLE_FETCH_TIMEOUT_MS);
try {
const doFetch = (tok) => fetch(url, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${tok}` }, signal: controller.signal });
const resp = await doFetch(token);
// A rejected token (revoked or expired in flight) would otherwise be reused from the cache until its expiry:
// drop it and retry once with a fresh one. If getting a fresh one fails, hand back the original 401.
if (resp.status === 401) {
// Drop the rejected token only if it is still the cached one; if another caller already replaced
// or cleared it, getAccessToken() returns the newer token / joins the one refresh in flight.
if (cachedToken && cachedToken.accessToken === token) { cachedToken = null; forceHostedNext = true; }
let fresh = null;
try { fresh = await getAccessToken(interactive); } catch (e) { fresh = null; }
if (fresh && fresh !== token) return await doFetch(fresh);
}
return resp;
} catch (err) {
if (err.name === 'AbortError') throw new Error(`Google didn't respond within ${GOOGLE_FETCH_TIMEOUT_MS / 1000}s — try again, or check for anything (a privacy extension, a network filter) that might be blocking requests to Google's API.`);
throw err;
} finally {
clearTimeout(timer);
}
}

// Exact-token membership, not a substring check -- scopesForSession is a
// space-joined string, and a plain .includes(CONTACTS_WRITE_SCOPE) was
// confirmed live to false-positive even with write OFF, because
// '.../auth/contacts.readonly' literally contains '.../auth/contacts' as
// a prefix (same trap TASKS_WRITE_SCOPE/'tasks.readonly' falls into).
// CALENDAR_WRITE_SCOPE happened not to share a prefix with its own
// readonly scope, which is exactly why this went unnoticed until now.
function hasScope(scope) {
return scopesForSession.split(' ').includes(scope);
}

// True when the current session was granted the Contacts write scope, so UI
// that writes can hide itself rather than failing at the API with a 403.
function hasContactsWrite() {
return hasScope(CONTACTS_WRITE_SCOPE);
}

// Same check for the Calendar write scope -- see CALENDAR_WRITE_SCOPE above.
function hasCalendarWrite() {
return hasScope(CALENDAR_WRITE_SCOPE);
}

// Same check for the Tasks write scope -- see TASKS_WRITE_SCOPE above.
function hasTasksWrite() {
return hasScope(TASKS_WRITE_SCOPE);
}

// True when the current session was granted the Gmail send scope -- see GMAIL_SEND_SCOPE above.
function hasGmailSend() {
return hasScope(GMAIL_SEND_SCOPE);
}

export {
NotConfiguredError, OfflineError,
isSignedIn, wasConnectedBefore, canAttemptGoogleAction, tryReconnectSilently, signIn, signOut,
googleFetch, onSignOut, refreshScopes, hostedGoogleStatus, linkGoogleToHost, unlinkGoogleFromHost, neededScopes, hasContactsWrite, hasCalendarWrite, hasTasksWrite, hasGmailSend,
};
