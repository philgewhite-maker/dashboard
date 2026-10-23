import { updateProfile } from './api.js';
import { escapeHtml, money } from './utils.js';

const PRIORITY_LABEL = { high: 'High', medium: 'Medium', low: 'Low', blocked: 'Needs another account', alt: 'Alternative', 'n/a': 'Not eligible' };
const PRIORITY_CLASS = { high: 'pri-high', medium: 'pri-medium', low: 'pri-low', blocked: 'pri-none', alt: 'pri-none', 'n/a': 'pri-none' };

// Cashback-site deals for opening this bank's current account (flat sums,
// from the weekly scan). Alternatives, not additions: one application can
// only be tracked by one site, so the wording says "pick one" and which pays
// most. The link is the site's own current-account search -- the one place
// both list these -- not a guessed merchant page.
function cashbackHtml(r) {
  const deals = r.cashback || [];
  if (!deals.length) return '';
  const links = deals.map((d) => `<a href="${escapeHtml(d.url)}" target="_blank" rel="noopener">${escapeHtml(d.label)} ${money(d.amount)}</a>`).join(' &middot; ');
  const asOf = deals[0].asOf ? ` (as of ${escapeHtml(deals[0].asOf)})` : '';
  const quidco = deals.some((d) => d.provider === 'quidco') ? " Quidco's figure is its premium-member rate." : '';
  return `<div class="rec-cashback"><strong>Plus cashback:</strong> ${links}${asOf} — pick one, and click through its link <em>before</em> you apply, or it may not track.${quidco}</div>`;
}

function rowHtml(r) {
  return `<div class="rec-row ${r.eligible ? '' : 'rec-ineligible'}">
    <div class="rec-head">
      <span class="rec-bank">${escapeHtml(r.product || r.bank)}</span>
      <span class="rec-amount">${money(r.amount)}</span>
      <span class="tag-chip ${PRIORITY_CLASS[r.priority] || ''}">${PRIORITY_LABEL[r.priority] || r.priority}</span>
    </div>
    <div class="rec-rationale">${escapeHtml(r.rationale)}</div>
    ${(r.todo || []).map((t) => `<div class="rec-todo"><strong>To do:</strong> ${escapeHtml(t)}</div>`).join('')}
    ${(r.ideas || []).map((t) => `<div class="rec-idea"><strong>Idea:</strong> ${escapeHtml(t)}</div>`).join('')}
    ${cashbackHtml(r)}
    ${r.conditions ? `<details class="rec-conditions"><summary>Terms</summary>${escapeHtml(r.conditions)}</details>` : ''}
    ${r.url ? `<a class="rec-link" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">View offer &rarr;</a>` : ''}
  </div>`;
}

// How many of the eligible switch offers your accounts can actually fund
// (each account can fund one -- a full switch closes it) and what to do
// about the rest. Built by the server from the same rows shown below, so
// it can't disagree with them.
function planHtml(plan) {
  if (!plan) return '';
  const how = (plan.howTo || []).length
    ? `<details class="rec-plan-how" ${plan.waiting ? 'open' : ''}><summary>How to do more than one</summary><ul>${plan.howTo.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul></details>`
    : '';
  return `<div class="rec-plan">
    <div class="rec-plan-head">${escapeHtml(plan.headline)}</div>
    <ul>${(plan.lines || []).map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
    ${how}
  </div>`;
}

export function renderRecommendations(me) {
  const asOf = document.getElementById('rec-asof');
  if (asOf) asOf.textContent = me.cacheAsOf ? `Offers last checked ${me.cacheAsOf}.` : 'Offers not yet checked.';
  const planEl = document.getElementById('rec-plan');
  if (planEl) planEl.innerHTML = planHtml(me.plan);

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
  const gross = document.getElementById('profile-gross');
  if (gross) gross.value = me.user.annualSalaryGross ?? '';
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
      const gross = document.getElementById('profile-gross').value;
      const balance = document.getElementById('profile-balance').value;
      const email = document.getElementById('profile-email').value;
      await updateProfile({
        annualSalaryNet: salary === '' ? null : Number(salary),
        annualSalaryGross: gross === '' ? null : Number(gross),
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
