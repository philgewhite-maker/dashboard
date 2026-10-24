// Money borrowed from a listing owner, in tranches, with the interest it
// costs offset against what that owner owes from the Airbnb ledger.
//
// The rule, in one place so it can be checked against: on any day an owner
// is lent L (the tranches that have started and not yet been repaid) and
// owes you A on the Airbnb ledger. You are only really in debt for the part
// A doesn't cover, so interest accrues daily on max(0, L - A) -- a bigger
// Airbnb balance means less interest. A negative A (you already owe them
// through the ledger) adds to the base. When tranches carry different
// rates, the base is charged at the principal-weighted average rate.
// Daily interest = base x rate / 365.
//
// On the 1st of each month the previous month's total is posted into that
// owner's lettingLedger as a negative 'interest' row dated the 1st, so it
// reduces what they owe you (and shows on their statement). Each month is
// posted once and then left alone, like any other posting; "Recalculate"
// clears the automatic rows and rebuilds them after a loan is edited.
import { data, queueSave, blankLoan } from '../state.js';
import { escapeHtml, todayStr } from '../utils.js';
import { owners, ownerNameFor, entriesFor, balanceFor, money, reconcileMonthlyCaps, renderLetting } from './letting.js';

const r2 = (n) => Math.round(n * 100) / 100;
const monthLabel = (ym) => new Date(`${ym}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
const firstOfNext = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10); };
const lastDay = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };

function loansFor(key) {
return (data.loans || []).filter((l) => l.ownerKey === key && Number(l.amount) > 0 && l.startDate && l.repayDate && l.repayDate > l.startDate);
}

function outstandingAt(loans, day) {
let principal = 0;
let weighted = 0;
loans.forEach((l) => {
if (l.startDate <= day && day < l.repayDate) {
principal += Number(l.amount);
weighted += Number(l.amount) * (Number(l.ratePct) || 0) / 100;
}
});
return { principal, rate: principal ? weighted / principal : 0 };
}

// Interest for one calendar month for one owner, from day 1 to `throughDay`
// (the whole month by default -- a smaller number gives the month so far).
function interestForMonth(key, ym, throughDay = lastDay(ym)) {
const loans = loansFor(key);
if (!loans.length) return 0;
const entries = entriesFor(key).filter((e) => e.date).slice().sort((a, b) => a.date.localeCompare(b.date));
let owed = 0; // what they owe you on the Airbnb ledger, as of the day being priced
let i = 0;
while (i < entries.length && entries[i].date < `${ym}-01`) owed += Number(entries[i++].amount) || 0;
let interest = 0;
for (let d = 1; d <= throughDay; d++) {
const day = `${ym}-${String(d).padStart(2, '0')}`;
while (i < entries.length && entries[i].date <= day) owed += Number(entries[i++].amount) || 0;
const { principal, rate } = outstandingAt(loans, day);
if (!principal) continue;
const base = Math.max(0, principal - owed);
if (base > 0) interest += (base * rate) / 365;
}
return r2(interest);
}

// Posts every completed month not yet posted, oldest first so each month's
// balance already includes the interest rows before it. Returns how many.
function postLoanInterest() {
reconcileMonthlyCaps(); // the balance interest is priced against must already include any monthly-cap adjustments
if (!Array.isArray(data.prefs.loanInterestDone)) data.prefs.loanInterestDone = [];
const done = new Set(data.prefs.loanInterestDone);
const nowMonth = todayStr().slice(0, 7);
let posted = 0;
[...new Set((data.loans || []).map((l) => l.ownerKey).filter(Boolean))].forEach((key) => {
const loans = loansFor(key);
if (!loans.length) return;
let ym = loans.map((l) => l.startDate).sort()[0].slice(0, 7);
while (ym < nowMonth) {
const id = `interest:${key}:${ym}`;
if (!done.has(id)) {
const amount = interestForMonth(key, ym);
done.add(id); // even a nil month, so it isn't re-priced on every open
if (amount > 0) {
data.lettingLedger.push({
id, ownerKey: key, kind: 'interest', autoInterest: true, amount: -amount,
date: firstOfNext(ym), note: `Loan interest, ${monthLabel(ym)}`,
});
posted++;
}
}
ym = firstOfNext(ym).slice(0, 7);
}
});
data.prefs.loanInterestDone = [...done];
if (posted) queueSave();
return posted;
}

function recalculateInterest() {
data.lettingLedger = (data.lettingLedger || []).filter((e) => !e.autoInterest);
data.prefs.loanInterestDone = [];
postLoanInterest();
queueSave();
}

// ---- Panel ----------------------------------------------------------------

function statusOf(l, today) {
if (l.repayDate && l.repayDate <= today) return 'repaid';
if (l.startDate && l.startDate > today) return 'upcoming';
return 'active';
}

function renderLoans() {
const el = document.getElementById('loans-list');
if (!el) return;
const today = todayStr();
const ownerOpts = owners().map((k) => `<option value="${escapeHtml(k)}">${escapeHtml(ownerNameFor(k))}</option>`).join('');
const addSel = document.getElementById('loan-add-owner');
if (addSel) addSel.innerHTML = `<option value="">Lender…</option>${ownerOpts}`;
const keys = [...new Set((data.loans || []).map((l) => l.ownerKey).filter(Boolean))];
const outstandingTotal = (data.loans || []).filter((l) => statusOf(l, today) === 'active').reduce((n, l) => n + (Number(l.amount) || 0), 0);
const badge = document.getElementById('loans-total');
if (badge) badge.textContent = outstandingTotal ? `${money(outstandingTotal)} borrowed` : '';
if (!keys.length) {
el.innerHTML = '<div class="settings-note" style="margin:0;">No loans yet. Add each tranche below — who lent it, how much, when it starts and when it is repaid.</div>';
return;
}
const ym = today.slice(0, 7);
el.innerHTML = keys.map((key) => {
const mine = (data.loans || []).filter((l) => l.ownerKey === key).sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
const { principal, rate } = outstandingAt(loansFor(key), today);
const owed = balanceFor(key);
const base = Math.max(0, principal - owed);
const soFar = interestForMonth(key, ym, Number(today.slice(8, 10)));
const paidToDate = entriesFor(key).filter((e) => e.autoInterest).reduce((n, e) => n - (Number(e.amount) || 0), 0);
return `<div class="letting-owner">
<div class="letting-head"><span class="letting-name">${escapeHtml(ownerNameFor(key))}</span>
<span class="settings-note" style="margin:0;">${escapeHtml(money(principal))} lent today &middot; they owe you ${escapeHtml(money(owed))} on the <span class="inline-goto-link" data-goto-tab="finances" data-goto-target="#letting-panel">Airbnb ledger</span></span></div>
<div class="settings-note" style="margin:2px 0 4px;">Interest-bearing today: <strong>${escapeHtml(money(base))}</strong>${principal ? ` at ${(rate * 100).toFixed(2).replace(/\.?0+$/, '')}%` : ''} &middot; ${escapeHtml(money(soFar))} so far this month &middot; ${escapeHtml(money(paidToDate))} posted to date</div>
${mine.map((l) => `<div class="loan-tranche" data-loan-row="${escapeHtml(l.id)}">
<span class="letting-kind ${statusOf(l, today) === 'repaid' ? '' : statusOf(l, today) === 'upcoming' ? 'upcoming' : 'earned'}">${statusOf(l, today)}</span>
<label>£<input type="number" min="0" step="0.01" class="settings-input" data-loan-field="amount" data-loan-id="${escapeHtml(l.id)}" value="${escapeHtml(l.amount)}" style="width:96px;"></label>
<label>from<input type="date" class="settings-input" data-loan-field="startDate" data-loan-id="${escapeHtml(l.id)}" value="${escapeHtml(l.startDate)}"></label>
<label>repay<input type="date" class="settings-input" data-loan-field="repayDate" data-loan-id="${escapeHtml(l.id)}" value="${escapeHtml(l.repayDate)}"></label>
<label>%<input type="number" min="0" step="0.1" class="settings-input" data-loan-field="ratePct" data-loan-id="${escapeHtml(l.id)}" value="${escapeHtml(l.ratePct)}" style="width:64px;"></label>
<span class="del-x" data-loan-del="${escapeHtml(l.id)}" title="Remove this tranche">&times;</span>
</div>`).join('')}
</div>`;
}).join('');

el.querySelectorAll('[data-loan-field]').forEach((input) => {
input.addEventListener('change', () => {
const loan = data.loans.find((l) => l.id === input.dataset.loanId);
if (!loan) return;
const f = input.dataset.loanField;
loan[f] = (f === 'amount' || f === 'ratePct') ? (Number(input.value) || 0) : input.value;
queueSave();
renderLoans();
});
});
el.querySelectorAll('[data-loan-del]').forEach((x) => {
x.addEventListener('click', () => {
data.loans = data.loans.filter((l) => l.id !== x.dataset.loanDel);
queueSave();
renderLoans();
});
});
}

function initLoans() {
const addBtn = document.getElementById('loan-add-btn');
if (!addBtn) return;
const sayEl = document.getElementById('loan-add-status');
const say = (t) => { if (sayEl) sayEl.textContent = t; };
const startEl = document.getElementById('loan-add-start');
if (startEl && !startEl.value) startEl.value = todayStr();
addBtn.addEventListener('click', () => {
const ownerKey = document.getElementById('loan-add-owner').value;
const amount = Number(document.getElementById('loan-add-amount').value);
const startDate = document.getElementById('loan-add-start').value;
const repayDate = document.getElementById('loan-add-repay').value;
const ratePct = Number(document.getElementById('loan-add-rate').value);
if (!ownerKey) { say('Pick the lender.'); return; }
if (!(amount > 0)) { say('Enter the amount.'); return; }
if (!startDate || !repayDate || repayDate <= startDate) { say('The repay date must be after the start date.'); return; }
data.loans.push(blankLoan({ ownerKey, amount, startDate, repayDate, ratePct: Number.isFinite(ratePct) ? ratePct : 10 }));
queueSave();
document.getElementById('loan-add-amount').value = '';
say('');
afterChange();
});
document.getElementById('loan-recalc-btn')?.addEventListener('click', () => {
if (!window.confirm('Remove the automatic loan-interest rows and work them out again from the loans as they are now?')) return;
recalculateInterest();
afterChange();
});
afterChange();
}

function afterChange() {
postLoanInterest();
renderLoans();
renderLetting();
}

export { initLoans, renderLoans, postLoanInterest, interestForMonth };
