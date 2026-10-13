// Quarterly Airbnb rate-adjustment proposals -- real, confirmed London
// demand dates (concerts, England matches, Wimbledon, NYE...) over a
// long look-ahead window (13 months: a ticket on-sale or a fixture
// list can land many months before the event itself), found by a real
// web search (ai.js's generateAirbnbRateReview), not guessed.
//
// Each run becomes ONE parent task with a subtask per proposed date
// range (js/features/tasks.js's existing parentId mechanism -- a real,
// trackable TODO, not a soft nudge, since a missed pricing window has
// a real £ cost). Ticking a subtask off is what "actioned" means --
// but the record that actually stops that same event being proposed
// again is data.airbnbRateProposals, independent of the task's own
// survival (deleting the task later must not silently reopen the
// event to be re-suggested).
import { data, queueSave } from '../state.js';
import { uid, daysSince } from '../utils.js';

const RATE_REVIEW_RECHECK_DAYS = 91; // ~quarterly, same "approx" the user asked for, not a calendar-exact boundary
// The first run has nothing proposed yet, so it's worth front-loading
// more than a normal quarter's worth -- asked for directly.
const RATE_REVIEW_FIRST_RUN_COUNT = 8;
const RATE_REVIEW_NORMAL_COUNT = 5;
const RATE_REVIEW_WINDOW_MONTHS = 13;

function isDue() {
const lastRunAt = data.prefs.airbnbRateReviewChecks?.lastRunAt;
if (!lastRunAt) return true;
return daysSince(lastRunAt) >= RATE_REVIEW_RECHECK_DAYS;
}

function addMonthsIso(dateStr, months) {
const d = new Date(`${dateStr}T00:00:00`);
d.setMonth(d.getMonth() + months);
return d.toISOString().slice(0, 10);
}

function listingContext() {
return (data.airbnbListings || []).map((l) => ({ id: l.id, label: l.label || l.prefix || 'Listing' }));
}

// "Check now" bypasses isDue entirely, same two-gates-not-one shape
// forceSetCompletionSearch/forceSchoolCalendarCheck already establish
// -- asked for directly, to allow testing re-runs rather than waiting
// out a real quarter.
async function runAirbnbRateReview({ force = false } = {}) {
const { reportCheck } = await import('./sitehealth.js');
if (!force && !isDue()) return null;
const listings = listingContext();
if (!listings.length) {
reportCheck('airbnb-rate-review', true, 'No listings set up yet.');
return 'No listings set up yet.';
}
const today = new Date().toISOString().slice(0, 10);
const windowEnd = addMonthsIso(today, RATE_REVIEW_WINDOW_MONTHS);
const isFirstRun = !data.airbnbRateProposals.length;
const count = isFirstRun ? RATE_REVIEW_FIRST_RUN_COUNT : RATE_REVIEW_NORMAL_COUNT;
const alreadyProposed = data.airbnbRateProposals.map((p) => ({ reason: p.reason, startDate: p.startDate, endDate: p.endDate }));

let proposals;
try {
const { generateAirbnbRateReview } = await import('../ai.js');
proposals = await generateAirbnbRateReview({ listings, windowStart: today, windowEnd, alreadyProposed, count });
} catch (err) {
console.error('Airbnb rate review failed:', err);
reportCheck('airbnb-rate-review', false, err.message || String(err));
return `Couldn't generate proposals: ${err.message || err}`;
}

// A safety net past the prompt's own exclusion list, in case the
// model repeats itself anyway -- drops anything that doesn't resolve
// to a real listing by name, or overlaps (same listing, overlapping
// dates) something already on record.
const fresh = [];
proposals.forEach((p) => {
const listing = listings.find((l) => l.label.trim().toLowerCase() === p.listing.trim().toLowerCase());
if (!listing) return;
const overlaps = data.airbnbRateProposals.some((existing) => existing.listingId === listing.id && p.startDate <= existing.endDate && p.endDate >= existing.startDate);
if (overlaps) return;
fresh.push({ ...p, listingId: listing.id, listingLabel: listing.label });
});

if (!fresh.length) {
data.prefs.airbnbRateReviewChecks = { lastRunAt: new Date().toISOString() };
queueSave();
reportCheck('airbnb-rate-review', true, 'Ran, but nothing new to propose this time.');
return 'Nothing new to propose this run.';
}

const { captureTask } = await import('./tasks.js');
const quarterLabel = new Date().toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
const parent = captureTask({
title: `Airbnb rate review — ${quarterLabel}`,
notes: `${fresh.length} suggested date range${fresh.length === 1 ? '' : 's'} to consider a rate uplift for, based on real London events over the next ${RATE_REVIEW_WINDOW_MONTHS} months. Tick off each one once you've actually changed the rate on Airbnb (or decided not to) -- that's what stops it being proposed again next time.`,
bucket: 'next',
source: { kind: 'airbnb-rate-review', label: 'Airbnb rate review', url: '' },
});
fresh.forEach((p) => {
const upliftText = p.upliftPct != null ? `+${p.upliftPct}%` : p.upliftAmount != null ? `+£${p.upliftAmount}` : 'uplift TBC';
const minStayText = p.minStayNights != null ? `, min ${p.minStayNights} night${p.minStayNights === 1 ? '' : 's'}` : '';
const sub = captureTask({
title: `${p.listingLabel}: ${p.startDate} → ${p.endDate} — ${upliftText}${minStayText} (${p.reason})`,
notes: p.notes || '',
bucket: 'next',
parentId: parent.id,
source: { kind: 'airbnb-rate-review', label: p.reason, url: '' },
});
data.airbnbRateProposals.push({
id: uid(), listingId: p.listingId, startDate: p.startDate, endDate: p.endDate, reason: p.reason,
upliftPct: p.upliftPct, upliftAmount: p.upliftAmount, minStayNights: p.minStayNights, notes: p.notes,
proposedAt: new Date().toISOString(), taskId: parent.id, subtaskId: sub.id,
});
});
data.prefs.airbnbRateReviewChecks = { lastRunAt: new Date().toISOString() };
queueSave();
const summary = `Proposed ${fresh.length} date range${fresh.length === 1 ? '' : 's'} as "${parent.title}" in Tasks.`;
reportCheck('airbnb-rate-review', true, summary);
return summary;
}

async function forceAirbnbRateReview() {
return runAirbnbRateReview({ force: true });
}

function initAirbnbRateReview() {
const btn = document.getElementById('airbnb-rate-review-btn');
if (!btn) return;
btn.addEventListener('click', async () => {
const status = document.getElementById('airbnb-rate-review-status');
btn.disabled = true;
if (status) status.textContent = 'Searching…';
try {
// Same stale-reference reasoning every other force-button in this
// app already follows (shopping.js's set-completion/resale buttons)
// -- this call re-renders nothing of its own (the result lands in
// Tasks, not here), so there's no re-render to race against, but the
// status span itself is still read fresh in case this button's own
// panel re-rendered for an unrelated reason while the search ran.
const summary = await forceAirbnbRateReview();
const freshStatus = document.getElementById('airbnb-rate-review-status');
if (freshStatus) freshStatus.textContent = summary || 'Nothing to propose right now.';
} catch (err) {
const freshStatus = document.getElementById('airbnb-rate-review-status');
if (freshStatus) freshStatus.textContent = `Couldn't run: ${err.message || err}`;
} finally {
btn.disabled = false;
}
});
}

export { runAirbnbRateReview, forceAirbnbRateReview, initAirbnbRateReview };
