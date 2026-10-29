import { getToken, setToken, redeemInvite, getMe, ApiError } from './api.js';
import { renderRecommendations, initProfileForm } from './recommend.js';
import { renderAccounts, initAccounts, setAddAccountEnabled } from './accounts.js';
import { renderCassGrid } from './cass.js';
import { renderReferrals } from './referrals.js';

const tabs = [...document.querySelectorAll('.tab-btn')];
const panels = [...document.querySelectorAll('.tab-panel')];
tabs.forEach((btn) => {
  btn.addEventListener('click', () => {
    tabs.forEach((b) => b.classList.toggle('active', b === btn));
    panels.forEach((p) => p.classList.toggle('active', p.id === `panel-${btn.dataset.tab}`));
  });
});

// Only Recommendations/My accounts/CASS map need an invite token; Referral
// links is public, so the message goes inside just those three panels.
const NEEDS_INVITE_MESSAGE = 'You need an invite link to use this. Ask whoever runs it for one.';

function showNeedsInvite(message) {
  ['plan-mount', 'rec-list', 'accounts-list', 'cass-grid-mount'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = `<div class="empty">${message}</div>`;
  });
  setAddAccountEnabled(false);
}

async function loadMe() {
  if (!getToken()) { showNeedsInvite(NEEDS_INVITE_MESSAGE); return; }
  try {
    const me = await getMe();
    renderRecommendations(me);
    renderAccounts(me);
    renderCassGrid(me);
    setAddAccountEnabled(true);
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
renderReferrals();
boot();
