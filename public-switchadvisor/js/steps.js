// A plan card's steps as a checklist, where some steps branch. "Make sure the account
// has 3 Direct Debits" is not one tick: it asks how many there are now, and each
// answer opens the tasks that follow from it. The branches live here, keyed by the
// step's type, so a new kind of step is a new entry in TREES (and the list of ways to
// make a Direct Debit is DD_OPTIONS in config.js, meant to grow).
import { DD_OPTIONS, isSetUp } from './config.js';
import { escapeHtml as esc } from './utils.js';
import { stepState, patchStep, clearStepTree, hasAnyProgress } from './progress.js';

let context = { lowIncome: false };
export function setStepContext(c) { context = { ...context, ...c }; }

const ddOptions = () => DD_OPTIONS.filter((o) => !o.url || isSetUp(o.url));

// ---- Nodes: the pieces a step can unfold into --------------------------------
const check = (id, html, plain) => ({ type: 'check', id, html, plain, done: !!stepState(id).done });
const ask = (id, html, plain, options, hint = '') => ({ type: 'ask', id, html, plain, options, hint, answer: stepState(id).answer || '' });

function ddTree(step) {
  const p = step.params || {};
  const need = Number(p.need) || 2;
  const account = p.account || 'the account';
  const nodes = [];
  let missing = null;
  let complete = false;
  if (p.fresh) {
    missing = need;
  } else {
    const options = [{ value: 'ok', label: `${need} or more` }];
    for (let k = need - 1; k >= 0; k -= 1) options.push({ value: String(k), label: k === 0 ? 'None' : String(k) });
    options.push({ value: 'unsure', label: 'Not sure' });
    const q = ask(`${step.id}~count`,
      `How many live Direct Debits does <strong>${esc(account)}</strong> have right now? It needs ${need}.`,
      `Say how many live Direct Debits ${account} has (it needs ${need})`,
      options, p.have != null ? `You told us it has ${p.have}.` : '');
    nodes.push(q);
    if (q.answer === 'ok') complete = true;
    else if (q.answer === 'unsure') nodes.push(check(`${step.id}~look`, `Open ${esc(account)} in its app or online banking, find the Direct Debits list and count the live ones. Then answer the question above.`, `Count the live Direct Debits on ${account}`));
    else if (q.answer !== '') missing = need - Number(q.answer);
  }
  if (missing && !complete) {
    let all = true;
    for (let i = 1; i <= missing; i += 1) {
      const pid = `${step.id}~dd${i}`;
      const pick = ask(pid,
        `Direct Debit ${i} of ${missing}: how will you set it up on <strong>${esc(account)}</strong>?`,
        `Choose how to set up Direct Debit ${i} of ${missing} on ${account}`,
        ddOptions().map((o) => ({ value: o.id, label: o.label })),
        i === 1 ? 'It has to be a Direct Debit: a card payment or a standing order does not count.' : '');
      nodes.push(pick);
      const opt = ddOptions().find((o) => o.id === pick.answer);
      if (opt) {
        const node = check(`${pid}~do`,
          `<strong>${esc(opt.label)}.</strong> ${esc(opt.detail)}${opt.url ? ` <a href="${esc(opt.url)}" target="_blank" rel="noopener">Open it &rarr;</a>` : ''}`,
          `${opt.label} (Direct Debit ${i} of ${missing})`);
        nodes.push(node);
        if (!node.done) all = false;
      } else {
        all = false;
      }
    }
    complete = all;
  }
  return { nodes, complete };
}

function salaryTree(step) {
  const p = step.params || {};
  const product = p.product || 'your new account';
  const msg = `Hello, I am changing the bank account my salary is paid into. From the payday after ${p.from || 'the date we agreed'}, please pay my salary into my ${product} account instead: sort code [          ], account number [          ], name on the account [          ]. The amount stays the same. Could you confirm which payday this starts from? Thank you.`;
  const nodes = [
    check(`${step.id}~who`, 'Find out who changes your pay details (payroll, HR or your manager will know) and how they want the request made.', 'Find out who handles payroll changes'),
    check(`${step.id}~send`, `Send them your new account details. You can use this wording:
      <details class="step-template"><summary>Show a message to send</summary><p class="step-msg">${esc(msg)}</p><button type="button" class="opt" data-copy="${esc(msg)}">Copy the message</button></details>`, 'Send your new account details to payroll'),
    check(`${step.id}~first`, `When the first payment arrives, check it landed in ${esc(product)} and shows as coming from your employer.`, `Check the first salary payment landed in ${product}`),
  ];
  return { nodes, complete: nodes.every((n) => n.done) };
}

function cassTree(step) {
  const p = step.params || {};
  const bank = p.bank || 'the new bank';
  const nodes = [
    check(`${step.id}~start`, `Start the switch with ${esc(bank)}: they ask for your ${esc(p.from || 'old account')} details and a switch date at least 7 working days ahead.`, `Start the switch with ${bank}`),
    check(`${step.id}~confirm`, `Wait for ${esc(bank)}'s confirmation of the switch date. Do not close or empty the old account yourself: the switch closes it.`, `Wait for ${bank}'s confirmation of the switch date`),
    check(`${step.id}~done`, `After the switch date, check the Direct Debits and standing orders have arrived on the new account and the old one has closed.`, 'Check the switch has gone through'),
  ];
  return { nodes, complete: nodes.every((n) => n.done) };
}

// A step only branches if the server gave it the facts the branch needs.
const TREES = { dd: ddTree, salary: salaryTree, cass: cassTree };
function treeFor(step) {
  const fn = TREES[step.t];
  return fn && step.params ? fn(step) : null;
}

// ---- Done-ness --------------------------------------------------------------
export function isStepDone(step) {
  if (stepState(step.id).done) return true;
  const tree = treeFor(step);
  return !!(tree && tree.complete);
}

export function cardProgress(card) {
  const total = (card.actions || []).length;
  const done = (card.actions || []).filter(isStepDone).length;
  return { done, total, complete: total > 0 && done === total };
}

export function cardStarted(card) {
  const p = cardProgress(card);
  return !p.complete && hasAnyProgress(`${card.key}/`);
}

// The first thing the person can act on: the first unfinished step, narrowed to the
// first unanswered question or unticked task inside it.
export function nextAction(cards) {
  for (const card of cards) {
    for (const step of card.actions || []) {
      if (isStepDone(step)) continue;
      const tree = treeFor(step);
      const node = tree ? tree.nodes.find((n) => (n.type === 'check' ? !n.done : !n.answer)) : null;
      return {
        card, step, node,
        plain: node ? node.plain : step.text,
        kind: node ? node.type : 'check',
        targetId: node ? `n-${node.id}` : `s-${step.id}`,
        tickId: node ? node.id : step.id,
        isNode: !!node,
      };
    }
  }
  return null;
}

// ---- Rendering --------------------------------------------------------------
function nodeHtml(n) {
  if (n.type === 'check') {
    return `<label class="node node-check ${n.done ? 'node-done' : ''}" id="n-${esc(n.id)}"><input type="checkbox" data-node-check="${esc(n.id)}" ${n.done ? 'checked' : ''}> <span>${n.html}</span></label>`;
  }
  return `<div class="node node-ask" id="n-${esc(n.id)}">
    <div class="node-q">${n.html}</div>
    ${n.hint ? `<div class="muted node-hint">${esc(n.hint)}</div>` : ''}
    <div class="node-opts">${n.options.map((o) => `<button type="button" class="opt ${n.answer === o.value ? 'sel' : ''}" data-ask="${esc(n.id)}" data-value="${esc(o.value)}">${esc(o.label)}</button>`).join('')}</div>
  </div>`;
}

const CIRCULATE_TYPES = new Set(['standing-order', 'payin', 'payin-back']);

// `bodyHtml(step)` renders the step's own sentence and links (it lives with the plan
// view, which owns the link and referral wording).
export function stepsHtml(card, bodyHtml) {
  return `<ul class="steps">${(card.actions || []).map((a) => {
    const done = isStepDone(a);
    const tree = treeFor(a);
    const tip = context.lowIncome && CIRCULATE_TYPES.has(a.t)
      ? '<div class="step-tip">This can be money you already have: move it in from your main account and back out when the offer allows. It does not need to come from income.</div>' : '';
    return `<li class="step ${done ? 'step-done' : ''}" id="s-${esc(a.id)}">
      <label class="step-row"><input type="checkbox" data-check="${esc(a.id)}" ${done ? 'checked' : ''}> <span class="step-text">${bodyHtml(a)}</span></label>
      ${tip}
      ${tree ? `<details class="step-branch" data-dkey="${esc(a.id)}" ${done ? '' : 'open'}><summary>${done ? 'Show the steps' : 'Take it step by step'}</summary><div class="step-tree">${tree.nodes.map(nodeHtml).join('')}</div></details>` : ''}
    </li>`;
  }).join('')}</ul>`;
}

// ---- Events -----------------------------------------------------------------
export function bindSteps(root, onChange) {
  root.addEventListener('change', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement)) return;
    if (t.dataset.nodeCheck) {
      patchStep(t.dataset.nodeCheck, { done: t.checked, at: new Date().toISOString().slice(0, 10) });
      onChange();
    } else if (t.dataset.check) {
      const id = t.dataset.check;
      if (t.checked) patchStep(id, { done: true, at: new Date().toISOString().slice(0, 10) });
      else clearStepTree(id); // unticking a step starts it again, branch answers included
      onChange();
    }
  });
  root.addEventListener('click', (e) => {
    const copy = e.target.closest?.('[data-copy]');
    if (copy) {
      navigator.clipboard?.writeText(copy.dataset.copy).then(() => { copy.textContent = 'Copied'; }).catch(() => {});
      return;
    }
    const btn = e.target.closest?.('[data-ask]');
    if (!btn) return;
    const id = btn.dataset.ask;
    const same = stepState(id).answer === btn.dataset.value;
    patchStep(id, { answer: same ? '' : btn.dataset.value });
    onChange();
  });
}

// Scroll to a node or step and flash it.
export function revealTarget(id) {
  const el = document.getElementById(id);
  if (!el) return;
  let up = el.parentElement;
  while (up) { if (up.tagName === 'DETAILS') up.open = true; up = up.parentElement; }
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1600);
}
