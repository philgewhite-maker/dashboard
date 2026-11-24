// The shared Google sign-in status/button, shown at the top of Overview
// since — with no refresh token in this pure client-side auth flow —
// reconnecting is common enough that it needed to stop being buried in
// Settings. Drive Push/Pull, Calendar Sync, and Mail Refresh all just call
// isSignedIn() themselves at click time rather than subscribing to this
// panel's state, which keeps this module the only thing that needs to know
// about sign-in/out UI at all.
//
// Also Settings → Google account → Stay signed in: linking Google to the web host (server/google-token.php), which
// replaces the hourly sign-in window with a token the host renews.
import { getLocalSettings } from '../state.js';
import { escapeHtml } from '../utils.js';
import {
NotConfiguredError, OfflineError, isSignedIn, wasConnectedBefore, tryReconnectSilently, signIn, signOut,
hostedGoogleStatus, linkGoogleToHost, unlinkGoogleFromHost, neededScopes,
} from '../sync/googleauth.js';
import { isConfigured as liveSyncConfigured } from '../sync/selfhost.js';

const SYNC_LINK = '<span class="inline-goto-link" data-goto-tab="settings" data-goto-target="#sync-url-input">live sync</span>';

async function renderHostLink() {
const statusEl = document.getElementById('google-host-status');
const linkBtn = document.getElementById('google-host-link-btn');
const unlinkBtn = document.getElementById('google-host-unlink-btn');
if (!statusEl || !linkBtn || !unlinkBtn) return;
if (!(await liveSyncConfigured())) {
statusEl.innerHTML = `Needs ${SYNC_LINK} set up on this device first: the link lives on the same web host.`;
linkBtn.style.display = 'none';
unlinkBtn.style.display = 'none';
return;
}
const st = await hostedGoogleStatus(true);
const settings = await getLocalSettings();
linkBtn.style.display = '';
unlinkBtn.style.display = st.linked ? '' : 'none';
if (!st.available) {
statusEl.textContent = "Not available yet: upload server/google-token.php to your web host, next to sync.php.";
linkBtn.style.display = 'none';
return;
}
if (!st.configured) {
statusEl.innerHTML = `Not set up on the host yet: add <code>google_client_id</code> and <code>google_client_secret</code> to dashboard-config.php, and add this address to the OAuth client's Authorised redirect URIs in the Google Cloud console: <code>${escapeHtml(st.redirectUri || '')}</code>`;
linkBtn.style.display = 'none';
return;
}
if (!st.linked) {
statusEl.textContent = st.lastError ? `Not linked. Last problem: ${st.lastError}` : 'Not linked. Each device signs in to Google by itself, about every hour.';
linkBtn.textContent = 'Link Google to your host';
return;
}
const granted = new Set(String(st.scopes || '').split(/\s+/));
const missing = (await neededScopes()).filter((s) => !granted.has(s));
const when = st.lastRefreshAt ? new Date(st.lastRefreshAt).toLocaleString() : 'not yet';
statusEl.innerHTML = escapeHtml(`Linked${st.linkedAt ? ` on ${new Date(st.linkedAt).toLocaleDateString()}` : ''}${st.linkedBy ? ` from ${st.linkedBy}` : ''}. Last renewed ${when}.`
+ (missing.length ? ` It doesn't cover ${missing.length} permission${missing.length === 1 ? '' : 's'} this device now asks for (${missing.map((s) => s.replace('https://www.googleapis.com/auth/', '')).join(', ')}), so this device uses its own sign-in until you link again.` : ''))
+ (settings.googleHostedOff ? ' This device is signed out of it: press <span class="inline-goto-link" data-goto-tab="overview" data-goto-target="#sync-signin-btn">Sign in to Google</span> to use it again.' : '');
linkBtn.textContent = missing.length ? 'Link again to add permissions' : 'Link again';
}

function initHostLink(refreshHeader) {
const linkBtn = document.getElementById('google-host-link-btn');
const unlinkBtn = document.getElementById('google-host-unlink-btn');
const msg = document.getElementById('google-host-msg');
if (!linkBtn || !unlinkBtn) return;
linkBtn.addEventListener('click', async () => {
linkBtn.disabled = true;
msg.textContent = 'Opening Google…';
try {
await linkGoogleToHost((m) => { msg.textContent = m; });
msg.textContent = 'Linked. This device now gets its Google access from your host.';
} catch (err) {
msg.textContent = `Not linked: ${err.message || err}`;
} finally {
linkBtn.disabled = false;
renderHostLink();
refreshHeader();
}
});
unlinkBtn.addEventListener('click', async () => {
unlinkBtn.disabled = true;
try {
await unlinkGoogleFromHost();
msg.textContent = 'Unlinked and revoked at Google. Devices go back to signing in by themselves.';
} catch (err) {
msg.textContent = `Couldn't unlink: ${err.message || err}`;
} finally {
unlinkBtn.disabled = false;
renderHostLink();
refreshHeader();
}
});
renderHostLink();
}

function initGoogleAccount() {
const signedOutBox = document.getElementById('google-signed-out');
const signedInBox = document.getElementById('google-signed-in');
const accountEl = document.getElementById('sync-account');
const statusEl = document.getElementById('sync-status');
const signinBtn = document.getElementById('sync-signin-btn');
const signoutBtn = document.getElementById('sync-signout-btn');

async function refresh() {
const signedIn = isSignedIn(); // fast, local-only — never blocks or opens anything
signedOutBox.style.display = signedIn ? 'none' : 'block';
signedInBox.style.display = signedIn ? 'block' : 'none';
if (signedIn) {
const settings = await getLocalSettings();
const parts = ['Connected to Google (Drive sync + Calendar + Mail)'];
if (settings.lastPushedAt) parts.push(`last pushed ${new Date(settings.lastPushedAt).toLocaleString()}`);
if (settings.lastPulledAt) parts.push(`last pulled ${new Date(settings.lastPulledAt).toLocaleString()}`);
accountEl.textContent = parts.join(' — ');
} else if (await wasConnectedBefore()) {
signinBtn.textContent = 'Reconnect to Google';
} else {
signinBtn.textContent = 'Sign in to Google';
}
}

signinBtn.addEventListener('click', async () => {
statusEl.textContent = 'Opening Google sign-in…';
try {
await signIn();
statusEl.textContent = 'Signed in.';
await refresh();
} catch (err) {
statusEl.textContent = err instanceof NotConfiguredError || err instanceof OfflineError
? err.message
: `Sign-in failed: ${err.message || err}`;
console.error('Google sign-in failed:', err);
}
});

signoutBtn.addEventListener('click', async () => {
try {
await signOut();
statusEl.textContent = 'Signed out.';
await refresh();
renderHostLink();
} catch (err) {
statusEl.textContent = `Sign-out failed: ${err.message || err}`;
console.error('Google sign-out failed:', err);
}
});

refresh();
initHostLink(refresh);

// Opportunistic, silent, entirely best-effort — see googleauth.js for why
// this must never surface an error or block the UI on failure.
const reconnect = () => tryReconnectSilently().then((reconnected) => { if (reconnected) refresh(); });
reconnect();
// Signal back after a spell offline: reconnect quietly rather than waiting for the next app open.
window.addEventListener('online', () => { if (!isSignedIn()) reconnect(); });
}

export { initGoogleAccount };
