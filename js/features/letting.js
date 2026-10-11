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
// Copied at accrual time, same as gross/pct -- the ledger row is the
// thing taxYearSummaryFor() and the chart actually read, not the
// reservation, so this needs to be a field here too, not just on `r`.
platform: r.platform === 'other' ? 'other' : 'airbnb',
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
const byYear = new Map(); // ty -> { total, airbnb, other }
entriesFor(key).forEach((e) => {
if (!e.gross || !e.date) return;
const ty = taxYearFor(e.date);
if (!ty) return;
const bucket = byYear.get(ty) || { total: 0, airbnb: 0, other: 0 };
bucket.total += Number(e.gross);
bucket[e.platform === 'other' ? 'other' : 'airbnb'] += Number(e.gross);
byYear.set(ty, bucket);
});
return [...byYear.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([taxYear, bucket]) => {
const revenue = Math.round(bucket.total * 100) / 100;
const excess = Math.max(0, Math.round((revenue - allowance) * 100) / 100);
const tax = Math.round(excess * (ratePct / 100) * 100) / 100;
return {
taxYear, revenue, allowance, excess, ratePct, tax, net: Math.round((revenue - tax) * 100) / 100,
airbnb: Math.round(bucket.airbnb * 100) / 100, other: Math.round(bucket.other * 100) / 100,
};
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
<td>${escapeHtml(t.taxYear)}${t.airbnb > 0.004 && t.other > 0.004 ? `<div class="settings-note" style="margin:2px 0 0;font-size:10px;">Airbnb ${escapeHtml(money(t.airbnb))} &middot; Other ${escapeHtml(money(t.other))}</div>` : ''}</td>
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
<td style="white-space:nowrap;"><input type="date" class="settings-input" style="max-width:130px;" data-letting-date="${escapeHtml(e.id)}" value="${escapeHtml(e.date || '')}" title="Edit retrospectively to the real Airbnb payout date, if it differs from checkout -- this is what tax-year grouping below uses.">${e.kind === 'earned' ? `<input type="date" class="settings-input" style="max-width:130px;margin-top:3px;" data-letting-start-date="${escapeHtml(e.id)}" value="${escapeHtml(e.startDate || '')}" title="Optional -- only if this booking ran longer than one month. When set, the chart above splits the gross across every month from here to the date on the left (same pro-rata-by-night split a real reservation's own checkin/checkout already gets), instead of landing as one spike in a single month.">` : ''}</td>
<td>${escapeHtml(e.note || e.kind)}${e.kind && e.kind !== 'accrual' ? ` <span class="letting-kind ${escapeHtml(e.kind)}">${escapeHtml(e.kind)}</span>` : ''}${
// Shown from the FIELD rather than left inside the note, because your
// own note replaces the default one — type "Bathilde" and the £419 it
// was half of disappeared from the record entirely.
e.gross ? ` <span class="letting-gross">${escapeHtml(`${e.pct ?? 50}% of ${money(e.gross)}`)}</span>` : ''}${e.kind === 'earned' ? ` <select data-letting-platform="${escapeHtml(e.id)}" title="Which platform this was actually earned through -- the chart above draws Other as a striped fill instead of solid.">
<option value="airbnb"${e.platform !== 'other' ? ' selected' : ''}>Airbnb</option>
<option value="other"${e.platform === 'other' ? ' selected' : ''}>Other</option>
</select>` : ''}</td>
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
// Empty is a valid value here (clearing it back to a single-month
// entry), unlike the payout date above which can't be blanked -- so no
// `!input.value` guard.
el.querySelectorAll('[data-letting-start-date]').forEach((input) => {
input.addEventListener('change', () => {
const entry = (data.lettingLedger || []).find((e) => e.id === input.dataset.lettingStartDate);
if (!entry) return;
entry.startDate = input.value;
queueSave();
renderLetting();
});
});
el.querySelectorAll('[data-letting-platform]').forEach((sel) => {
sel.addEventListener('change', () => {
const entry = (data.lettingLedger || []).find((e) => e.id === sel.dataset.lettingPlatform);
if (!entry) return;
entry.platform = sel.value;
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

// Two flat monthly targets per owner-group, regardless of days-in-month
// -- "per calendar month" means the same number every month, not
// pro-rated for a 28 vs 31 day month. Amounts are user-editable (see
// lettingChartTargetsFor() and the inputs renderLettingChartGroupPicker()
// builds per row) and additive across whichever groups are ticked,
// rather than one hardcoded shared pair.
const LETTING_TARGETS = [
{ key: 'aggressive', label: 'Aggressive', colorVar: '--red' },
{ key: 'normal', label: 'Normal', colorVar: '--slate' },
];
// The bucket every listing's OWNER's own cut, plus Phil's balance from
// every other owner's listing, lands in -- see splitContribution().
const LETTING_CHART_MINE_KEY = '__mine__';

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

// A listing's Owner is either me (an unowned listing counts as mine too)
// or someone else (Lewis, Zara) with their own sharePct cut -- confirmed
// against the real listings (Settings -> Travel -> Airbnb listings):
// "En-suite - Phil" / "Flat" both have Owner "Phil", sharePct 100
// (the owner -- me -- keeps it all); "En-suite - Lewis" / "Double -
// Zara" have sharePct 50 (THEIR cut). So every pound a listing earns
// splits into at most two buckets: the owner's own cut (Lewis'/Zara's,
// nothing for a listing that's mine already) and MY balance -- what's
// left once their cut is taken, which is the whole amount for a listing
// I own outright. This is what the chart's multi-select picks between
// (Mine / Lewis' / Zara's / ...), not a single blanket percentage.
function isMyOwnListing(listing) {
const key = ownerKeyFor(listing);
return !key || /^phil$/i.test(String(ownerNameFor(key) || '').trim());
}
function splitContribution(listing, amount) {
if (isMyOwnListing(listing)) return [{ group: LETTING_CHART_MINE_KEY, amount }];
const pct = Number(listing.sharePct);
const sharePct = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 50));
const ownCut = amount * (sharePct / 100);
const balance = amount - ownCut;
const out = [{ group: ownerKeyFor(listing), amount: ownCut }];
if (balance > 0) out.push({ group: LETTING_CHART_MINE_KEY, amount: balance });
return out;
}

// Every group that could show a bar segment: "Mine" always exists (even
// with nothing in it yet), plus one per other real owner found across
// the listings -- built fresh each render so a newly-added owner shows
// up without needing its own setup step. Each group's colour comes from
// one of its own listings (the first found), so the chart's colours stay
// tied to the same per-listing `colour` field used everywhere else in
// this app rather than a separately-assigned palette.
function lettingChartGroups() {
const listings = data.airbnbListings || [];
const groups = new Map();
const mineListing = listings.find(isMyOwnListing);
groups.set(LETTING_CHART_MINE_KEY, { key: LETTING_CHART_MINE_KEY, label: 'Mine', colour: (mineListing && mineListing.colour) || 'slate' });
listings.forEach((l) => {
if (isMyOwnListing(l)) return;
const key = ownerKeyFor(l);
if (!groups.has(key)) groups.set(key, { key, label: `${ownerNameFor(key)}'s`, colour: l.colour || 'slate' });
});
return groups;
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

// One Map per group (Mine / Lewis' / Zara's / ...), ym -> allocated
// income, built fresh from data.airbnbReservations every render -- same
// "derive it, don't store it" rule the owed/gross totals above already
// follow, so a stay edited after the fact (income corrected, dates
// fixed) is reflected immediately with nothing to go stale. Each
// reservation/ledger amount is split via splitContribution() BEFORE being
// added, so e.g. Lewis' listing's income always lands partly in his own
// group and partly in Mine, regardless of which groups the multi-select
// currently has ticked -- the split itself isn't a display filter, it's
// just where the money actually goes.
function lettingChartData() {
const current = currentMonthYm();
const baseStart = addMonths(current, -LETTING_CHART_MONTHS_BACK);
const endYm = addMonths(current, LETTING_CHART_MONTHS_FORWARD);
const baseMonthSet = new Set(monthRange(baseStart, endYm));

const groupMeta = lettingChartGroups();
const perGroupByMonth = new Map();
groupMeta.forEach((g) => perGroupByMonth.set(g.key, new Map()));
const addAmount = (groupKey, ym, amount) => {
const byMonth = perGroupByMonth.get(groupKey);
if (byMonth) byMonth.set(ym, (byMonth.get(ym) || 0) + amount);
};
// Parallel to perGroupByMonth, split further by platform -- which
// listing.colour draws solid vs striped (drawLettingChart) and what the
// hover tooltip's per-group sub-line shows. Kept separate from
// perGroupByMonth itself (rather than changing that map's value shape)
// so the axis/rolling-average/total math above is untouched.
const perGroupByMonthPlatform = new Map();
groupMeta.forEach((g) => perGroupByMonthPlatform.set(g.key, new Map()));
const addAmountPlatform = (groupKey, ym, platform, amount) => {
const byMonth = perGroupByMonthPlatform.get(groupKey);
if (!byMonth) return;
const bucket = byMonth.get(ym) || { airbnb: 0, other: 0 };
bucket[platform === 'other' ? 'other' : 'airbnb'] += amount;
byMonth.set(ym, bucket);
};

const listings = data.airbnbListings || [];
const listingById = new Map(listings.map((l) => [l.id, l]));

(data.airbnbReservations || []).forEach((r) => {
const income = Number(r.income);
if (!Number.isFinite(income) || income <= 0) return;
if (!r.checkin || !r.checkout || r.checkout <= r.checkin) return;
const listing = listingById.get(r.listingId);
if (!listing) return; // listing deleted, or never assigned -- nothing to attribute this to
const { counts, total } = nightsByMonth(r.checkin, r.checkout);
if (!total) return;
const platform = r.platform === 'other' ? 'other' : 'airbnb';
counts.forEach((nights, ym) => {
if (!baseMonthSet.has(ym)) return;
splitContribution(listing, income * (nights / total)).forEach((c) => { addAmount(c.group, ym, c.amount); addAmountPlatform(c.group, ym, platform, c.amount); });
});
});

// "Earned (historic)" ledger rows -- pre-tracking income typed in by
// hand (initLetting()'s add-row, kind 'earned'). Deliberately excludes
// 'accrual' (already counted above, since every accrual mirrors a
// reservation's own income) and 'payment'/'adjustment' (balance moves,
// not income). A hand-added row carries no listingId, only an ownerKey,
// so it's attributed to whichever listing that owner currently has --
// same one-owner-one-listing assumption balanceFor/grossFor already
// make elsewhere in this file. baseStart (the normal rolling-15-month
// start) is a real floor here, not just a default -- a historic entry
// older than that is excluded rather than widening the chart back to
// meet it, so the window stays a fixed 15 months regardless of how far
// back the ledger goes.
(data.lettingLedger || []).forEach((e) => {
if (e.kind !== 'earned' || !e.gross || !e.date) return;
const listing = listings.find((l) => ownerKeyFor(l) === e.ownerKey);
if (!listing) return;
// Optional startDate (letting-add-start-date input above): a historic
// booking that actually ran longer than one month gets split pro-rata
// by night across every month it spans, exactly like a real
// reservation's own checkin/checkout (nightsByMonth) -- otherwise the
// whole gross lands as one spike in a single month, which is what was
// blowing the chart's own scale for a multi-month let.
const platform = e.platform === 'other' ? 'other' : 'airbnb';
if (e.startDate && e.startDate < e.date) {
const { counts, total } = nightsByMonth(e.startDate, e.date);
if (!total) return;
counts.forEach((nights, ym) => {
if (!baseMonthSet.has(ym)) return;
splitContribution(listing, Number(e.gross) * (nights / total)).forEach((c) => { addAmount(c.group, ym, c.amount); addAmountPlatform(c.group, ym, platform, c.amount); });
});
return;
}
const ym = e.date.slice(0, 7);
if (ym > endYm) return; // a future-dated "historic" entry makes no sense -- ignore rather than extend forward
if (ym < baseStart) return; // older than the rolling window -- excluded, not widened in to meet it
splitContribution(listing, Number(e.gross)).forEach((c) => { addAmount(c.group, ym, c.amount); addAmountPlatform(c.group, ym, platform, c.amount); });
});

const months = monthRange(baseStart, endYm);
const nowIndex = months.indexOf(current);
// Only a group that actually has something in this window plots a
// picker row and a stack segment -- "Mine, Lewis', Zara's" in practice,
// but not hardcoded to those names, so a 4th owner (or one retired with
// no recent income) is handled correctly either way.
const activeGroups = [...groupMeta.values()].filter((g) => [...(perGroupByMonth.get(g.key) || new Map()).values()].some((v) => v > 0.004));
return { months, groups: activeGroups, perGroupByMonth, perGroupByMonthPlatform, nowIndex };
}

function money0(n) { return `£${Math.round(n).toLocaleString('en-GB')}`; }

// Reads (and, the first time, migrates) a group's own Aggressive/Normal
// targets. The old shape -- a single flat {aggressive,normal} pair for
// the whole chart, before targets were per-person -- is folded into Mine
// the first time this runs into one, since that pair was always really
// describing what I alone was aiming for. Mine falls back to the
// original 2700/1700 until something is actually set; every other group
// falls back to 0/0 -- there's no sensible default for a kid's own target
// to guess at.
function lettingChartTargetsFor(groupKey) {
const all = data.prefs.lettingChartTargets || (data.prefs.lettingChartTargets = {});
if (Number.isFinite(all.aggressive) || Number.isFinite(all.normal)) {
all[LETTING_CHART_MINE_KEY] = { aggressive: Number(all.aggressive) || 0, normal: Number(all.normal) || 0, ...(all[LETTING_CHART_MINE_KEY] || {}) };
delete all.aggressive;
delete all.normal;
queueSave();
}
if (all[groupKey]) return all[groupKey];
return groupKey === LETTING_CHART_MINE_KEY ? { aggressive: 2700, normal: 1700 } : { aggressive: 0, normal: 0 };
}

// Doubles as the multi-select: each row is a checkbox (which group to
// show), not just a colour key. `lettingChartSelectedGroups` tracks which
// are currently ticked; `lettingChartKnownGroupKeys` tracks which the
// picker has ever offered, so a group seen for the first time defaults
// to ticked (shown) without clobbering a choice the user already made on
// one they've seen before.
let lettingChartSelectedGroups = new Set();
let lettingChartKnownGroupKeys = new Set();
function syncLettingChartSelection(groups) {
groups.forEach((g) => {
if (lettingChartKnownGroupKeys.has(g.key)) return;
lettingChartKnownGroupKeys.add(g.key);
lettingChartSelectedGroups.add(g.key);
});
}

// Each row is the checkbox that includes/excludes this group from the
// stack, plus that group's OWN Aggressive/Normal target -- additive
// across whichever rows are ticked (drawLettingChart sums lettingChart
// TargetsFor() over the same filtered `groups` list the stack itself
// uses), not a single shared pair any more.
function renderLettingChartGroupPicker(groups) {
const el = document.getElementById('letting-chart-legend');
if (!el) return;
if (!groups.length) { el.innerHTML = '<span class="settings-note" style="margin:0;">No income recorded yet.</span>'; return; }
const avgSwatch = '<span class="letting-chart-legend-line" aria-hidden="true"></span>';
el.innerHTML = groups.map((g) => {
const t = lettingChartTargetsFor(g.key);
return `<div class="letting-chart-group-row">
<label class="letting-chart-legend-item" style="cursor:pointer;">
<input type="checkbox" data-letting-chart-group="${escapeHtml(g.key)}"${lettingChartSelectedGroups.has(g.key) ? ' checked' : ''}>
<span class="dot ${escapeHtml(g.colour || 'slate')}"></span>${escapeHtml(g.label)}
</label>
<span class="letting-chart-group-targets">
<label>Agg £<input type="number" min="0" step="10" class="settings-input" data-letting-chart-target="${escapeHtml(g.key)}:aggressive" value="${t.aggressive || ''}"></label>
<label>Normal £<input type="number" min="0" step="10" class="settings-input" data-letting-chart-target="${escapeHtml(g.key)}:normal" value="${t.normal || ''}"></label>
</span>
</div>`;
}).join('')
+ `<span class="letting-chart-legend-item">${avgSwatch}3-month avg</span>`;
el.querySelectorAll('[data-letting-chart-group]').forEach((cb) => {
cb.addEventListener('change', () => {
const key = cb.dataset.lettingChartGroup;
if (cb.checked) lettingChartSelectedGroups.add(key); else lettingChartSelectedGroups.delete(key);
renderLettingChart();
});
});
el.querySelectorAll('[data-letting-chart-target]').forEach((input) => {
input.addEventListener('change', () => {
const [key, field] = input.dataset.lettingChartTarget.split(':');
const all = data.prefs.lettingChartTargets || (data.prefs.lettingChartTargets = {});
const entry = all[key] || (all[key] = { aggressive: 0, normal: 0 });
const v = Number(input.value);
entry[field] = Number.isFinite(v) && v >= 0 ? v : 0;
queueSave();
renderLettingChart();
});
});
}

let lettingChartHoverIndex = null;
let lettingChartLastPlot = null; // {plot, bw, months} for the pointermove handler below

// Nearest "nice" round number at or above roughStep -- 1/2/5 scaled to
// roughStep's own order of magnitude (...100, 200, 500, 1000, 2000,
// 5000...), so the axis always steps in round numbers regardless of
// what the underlying data's max happens to be.
function niceLettingAxisStep(roughStep) {
if (roughStep <= 0) return 100;
const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
const residual = roughStep / magnitude;
const niceResidual = residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 5 ? 5 : 10;
return niceResidual * magnitude;
}

function drawLettingChart(canvas, chartData) {
const { months, groups: allGroups, perGroupByMonth, perGroupByMonthPlatform, nowIndex } = chartData;
const groups = allGroups.filter((g) => lettingChartSelectedGroups.has(g.key));
// One 45-degree-hatch pattern per colour, built fresh each draw (colours
// can change with the theme, and a redraw already happens on every
// render/resize/hover, so there's nothing stale to cache across calls).
// Three parallel diagonals offset by a full tile width is the standard
// trick for a seamless repeat -- without it, the hatch visibly seams at
// every tile boundary.
const stripeCache = new Map();
function stripePatternFor(color) {
if (stripeCache.has(color)) return stripeCache.get(color);
const size = 8;
const tile = document.createElement('canvas');
tile.width = size; tile.height = size;
const tctx = tile.getContext('2d');
tctx.fillStyle = color;
tctx.globalAlpha = 0.22;
tctx.fillRect(0, 0, size, size);
tctx.globalAlpha = 1;
tctx.strokeStyle = color;
tctx.lineWidth = 2.2;
[-size, 0, size].forEach((o) => {
tctx.beginPath();
tctx.moveTo(o, size);
tctx.lineTo(o + size, 0);
tctx.stroke();
});
const pattern = ctx.createPattern(tile, 'repeat');
stripeCache.set(color, pattern);
return pattern;
}
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

const lineColor = resolveColor('--line');
const muted = resolveColor('--muted');
const ink = resolveColor('--ink');
const card = resolveColor('--card');
const paper = resolveColor('--paper');

const padLeft = 46, padRight = 10, padTop = 16, padBottom = 20;
const plot = { x: padLeft, y: padTop, w: Math.max(10, width - padLeft - padRight), h: Math.max(10, height - padTop - padBottom) };

const monthTotals = months.map((ym) => groups.reduce((n, g) => n + (perGroupByMonth.get(g.key).get(ym) || 0), 0));
// Each visible group's own target, summed -- additive across whichever
// rows are ticked, same `groups` (already filtered by selection) the
// stack itself sums over, so the two stay comparable: tick just Lewis'
// and the lines show only his target, tick everyone and they show the
// combined one.
const targets = LETTING_TARGETS.map((t) => ({ ...t, amount: groups.reduce((n, g) => n + (Number(lettingChartTargetsFor(g.key)[t.key]) || 0), 0) }));
const rawMax = Math.max(...monthTotals, ...targets.map((t) => t.amount), 1);
// A round step (500, 1000, 2000, 5000...) rather than an arbitrary
// fraction of whatever the data's own max happens to be -- a classic
// 1-2-5 "nice numbers" sequence scaled to the data's own order of
// magnitude, same idea any charting library's own axis uses.
const axisStep = niceLettingAxisStep(rawMax / 4);
// floor()+1, not ceil(): guarantees at least one full step of headroom
// above the highest bar/target even when rawMax is itself an exact
// multiple of axisStep (ceil alone would let the top bar touch the very
// top gridline with nothing above it).
const axisSteps = Math.floor(rawMax / axisStep) + 1;
const maxVal = axisSteps * axisStep;
const scaleY = (v) => plot.y + plot.h - (v / maxVal) * plot.h;

// Gridlines + Y labels, one per round step.
ctx.strokeStyle = lineColor;
ctx.lineWidth = 1;
ctx.fillStyle = muted;
ctx.font = "10px 'Inter', sans-serif";
ctx.textAlign = 'right';
ctx.textBaseline = 'middle';
for (let i = 0; i <= axisSteps; i++) {
const v = i * axisStep;
const y = scaleY(v);
ctx.beginPath(); ctx.moveTo(plot.x, y); ctx.lineTo(plot.x + plot.w, y); ctx.stroke();
ctx.fillText(money0(v), plot.x - 6, y);
}

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
const segs = groups.map((g) => ({ g, raw: perGroupByMonth.get(g.key).get(ym) || 0, platform: perGroupByMonthPlatform.get(g.key).get(ym) || { airbnb: 0, other: 0 } })).filter((s) => s.raw > 0.004);
segs.forEach((s, segIdx) => {
const color = resolveColor(listingColorVar(s.g.colour));
// Solid (Airbnb) drawn below, striped (Other) above, within this
// group's own slice of the stack -- falls back to one solid part if
// platform data is missing entirely (shouldn't happen once every
// contributor sets `platform`, but a safe default beats a blank gap).
const rawParts = [{ amt: s.platform.airbnb, striped: false }, { amt: s.platform.other, striped: true }].filter((p) => p.amt > 0.004);
const parts = rawParts.length ? rawParts : [{ amt: s.raw, striped: false }];
parts.forEach((p, pIdx) => {
const yBottom = scaleY(cumulative);
const yTop = scaleY(cumulative + p.amt);
const inset = Math.min(1, (yBottom - yTop) / 4);
const top = yTop + inset, bottom = yBottom - inset;
const h = Math.max(1, bottom - top);
ctx.fillStyle = p.striped ? stripePatternFor(color) : color;
const isTopOfWholeStack = segIdx === segs.length - 1 && pIdx === parts.length - 1;
if (isTopOfWholeStack && typeof ctx.roundRect === 'function') {
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
ctx.fillText(money0(p.amt), cx, (top + bottom) / 2);
}
cumulative += p.amt;
});
});
if (i === lettingChartHoverIndex) {
ctx.fillStyle = ink;
ctx.globalAlpha = 0.05;
ctx.fillRect(plot.x + i * bw, plot.y, bw, plot.h);
ctx.globalAlpha = 1;
}
});

// 3-month rolling average -- a trailing mean of monthTotals, using
// however many of the up-to-3 preceding months actually fall in the
// window (the first couple of months have no 2-3 predecessors to
// average, same "use what's there" rule a rolling average anywhere else
// in this app would follow). Solid ink, not dashed -- it's an observed
// trend read off the bars themselves, not a fixed reference like the two
// target lines, and small dots at each point make it readable even
// where it overlaps a target line's own dashes.
ctx.save();
ctx.strokeStyle = ink;
ctx.globalAlpha = 0.55;
ctx.lineWidth = 1.75;
ctx.beginPath();
months.forEach((ym, i) => {
const windowVals = monthTotals.slice(Math.max(0, i - 2), i + 1);
const avg = windowVals.reduce((s, v) => s + v, 0) / windowVals.length;
const x = plot.x + (i + 0.5) * bw;
const y = scaleY(avg);
if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
});
ctx.stroke();
ctx.globalAlpha = 1;
ctx.fillStyle = ink;
months.forEach((ym, i) => {
const windowVals = monthTotals.slice(Math.max(0, i - 2), i + 1);
const avg = windowVals.reduce((s, v) => s + v, 0) / windowVals.length;
ctx.beginPath();
ctx.arc(plot.x + (i + 0.5) * bw, scaleY(avg), 1.6, 0, Math.PI * 2);
ctx.fill();
});
ctx.restore();

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

// Hover tooltip -- per-group breakdown for the highlighted month, since
// a short segment's inline label may have been skipped above for lack of
// room.
if (lettingChartHoverIndex != null && months[lettingChartHoverIndex]) {
const ym = months[lettingChartHoverIndex];
const rows = groups.map((g) => ({ g, raw: perGroupByMonth.get(g.key).get(ym) || 0, platform: perGroupByMonthPlatform.get(g.key).get(ym) || { airbnb: 0, other: 0 } })).filter((s) => s.raw > 0.004);
const total = rows.reduce((s, r) => s + r.raw, 0);
// Same trailing-mean window the chart's own rolling-average line (above)
// already plots -- shown as a number here too, since the line alone
// doesn't say its exact value.
const avgWindow = monthTotals.slice(Math.max(0, lettingChartHoverIndex - 2), lettingChartHoverIndex + 1);
const avg = avgWindow.reduce((s, v) => s + v, 0) / avgWindow.length;
const lines = [monthLabel(ym)];
rows.forEach((r) => {
lines.push(`${r.g.label}: ${money0(r.raw)}`);
// Only when a group actually mixes both this month -- a group that's
// entirely one platform already says so via its label alone, nothing
// to break out.
if (r.platform.airbnb > 0.004 && r.platform.other > 0.004) {
lines.push(`  Airbnb ${money0(r.platform.airbnb)} · Other ${money0(r.platform.other)}`);
}
});
lines.push(`Total: ${money0(total)}`, `3-month avg: ${money0(avg)}`);
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
syncLettingChartSelection(chartData.groups);
renderLettingChartGroupPicker(chartData.groups);
drawLettingChart(canvas, chartData);
}

function initLettingChart() {
const canvas = document.getElementById('letting-chart-canvas');
if (!canvas) return;
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
