// What the kids owe you for their listings' takings.
//
// Each of them owns one listing. You type in what a stay earned, and half
// of it becomes a debt on the day the guests leave — "from last day",
// which is `checkout`, the turnover date the ICS feed already carries.
//
// Kept as a LIST rather than a balance. A balance alone cannot be
// audited, and the question you will actually ask months later is "where
// did that number come from", which only the entries can answer. The two
// totals are derived from the list every time rather than stored, so they
// cannot drift away from the thing they summarise.
//
// Accrual is idempotent: a stay carries `accruedAt` once it has been
// charged, and the sweep skips anything already written. It runs on app
// open, so a stay that ended while you were away is picked up the next
// time you look rather than needing a button.
import { data, queueSave } from '../state.js';
import { escapeHtml, uid } from '../utils.js';

// An owner is a connection where possible, so the ledger can lead back to
// the real person. A listing with only a typed name still works — the key
// is just that name — which matters because a child may well not be a
// record on the Dating tab.
function ownerKeyFor(listing) {
if (!listing) return '';
return listing.ownerConnectionId || (listing.ownerLabel || '').trim().toLowerCase();
}

function ownerNameFor(key) {
if (!key) return 'Unassigned';
const conn = (data.connections || []).find((c) => c.id === key);
if (conn) return conn.name || 'Unnamed';
const listing = (data.airbnbListings || []).find((l) => ownerKeyFor(l) === key);
return (listing && listing.ownerLabel) || key;
}

// Their share, taken from whichever listing they own. Falls back to 50
// rather than refusing: the number is on the listing, and a historic
// figure may well be entered before the listing is set up.
function sharePctFor(key) {
const listing = (data.airbnbListings || []).find((l) => ownerKeyFor(l) === key);
const pct = listing ? Number(listing.sharePct) : NaN;
return Number.isFinite(pct) ? pct : 50;
}

function entriesFor(key) {
return (data.lettingLedger || []).filter((e) => e.ownerKey === key);
}

function balanceFor(key) {
return entriesFor(key).reduce((n, e) => n + (Number(e.amount) || 0), 0);
}

// Every owner who has a listing or a ledger entry, so somebody who has
// paid up and has no listing this season doesn't vanish mid-settlement.
function owners() {
const keys = new Set();
(data.airbnbListings || []).forEach((l) => { const k = ownerKeyFor(l); if (k) keys.add(k); });
(data.lettingLedger || []).forEach((e) => { if (e.ownerKey) keys.add(e.ownerKey); });
return [...keys];
}

function totalOwed() {
return owners().reduce((n, k) => n + balanceFor(k), 0);
}

// ---- Accrual --------------------------------------------------------------

function today() { return new Date().toISOString().slice(0, 10); }

// Turns finished stays into what they owe. Only stays that have ENDED:
// money is not owed on a booking that might still be cancelled, and
// `checkout` is the day they leave.
function accrueLettings() {
const listings = data.airbnbListings || [];
let added = 0;
(data.airbnbReservations || []).forEach((r) => {
if (r.accruedAt) return;
const income = Number(r.income);
if (!Number.isFinite(income) || income <= 0) return;
if (!r.checkout || r.checkout > today()) return;
const listing = listings.find((l) => l.id === r.listingId);
const key = ownerKeyFor(listing);
if (!key) return; // no owner set yet; left alone rather than guessed at
const share = Number(listing.sharePct);
const pct = Number.isFinite(share) ? share : 50;
const amount = Math.round(income * (pct / 100) * 100) / 100;
if (!amount) return;
data.lettingLedger.push({
id: uid(),
ownerKey: key,
kind: 'accrual',
amount,
date: r.checkout,
note: `${pct}% of ${money(income)} — ${listing.label || 'listing'}${r.guestName ? `, ${r.guestName}` : ''}`,
reservationId: r.id,
listingId: r.listingId,
});
r.accruedAt = new Date().toISOString();
added += 1;
});
if (added) queueSave();
return { added };
}

function money(n) {
const v = Number(n) || 0;
return `${v < 0 ? '-' : ''}£${Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ---- Rendering ------------------------------------------------------------

function renderLetting() {
// The picker is refreshed here rather than only at startup: assigning an
// owner to a listing happens on another tab, and until this ran again
// the dropdown had no one to choose and the Add button silently did
// nothing.
renderOwnerPicker();
const el = document.getElementById('letting-list');
if (!el) return;
const keys = owners();
if (!keys.length) {
el.innerHTML = '<div class="settings-note" style="margin:0;">No listing has an owner yet — set one on the Travel tab’s Airbnb settings, then enter what each stay earned.</div>';
return;
}
el.innerHTML = keys.map((key) => {
const rows = entriesFor(key).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
const bal = balanceFor(key);
return `<div class="letting-owner">
<div class="letting-head">
<span class="letting-name">${escapeHtml(ownerNameFor(key))}</span>
<span class="letting-balance${bal > 0 ? ' owes' : bal < 0 ? ' credit' : ''}">${escapeHtml(money(bal))}</span>
<span class="settings-note" style="margin:0;">${bal > 0 ? 'owed to you' : bal < 0 ? 'in credit' : 'settled'}</span>
</div>
${rows.length ? `<table class="limits-table"><tbody>${rows.map((e) => `<tr>
<td style="white-space:nowrap;">${escapeHtml(e.date || '')}</td>
<td>${escapeHtml(e.note || e.kind)}${e.kind && e.kind !== 'accrual' ? ` <span class="letting-kind ${escapeHtml(e.kind)}">${escapeHtml(e.kind)}</span>` : ''}</td>
<td style="text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;">${escapeHtml(money(e.amount))}</td>
<td style="width:1%;"><span class="del-x" data-letting-del="${escapeHtml(e.id)}" title="Remove this entry">&times;</span></td>
</tr>`).join('')}</tbody></table>` : '<div class="settings-note" style="margin:4px 0 0;">Nothing yet.</div>'}
</div>`;
}).join('');

el.querySelectorAll('[data-letting-del]').forEach((x) => {
x.addEventListener('click', () => {
const entry = (data.lettingLedger || []).find((e) => e.id === x.dataset.lettingDel);
// Deleting an accrual clears the stay's income as well as its
// already-charged stamp, so the deletion STAYS deleted. Clearing the
// stamp alone just meant the next sweep rebuilt the identical row,
// which made the × look broken; leaving the stamp instead would mark
// the stay charged with nothing to show for it, and the money would
// be unrecoverable. Clearing both puts the stay back to "earned
// something, you haven't said how much" — type a figure in and it
// charges again, leave it and it never does.
if (entry && entry.reservationId) {
const r = (data.airbnbReservations || []).find((v) => v.id === entry.reservationId);
if (r) { r.accruedAt = ''; r.income = null; }
}
data.lettingLedger = (data.lettingLedger || []).filter((e) => e.id !== x.dataset.lettingDel);
queueSave();
renderLetting();
});
});
}

function initLetting() {
const addBtn = document.getElementById('letting-add-btn');
if (!addBtn) return; // not in this build's DOM
// "Amount" means two different things depending on the kind, and
// getting it wrong is a silent factor of two — so the box says which
// one it wants rather than leaving you to remember.
const kindEl = document.getElementById('letting-add-kind');
const amountEl = document.getElementById('letting-add-amount');
const setHint = () => {
if (!kindEl || !amountEl) return;
amountEl.placeholder = kindEl.value === 'earned' ? 'Gross takings' : 'Amount';
};
kindEl?.addEventListener('change', setHint);
setHint();
addBtn.addEventListener('click', () => {
// The placeholder changes with the kind, because "Amount" means two
// different things here and getting it wrong is a silent factor of two.
const who = document.getElementById('letting-add-owner');
const amount = Number(document.getElementById('letting-add-amount').value);
const note = (document.getElementById('letting-add-note').value || '').trim();
const status = document.getElementById('letting-add-status');
const say = (t) => { if (status) status.textContent = t; };
if (!who.value) { say('Pick who it is for.'); return; }
if (!Number.isFinite(amount) || !amount) { say('Give an amount — negative for a payment to you.'); return; }
// Chosen, not inferred from the sign. A negative used to mean "paid",
// which recorded writing £50 off as £50 received — right arithmetic,
// false history, and the balance alone can never tell the two apart
// afterwards.
const kind = (document.getElementById('letting-add-kind') || {}).value || 'payment';
// "Earned" takes the GROSS figure and applies their share, so seeding
// what a listing took before any of this existed works exactly like a
// stay does. Entering the owed half directly is what Adjustment is for;
// having both means you can use whichever number you actually have to
// hand, rather than doing the arithmetic yourself and leaving a row that
// doesn't say what it came from.
const pct = sharePctFor(who.value);
const signed = kind === 'earned'
? Math.round(amount * (pct / 100) * 100) / 100
: Math.round(amount * 100) / 100;
if (!signed) { say('That works out as nothing — check the amount.'); return; }
data.lettingLedger.push({
id: uid(),
ownerKey: who.value,
kind,
amount: signed,
date: today(),
note: note || (kind === 'earned'
? `${pct}% of ${money(amount)} — earned before tracking`
: kind === 'payment' ? (amount < 0 ? 'Paid' : 'Owed more') : 'Adjustment'),
});
queueSave();
document.getElementById('letting-add-amount').value = '';
document.getElementById('letting-add-note').value = '';
say(`Added ${money(amount)} for ${ownerNameFor(who.value)}.`);
renderOwnerPicker();
renderLetting();
});
renderOwnerPicker();
renderLetting();
}

function renderOwnerPicker() {
const sel = document.getElementById('letting-add-owner');
if (!sel) return;
const keep = sel.value;
sel.innerHTML = `<option value="">Who…</option>${owners().map((k) => `<option value="${escapeHtml(k)}">${escapeHtml(ownerNameFor(k))}</option>`).join('')}`;
if (keep) sel.value = keep;
}

export { accrueLettings, renderLetting, initLetting, totalOwed, balanceFor, owners, ownerNameFor, ownerKeyFor, sharePctFor, money };
