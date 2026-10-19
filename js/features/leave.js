// Annual leave tracking: 30 days/year (1 April -> 31 March), allocated
// to trips as draft/firm/approved, auto-computed from each trip's own
// date range (weekdays only, UK bank holidays excluded). Edited on the
// trip's own card (leaveControlHtml, mounted by travel.js); this module
// also renders the read-only Annual Leave summary panel, which links
// back to each trip via travel.js's own tripChipHtml/bindTripChips --
// per CLAUDE.md's record-reference rule, never a second trip-reference
// pattern.
import { data, queueSave, blankLeaveYear } from '../state.js';
import { escapeHtml, dateStrAdd, todayStr } from '../utils.js';
import { tripById, tripChipHtml, bindTripChips, renderTravel } from './travel.js';
import { tripRangeFor } from './planner.js';

// ---- Bank holidays -------------------------------------------------------
//
// Reuses schoolcalendar.js's own fetchGovUkHolidays verbatim (not
// reimplemented) -- that function's own comment already documents it as
// "not year-scoped (one feed, several years) -- fetched once and cached
// for the life of this module", so one fetch here is enough; this
// module's own cache just avoids a second network round-trip for the
// SAME england-and-wales division schoolcalendar.js may also have asked
// for. Hardcoded to england-and-wales -- there's no data.prefs country/
// locale field to key off, and it matches the user's own existing Leeds
// school-site config.
let bankHolidaysCache = null;
let bankHolidaysLoading = null;
async function loadBankHolidays() {
if (bankHolidaysCache) return bankHolidaysCache;
if (!bankHolidaysLoading) {
bankHolidaysLoading = import('./schoolcalendar.js')
.then(({ fetchGovUkHolidays }) => fetchGovUkHolidays('england-and-wales'))
.then((hols) => { bankHolidaysCache = hols; return hols; });
}
return bankHolidaysLoading;
}

// ---- Holiday-year math ----------------------------------------------------

function holidayYearStart(dateStr) {
const y = Number(dateStr.slice(0, 4));
const m = Number(dateStr.slice(5, 7));
return `${m >= 4 ? y : y - 1}-04-01`;
}
function holidayYearLabel(startDate) {
const y = Number(startDate.slice(0, 4));
return `${y}/${String(y + 1).slice(2)}`;
}

// ---- Per-trip day computation ----------------------------------------------

function isWeekendDate(dateStr) {
const d = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
return d === 0 || d === 6;
}

// Weekdays only, minus any UK bank holiday landing on a weekday --
// weekends are never counted (you wouldn't book leave for a Saturday).
// Capped at 60 days of iteration, same convention planner.js's own
// tripRangeFor-consuming code already uses for a day-by-day walk.
function computeLeaveDays(trip, holidays) {
const { start, end } = tripRangeFor(trip);
if (!start || !end || start > end) return 0;
const holidaySet = new Set((holidays || []).map((h) => h.date));
let n = 0;
let cur = start;
for (let i = 0; i < 60 && cur <= end; i++) {
if (!isWeekendDate(cur) && !holidaySet.has(cur)) n++;
cur = dateStrAdd(cur, 1);
}
return n;
}
function effectiveLeaveDays(trip, holidays) {
return trip.leaveDaysOverride != null ? trip.leaveDaysOverride : computeLeaveDays(trip, holidays);
}

// ---- Leave-year records ----------------------------------------------------

function ensureLeaveYear(startDate) {
let y = data.leaveYears.find((x) => x.startDate === startDate);
if (!y) { y = blankLeaveYear({ startDate }); data.leaveYears.push(y); queueSave(); }
return y;
}
function setLeaveYearEntitlement(startDate, days) {
const y = ensureLeaveYear(startDate);
y.entitlementDays = Number(days) || 0;
queueSave();
}

// Running/cascading remainder, most-certain status first -- approved is
// locked in with work, firm is the user's own settled intent, draft is
// tentative, so each one eats further into what's left rather than one
// flat "remaining" figure treating all three the same way. Reported
// directly as wanted this way.
function runningTotals(subtotals, entitlementDays) {
const afterApproved = entitlementDays - subtotals.approved;
const afterFirm = afterApproved - subtotals.firm;
const afterDraft = afterFirm - subtotals.draft;
return { afterApproved, afterFirm, afterDraft };
}

// Bespoke, not healthrollup.js's aggregateByPeriod -- that helper
// averages numeric fields over a calendar month/quarter/year, this
// SUMS a day-count over a custom 1-April boundary, two mismatches.
function leaveYearGroups(holidays) {
ensureLeaveYear(holidayYearStart(todayStr())); // always visible, even with 0 trips
data.trips.filter((t) => t.leaveStatus).forEach((t) => {
const { start } = tripRangeFor(t);
if (start) ensureLeaveYear(holidayYearStart(start));
});
const groups = new Map(data.leaveYears.map((y) => [y.startDate, { ...y, trips: [], subtotals: { draft: 0, firm: 0, approved: 0 } }]));
data.trips.filter((t) => t.leaveStatus).forEach((t) => {
const { start } = tripRangeFor(t);
if (!start) return;
const g = groups.get(holidayYearStart(start));
if (!g) return;
const days = effectiveLeaveDays(t, holidays);
g.trips.push({ trip: t, days });
g.subtotals[t.leaveStatus] += days;
});
return [...groups.values()]
.map((g) => ({ ...g, running: runningTotals(g.subtotals, g.entitlementDays) }))
.sort((a, b) => b.startDate.localeCompare(a.startDate));
}

// ---- Per-trip control (mounted into travel.js's tripCardHtml) -------------

const LEAVE_STATUS_ORDER = ['', 'draft', 'firm', 'approved'];
const LEAVE_STATUS_TITLES = {
'': 'Not tracked as leave — click to mark draft',
draft: 'Draft — click to mark firm',
firm: 'Firm — click to mark approved',
approved: 'Approved — click to clear',
};

function leaveControlHtml(trip) {
const status = trip.leaveStatus || '';
const days = status ? effectiveLeaveDays(trip, bankHolidaysCache || []) : 0;
return `<div class="alloc-card" style="margin-top:8px;padding:6px 10px;" data-leave-block="${escapeHtml(trip.id)}">
<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
<button type="button" class="leave-status-dot status-${status || 'none'}" data-leave-cycle="${escapeHtml(trip.id)}" title="${escapeHtml(LEAVE_STATUS_TITLES[status])}"></button>
<span class="field-label" style="margin:0;">Annual leave</span>
${status ? `
<span class="settings-note" style="margin:0;">${bankHolidaysCache ? `${days} day${days === 1 ? '' : 's'} (weekdays, bank holidays excluded)` : 'Loading bank holidays…'}</span>
<input type="number" min="0" step="0.5" data-leave-override="${escapeHtml(trip.id)}" value="${trip.leaveDaysOverride ?? ''}" placeholder="auto" style="width:64px;" title="Manual override — blank uses the auto-computed day count">
` : ''}
</div>
</div>`;
}

function cycleLeaveStatus(tripId) {
const t = tripById(tripId);
if (!t) return;
t.leaveStatus = LEAVE_STATUS_ORDER[(LEAVE_STATUS_ORDER.indexOf(t.leaveStatus || '') + 1) % LEAVE_STATUS_ORDER.length];
queueSave();
}

// Bound from travel.js (the control lives inside a trip card travel.js
// owns). Mutates then calls the real renderTravel() -- same full
// re-render-after-mutation idiom travel.js's own handlers already use
// (e.g. data-trip-add-person), which naturally throws away the old DOM
// (and its listeners) rather than needing a manual patch-and-rebind.
function bindLeaveControls(root) {
root.querySelectorAll('[data-leave-cycle]').forEach((btn) => {
btn.addEventListener('click', () => {
cycleLeaveStatus(btn.dataset.leaveCycle);
renderTravel();
renderLeave();
});
});
root.querySelectorAll('[data-leave-override]').forEach((input) => {
input.addEventListener('change', () => {
const t = tripById(input.dataset.leaveOverride);
if (t) { t.leaveDaysOverride = input.value === '' ? null : Number(input.value); queueSave(); }
renderTravel();
renderLeave();
});
});
}

// ---- Panel render -----------------------------------------------------

function leaveYearGroupHtml(g) {
const r = g.running;
return `<div class="account-card" style="margin-bottom:10px;">
<div class="account-summary" style="cursor:default;align-items:center;">
<strong>${escapeHtml(holidayYearLabel(g.startDate))}</strong>
<span class="settings-note" style="margin:0;">Entitlement <input type="number" min="0" step="0.5" data-leave-year-entitlement="${escapeHtml(g.startDate)}" value="${g.entitlementDays}" style="width:56px;"> days</span>
</div>
<div class="settings-note" style="margin:0 0 6px;">Draft ${g.subtotals.draft} · Firm ${g.subtotals.firm} · Approved ${g.subtotals.approved} — ${g.entitlementDays} entitlement &rarr; ${r.afterApproved} after approved &rarr; ${r.afterFirm} after firm &rarr; ${r.afterDraft} after draft</div>
${g.trips.length
? g.trips.map(({ trip, days }) => `<div class="loyalty-reading" style="padding:4px 0;">${tripChipHtml(trip)}<span class="tag-chip" style="margin-left:6px;">${escapeHtml(LEAVE_STATUS_TITLES[trip.leaveStatus].split(' —')[0])}</span><span class="settings-note" style="margin:0 0 0 8px;">${days} day${days === 1 ? '' : 's'}</span></div>`).join('')
: '<div class="empty">No trips allocated yet.</div>'}
</div>`;
}

async function renderLeave() {
const el = document.getElementById('leave-list');
if (!el) return;
const holidays = await loadBankHolidays().catch(() => []);
el.innerHTML = leaveYearGroups(holidays).map(leaveYearGroupHtml).join('');
bindTripChips();
el.querySelectorAll('[data-leave-year-entitlement]').forEach((input) => {
input.addEventListener('change', () => { setLeaveYearEntitlement(input.dataset.leaveYearEntitlement, input.value); renderLeave(); });
});
}

function initLeave() {
renderLeave();
loadBankHolidays().then(() => { renderLeave(); }).catch(() => {});
}

export { computeLeaveDays, effectiveLeaveDays, leaveControlHtml, bindLeaveControls, renderLeave, initLeave, holidayYearLabel };
