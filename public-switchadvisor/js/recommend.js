import { getLiveProfile, setLiveProfile, getOptions, setOptions, planRequested, setPlanRequested } from './api.js';
import { escapeHtml, money } from './utils.js';
import { REFERRALS, isSetUp } from './config.js';
import { getAccepted, setAccepted, getFlag, setFlag, patchStep, fingerprint, getCatchup, setCatchup, isSkipped } from './progress.js';
import { stepsHtml, bindSteps, cardProgress, cardStarted, nextAction, revealTarget, setStepContext } from './steps.js';
import { diffDigest, changeBannerHtml, acceptedFrom, allCards, activeCards, overallProgress, normalisePlan } from './changes.js';
import { renderSetup, initSetup, incomeNoteHtml, incomeNoteRefresh, incomeState } from './setup.js';

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
    <p class="muted">${lo && hi && hi > lo ? 'The lower figure is for an ordinary salary; the higher one also counts the premier accounts, which need roughly £75,000–£100,000+ a year. ' : ''}It is switch bonuses (plus cashback and Krak Salary Match) from the best sequence of switches for someone starting with no accounts, and it is subject to your existing accounts and income — those can move it either way. Answer the three quick steps below for a plan that fits you.</p>
  </div>`;
}

// ---- The customised plan ---------------------------------------------------
// One step's own sentence, with any links it carries (cashback sites, Krak).
function stepBodyHtml(a) {
  let extra = '';
  if (a.links) extra = ' ' + a.links.map(linkHtml).join(' &middot; ');
  if (a.link) extra = ' ' + linkHtml(a.link);
  return `${escapeHtml(a.text)}${extra}`;
}

const KIND_LABEL = { switch: 'Switch', 'open-donor': 'Open', krak: 'Salary', perk: 'Yearly extra', bills: 'Bills account' };

// "Starts in 12 days" / "Today" / "Was due 3 days ago", from the day the plan was built.
function dueInfo(card, planToday) {
  const base = new Date(`${planToday || new Date().toISOString().slice(0, 10)}T00:00:00`);
  base.setDate(base.getDate() + (card.day || 0));
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const days = Math.round((base - now) / 86400000);
  if (days > 1) return { days, label: `Starts in ${days} days`, cls: 'due-later' };
  if (days === 1) return { days, label: 'Starts tomorrow', cls: 'due-later' };
  if (days === 0) return { days, label: 'Do this today', cls: 'due-now' };
  return { days, label: `Was due ${-days} day${days === -1 ? '' : 's'} ago`, cls: 'due-over' };
}

function cardHtml(c, n, planToday) {
  if (isSkipped(c.key)) {
    return `<article class="plan-card plan-skipped" id="c-${escapeHtml(c.key)}"><header><span class="plan-n">–</span>
      <div class="plan-title"><span class="plan-date">${escapeHtml(c.dateLabel)} <span class="tag-chip">Skipped</span></span><h3>${escapeHtml(c.title)}</h3></div>
      <button type="button" class="linklike" data-unskip="${escapeHtml(c.key)}">Undo</button></header></article>`;
  }
  const prog = cardProgress(c);
  const due = dueInfo(c, planToday);
  const facts = [];
  if (c.completes) facts.push(`switch completes about ${escapeHtml(c.completes)}`);
  if (c.bonusBy) facts.push(`bonus by about ${escapeHtml(c.bonusBy)}`);
  if (c.freeFrom) facts.push(`keep open until ${escapeHtml(c.freeFrom)}`);
  if (c.salary) facts.push(`salary here ${escapeHtml(c.salary.from)} → ${escapeHtml(c.salary.to)}`);
  const status = prog.complete ? '<span class="tag-chip pri-high">✓ Done</span>'
    : c.carried ? '<span class="tag-chip pri-low">Under way</span>'
      : cardStarted(c) ? `<span class="tag-chip pri-medium" ${c.kind === 'switch' ? 'title="A started switch is kept in your plan when it is rebuilt, even if it is no longer the best move."' : ''}>Started</span>`
        : `<span class="tag-chip due ${due.cls}">${escapeHtml(due.label)}</span>`;
  return `<article class="plan-card plan-${escapeHtml(c.kind)} ${prog.complete ? 'plan-complete' : ''}" id="c-${escapeHtml(c.key)}">
    <header>
      <span class="plan-n">${prog.complete ? '✓' : n}</span>
      <div class="plan-title"><span class="plan-date">${escapeHtml(c.dateLabel)} · ${escapeHtml(KIND_LABEL[c.kind] || c.kind)} ${status}</span><h3>${escapeHtml(c.title)}</h3></div>
      ${c.amountLabel ? `<span class="plan-amount">${escapeHtml(c.amountLabel)}</span>` : c.amount ? `<span class="plan-amount">${money(c.amount)}</span>` : ''}
    </header>
    <details class="plan-body" data-dkey="card:${escapeHtml(c.key)}" ${prog.complete ? '' : 'open'}>
      <summary>${prog.done} of ${prog.total} step${prog.total === 1 ? '' : 's'} done</summary>
      ${facts.length ? `<p class="plan-facts muted">${facts.join(' · ')}</p>` : ''}
      ${c.carried ? `<p class="muted">You started this under an earlier plan, so it stays here until you finish it. <button type="button" class="linklike" data-stop-card="${escapeHtml(c.key)}">Stop tracking this one</button></p>` : ''}
      <details class="plan-why-box" data-dkey="why:${escapeHtml(c.key)}"><summary>Why this move</summary><ul>${(c.why || []).map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul></details>
      ${stepsHtml(c, stepBodyHtml)}
      ${c.url ? `<a class="rec-link" href="${escapeHtml(c.url)}" target="_blank" rel="noopener">View offer &rarr;</a>` : ''}
    </details>
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

function customPlanHtml(accepted) {
  const p = accepted.plan;
  const cards = allCards(accepted);
  const prog = overallProgress(accepted);
  const built = accepted.builtAt ? new Date(accepted.builtAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const live = getLiveProfile();
  const parts = [];
  parts.push(`<div class="plan-head"><div class="opp-label">Your customised plan${built ? ` · built ${escapeHtml(built)}` : ''}</div><p class="plan-headline">${escapeHtml(p.headline)}</p>
    <div class="plan-totals">
      <span><b>${money(p.bonus)}</b> switch bonuses</span>
      ${p.cashback ? `<span><b>${money(p.cashback)}</b> cashback sites</span>` : ''}
      ${p.krak ? `<span><b>${money(p.krak)}</b> Krak Salary Match</span>` : ''}
      ${p.krakSpend ? `<span><b>${money(p.krakSpend)}</b> Krak card cashback</span>` : ''}
      ${p.fairerShare ? `<span><b>${money(p.fairerShare)}</b> Fairer Share (if repeated)</span>` : ''}
      <span><b>${p.openings}</b> accounts opened</span><span><b>${p.switches}</b> switches</span><span><b>${p.repoints}</b> salary moves</span>
    </div>
    ${prog.total ? `<div class="prog"><div class="prog-bar"><span style="width:${Math.round((prog.done / prog.total) * 100)}%"></span></div><span class="muted">${prog.done} of ${prog.total} steps done</span></div>` : ''}
  </div>`);
  parts.push(incomeNoteHtml(live.annualSalaryNet, p.funds));
  if ((p.quests || []).length) parts.push(`<div class="rec-quests"><strong>Side quests</strong> — what each extra donor account adds (already counted above):<ul>${p.quests.map((q) => `<li>${escapeHtml(q)}</li>`).join('')}</ul></div>`);
  parts.push(cards.map((c, i) => cardHtml(c, i + 1, p.today)).join(''));
  parts.push(endStateHtml(p.endState));
  parts.push(`<details class="rec-plan-how"><summary>How this was worked out</summary><ul>${(p.notes || []).map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul></details>`);
  return `<div class="plan-wrap">${parts.join('')}</div>`;
}

// The one thing to do next, with the way to do it right there.
// "Did you start this?" for the first card whose date has passed with nothing ticked in it.
// Ticking any step marks a card as started, so this only asks about the ones left untouched.
function catchUpHtml(accepted) {
  const today = new Date().toISOString().slice(0, 10);
  for (const c of activeCards(accepted)) {
    if (c.carried || cardProgress(c).complete || cardStarted(c)) continue;
    const st = getCatchup(c.key);
    if (st === 'started' || st === `later:${today}`) continue;
    const due = dueInfo(c, accepted.plan.today);
    if (due.days >= 0) return ''; // cards run in date order: nothing after this one is due either
    const k = escapeHtml(c.key);
    return `<div class="catchup">
      <strong>Did you start “${escapeHtml(c.title)}”?</strong>
      <p class="muted">It was due ${-due.days} day${due.days === -1 ? '' : 's'} ago and nothing in it is ticked yet. A switch you have started stays in your plan even if a better one comes along; one you have not started is re-planned freely. So if you did begin it, say so.</p>
      <div class="next-actions">
        <button type="button" class="sync-btn" data-catch="all" data-key="${k}">Yes, it is all done</button>
        <button type="button" class="sync-btn ghost" data-catch="some" data-key="${k}">I started it: let me tick what I have done</button>
        <button type="button" class="sync-btn ghost" data-catch="later" data-key="${k}">Not yet</button>
        <button type="button" class="sync-btn ghost" data-catch="skip" data-key="${k}">Skip this one</button>
      </div>
    </div>`;
  }
  return '';
}

function nextStepHtml(accepted) {
  const cards = activeCards(accepted);
  if (!cards.length) return '';
  const next = nextAction(cards);
  if (!next) {
    return '<div class="next-step next-done"><div class="opp-label">Your next step</div><p class="next-text">Every step in your plan is ticked. 🎉 Check back here: if the offers change, you will be told what it means for you.</p></div>';
  }
  const due = next.card.carried ? { days: 0, label: 'Already under way', cls: 'due-now' } : dueInfo(next.card, accepted.plan.today);
  const early = !next.card.carried && due.days > 0;
  const cta = next.kind === 'check'
    ? `<button type="button" class="sync-btn" data-next-tick="${escapeHtml(next.tickId)}">Done ✓</button>`
    : '<button type="button" class="sync-btn" data-next-show>Answer this ↓</button>';
  return `<div class="next-step ${early ? 'next-later' : ''}">
    <div class="opp-label">${early ? 'Coming up' : 'Your next step'}</div>
    <p class="next-text">${escapeHtml(next.plain)}</p>
    <p class="muted next-where">${escapeHtml(next.card.title)} · ${escapeHtml(due.label)}</p>
    <div class="next-actions">${early ? '' : cta} <button type="button" class="sync-btn ghost" data-next-show>${next.kind === 'check' && !early ? 'Show me where' : 'Show me'}</button></div>
  </div>`;
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
}

// ---- Putting it together -----------------------------------------------------
let lastMe = null;
let reload = async () => {};
const openState = new Map();

// What the person controls, as a fingerprint: accounts, figures and options. When it
// differs from the one the plan was built on, the plan is out of date by their own doing.
function inputSignature(me) {
  const accounts = (me.user.accounts || []).map((a) => [a.id, a.bank, a.closeDate || '', a.wantToKeep, a.directDebitCount]);
  return fingerprint({ accounts, live: getLiveProfile(), opts: getOptions() });
}

function digestKey(d) {
  return fingerprint((d?.items || []).map((i) => [i.id, i.amount, i.terms, i.deadline]));
}

// Adopt the freshly computed plan as the one being followed, when the person has just
// asked for that (building or updating); otherwise leave the plan they have alone.
function syncAccepted(me) {
  if (!planRequested()) return;
  let accepted = getAccepted();
  const wanted = getFlag('accept') === true || !accepted;
  if (wanted && me.actionPlan) {
    accepted = acceptedFrom(me.actionPlan, me.offerDigest, inputSignature(me), accepted, getFlag('abandoned', {}) || {});
    setAccepted(accepted);
    setFlag('accept', null);
    setFlag('dismissed', null);
  } else if (getFlag('accept') === true) {
    setFlag('accept', null);
  }
}

function pendingUpdate(me, accepted) {
  if (!accepted || !me.actionPlan) return null;
  const offerChanges = diffDigest(accepted.digest, me.offerDigest, accepted.plan.cards);
  const inputsChanged = accepted.inputSig !== inputSignature(me);
  if (!offerChanges.length && !inputsChanged) return null;
  if (getFlag('dismissed') === `${digestKey(me.offerDigest)}:${inputSignature(me)}`) return null;
  return { offerChanges, inputsChanged };
}

function captureOpen() {
  document.querySelectorAll('#plan-mount details[data-dkey]').forEach((d) => openState.set(d.dataset.dkey, d.open));
}
function restoreOpen() {
  document.querySelectorAll('#plan-mount details[data-dkey]').forEach((d) => {
    if (openState.has(d.dataset.dkey)) d.open = openState.get(d.dataset.dkey);
  });
}

function renderPlanUi() {
  const me = lastMe;
  if (!me) return;
  const built = planRequested();
  const accepted = built ? getAccepted() : null;
  const pending = pendingUpdate(me, accepted);

  const lowIncome = incomeState(getLiveProfile().annualSalaryNet, accepted?.plan?.funds || me.actionPlan?.funds).low;
  setStepContext({ lowIncome });

  captureOpen();
  const change = document.getElementById('change-mount');
  if (change) {
    change.innerHTML = pending ? changeBannerHtml({ accepted, fresh: me.actionPlan, offerChanges: pending.offerChanges, inputsChanged: pending.inputsChanged }) : '';
  }
  const next = document.getElementById('next-mount');
  if (next) next.innerHTML = accepted ? catchUpHtml(accepted) + nextStepHtml(accepted) : '';

  const mount = document.getElementById('plan-mount');
  if (mount) {
    if (accepted) mount.innerHTML = customPlanHtml(accepted);
    else if (built) mount.innerHTML = '<div class="rec-plan">The plan is built from this week\'s structured offer data. It will appear after the next weekly check — please look again shortly.</div>';
    else mount.innerHTML = '';
  }
  restoreOpen();

  const prog = accepted ? overallProgress(accepted) : { done: 0, total: 0 };
  renderSetup({ me, built: !!accepted, allDone: prog.total > 0 && prog.done === prog.total, hasUpdate: !!pending });
  const opp = document.getElementById('opportunity');
  if (opp) opp.innerHTML = accepted ? '' : opportunityHtml(me.opportunity);
  incomeNoteRefresh(accepted?.plan?.funds || me.actionPlan?.funds);
}

export function renderRecommendations(me) {
  lastMe = me;
  normalisePlan(me.actionPlan);
  syncAccepted(me);
  const asOf = document.getElementById('rec-asof');
  if (asOf) asOf.textContent = me.cacheAsOf ? `Offers last checked ${me.cacheAsOf}.` : 'Offers not yet checked.';

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

  // Don't overwrite what someone is typing: the figures are only refilled when no
  // field in the form has focus.
  const form = document.getElementById('profile-form');
  if (!form || !form.contains(document.activeElement)) {
    const live = getLiveProfile();
    const put = (id, v) => { const el = document.getElementById(id); if (el) el.value = v ?? ''; };
    put('profile-spend', live.monthlySpend);
    put('profile-gross', live.annualSalaryGross);
    put('profile-salary', live.annualSalaryNet);
    put('profile-balance', live.assumedBalance);
    fillOptionsForm(me);
  }
  renderPlanUi();
}

function readFigures() {
  const num = (id) => { const v = document.getElementById(id).value; return v === '' ? null : Number(v); };
  return {
    monthlySpend: num('profile-spend'),
    annualSalaryNet: num('profile-salary'),
    annualSalaryGross: num('profile-gross'),
    assumedBalance: num('profile-balance'),
  };
}

export function initProfileForm(onSaved) {
  const form = document.getElementById('profile-form');
  if (!form) return;
  reload = onSaved;
  const status = document.getElementById('profile-status');
  const keep = document.getElementById('opt-keep-primary');
  keep?.addEventListener('change', () => {
    const wrap = document.getElementById('opt-primary-wrap');
    if (wrap) wrap.hidden = !keep.checked;
  });

  // Enter inside a field must not build the plan half-way through the setup.
  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !(e.target instanceof HTMLInputElement) || e.target.type === 'checkbox') return;
    if (!planRequested()) {
      e.preventDefault();
      const step = Number(getFlag('wizStep', 1)) || 1;
      if (step < 3) { setFlag('wizStep', step + 1); renderPlanUi(); }
    }
  });

  initSetup(() => lastMe, renderPlanUi);
  const plan = document.getElementById('panel-recommend');
  bindSteps(plan, renderPlanUi);

  plan.addEventListener('click', async (e) => {
    const tick = e.target.closest('[data-next-tick]');
    if (tick) { patchStep(tick.dataset.nextTick, { done: true, at: new Date().toISOString().slice(0, 10) }); renderPlanUi(); return; }
    if (e.target.closest('[data-next-show]')) {
      const next = nextAction(activeCards(getAccepted()));
      if (next) revealTarget(next.targetId);
      return;
    }
    const chg = e.target.closest('[data-chg]');
    if (chg) {
      if (chg.dataset.chg === 'update') {
        setFlag('accept', true);
        chg.disabled = true;
        chg.textContent = 'Updating…';
        try { await onSaved(); } catch (err) { chg.disabled = false; chg.textContent = 'Update my plan'; }
        document.getElementById('plan-mount')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else if (lastMe) {
        setFlag('dismissed', `${digestKey(lastMe.offerDigest)}:${inputSignature(lastMe)}`);
        renderPlanUi();
      }
      return;
    }
    const unskip = e.target.closest('[data-unskip]');
    if (unskip) { setCatchup(unskip.dataset.unskip, ''); renderPlanUi(); return; }
    const catchBtn = e.target.closest('[data-catch]');
    if (catchBtn) {
      const key = catchBtn.dataset.key;
      const card = allCards(getAccepted()).find((c) => c.key === key);
      const choice = catchBtn.dataset.catch;
      if (choice === 'all' && card) {
        const at = new Date().toISOString().slice(0, 10);
        (card.actions || []).forEach((a) => patchStep(a.id, { done: true, at }));
      } else if (choice === 'some') {
        setCatchup(key, 'started');
        openState.set(`card:${key}`, true);
      } else if (choice === 'later') {
        setCatchup(key, `later:${new Date().toISOString().slice(0, 10)}`);
      } else if (choice === 'skip') {
        setCatchup(key, 'skipped');
      }
      renderPlanUi();
      if (choice === 'some') revealTarget(`c-${key}`);
      return;
    }
    const stop = e.target.closest('[data-stop-card]');
    if (stop) {
      const key = stop.dataset.stopCard;
      const accepted = getAccepted();
      if (accepted) {
        accepted.carried = (accepted.carried || []).filter((c) => c.key !== key);
        setAccepted(accepted);
        setFlag('abandoned', { ...(getFlag('abandoned', {}) || {}), [key]: true });
      }
      renderPlanUi();
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    status.textContent = 'Building your plan…';
    try {
      setLiveProfile(readFigures());
      setOptions(readOptionsFromForm());
      setPlanRequested(true);
      setFlag('accept', true);
      await onSaved();
      status.textContent = '';
      document.getElementById('next-mount')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      status.textContent = `Couldn't build the plan: ${err.message}`;
    }
  });
}
