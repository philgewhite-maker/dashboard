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
import { escapeHtml, uid, logoBadgeHtml, bindLogoFallbacks } from '../utils.js';
import { matchBrandLogo } from '../brandLogos.js';

// Per-device view state, not data: which people's sections are folded away
// (remembered across visits) and which ledger rows have their detail line
// open (just for this session).
function loadCollapsedOwners() {
try { return new Set(JSON.parse(localStorage.getItem('lettingCollapsedOwners') || '[]')); } catch { return new Set(); }
}
const collapsedOwners = loadCollapsedOwners();
function saveCollapsedOwners() {
try { localStorage.setItem('lettingCollapsedOwners', JSON.stringify([...collapsedOwners])); } catch { /* storage unavailable -- the fold just won't be remembered */ }
}
const expandedLedgerRows = new Set();

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

// The share rule in effect ON a given date -- the LATEST rule whose
// fromDate has already arrived by then. A stay's split is decided by
// whatever arrangement applied when it happened/was paid out, not by
// today's rule -- a historic figure has to keep reflecting the OLD
// split even after the rule later changes, which is the whole reason
// this is a resolver rather than one flat field. Falls back to the
// listing's own plain sharePct when there's no shareRules entry yet
// (the common, never-changed case) -- so a listing on a flat split
// never needs a rule added just to keep working.
function shareRuleAt(listing, dateStr) {
if (!listing) return { pct: 50, capAmount: null };
const rules = (listing.shareRules || []).filter((r) => r.fromDate && r.fromDate <= dateStr).sort((a, b) => b.fromDate.localeCompare(a.fromDate));
if (rules[0]) {
const pct = Number(rules[0].pct);
const cap = Number(rules[0].capAmount);
return { pct: Number.isFinite(pct) ? pct : 50, capAmount: Number.isFinite(cap) ? cap : null };
}
const pct = Number(listing.sharePct);
return { pct: Number.isFinite(pct) ? pct : 50, capAmount: null };
}

// Applies both the percentage AND the cap in one place -- "the smaller
// of 50% or £800/month" means Math.min(gross * pct/100, capAmount),
// not just the raw percentage -- so every caller gets the real owed
// figure without re-deriving the cap logic itself.
function splitAmountFor(listing, gross, dateStr) {
const rule = shareRuleAt(listing, dateStr);
const uncapped = Number(gross) * (rule.pct / 100);
return rule.capAmount != null ? Math.min(uncapped, rule.capAmount) : uncapped;
}

// Their share, taken from whichever listing they own, as of today --
// used by the manual add-row's own pct display and anywhere else that
// genuinely means "the CURRENT rate", not a specific past date's.
// Falls back to 50 rather than refusing: the number is on the listing,
// and a historic figure may well be entered before the listing is set
// up.
function sharePctFor(key) {
const listing = (data.airbnbListings || []).find((l) => ownerKeyFor(l) === key);
return shareRuleAt(listing, today()).pct;
}

// A refund's own note is the first name Airbnb's email carries ("Eduardo"),
// while the stay it relates to is recorded under the full booker name
// ("Eduardo Martinez Escalante"). Shown under the fuller name when a
// nearby entry for the same owner has it, so the two read as one person.
function ledgerNoteFor(e) {
const note = String(e.note || '').trim();
if (e.kind !== 'refund' || !note) return e.note || e.kind;
const lower = note.toLowerCase();
const when = new Date(`${e.date}T00:00:00`).getTime();
const full = (data.lettingLedger || [])
.filter((x) => x.ownerKey === e.ownerKey && x.kind !== 'refund' && x.date && Math.abs(new Date(`${x.date}T00:00:00`).getTime() - when) <= 45 * 86400000)
.map((x) => { const parts = String(x.note || '').split(', '); return (parts.length > 1 ? parts.slice(1).join(', ') : parts[0]).trim(); })
.find((g) => g.length > note.length && g.toLowerCase().startsWith(`${lower} `));
return full || note;
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
// Excludes a self-resolving key -- unlike totalGross() just above,
// which deliberately still counts a self-owned listing's income
// toward "taken" (it's real income), a balance owed TO yourself is
// meaningless and must never silently inflate this figure with no
// visible row (renderLetting's own row list is filtered the same way)
// to explain where it came from.
return owners().filter((k) => !isMyOwnKey(k)).reduce((n, k) => n + balanceFor(k), 0);
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
// A self-owned listing isn't special-cased here -- its OWN sharePct
// already reflects your real cut (100, for one you keep in full, per
// Settings -> Travel -> Airbnb listings), so this is the same
// arithmetic as any other owner's and the row correctly shows what
// you actually earned. Confirmed live: an earlier version of this
// forced the per-row amount to zero for a self-resolving owner too,
// which went further than the actual bug (a listing owner typed as
// "Phil" producing a ledger row claiming you owed yourself £1,000) --
// that's an AGGREGATE-level problem, and totalOwed()/the ticker's
// Owed tile/the per-owner balance badge all already exclude a self-
// resolving key independently (isMyOwnKey), regardless of what this
// row's own amount holds. Zeroing the row too just discarded real
// "what did this stay actually bring in" data for no reason.
// Resolved as of checkout -- the date the money's actually earned on,
// and the same date this row's own `pct` field (below) needs to match
// so a later report can show which rule produced this figure.
const rule = shareRuleAt(listing, r.checkout);
const pct = rule.pct;
const amount = Math.round(splitAmountFor(listing, income, r.checkout) * 100) / 100;
if (!amount) return;
// Nights, same inclusive-both-ends arithmetic the reservation's own
// checkin/checkout convention already uses elsewhere -- stored as a
// field here (not recomputed from the reservation later) for the same
// reason gross/pct/platform already are: the reservation this points
// at can be pruned (a cancelled one, or one the ICS feed's own window
// has simply aged out of), and the figure this feeds -- average
// night rate, nightRateFor() below -- needs to survive that.
const nights = Math.round((new Date(`${r.checkout}T00:00:00`) - new Date(`${r.checkin}T00:00:00`)) / 86400000);
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
nights,
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

// The user's own formula: gross minus one cleaning cost up front, minus
// another for every full 7 days of the stay (a longer stay needs a
// mid-stay clean too), divided by nights. A blacked-out family period
// has no income attached at all -- that alone is what keeps it out of
// this (and everything else money-shaped here): `gross` of 0 or less
// returns null just like having no nights does, no separate "is this a
// real booking" flag needed.
function nightRateFromGrossNights(gross, nights) {
if (!nights || nights <= 0) return null;
if (!(Number(gross) > 0)) return null;
const configured = Number(data.prefs.airbnbCleaningCost);
const cleaningCost = Number.isFinite(configured) ? configured : 50;
const cleanings = 1 + Math.floor(nights / 7);
const net = Number(gross) - cleanings * cleaningCost;
return net / nights;
}
// Only meaningful for a ledger row that's actually a real stay with
// occupied nights -- an 'accrual' (set by accrueLettings) or an
// 'earned' historic one (set by the manual-add handler, only when
// enough dates were given to derive nights from); a cancellation never
// had a guest in it, and a plain payment/adjustment isn't a stay at all.
function nightRateFor(e) {
if (e.kind !== 'accrual' && e.kind !== 'earned') return null;
return nightRateFromGrossNights(e.gross, e.nights);
}

// Weighted by nights, not a plain average of each row's own rate -- a
// 2-night stay and a 20-night stay don't deserve equal weight in "the
// average", same reasoning any other per-unit average in this app
// would use. Broken down by LISTING, not just owner -- an owner can
// have more than one listing (confirmed real: "En-suite - Phil" and
// "Flat" are both Phil's), different properties with their own rates,
// not one blended number.
function nightRateSummaryForOwner(key) {
const byListing = new Map();
entriesFor(key).forEach((e) => {
const rate = nightRateFor(e);
if (rate == null) return;
const listing = (data.airbnbListings || []).find((l) => l.id === e.listingId);
const g = byListing.get(e.listingId) || { listingId: e.listingId, label: (listing && listing.label) || 'Unknown listing', netTotal: 0, nightsTotal: 0, count: 0 };
g.netTotal += rate * e.nights; // rate * nights recovers the net this row contributed, without redoing the cleaning-cost arithmetic a second time
g.nightsTotal += e.nights;
g.count += 1;
byListing.set(e.listingId, g);
});
return [...byListing.values()].map((g) => ({ ...g, avgRate: g.nightsTotal > 0 ? g.netTotal / g.nightsTotal : null }));
}
function nightRateSummaryHtml(key) {
const summary = nightRateSummaryForOwner(key).filter((g) => g.avgRate != null);
if (!summary.length) return '';
const parts = summary.map((g) => `${escapeHtml(g.label)} ${escapeHtml(money(g.avgRate))}/night (${g.count})`).join(' · ');
// No auto-margin of its own -- the "taken" badge right before it
// already pushed the row to the far edge (for a non-mine owner); this
// one just follows on immediately after it, same flex row.
return `<span class="settings-note" style="margin:0;" title="Average night rate, weighted by nights, after the configured cleaning cost -- number in brackets is how many stays it's averaged over.">${parts}</span>`;
}

// ---- Upcoming / awaiting payout (not yet accrued) ----------------------
//
// A preview, not a record: neither a future stay nor a past one still
// waiting on its income figure ever gets a lettingLedger entry
// (accrueLettings only accrues a past checkout that ALSO already has an
// income > 0), so this reads straight off data.airbnbReservations
// instead -- nothing here can ever feed balanceFor/grossFor/totalOwed,
// by construction, which is exactly "doesn't break the earnings totals".
//
// Originally future-only -- confirmed live as a real gap, reported
// directly: a stay that's already checked out but has no income typed
// in yet (Airbnb's payout email hasn't landed, or it just hasn't been
// entered) fell out of BOTH this list and the real ledger at once, so
// it was invisible everywhere, including the average night-rate chart
// -- which is correct (there's no gross to compute a rate from yet),
// but with nothing on screen to explain why, it just looked like a
// silent gap instead of "waiting on a number". Now includes a past
// checkout too, as long as it's still unaccrued.
function upcomingReservationsFor(key) {
const listingIds = new Set((data.airbnbListings || []).filter((l) => ownerKeyFor(l) === key).map((l) => l.id));
return (data.airbnbReservations || [])
.filter((r) => listingIds.has(r.listingId) && !r.accruedAt && r.checkout)
.sort((a, b) => String(a.checkout).localeCompare(String(b.checkout)));
}

// Same pro-rata share accrueLettings() will actually post once this
// stay has both checked out AND has a real income figure -- a genuine
// preview of what's coming/owed, not just a bare list of bookings, so
// it reads consistently with the Earned rows right above it.
function upcomingTableHtml(key) {
const rows = upcomingReservationsFor(key);
if (!rows.length) return '';
return `<div class="letting-upcoming">
<div class="settings-note" style="margin:8px 0 2px;"><strong>Upcoming / awaiting payout</strong> — not yet earned, a preview only. A past-checkout row with no amount is just waiting on its income figure -- add it on <span class="inline-goto-link" data-goto-tab="overview" data-goto-target="#airbnb-panel">Airbnb</span>'s own reservation row and it'll flow through here and onto the chart above automatically.</div>
<div class="letting-scroll"><table class="limits-table"><tbody>${rows.map((r) => {
const listing = (data.airbnbListings || []).find((l) => l.id === r.listingId);
// Resolved as of the stay's own checkout, even if that's still in the
// future -- a preview should already reflect whichever rule will
// actually be in force by then (a booking after a scheduled rate
// change previews under the NEW rule, not today's).
const pct = shareRuleAt(listing, r.checkout).pct;
const income = Number(r.income) || 0;
const amount = Math.round(splitAmountFor(listing, income, r.checkout) * 100) / 100;
const isPast = r.checkout && r.checkout <= today();
// Computed straight off the reservation's own dates -- a row here has
// no ledger row yet to carry a stored `nights`. A blacked-out family
// period (no income typed in) falls out of this for free:
// nightRateFromGrossNights returns null the moment gross isn't
// positive, same gate the gross/amount columns already use -- and so
// does a past stay still waiting on its income figure, for the same
// reason, not a bug: there's genuinely no gross to divide yet.
const nights = r.checkin && r.checkout ? Math.round((new Date(`${r.checkout}T00:00:00`) - new Date(`${r.checkin}T00:00:00`)) / 86400000) : 0;
const nightRate = nightRateFromGrossNights(income, nights);
const nightRateHtml = nightRate != null
? ` <span class="letting-gross" title="${escapeHtml(`${nights} night${nights === 1 ? '' : 's'}, after cleaning cost`)}">${escapeHtml(`${money(nightRate)}/night`)}</span>`
: '';
const statusLabel = isPast ? 'awaiting payout' : 'upcoming';
return `<tr>
<td style="white-space:nowrap;">${escapeHtml(r.checkin || '?')} &rarr; ${escapeHtml(r.checkout)}</td>
<td>${escapeHtml(`${(listing && listing.label) || 'listing'}${r.guestName ? `, ${r.guestName}` : ''}`)} <span class="letting-kind upcoming">${escapeHtml(statusLabel)}</span>${income ? ` <span class="letting-gross" title="${escapeHtml(`Booking total (${pct}% share, before any monthly cap)`)}">${escapeHtml(money(income))}</span>` : ''}${nightRateHtml}</td>
<td style="text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;">${income ? escapeHtml(money(amount)) : ''}</td>
</tr>`;
}).join('')}</tbody></table></div>
</div>`;
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
renderNightRateChart();
const el = document.getElementById('letting-list');
if (!el) return;
// A self-owned listing's income still belongs here -- the entries, the
// gross, the tax-year summary are all real and worth keeping visible.
// Confirmed live this needs to stay the FULL owner list: an earlier
// version of this fix excluded self entirely and took the income
// entries with it, which is not what was wanted -- only the "owed to
// you" FRAMING is meaningless for yourself, not the record of the
// income itself. See the per-row rendering below for where that
// framing is actually suppressed.
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
// Which accruals still have a live reservation backing them -- an
// orphaned one (the ICS feed's own rolling window aged the real
// reservation out, or it was genuinely cancelled) has no real
// checkin/checkout left anywhere BUT this row, so it needs the same
// explicit start-date capture an "Earned" row already gets, not just
// the ones typed in by hand from the start.
const reservationIds = new Set((data.airbnbReservations || []).map((r) => r.id));
const airbnbLogo = matchBrandLogo('Airbnb');
el.innerHTML = keys.map((key) => {
const rows = entriesFor(key).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
const bal = balanceFor(key);
const mine = isMyOwnKey(key);
const taxYears = taxYearSummaryFor(key);
const collapsed = collapsedOwners.has(key);
return `<div class="letting-owner">
<div class="letting-head" data-letting-owner-toggle="${escapeHtml(key)}" title="${collapsed ? 'Show' : 'Hide'} this person's ledger" style="cursor:pointer;">
<span class="letting-chevron">${collapsed ? '&#9656;' : '&#9662;'}</span>
<span class="letting-name">${escapeHtml(ownerNameFor(key))}</span>
${mine
// No "owed to you" framing for yourself -- that money's already
// yours, there's nothing to owe. Still shows the gross taken,
// same as everyone else's row, just without a balance that would
// otherwise always read as a meaningless "£0.00 settled".
? ''
: `<span class="letting-balance${bal > 0 ? ' owes' : bal < 0 ? ' credit' : ''}">${escapeHtml(money(bal))}</span>
<span class="settings-note" style="margin:0;">${bal > 0 ? 'owed to you' : bal < 0 ? 'in credit' : 'settled'}</span>`}
${grossFor(key) ? `<span class="settings-note" style="margin:${mine ? '0' : '0 0 0 auto'};">${escapeHtml(money(grossFor(key)))} taken</span>` : ''}
${nightRateSummaryHtml(key)}
</div>
<div class="letting-owner-body"${collapsed ? ' hidden' : ''}>
${mine ? '' : `<div class="sync-row" style="margin:4px 0 8px;flex-wrap:wrap;align-items:center;">
<input type="month" class="settings-input" data-report-period="${escapeHtml(key)}" style="max-width:130px;" title="The month this report covers -- defaults to last month.">
<button class="sync-btn sm inline" type="button" data-report-generate="${escapeHtml(key)}">&#128196; Generate report</button>
<span class="sync-status" data-report-status="${escapeHtml(key)}"></span>
</div>`}
${rows.length ? `<div class="letting-scroll"><table class="limits-table"><tbody>${rows.map((e) => {
const nightRate = nightRateFor(e);
const nightRateHtml = nightRate != null
? ` <span class="letting-gross" title="${escapeHtml(`${e.nights} night${e.nights === 1 ? '' : 's'}, after cleaning cost`)}">${escapeHtml(`${money(nightRate)}/night`)}</span>`
: '';
const isOrphanedAccrual = e.kind === 'accrual' && (!e.reservationId || !reservationIds.has(e.reservationId));
const showStartDate = e.kind === 'earned' || isOrphanedAccrual;
const showNights = e.kind === 'accrual' || e.kind === 'earned';
const showListing = e.kind === 'earned' && !e.listingId;
const showPlatform = e.kind === 'earned' || e.kind === 'cancellation';
const hasDetail = showStartDate || showNights || showListing || showPlatform;
const open = expandedLedgerRows.has(e.id);
const isIncomeKind = e.kind === 'accrual' || e.kind === 'earned' || e.kind === 'cancellation';
// The Airbnb mark stands in for the old platform dropdown on the line
// itself; changing the platform lives in the row's own hidden details.
const platformBadge = isIncomeKind && e.platform !== 'other' ? ` ${logoBadgeHtml(airbnbLogo, 'A', 'letting-platform-badge')}` : '';
// The booking's gross total, not "X% of" it -- a share that can be
// capped per month isn't a fixed percentage of any one booking.
const grossHtml = e.gross ? ` <span class="letting-gross" title="${escapeHtml(`Booking total (${e.pct ?? 50}% share, before any monthly cap)`)}">${escapeHtml(money(e.gross))}</span>` : '';
return `<tr>
<td style="white-space:nowrap;"><input type="date" class="settings-input" data-letting-date="${escapeHtml(e.id)}" value="${escapeHtml(e.date || '')}" title="The payout/accrual date -- used for statements and tax-year grouping only. Edit it to the real Airbnb payout date if that differs from checkout; it has no effect on occupancy or the nightly rate, which both come from check-in/nights instead."></td>
<td>${escapeHtml(ledgerNoteFor(e))}${e.kind && e.kind !== 'accrual' ? ` <span class="letting-kind ${escapeHtml(e.kind)}">${escapeHtml(e.kind)}</span>` : ''}${platformBadge}${grossHtml}${nightRateHtml}</td>
<td style="text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;">${escapeHtml(money(e.amount))}</td>
<td style="width:1%;white-space:nowrap;">${hasDetail ? `<span class="letting-row-toggle" data-letting-row-toggle="${escapeHtml(e.id)}" title="Check-in date, nights, listing and platform">${open ? '&#9662;' : '&#9656;'}</span> ` : ''}<span class="del-x" data-letting-del="${escapeHtml(e.id)}" title="Remove this entry">&times;</span></td>
</tr>${hasDetail ? `<tr class="letting-detail-row"${open ? '' : ' hidden'}><td colspan="4"><div class="letting-detail">
${showStartDate ? `<label>Check-in<input type="date" class="settings-input" data-letting-start-date="${escapeHtml(e.id)}" value="${escapeHtml(e.startDate || '')}" title="The real check-in date for this stay -- what occupancy and the average night rate are actually based on, kept separate from the payout date. Leave blank and nights get guessed backward from the payout date instead, which is wrong whenever the payout didn't land on the real checkout."></label>` : ''}
${showNights ? `<label>Nights<input type="number" min="0" step="1" class="settings-input" data-letting-nights="${escapeHtml(e.id)}" value="${e.nights || ''}" placeholder="Nights" title="Nights this stay covered -- used for the average night rate. Filled in automatically when the reservation was still on file at accrual time; type it in for an older row that's missing it."></label>` : ''}
${showListing ? `<label>Listing<select class="settings-input" data-letting-listing="${escapeHtml(e.id)}" title="Which listing this stay was for -- a manually-added row has no listing on it yet, so it's left out of the average night-rate chart (which groups by listing) until this is set.">
<option value="">Listing…</option>
${(data.airbnbListings || []).map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.label || l.prefix || 'Listing')}</option>`).join('')}
</select></label>` : ''}
${showPlatform ? `<label>Platform<select data-letting-platform="${escapeHtml(e.id)}" title="Which platform this actually happened through -- the chart above draws Other as a striped fill instead of solid.">
<option value="airbnb"${e.platform !== 'other' ? ' selected' : ''}>Airbnb</option>
<option value="other"${e.platform === 'other' ? ' selected' : ''}>Other</option>
</select></label>` : ''}
</div></td></tr>` : ''}`;
}).join('')}</tbody></table></div>` : '<div class="settings-note" style="margin:4px 0 0;">Nothing yet.</div>'}
${upcomingTableHtml(key)}
${taxYearSummaryHtml(key, taxYears)}
</div>
</div>`;
}).join('');
bindLogoFallbacks(el);
el.querySelectorAll('[data-letting-owner-toggle]').forEach((head) => {
head.addEventListener('click', () => {
const key = head.dataset.lettingOwnerToggle;
if (collapsedOwners.has(key)) collapsedOwners.delete(key); else collapsedOwners.add(key);
saveCollapsedOwners();
renderLetting();
});
});
el.querySelectorAll('[data-letting-row-toggle]').forEach((t) => {
t.addEventListener('click', () => {
const id = t.dataset.lettingRowToggle;
if (expandedLedgerRows.has(id)) expandedLedgerRows.delete(id); else expandedLedgerRows.add(id);
renderLetting();
});
});

el.querySelectorAll('[data-report-generate]').forEach((btn) => {
btn.addEventListener('click', async () => {
const key = btn.dataset.reportGenerate;
const status = el.querySelector(`[data-report-status="${CSS.escape(key)}"]`);
const periodInput = el.querySelector(`[data-report-period="${CSS.escape(key)}"]`);
const say = (t) => { if (status) status.textContent = t; };
btn.disabled = true;
say('Building…');
try {
const report = await import('./lettingreport.js');
let period = report.defaultPeriod();
// <input type="month"> gives "YYYY-MM" -- the whole of that
// calendar month, same convention defaultPeriod() itself uses.
if (periodInput && periodInput.value) {
const [y, m] = periodInput.value.split('-').map(Number);
// isoDate, not .toISOString() -- that converts through UTC first,
// which silently shifted the date by a day under BST. Confirmed
// live: picking "2026-09" downloaded a report filed under 2026-08.
const start = report.isoDate(new Date(y, m - 1, 1));
const end = report.isoDate(new Date(y, m, 0));
period = { start, end };
}
const blob = await report.buildReportPdf(key, period);
const filename = report.reportFilename(key, period.start);
report.downloadBlob(blob, filename);
say(`Downloaded ${filename}. `);
// Appended rather than replacing the status text above, so the
// download confirmation stays visible once these are added.
if (status) {
const emailBtn = document.createElement('button');
emailBtn.type = 'button'; emailBtn.className = 'todo-add-btn';
emailBtn.textContent = 'Open email draft';
emailBtn.addEventListener('click', () => report.openEmailDraft(key, period.start, period.end));
status.appendChild(emailBtn);
// Telegram only when `key` resolves to a real connection WITH a
// linked chat id -- ownerKeyFor() returns the connection's own id
// when the owner was set via the dropdown (not the free-text
// fallback), and reachability (having actually DM'd the bot at
// least once) is the same precondition telegramfamily.js's own
// askQuestion already requires.
const ownerConn = (data.connections || []).find((c) => c.id === key);
if (ownerConn && ownerConn.telegramChatId) {
const tgBtn = document.createElement('button');
tgBtn.type = 'button'; tgBtn.className = 'todo-add-btn';
tgBtn.textContent = 'Send via Telegram';
tgBtn.addEventListener('click', async () => {
tgBtn.disabled = true;
try {
const { sendDocument } = await import('./telegramfamily.js');
await sendDocument(ownerConn.telegramChatId, blob, filename, `Letting report, ${period.start} to ${period.end}`);
say('Sent via Telegram.');
} catch (err) {
say(`Couldn't send via Telegram: ${err.message || err}`);
} finally {
tgBtn.disabled = false;
}
});
status.appendChild(tgBtn);
}
}
} catch (err) {
console.error('Letting report failed:', err);
say(`Couldn't build the report: ${err.message || err}`);
} finally {
btn.disabled = false;
}
});
});

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
// Reported directly as needed for every older row the backfill
// couldn't reach (its own reservation already pruned by the time this
// shipped) -- typed in by hand instead. Empty is valid (clears it back
// to "no rate shown"), same as the start-date field above.
el.querySelectorAll('[data-letting-nights]').forEach((input) => {
input.addEventListener('change', () => {
const entry = (data.lettingLedger || []).find((e) => e.id === input.dataset.lettingNights);
if (!entry) return;
const n = Number(input.value);
entry.nights = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
queueSave();
renderLetting();
});
});
el.querySelectorAll('[data-letting-listing]').forEach((sel) => {
sel.addEventListener('change', () => {
const entry = (data.lettingLedger || []).find((e) => e.id === sel.dataset.lettingListing);
if (!entry) return;
entry.listingId = sel.value || undefined;
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
const earnedFieldsEl = document.getElementById('letting-add-earned-fields');
const platformFieldEl = document.getElementById('letting-add-platform-field');
const setHint = () => {
if (!kindEl || !amountEl) return;
amountEl.placeholder = kindEl.value === 'earned' ? 'Gross takings' : 'Amount';
// Nights/start-date only mean anything for a real stay -- asked for
// directly, so a historic "Earned" row doesn't need a second visit to
// the row below just to fill them in.
if (earnedFieldsEl) earnedFieldsEl.style.display = kindEl.value === 'earned' ? '' : 'none';
// Platform matters for the same two kinds the per-row edit view
// already lets you set it on afterward (earned/cancellation) -- a
// cancellation payout has no nights (nothing was occupied), but it
// still happened on some platform, so it gets this field without the
// nights/start-date ones above.
if (platformFieldEl) platformFieldEl.style.display = (kindEl.value === 'earned' || kindEl.value === 'cancellation') ? '' : 'none';
};
kindEl?.addEventListener('change', setHint);
setHint();
const dateEl = document.getElementById('letting-add-date');
if (dateEl && !dateEl.value) dateEl.value = today();
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
// Not special-cased for yourself -- sharePctFor() already reads the
// real cut straight off the listing (100 for one you keep in full),
// same arithmetic accrueLettings() uses for a real stay. Nothing here
// claims a debt to yourself: totalOwed()/the ticker's Owed tile/the
// per-owner balance badge exclude a self-resolving key independently
// of this row's own amount.
// Nights/start-date, for "Earned" -- filled in here now rather than
// needing a second visit to the row below afterward. Asked for
// directly: nights feeds the average night rate and the income
// chart's own month-split the moment it's more than one month's worth
// (see impliedStartDate); start-date only needed on top of that for a
// stay with a real gap the "date minus nights" arithmetic can't infer.
const nightsVal = kind === 'earned' ? Number(document.getElementById('letting-add-nights')?.value) : null;
const startDateVal = kind === 'earned' ? (document.getElementById('letting-add-start-date')?.value || '') : '';
// Same two kinds the platform field above shows for -- stored so the
// income chart draws Other as a striped fill instead of solid, same as
// an accrual's own platform already does. Missing until now: a
// manually-added row had no way to say Other at all.
const platformVal = (kind === 'earned' || kind === 'cancellation') ? (document.getElementById('letting-add-platform')?.value || 'airbnb') : '';
const dateVal = document.getElementById('letting-add-date')?.value || today();
// Resolved as of the row's OWN date, not today's -- a backdated
// "Earned" entry should use whichever rule actually applied then.
const whoListing = (data.airbnbListings || []).find((l) => ownerKeyFor(l) === who.value);
const pct = shareRuleAt(whoListing, dateVal).pct;
const signed = kind === 'earned'
? Math.round(splitAmountFor(whoListing, amount, dateVal) * 100) / 100
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
...(kind === 'earned' && Number.isFinite(nightsVal) && nightsVal > 0 ? { nights: Math.round(nightsVal) } : {}),
...(kind === 'earned' && startDateVal ? { startDate: startDateVal } : {}),
...(platformVal ? { platform: platformVal } : {}),
date: dateVal,
note: note || (kind === 'earned'
? `Earned before tracking`
: kind === 'cancellation' ? 'Cancellation'
: kind === 'payment' ? (amount < 0 ? 'Paid' : 'Owed more') : 'Adjustment'),
});
queueSave();
document.getElementById('letting-add-amount').value = '';
document.getElementById('letting-add-note').value = '';
const nightsEl = document.getElementById('letting-add-nights');
const startEl = document.getElementById('letting-add-start-date');
if (nightsEl) nightsEl.value = '';
if (startEl) startEl.value = '';
if (dateEl) dateEl.value = today();
say(`Added ${money(amount)} for ${ownerNameFor(who.value)}.`);
renderOwnerPicker();
renderLetting();
});
const cleaningCostInput = document.getElementById('letting-cleaning-cost');
if (cleaningCostInput) {
cleaningCostInput.value = Number.isFinite(Number(data.prefs.airbnbCleaningCost)) ? data.prefs.airbnbCleaningCost : 50;
cleaningCostInput.addEventListener('change', () => {
const v = Number(cleaningCostInput.value);
data.prefs.airbnbCleaningCost = Number.isFinite(v) && v >= 0 ? v : 50;
queueSave();
renderLetting();
});
}
renderOwnerPicker();
initLettingTaxSettings();
initLettingChart();
initNightRateChart();
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
// A blank key (no owner set) or one that resolves to your own name --
// either way, nobody else is actually owed anything. Key-level so both
// a listing (via ownerKeyFor) and a raw ownerKey from the ledger/owner
// picker can use the same one check.
function isMyOwnKey(key) {
return !key || /^phil$/i.test(String(ownerNameFor(key) || '').trim());
}
function isMyOwnListing(listing) {
return isMyOwnKey(ownerKeyFor(listing));
}
function splitContribution(listing, amount, dateStr) {
if (isMyOwnListing(listing)) return [{ group: LETTING_CHART_MINE_KEY, amount }];
const ownCut = splitAmountFor(listing, amount, dateStr);
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

// Reads a LOCAL-calendar date straight off the Date object's own
// getters, never .toISOString() (which converts through UTC first and
// silently shifts the date by a day under BST) -- the two helpers
// below both do day arithmetic on a local-midnight Date and need to
// read the result back out safely.
function isoDate(d) {
return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDaysIso(dateStr, days) {
const d = new Date(`${dateStr}T00:00:00`);
d.setDate(d.getDate() + days);
return isoDate(d);
}

// `date` minus `nights` days -- the checkin a historic "earned" row
// WOULD have had, derivable from fields already on the row without
// needing its own optional startDate input filled in too. Used as a
// fallback date range for month-splitting wherever startDate is blank,
// instead of lumping the whole gross into date's own single month.
// Confirmed live as a real gap, reported directly: a real 20-night stay
// (23 Sept -> 13 Oct) with nights recorded but no startDate typed in
// landed entirely in October on the income chart, with nothing at all
// in September -- "not fully reflected" is exactly what that looks
// like, and it's purely because startDate happened to be the ONLY way
// this function knew to split across months, despite nights already
// saying the stay couldn't have fit in one. Only a GUESS, and only as
// good as the assumption that `date` itself lands on the real checkout
// -- see nightsByMonthForEntry, which prefers a real startDate+nights
// pair over this the moment one exists, precisely because the payout
// date can legitimately land any time during a stay now, not just on
// its last day.
function impliedStartDate(dateStr, nights) {
if (!dateStr || !(nights > 0)) return '';
return addDaysIso(dateStr, -nights);
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
const reservationIds = new Set((data.airbnbReservations || []).map((r) => r.id));

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
splitContribution(listing, income * (nights / total), r.checkout).forEach((c) => { addAmount(c.group, ym, c.amount); addAmountPlatform(c.group, ym, platform, c.amount); });
});
});

// "Earned (historic)" and "cancellation" ledger rows -- real income
// that has no entry in data.airbnbReservations for the loop above to
// count: 'earned' is pre-tracking income typed in by hand (initLetting
// ()'s add-row), 'cancellation' is a payout whose reservation record is
// gone by the time it posts (syncCancellationsFromEmail -- the ICS sync
// deletes a cancelled reservation outright, there's nothing left for
// the loop above to find).
//
// 'accrual' rows join this loop too, but ONLY when their OWN
// reservationId no longer resolves to a real reservation -- confirmed
// live as a real gap, with real data: a genuine, fully-accrued 20-night
// stay's reservation had since been pruned (the ICS feed's own rolling
// window ages a past stay out of it eventually), leaving a perfectly
// real ledger row -- gross, nights, date all intact, the money genuinely
// owed -- with NOTHING in data.airbnbReservations left for the loop
// above to find it by. The old assumption ("every accrual mirrors a
// reservation's own income still present") was true until the
// reservation itself stopped being guaranteed to survive. An accrual
// whose reservation IS still on file is correctly left to the loop
// above (counting it again here would double it) -- reservationIds is
// exactly that still-on-file check. 'payment'/'adjustment' stay
// excluded either way (balance moves, not income). A row with no
// listingId (a hand-added "earned" one) falls back to whichever
// listing that owner currently has -- same one-owner-one-listing
// assumption balanceFor/grossFor already make elsewhere in this file.
// baseStart (the normal rolling-15-month start) is a real floor here,
// not just a default -- a historic entry older than that is excluded
// rather than widening the chart back to meet it, so the window stays
// a fixed 15 months regardless of how far back the ledger goes.
(data.lettingLedger || []).forEach((e) => {
const isOrphanedAccrual = e.kind === 'accrual' && e.reservationId && !reservationIds.has(e.reservationId);
if ((e.kind !== 'earned' && e.kind !== 'cancellation' && !isOrphanedAccrual) || !e.gross || !e.date) return;
const listing = (e.listingId && listingById.get(e.listingId)) || listings.find((l) => ownerKeyFor(l) === e.ownerKey);
if (!listing) return;
// A historic booking that actually ran longer than one month gets
// split pro-rata by night across every month it spans, exactly like a
// real reservation's own checkin/checkout (nightsByMonth) -- otherwise
// the whole gross lands as one spike in a single month, which is what
// was blowing the chart's own scale for a multi-month let. A real
// startDate+nights pair (letting-add-start-date/-nights inputs above)
// wins when both are set, counted FORWARD from check-in rather than
// bounded by `date` -- `date` is the payout/accrual date, which can
// legitimately land any time during the stay, not just on its last
// day, so it must never be the thing deciding where the stay's own
// nights actually fall. Falling back to "date minus nights" only when
// there's no real startDate to use instead -- a guess, not a certainty,
// but still better than lumping the whole gross into date's own single
// month just because neither of the above was available.
const platform = e.platform === 'other' ? 'other' : 'airbnb';
const splitStart = (e.startDate && e.nights > 0) ? e.startDate : impliedStartDate(e.date, e.nights);
const splitEnd = (e.startDate && e.nights > 0) ? addDaysIso(e.startDate, e.nights) : e.date;
if (splitStart && splitEnd && splitStart < splitEnd) {
const { counts, total } = nightsByMonth(splitStart, splitEnd);
if (!total) return;
counts.forEach((nights, ym) => {
if (!baseMonthSet.has(ym)) return;
splitContribution(listing, Number(e.gross) * (nights / total), e.date).forEach((c) => { addAmount(c.group, ym, c.amount); addAmountPlatform(c.group, ym, platform, c.amount); });
});
return;
}
const ym = e.date.slice(0, 7);
if (ym > endYm) return; // a future-dated "historic" entry makes no sense -- ignore rather than extend forward
if (ym < baseStart) return; // older than the rolling window -- excluded, not widened in to meet it
splitContribution(listing, Number(e.gross), e.date).forEach((c) => { addAmount(c.group, ym, c.amount); addAmountPlatform(c.group, ym, platform, c.amount); });
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

// padTop reserves a fixed header band ABOVE the plotted bars for the
// hover tooltip to live in -- it used to sit at plot.y+2 (the very top
// of the bars themselves), so a tall bar near the hovered month
// routinely sat right under it, which is exactly the part of the chart
// worth seeing most. Confirmed directly as a real problem from a
// screenshot, not a style nitpick -- the tooltip now always renders in
// this reserved band (see boxY below), never over real chart content.
const padLeft = 46, padRight = 10, padTop = 62, padBottom = 20;
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
// Month, total and the 3-month average folded onto one line -- each
// used to get its own row ("Total: X" / "3-month avg: Y"), 2 rows of
// height for numbers that read fine packed beside the month itself.
const lines = [`${monthLabel(ym)} — ${money0(total)} · 3m avg ${money0(avg)}`];
rows.forEach((r) => {
lines.push(`${r.g.label}: ${money0(r.raw)}`);
// Only when a group actually mixes both this month -- a group that's
// entirely one platform already says so via its label alone, nothing
// to break out.
if (r.platform.airbnb > 0.004 && r.platform.other > 0.004) {
lines.push(`  Airbnb ${money0(r.platform.airbnb)} · Other ${money0(r.platform.other)}`);
}
});
ctx.font = "10px 'Inter', sans-serif";
const boxW = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16;
const boxH = lines.length * 14 + 10;
const cx = plot.x + (lettingChartHoverIndex + 0.5) * bw;
const boxX = Math.min(Math.max(cx - boxW / 2, plot.x), plot.x + plot.w - boxW);
// Pinned near the very top of the canvas, inside padTop's reserved
// header band -- not plot.y (the top of the bars themselves), which is
// what used to put this right on top of the tallest ones.
const boxY = 4;
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

// ---- Average night rate by listing (a SEPARATE chart from income above) ---
//
// One series per real LISTING, not the income chart's own owner/Mine-
// merged groups -- a night rate is a property of the listing itself,
// and "Mine" would wrongly blend two different properties' rates into
// one meaningless number the moment there's more than one self-owned
// listing (there already is: "En-suite - Phil" and "Flat"). Lines, not
// stacked bars -- summing several listings' average rates together
// isn't a real number the way summing their income is, so this is
// deliberately a different chart shape from the one above, sharing
// only the month-axis plumbing (addMonths/monthRange/monthLabel/
// niceLettingAxisStep) rather than drawLettingChart itself.
function nightRateListings() {
return (data.airbnbListings || []).map((l) => ({ key: l.id, label: l.label || l.prefix || 'Listing', colour: l.colour || 'slate' }));
}

// Same "seen before defaults to ticked" shape lettingChartSelectedGroups
// above already uses, kept as its own pair of sets since the two charts'
// group keys (listing id here, owner/Mine key there) are a different
// universe entirely.
let nightRateSelectedListings = new Set();
let nightRateKnownListingKeys = new Set();
function syncNightRateSelection(listings) {
listings.forEach((l) => {
if (nightRateKnownListingKeys.has(l.key)) return;
nightRateKnownListingKeys.add(l.key);
nightRateSelectedListings.add(l.key);
});
}

// A stay that actually spans more than one month should carry its rate
// into EVERY month it covers, not land as a single spike in whichever
// month its `date` field happens to be -- the same nightsByMonth
// pro-rata the income chart above already applies to a reservation's
// gross, applied here to a stay's NIGHTS (its weight in each month's
// average) instead. The rate itself stays one number for the whole
// stay either way (nightRateFromGrossNights divides by the whole
// stay's own nights up front) -- what moves per month is only how much
// weight that stay contributes once more than one stay shares a month.
// An accrual's real checkin/checkout lives on its reservation, if
// still on file; an "earned" (historic, hand-typed) row has its own
// optional startDate for the same purpose, which wins when set (it can
// account for a real gap the "date minus nights" arithmetic below
// can't). Below that, `nights` alone already says how far back the
// stay must have started -- date minus nights -- so that's used rather
// than lumping into a single month just because neither of the above
// was available. Confirmed live as a real gap: a 20-night stay with no
// reservation left on file and no startDate typed in showed its whole
// rate bunched into one month on the chart, nothing in the other one
// it actually spanned.
function nightsByMonthForEntry(e) {
if (e.kind === 'accrual' && e.reservationId) {
const r = (data.airbnbReservations || []).find((x) => x.id === e.reservationId);
if (r && r.checkin && r.checkout && r.checkout > r.checkin) return nightsByMonth(r.checkin, r.checkout);
}
// A real startDate+nights pair fixes the whole window on its own --
// counted FORWARD from check-in, never bounded by `date`. `date` is
// the payout/accrual date, which can legitimately land any time during
// (or even after) the stay now, not just on its last day -- using it
// as the other end of the range here would silently truncate or shift
// a stay the moment payout timing stops lining up with checkout. Not
// just an "earned" row either: an orphaned accrual can carry an
// explicit startDate too (the per-row edit view offers it the same
// way), and it's a real checkin either way.
if (e.startDate && e.nights > 0) {
return nightsByMonth(e.startDate, addDaysIso(e.startDate, e.nights));
}
// Nothing but the payout date and a nights count -- the best guess
// left, and only as good as assuming payout landed on the real
// checkout. Confirmed live as a real gap when this guess wasn't made
// at all: a 20-night stay with no reservation on file and no startDate
// typed in showed its whole rate bunched into one month on the chart,
// nothing in the other one it actually spanned.
const implied = impliedStartDate(e.date, e.nights);
if (implied && e.date && implied < e.date) {
return nightsByMonth(implied, e.date);
}
const ym = (e.date || '').slice(0, 7);
if (!ym || !e.nights) return { counts: new Map(), total: 0 };
return { counts: new Map([[ym, e.nights]]), total: e.nights };
}

// A "Room" is two or more listings sharing a `colour` -- the same
// physical let presented as separate listings (see blankAirbnbListing's
// own comment on `colour`, state.js). Occupancy and the candle view
// below both answer "is the ROOM full/what did the room go for", not
// "is listing A full while listing B sits idle" -- not a real
// distinction for the same physical space.
function nightRateRooms() {
const listings = data.airbnbListings || [];
const byColour = new Map();
listings.forEach((l) => {
const colour = l.colour || 'slate';
if (!byColour.has(colour)) byColour.set(colour, { key: colour, colour, labels: [], listingIds: [] });
const g = byColour.get(colour);
g.listingIds.push(l.id);
g.labels.push(l.label || l.prefix || 'Listing');
});
return [...byColour.values()].map((g) => ({ key: g.key, colour: g.colour, listingIds: g.listingIds, label: roomLabelFromListingLabels(g.labels) }));
}

// "En-Suite - Phil" + "En-Suite - Lewis" -> "En-Suite" -- the shared
// prefix before the " - Name" the two listings' own labels already
// follow. Falls back to joining every label when they don't share one
// (nothing real to shorten to) rather than guessing which one "wins".
function roomLabelFromListingLabels(labels) {
if (labels.length <= 1) return labels[0] || 'Room';
const stripped = labels.map((l) => l.split(/\s+-\s+/)[0].trim());
return stripped.every((s) => s === stripped[0]) ? stripped[0] : labels.join(' / ');
}

// Every real "this stay happened/will happen at this rate" contribution,
// per listing, spread across the months it covers -- from TWO sources:
// the ledger (a past, accrued stay) and an UPCOMING reservation that
// already has a real income figure but hasn't checked out yet, so it
// has no ledger row at all (accrueLettings only ever posts once a stay
// is both past AND priced -- see its own comment). Without this second
// source, every future month was blank on both the average and candle
// views no matter how many future bookings already had a known price --
// confirmed directly as a real gap: the chart's own x-axis runs 6
// months forward (LETTING_CHART_MONTHS_FORWARD), but nothing from those
// months ever had a chance to land on it. A reservation already accrued
// is skipped here -- its ledger row already covers it, counting it
// again here would double its weight in the average.
function nightRateContributions() {
const out = []; // { listingId, rate, counts: Map<ym, nights> }
(data.lettingLedger || []).forEach((e) => {
const rate = nightRateFor(e);
if (rate == null || !e.listingId) return;
const { counts, total } = nightsByMonthForEntry(e);
if (!total) return;
out.push({ listingId: e.listingId, rate, counts });
});
(data.airbnbReservations || []).forEach((r) => {
if (r.accruedAt) return; // already counted via its own ledger row, above
const income = Number(r.income);
if (!Number.isFinite(income) || income <= 0) return;
if (!r.checkin || !r.checkout || r.checkout <= r.checkin) return;
const wholeNights = Math.round((new Date(`${r.checkout}T00:00:00`) - new Date(`${r.checkin}T00:00:00`)) / DAY_MS);
const rate = nightRateFromGrossNights(income, wholeNights);
if (rate == null) return;
const { counts, total } = nightsByMonth(r.checkin, r.checkout);
if (!total) return;
out.push({ listingId: r.listingId, rate, counts });
});
return out;
}

// High/low/avg per room per month -- the candle view. High and low are
// a STAY's own flat rate (the whole-stay figure, same one the average
// view plots), not a per-month-split rate -- a single stay spanning two
// months contributes the SAME rate as its own high and low in both,
// and only distinct stays sharing a room/month produce a real spread.
function nightRateRoomStats(months, baseStart, endYm, rooms, contributions) {
const listingToRoom = new Map();
rooms.forEach((room) => room.listingIds.forEach((id) => listingToRoom.set(id, room.key)));
const perRoomByMonth = new Map();
rooms.forEach((room) => perRoomByMonth.set(room.key, new Map()));
contributions.forEach(({ listingId, rate, counts }) => {
const roomKey = listingToRoom.get(listingId);
if (!roomKey) return;
const byMonth = perRoomByMonth.get(roomKey);
counts.forEach((nights, ym) => {
if (ym < baseStart || ym > endYm) return;
const bucket = byMonth.get(ym) || { net: 0, nights: 0, high: null, low: null };
bucket.net += rate * nights;
bucket.nights += nights;
bucket.high = bucket.high == null ? rate : Math.max(bucket.high, rate);
bucket.low = bucket.low == null ? rate : Math.min(bucket.low, rate);
byMonth.set(ym, bucket);
});
});
return rooms.map((room) => ({
room,
statsByMonth: months.map((ym) => {
const b = perRoomByMonth.get(room.key).get(ym);
if (!b || b.nights <= 0) return null;
return { avg: b.net / b.nights, high: b.high, low: b.low };
}),
}));
}

// One room can only actually be occupied by one of its own listings on
// any given night (it's the same physical space) -- a Set of occupied
// ISO dates per room, not a per-listing sum, is what keeps two listings
// for the same room from ever reading as more than 100% occupied. Reads
// straight off data.airbnbReservations first, so an upcoming booked-
// but-not-yet-accrued stay still counts, at exact day-by-day precision.
//
// A historic ledger row has no such reservation behind it any more (a
// pre-tracking "earned" entry never had one; an old accrual's own
// reservation can have been pruned since) -- without a real
// checkin/checkout there's nothing to put in the day-level Set above,
// only a nights total, so those are added as a flat count instead
// (via nightsByMonthForEntry, the same pro-rata-by-startDate split the
// rate chart above already uses for the same rows) rather than being
// left out of the older months entirely. Capped at 100% below since a
// flat count, unlike the exact Set, has no way to detect two such rows
// overlapping the same nights.
function nightRateOccupancyData(months, baseStart, endYm, rooms) {
const listingToRoom = new Map();
rooms.forEach((room) => room.listingIds.forEach((id) => listingToRoom.set(id, room.key)));
const occupiedDays = new Map();
const perRoomMonthCount = new Map();
// Average stay LENGTH, not occupancy -- a stay's own whole-stay nights
// (never the pro-rated per-month split the occupancy count above and
// the rate chart both use), counted once in every month that stay
// touches. A 20-night stay spanning two months should read as "avg 20
// nights" in BOTH of them, not read as two shorter stays because it
// happened to straddle a month end.
const perRoomMonthDuration = new Map();
rooms.forEach((room) => { occupiedDays.set(room.key, new Set()); perRoomMonthCount.set(room.key, new Map()); perRoomMonthDuration.set(room.key, new Map()); });
const addCount = (roomKey, ym, n) => {
if (ym < baseStart || ym > endYm || n <= 0) return;
const byMonth = perRoomMonthCount.get(roomKey);
byMonth.set(ym, (byMonth.get(ym) || 0) + n);
};
const addDuration = (roomKey, touchedYms, wholeNights) => {
if (!wholeNights) return;
const byMonth = perRoomMonthDuration.get(roomKey);
touchedYms.forEach((ym) => {
if (ym < baseStart || ym > endYm) return;
const b = byMonth.get(ym) || { nightsSum: 0, stayCount: 0 };
b.nightsSum += wholeNights;
b.stayCount += 1;
byMonth.set(ym, b);
});
};
const reservationsById = new Map((data.airbnbReservations || []).map((r) => [r.id, r]));
(data.airbnbReservations || []).forEach((r) => {
const roomKey = listingToRoom.get(r.listingId);
if (!roomKey || !r.checkin || !r.checkout || r.checkout <= r.checkin) return;
const seenDays = occupiedDays.get(roomKey);
const start = new Date(`${r.checkin}T00:00:00`);
const end = new Date(`${r.checkout}T00:00:00`);
const wholeNights = Math.round((end - start) / DAY_MS);
const touchedYms = new Set();
for (let t = start.getTime(); t < end.getTime(); t += DAY_MS) {
const d = new Date(t);
const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
if (ym < baseStart || ym > endYm) continue;
touchedYms.add(ym);
const dateKey = `${ym}-${String(d.getDate()).padStart(2, '0')}`;
if (seenDays.has(dateKey)) continue; // already counted via another listing of this same room on this day
seenDays.add(dateKey);
addCount(roomKey, ym, 1);
}
addDuration(roomKey, touchedYms, wholeNights);
});
(data.lettingLedger || []).forEach((e) => {
if (e.kind !== 'earned' && e.kind !== 'accrual') return;
if (e.reservationId && reservationsById.has(e.reservationId)) return; // counted exactly, above
const roomKey = listingToRoom.get(e.listingId);
if (!roomKey) return;
const { counts, total } = nightsByMonthForEntry(e);
if (!total) return;
counts.forEach((nights, ym) => addCount(roomKey, ym, nights));
addDuration(roomKey, [...counts.keys()], e.nights);
});
const daysInMonth = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); };
return rooms.map((room) => ({
room,
pctByMonth: months.map((ym) => {
const dim = daysInMonth(ym);
if (!dim) return null;
const occ = perRoomMonthCount.get(room.key).get(ym) || 0;
return Math.min(1, occ / dim);
}),
avgDurationByMonth: months.map((ym) => {
const b = perRoomMonthDuration.get(room.key).get(ym);
return b && b.stayCount > 0 ? b.nightsSum / b.stayCount : null;
}),
}));
}

function nightRateChartData() {
const current = currentMonthYm();
const baseStart = addMonths(current, -LETTING_CHART_MONTHS_BACK);
const endYm = addMonths(current, LETTING_CHART_MONTHS_FORWARD);
const months = monthRange(baseStart, endYm);
const listings = nightRateListings();
const perListingByMonth = new Map();
listings.forEach((l) => perListingByMonth.set(l.key, new Map()));
const contributions = nightRateContributions();
contributions.forEach(({ listingId, rate, counts }) => {
if (!perListingByMonth.has(listingId)) return;
const byMonth = perListingByMonth.get(listingId);
counts.forEach((nights, ym) => {
if (ym < baseStart || ym > endYm) return;
const bucket = byMonth.get(ym) || { net: 0, nights: 0 };
bucket.net += rate * nights;
bucket.nights += nights;
byMonth.set(ym, bucket);
});
});
const rooms = nightRateRooms();
const roomStats = nightRateRoomStats(months, baseStart, endYm, rooms, contributions);
const occupancy = nightRateOccupancyData(months, baseStart, endYm, rooms);
return { months, listings, perListingByMonth, rooms, roomStats, occupancy, nowIndex: months.indexOf(current) };
}

function renderNightRateChartLegend(listings) {
const el = document.getElementById('night-rate-chart-legend');
if (!el) return;
if (!listings.length) { el.innerHTML = '<span class="settings-note" style="margin:0;">No listings set up yet.</span>'; return; }
el.innerHTML = listings.map((l) => `<label class="letting-chart-legend-item" style="cursor:pointer;">
<input type="checkbox" data-night-rate-listing="${escapeHtml(l.key)}"${nightRateSelectedListings.has(l.key) ? ' checked' : ''}>
<span class="dot ${escapeHtml(l.colour)}"></span>${escapeHtml(l.label)}
</label>`).join('');
el.querySelectorAll('[data-night-rate-listing]').forEach((cb) => {
cb.addEventListener('change', () => {
const key = cb.dataset.nightRateListing;
if (cb.checked) nightRateSelectedListings.add(key); else nightRateSelectedListings.delete(key);
renderNightRateChart();
});
});
}

let nightRateChartHoverIndex = null;
let nightRateChartLastPlot = null;
// 'average' (one line per listing, the original view) or 'candles'
// (high/low/avg per ROOM per month -- asked for directly: a single
// average line hides how wide a room's own rates actually ranged in a
// given month, which candles show at a glance the way a line can't).
let nightRateChartMode = 'average';
// Occupancy is drawn as a subplot in the LOWER THIRD of this SAME
// canvas, under whichever rate view is showing -- asked for directly,
// rather than as its own separate chart below. One hover index and one
// plot now drives both halves (a single canvas, a single x-axis).
const NIGHT_RATE_OCCUPANCY_SHARE = 1 / 3;
let nightRateSelectedRooms = new Set();
let nightRateKnownRoomKeys = new Set();
function syncNightRateRoomSelection(rooms) {
rooms.forEach((r) => {
if (nightRateKnownRoomKeys.has(r.key)) return;
nightRateKnownRoomKeys.add(r.key);
nightRateSelectedRooms.add(r.key);
});
}
function renderNightRateRoomLegend(rooms) {
const el = document.getElementById('night-rate-chart-legend');
if (!el) return;
if (!rooms.length) { el.innerHTML = '<span class="settings-note" style="margin:0;">No listings set up yet.</span>'; return; }
el.innerHTML = rooms.map((r) => `<label class="letting-chart-legend-item" style="cursor:pointer;">
<input type="checkbox" data-night-rate-room="${escapeHtml(r.key)}"${nightRateSelectedRooms.has(r.key) ? ' checked' : ''}>
<span class="dot ${escapeHtml(r.colour)}"></span>${escapeHtml(r.label)}
</label>`).join('');
el.querySelectorAll('[data-night-rate-room]').forEach((cb) => {
cb.addEventListener('change', () => {
const key = cb.dataset.nightRateRoom;
if (cb.checked) nightRateSelectedRooms.add(key); else nightRateSelectedRooms.delete(key);
renderNightRateChart();
});
});
}

function renderNightRateOccupancyLegend(occupancy) {
const el = document.getElementById('night-rate-occupancy-legend');
if (!el) return;
if (!occupancy.length) { el.innerHTML = '<span class="settings-note" style="margin:0;">No listings set up yet.</span>'; return; }
el.innerHTML = occupancy.map((s) => `<span class="letting-chart-legend-item"><span class="dot ${escapeHtml(s.room.colour)}"></span>${escapeHtml(s.room.label)}</span>`).join('');
}

// The occupancy subplot itself -- shared by both the average-line and
// candle draw functions below, since neither changes what occupancy
// looks like. `occPlot` is the lower-third region within the SAME
// canvas (computed by the caller); a thin reserved row at its own top
// holds the average-stay-LENGTH labels (asked for directly), one per
// room per month, skipped wherever a month/room's own slot is too
// narrow to hold a legible number rather than letting labels collide.
function drawOccupancySubplot(ctx, occPlot, months, occupancy, hoverIndex, nowIndex, bw, colors) {
const { lineColor, muted, ink } = colors;
const labelPad = 10;
const barArea = { x: occPlot.x, y: occPlot.y + labelPad, w: occPlot.w, h: occPlot.h - labelPad };

ctx.strokeStyle = lineColor;
ctx.lineWidth = 1;
ctx.fillStyle = muted;
ctx.font = "9px 'Inter', sans-serif";
ctx.textAlign = 'right';
ctx.textBaseline = 'middle';
[0, 1].forEach((t) => {
const y = barArea.y + barArea.h - t * barArea.h;
ctx.beginPath(); ctx.moveTo(barArea.x, y); ctx.lineTo(barArea.x + barArea.w, y); ctx.stroke();
ctx.fillText(`${Math.round(t * 100)}%`, barArea.x - 6, y);
});

if (hoverIndex != null) {
ctx.fillStyle = ink;
ctx.globalAlpha = 0.05;
ctx.fillRect(occPlot.x + hoverIndex * bw, occPlot.y, bw, occPlot.h);
ctx.globalAlpha = 1;
}

// Grouped, not stacked -- two rooms both full doesn't mean "200%", it
// means two separate 100%s -- with a 2px surface gap between adjacent
// rooms' bars.
const roomCount = Math.max(1, occupancy.length);
const groupPad = 4;
const gap = 2;
const barW = Math.max(2, (bw - groupPad * 2 - gap * (roomCount - 1)) / roomCount);
occupancy.forEach((s, ri) => {
const color = resolveColor(listingColorVar(s.room.colour));
ctx.fillStyle = color;
s.pctByMonth.forEach((pct, i) => {
if (pct == null) return;
const h = Math.max(0, Math.min(1, pct)) * barArea.h;
const x = barArea.x + i * bw + groupPad + ri * (barW + gap);
const y = barArea.y + barArea.h - h;
ctx.fillRect(x, y, barW, h);
});
});

if (barW >= 10) {
ctx.font = "8px 'Inter', sans-serif";
ctx.textAlign = 'center';
ctx.textBaseline = 'bottom';
occupancy.forEach((s, ri) => {
const color = resolveColor(listingColorVar(s.room.colour));
ctx.fillStyle = color;
(s.avgDurationByMonth || []).forEach((avg, i) => {
if (avg == null) return;
const cx = barArea.x + i * bw + groupPad + ri * (barW + gap) + barW / 2;
ctx.fillText(`${Math.round(avg)}n`, cx, occPlot.y + labelPad - 1);
});
});
}
}

// Occupancy's own hover lines, appended to whichever rate-mode tooltip
// is already being built -- one combined box, not two. A 0% month is
// skipped entirely rather than printed -- "no stay this month" isn't
// worth a line of its own once it's the common case for an off-season
// month, and every line here costs real vertical space reserved above
// the chart for it (see padTop).
function occupancyTooltipLines(occupancy, hoverIndex) {
if (hoverIndex == null) return [];
return occupancy.map((s) => {
const pct = s.pctByMonth[hoverIndex];
if (!pct) return null;
const avg = s.avgDurationByMonth ? s.avgDurationByMonth[hoverIndex] : null;
return `${s.room.label}: ${Math.round(pct * 100)}% occ${avg != null ? `, avg ${avg.toFixed(1)}n` : ''}`;
}).filter(Boolean);
}

// One line per room, rate AND occupancy together -- used by the candle
// view below, the one place both are already grouped by the same ROOM
// (the average/per-listing view's rate rows and the per-room occupancy
// rows are genuinely different groupings -- see nightRateRooms -- so
// those stay as two separate blocks instead of being force-merged into
// something that doesn't actually correspond 1:1).
function roomCombinedTooltipLine(label, st, pct, avgDur) {
const parts = [];
if (st) parts.push(`${money0(st.low)}–${money0(st.high)} avg ${money0(st.avg)}/n`);
if (pct) parts.push(`${Math.round(pct * 100)}% occ`);
if (avgDur != null) parts.push(`avg ${avgDur.toFixed(1)}n`);
if (!parts.length) return null;
return `${label}: ${parts.join(' · ')}`;
}

function drawNightRateChart(canvas, chartData) {
const { months, listings: allListings, perListingByMonth, occupancy, nowIndex } = chartData;
const listings = allListings.filter((l) => nightRateSelectedListings.has(l.key));
const dpr = window.devicePixelRatio || 1;
const rect = canvas.getBoundingClientRect();
const width = Math.max(1, Math.round(rect.width));
const height = Math.max(1, Math.round(rect.height));
if (!width || !height) return; // canvas is on a hidden tab -- nothing to measure yet
canvas.width = Math.round(width * dpr);
canvas.height = Math.round(height * dpr);
const ctx = canvas.getContext('2d');
ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
ctx.clearRect(0, 0, width, height);

const lineColor = resolveColor('--line');
const muted = resolveColor('--muted');
const ink = resolveColor('--ink');
const paper = resolveColor('--paper');

// padTop reserves a fixed header band for the hover tooltip, same
// reasoning as the income chart above -- it used to sit at plot.y+2,
// right on top of the tallest bars/candles near the hovered month.
const padLeft = 46, padRight = 10, padTop = 62, padBottom = 20;
const totalH = Math.max(10, height - padTop - padBottom);
const occGap = 14;
const occH = Math.round(totalH * NIGHT_RATE_OCCUPANCY_SHARE);
const rateH = Math.max(10, totalH - occH - occGap);
const plot = { x: padLeft, y: padTop, w: Math.max(10, width - padLeft - padRight), h: rateH };
const occPlot = { x: padLeft, y: padTop + rateH + occGap, w: plot.w, h: occH };

// Per-listing, per-month rate -- null where there's no stay that month,
// which is what lets the line below break instead of implying a flat
// rate across a gap it has no data for.
const series = listings.map((l) => ({
l,
rates: months.map((ym) => {
const bucket = perListingByMonth.get(l.key).get(ym);
return bucket && bucket.nights > 0 ? bucket.net / bucket.nights : null;
}),
}));
const allRates = series.flatMap((s) => s.rates).filter((v) => v != null);
const rawMax = Math.max(...allRates, 1);
const rawMin = Math.min(...allRates, 0);
const axisStep = niceLettingAxisStep((rawMax - Math.min(0, rawMin)) / 4);
const axisTop = (Math.floor(rawMax / axisStep) + 1) * axisStep;
const axisBottom = rawMin < 0 ? -(Math.floor(-rawMin / axisStep) + 1) * axisStep : 0;
const span = axisTop - axisBottom || 1;
const scaleY = (v) => plot.y + plot.h - ((v - axisBottom) / span) * plot.h;

ctx.strokeStyle = lineColor;
ctx.lineWidth = 1;
ctx.fillStyle = muted;
ctx.font = "10px 'Inter', sans-serif";
ctx.textAlign = 'right';
ctx.textBaseline = 'middle';
for (let v = axisBottom; v <= axisTop + 0.001; v += axisStep) {
const y = scaleY(v);
ctx.beginPath(); ctx.moveTo(plot.x, y); ctx.lineTo(plot.x + plot.w, y); ctx.stroke();
ctx.fillText(money0(v), plot.x - 6, y);
}
// Zero line drawn a touch heavier, since a negative night rate (the
// cleaning cost exceeding the stay's gross) is the one value on this
// chart worth a reader noticing at a glance.
if (axisBottom < 0) {
ctx.strokeStyle = muted;
ctx.lineWidth = 1.5;
const y0 = scaleY(0);
ctx.beginPath(); ctx.moveTo(plot.x, y0); ctx.lineTo(plot.x + plot.w, y0); ctx.stroke();
}

const n = months.length;
const bw = plot.w / n;
const fullH = { y: plot.y, bottom: occPlot.y + occPlot.h };

if (nowIndex >= 0) {
const nowX = plot.x + (nowIndex + 1) * bw;
ctx.save();
ctx.strokeStyle = muted;
ctx.setLineDash([2, 3]);
ctx.lineWidth = 1;
ctx.beginPath(); ctx.moveTo(nowX, fullH.y); ctx.lineTo(nowX, fullH.bottom); ctx.stroke();
ctx.restore();
}

if (nightRateChartHoverIndex != null) {
ctx.fillStyle = ink;
ctx.globalAlpha = 0.05;
ctx.fillRect(plot.x + nightRateChartHoverIndex * bw, fullH.y, bw, fullH.bottom - fullH.y);
ctx.globalAlpha = 1;
}

// One 2px line per listing (the dataviz mark spec for a line series),
// broken at any month with no stay rather than interpolated across it,
// and a >=7px marker at every real data point -- a gap in the data is
// a real gap, not a rate that happened to sit between two known ones.
series.forEach(({ l, rates }) => {
const color = resolveColor(listingColorVar(l.colour));
ctx.strokeStyle = color;
ctx.lineWidth = 2;
ctx.beginPath();
let drawing = false;
rates.forEach((v, i) => {
if (v == null) { drawing = false; return; }
const x = plot.x + (i + 0.5) * bw;
const y = scaleY(v);
if (!drawing) { ctx.moveTo(x, y); drawing = true; } else { ctx.lineTo(x, y); }
});
ctx.stroke();
ctx.fillStyle = color;
rates.forEach((v, i) => {
if (v == null) return;
const x = plot.x + (i + 0.5) * bw;
const y = scaleY(v);
ctx.beginPath();
ctx.arc(x, y, 3.5, 0, Math.PI * 2);
ctx.fill();
});
});

// Occupancy is per ROOM, this view's own selection is per LISTING --
// a room counts as "shown" if at least one of its own listings is
// currently ticked, same relationship nightRateRooms() already
// establishes between the two. Confirmed live as a real gap: ticking/
// unticking a listing above changed the rate lines but left every
// room's occupancy bars showing regardless.
const occupancyShown = occupancy.filter((o) => o.room.listingIds.some((id) => nightRateSelectedListings.has(id)));
drawOccupancySubplot(ctx, occPlot, months, occupancyShown, nightRateChartHoverIndex, nowIndex, bw, { lineColor, muted, ink });

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
ctx.fillText(monthLabel(ym), plot.x + (i + 0.5) * bw, occPlot.y + occPlot.h + 4);
});

nightRateChartLastPlot = { plot, bw, months };

// Hover tooltip -- rate rows for only the listings with a rate that
// month, then the occupancy subplot's own rows appended beneath, one
// combined box rather than two.
if (nightRateChartHoverIndex != null && months[nightRateChartHoverIndex]) {
const rows = series.map((s) => ({ l: s.l, v: s.rates[nightRateChartHoverIndex] })).filter((r) => r.v != null);
const occLines = occupancyTooltipLines(occupancyShown, nightRateChartHoverIndex);
if (rows.length || occLines.length) {
const lines = [monthLabel(months[nightRateChartHoverIndex]), ...rows.map((r) => `${r.l.label}: ${money0(r.v)}/n`), ...occLines];
ctx.font = "10px 'Inter', sans-serif";
const boxW = Math.max(...lines.map((ln) => ctx.measureText(ln).width)) + 16;
const boxH = lines.length * 14 + 10;
const cx = plot.x + (nightRateChartHoverIndex + 0.5) * bw;
const boxX = Math.min(Math.max(cx - boxW / 2, plot.x), plot.x + plot.w - boxW);
// Pinned near the very top of the canvas, inside padTop's reserved
// header band -- not plot.y (the top of the bars themselves), which is
// what used to put this right on top of the tallest ones.
const boxY = 4;
ctx.fillStyle = paper;
ctx.strokeStyle = lineColor;
ctx.fillRect(boxX, boxY, boxW, boxH);
ctx.strokeRect(boxX, boxY, boxW, boxH);
ctx.fillStyle = ink;
ctx.textAlign = 'left';
ctx.textBaseline = 'alphabetic';
lines.forEach((ln, i) => ctx.fillText(ln, boxX + 8, boxY + 12 + i * 14));
}
}
}

// High/low/avg per room, one candle per room per month -- the mirror
// of drawNightRateChart's per-listing lines above, grouped side by side
// within each month's column (same spacing approach as the occupancy
// bars below) rather than overlapping, so two rooms' candles in the
// same month never sit on top of each other.
function drawNightRateCandleChart(canvas, chartData) {
const { months, roomStats, occupancy, nowIndex } = chartData;
const rooms = roomStats.filter((s) => nightRateSelectedRooms.has(s.room.key));
const dpr = window.devicePixelRatio || 1;
const rect = canvas.getBoundingClientRect();
const width = Math.max(1, Math.round(rect.width));
const height = Math.max(1, Math.round(rect.height));
if (!width || !height) return;
canvas.width = Math.round(width * dpr);
canvas.height = Math.round(height * dpr);
const ctx = canvas.getContext('2d');
ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
ctx.clearRect(0, 0, width, height);

const lineColor = resolveColor('--line');
const muted = resolveColor('--muted');
const ink = resolveColor('--ink');
const paper = resolveColor('--paper');

// padTop reserves a fixed header band for the hover tooltip, same
// reasoning as the income chart above -- it used to sit at plot.y+2,
// right on top of the tallest bars/candles near the hovered month.
const padLeft = 46, padRight = 10, padTop = 62, padBottom = 20;
const totalH = Math.max(10, height - padTop - padBottom);
const occGap = 14;
const occH = Math.round(totalH * NIGHT_RATE_OCCUPANCY_SHARE);
const rateH = Math.max(10, totalH - occH - occGap);
const plot = { x: padLeft, y: padTop, w: Math.max(10, width - padLeft - padRight), h: rateH };
const occPlot = { x: padLeft, y: padTop + rateH + occGap, w: plot.w, h: occH };

const allValues = rooms.flatMap((s) => s.statsByMonth.filter(Boolean).flatMap((st) => [st.high, st.low]));
const rawMax = Math.max(...allValues, 1);
const rawMin = Math.min(...allValues, 0);
const axisStep = niceLettingAxisStep((rawMax - Math.min(0, rawMin)) / 4);
const axisTop = (Math.floor(rawMax / axisStep) + 1) * axisStep;
const axisBottom = rawMin < 0 ? -(Math.floor(-rawMin / axisStep) + 1) * axisStep : 0;
const span = axisTop - axisBottom || 1;
const scaleY = (v) => plot.y + plot.h - ((v - axisBottom) / span) * plot.h;

ctx.strokeStyle = lineColor;
ctx.lineWidth = 1;
ctx.fillStyle = muted;
ctx.font = "10px 'Inter', sans-serif";
ctx.textAlign = 'right';
ctx.textBaseline = 'middle';
for (let v = axisBottom; v <= axisTop + 0.001; v += axisStep) {
const y = scaleY(v);
ctx.beginPath(); ctx.moveTo(plot.x, y); ctx.lineTo(plot.x + plot.w, y); ctx.stroke();
ctx.fillText(money0(v), plot.x - 6, y);
}
if (axisBottom < 0) {
ctx.strokeStyle = muted;
ctx.lineWidth = 1.5;
const y0 = scaleY(0);
ctx.beginPath(); ctx.moveTo(plot.x, y0); ctx.lineTo(plot.x + plot.w, y0); ctx.stroke();
}

const n = months.length;
const bw = plot.w / n;
const fullH = { y: plot.y, bottom: occPlot.y + occPlot.h };

if (nowIndex >= 0) {
const nowX = plot.x + (nowIndex + 1) * bw;
ctx.save();
ctx.strokeStyle = muted;
ctx.setLineDash([2, 3]);
ctx.lineWidth = 1;
ctx.beginPath(); ctx.moveTo(nowX, fullH.y); ctx.lineTo(nowX, fullH.bottom); ctx.stroke();
ctx.restore();
}

if (nightRateChartHoverIndex != null) {
ctx.fillStyle = ink;
ctx.globalAlpha = 0.05;
ctx.fillRect(plot.x + nightRateChartHoverIndex * bw, fullH.y, bw, fullH.bottom - fullH.y);
ctx.globalAlpha = 1;
}

// A vertical high-low wick (2px, the same line weight the average
// view's own lines use) plus a short horizontal tick at the weighted
// average -- not open/close candlesticks (there's no "open" for a
// night rate), just the three numbers that matter here.
const roomCount = Math.max(1, rooms.length);
const groupPad = 4;
const gap = 2;
const slot = (bw - groupPad * 2 - gap * (roomCount - 1)) / roomCount;
const wickW = Math.max(2, Math.min(10, slot));
rooms.forEach((s, ri) => {
const color = resolveColor(listingColorVar(s.room.colour));
s.statsByMonth.forEach((st, i) => {
if (!st) return;
const cx = plot.x + i * bw + groupPad + ri * (slot + gap) + slot / 2;
const yHigh = scaleY(st.high);
const yLow = scaleY(st.low);
const yAvg = scaleY(st.avg);
ctx.strokeStyle = color;
ctx.lineWidth = 2;
ctx.beginPath(); ctx.moveTo(cx, yHigh); ctx.lineTo(cx, Math.max(yHigh, yLow)); ctx.stroke();
if (yLow !== yHigh) { ctx.beginPath(); ctx.moveTo(cx, yHigh); ctx.lineTo(cx, yLow); ctx.stroke(); }
ctx.fillStyle = color;
ctx.fillRect(cx - wickW / 2, yAvg - 1.5, wickW, 3);
});
});

// This view's own selection is already per-ROOM (nightRateSelectedRooms),
// the same grouping occupancy itself uses -- a direct key match, unlike
// the average view's per-listing selection just above. Confirmed live
// as the same real gap: ticking/unticking a room's candle left every
// room's occupancy bars showing regardless.
const occupancyShown = occupancy.filter((o) => nightRateSelectedRooms.has(o.room.key));
drawOccupancySubplot(ctx, occPlot, months, occupancyShown, nightRateChartHoverIndex, nowIndex, bw, { lineColor, muted, ink });

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
ctx.fillText(monthLabel(ym), plot.x + (i + 0.5) * bw, occPlot.y + occPlot.h + 4);
});

nightRateChartLastPlot = { plot, bw, months };

if (nightRateChartHoverIndex != null && months[nightRateChartHoverIndex]) {
// One line per room -- rate and occupancy together, since the candle
// view is the one place both are already grouped by the same room.
const roomLines = rooms.map((s) => {
const st = s.statsByMonth[nightRateChartHoverIndex];
const occEntry = occupancy.find((o) => o.room.key === s.room.key);
const pct = occEntry ? occEntry.pctByMonth[nightRateChartHoverIndex] : null;
const avgDur = occEntry && occEntry.avgDurationByMonth ? occEntry.avgDurationByMonth[nightRateChartHoverIndex] : null;
return roomCombinedTooltipLine(s.room.label, st, pct, avgDur);
}).filter(Boolean);
if (roomLines.length) {
const lines = [monthLabel(months[nightRateChartHoverIndex]), ...roomLines];
ctx.font = "10px 'Inter', sans-serif";
const boxW = Math.max(...lines.map((ln) => ctx.measureText(ln).width)) + 16;
const boxH = lines.length * 14 + 10;
const cx = plot.x + (nightRateChartHoverIndex + 0.5) * bw;
const boxX = Math.min(Math.max(cx - boxW / 2, plot.x), plot.x + plot.w - boxW);
// Pinned near the very top of the canvas, inside padTop's reserved
// header band -- not plot.y (the top of the bars themselves), which is
// what used to put this right on top of the tallest ones.
const boxY = 4;
ctx.fillStyle = paper;
ctx.strokeStyle = lineColor;
ctx.fillRect(boxX, boxY, boxW, boxH);
ctx.strokeRect(boxX, boxY, boxW, boxH);
ctx.fillStyle = ink;
ctx.textAlign = 'left';
ctx.textBaseline = 'alphabetic';
lines.forEach((ln, i) => ctx.fillText(ln, boxX + 8, boxY + 12 + i * 14));
}
}
}

function renderNightRateChart() {
const canvas = document.getElementById('night-rate-chart-canvas');
if (!canvas) return;
const chartData = nightRateChartData();
syncNightRateSelection(chartData.listings);
syncNightRateRoomSelection(chartData.roomStats.map((s) => s.room));
renderNightRateOccupancyLegend(chartData.occupancy);
if (nightRateChartMode === 'candles') {
renderNightRateRoomLegend(chartData.roomStats.map((s) => s.room));
drawNightRateCandleChart(canvas, chartData);
} else {
renderNightRateChartLegend(chartData.listings);
drawNightRateChart(canvas, chartData);
}
}

function initNightRateChart() {
const canvas = document.getElementById('night-rate-chart-canvas');
if (!canvas) return;
canvas.addEventListener('pointermove', (evt) => {
if (!nightRateChartLastPlot) return;
const r = canvas.getBoundingClientRect();
const x = evt.clientX - r.left;
const { plot, bw, months } = nightRateChartLastPlot;
const i = Math.floor((x - plot.x) / bw);
nightRateChartHoverIndex = (i >= 0 && i < months.length) ? i : null;
renderNightRateChart();
});
canvas.addEventListener('pointerleave', () => { nightRateChartHoverIndex = null; renderNightRateChart(); });
document.querySelectorAll('[data-night-rate-mode]').forEach((btn) => {
btn.addEventListener('click', () => {
nightRateChartMode = btn.dataset.nightRateMode;
document.querySelectorAll('[data-night-rate-mode]').forEach((b) => b.classList.toggle('active', b === btn));
nightRateChartHoverIndex = null;
renderNightRateChart();
});
});
document.addEventListener('tabshown', (e) => { if (e.detail?.tab === 'finances') renderNightRateChart(); });
window.addEventListener('resize', renderNightRateChart);
renderNightRateChart();
}

function renderOwnerPicker() {
const sel = document.getElementById('letting-add-owner');
if (!sel) return;
const keep = sel.value;
// Includes yourself -- logging a historic "Earned" figure for your
// own listing (pre-tracking income) is a legitimate real use; see the
// add-button handler below, which uses the same sharePctFor() a real
// stay's accrual uses, no self-exception.
sel.innerHTML = `<option value="">Who…</option>${owners().map((k) => `<option value="${escapeHtml(k)}">${escapeHtml(ownerNameFor(k))}</option>`).join('')}`;
if (keep) sel.value = keep;
}

export {
accrueLettings, renderLetting, initLetting, totalOwed, totalGross, balanceFor, grossFor, owners, ownerNameFor, ownerKeyFor, sharePctFor, shareRuleAt, splitAmountFor, money, isMyOwnKey, isMyOwnListing,
entriesFor, nightRateFor, money0, monthRange, monthLabel, addMonths, today, resolveColor, listingColorVar, nightsByMonthForEntry,
};
