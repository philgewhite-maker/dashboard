// The Planner tab: a 14-day grid of drop-target day boxes, fed by two
// draggable pools (priority connections, a reusable "things to do" list),
// each placement markable draft or firm. Trips already in data.trips get
// their own mini version of the same grid further down the page, scoped to
// that trip's own known dates, with its existing legs (flights/
// accommodation/etc.) shown read-only for context. See
// js/state.js's blankPlannerEntry/blankPlannerActivity for the data shapes.
//
// Drag-and-drop mechanics deliberately mirror tasks.js's bindAllocation
// (the Tasks tab's Inbox allocation workspace) rather than inventing a new
// pattern: draggable="true" + dragstart setting a text/plain dataTransfer
// payload, .dragging/.over CSS classes already defined in style.css for
// that feature and reused here unchanged. Extended for this tab's several
// drag sources by tagging the payload's kind: "connection:<id>",
// "activity:<id>", or "entry:<entryId>" for an already-placed card being
// dragged to a different day.
import { data, queueSave, blankPlannerEntry, blankPlannerActivity, isDormantStage, isTravelPaused, LEG_DATE_FIELDS } from '../state.js';
import { escapeHtml, uid, todayStr, dateStrAdd, avatarHtml, hydratePhotoBackgrounds, bindForm, foldDiacritics, scrollAndFlash, parseLooseDateTime } from '../utils.js';
import { isPriorityConnection, renderConnPicker, bindConnPickers, expandConnection } from './connections.js';
import { switchTab } from '../tabs.js';
import { revealTrip } from './travel.js';
import { airbnbSegmentsForDay } from './airbnb.js';

// The 14-day grid (and a long trip's mini-grid) routinely runs well past
// the fold, but native HTML5 drag-and-drop does NOT auto-scroll the page
// as the cursor nears the viewport edge -- confirmed live: dragging a
// connection toward a day box below the bottom of the screen just has the
// cursor stall there with no way to reach it short of dropping, scrolling
// manually, and dragging again. Guarded by plannerDragActive (set true/
// false around every planner-sourced drag in bindPlannerEvents below) so
// this document-level listener -- bound once in initPlanner(), not
// per-render -- never scrolls the page during some unrelated drag
// elsewhere in the app (e.g. the Tasks tab's own allocation drag).
let plannerDragActive = false;
const PLANNER_SCROLL_EDGE = 90;
const PLANNER_SCROLL_MAX_SPEED = 24;
function autoScrollDuringPlannerDrag(e) {
if (!plannerDragActive) return;
const y = e.clientY;
if (y < PLANNER_SCROLL_EDGE) {
window.scrollBy(0, -Math.ceil(((PLANNER_SCROLL_EDGE - y) / PLANNER_SCROLL_EDGE) * PLANNER_SCROLL_MAX_SPEED));
} else if (y > window.innerHeight - PLANNER_SCROLL_EDGE) {
window.scrollBy(0, Math.ceil(((y - (window.innerHeight - PLANNER_SCROLL_EDGE)) / PLANNER_SCROLL_EDGE) * PLANNER_SCROLL_MAX_SPEED));
}
}

function entriesForDay(date, tripId = '') {
return data.plannerEntries.filter((e) => e.date === date && (e.tripId || '') === (tripId || ''));
}

function placeEntry(kind, refId, date, tripId = '') {
const entry = blankPlannerEntry({
kind, date, tripId,
[kind === 'connection' ? 'connectionId' : 'activityId']: refId,
});
data.plannerEntries.push(entry);
queueSave();
renderPlanner();
}

// Also updates tripId to match wherever it was dropped -- an entry moved
// from the main grid into a trip's own mini-grid (or back) should belong
// to that zone, not silently keep pointing at the old one.
function moveEntry(entryId, date, tripId = '') {
const entry = data.plannerEntries.find((e) => e.id === entryId);
if (!entry) return;
entry.date = date;
entry.tripId = tripId;
queueSave();
renderPlanner();
}

function setEntryStatus(entryId, status) {
const entry = data.plannerEntries.find((e) => e.id === entryId);
if (!entry) return;
entry.status = status;
queueSave();
renderPlanner();
}

function removeEntry(entryId) {
data.plannerEntries = data.plannerEntries.filter((e) => e.id !== entryId);
queueSave();
renderPlanner();
}

function addActivity(title) {
const t = String(title || '').trim();
if (!t) return;
data.plannerActivities.push(blankPlannerActivity({ title: t }));
queueSave();
renderPlanner();
}

// Also drops any entries referencing it -- an activity gone from the pool
// shouldn't leave a dangling reference sitting in a day box (plannerEntryHtml
// would otherwise just skip rendering it, but the record would linger).
function removeActivity(id) {
data.plannerActivities = data.plannerActivities.filter((a) => a.id !== id);
data.plannerEntries = data.plannerEntries.filter((e) => !(e.kind === 'activity' && e.activityId === id));
queueSave();
renderPlanner();
}

function formatDayLabel(dateStr) {
const d = new Date(`${dateStr}T00:00:00`);
return isNaN(d) ? dateStr : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

function plannerEntryHtml(entry) {
let label, avatar = '', openAttr = '';
if (entry.kind === 'connection') {
const c = data.connections.find((x) => x.id === entry.connectionId);
if (!c) return ''; // the connection was deleted since this was placed
label = escapeHtml(c.name);
avatar = avatarHtml(c.photoId, c.name, 'sm');
openAttr = ` data-planner-open-connection="${c.id}"`;
} else {
const a = data.plannerActivities.find((x) => x.id === entry.activityId);
if (!a) return ''; // the activity was removed from the pool since this was placed
label = escapeHtml(a.title);
}
// Draft/firm used to be a wide text pill ("DRAFT"/"FIRM") -- confirmed
// live to crowd the name off a phone's 2-column day grid. Replaced with
// signals that cost zero row width: the card's own border (dashed vs
// solid+rose, via the status-${status} class) and the label's weight
// (italic vs bold). The dot/plane/remove controls that took the pill's
// place still crowded a longer name on one line (confirmed live) -- moved
// onto their own row below the name instead of competing with it for the
// same line.
return `<div class="planner-entry alloc-card status-${entry.status}" draggable="true" data-planner-entry="${entry.id}">
<span class="planner-entry-link"${openAttr}>${avatar}<span class="planner-entry-label">${label}</span></span>
<div class="planner-entry-controls">
<button type="button" class="planner-status-dot status-${entry.status}" data-planner-toggle-status="${entry.id}" title="${entry.status === 'draft' ? 'Draft' : 'Firm'} — click to mark ${entry.status === 'draft' ? 'firm' : 'draft'}"></button>
${entry.tripId ? `<span class="planner-entry-trip-link" data-planner-open-trip="${entry.tripId}" title="Open this trip on the Travel tab">&#9992;</span>` : ''}
<span class="planner-entry-remove" data-planner-remove="${entry.id}" title="Remove">&times;</span>
</div>
</div>`;
}

// Same stripe on a trip's own mini-grid as the main grid -- useful there
// too (e.g. "will a room be occupied while I'm away"), not just on the
// main 14-day view. airbnbSegmentsForDay() is date-only and doesn't care
// which grid is asking, so this needs no tripId branch at all any more.
function airbnbStripeHtml(dateStr) {
const segments = airbnbSegmentsForDay(dateStr);
if (!segments.length) return '';
return `<div class="planner-day-stripe">${segments.map((s) => `<span class="stripe-seg stripe-${escapeHtml(s.colour)}" title="${escapeHtml(s.title)}"></span>`).join('')}</div>`;
}

function plannerDayHtml(dateStr, tripId = '', legChipsHtml = '') {
const entries = entriesForDay(dateStr, tripId);
return `<div class="planner-day alloc-target" data-planner-day="${dateStr}" data-planner-trip="${tripId}">
<div class="planner-day-label">${formatDayLabel(dateStr)}</div>
${legChipsHtml}
<div class="planner-day-entries">${entries.map(plannerEntryHtml).join('')}</div>
${airbnbStripeHtml(dateStr)}
</div>`;
}

function mainGridHtml() {
const days = Array.from({ length: 14 }, (_, i) => dateStrAdd(todayStr(), i));
return days.map((d) => plannerDayHtml(d)).join('');
}

function priorityPoolHtml() {
const priority = data.connections.filter(isPriorityConnection);
if (!priority.length) return '<div class="empty">No priority connections yet — pin someone (📌) below, on the Dating tab, or they\'ll appear automatically once things reach "Planning to meet" or later.</div>';
return priority.map((c) => `<div class="planner-pool-card alloc-card" draggable="true" data-planner-drag="connection:${c.id}">
<span class="planner-entry-link" data-planner-open-connection="${c.id}">${avatarHtml(c.photoId, c.name, 'sm')}<span>${escapeHtml(c.name)}</span></span>
</div>`).join('');
}

// The auto-priority filter (flag OR stage) is deliberately narrow -- this
// picker is the escape hatch for anyone else worth dragging in just for a
// particular window (a friend visiting, a family member), without having
// to go pin them on the Dating tab first. Picking someone here sets the
// same priorityFlag the 📌 button on their connection card does, so they
// keep showing up in this pool afterwards too, not just for one drag.
function addConnectionToPriority(connId) {
const c = data.connections.find((x) => x.id === connId);
if (!c) return;
if (!c.priorityFlag) { c.priorityFlag = true; queueSave(); }
// Cleared before renderPlanner() re-renders the picker, so it resets to
// its placeholder instead of renderConnPicker restoring the just-picked
// value (which would leave it looking stuck on the last person added).
const picker = document.getElementById('planner-add-connection-picker');
if (picker) picker.value = '';
renderPlanner();
}

function activitiesPoolHtml() {
if (!data.plannerActivities.length) return '<div class="empty">Nothing yet — add one below.</div>';
return data.plannerActivities.map((a) => `<div class="planner-pool-card alloc-card" draggable="true" data-planner-drag="activity:${a.id}">
<span>${escapeHtml(a.title)}</span>
<span class="tag-x" data-planner-del-activity="${a.id}" title="Remove from the list">&times;</span>
</div>`).join('');
}

// A leg's date fields are free text (travel.js's legFieldRowHtml normalizes
// them to a fixed form on capture, but older/AI-extracted values may still
// be loose) -- parseLooseDateTime (utils.js) is the shared parser travel.js
// also uses, so both sides tolerate the same shapes identically. `hintYear`
// corrects a year-less date to the trip's own known year rather than
// whatever Date.parse would otherwise guess. Doesn't handle a trip spanning
// a New Year's Eve boundary correctly (a leg dated "2 Jan" would get the
// trip's START year, not start+1) -- a real but rare imperfection, and a
// wrong-year bucket is still strictly better than the leg vanishing
// entirely.
function legDatesFor(leg, hintYear) {
const fields = LEG_DATE_FIELDS[leg.kind] || [];
return fields.map((f) => parseLooseDateTime(leg.fields[f], hintYear)?.date).filter(Boolean);
}

function legChipsForDay(trip, dateStr) {
const hintYear = trip.startDate ? parseInt(trip.startDate.slice(0, 4), 10) : undefined;
const legs = trip.legs.filter((l) => legDatesFor(l, hintYear).includes(dateStr));
if (!legs.length) return '';
return `<div class="planner-leg-chips">${legs.map((l) => `<span class="planner-leg-chip" title="Already scheduled — edit on the Travel tab">${escapeHtml(l.label || l.kind)}</span>`).join('')}</div>`;
}

// Best-known bounds, falling back to legs' earliest/latest dated fields when
// the trip-level dates aren't filled in yet -- same "refined as legs fill
// in" reasoning blankTrip's own comment already documents.
function tripRangeFor(trip) {
let start = trip.startDate, end = trip.endDate;
if (!start || !end) {
// Explicit wrapper, not a bare `legDatesFor` reference -- flatMap's
// callback gets (leg, index, array), and legDatesFor's 2nd param is
// hintYear; passing it directly would silently feed the array INDEX in as
// a year (setFullYear(1), setFullYear(2)...) for every leg after the
// first. No year hint available at this point anyway -- that's exactly
// what this fallback is trying to establish.
const legDates = trip.legs.flatMap((l) => legDatesFor(l)).sort();
if (legDates.length) {
start = start || legDates[0];
end = end || legDates[legDates.length - 1];
}
}
return { start, end };
}

// Who's actually reachable at a trip's destination(s), pickable straight
// into that trip's own day grid -- "who's around while I'm there" rather
// than making the user go check Connections' City field separately.
// foldDiacritics matches knownCityMap's own reasoning (utils.js) for
// loosely matching a place name; the dormant/paused exclusion matches the
// app's established "who's actually in rotation" predicate pair (see e.g.
// connections.js's reachOutOverdueAmount).
function connectionsAtDestinations(destinations) {
const wanted = (destinations || []).map((d) => foldDiacritics(String(d).trim().toLowerCase())).filter(Boolean);
if (!wanted.length) return [];
return data.connections.filter((c) => !isDormantStage(c.stage) && !isTravelPaused(c)
&& (c.location || []).some((loc) => wanted.includes(foldDiacritics(String(loc).trim().toLowerCase()))));
}

function destinationConnectionsPoolHtml(trip) {
if (!trip.destinations.length) return '';
const matches = connectionsAtDestinations(trip.destinations);
const body = matches.length
? `<div class="planner-pool-list">${matches.map((c) => `<div class="planner-pool-card alloc-card" draggable="true" data-planner-drag="connection:${c.id}">
<span class="planner-entry-link" data-planner-open-connection="${c.id}">${avatarHtml(c.photoId, c.name, 'sm')}<span>${escapeHtml(c.name)}</span></span>
</div>`).join('')}</div>`
: `<div class="empty">No non-archived connections listed at ${escapeHtml(trip.destinations.join(', '))} yet.</div>`;
return `<h4>Connections in ${escapeHtml(trip.destinations.join(', '))}</h4>${body}`;
}

function tripPanelHtml(trip) {
const { start, end } = tripRangeFor(trip);
if (!start || !end || start > end) return ''; // nothing dated yet -- nothing to lay a grid out against
const days = [];
let cur = start;
// A trip's real length rather than a fixed cap would be nicer, but a
// runaway loop from a garbage date is worse than a capped one -- 60 days
// covers any real holiday with headroom.
for (let i = 0; i < 60 && cur <= end; i++) { days.push(cur); cur = dateStrAdd(cur, 1); }
return `<div class="planner-trip-panel">
<h3>${escapeHtml(trip.title || trip.destinations.join(', ') || 'Trip')}</h3>
<div class="planner-grid planner-grid-trip">${days.map((d) => plannerDayHtml(d, trip.id, legChipsForDay(trip, d))).join('')}</div>
${destinationConnectionsPoolHtml(trip)}
</div>`;
}

// Fills in any day of the trip's KNOWN range that hasn't already been
// synced for a given person -- idempotent and safe to call repeatedly (on
// every Planner render, and right after someone's added to a trip), since
// autoPlacedDates permanently marks a (person, date) pair as handled the
// first time, so a day the user later drags this person OFF never gets
// silently re-filled, even if the trip's dates are edited again
// afterwards. Only ever ADDS entries -- a date range that shrinks is left
// alone, same "no silent deletion" reasoning airbnb.js and
// tinderimport.js's overrideFallbackFrom marker already follow elsewhere.
function syncTripPeopleEntries(trip) {
if (!trip) return;
const { start, end } = tripRangeFor(trip);
if (!start || !end || start > end) return;
let changed = false;
trip.people.forEach((p) => {
// 'self' has no connection to place, and freetext-only people (added
// via the picker's "someone not in Connections yet" row) have no
// connectionId either -- nothing for a planner entry to point at.
if (!p.connectionId || p.relation === 'self') return;
if (!Array.isArray(p.autoPlacedDates)) p.autoPlacedDates = [];
let cur = start;
for (let i = 0; i < 60 && cur <= end; i++) { // same 60-day cap tripPanelHtml's own day loop already uses
if (!p.autoPlacedDates.includes(cur)) {
p.autoPlacedDates.push(cur);
data.plannerEntries.push(blankPlannerEntry({ date: cur, tripId: trip.id, kind: 'connection', connectionId: p.connectionId }));
changed = true;
}
cur = dateStrAdd(cur, 1);
}
});
if (changed) queueSave();
}

function renderPlanner() {
const panel = document.getElementById('planner-panel');
if (!panel) return; // tab not in this build's DOM
const priorityEl = document.getElementById('planner-priority-pool');
const activitiesEl = document.getElementById('planner-activities-pool');
const gridEl = document.getElementById('planner-main-grid');
const tripsEl = document.getElementById('planner-trips');
priorityEl.innerHTML = priorityPoolHtml();
renderConnPicker('planner-add-connection-picker', 'Add someone else&hellip;', '');
activitiesEl.innerHTML = activitiesPoolHtml();
gridEl.innerHTML = mainGridHtml();
// Same "this is about what's coming up, not history" reasoning as the
// Airbnb sync's own past-reservation exclusion -- a trip that's already
// finished (a real end date, already before today) has nothing left to
// plan, so its whole mini-grid panel is dropped rather than sitting
// here as dead weight below the still-relevant ones. An undated trip
// (tripRangeFor has no end yet) is left alone here -- tripPanelHtml
// already renders nothing for it either way, nothing to filter.
const today = todayStr();
const sortedTrips = [...data.trips]
.filter((t) => { const { end } = tripRangeFor(t); return !end || end >= today; })
.sort((a, b) => {
const as = tripRangeFor(a).start || '9999', bs = tripRangeFor(b).start || '9999';
return as.localeCompare(bs) || a.createdAt.localeCompare(b.createdAt);
});
// General backstop for syncTripPeopleEntries() -- covers a trip whose
// dates only just became known (a start/end date typed in, a leg date
// filled in) with no hook needed anywhere in travel.js for date edits;
// the very next time this tab renders, it catches up. Cheap and
// idempotent when there's nothing new to add.
sortedTrips.forEach(syncTripPeopleEntries);
const tripPanels = sortedTrips.map(tripPanelHtml).filter(Boolean).join('');
tripsEl.innerHTML = tripPanels || '<div class="empty">No trips with known dates yet — add dates on the Travel tab and they\'ll show up here.</div>';
hydratePhotoBackgrounds(priorityEl);
hydratePhotoBackgrounds(gridEl);
hydratePhotoBackgrounds(tripsEl);
bindPlannerEvents(panel);
}

function bindPlannerEvents(root) {
root.querySelectorAll('[data-planner-drag]').forEach((card) => {
card.addEventListener('dragstart', (e) => {
e.dataTransfer.setData('text/plain', card.dataset.plannerDrag);
e.dataTransfer.effectAllowed = 'move';
card.classList.add('dragging');
plannerDragActive = true;
});
card.addEventListener('dragend', () => { card.classList.remove('dragging'); plannerDragActive = false; });
});
root.querySelectorAll('[data-planner-entry]').forEach((card) => {
card.addEventListener('dragstart', (e) => {
e.dataTransfer.setData('text/plain', `entry:${card.dataset.plannerEntry}`);
e.dataTransfer.effectAllowed = 'move';
card.classList.add('dragging');
plannerDragActive = true;
});
card.addEventListener('dragend', () => { card.classList.remove('dragging'); plannerDragActive = false; });
});
root.querySelectorAll('[data-planner-day]').forEach((zone) => {
zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
zone.addEventListener('dragleave', () => zone.classList.remove('over'));
zone.addEventListener('drop', (e) => {
e.preventDefault();
zone.classList.remove('over');
const payload = e.dataTransfer.getData('text/plain');
const sep = payload.indexOf(':');
if (sep < 0) return;
const kind = payload.slice(0, sep);
const refId = payload.slice(sep + 1);
const date = zone.dataset.plannerDay;
const tripId = zone.dataset.plannerTrip || '';
if (kind === 'entry') moveEntry(refId, date, tripId);
else if (kind === 'connection' || kind === 'activity') placeEntry(kind, refId, date, tripId);
});
});
root.querySelectorAll('[data-planner-toggle-status]').forEach((btn) => {
btn.addEventListener('click', () => {
const entry = data.plannerEntries.find((e) => e.id === btn.dataset.plannerToggleStatus);
if (entry) setEntryStatus(entry.id, entry.status === 'draft' ? 'firm' : 'draft');
});
});
root.querySelectorAll('[data-planner-remove]').forEach((btn) => {
btn.addEventListener('click', () => removeEntry(btn.dataset.plannerRemove));
});
root.querySelectorAll('[data-planner-del-activity]').forEach((btn) => {
btn.addEventListener('click', () => {
if (confirm("Remove this from the things-to-do list? Any day it's already placed on loses it too.")) removeActivity(btn.dataset.plannerDelActivity);
});
});
// Same cross-tab jump already used by app.js's "Save & open profile" hash
// handler and nudges.js's goToTarget -- switch tab, expand that
// connection's Details, scroll/flash it. stopPropagation so a click here
// (inside a draggable card) never bubbles into anything drag-related.
root.querySelectorAll('[data-planner-open-connection]').forEach((el) => {
el.addEventListener('click', (e) => {
e.stopPropagation();
const id = el.dataset.plannerOpenConnection;
switchTab('dating');
expandConnection(id);
setTimeout(() => scrollAndFlash(`[data-conn-row="${id}"]`), 80);
});
});
root.querySelectorAll('[data-planner-open-trip]').forEach((el) => {
el.addEventListener('click', (e) => {
e.stopPropagation();
switchTab('travel');
revealTrip(el.dataset.plannerOpenTrip);
});
});
}

// ---- Push to Google Calendar ----
//
// Privacy: a pushed event's TITLE never carries a connection's name -- the
// whole reason this exists (the user's own words: not wanting "tomorrow's
// girl's name showing on my watch or phone while out for dinner today").
// It borrows a same-day activity's title if there is one ("Dinner"),
// otherwise falls back to a neutral placeholder. The real detail (who,
// draft/firm, notes) goes in the DESCRIPTION instead, which a watch face or
// lock-screen banner never surfaces -- only visible if the event is opened.

function calendarTitleFor(entry) {
if (entry.kind === 'activity') {
const a = data.plannerActivities.find((x) => x.id === entry.activityId);
return a ? a.title : 'Personal plans';
}
const sibling = data.plannerEntries.find((e) => e.kind === 'activity' && e.date === entry.date && (e.tripId || '') === (entry.tripId || ''));
if (sibling) {
const a = data.plannerActivities.find((x) => x.id === sibling.activityId);
if (a) return a.title;
}
return 'Personal plans';
}

function plannerEntrySummaryLabel(entry) {
if (entry.kind === 'connection') {
const c = data.connections.find((x) => x.id === entry.connectionId);
return c ? c.name : '(deleted connection)';
}
const a = data.plannerActivities.find((x) => x.id === entry.activityId);
return a ? a.title : '(removed activity)';
}

function calendarDescriptionFor(entry) {
const parts = [plannerEntrySummaryLabel(entry), entry.status === 'firm' ? 'Firm' : 'Draft'];
if (entry.notes && entry.notes.trim()) parts.push(entry.notes.trim());
return parts.join(' — ');
}

function pushListHtml() {
const firm = data.plannerEntries.filter((e) => e.status === 'firm');
if (!firm.length) return '<div class="empty">No firm plans yet — mark an entry Firm first.</div>';
return firm.map((e) => `<label class="pending-option">
<input type="checkbox" data-planner-push-check="${e.id}" ${e.calendarPushed ? '' : 'checked'}>
<span class="pending-option-info">
<strong>${escapeHtml(formatDayLabel(e.date))}${e.tripId ? ' · trip' : ''} — ${escapeHtml(plannerEntrySummaryLabel(e))}</strong>
<span class="compare-caption">${e.calendarPushed ? 'Already pushed — re-check to push again' : 'Not yet pushed'}</span>
</span>
</label>`).join('');
}

async function openPushPanel() {
const status = document.getElementById('planner-push-status');
const panel = document.getElementById('planner-push-panel');
status.textContent = '';
const { canAttemptGoogleAction, hasCalendarWrite } = await import('../sync/googleauth.js');
if (!(await canAttemptGoogleAction())) { status.textContent = 'Sign in to Google at the top of Overview first.'; return; }
if (!hasCalendarWrite()) { status.textContent = 'Turn on "Allow creating events in Google Calendar" in Settings, then sign out and back in.'; return; }
const { listCalendars } = await import('../googlecalendar.js');
const calSelect = document.getElementById('planner-push-calendar');
try {
const calendars = await listCalendars();
if (!calendars.length) { status.textContent = "No calendars found on this account."; return; }
calSelect.innerHTML = calendars.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.summary)}</option>`).join('');
} catch (err) {
status.textContent = `Couldn't load your calendars: ${err.message}`;
return;
}
document.getElementById('planner-push-list').innerHTML = pushListHtml();
panel.hidden = false;
}

async function confirmPush() {
const status = document.getElementById('planner-push-status');
const calendarId = document.getElementById('planner-push-calendar').value;
if (!calendarId) { status.textContent = 'Pick a calendar first.'; return; }
const checked = [...document.querySelectorAll('[data-planner-push-check]:checked')].map((el) => el.dataset.plannerPushCheck);
if (!checked.length) { status.textContent = 'Nothing ticked.'; return; }
const { createEvent } = await import('../googlecalendar.js');
status.textContent = `Pushing ${checked.length}…`;
let pushed = 0, failed = 0;
for (const id of checked) {
const entry = data.plannerEntries.find((e) => e.id === id);
if (!entry) continue;
try {
await createEvent(calendarId, { title: calendarTitleFor(entry), description: calendarDescriptionFor(entry), date: entry.date });
entry.calendarPushed = true;
pushed++;
} catch (err) {
failed++;
}
}
queueSave();
status.textContent = `Pushed ${pushed}${failed ? `, ${failed} failed` : ''}.`;
document.getElementById('planner-push-panel').hidden = true;
renderPlanner();
}

function initPlanner() {
bindConnPickers();
bindForm('planner-activity-form', () => {
const input = document.getElementById('planner-activity-input');
if (!input) return;
addActivity(input.value);
input.value = '';
});
const pushBtn = document.getElementById('planner-push-btn');
const cancelBtn = document.getElementById('planner-push-cancel-btn');
const confirmBtn = document.getElementById('planner-push-confirm-btn');
if (pushBtn) pushBtn.addEventListener('click', openPushPanel);
if (cancelBtn) cancelBtn.addEventListener('click', () => { document.getElementById('planner-push-panel').hidden = true; });
if (confirmBtn) confirmBtn.addEventListener('click', confirmPush);
document.addEventListener('dragover', autoScrollDuringPlannerDrag);
// The picker's own row-click handler (connections.js's bindConnPickers)
// fires a bubbling 'change' on the hidden input -- delegated here once
// rather than re-bound every render, same reasoning as the dragover
// listener above.
document.addEventListener('change', (e) => {
if (e.target.id === 'planner-add-connection-picker' && e.target.value) addConnectionToPriority(e.target.value);
});
}

// Cross-tab jump target for connections.js's reverse "Plans" chip row --
// mirrors travel.js's own revealTrip exactly.
function revealPlannerEntry(entryId) {
renderPlanner();
setTimeout(() => {
const el = document.querySelector(`[data-planner-entry="${entryId}"]`);
if (el) {
el.scrollIntoView({ behavior: 'smooth', block: 'center' });
el.classList.add('flash-new');
setTimeout(() => el.classList.remove('flash-new'), 1800);
}
}, 60);
}

export { renderPlanner, initPlanner, revealPlannerEntry, syncTripPeopleEntries };
