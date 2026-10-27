import { data, queueSave } from '../state.js';
import { uid, escapeHtml, bindForm, daysUntil, scrollAndFlash, todayStr } from '../utils.js';

const FREQUENCIES = ['Monthly', 'Yearly', 'Weekly', 'Other'];

// A subscription can hang off one of the tracked finance accounts, and
// the link means one of two different things: it's PAID from that
// account, or it comes free with it (Apple TV+ included with a Barclays
// account). The "Free with it" box is what separates them -- without it
// an £8.99 perk and an £8.99 bill look identical, and knowing which is
// the point of recording the link at all. The link is stored here, on
// the subscription, rather than as a list on the account, so there's
// one copy of it; financeaccounts.js reads it back with its own
// subscriptionsFor() lookup.
function accountLinkHtml(s) {
const accounts = data.financeAccounts.filter((a) => !a.closeDate || new Date(a.closeDate) > new Date());
const options = '<option value="">Not linked to an account</option>'
+ accounts.map((a) => `<option value="${escapeHtml(a.id)}" ${a.id === s.accountId ? 'selected' : ''}>${escapeHtml([a.bank, a.name].filter(Boolean).join(' · ') || 'Unnamed account')}</option>`).join('');
return `<div class="subscription-account">
<select class="voucher-edit" data-sub-account="${s.id}" title="Which account this is paid from, or comes free with">${options}</select>
${s.accountId ? `<label class="subscription-free" title="Comes free with the account — you'd lose it by closing the account"><input type="checkbox" data-sub-free="${s.id}" ${s.includedWithAccount ? 'checked' : ''}> Free with it</label>` : ''}
</div>`;
}

// The date `n` periods after `dateStr`, always counted from the ORIGINAL date
// (so 31 Jan + 1 month is 28/29 Feb and + 2 months is back on 31 Mar, not
// stuck on the 28th). Weekly is 7 days; Yearly is 12 months.
function addPeriod(dateStr, frequency, n) {
const [y, m, d] = dateStr.split('-').map(Number);
if (frequency === 'Weekly') return new Date(Date.UTC(y, m - 1, d + 7 * n)).toISOString().slice(0, 10);
const months = (frequency === 'Yearly' ? 12 : 1) * n;
const target = new Date(Date.UTC(y, m - 1 + months, 1));
const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
target.setUTCDate(Math.min(d, last));
return target.toISOString().slice(0, 10);
}

// A renewal date that has passed moves on to the next one by itself for the
// regular frequencies, so a monthly subscription doesn't need retyping every
// month. "Other" has no known period and keeps asking for an update.
function rollRenewals() {
const today = todayStr();
let changed = false;
data.subscriptions.forEach((s) => {
if (!s.nextRenewal || s.nextRenewal >= today || !['Monthly', 'Yearly', 'Weekly'].includes(s.frequency)) return;
let k = 1;
let next = addPeriod(s.nextRenewal, s.frequency, k);
while (next < today && k < 2000) next = addPeriod(s.nextRenewal, s.frequency, ++k);
s.nextRenewal = next;
changed = true;
});
if (changed) queueSave();
}

const fmtGbp = (n) => `£${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// What one subscription costs over a year, or null when that can't be
// worked out: no amount typed, a frequency of "Other" (no known period), or
// one that comes free with an account.
function annualOf(s) {
if (s.includedWithAccount || s.amount == null || !(s.amount >= 0)) return null;
const perYear = { Monthly: 12, Yearly: 1, Weekly: 52 }[s.frequency];
return perYear ? s.amount * perYear : null;
}

function renderSubscriptionTotal() {
const el = document.getElementById('subscriptions-total');
if (!el) return;
const counted = data.subscriptions.filter((s) => annualOf(s) != null);
if (!counted.length) { el.innerHTML = data.subscriptions.length ? '<div class="settings-note" style="margin:0 0 8px;">Type an amount on a subscription to see what they cost in a year.</div>' : ''; return; }
const year = counted.reduce((n, s) => n + annualOf(s), 0);
const left = data.subscriptions.length - counted.length;
el.innerHTML = `<div class="settings-note" style="margin:0 0 8px;"><strong>${fmtGbp(year)} a year</strong> (${fmtGbp(year / 12)} a month) across ${counted.length} subscription${counted.length === 1 ? '' : 's'}.${left ? ` ${left} not counted: no amount yet, frequency Other, or free with an account.` : ''}</div>`;
}

function renderSubscriptions() {
rollRenewals();
renderSubscriptionTotal();
const list = document.getElementById('subscriptions-list');
document.getElementById('subscriptions-count').textContent = data.subscriptions.length + (data.subscriptions.length === 1 ? ' subscription' : ' subscriptions');
if (data.subscriptions.length === 0) {
list.innerHTML = '<div class="empty">Nothing tracked yet. Add one below.</div>';
return;
}
const sorted = [...data.subscriptions].sort((a, b) => {
const da = a.nextRenewal ? daysUntil(a.nextRenewal) : Infinity;
const db = b.nextRenewal ? daysUntil(b.nextRenewal) : Infinity;
return da - db;
});

list.innerHTML = sorted.map((s) => {
let badgeHtml = '';
if (s.nextRenewal) {
const dn = daysUntil(s.nextRenewal);
if (dn < 0) {
badgeHtml = `<span class="expiry-badge expired">Update due</span>`;
} else if (dn <= 7) {
badgeHtml = `<span class="expiry-badge soon">${dn === 0 ? 'Renews today' : dn + 'd left'}</span>`;
} else {
badgeHtml = `<span class="expiry-badge">${dn}d left</span>`;
}
}
return `<div class="voucher-row" data-subscription-row="${s.id}">
<div class="voucher-id">
<input type="text" autocomplete="off" class="voucher-edit voucher-name-edit" data-field="name" data-sub-id="${s.id}" value="${escapeHtml(s.name)}">
<div class="voucher-meta">
<select class="voucher-edit voucher-type-edit" data-field="frequency" data-sub-id="${s.id}">
${FREQUENCIES.map((f) => `<option value="${f}" ${f === s.frequency ? 'selected' : ''}>${f}</option>`).join('')}
</select>
<input type="number" step="0.01" min="0" inputmode="decimal" class="voucher-edit voucher-value-edit" data-field="amount" data-sub-id="${s.id}" value="${s.amount != null ? s.amount : ''}" placeholder="£ ${s.frequency === 'Yearly' ? 'a year' : s.frequency === 'Weekly' ? 'a week' : s.frequency === 'Monthly' ? 'a month' : 'each time'}" title="What one payment costs, in pounds"${s.includedWithAccount ? ' disabled title="Included with the linked account — no cost of its own"' : ''}>
${annualOf(s) != null ? `<span class="settings-note" style="margin:0;white-space:nowrap;" title="Worked out from the amount and how often it is charged">&asymp; ${fmtGbp(annualOf(s))}/yr</span>` : ''}
</div>
${accountLinkHtml(s)}
</div>
<input type="text" autocomplete="off" class="voucher-edit voucher-notes-edit" data-field="notes" data-sub-id="${s.id}" value="${escapeHtml(s.notes || '')}" placeholder="Notes">
<div class="voucher-expiry">
<input type="date" class="voucher-edit expiry-date-edit" data-field="nextRenewal" data-sub-id="${s.id}" value="${escapeHtml(s.nextRenewal || '')}" title="Next renewal date — not when you first got it">
${badgeHtml}
</div>
<div class="voucher-actions">
<span class="del-x" style="opacity:1;" data-del-subscription="${s.id}">&times;</span>
</div>
</div>`;
}).join('');

list.querySelectorAll('[data-field][data-sub-id]').forEach((el) => {
el.addEventListener('change', () => {
const s = data.subscriptions.find((x) => x.id === el.dataset.subId);
if (!s) return;
if (el.dataset.field === 'amount') {
const n = el.value.trim() === '' ? null : Number(el.value);
s.amount = Number.isFinite(n) && n >= 0 ? n : null;
} else {
s[el.dataset.field] = el.value.trim();
}
renderSubscriptions();
queueSave();
});
});
// Both of these change what the Finances accounts panel shows (its
// per-account "3 subs · 1 free" chip and the linked list inside each
// account), and the two panels sit on screen together, so it redraws
// too. Dynamic import keeps the dependency one-directional at load
// time -- financeaccounts.js already imports this module, not the
// other way round.
async function refreshAccountsPanel() {
const { renderFinanceAccounts } = await import('./financeaccounts.js');
renderFinanceAccounts();
}
list.querySelectorAll('[data-sub-account]').forEach((sel) => {
sel.addEventListener('change', () => {
const s = data.subscriptions.find((x) => x.id === sel.dataset.subAccount);
if (!s) return;
s.accountId = sel.value;
// "Free with an account" can't survive being unlinked from every
// account -- it'd read as a perk you still have, attached to nothing.
if (!s.accountId) s.includedWithAccount = false;
renderSubscriptions();
queueSave();
refreshAccountsPanel();
});
});
list.querySelectorAll('[data-sub-free]').forEach((cb) => {
cb.addEventListener('change', () => {
const s = data.subscriptions.find((x) => x.id === cb.dataset.subFree);
if (!s) return;
s.includedWithAccount = cb.checked;
renderSubscriptions();
queueSave();
refreshAccountsPanel();
});
});
list.querySelectorAll('[data-del-subscription]').forEach((el) => {
el.addEventListener('click', () => {
const wasLinked = data.subscriptions.some((x) => x.id === el.dataset.delSubscription && x.accountId);
data.subscriptions = data.subscriptions.filter((x) => x.id !== el.dataset.delSubscription);
renderSubscriptions();
queueSave();
if (wasLinked) refreshAccountsPanel();
});
});
}

function initSubscriptionForm() {
bindForm('subscription-form', () => {
const nameInput = document.getElementById('subscription-name-input');
const frequencyInput = document.getElementById('subscription-frequency-input');
const costInput = document.getElementById('subscription-cost-input');
const renewalInput = document.getElementById('subscription-renewal-input');
const notesInput = document.getElementById('subscription-notes-input');
const name = nameInput.value.trim();
if (!name) return;
data.subscriptions.push({
id: uid(),
name,
frequency: frequencyInput.value,
amount: costInput.value.trim() === '' || !(Number(costInput.value) >= 0) ? null : Number(costInput.value),
nextRenewal: renewalInput.value,
notes: notesInput.value.trim(),
});
nameInput.value = '';
costInput.value = '';
renewalInput.value = '';
notesInput.value = '';
renderSubscriptions();
queueSave();
});
}

// The canonical way to land on one subscription from elsewhere -- the
// Media tab's "you already pay for this" tick is the first such
// reference, and per dashboard/CLAUDE.md a record shown outside its own
// list has to lead back to the real row. Same shape as revealTask and
// revealMediaItem.
function revealSubscription(id) {
renderSubscriptions();
setTimeout(() => scrollAndFlash(`[data-subscription-row="${id}"]`), 60);
}

export { renderSubscriptions, initSubscriptionForm, revealSubscription };
