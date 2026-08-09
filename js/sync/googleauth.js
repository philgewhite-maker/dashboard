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

const SCOPES = [
'https://www.googleapis.com/auth/drive.appdata',
'https://www.googleapis.com/auth/calendar.readonly',
'https://www.googleapis.com/auth/gmail.readonly',
].join(' ');

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
scope: SCOPES,
callback: () => {}, // replaced per-call in requestToken()
});
}
return tokenClient;
}

function requestToken(prompt) {
return new Promise((resolve, reject) => {
const client = ensureTokenClient();
client.callback = (resp) => {
if (resp.error) reject(new Error(`Google sign-in failed: ${resp.error}`));
else resolve(resp);
};
client.error_callback = (err) => reject(new Error(err?.message || 'Google sign-in was cancelled or failed.'));
client.requestAccessToken({ prompt });
});
}

async function getAccessToken(interactive) {
if (cachedToken && cachedToken.expiresAt > Date.now() + 30000) return cachedToken.accessToken;
const resp = await requestToken(interactive ? 'consent' : '');
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
ensureConfigured();
if (!(await wasConnectedBefore())) return false;
await getAccessToken(false);
return true;
} catch (e) {
return false;
}
}

async function signIn() {
await getAccessToken(true);
}

async function signOut() {
if (cachedToken && window.google?.accounts?.oauth2?.revoke) {
await new Promise((resolve) => window.google.accounts.oauth2.revoke(cachedToken.accessToken, resolve));
}
cachedToken = null;
await setLocalSetting('googleConnected', false);
}

// Authenticated fetch helper for any Google API — Drive, Calendar, etc.
async function googleFetch(url, options = {}, interactive) {
const token = await getAccessToken(interactive);
return fetch(url, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` } });
}

export {
NotConfiguredError,
isSignedIn, wasConnectedBefore, tryReconnectSilently, signIn, signOut,
googleFetch,
};
