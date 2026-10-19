// Cat sitting mini planner: up to 2 visitors/day during a trip, each day
// covered once at least one visit for it is "firm" (a 2nd visit, e.g.
// AM+PM, is shown but not required). A per-trip day-by-day section is
// mounted into travel.js's tripCardHtml; a rollup strip at the top of
// the main trip list shows every upcoming trip's own coverage at a
// glance, each linking via travel.js's own tripChipHtml/bindTripChips.
//
// Modelled as one record per visitor per day -- the same shape
// planner.js's own day grid already uses for "2 different connections,
// 1 day" (two separate entries sharing one date), not one record
// holding an array of connection ids.
import { data, queueSave, blankCatSittingVisit } from '../state.js';
import { escapeHtml, dateStrAdd, todayStr } from '../utils.js';
import { tripById, tripChipHtml, bindTripChips, renderTravel } from './travel.js';
import { tripRangeFor } from './planner.js';

// ---- Data access + mutation ------------------------------------------

function visitsForTripDay(tripId, date) {
return data.catSittingVisits.filter((v) => v.tripId === tripId && v.date === date);
}
function addVisit(tripId, date, connectionId) {
if (!connectionId || visitsForTripDay(tripId, date).length >= 2) return null;
const v = blankCatSittingVisit({ tripId, date, connectionId });
data.catSittingVisits.push(v);
queueSave();
return v;
}
function removeVisit(id) {
data.catSittingVisits = data.catSittingVisits.filter((v) => v.id !== id);
queueSave();
}
function setVisitStatus(id, status) {
const v = data.catSittingVisits.find((x) => x.id === id);
if (v && (status === 'draft' || status === 'firm')) { v.status = status; queueSave(); }
}

// ---- Coverage gap-checker ----------------------------------------------
//
// Fresh per-day variant of the same SHAPE of problem travel.js's own
// gapsFor/tripGapCount already solve for leg fields -- not a reuse of
// that leg-specific code, which has nothing per-day to walk.
function dayCoverage(tripId, date) {
const visits = visitsForTripDay(tripId, date);
return { date, visits, covered: visits.some((v) => v.status === 'firm') };
}
function tripCoverage(trip) {
const { start, end } = tripRangeFor(trip);
if (!start || !end || start > end) return { days: [], totalDays: 0, firmDays: 0, draftOnlyDays: 0, uncoveredDays: 0 };
const days = [];
let cur = start;
for (let i = 0; i < 60 && cur <= end; i++) { days.push(dayCoverage(trip.id, cur)); cur = dateStrAdd(cur, 1); }
return {
days,
totalDays: days.length,
firmDays: days.filter((d) => d.covered).length,
draftOnlyDays: days.filter((d) => !d.covered && d.visits.length).length,
uncoveredDays: days.filter((d) => !d.covered && !d.visits.length).length,
};
}
function tripCoverageSummaryLabel(cov) {
if (!cov.totalDays) return 'No away dates known yet.';
const parts = [`${cov.firmDays} of ${cov.totalDays} days firm`];
if (cov.draftOnlyDays) parts.push(`${cov.draftOnlyDays} draft`);
if (cov.uncoveredDays) parts.push(`${cov.uncoveredDays} uncovered`);
return parts.join(', ');
}

// ---- Per-trip section (mounted into travel.js's tripCardHtml) -------------

function dayCellHtml(trip, day) {
const chips = day.visits.map((v) => {
const conn = v.connectionId ? data.connections.find((c) => c.id === v.connectionId) : null;
const name = escapeHtml(conn ? conn.name : 'Someone');
return `<span class="tag-chip${v.status === 'draft' ? ' tag-chip-amber' : ''}" data-catsit-visit="${escapeHtml(v.id)}">
${name}
<button type="button" class="leave-status-dot status-${v.status === 'firm' ? 'firm' : 'none'}" data-catsit-cycle="${escapeHtml(v.id)}" title="${v.status === 'draft' ? 'Draft — click to mark firm' : 'Firm — click to mark draft'}"></button>
<span class="tag-x" data-catsit-remove="${escapeHtml(v.id)}">&times;</span>
</span>`;
}).join('');
const pickerId = `catsit-picker-${trip.id}-${day.date}`;
const addRow = day.visits.length < 2
? `<span data-catsit-add-mount="${escapeHtml(trip.id)}:${escapeHtml(day.date)}" data-catsit-picker-id="${pickerId}"></span>`
: '';
return `<div class="alloc-card${day.covered ? '' : ' catsit-day-flag'}" data-catsit-day="${escapeHtml(trip.id)}:${escapeHtml(day.date)}" style="padding:6px 8px;">
<div class="settings-note" style="margin:0 0 4px;">${escapeHtml(day.date)}${day.covered ? '' : ' <span class="tag-chip tag-chip-amber">Uncovered</span>'}</div>
<div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;">${chips}${addRow}</div>
</div>`;
}

function catSittingSectionHtml(trip) {
const cov = tripCoverage(trip);
if (!cov.totalDays) return '';
return `<div class="cat-sitting-section" data-catsitting-section="${escapeHtml(trip.id)}" style="margin-top:8px;">
<h4 style="margin:0 0 4px;">&#128062; Cat sitting</h4>
<div class="settings-note" style="margin:0 0 6px;">${escapeHtml(tripCoverageSummaryLabel(cov))}</div>
<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:6px;">
${cov.days.map((d) => dayCellHtml(trip, d)).join('')}
</div>
</div>`;
}

// ---- Rollup strip -----------------------------------------------------

function catSittingRollupStripHtml() {
const today = todayStr();
const rows = data.trips
.map((trip) => ({ trip, cov: tripCoverage(trip) }))
.filter(({ trip, cov }) => cov.totalDays && (!tripRangeFor(trip).end || tripRangeFor(trip).end >= today));
if (!rows.length) return '';
return `<div class="sync-row" style="align-items:flex-start;flex-wrap:wrap;">${rows.map(({ trip, cov }) =>
tripChipHtml(trip, `<span class="settings-note" style="margin:0 0 0 4px;">${escapeHtml(tripCoverageSummaryLabel(cov))}${cov.uncoveredDays ? ' <span class="tag-chip tag-chip-amber">&#9888;</span>' : ''}</span>`)
).join('')}</div>`;
}
function renderCatSittingRollup() {
const mount = document.getElementById('cat-sitting-rollup-strip');
if (!mount) return;
mount.innerHTML = catSittingRollupStripHtml();
bindTripChips();
}

// ---- Binding (called from travel.js, same as bindPacking) -----------------

function bindCatSitting(root) {
root.querySelectorAll('[data-catsit-cycle]').forEach((btn) => {
btn.addEventListener('click', () => {
const v = data.catSittingVisits.find((x) => x.id === btn.dataset.catsitCycle);
if (v) setVisitStatus(v.id, v.status === 'firm' ? 'draft' : 'firm');
renderTravel();
});
});
root.querySelectorAll('[data-catsit-remove]').forEach((x) => {
x.addEventListener('click', () => { removeVisit(x.dataset.catsitRemove); renderTravel(); });
});
root.querySelectorAll('[data-catsit-add-mount]').forEach((mount) => {
import('./connections.js').then(({ connectionPickerHtml, bindConnPickers }) => {
bindConnPickers();
const [tripId, date] = mount.dataset.catsitAddMount.split(':');
const pickerId = mount.dataset.catsitPickerId;
mount.innerHTML = `${connectionPickerHtml(pickerId, 'Add a sitter…', '')}<button type="button" class="todo-add-btn" data-catsit-add="${escapeHtml(tripId)}:${escapeHtml(date)}:${escapeHtml(pickerId)}">Add</button>`;
const addBtn = mount.querySelector('[data-catsit-add]');
addBtn.addEventListener('click', () => {
const picker = document.getElementById(pickerId);
if (!picker || !picker.value) return;
addVisit(tripId, date, picker.value);
renderTravel();
});
});
});
}

function initCatSitting() {
renderCatSittingRollup();
}

export { tripCoverage, tripCoverageSummaryLabel, catSittingSectionHtml, bindCatSitting, catSittingRollupStripHtml, renderCatSittingRollup, initCatSitting };
