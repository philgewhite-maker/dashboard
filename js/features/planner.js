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
import { data, queueSave, blankPlannerEntry, blankPlannerActivity } from '../state.js';
import { escapeHtml, uid, todayStr, avatarHtml, hydratePhotoBackgrounds, bindForm } from '../utils.js';
import { isPriorityConnection } from './connections.js';

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

// Entirely UTC, deliberately -- parsing "${base}T00:00:00" as LOCAL
// midnight and then reading it back via toISOString() (UTC) is timezone-
// dependent, and confirmed live as a real bug: in a timezone where local
// midnight converts to the PREVIOUS UTC day, adding 1 day and losing 1 day
// to that conversion cancel out exactly, so a day never actually advances
// and every "day box" in a 14-day grid silently renders the same date.
// Date.UTC + getUTCDate/setUTCDate never touches the local clock at all.
function dateStrAdd(base, days) {
const [y, m, d] = base.split('-').map(Number);
const dt = new Date(Date.UTC(y, m - 1, d));
dt.setUTCDate(dt.getUTCDate() + days);
return dt.toISOString().slice(0, 10);
}

function formatDayLabel(dateStr) {
const d = new Date(`${dateStr}T00:00:00`);
return isNaN(d) ? dateStr : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

function plannerEntryHtml(entry) {
let label, avatar = '';
if (entry.kind === 'connection') {
const c = data.connections.find((x) => x.id === entry.connectionId);
if (!c) return ''; // the connection was deleted since this was placed
label = escapeHtml(c.name);
avatar = avatarHtml(c.photoId, c.name, 'sm');
} else {
const a = data.plannerActivities.find((x) => x.id === entry.activityId);
if (!a) return ''; // the activity was removed from the pool since this was placed
label = escapeHtml(a.title);
}
return `<div class="planner-entry alloc-card" draggable="true" data-planner-entry="${entry.id}">
${avatar}
<span class="planner-entry-label">${label}</span>
<button type="button" class="planner-status-pill planner-status-${entry.status}" data-planner-toggle-status="${entry.id}" title="Click to mark ${entry.status === 'draft' ? 'firm' : 'draft'}">${entry.status === 'draft' ? 'Draft' : 'Firm'}</button>
<span class="planner-entry-remove" data-planner-remove="${entry.id}" title="Remove">&times;</span>
</div>`;
}

function plannerDayHtml(dateStr, tripId = '', legChipsHtml = '') {
const entries = entriesForDay(dateStr, tripId);
return `<div class="planner-day alloc-target" data-planner-day="${dateStr}" data-planner-trip="${tripId}">
<div class="planner-day-label">${formatDayLabel(dateStr)}</div>
${legChipsHtml}
<div class="planner-day-entries">${entries.map(plannerEntryHtml).join('')}</div>
</div>`;
}

function mainGridHtml() {
const days = Array.from({ length: 14 }, (_, i) => dateStrAdd(todayStr(), i));
return days.map((d) => plannerDayHtml(d)).join('');
}

function priorityPoolHtml() {
const priority = data.connections.filter(isPriorityConnection);
if (!priority.length) return '<div class="empty">No priority connections yet — pin someone (📌) on the Dating tab, or they\'ll appear automatically once things reach "Planning to meet" or later.</div>';
return priority.map((c) => `<div class="planner-pool-card alloc-card" draggable="true" data-planner-drag="connection:${c.id}">
${avatarHtml(c.photoId, c.name, 'sm')}
<span>${escapeHtml(c.name)}</span>
</div>`).join('');
}

function activitiesPoolHtml() {
if (!data.plannerActivities.length) return '<div class="empty">Nothing yet — add one below.</div>';
return data.plannerActivities.map((a) => `<div class="planner-pool-card alloc-card" draggable="true" data-planner-drag="activity:${a.id}">
<span>${escapeHtml(a.title)}</span>
<span class="tag-x" data-planner-del-activity="${a.id}" title="Remove from the list">&times;</span>
</div>`).join('');
}

// Which of a leg's own fields actually hold a date, per kind -- same field
// names LEG_FIELD_DEFS (state.js) uses, just narrowed to the ones worth
// bucketing a leg chip under a specific day for.
const LEG_DATE_FIELDS = {
flight: ['departTime', 'arriveTime'],
car_hire: ['pickupTime', 'dropoffTime'],
accommodation: ['checkIn', 'checkOut'],
transfer: ['departTime'],
other: ['when'],
};

// Tolerant of freeform text in a field that hasn't actually been filled in
// as a real date yet -- only a value that starts like an ISO date
// contributes a day bucket, so a half-entered leg just contributes nothing
// rather than mis-bucketing garbage.
function legDatesFor(leg) {
const fields = LEG_DATE_FIELDS[leg.kind] || [];
return fields
.map((f) => leg.fields[f])
.filter((v) => v && /^\d{4}-\d{2}-\d{2}/.test(String(v)))
.map((v) => String(v).slice(0, 10));
}

function legChipsForDay(trip, dateStr) {
const legs = trip.legs.filter((l) => legDatesFor(l).includes(dateStr));
if (!legs.length) return '';
return `<div class="planner-leg-chips">${legs.map((l) => `<span class="planner-leg-chip" title="Already scheduled — edit on the Travel tab">${escapeHtml(l.label || l.kind)}</span>`).join('')}</div>`;
}

// Best-known bounds, falling back to legs' earliest/latest dated fields when
// the trip-level dates aren't filled in yet -- same "refined as legs fill
// in" reasoning blankTrip's own comment already documents.
function tripRangeFor(trip) {
let start = trip.startDate, end = trip.endDate;
if (!start || !end) {
const legDates = trip.legs.flatMap(legDatesFor).sort();
if (legDates.length) {
start = start || legDates[0];
end = end || legDates[legDates.length - 1];
}
}
return { start, end };
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
<h3>${escapeHtml(trip.title || trip.destination || 'Trip')}</h3>
<div class="planner-grid planner-grid-trip">${days.map((d) => plannerDayHtml(d, trip.id, legChipsForDay(trip, d))).join('')}</div>
</div>`;
}

function renderPlanner() {
const panel = document.getElementById('planner-panel');
if (!panel) return; // tab not in this build's DOM
const priorityEl = document.getElementById('planner-priority-pool');
const activitiesEl = document.getElementById('planner-activities-pool');
const gridEl = document.getElementById('planner-main-grid');
const tripsEl = document.getElementById('planner-trips');
priorityEl.innerHTML = priorityPoolHtml();
activitiesEl.innerHTML = activitiesPoolHtml();
gridEl.innerHTML = mainGridHtml();
const tripPanels = data.trips.map(tripPanelHtml).filter(Boolean).join('');
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
});
card.addEventListener('dragend', () => card.classList.remove('dragging'));
});
root.querySelectorAll('[data-planner-entry]').forEach((card) => {
card.addEventListener('dragstart', (e) => {
e.dataTransfer.setData('text/plain', `entry:${card.dataset.plannerEntry}`);
e.dataTransfer.effectAllowed = 'move';
card.classList.add('dragging');
});
card.addEventListener('dragend', () => card.classList.remove('dragging'));
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
}

export { renderPlanner, initPlanner };
