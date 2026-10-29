import { getLiveProfile, setLiveProfile, getOptions, setOptions, planRequested, setPlanRequested } from './api.js';
import { escapeHtml, money } from './utils.js';
import { REFERRALS, isSetUp } from './config.js';

const PRIORITY_LABEL = { high: 'High', medium: 'Medium', low: 'Low', blocked: 'Needs another account', alt: 'Alternative', 'n/a': 'Not eligible' };
const PRIORITY_CLASS = { high: 'pri-high', medium: 'pri-medium', low: 'pri-low', blocked: 'pri-none', alt: 'pri-none', 'n/a': 'pri-none' };

// A link to a cashback site or to Krak. Where you have set up a referral link
// (config.js), it is offered next to the plain site link ("new to X? join with
// my link"); for Krak the referral link replaces it, since Krak is opened once.
function linkHtml(l) {
  const ref = REFERRALS[l.ref];
  const site = l.url || (ref && ref.site) || '';
  const main = l.ref === 'krak' && ref && isSetUp(ref.url) ? ref.url : site;
  let h = `<a href="${escapeHtml(main)}" target="_blank" rel="noopener">${escapeHtml(l.label)}</a>`;
  if (l.ref !== 'krak' && ref && isSetUp(ref.url)) {
    h += ` <a class="plan-ref" href="${escapeHtml(ref.url)}" target="_blank" rel="noopener">(new to ${escapeHtml(ref.name)}? join with my link)</a>`;
  }
  return h;
}

// Cashback-site deals for opening this bank's current account (flat sums,
// from the weekly scan). Alternatives, not additions: one application can
// only be tracked by one site, so the wording says "pick one".
function cashbackHtml(r) {
  const deals = r.cashback || [];
  if (!deals.length) return '';
  const links = deals.map((d) => linkHtml({ label: `${d.label} ${money(d.amount)}`, url: d.url, ref: d.provider })).join(' &middot; ');
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
    ${(r.tips || []).map((t) => `<div class="rec-tip"><strong>Worth knowing:</strong> ${escapeHtml(t)}</div>`).join('')}
    ${(r.ideas || []).map((t) => `<div class="rec-idea"><strong>Idea:</strong> ${escapeHtml(t)}</div>`).join('')}
    ${cashbackHtml(r)}
    ${r.conditions ? `<details class="rec-conditions"><summary>Terms</summary>${escapeHtml(r.conditions)}</details>` : ''}
    ${r.url ? `<a class="rec-link" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">View offer &rarr;</a>` : ''}
  </div>`;
}

// How many of the eligible switch offers your accounts can fund right now
// and what to do about the rest. Built by the server from the same rows shown
// below, so it can't disagree with them.
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

// Payments a bank makes every year for keeping and using an account (Nationwide
// Fairer Share), for accounts you already hold. Built by the server.
function perksHtml(perks) {
  return (perks || []).map((p) => `<div class="rec-plan">
    <div class="rec-plan-head">${escapeHtml(p.name)} — about ${money(p.amount)} a year${p.guaranteed ? '' : ' (not guaranteed)'}</div>
    <p class="muted">Your account${p.accounts.length === 1 ? '' : 's'}: ${p.accounts.map(escapeHtml).join(', ')}. ${escapeHtml(p.status)}</p>
    <ol>${p.todo.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ol>
    ${p.url ? `<a class="rec-link" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">How it works &rarr;</a>` : ''}
  </div>`).join('');
}

// ---- The simple figure shown before anyone has said anything --------------
function opportunityHtml(op) {
  if (!op) return '';
  const lo = op.standard && op.standard.total;
  const hi = op.high && op.high.total;
  if (!lo && !hi) return '';
  const range = lo && hi && hi > lo ? `${money(lo)} – ${money(hi)}` : money(hi || lo);
  return `<div class="opp">
    <div class="opp-label">Potential opportunity over 12 months</div>
    <div class="opp-figure">about ${range}</div>
    <p class="muted">${lo && hi && hi > lo ? 'The lower figure is for an ordinary salary; the higher one also counts the premier accounts, which need roughly £75,000–£100,000+ a year. ' : ''}It is switch bonuses (plus cashback and Krak Salary Match) from the best sequence of switches for someone starting with no accounts, and it is subject to your existing accounts and income — those can move it either way. Tell the page about yours below for a plan that fits you.</p>
  </div>`;
}

// ---- The customised plan ---------------------------------------------------
function actionHtml(a) {
  let extra = '';
  if (a.links) extra = ' ' + a.links.map(linkHtml).join(' &middot; ');
  if (a.link) extra = ' ' + linkHtml(a.link);
  return `<li>${escapeHtml(a.text)}${extra}</li>`;
}

const KIND_LABEL = { switch: 'Switch', 'open-donor': 'Open', krak: 'Salary', perk: 'Yearly extra', bills: 'Bills account' };

function cardHtml(c, n) {
  const facts = [];
  if (c.completes) facts.push(`switch completes about ${escapeHtml(c.completes)}`);
  if (c.bonusBy) facts.push(`bonus by about ${escapeHtml(c.bonusBy)}`);
  if (c.freeFrom) facts.push(`keep open until ${escapeHtml(c.freeFrom)}`);
  if (c.salary) facts.push(`salary here ${escapeHtml(c.salary.from)} → ${escapeHtml(c.salary.to)}`);
  return `<article class="plan-card plan-${escapeHtml(c.kind)}">
    <header>
      <span class="plan-n">${n}</span>
      <div class="plan-title"><span class="plan-date">${escapeHtml(c.dateLabel)} · ${escapeHtml(KIND_LABEL[c.kind] || c.kind)}</span><h3>${escapeHtml(c.title)}</h3></div>
      ${c.amountLabel ? `<span class="plan-amount">${escapeHtml(c.amountLabel)}</span>` : c.amount ? `<span class="plan-amount">${money(c.amount)}</span>` : ''}
    </header>
    ${facts.length ? `<p class="plan-facts muted">${facts.join(' · ')}</p>` : ''}
    <details class="plan-why-box"><summary>Why this move</summary><ul>${(c.why || []).map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul></details>
    <div class="plan-do-head">What to do</div>
    <ol class="plan-do">${(c.actions || []).map(actionHtml).join('')}</ol>
    ${c.url ? `<a class="rec-link" href="${escapeHtml(c.url)}" target="_blank" rel="noopener">View offer &rarr;</a>` : ''}
  </article>`;
}

function endStateHtml(es) {
  if (!es) return '';
  const li = (arr) => (arr || []).map((t) => `<li>${escapeHtml(t)}</li>`).join('');
  return `<div class="plan-end">
    <h3>Where you end up</h3>
    ${(es.keep || []).length ? `<p class="plan-sub">Worth keeping</p><ul>${li(es.keep)}</ul>` : ''}
    ${(es.alternatives || []).length ? `<p class="plan-sub">You could also keep…</p><ul>${li(es.alternatives)}</ul>` : ''}
    ${(es.close || []).length ? `<p class="plan-sub">Close once its bonus has paid</p><ul>${li(es.close)}</ul>` : ''}
    <ul class="muted">${li(es.notes)}</ul>
  </div>`;
}

function customPlanHtml(p) {
  if (!p) return '<div class="rec-plan">The plan is built from this week\'s structured offer data. It will appear after the next weekly check — please look again shortly.</div>';
  const parts = [];
  parts.push(`<div class="plan-head"><div class="opp-label">Your customised plan</div><p class="plan-headline">${escapeHtml(p.headline)}</p>
    <div class="plan-totals">
      <span><b>${money(p.bonus)}</b> switch bonuses</span>
      ${p.cashback ? `<span><b>${money(p.cashback)}</b> cashback sites</span>` : ''}
      ${p.krak ? `<span><b>${money(p.krak)}</b> Krak Salary Match</span>` : ''}
      ${p.fairerShare ? `<span><b>${money(p.fairerShare)}</b> Fairer Share (if repeated)</span>` : ''}
      <span><b>${p.openings}</b> accounts opened</span><span><b>${p.switches}</b> switches</span><span><b>${p.repoints}</b> salary moves</span>
    </div></div>`);
  if ((p.quests || []).length) parts.push(`<div class="rec-quests"><strong>Side quests</strong> — what each extra donor account adds (already counted above):<ul>${p.quests.map((q) => `<li>${escapeHtml(q)}</li>`).join('')}</ul></div>`);
  parts.push((p.cards || []).map((c, i) => cardHtml(c, i + 1)).join(''));
  parts.push(endStateHtml(p.endState));
  parts.push(`<details class="rec-plan-how"><summary>How this was worked out</summary><ul>${(p.notes || []).map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul></details>`);
  return `<div class="plan-wrap">${parts.join('')}</div>`;
}

function readOptionsFromForm() {
  const horizon = Number(document.getElementById('opt-horizon').value) || 12;
  const keep = document.getElementById('opt-keep-primary').checked;
  return {
    horizonMonths: horizon,
    minimiseSwitches: document.getElementById('opt-minimise').checked,
    fullBonuses: document.getElementById('opt-full').checked,
    keepPrimary: keep,
    primaryAccountId: keep ? document.getElementById('opt-primary').value : '',
    allowNewAccounts: document.getElementById('opt-allow-new').checked,
  };
}

function fillOptionsForm(me) {
  const o = getOptions();
  const set = (id, fn) => { const el = document.getElementById(id); if (el) fn(el); };
  set('opt-horizon', (el) => { el.value = String(o.horizonMonths || 12); });
  set('opt-minimise', (el) => { el.checked = !!o.minimiseSwitches; });
  set('opt-full', (el) => { el.checked = !!o.fullBonuses; });
  set('opt-allow-new', (el) => { el.checked = o.allowNewAccounts !== false; });
  const accounts = (me.user.accounts || []).filter((a) => !a.closeDate);
  const sel = document.getElementById('opt-primary');
  if (sel) {
    sel.innerHTML = accounts.map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.bank)}${a.nickname ? ` — ${escapeHtml(a.nickname)}` : ''}</option>`).join('');
    if (o.primaryAccountId) sel.value = o.primaryAccountId;
  }
  set('opt-keep-primary', (el) => {
    el.checked = !!o.keepPrimary && accounts.length > 0;
    el.disabled = accounts.length === 0;
    const wrap = document.getElementById('opt-primary-wrap');
    if (wrap) wrap.hidden = !el.checked;
  });
  const summary = document.getElementById('plan-accounts-summary');
  if (summary) {
    summary.textContent = accounts.length
      ? `You have added ${accounts.length} open account${accounts.length === 1 ? '' : 's'}: ${accounts.map((a) => a.bank).join(', ')}. Accounts you mark "keep" are never switched away.`
      : "You haven't added any accounts, so the plan assumes you start by opening a new free account to switch from.";
  }
}

export function renderRecommendations(me) {
  const asOf = document.getElementById('rec-asof');
  if (asOf) asOf.textContent = me.cacheAsOf ? `Offers last checked ${me.cacheAsOf}.` : 'Offers not yet checked.';
  const opp = document.getElementById('opportunity');
  if (opp) opp.innerHTML = opportunityHtml(me.opportunity);
  const mount = document.getElementById('plan-mount');
  if (mount) {
    mount.innerHTML = planRequested()
      ? customPlanHtml(me.actionPlan)
      : '<p class="muted plan-hint">Fill in as much as you like above — or nothing — then press <strong>Show my customised plan</strong> for your step-by-step action plan.</p>';
  }
  const planEl = document.getElementById('rec-plan');
  if (planEl) planEl.innerHTML = planHtml(me.plan);
  const perksEl = document.getElementById('rec-perks-wrap');
  if (perksEl) perksEl.innerHTML = perksHtml(me.annualPerks);

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
  fillOptionsForm(me);
}

export function initProfileForm(onSaved) {
  const form = document.getElementById('profile-form');
  if (!form) return;
  const status = document.getElementById('profile-status');
  const keep = document.getElementById('opt-keep-primary');
  keep?.addEventListener('change', () => {
    const wrap = document.getElementById('opt-primary-wrap');
    if (wrap) wrap.hidden = !keep.checked;
  });
  document.getElementById('plan-goto-accounts')?.addEventListener('click', () => {
    document.querySelector('.tab-btn[data-tab="accounts"]')?.click();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    status.textContent = 'Building your plan…';
    try {
      const salary = document.getElementById('profile-salary').value;
      const gross = document.getElementById('profile-gross').value;
      const balance = document.getElementById('profile-balance').value;
      setLiveProfile({
        annualSalaryNet: salary === '' ? null : Number(salary),
        annualSalaryGross: gross === '' ? null : Number(gross),
        assumedBalance: balance === '' ? null : Number(balance),
      });
      setOptions(readOptionsFromForm());
      setPlanRequested(true);
      await onSaved();
      status.textContent = '';
      document.getElementById('plan-mount')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      status.textContent = `Couldn't build the plan: ${err.message}`;
    }
  });
}
