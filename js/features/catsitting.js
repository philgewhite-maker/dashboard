// Cat sitting mini planner: each visit is a SITTER ASSIGNMENT spanning a
// real date range, not one record per day -- confirmed live as a real
// complaint about the original one-row-per-day grid ("way too bulky").
// Modelled directly on airbnb.js's own cleanerChipHtml: a filled chip per
// real assignment, a dashed "TBC" pending chip per date range the trip
// isn't covered for yet (clicking it opens an inline add-form, same
// toggle-to-form pattern), a day "covered" once at least one assignment
// over it is "firm" (a 2nd, overlapping assignment is allowed but not
// required). A per-trip section is mounted into travel.js's tripCardHtml;
// a rollup strip at the top of the main trip list shows every upcoming
// trip's own coverage at a glance, via travel.js's own tripChipHtml/
// bindTripChips.
//
// Also scans catinaflat.com's own "Your booking has been made." emails
// to capture real bookings automatically -- see runCatSittingEmailImport
// below. The sitter name is plain text, deliberately never auto-linked to
// a Connection (confirmed live as a real risk: a sitter can share a first
// name with someone already in Connections -- the user's own daughter is
// also "Zara" -- so guessing that match would silently misattribute a
// real booking to the wrong person).
import { data, queueSave, blankCatSittingVisit } from '../state.js';
import { escapeHtml, dateStrAdd, todayStr } from '../utils.js';
import { tripById, tripChipHtml, bindTripChips, renderTravel } from './travel.js';
import { tripRangeFor } from './planner.js';
import { canAttemptGoogleAction } from '../sync/googleauth.js';
import { recordMail, registerRetry } from './mailledger.js';

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// ---- Data access + mutation ------------------------------------------

function visitsForTrip(tripId) {
return data.catSittingVisits.filter((v) => v.tripId === tripId);
}
function addVisit(tripId, startDate, endDate, sitterName) {
if (!sitterName || !startDate || !endDate || startDate > endDate) return null;
const v = blankCatSittingVisit({ tripId, startDate, endDate, sitterName, status: 'draft' });
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

// ---- Coverage + gap-finder ---------------------------------------------

function dayCoverage(tripId, date) {
const visits = visitsForTrip(tripId).filter((v) => v.startDate <= date && date <= v.endDate);
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

// Contiguous date ranges within the trip that NO firm assignment covers
// -- each becomes its own "TBC" pending chip, so a trip half-covered by
// one sitter shows exactly which part still needs one, not a single
// all-or-nothing flag for the whole trip.
function gapsForTrip(trip) {
const cov = tripCoverage(trip);
const gaps = [];
let gapStart = null;
let prev = null;
cov.days.forEach((d) => {
if (!d.covered) {
if (!gapStart) gapStart = d.date;
} else if (gapStart) {
gaps.push({ start: gapStart, end: prev });
gapStart = null;
}
prev = d.date;
});
if (gapStart) gaps.push({ start: gapStart, end: prev });
return gaps;
}

function formatDateRange(start, end) {
const fmt = (d) => {
const dt = new Date(`${d}T00:00:00`);
return `${dt.getDate()} ${dt.toLocaleDateString('en-GB', { month: 'short' })}`;
};
return start === end ? fmt(start) : `${fmt(start)} – ${fmt(end)}`;
}

// ---- Per-trip section (mounted into travel.js's tripCardHtml) -------------

function visitChipHtml(v) {
const name = escapeHtml(v.sitterName || 'Someone');
return `<span class="cal-badge cleaner-chip" data-catsit-visit="${escapeHtml(v.id)}">
${name}: ${escapeHtml(formatDateRange(v.startDate, v.endDate))}
<button type="button" class="leave-status-dot status-${v.status === 'firm' ? 'firm' : 'draft'}" data-catsit-cycle="${escapeHtml(v.id)}" title="${v.status === 'draft' ? 'Draft — click to mark firm' : 'Firm — click to mark draft'}"></button>
<span class="tag-x" data-catsit-remove="${escapeHtml(v.id)}">&times;</span>
</span>`;
}

// Same toggle-to-inline-form pattern as airbnb.js's own cleanerChipHtml --
// a dashed "TBC" chip that expands into Who/start/end inputs on click,
// prefilled to exactly this gap's own range.
const openGapForms = new Set();
function gapChipHtml(trip, gap) {
const key = `${trip.id}:${gap.start}`;
const label = formatDateRange(gap.start, gap.end);
if (!openGapForms.has(key)) {
return `<span class="cal-badge cleaner-chip-tbc" data-catsit-gap-toggle="${escapeHtml(key)}" title="Click to add who's covering this">${escapeHtml(label)}: TBC</span>`;
}
return `<span class="cal-badge cleaner-chip-form">
<input type="text" autocomplete="off" class="tag-add-input" placeholder="Who" data-catsit-gap-name="${escapeHtml(key)}" style="max-width:90px;">
<input type="date" class="tag-add-input" data-catsit-gap-start="${escapeHtml(key)}" value="${escapeHtml(gap.start)}" style="max-width:130px;">
<input type="date" class="tag-add-input" data-catsit-gap-end="${escapeHtml(key)}" value="${escapeHtml(gap.end)}" style="max-width:130px;">
<button class="sync-btn sm inline" type="button" data-catsit-gap-add="${escapeHtml(key)}">Add</button>
<span class="tag-x" data-catsit-gap-cancel="${escapeHtml(key)}" title="Cancel">&times;</span>
</span>`;
}

function catSittingSectionHtml(trip) {
const cov = tripCoverage(trip);
if (!cov.totalDays) return '';
const visits = [...visitsForTrip(trip.id)].sort((a, b) => a.startDate.localeCompare(b.startDate));
const gaps = gapsForTrip(trip);
return `<div class="cat-sitting-section" data-catsitting-section="${escapeHtml(trip.id)}" style="margin-top:8px;">
<h4 style="margin:0 0 4px;">&#128062; Cat sitting</h4>
<div class="settings-note" style="margin:0 0 6px;">${escapeHtml(tripCoverageSummaryLabel(cov))}</div>
<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
${visits.map(visitChipHtml).join('')}
${gaps.map((g) => gapChipHtml(trip, g)).join('')}
</div>
</div>`;
}

// ---- Rollup strip -----------------------------------------------------

function catSittingRollupStripHtml() {
const today = todayStr();
const rows = data.trips
.map((trip) => ({ trip, cov: tripCoverage(trip) }))
.filter(({ trip, cov }) => cov.totalDays && (!tripRangeFor(trip).end || tripRangeFor(trip).end >= today));
// Bookings no single trip covers yet -- shown here so they can't go missing.
const orphans = data.catSittingVisits.filter((v) => !v.tripId && v.endDate >= today).sort((a, b) => a.startDate.localeCompare(b.startDate));
if (!rows.length && !orphans.length) return '';
const tripsHtml = rows.length ? `<div class="sync-row" style="align-items:flex-start;flex-wrap:wrap;">${rows.map(({ trip, cov }) =>
tripChipHtml(trip, `<span class="settings-note" style="margin:0 0 0 4px;">${escapeHtml(tripCoverageSummaryLabel(cov))}${cov.uncoveredDays ? ' <span class="tag-chip tag-chip-amber">&#9888;</span>' : ''}</span>`)
).join('')}</div>` : '';
const orphanHtml = orphans.length ? `<div class="sync-row" style="align-items:flex-start;flex-wrap:wrap;gap:6px;">
<span class="settings-note" style="margin:0;">&#9888; Booked, but no single trip covers these dates yet (they attach once one does):</span>
${orphans.map(visitChipHtml).join('')}
</div>` : '';
return tripsHtml + orphanHtml;
}
function renderCatSittingRollup() {
const mount = document.getElementById('cat-sitting-rollup-strip');
if (!mount) return;
attachOrphanVisits();
mount.innerHTML = catSittingRollupStripHtml();
bindTripChips();
bindCatSitting(mount);
}

// ---- catinaflat.com email import ---------------------------------------
//
// Real example confirmed live (Gmail connector, "catinaflat@e.catinaflat.com",
// 22 Oct 2026 message, real text/plain MIME part): subject "Your booking
// has been made.", body "Katsu's Itinerary / Date(s): 25th Oct 2026 - 27th
// Oct 2026 / Owner: Phil / Sitter: Zara / You paid: £34.50" -- each field
// on its own line, no whitespace traps, BOTH dates carry their own year
// (no year-inference needed, unlike the Airbnb cancellation template).
// Four more real examples (Alfryd, Hayley, different dates/amounts)
// confirmed the same shape holds. No booking/reservation id anywhere in
// the email, so a trip is matched purely by whether the stay's dates fall
// entirely within a trip's own away-dates -- genuinely ambiguous (none,
// or more than one trip) is left unmatched (tripId stays blank) rather
// than guessed; the visit itself is still captured either way.
const CATINAFLAT_QUERY = 'from:(catinaflat@e.catinaflat.com) subject:"Your booking has been made"';
const CATINAFLAT_SEARCH_LIMIT = 25;
const CATINAFLAT_DATE_RE = /Date\(s\):\s*(\d{1,2})(?:st|nd|rd|th)\s+([A-Za-z]+)\s+(\d{4})\s*[-–—]\s*(\d{1,2})(?:st|nd|rd|th)\s+([A-Za-z]+)\s+(\d{4})/i;
const CATINAFLAT_SITTER_RE = /Sitter:\s*([^\n]+)/i;
const CATINAFLAT_PAID_RE = /You paid:\s*£([\d,]+\.?\d*)/i;

function matchTripForDates(startDate, endDate) {
const candidates = data.trips.filter((t) => {
const r = tripRangeFor(t);
return r.start && r.end && startDate >= r.start && endDate <= r.end;
});
return candidates.length === 1 ? candidates[0].id : '';
}

// What the ledger records for a visit: on a trip it's that trip's chip; a
// visit no single trip covers yet is flagged as waiting for one.
function visitOutcome(visit) {
const range = formatDateRange(visit.startDate, visit.endDate);
if (visit.tripId && tripById(visit.tripId)) {
const trip = tripById(visit.tripId);
return { outcome: 'filed', note: `${visit.sitterName}, ${range}`, produced: [{ kind: 'trip', id: trip.id, label: trip.title }] };
}
return {
outcome: 'waiting',
note: `${visit.sitterName}, ${range}: no single trip covers these dates yet. It attaches itself once one does.`,
produced: [{ kind: 'catvisit', id: visit.id, label: `Cat-sitting visit ${range}` }],
};
}

// Reads one catinaflat email and files it as a visit (or updates the visit it
// already made). The scan and the ledger's Retry button both come through here,
// so a retried email takes exactly the path a fresh one does. Returns true when
// the email was a booking, false when it wasn't recognised.
function fileCatSittingEmail(summary, detail) {
const bodyText = detail.bodyText || '';
const meta = { id: summary.id, from: detail.from || summary.from, subject: detail.subject || summary.subject, date: detail.date || summary.date, snippet: summary.snippet };
const dateMatch = CATINAFLAT_DATE_RE.exec(bodyText);
const sitterMatch = CATINAFLAT_SITTER_RE.exec(bodyText);
const startMonth = dateMatch ? MONTH_NAMES.indexOf(dateMatch[2].slice(0, 3).toLowerCase()) : -1;
const endMonth = dateMatch ? MONTH_NAMES.indexOf(dateMatch[5].slice(0, 3).toLowerCase()) : -1;
if (!dateMatch || !sitterMatch || startMonth === -1 || endMonth === -1) {
recordMail(meta, 'catsitting', 'nomatch', { note: !dateMatch ? 'No "Date(s):" line found in the email.' : !sitterMatch ? 'No "Sitter:" line found in the email.' : 'The month name was not recognised.' });
return false;
}
const startDate = `${dateMatch[3]}-${String(startMonth + 1).padStart(2, '0')}-${String(dateMatch[1]).padStart(2, '0')}`;
const endDate = `${dateMatch[6]}-${String(endMonth + 1).padStart(2, '0')}-${String(dateMatch[4]).padStart(2, '0')}`;
const sitterName = sitterMatch[1].trim();
const paidMatch = CATINAFLAT_PAID_RE.exec(bodyText);
const cost = paidMatch ? Number(paidMatch[1].replace(/,/g, '')) : null;

let visit = data.catSittingVisits.find((v) => v.sourceMessageId === summary.id);
if (!visit) {
// A real, paid booking confirmation -- 'firm', not 'draft', unlike a
// hand-added placeholder that still needs confirming.
visit = blankCatSittingVisit({ startDate, endDate, sitterName, status: 'firm', cost, sourceMessageId: summary.id });
data.catSittingVisits.push(visit);
}
if (!visit.tripId) visit.tripId = matchTripForDates(visit.startDate, visit.endDate);
const { outcome, note, produced } = visitOutcome(visit);
recordMail(meta, 'catsitting', outcome, { note, produced });
return true;
}

// A visit saved before its trip existed attaches itself the moment exactly one
// trip covers its dates, instead of waiting for the next email check.
function attachOrphanVisits() {
let changed = false;
data.catSittingVisits.forEach((v) => {
if (v.tripId || !v.sourceMessageId) return;
const tripId = matchTripForDates(v.startDate, v.endDate);
if (!tripId) return;
v.tripId = tripId;
const { outcome, note, produced } = visitOutcome(v);
recordMail({ id: v.sourceMessageId }, 'catsitting', outcome, { note, produced });
changed = true;
});
if (changed) queueSave();
return changed;
}

async function runCatSittingEmailImport() {
if (!(await canAttemptGoogleAction())) return { added: 0, error: 'Sign in to Google at the top of Overview first.' };
if (!Array.isArray(data.prefs.catSittingImportSeen)) data.prefs.catSittingImportSeen = [];
const seen = new Set(data.prefs.catSittingImportSeen);
attachOrphanVisits();

const { fetchMailSearches, getMessageDetail } = await import('../googlemail.js');
const search = { kind: 'query', value: CATINAFLAT_QUERY, maxDays: 0, maxEvents: CATINAFLAT_SEARCH_LIMIT };
let sections;
try {
sections = await fetchMailSearches([search], CATINAFLAT_SEARCH_LIMIT);
} catch (err) {
return { added: 0, error: err.message || String(err) };
}

let added = 0;
let unmatched = 0;
for (const m of sections[0]?.messages || []) {
const visit = data.catSittingVisits.find((v) => v.sourceMessageId === m.id);
if (seen.has(m.id) || visit) {
// Handled before the ledger existed: give it a row (never overwriting a real outcome).
if (visit) { const { outcome, note, produced } = visitOutcome(visit); recordMail(m, 'catsitting', outcome, { note, produced, onlyIfMissing: true }); }
else recordMail(m, 'catsitting', 'seen', { note: 'Read by an earlier check; nothing was filed.', onlyIfMissing: true });
seen.add(m.id);
continue;
}
let detail;
try { detail = await getMessageDetail(m.id); } catch (err) {
// transient fetch failure -- try again next check
recordMail(m, 'catsitting', 'failed', { note: `Could not read the email: ${err.message || err}` });
continue;
}
if (fileCatSittingEmail(m, detail)) added++; else unmatched++;
seen.add(m.id);
}
data.prefs.catSittingImportSeen = [...seen];
if (added || unmatched) queueSave();
return { added, unmatched };
}

// The ledger's Retry button: re-reads this one email and files it again.
async function retryCatSittingMessage(entry) {
const { getMessageDetail } = await import('../googlemail.js');
let detail;
try { detail = await getMessageDetail(entry.messageId); } catch (err) {
recordMail({ id: entry.messageId }, 'catsitting', 'failed', { note: `Could not read the email: ${err.message || err}` });
return;
}
fileCatSittingEmail({ id: entry.messageId, from: entry.from, subject: entry.subject, date: entry.date }, detail);
renderTravel();
renderCatSittingRollup();
}
registerRetry('catsitting', { retry: retryCatSittingMessage });

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
root.querySelectorAll('[data-catsit-gap-toggle]').forEach((chip) => {
chip.addEventListener('click', () => { openGapForms.add(chip.dataset.catsitGapToggle); renderTravel(); });
});
root.querySelectorAll('[data-catsit-gap-cancel]').forEach((x) => {
x.addEventListener('click', () => { openGapForms.delete(x.dataset.catsitGapCancel); renderTravel(); });
});
root.querySelectorAll('[data-catsit-gap-add]').forEach((btn) => {
btn.addEventListener('click', () => {
const key = btn.dataset.catsitGapAdd;
const tripId = key.split(':')[0];
const nameInput = root.querySelector(`[data-catsit-gap-name="${key}"]`);
const startInput = root.querySelector(`[data-catsit-gap-start="${key}"]`);
const endInput = root.querySelector(`[data-catsit-gap-end="${key}"]`);
const name = nameInput?.value.trim();
if (!name || !startInput?.value || !endInput?.value) return;
addVisit(tripId, startInput.value, endInput.value, name);
openGapForms.delete(key);
renderTravel();
});
});
}

function initCatSitting() {
renderCatSittingRollup();
const btn = document.getElementById('catsitting-check-btn');
const status = document.getElementById('catsitting-check-status');
btn?.addEventListener('click', async () => {
btn.disabled = true;
status.textContent = 'Checking…';
try {
const result = await runCatSittingEmailImport();
status.textContent = result.error ? result.error
: `Checked — ${result.added} new booking${result.added === 1 ? '' : 's'} captured${result.unmatched ? `, ${result.unmatched} email${result.unmatched === 1 ? '' : 's'} not recognised` : ''}.`;
renderTravel();
renderCatSittingRollup();
} catch (err) {
status.textContent = err.message || String(err);
} finally {
btn.disabled = false;
}
});
}

export { tripCoverage, tripCoverageSummaryLabel, catSittingSectionHtml, bindCatSitting, catSittingRollupStripHtml, renderCatSittingRollup, initCatSitting, runCatSittingEmailImport };
