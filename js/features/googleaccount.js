// The shared Google sign-in status/button, shown at the top of Overview
// since — with no refresh token in this pure client-side auth flow —
// reconnecting is common enough that it needed to stop being buried in
// Settings. Drive Push/Pull, Calendar Sync, and Mail Refresh all just call
// isSignedIn() themselves at click time rather than subscribing to this
// panel's state, which keeps this module the only thing that needs to know
// about sign-in/out UI at all.
import { getLocalSettings } from '../state.js';
import { NotConfiguredError, isSignedIn, wasConnectedBefore, tryReconnectSilently, signIn, signOut } from '../sync/googleauth.js';

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
statusEl.textContent = err instanceof NotConfiguredError
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
} catch (err) {
statusEl.textContent = `Sign-out failed: ${err.message || err}`;
console.error('Google sign-out failed:', err);
}
});

refresh();

// Opportunistic, silent, entirely best-effort — see googleauth.js for why
// this must never surface an error or block the UI on failure.
tryReconnectSilently().then((reconnected) => { if (reconnected) refresh(); });
}

export { initGoogleAccount };
