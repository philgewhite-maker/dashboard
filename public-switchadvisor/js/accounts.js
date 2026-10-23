import { upsertAccount, deleteAccount, getBankList, getToken } from './api.js';
import { escapeHtml, uid } from './utils.js';

let bankListCache = [];

// Mirrors the server's own is_cass_ready() exactly (switchadvisor.php)
// -- open, and not explicitly marked "keep". Purely a display label
// here; the server recomputes this itself for the recommendation
// engine, so the two can't drift into disagreeing about a stored flag
// because there no longer is one.
function cassReadyLabel(a) {
  return !a.closeDate && a.wantToKeep !== true;
}

function accountRowHtml(a) {
  const bonuses = (a.switchBonuses || []).map((sb) => `${sb.amount ? `£${sb.amount}` : ''} (${escapeHtml(sb.status || '')})${sb.date ? ` — ${escapeHtml(sb.date)}` : ''}`).join(', ');
  return `<div class="account-row" data-account-id="${escapeHtml(a.id)}">
    <div class="account-head">
      <span class="account-bank">${escapeHtml(a.bank)}${a.nickname ? ` — ${escapeHtml(a.nickname)}` : ''}</span>
      <span class="tag-chip ${a.closeDate ? '' : 'pri-high'}">${a.closeDate ? 'Closed' : 'Open'}</span>
      ${cassReadyLabel(a) ? '<span class="tag-chip pri-medium">Assumed CASS-ready</span>' : ''}
      <span class="del-x" data-delete-account="${escapeHtml(a.id)}" title="Delete">&times;</span>
    </div>
    <div class="account-detail">
      ${a.openDate ? `Opened ${escapeHtml(a.openDate)}` : 'Open date not set'}${a.closeDate ? ` · Closed ${escapeHtml(a.closeDate)}` : ''}
      ${a.directDebitCount != null ? ` · ${a.directDebitCount} Direct Debits` : ''}
      ${a.wantToKeep === true ? ' · Keeping this one' : a.wantToKeep === false ? ' · Planning to leave' : ''}
    </div>
    ${bonuses ? `<div class="account-detail">Switch bonus: ${bonuses}</div>` : ''}
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
      try {
        await deleteAccount(el.dataset.deleteAccount);
        window.dispatchEvent(new CustomEvent('switchadvisor:refresh'));
      } catch (err) {
        alert(`Couldn't delete: ${err.message}`);
      }
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
  form.elements.directDebitCount.value = account?.directDebitCount ?? '';
  // Only one switch bonus shown/edited here (the one from opening THIS
  // account) -- the data model allows more, but a second one on the same
  // account is rare enough not to need a repeater UI for it.
  const bonus = (account?.switchBonuses || [])[0];
  form.elements.switchBonusStatus.value = bonus?.status || '';
  form.elements.switchBonusAmount.value = bonus?.amount ?? '';
  form.elements.switchBonusDate.value = bonus?.date || '';
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

  addBtn.addEventListener('click', () => {
    // Belt-and-braces: app.js already hides this button with no token,
    // but guard here too so the dialog never opens into a save that can
    // only fail -- confirmed live as a real gap otherwise (the button
    // used to be clickable with no token at all, and the save failed
    // silently with no visible error).
    if (!getToken()) { alert("You need an invite link to add accounts. Ask whoever invited you."); return; }
    openAccountForm(null);
  });
  document.getElementById('account-cancel-btn')?.addEventListener('click', () => dialog.close());

  const errorEl = document.getElementById('account-form-error');
  const say = (m) => { if (errorEl) errorEl.textContent = m; };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    say('');
    const fd = new FormData(form);
    const account = {
      id: fd.get('id') || uid(),
      bank: fd.get('bank'),
      nickname: fd.get('nickname'),
      openDate: fd.get('openDate'),
      closeDate: fd.get('closeDate'),
      wantToKeep: fd.get('wantToKeep') === 'true' ? true : fd.get('wantToKeep') === 'false' ? false : null,
      directDebitCount: fd.get('directDebitCount') ? Number(fd.get('directDebitCount')) : null,
      switchBonuses: fd.get('switchBonusStatus')
        ? [{ amount: fd.get('switchBonusAmount') ? Number(fd.get('switchBonusAmount')) : 0, status: fd.get('switchBonusStatus'), date: fd.get('switchBonusDate') || '' }]
        : [],
    };
    if (!account.bank) { say('Pick a bank first.'); return; }
    try {
      await upsertAccount(account);
      dialog.close();
      window.dispatchEvent(new CustomEvent('switchadvisor:refresh'));
    } catch (err) {
      say(`Couldn't save: ${err.message}`);
    }
  });
}

export function setAddAccountEnabled(enabled) {
  const addBtn = document.getElementById('add-account-btn');
  if (addBtn) addBtn.hidden = !enabled;
}
