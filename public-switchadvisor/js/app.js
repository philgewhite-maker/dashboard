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

async function loadMe() {
  const statusEl = document.getElementById('app-status');
  try {
    const me = await getMe();
    document.getElementById('gate').hidden = true;
    document.getElementById('app').hidden = false;
    renderRecommendations(me);
    renderAccounts(me);
    renderCassGrid(me);
    if (statusEl) statusEl.textContent = '';
  } catch (err) {
    document.getElementById('gate').hidden = false;
    document.getElementById('app').hidden = true;
    document.getElementById('gate-message').textContent = err instanceof ApiError
      ? 'That invite link is no longer valid — ask for a new one.'
      : `Couldn't reach the server: ${err.message}`;
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
      document.getElementById('gate-message').textContent = 'That invite link is no longer valid — ask for a new one.';
      return;
    }
  }
  if (!getToken()) {
    document.getElementById('gate-message').textContent = 'You need an invite link to use this. Ask whoever invited you to send it again.';
    return;
  }
  await loadMe();
}

window.addEventListener('switchadvisor:refresh', loadMe);
initProfileForm(loadMe);
initAccounts();
initAdmin();
renderReferrals();
boot();
