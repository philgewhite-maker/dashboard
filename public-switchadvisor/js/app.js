import { getToken, setToken, redeemInvite, getMe, ApiError } from './api.js';
import { renderRecommendations, initProfileForm } from './recommend.js';
import { renderAccounts, initAccounts } from './accounts.js';
import { renderCassGrid } from './cass.js';
import { renderReferrals } from './referrals.js';
import { initAdmin } from './admin.js';

const tabs = [...document.querySelectorAll('.tab-btn')];
const panels = [...document.querySelectorAll('.tab-panel')];
tabs.forEach((btn) => {
  btn.addEventListener('click', () => {
    tabs.forEach((b) => b.classList.toggle('active', b === btn));
    panels.forEach((p) => p.classList.toggle('active', p.id === `panel-${btn.dataset.tab}`));
  });
});

// Only Recommendations/My accounts/CASS map need an invite token -- the
// Admin tab uses its own, completely separate credential (the admin
// secret), and Referrals is public. Showing a "need an invite" message
// INSIDE just those three panels, rather than hiding the whole app
// behind one gate, is what lets you (the admin) reach Admin and create
// the first invite without having redeemed one on yourself.
const NEEDS_INVITE_MESSAGE = "You need an invite link to use this. If you're the admin, open the Admin tab to create one.";

function showNeedsInvite(message) {
  ['rec-list', 'accounts-list', 'cass-grid-mount'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = `<div class="empty">${message}</div>`;
  });
}

async function loadMe() {
  if (!getToken()) { showNeedsInvite(NEEDS_INVITE_MESSAGE); return; }
  try {
    const me = await getMe();
    renderRecommendations(me);
    renderAccounts(me);
    renderCassGrid(me);
  } catch (err) {
    showNeedsInvite(err instanceof ApiError
      ? 'That invite link is no longer valid — ask whoever invited you for a new one.'
      : `Couldn't reach the server: ${err.message}`);
  }
}

async function boot() {
  const params = new URLSearchParams(window.location.search);
  const inviteToken = params.get('invite');
  if (inviteToken) {
    try {
      await redeemInvite(inviteToken);
      setToken(inviteToken);
      window.history.replaceState({}, '', window.location.pathname);
    } catch (err) {
      showNeedsInvite('That invite link is no longer valid — ask for a new one.');
      return;
    }
  }
  await loadMe();
}

window.addEventListener('switchadvisor:refresh', loadMe);
initProfileForm(loadMe);
initAccounts();
initAdmin();
renderReferrals();
boot();
