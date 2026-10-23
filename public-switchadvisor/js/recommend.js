import { updateProfile } from './api.js';
import { escapeHtml, money } from './utils.js';

const PRIORITY_LABEL = { high: 'High', medium: 'Medium', low: 'Low', 'n/a': 'Not eligible' };
const PRIORITY_CLASS = { high: 'pri-high', medium: 'pri-medium', low: 'pri-low', 'n/a': 'pri-none' };

function rowHtml(r) {
  return `<div class="rec-row ${r.eligible ? '' : 'rec-ineligible'}">
    <div class="rec-head">
      <span class="rec-bank">${escapeHtml(r.product || r.bank)}</span>
      <span class="rec-amount">${money(r.amount)}</span>
      <span class="tag-chip ${PRIORITY_CLASS[r.priority] || ''}">${PRIORITY_LABEL[r.priority] || r.priority}</span>
    </div>
    <div class="rec-rationale">${escapeHtml(r.rationale)}</div>
    ${(r.todo || []).map((t) => `<div class="rec-todo"><strong>To do:</strong> ${escapeHtml(t)}</div>`).join('')}
    ${r.conditions ? `<details class="rec-conditions"><summary>Terms</summary>${escapeHtml(r.conditions)}</details>` : ''}
    ${r.url ? `<a class="rec-link" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">View offer &rarr;</a>` : ''}
  </div>`;
}

export function renderRecommendations(me) {
  const asOf = document.getElementById('rec-asof');
  if (asOf) asOf.textContent = me.cacheAsOf ? `Offers last checked ${me.cacheAsOf}.` : 'Offers not yet checked.';

  const list = document.getElementById('rec-list');
  if (list) {
    const rows = me.recommendations || [];
    list.innerHTML = rows.length
      ? rows.map(rowHtml).join('')
      : '<div class="empty">Nothing to show yet — add your accounts first.</div>';
  }

  const salary = document.getElementById('profile-salary');
  const balance = document.getElementById('profile-balance');
  const email = document.getElementById('profile-email');
  if (salary) salary.value = me.user.annualSalaryNet ?? '';
  if (balance) balance.value = me.user.assumedBalance ?? '';
  if (email) email.value = me.user.email ?? '';
}

export function initProfileForm(onSaved) {
  const form = document.getElementById('profile-form');
  if (!form) return;
  const status = document.getElementById('profile-status');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    status.textContent = 'Saving…';
    try {
      const salary = document.getElementById('profile-salary').value;
      const balance = document.getElementById('profile-balance').value;
      const email = document.getElementById('profile-email').value;
      await updateProfile({
        annualSalaryNet: salary === '' ? null : Number(salary),
        assumedBalance: balance === '' ? null : Number(balance),
        email,
      });
      status.textContent = 'Saved.';
      await onSaved();
    } catch (err) {
      status.textContent = `Couldn't save: ${err.message}`;
    }
  });
}
