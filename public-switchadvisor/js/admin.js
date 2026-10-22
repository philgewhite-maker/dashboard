import { createInvite, listInvites } from './api.js';
import { escapeHtml } from './utils.js';

const SECRET_KEY = 'switchadvisor-admin-secret';

function inviteRowHtml(inv) {
  return `<div class="account-row">
    <div class="account-head">
      <span class="account-bank">${escapeHtml(inv.label)}</span>
      <span class="tag-chip ${inv.redeemed ? 'pri-high' : ''}">${inv.redeemed ? 'Redeemed' : 'Not used yet'}</span>
    </div>
    <div class="account-detail">
      Created ${escapeHtml((inv.createdAt || '').slice(0, 10))}
      ${inv.lastRedeemedAt ? ` · Last used ${escapeHtml(inv.lastRedeemedAt.slice(0, 10))}` : ''}
      ${inv.userEmail ? ` · ${escapeHtml(inv.userEmail)}` : ''}
      ${inv.redeemed ? ` · ${inv.accountCount} account${inv.accountCount === 1 ? '' : 's'} added` : ''}
    </div>
  </div>`;
}

async function refreshInviteList() {
  const list = document.getElementById('admin-invite-list');
  if (!list) return;
  try {
    const { invites } = await listInvites();
    list.innerHTML = invites.length ? invites.map(inviteRowHtml).join('') : '<div class="empty">No invites created yet.</div>';
  } catch (err) {
    list.innerHTML = `<div class="empty">Couldn't load invites: ${escapeHtml(err.message)}</div>`;
  }
}

export function initAdmin() {
  const unlockForm = document.getElementById('admin-unlock-form');
  const panel = document.getElementById('admin-panel');
  const secretInput = document.getElementById('admin-secret-input');
  if (!unlockForm || !panel) return;

  const existing = sessionStorage.getItem(SECRET_KEY);
  if (existing) {
    unlockForm.hidden = true;
    panel.hidden = false;
    refreshInviteList();
  }

  unlockForm.addEventListener('submit', (e) => {
    e.preventDefault();
    sessionStorage.setItem(SECRET_KEY, secretInput.value);
    unlockForm.hidden = true;
    panel.hidden = false;
    refreshInviteList();
  });

  const createForm = document.getElementById('admin-create-invite-form');
  createForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const label = document.getElementById('admin-invite-label').value;
    const result = document.getElementById('admin-invite-result');
    try {
      const { token } = await createInvite(label);
      const base = window.location.origin + window.location.pathname;
      const url = `${base}?invite=${token}`;
      result.innerHTML = `Invite link for <strong>${escapeHtml(label)}</strong>: <code>${escapeHtml(url)}</code>`;
      document.getElementById('admin-invite-label').value = '';
      refreshInviteList();
    } catch (err) {
      result.textContent = `Couldn't create invite: ${err.message}`;
      if (err.message.includes('admin secret')) {
        sessionStorage.removeItem(SECRET_KEY);
        unlockForm.hidden = false;
        panel.hidden = true;
      }
    }
  });
}
