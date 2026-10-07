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
<div class="settings-note" style="margin:0 0 4px;"><strong>By tax year</strong>${noSettings ? ' — no rate/allowance set for them yet in <span class="inline-goto-link" data-goto-tab="settings" data-goto-target="#letting-tax-settings">Settings</span> (showing revenue only).' : ` (${ratePct}% over ${escapeHtml(money(allowance))} allowance)`}</div>
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
// Independent of whether any owner is set yet -- the chart reads income
// straight off the listings/reservations, not the owed-ledger below it.
renderLettingChart();
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
initLettingChart();
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

// ---- Income chart: rolling months, stacked by listing --------------------
//
// Canvas, not SVG -- matches healthchart.js, the one other chart in this
// codebase (no charting library anywhere, same no-build-step pattern).
// resolveColor() is duplicated rather than shared, same as healthchart.js's
// own copy -- a two-line CSS-var reader isn't worth a shared module for.
//
// The window is fixed at 15 months ending on the current month (the
// "rolling past" span) plus 6 months after it (the "forward" span) -- 21
// months total, not user-adjustable, since this chart's whole point is a
// standing at-a-glance view, not an explorable range picker like Health's.
const DAY_MS = 24 * 60 * 60 * 1000;
const LETTING_CHART_MONTHS_BACK = 14; // + the current month itself = 15
const LETTING_CHART_MONTHS_FORWARD = 6;
// An "Earned (historic)" ledger row dated further back than the default
// window is allowed to widen it -- see lettingChartData() -- but never
// past this floor. Fixed to a real calendar month rather than "N months
// before whatever today happens to be": this is the actual earliest
// pre-tracking figure worth showing, not a rolling lookback, so it
// shouldn't quietly drift as "today" moves forward.
const LETTING_CHART_HISTORIC_FLOOR = '2026-01';

// £2,700pcm / £1,700pcm are flat targets regardless of days-in-month --
// "per calendar month" means the same number every month, not pro-rated
// for a 28 vs 31 day month.
const LETTING_TARGETS = [
{ key: 'aggressive', amount: 2700, label: 'Aggressive', colorVar: '--red' },
{ key: 'normal', amount: 1700, label: 'Normal', colorVar: '--slate' },
];

// Mirrors .dot.X{background:var(--Y)} in style.css exactly (green is the
// one name that maps to a DIFFERENT var, --sage) -- a listing's `colour`
// field is one of these names, not a CSS var name itself, so resolving it
// needs this same table rather than guessing `--${colour}` always exists.
const LETTING_COLOR_VAR = { sage: '--sage', slate: '--slate', amber: '--amber', rose: '--rose', teal: '--teal', plum: '--plum', red: '--red', green: '--sage', blue: '--blue', pink: '--pink' };
function listingColorVar(colour) { return LETTING_COLOR_VAR[colour] || '--slate'; }

function resolveColor(varName) {
return getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || '#8A8579';
}

function addMonths(ym, n) {
const [y, m] = ym.split('-').map(Number);
const total = y * 12 + (m - 1) + n;
const ny = Math.floor(total / 12);
const nm = ((total % 12) + 12) % 12;
return `${ny}-${String(nm + 1).padStart(2, '0')}`;
}

function monthLabel(ym) {
const [y, m] = ym.split('-').map(Number);
return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
}

function currentMonthYm() {
const now = new Date();
return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function monthRange(startYm, endYm) {
const months = [];
let ym = startYm;
while (ym <= endYm) { months.push(ym); ym = addMonths(ym, 1); }
return months;
}

// "My share" only halves what's actually shared -- a listing with a real
// owner (Lewis, Zara) owes them sharePct of its takings, so my own cut is
// the rest; a listing with no owner at all is entirely mine already, so
// nothing is owed away and the toggle should leave it at 100%. Confirmed
// live: the first version of this toggle applied a blanket 50% to every
// bar, which was wrong for exactly the no-owner (my own) listing.
function myShareMult(listing) {
if (!ownerKeyFor(listing)) return 1;
const pct = Number(listing.sharePct);
return Math.max(0, 1 - (Number.isFinite(pct) ? pct : 50) / 100);
}

// A stay spanning a month boundary splits its income by NIGHTS in each
// month, not by a flat half-and-half -- a 1-night-in-August/29-nights-in-
// September stay should land almost entirely in September. checkout is
// exclusive (the turnover day, same convention as everywhere else this app
// reads a reservation), so the loop stops the day before it.
function nightsByMonth(checkin, checkout) {
const start = new Date(`${checkin}T00:00:00`);
const end = new Date(`${checkout}T00:00:00`);
const counts = new Map();
let total = 0;
for (let t = start.getTime(); t < end.getTime(); t += DAY_MS) {
const d = new Date(t);
const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
counts.set(ym, (counts.get(ym) || 0) + 1);
total += 1;
}
return { counts, total };
}

// One Map per listing, ym -> allocated income, built fresh from
// data.airbnbReservations every render -- same "derive it, don't store it"
// rule the owed/gross totals above already follow, so a stay edited after
// the fact (income corrected, dates fixed) is reflected immediately with
// nothing to go stale.
function lettingChartData() {
const current = currentMonthYm();
const baseStart = addMonths(current, -LETTING_CHART_MONTHS_BACK);
const endYm = addMonths(current, LETTING_CHART_MONTHS_FORWARD);
const baseMonthSet = new Set(monthRange(baseStart, endYm));

const listings = (data.airbnbListings || []).slice();
const perListingByMonth = new Map();
listings.forEach((l) => perListingByMonth.set(l.id, new Map()));
const addAmount = (listingId, ym, amount) => {
const byMonth = perListingByMonth.get(listingId);
if (byMonth) byMonth.set(ym, (byMonth.get(ym) || 0) + amount);
};

(data.airbnbReservations || []).forEach((r) => {
const income = Number(r.income);
if (!Number.isFinite(income) || income <= 0) return;
if (!r.checkin || !r.checkout || r.checkout <= r.checkin) return;
if (!perListingByMonth.has(r.listingId)) return; // listing deleted, or never assigned -- nothing to attribute this to
const { counts, total } = nightsByMonth(r.checkin, r.checkout);
if (!total) return;
counts.forEach((nights, ym) => { if (baseMonthSet.has(ym)) addAmount(r.listingId, ym, income * (nights / total)); });
});

// "Earned (historic)" ledger rows -- pre-tracking income typed in by
// hand (initLetting()'s add-row, kind 'earned'). Deliberately excludes
// 'accrual' (already counted above, since every accrual mirrors a
// reservation's own income) and 'payment'/'adjustment' (balance moves,
// not income). A hand-added row carries no listingId, only an ownerKey,
// so it's attributed to whichever listing that owner currently has --
// same one-owner-one-listing assumption balanceFor/grossFor already
// make elsewhere in this file. Allowed to widen the window backward so a
// figure logged for an earlier month isn't silently dropped off the left
// edge just because it predates the default span -- but never earlier
// than LETTING_CHART_HISTORIC_FLOOR; anything before that is excluded
// entirely rather than bunched into the floor month, which would
// misrepresent which month it was actually earned in.
let startYm = baseStart;
(data.lettingLedger || []).forEach((e) => {
if (e.kind !== 'earned' || !e.gross || !e.date) return;
const listing = listings.find((l) => ownerKeyFor(l) === e.ownerKey);
if (!listing) return;
const ym = e.date.slice(0, 7);
if (ym > endYm) return; // a future-dated "historic" entry makes no sense -- ignore rather than extend forward
if (ym < LETTING_CHART_HISTORIC_FLOOR) return; // older than the chart is willing to show
if (ym < startYm) startYm = ym;
addAmount(listing.id, ym, Number(e.gross));
});

const months = monthRange(startYm, endYm);
const nowIndex = months.indexOf(current);
// Only listings that actually earned something in this window plot a
// legend entry and a stack segment -- "the 3 lets" in practice, but not
// hardcoded to 3, so a 4th listing (or one retired with no recent income)
// is handled correctly either way.
const activeListings = listings.filter((l) => [...(perListingByMonth.get(l.id) || new Map()).values()].some((v) => v > 0.004));
return { months, listings: activeListings, perListingByMonth, nowIndex };
}

function money0(n) { return `£${Math.round(n).toLocaleString('en-GB')}`; }

function renderLettingChartLegend(listings) {
const el = document.getElementById('letting-chart-legend');
if (!el) return;
el.innerHTML = listings.length
? listings.map((l) => `<span class="letting-chart-legend-item"><span class="dot ${escapeHtml(l.colour || 'slate')}"></span>${escapeHtml(l.label || 'Listing')}</span>`).join('')
: '<span class="settings-note" style="margin:0;">No income recorded yet.</span>';
}

let lettingChartShareOnly = false; // not persisted -- Total is the more informative number to land on
let lettingChartHoverIndex = null;
let lettingChartLastPlot = null; // {plot, bw, months} for the pointermove handler below

function drawLettingChart(canvas, chartData) {
const { months, listings, perListingByMonth, nowIndex } = chartData;
const dpr = window.devicePixelRatio || 1;
const rect = canvas.getBoundingClientRect();
const width = Math.max(1, Math.round(rect.width));
const height = Math.max(1, Math.round(rect.height));
if (!width || !height) return; // canvas is on a hidden tab -- nothing to measure yet, see the tabshown re-render below
canvas.width = Math.round(width * dpr);
canvas.height = Math.round(height * dpr);
const ctx = canvas.getContext('2d');
ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
ctx.clearRect(0, 0, width, height);

// Target lines stay a flat 50% when toggled (per the original ask); bars
// use each listing's OWN share multiplier instead (see myShareMult) --
// a blanket 50% was wrong for a no-owner listing, which keeps 100%.
const targetMult = lettingChartShareOnly ? 0.5 : 1;
const shareMult = (l) => lettingChartShareOnly ? myShareMult(l) : 1;
const lineColor = resolveColor('--line');
const muted = resolveColor('--muted');
const ink = resolveColor('--ink');
const card = resolveColor('--card');
const paper = resolveColor('--paper');

const padLeft = 46, padRight = 10, padTop = 16, padBottom = 20;
const plot = { x: padLeft, y: padTop, w: Math.max(10, width - padLeft - padRight), h: Math.max(10, height - padTop - padBottom) };

const monthTotals = months.map((ym) => listings.reduce((n, l) => n + (perListingByMonth.get(l.id).get(ym) || 0) * shareMult(l), 0));
const targets = LETTING_TARGETS.map((t) => ({ ...t, amount: t.amount * targetMult }));
const maxVal = Math.max(...monthTotals, ...targets.map((t) => t.amount), 1) * 1.1;
const scaleY = (v) => plot.y + plot.h - (v / maxVal) * plot.h;

// Gridlines + Y labels.
ctx.strokeStyle = lineColor;
ctx.lineWidth = 1;
ctx.fillStyle = muted;
ctx.font = "10px 'Inter', sans-serif";
ctx.textAlign = 'right';
ctx.textBaseline = 'middle';
[0, 0.25, 0.5, 0.75, 1].forEach((f) => {
const y = scaleY(maxVal * f);
ctx.beginPath(); ctx.moveTo(plot.x, y); ctx.lineTo(plot.x + plot.w, y); ctx.stroke();
ctx.fillText(money0(maxVal * f), plot.x - 6, y);
});

const n = months.length;
const bw = plot.w / n;
const barW = Math.max(3, bw * 0.62);

// A faint divider between the rolling-past span and the forward one, so
// "where is now" reads at a glance rather than needing the axis labels.
// nowIndex can land anywhere once a historic entry has widened the
// window backward, so it's read from chartData rather than assumed fixed.
if (nowIndex >= 0) {
const nowX = plot.x + (nowIndex + 1) * bw;
ctx.save();
ctx.strokeStyle = muted;
ctx.setLineDash([2, 3]);
ctx.lineWidth = 1;
ctx.beginPath(); ctx.moveTo(nowX, plot.y); ctx.lineTo(nowX, plot.y + plot.h); ctx.stroke();
ctx.restore();
}

// Stacked bars -- each segment inset by 1px top/bottom for the 2px surface
// gap between fills (see the dataviz skill's mark spec), topmost segment
// per bar gets rounded top corners as its "data end".
months.forEach((ym, i) => {
const cx = plot.x + (i + 0.5) * bw;
let cumulative = 0;
const segs = listings.map((l) => ({ l, raw: (perListingByMonth.get(l.id).get(ym) || 0) * shareMult(l) })).filter((s) => s.raw > 0.004);
segs.forEach((s, segIdx) => {
const yBottom = scaleY(cumulative);
const yTop = scaleY(cumulative + s.raw);
const inset = Math.min(1, (yBottom - yTop) / 4);
const top = yTop + inset, bottom = yBottom - inset;
const h = Math.max(1, bottom - top);
ctx.fillStyle = resolveColor(listingColorVar(s.l.colour));
if (segIdx === segs.length - 1 && typeof ctx.roundRect === 'function') {
ctx.beginPath();
ctx.roundRect(cx - barW / 2, top, barW, h, [4, 4, 0, 0]);
ctx.fill();
} else {
ctx.fillRect(cx - barW / 2, top, barW, h);
}
if (h >= 15) {
ctx.fillStyle = card;
ctx.font = "600 9px 'Inter', sans-serif";
ctx.textAlign = 'center';
ctx.textBaseline = 'middle';
ctx.fillText(money0(s.raw), cx, (top + bottom) / 2);
}
cumulative += s.raw;
});
if (i === lettingChartHoverIndex) {
ctx.fillStyle = ink;
ctx.globalAlpha = 0.05;
ctx.fillRect(plot.x + i * bw, plot.y, bw, plot.h);
ctx.globalAlpha = 1;
}
});

// Target lines drawn over the bars, dashed, each labelled at its own
// height so the two don't need a shared legend entry.
targets.forEach((t) => {
const y = scaleY(t.amount);
const color = resolveColor(t.colorVar);
ctx.save();
ctx.strokeStyle = color;
ctx.setLineDash([5, 4]);
ctx.lineWidth = 1.5;
ctx.beginPath(); ctx.moveTo(plot.x, y); ctx.lineTo(plot.x + plot.w, y); ctx.stroke();
ctx.restore();
ctx.fillStyle = color;
ctx.font = "600 10px 'Inter', sans-serif";
ctx.textAlign = 'left';
ctx.textBaseline = y < plot.y + 12 ? 'top' : 'bottom';
ctx.fillText(`${t.label} ${money0(t.amount)}`, plot.x + 4, y + (y < plot.y + 12 ? 3 : -3));
});

// X-axis month labels -- a fixed, evenly-spaced set of ticks sized to the
// actual plot width (same idea as healthchart.js's timeTicks(), which
// picks ticks by POSITION rather than thinning every Nth bar). Thinning
// by bar index instead (an earlier version of this) put "always show the
// current month" on top of whichever modulo tick already landed nearby,
// clustering 2-3 labels within a few bars of each other right at the
// "now" marker -- confirmed live as the unreadable bunched text that
// bug produced. Snapping the nearest even tick onto the now-index instead
// of adding a duplicate keeps every label's neighbours predictably spaced.
ctx.fillStyle = muted;
ctx.font = "10px 'Inter', sans-serif";
ctx.textAlign = 'center';
ctx.textBaseline = 'top';
const maxLabels = Math.max(3, Math.min(n, Math.floor(plot.w / 34)));
const tickIndices = new Set();
for (let k = 0; k < maxLabels; k++) tickIndices.add(Math.round((k / (maxLabels - 1)) * (n - 1)));
if (nowIndex >= 0) {
let nearestToNow = [...tickIndices].reduce((a, b) => Math.abs(b - nowIndex) < Math.abs(a - nowIndex) ? b : a);
tickIndices.delete(nearestToNow);
tickIndices.add(nowIndex);
}
months.forEach((ym, i) => {
if (!tickIndices.has(i)) return;
ctx.fillText(monthLabel(ym), plot.x + (i + 0.5) * bw, plot.y + plot.h + 4);
});

lettingChartLastPlot = { plot, bw, months };

// Hover tooltip -- per-listing breakdown for the highlighted month, since
// a short segment's inline label may have been skipped above for lack of
// room.
if (lettingChartHoverIndex != null && months[lettingChartHoverIndex]) {
const ym = months[lettingChartHoverIndex];
const rows = listings.map((l) => ({ l, raw: (perListingByMonth.get(l.id).get(ym) || 0) * shareMult(l) })).filter((s) => s.raw > 0.004);
const total = rows.reduce((s, r) => s + r.raw, 0);
const lines = [monthLabel(ym), ...rows.map((r) => `${r.l.label || 'Listing'}: ${money0(r.raw)}`), `Total: ${money0(total)}`];
ctx.font = "10px 'Inter', sans-serif";
const boxW = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16;
const boxH = lines.length * 14 + 10;
const cx = plot.x + (lettingChartHoverIndex + 0.5) * bw;
const boxX = Math.min(Math.max(cx - boxW / 2, plot.x), plot.x + plot.w - boxW);
const boxY = plot.y + 2;
ctx.fillStyle = paper;
ctx.strokeStyle = lineColor;
ctx.fillRect(boxX, boxY, boxW, boxH);
ctx.strokeRect(boxX, boxY, boxW, boxH);
ctx.fillStyle = ink;
ctx.textAlign = 'left';
ctx.textBaseline = 'alphabetic';
lines.forEach((l, i) => ctx.fillText(l, boxX + 8, boxY + 12 + i * 14));
}
}

function renderLettingChart() {
const canvas = document.getElementById('letting-chart-canvas');
if (!canvas) return;
const chartData = lettingChartData();
renderLettingChartLegend(chartData.listings);
drawLettingChart(canvas, chartData);
}

function initLettingChart() {
const canvas = document.getElementById('letting-chart-canvas');
if (!canvas) return;
const toggle = document.getElementById('letting-chart-share-toggle');
if (toggle) {
toggle.addEventListener('change', () => { lettingChartShareOnly = toggle.checked; renderLettingChart(); });
}
canvas.addEventListener('pointermove', (evt) => {
if (!lettingChartLastPlot) return;
const r = canvas.getBoundingClientRect();
const x = evt.clientX - r.left;
const { plot, bw, months } = lettingChartLastPlot;
const i = Math.floor((x - plot.x) / bw);
lettingChartHoverIndex = (i >= 0 && i < months.length) ? i : null;
renderLettingChart();
});
canvas.addEventListener('pointerleave', () => { lettingChartHoverIndex = null; renderLettingChart(); });
// A canvas measured while its tab is hidden gets 0x0 -- re-render once the
// Finances tab is actually shown, same fix updateTabBarHeightVar (app.js)
// already uses for its own hidden-on-load measurement.
document.addEventListener('tabshown', (e) => { if (e.detail?.tab === 'finances') renderLettingChart(); });
window.addEventListener('resize', renderLettingChart);
renderLettingChart();
}

function renderOwnerPicker() {
const sel = document.getElementById('letting-add-owner');
if (!sel) return;
const keep = sel.value;
sel.innerHTML = `<option value="">Who…</option>${owners().map((k) => `<option value="${escapeHtml(k)}">${escapeHtml(ownerNameFor(k))}</option>`).join('')}`;
if (keep) sel.value = keep;
}

export { accrueLettings, renderLetting, initLetting, totalOwed, totalGross, balanceFor, grossFor, owners, ownerNameFor, ownerKeyFor, sharePctFor, money };
