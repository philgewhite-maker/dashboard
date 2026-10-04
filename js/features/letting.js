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

// What the listing has taken, as opposed to what is owed on it. Two
// different questions — "how is the flat doing" and "what do they owe me"
// — and keeping the gross as a field is what makes the first answerable
// at all.
function grossFor(key) {
return entriesFor(key).reduce((n, e) => n + (Number(e.gross) || 0), 0);
}

// Every owner who has a listing or a ledger entry, so somebody who has
// paid up and has no listing this season doesn't vanish mid-settlement.
function owners() {
const keys = new Set();
(data.airbnbListings || []).forEach((l) => { const k = ownerKeyFor(l); if (k) keys.add(k); });
(data.lettingLedger || []).forEach((e) => { if (e.ownerKey) keys.add(e.ownerKey); });
return [...keys];
}

function totalGross() {
return owners().reduce((n, k) => n + grossFor(k), 0);
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
// The gross and the rate are kept as FIELDS, not just inside the note.
// A note is a sentence for you to read; a number you might ever want to
// total has to survive without being parsed back out of English.
gross: income,
pct,
date: r.checkout,
// The gross is on the entry as a field, so the note is free to be what
// it should be: which stay it was. No more repeating a number that now
// renders beside it.
note: `${listing.label || 'listing'}${r.guestName ? `, ${r.guestName}` : ''}`,
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

// ---- Tax by tax year --------------------------------------------------
//
// A stay's `date` defaults to its checkout (accrueLettings, above), but
// what actually matters for tax is the day Airbnb PAYS OUT, which can
// land on the other side of the 6 April boundary from checkout -- hence
// the date being editable in the ledger table below, retrospectively,
// once the real payout date is known.
//
// UK tax year: 6 April to 5 April. A date on or after 6 April belongs to
// the tax year starting that same calendar year; a date in Jan/Feb/Mar
// or the first 5 days of April belongs to the one that started the
// PREVIOUS calendar year. Fixed by HMRC -- not a setting to capture,
// unlike the per-owner rate/allowance below.
function taxYearFor(dateStr) {
if (!dateStr) return '';
const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
if (!m) return '';
const [, yStr, moStr, dStr] = m;
const y = Number(yStr), mo = Number(moStr), d = Number(dStr);
const startYear = (mo > 4 || (mo === 4 && d >= 6)) ? y : y - 1;
return `${startYear}/${String(startYear + 1).slice(2)}`;
}

function taxSettingsFor(key) {
const t = (data.prefs.lettingTaxByOwner || {})[key];
return { ratePct: Number(t?.ratePct) || 0, allowance: Number(t?.allowance) || 0 };
}

// Only entries that are real INCOME (accrual/earned, both of which carry
// a `gross` field) count toward revenue -- a payment or adjustment moves
// the balance without being new money earned, and would double-count
// against the same stay's accrual if included here too.
function taxYearSummaryFor(key) {
const { ratePct, allowance } = taxSettingsFor(key);
const byYear = new Map();
entriesFor(key).forEach((e) => {
if (!e.gross || !e.date) return;
const ty = taxYearFor(e.date);
if (!ty) return;
byYear.set(ty, (byYear.get(ty) || 0) + Number(e.gross));
});
return [...byYear.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([taxYear, revenueRaw]) => {
const revenue = Math.round(revenueRaw * 100) / 100;
const excess = Math.max(0, Math.round((revenue - allowance) * 100) / 100);
const tax = Math.round(excess * (ratePct / 100) * 100) / 100;
return { taxYear, revenue, allowance, excess, ratePct, tax, net: Math.round((revenue - tax) * 100) / 100 };
});
}

// Replaces the single lifetime "£x taken" figure with one row per tax
// year it was actually earned in -- grouped by each entry's own `date`
// (editable above), not by when the ledger row happened to be created.
function taxYearSummaryHtml(key, taxYears) {
if (!taxYears.length) return '';
const { ratePct, allowance } = taxSettingsFor(key);
const noSettings = !ratePct && !allowance;
return `<div class="letting-tax" style="margin-top:8px;">
<div class="settings-note" style="margin:0 0 4px;"><strong>By tax year</strong>${noSettings ? ' — no rate/allowance set for them yet in Settings &rarr; Travel &rarr; Letting tax (showing revenue only).' : ` (${ratePct}% over ${escapeHtml(money(allowance))} allowance)`}</div>
<table class="limits-table"><tbody>
<tr><th>Tax year</th><th style="text-align:right;">Revenue</th><th style="text-align:right;">Excess</th><th style="text-align:right;">Tax due</th><th style="text-align:right;">Net</th></tr>
${taxYears.map((t) => `<tr>
<td>${escapeHtml(t.taxYear)}</td>
<td style="text-align:right;font-variant-numeric:tabular-nums;">${escapeHtml(money(t.revenue))}</td>
<td style="text-align:right;font-variant-numeric:tabular-nums;">${escapeHtml(money(t.excess))}</td>
<td style="text-align:right;font-variant-numeric:tabular-nums;">${escapeHtml(money(t.tax))}</td>
<td style="text-align:right;font-variant-numeric:tabular-nums;font-weight:600;">${escapeHtml(money(t.net))}</td>
</tr>`).join('')}
</tbody></table>
</div>`;
}

// ---- Rendering ------------------------------------------------------------

function renderLetting() {
// The picker (and the tax-settings rows) are refreshed here rather than
// only at startup: assigning an owner to a listing happens on another
// tab, and until this ran again the dropdown had no one to choose and
// the Add button silently did nothing.
renderOwnerPicker();
renderLettingTaxSettings();
const el = document.getElementById('letting-list');
if (!el) return;
const keys = owners();
if (!keys.length) {
el.innerHTML = '<div class="settings-note" style="margin:0;">No listing has an owner yet — set one on the Travel tab’s Airbnb settings, then enter what each stay earned.</div>';
return;
}
// The two totals the Finances panel exists to show: what the listings
// have taken, and what of that is still owed to you. The second is not
// derivable from the first — payments and write-offs move it — which is
// the whole reason both are kept.
const badge = document.getElementById('letting-total');
if (badge) {
badge.textContent = totalGross()
? `${money(totalOwed())} owed of ${money(totalGross())} taken`
: `${money(totalOwed())} owed`;
}
el.innerHTML = keys.map((key) => {
const rows = entriesFor(key).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
const bal = balanceFor(key);
const taxYears = taxYearSummaryFor(key);
return `<div class="letting-owner">
<div class="letting-head">
<span class="letting-name">${escapeHtml(ownerNameFor(key))}</span>
<span class="letting-balance${bal > 0 ? ' owes' : bal < 0 ? ' credit' : ''}">${escapeHtml(money(bal))}</span>
<span class="settings-note" style="margin:0;">${bal > 0 ? 'owed to you' : bal < 0 ? 'in credit' : 'settled'}</span>
${grossFor(key) ? `<span class="settings-note" style="margin:0 0 0 auto;">${escapeHtml(money(grossFor(key)))} taken</span>` : ''}
</div>
${rows.length ? `<div class="letting-scroll"><table class="limits-table"><tbody>${rows.map((e) => `<tr>
<td style="white-space:nowrap;"><input type="date" class="settings-input" style="max-width:130px;" data-letting-date="${escapeHtml(e.id)}" value="${escapeHtml(e.date || '')}" title="Edit retrospectively to the real Airbnb payout date, if it differs from checkout -- this is what tax-year grouping below uses."></td>
<td>${escapeHtml(e.note || e.kind)}${e.kind && e.kind !== 'accrual' ? ` <span class="letting-kind ${escapeHtml(e.kind)}">${escapeHtml(e.kind)}</span>` : ''}${
// Shown from the FIELD rather than left inside the note, because your
// own note replaces the default one — type "Bathilde" and the £419 it
// was half of disappeared from the record entirely.
e.gross ? ` <span class="letting-gross">${escapeHtml(`${e.pct ?? 50}% of ${money(e.gross)}`)}</span>` : ''}</td>
<td style="text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;">${escapeHtml(money(e.amount))}</td>
<td style="width:1%;"><span class="del-x" data-letting-del="${escapeHtml(e.id)}" title="Remove this entry">&times;</span></td>
</tr>`).join('')}</tbody></table></div>` : '<div class="settings-note" style="margin:4px 0 0;">Nothing yet.</div>'}
${taxYearSummaryHtml(key, taxYears)}
</div>`;
}).join('');

el.querySelectorAll('[data-letting-date]').forEach((input) => {
input.addEventListener('change', () => {
const entry = (data.lettingLedger || []).find((e) => e.id === input.dataset.lettingDate);
if (!entry || !input.value) return;
entry.date = input.value;
queueSave();
renderLetting();
});
});
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
// Only "earned" has a gross behind it — a payment or an adjustment IS
// its own figure. Recorded the same way as an accrual's so the two
// sources of earnings add up together.
...(kind === 'earned' ? { gross: Math.round(amount * 100) / 100, pct } : {}),
date: today(),
note: note || (kind === 'earned'
? `Earned before tracking`
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
initLettingTaxSettings();
renderLetting();
}

// ---- Tax settings (Settings -> Travel) --------------------------------

function lettingTaxRowHtml(key) {
const { ratePct, allowance } = taxSettingsFor(key);
return `<div class="sync-row" data-letting-tax-row="${escapeHtml(key)}" style="margin-bottom:4px;">
<span style="flex:1;min-width:0;">${escapeHtml(ownerNameFor(key))}</span>
<label style="font-size:12px;display:flex;align-items:center;gap:4px;">Rate <input type="number" min="0" max="100" step="1" class="settings-input" style="max-width:60px;" data-letting-tax-rate="${escapeHtml(key)}" value="${ratePct || ''}">%</label>
<label style="font-size:12px;display:flex;align-items:center;gap:4px;">Allowance £<input type="number" min="0" step="1" class="settings-input" style="max-width:90px;" data-letting-tax-allowance="${escapeHtml(key)}" value="${allowance || ''}"></label>
<span class="del-x" data-letting-tax-remove="${escapeHtml(key)}" title="Remove this row">&times;</span>
</div>`;
}

// Every current owner, PLUS anyone already given a rate/allowance even if
// they don't (yet) own a listing -- so a rate can be set up ahead of
// someone ever appearing in owners() themselves, via the free-text Add
// row below.
function lettingTaxKeys() {
return [...new Set([...owners(), ...Object.keys(data.prefs.lettingTaxByOwner || {})])];
}

function renderLettingTaxSettings() {
const el = document.getElementById('letting-tax-settings');
if (!el) return;
const keys = lettingTaxKeys();
el.innerHTML = keys.length
? keys.map(lettingTaxRowHtml).join('')
: '<div class="settings-note" style="margin:0;">No letting owners yet — add one below, or set an Airbnb listing owner first.</div>';
el.querySelectorAll('[data-letting-tax-rate]').forEach((input) => {
input.addEventListener('change', () => {
const key = input.dataset.lettingTaxRate;
const t = data.prefs.lettingTaxByOwner[key] || (data.prefs.lettingTaxByOwner[key] = {});
t.ratePct = Number(input.value) || 0;
queueSave();
renderLetting();
});
});
el.querySelectorAll('[data-letting-tax-allowance]').forEach((input) => {
input.addEventListener('change', () => {
const key = input.dataset.lettingTaxAllowance;
const t = data.prefs.lettingTaxByOwner[key] || (data.prefs.lettingTaxByOwner[key] = {});
t.allowance = Number(input.value) || 0;
queueSave();
renderLetting();
});
});
el.querySelectorAll('[data-letting-tax-remove]').forEach((x) => {
x.addEventListener('click', () => {
delete data.prefs.lettingTaxByOwner[x.dataset.lettingTaxRemove];
queueSave();
renderLettingTaxSettings();
renderLetting();
});
});
}

function initLettingTaxSettings() {
const addBtn = document.getElementById('letting-tax-add-btn');
const nameInput = document.getElementById('letting-tax-add-name');
if (addBtn && nameInput) {
addBtn.addEventListener('click', () => {
const name = nameInput.value.trim();
if (!name) return;
// Same lowercased-typed-name key convention as ownerKeyFor's own
// fallback (airbnb.js's ownerLabel) -- so this row lines up with that
// same person's real owner key the moment they're given a listing,
// rather than needing to be re-entered.
const key = name.toLowerCase();
if (!data.prefs.lettingTaxByOwner[key]) data.prefs.lettingTaxByOwner[key] = { ratePct: 0, allowance: 0 };
queueSave();
nameInput.value = '';
renderLettingTaxSettings();
});
}
renderLettingTaxSettings();
}

function renderOwnerPicker() {
const sel = document.getElementById('letting-add-owner');
if (!sel) return;
const keep = sel.value;
sel.innerHTML = `<option value="">Who…</option>${owners().map((k) => `<option value="${escapeHtml(k)}">${escapeHtml(ownerNameFor(k))}</option>`).join('')}`;
if (keep) sel.value = keep;
}

export { accrueLettings, renderLetting, initLetting, totalOwed, totalGross, balanceFor, grossFor, owners, ownerNameFor, ownerKeyFor, sharePctFor, money };
