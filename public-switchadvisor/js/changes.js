// What happened to the offers since the person built the plan they are following, and
// what it would mean for them to rebuild it. The plan they follow is frozen (see
// progress.js); nothing here changes it, it only describes the difference and carries
// the in-progress work across when they choose to update.
import { escapeHtml as esc, money } from './utils.js';
import { cardProgress, cardStarted } from './steps.js';
import { isSkipped } from './progress.js';

// ---- Offers -----------------------------------------------------------------
// Compares two offerDigest objects from the server. An entry is "yours" when the plan
// being followed uses that product, so those changes are listed first.
export function diffDigest(oldD, newD, planCards) {
  const out = [];
  if (!oldD || !newD) return out;
  const used = new Set((planCards || []).map((c) => (c.product || '').toLowerCase()).filter(Boolean));
  const usedBanks = new Set((planCards || []).map((c) => (c.bank || '').toLowerCase()).filter(Boolean));
  const was = new Map((oldD.items || []).map((i) => [i.id, i]));
  const now = new Map((newD.items || []).map((i) => [i.id, i]));
  const mine = (i) => used.has((i.product || '').toLowerCase()) || (i.kind === 'cashback' && [...usedBanks].some((b) => b && (i.product || '').toLowerCase().includes(b.split(' ')[0])));
  const label = (i) => (i.kind === 'switch' ? `${i.product}` : i.product);

  now.forEach((n, id) => {
    const o = was.get(id);
    if (!o) {
      if (n.kind === 'krak') return;
      out.push({ kind: 'new', mine: false, item: n, text: `New: ${label(n)}${n.amount ? ` pays ${money(n.amount)}` : ''}.` });
      return;
    }
    if (n.amount !== o.amount) {
      const up = n.amount > o.amount;
      out.push({ kind: up ? 'up' : 'down', mine: mine(n), item: n, text: `${label(n)}: ${up ? 'now pays more' : 'now pays less'} — ${money(o.amount)} → ${money(n.amount)}.` });
    } else if ((n.deadline || '') !== (o.deadline || '')) {
      out.push({ kind: 'deadline', mine: mine(n), item: n, text: `${label(n)}: the deadline has moved${o.deadline ? ` from ${o.deadline}` : ''}${n.deadline ? ` to ${n.deadline}` : ' (no deadline now)'}.` });
    } else if (n.terms !== o.terms) {
      out.push({ kind: 'terms', mine: mine(n), item: n, text: n.kind === 'krak' ? 'Krak’s reward rates or minimums have changed.' : `${label(n)}: the conditions have changed — worth reading its terms again.` });
    }
  });
  was.forEach((o, id) => {
    if (!now.has(id)) out.push({ kind: 'ended', mine: mine(o), item: o, text: `${label(o)} is no longer listed${o.amount ? ` (it paid ${money(o.amount)})` : ''}.` });
  });
  return out;
}

// ---- Plans ------------------------------------------------------------------
export function diffPlans(oldPlan, newPlan) {
  const oldCards = new Map((oldPlan?.cards || []).map((c) => [c.key, c]));
  const newCards = new Map((newPlan?.cards || []).map((c) => [c.key, c]));
  const added = [...newCards.values()].filter((c) => !oldCards.has(c.key));
  const removed = [...oldCards.values()].filter((c) => !newCards.has(c.key));
  return { added, removed };
}

// Cards the person has begun but not finished (counting ones carried over earlier).
export function startedCards(accepted) {
  return activeCards(accepted).filter(cardStarted);
}

// The cards still being followed: skipped ones stay on screen but no longer count.
export function activeCards(accepted) {
  return allCards(accepted).filter((c) => !isSkipped(c.key));
}

export function allCards(accepted) {
  if (!accepted) return [];
  return [...(accepted.carried || []), ...((accepted.plan && accepted.plan.cards) || [])];
}

// The accepted object for an updated plan: the new plan, plus any card that was under
// way in the old one but is not in the new one -- still theirs to finish.
export function acceptedFrom(fresh, digest, inputSig, previous, abandoned = {}) {
  const freshKeys = new Set((fresh.cards || []).map((c) => c.key));
  const carried = previous
    ? startedCards(previous)
      .filter((c) => !freshKeys.has(c.key) && !abandoned[c.key])
      .map((c) => ({ ...c, carried: true }))
    : [];
  return { plan: fresh, digest, inputSig, builtAt: new Date().toISOString(), carried };
}

// ---- The banner ---------------------------------------------------------------
export function changeBannerHtml({ accepted, fresh, offerChanges, inputsChanged }) {
  if (!accepted || !fresh) return '';
  const oldTotal = Number(accepted.plan.total) || 0;
  const newTotal = Number(fresh.total) || 0;
  const delta = Math.round(newTotal - oldTotal);
  const started = startedCards(accepted);
  const { added, removed } = diffPlans(accepted.plan, fresh);
  const freshKeys = new Set((fresh.cards || []).map((c) => c.key));

  const mineChanges = offerChanges.filter((c) => c.mine);
  const otherChanges = offerChanges.filter((c) => !c.mine);
  if (!offerChanges.length && !inputsChanged) return '';

  let tone = 'neutral';
  let impact;
  if (Math.abs(delta) < 10) impact = `Rebuilding now would give about the same total — roughly ${money(newTotal)}.`;
  else if (delta > 0) { tone = 'good'; impact = `Good news: rebuilding now would be worth about <strong>${money(delta)} more</strong> (${money(oldTotal)} → ${money(newTotal)}).`; }
  else { tone = 'bad'; impact = `Rebuilding now would be worth about <strong>${money(-delta)} less</strong> (${money(oldTotal)} → ${money(newTotal)}), because of the changes below.`; }

  const title = offerChanges.length
    ? (inputsChanged ? 'The offers have changed, and so have your details' : 'The offers have changed since you built your plan')
    : 'You have changed your details';
  const noteInputs = inputsChanged ? '<p class="muted">The figure above includes the effect of your own changes (accounts, income or options) as well as the offers.</p>' : '';

  const li = (arr) => arr.map((c) => `<li class="chg chg-${esc(c.kind)}">${esc(c.text)}</li>`).join('');
  const mineHtml = mineChanges.length ? `<p class="plan-sub">Changes that touch your plan</p><ul>${li(mineChanges)}</ul>` : (offerChanges.length ? '<p class="muted">None of the offers in your plan have changed.</p>' : '');
  const otherHtml = otherChanges.length ? `<details><summary>${otherChanges.length} other change${otherChanges.length === 1 ? '' : 's'} to offers not in your plan</summary><ul>${li(otherChanges)}</ul></details>` : '';

  const titles = (cards) => cards.map((c) => esc(c.title)).join('; ');
  const stepDiff = [];
  if (added.length) stepDiff.push(`<li><strong>${added.length} new step group${added.length === 1 ? '' : 's'}:</strong> ${titles(added)}.</li>`);
  if (removed.length) stepDiff.push(`<li><strong>${removed.length} no longer needed:</strong> ${titles(removed)}.</li>`);
  const diffHtml = stepDiff.length ? `<p class="plan-sub">If you update</p><ul>${stepDiff.join('')}</ul>` : '';

  const under = started.length ? `<div class="chg-reassure">
      <strong>You are part-way through ${started.map((c) => esc(c.title)).join('; ')}.</strong>
      Carry on with ${started.length === 1 ? 'it' : 'them'} whatever the offers do: finish what you have started. Updating keeps every tick you have made, and
      ${started.some((c) => !freshKeys.has(c.key)) ? 'anything you have started that the new plan would not begin today stays on your list until you finish it or stop it.' : 'everything you have started is still in the new plan.'}
      ${started.some((c) => !freshKeys.has(c.key)) ? 'Check the bank’s own terms for an offer you have already applied under.' : ''}
    </div>` : '';

  return `<div class="chg-banner chg-${tone}" id="change-banner">
    <h3>${title}</h3>
    <p>${impact}</p>
    ${noteInputs}
    ${mineHtml}
    ${diffHtml}
    ${otherHtml}
    ${under}
    <div class="chg-actions">
      <button type="button" class="sync-btn" data-chg="update">Update my plan</button>
      <button type="button" class="sync-btn ghost" data-chg="keep">Keep my current plan for now</button>
    </div>
  </div>`;
}

// For the plan header: how far through the person is.
export function overallProgress(accepted) {
  let done = 0;
  let total = 0;
  activeCards(accepted).forEach((c) => { const p = cardProgress(c); done += p.done; total += p.total; });
  return { done, total };
}

// A plan from a server that has not been updated yet carries no card keys or step ids.
// Give it some, from the card's kind and title, so ticking still works (the branching
// steps need the server's parameters and simply show as plain steps until it is updated).
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
export function normalisePlan(plan) {
  if (!plan || !Array.isArray(plan.cards)) return plan;
  const seen = {};
  plan.cards.forEach((c) => {
    if (!c.key) {
      let key = `${c.kind}:${slug(c.title)}`;
      seen[key] = (seen[key] || 0) + 1;
      if (seen[key] > 1) key += `-${seen[key]}`;
      c.key = key;
    }
    const count = {};
    (c.actions || []).forEach((a) => {
      a.t = a.t || 'step';
      if (!a.id) { count[a.t] = (count[a.t] || 0) + 1; a.id = `${c.key}/${a.t}${count[a.t]}`; }
    });
  });
  return plan;
}
