import { upsertAccount, deleteAccount, getBankList } from './api.js';
import { escapeHtml, uid } from './utils.js';

let bankListCache = [];

function accountRowHtml(a) {
  const bonuses = (a.switchBonuses || []).map((sb) => `${escapeHtml(sb.bank || '')} ${sb.amount ? `£${sb.amount}` : ''} (${escapeHtml(sb.status || '')})`).join(', ');
  return `<div class="account-row" data-account-id="${escapeHtml(a.id)}">
    <div class="account-head">
      <span class="account-bank">${escapeHtml(a.bank)}${a.nickname ? ` — ${escapeHtml(a.nickname)}` : ''}</span>
      <span class="tag-chip ${a.closeDate ? '' : 'pri-high'}">${a.closeDate ? 'Closed' : 'Open'}</span>
      ${a.cassReady ? '<span class="tag-chip pri-medium">CASS-ready</span>' : ''}
      <span class="del-x" data-delete-account="${escapeHtml(a.id)}" title="Delete">&times;</span>
    </div>
    <div class="account-detail">
      ${a.openDate ? `Opened ${escapeHtml(a.openDate)}` : 'Open date not set'}${a.closeDate ? ` · Closed ${escapeHtml(a.closeDate)}` : ''}
      ${a.directDebitCount != null ? ` · ${a.directDebitCount} Direct Debits` : ''}
      ${a.wantToKeep === true ? ' · Keeping this one' : a.wantToKeep === false ? ' · Planning to leave' : ''}
    </div>
    ${bonuses ? `<div class="account-detail">Switch bonuses: ${bonuses}</div>` : ''}
    <button class="sync-btn sm inline" type="button" data-edit-account="${escapeHtml(a.id)}">Edit</button>
  </div>`;
}

export function renderAccounts(me) {
  const list = document.getElementById('accounts-list');
  if (!list) return;
  const accounts = me.user.accounts || [];
  list.innerHTML = accounts.length ? accounts.map(accountRowHtml).join('') : '<div class="empty">No accounts added yet.</div>';
  list.querySelectorAll('[data-delete-account]').forEach((el) => {
    el.addEventListener('click', async () => {
      if (!confirm('Delete this account?')) return;
      await deleteAccount(el.dataset.deleteAccount);
      window.dispatchEvent(new CustomEvent('switchadvisor:refresh'));
    });
  });
  list.querySelectorAll('[data-edit-account]').forEach((el) => {
    el.addEventListener('click', () => {
      const account = accounts.find((a) => a.id === el.dataset.editAccount);
      openAccountForm(account);
    });
  });
}

function openAccountForm(account) {
  const dialog = document.getElementById('account-dialog');
  const form = document.getElementById('account-form');
  if (!dialog || !form) return;
  form.reset();
  form.elements.id.value = account?.id || '';
  form.elements.bank.value = account?.bank || '';
  form.elements.nickname.value = account?.nickname || '';
  form.elements.openDate.value = account?.openDate || '';
  form.elements.closeDate.value = account?.closeDate || '';
  form.elements.wantToKeep.value = account?.wantToKeep === true ? 'true' : account?.wantToKeep === false ? 'false' : '';
  form.elements.cassReady.checked = !!account?.cassReady;
  form.elements.directDebitCount.value = account?.directDebitCount ?? '';
  dialog.showModal();
}

export function initAccounts() {
  const addBtn = document.getElementById('add-account-btn');
  const dialog = document.getElementById('account-dialog');
  const form = document.getElementById('account-form');
  const bankInput = document.getElementById('account-bank-input');
  const bankList = document.getElementById('bank-datalist');
  if (!addBtn || !dialog || !form) return;

  getBankList().then(({ banks }) => {
    bankListCache = banks || [];
    if (bankList) bankList.innerHTML = bankListCache.map((b) => `<option value="${escapeHtml(b)}">`).join('');
  }).catch(() => {});

  addBtn.addEventListener('click', () => openAccountForm(null));
  document.getElementById('account-cancel-btn')?.addEventListener('click', () => dialog.close());

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const account = {
      id: fd.get('id') || uid(),
      bank: fd.get('bank'),
      nickname: fd.get('nickname'),
      openDate: fd.get('openDate'),
      closeDate: fd.get('closeDate'),
      wantToKeep: fd.get('wantToKeep') === 'true' ? true : fd.get('wantToKeep') === 'false' ? false : null,
      cassReady: fd.get('cassReady') === 'on',
      directDebitCount: fd.get('directDebitCount') ? Number(fd.get('directDebitCount')) : null,
    };
    if (!account.bank) return;
    await upsertAccount(account);
    dialog.close();
    window.dispatchEvent(new CustomEvent('switchadvisor:refresh'));
  });
}
