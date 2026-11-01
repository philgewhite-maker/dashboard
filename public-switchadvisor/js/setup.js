// The getting-started flow: 1 your income -> 2 your accounts -> 3 build the plan ->
// 4 take the first steps. Before a plan exists it shows one step at a time with
// Continue / Back; once a plan exists the same three panels sit together in a
// collapsed box, to change and rebuild from.
import { escapeHtml as esc, money } from './utils.js';
import { getFlag, setFlag } from './progress.js';
import { openAccountForm } from './accounts.js';

const STAGES = [
  { n: 1, label: 'Your income' },
  { n: 2, label: 'Your accounts' },
  { n: 3, label: 'Build your plan' },
  { n: 4, label: 'Take your first steps' },
];

// ---- "You don't need income for this" -----------------------------------------
// Minimum pay-in tests check that money arrives, not that it is earned. Shown when no
// income has been entered, or when it is below what the plan's pay-ins ask for each month.
export function incomeState(netAnnual, funds) {
  const need = (funds && funds.maxMonthlyPayIn) || 0;
  if (!netAnnual) return { low: true, reason: 'none', need };
  const monthly = netAnnual / 12;
  return { low: monthly < Math.max(need, 1500), reason: 'low', monthly, need };
}

export function incomeNoteHtml(netAnnual, funds) {
  const st = incomeState(netAnnual, funds);
  if (!st.low) return '';
  const lead = st.reason === 'none'
    ? 'No income entered? You can still do most of this.'
    : (st.need && st.monthly < st.need
      ? `Your take-home is about ${money(st.monthly)} a month — less than some of these tests ask to be paid in. That does not rule them out.`
      : `Your take-home is about ${money(st.monthly)} a month. If any pay-in in the plan feels large for that, it does not have to come from income.`);
  const asks = st.need ? `up to ${money(st.need)} a month` : 'anything from a few hundred to a couple of thousand pounds a month';
  const lump = funds && funds.maxLumpPayIn ? ` The largest one-off pay-in in the plan is ${money(funds.maxLumpPayIn)}.` : '';
  return `<div class="circ-note">
    <strong>${esc(lead)}</strong>
    <p>The minimum pay-in tests ask for ${asks}, but they only test that the money <em>arrives</em>, not that it was earned. It can be the same money going round: pay it in from an account you already hold, then send it straight back out once the offer allows. The plan’s steps include that return payment.${lump} What you need is a cushion of that size in an account you control, not an income.</p>
    <p class="muted">Check each offer’s terms: some need the money to stay for a day or more, and any offer that needs a salary from an employer cannot be met this way. The plan leaves those out until you enter your income.</p>
  </div>`;
}

// ---- The inline accounts step ------------------------------------------------
function accountsPanelHtml(accounts) {
  const open = accounts.filter((a) => !a.closeDate);
  const rows = accounts.map((a) => `<div class="wiz-acc">
      <span><strong>${esc(a.bank)}</strong>${a.nickname ? ` — ${esc(a.nickname)}` : ''}${a.closeDate ? ' <span class="tag-chip">Closed</span>' : ''}
      <span class="muted">${a.directDebitCount != null ? ` · ${a.directDebitCount} Direct Debit${a.directDebitCount === 1 ? '' : 's'}` : ''}${a.wantToKeep === true ? ' · keeping it' : a.wantToKeep === false ? ' · planning to leave it' : ''}</span></span>
      <button type="button" class="sync-btn sm inline ghost" data-wiz-edit="${esc(a.id)}">Edit</button>
    </div>`).join('');
  const noneFlag = getFlag('noAccounts') === true;
  const intro = accounts.length
    ? `You have added ${open.length} open account${open.length === 1 ? '' : 's'}. The plan will not suggest a bank you already hold, and it can switch away from any account you have not marked “keep”.`
    : noneFlag
      ? 'You are starting from scratch: the plan will start by opening a free account to switch from. Changed your mind? Add an account below.'
      : 'Do you already have any current accounts (a high-street bank, Monzo, Starling…)? The plan starts from them: it avoids banks you already hold and switches away from the ones you do not need.';
  return `<p>${intro}</p>${rows}
    <div class="wiz-acc-actions">
      <button type="button" class="sync-btn sm inline" data-wiz-add>${accounts.length ? 'Add another account' : 'Add an account'}</button>
      ${!accounts.length && !noneFlag ? '<button type="button" class="sync-btn sm inline ghost" data-wiz-none>I’m starting from scratch</button>' : ''}
    </div>`;
}

// ---- Rendering and events -------------------------------------------------------
export function renderSetup({ me, built, allDone, hasUpdate }) {
  const accounts = (me.user && me.user.accounts) || [];
  const step = built ? 'all' : Math.min(3, Math.max(1, Number(getFlag('wizStep', 1)) || 1));

  document.querySelectorAll('.wiz').forEach((p) => {
    p.hidden = !(step === 'all' || Number(p.dataset.wiz) === step);
  });

  const box = document.getElementById('setup-box');
  const sum = document.getElementById('setup-summary');
  if (box && sum) {
    sum.textContent = built ? 'Your details and options — change them, then update your plan' : 'Get started: three quick steps';
    if (built !== box.dataset.built) {
      box.dataset.built = built ? '1' : '';
      box.open = !built;
    }
  }

  const stepper = document.getElementById('stepper');
  if (stepper) {
    stepper.innerHTML = STAGES.map((s) => {
      let state = 'todo';
      if (built) state = s.n < 4 ? 'done' : (allDone ? 'done' : 'current');
      else state = s.n < step ? 'done' : s.n === step ? 'current' : 'todo';
      return `<li class="stage stage-${state}" ${s.n < 4 && !built ? `data-wiz-go="${s.n}" role="button" tabindex="0"` : ''}><span class="stage-n">${state === 'done' ? '✓' : s.n}</span><span class="stage-l">${esc(s.label)}</span></li>`;
    }).join('');
  }

  const accEl = document.getElementById('wiz-accounts');
  if (accEl) accEl.innerHTML = accountsPanelHtml(accounts);

  const btn = document.getElementById('show-plan-btn');
  if (btn) btn.textContent = built ? (hasUpdate ? 'Update my plan' : 'Rebuild my plan') : 'Build my plan';
  document.getElementById('plan-tab-dot')?.toggleAttribute('hidden', !hasUpdate);

  const accountsNext = document.getElementById('accounts-next');
  if (accountsNext) {
    accountsNext.innerHTML = accounts.length || getFlag('noAccounts') === true
      ? `<p class="next-hint">${built ? (hasUpdate ? 'Your accounts changed, so your plan has an update waiting.' : 'Your plan already uses these.') : 'Done adding accounts?'} <button type="button" class="sync-btn sm inline" data-goto-tab="recommend">${built ? 'Back to my plan →' : 'Next: build my plan →'}</button></p>` : '';
  }
}

export function incomeNoteRefresh(funds) {
  const el = document.getElementById('income-note');
  if (!el) return;
  const raw = document.getElementById('profile-salary')?.value;
  el.innerHTML = incomeNoteHtml(raw === '' || raw == null ? null : Number(raw), funds);
}

export function initSetup(getMe, rerender) {
  const root = document.getElementById('panel-recommend');
  if (!root) return;
  const go = (n) => {
    if (n === 3 && !((getMe()?.user?.accounts) || []).length) setFlag('noAccounts', true);
    setFlag('wizStep', n); rerender(); root.scrollIntoView?.({ behavior: 'smooth', block: 'start' }); };
  root.addEventListener('click', (e) => {
    const t = e.target.closest?.('[data-wiz-go]');
    if (t) { go(Number(t.dataset.wizGo)); return; }
    if (e.target.closest?.('[data-wiz-add]')) { openAccountForm(null); return; }
    const edit = e.target.closest?.('[data-wiz-edit]');
    if (edit) {
      const acc = ((getMe()?.user?.accounts) || []).find((a) => a.id === edit.dataset.wizEdit);
      if (acc) openAccountForm(acc);
      return;
    }
    if (e.target.closest?.('[data-wiz-none]')) { setFlag('noAccounts', true); rerender(); }
  });
  root.addEventListener('keydown', (e) => {
    const t = e.target.closest?.('[data-wiz-go]');
    if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); go(Number(t.dataset.wizGo)); }
  });
  document.getElementById('profile-salary')?.addEventListener('input', () => incomeNoteRefresh(null));
}
