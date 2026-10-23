import { getLiveProfile, setLiveProfile } from './api.js';
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

// The to-do text points at the salary plan by name; make that a real link.
function linkSalaryPlan(html) {
  return html.replace(/(?:"|&quot;|&#34;)Where your salary goes(?:"|&quot;|&#34;)/, '<a href="#rec-salary">Where your salary goes</a>');
}

function rowHtml(r) {
  return `<div class="rec-row ${r.eligible ? '' : 'rec-ineligible'}">
    <div class="rec-head">
      <span class="rec-bank">${escapeHtml(r.product || r.bank)}</span>
      <span class="rec-amount">${money(r.amount)}</span>
      <span class="tag-chip ${PRIORITY_CLASS[r.priority] || ''}">${PRIORITY_LABEL[r.priority] || r.priority}</span>
    </div>
    <div class="rec-rationale">${escapeHtml(r.rationale)}</div>
    ${(r.todo || []).map((t) => `<div class="rec-todo"><strong>To do:</strong> ${linkSalaryPlan(escapeHtml(t))}</div>`).join('')}
    ${(r.tips || []).map((t) => `<div class="rec-tip"><strong>Worth knowing:</strong> ${escapeHtml(t)}</div>`).join('')}
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

// Salary can only land in one account: which salary-tied offers take turns,
// and what that costs in Krak Salary Match. Built by the server.
function salaryPlanHtml(sp) {
  if (!sp) return '';
  const li = (arr) => (arr || []).map((l) => `<li>${escapeHtml(l)}</li>`).join('');
  const notes = (sp.notes || []).length
    ? `<details class="rec-plan-how"><summary>What counts as salary, and the small print</summary><ul>${li(sp.notes)}</ul></details>`
    : '';
  return `<div class="rec-plan" id="rec-salary">
    <div class="rec-plan-head">${escapeHtml(sp.headline)}</div>
    ${(sp.steps || []).length ? `<ol>${li(sp.steps)}</ol>` : ''}
    <ul>${li(sp.summary)}</ul>
    ${notes}
  </div>`;
}

// The year sketch: the most you could collect over 12 months by taking the
// offers in turn, with the alternatives the server tried. Built by the server.
function yearPathHtml(yp) {
  if (!yp) return '';
  const li = (arr) => (arr || []).map((l) => `<li>${escapeHtml(l)}</li>`).join('');
  const quests = (yp.quests || []).length
    ? `<div class="rec-quests"><strong>Side quests</strong> — what each extra donor account adds (already counted in the total above):<ul>${li(yp.quests)}</ul></div>`
    : '';
  return `<div class="rec-plan rec-year" id="rec-year">
    <div class="rec-plan-head">${escapeHtml(yp.headline)}</div>
    <ol>${li(yp.steps)}</ol>
    <ul>${li(yp.summary)}</ul>
    ${quests}
    <details class="rec-plan-how"><summary>How this was worked out</summary><ul>${li(yp.notes)}</ul></details>
  </div>`;
}

export function renderRecommendations(me) {
  const asOf = document.getElementById('rec-asof');
  if (asOf) asOf.textContent = me.cacheAsOf ? `Offers last checked ${me.cacheAsOf}.` : 'Offers not yet checked.';
  const planEl = document.getElementById('rec-plan');
  if (planEl) planEl.innerHTML = planHtml(me.plan);
  const yearEl = document.getElementById('rec-year-wrap');
  if (yearEl) yearEl.innerHTML = yearPathHtml(me.yearPath);
  const salaryEl = document.getElementById('rec-salary-wrap');
  if (salaryEl) salaryEl.innerHTML = salaryPlanHtml(me.salaryPlan);

  const list = document.getElementById('rec-list');
  if (list) {
    const rows = me.recommendations || [];
    list.innerHTML = rows.length
      ? rows.map(rowHtml).join('')
      : '<div class="empty">Nothing to show yet — add your accounts first.</div>';
  }

  const salary = document.getElementById('profile-salary');
  const balance = document.getElementById('profile-balance');
  const gross = document.getElementById('profile-gross');
  const live = getLiveProfile();
  if (gross) gross.value = live.annualSalaryGross ?? '';
  if (salary) salary.value = live.annualSalaryNet ?? '';
  if (balance) balance.value = live.assumedBalance ?? '';
}

export function initProfileForm(onSaved) {
  const form = document.getElementById('profile-form');
  if (!form) return;
  const status = document.getElementById('profile-status');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    status.textContent = 'Updating…';
    try {
      const salary = document.getElementById('profile-salary').value;
      const gross = document.getElementById('profile-gross').value;
      const balance = document.getElementById('profile-balance').value;
      setLiveProfile({
        annualSalaryNet: salary === '' ? null : Number(salary),
        annualSalaryGross: gross === '' ? null : Number(gross),
        assumedBalance: balance === '' ? null : Number(balance),
      });
      status.textContent = 'Updated.';
      await onSaved();
    } catch (err) {
      status.textContent = `Couldn't update: ${err.message}`;
    }
  });
}
