// Each tracked entry is a calendar NAME (as it appears in Google Calendar,
// e.g. "Work", "Family") — "Sync calendars" resolves each name to a real
// Google Calendar and shows its next upcoming event. Add calendars to
// track in Settings; this panel only shows what Sync last found.
import { data, queueSave } from '../state.js';
import { escapeHtml, bindForm, scrollAndFlash, daysUntil } from '../utils.js';
import { canAttemptGoogleAction } from '../sync/googleauth.js';
import { syncCalendars, listCalendars } from '../googlecalendar.js';
import { captureTask } from './tasks.js';

function renderCalendars() {
const list = document.getElementById('calendars-list');
document.getElementById('calendars-count').textContent = data.calendars.length + (data.calendars.length === 1 ? ' calendar' : ' calendars');
if (data.calendars.length === 0) {
list.innerHTML = '<div class="empty">Nothing tracked yet. Add one in Settings, then Sync.</div>';
return;
}
// Sort by each calendar's soonest event so whatever is happening next
// floats to the top, regardless of how many events each one shows.
const withDate = (cal) => {
const s = data.calendarStatus[cal.name];
const first = s && s.events && s.events[0];
return first && first.date ? daysUntil(first.date) : Infinity;
};
const sorted = [...data.calendars].sort((a, b) => withDate(a) - withDate(b));

const eventRowHtml = (e, calName) => {
const dn = daysUntil(e.date);
const badgeText = dn <= 0 ? 'Today' : dn === 1 ? 'Tomorrow' : `in ${dn} days`;
return `<div class="cal-event-row">
<span class="cal-event">${escapeHtml(e.title)}<span class="cal-date">${escapeHtml(String(e.date).slice(0, 10))}</span></span>
<button class="mini-task-btn" type="button" title="Capture as a task"
data-event-task="1" data-event-title="${escapeHtml(e.title)}"
data-event-date="${escapeHtml(String(e.date).slice(0, 10))}"
data-event-cal="${escapeHtml(calName)}">+ task</button>
<span class="cal-badge ${dn <= 0 ? 'today' : ''}">${badgeText}</span>
</div>`;
};

list.innerHTML = sorted.map((cal) => {
const name = cal.name;
const status = data.calendarStatus[name];
const events = (status && status.events) || [];
let body;
if (!status) {
body = '<div class="cal-event-row"><span class="cal-event empty-state">Not synced yet</span></div>';
} else if (status.error) {
body = `<div class="cal-event-row"><span class="cal-event empty-state">Sync error: ${escapeHtml(status.error)}</span></div>`;
} else if (events.length === 0) {
body = '<div class="cal-event-row"><span class="cal-event empty-state">No upcoming events found</span></div>';
} else {
body = events.map((e) => eventRowHtml(e, name)).join('');
}
return `<div class="cal-row" data-cal-row="${escapeHtml(name)}">
<div class="cal-head">
<span class="cal-name">${escapeHtml(name)}</span>
<span class="del-x" style="opacity:1;" data-del-cal="${escapeHtml(name)}">&times;</span>
</div>
<div class="cal-events">${body}</div>
</div>`;
}).join('');

list.querySelectorAll('[data-event-task]').forEach((btn) => {
btn.addEventListener('click', () => {
captureTask({
title: `Prep: ${btn.dataset.eventTitle}`,
notes: `${btn.dataset.eventCal} — ${btn.dataset.eventDate}`,
source: { kind: 'calendar', label: `${btn.dataset.eventTitle} (${btn.dataset.eventDate})` },
});
btn.textContent = '✓';
btn.disabled = true;
});
});

list.querySelectorAll('[data-del-cal]').forEach((el) => {
el.addEventListener('click', () => {
const name = el.dataset.delCal;
data.calendars = data.calendars.filter((c) => c.name !== name);
delete data.calendarStatus[name];
renderCalendars();
renderCalendarLimits();
queueSave();
});
});
}

// The per-calendar Max days / Max events table in Settings. Lives here
// rather than settings.js so it can re-render alongside the panel whenever
// a calendar is added or removed.
function renderCalendarLimits() {
const el = document.getElementById('calendar-limits');
if (!el) return;
if (data.calendars.length === 0) {
el.innerHTML = '<div class="settings-note" style="margin:0;">No calendars tracked yet.</div>';
return;
}
el.innerHTML = `<table class="limits-table">
<thead><tr><th>Calendar</th><th>Max days</th><th>Max events</th><th></th></tr></thead>
<tbody>${data.calendars.map((c) => `<tr>
<td>${escapeHtml(c.name)}</td>
<td><input type="number" min="0" max="365" placeholder="any" value="${c.maxDays || ''}" data-cal-limit="${escapeHtml(c.name)}" data-limit-field="maxDays"></td>
<td><input type="number" min="0" max="50" placeholder="${data.prefs.calendarEventCount}" value="${c.maxEvents || ''}" data-cal-limit="${escapeHtml(c.name)}" data-limit-field="maxEvents"></td>
<td><span class="del-x" style="opacity:1;" data-del-cal-limit="${escapeHtml(c.name)}">&times;</span></td>
</tr>`).join('')}</tbody>
</table>
<div class="settings-note" style="margin:6px 0 0;">Blank means no day limit, and the default count. Applies next time you press "Sync calendars".</div>`;

el.querySelectorAll('[data-cal-limit]').forEach((input) => {
input.addEventListener('change', () => {
const cal = data.calendars.find((c) => c.name === input.dataset.calLimit);
if (!cal) return;
const parsed = parseInt(input.value, 10);
cal[input.dataset.limitField] = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
input.value = cal[input.dataset.limitField] || '';
queueSave();
});
});
el.querySelectorAll('[data-del-cal-limit]').forEach((x) => {
x.addEventListener('click', () => {
const name = x.dataset.delCalLimit;
data.calendars = data.calendars.filter((c) => c.name !== name);
delete data.calendarStatus[name];
renderCalendars();
renderCalendarLimits();
queueSave();
});
});
}

function initCalendarForm() {
bindForm('calendar-form', () => {
const select = document.getElementById('cal-name-input');
const name = select.value.trim();
if (!name) return;
if (!data.calendars.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
data.calendars.push({ name, maxDays: 0, maxEvents: 0 });
}
renderCalendars();
renderCalendarLimits();
queueSave();
setTimeout(() => scrollAndFlash(`[data-cal-row="${CSS.escape(name)}"]`), 50);
});
}

// Populates the "Track a new calendar" dropdown from the real Google
// Calendar list, on demand rather than automatically — same explicit-click
// pattern as Sync calendars / Refresh mail, rather than hitting the API on
// every Settings visit for something that rarely changes.
async function loadCalendarOptions() {
const select = document.getElementById('cal-name-input');
const status = document.getElementById('cal-list-status');
if (!(await canAttemptGoogleAction())) {
status.textContent = 'Sign in to Google at the top of the page first.';
return;
}
status.textContent = 'Loading…';
try {
const list = await listCalendars();
if (list.length === 0) {
select.innerHTML = '<option value="">No calendars found</option>';
status.textContent = '';
return;
}
select.innerHTML = list.map((c) => `<option value="${escapeHtml(c.summary || '')}">${escapeHtml(c.summary || '(untitled)')}</option>`).join('');
status.textContent = `Loaded ${list.length} calendar${list.length === 1 ? '' : 's'}.`;
} catch (err) {
status.textContent = `Couldn't load calendars: ${err.message || err}`;
console.error('Calendar list load failed:', err);
}
}

function initCalendarListLoader() {
document.getElementById('load-cal-list-btn').addEventListener('click', loadCalendarOptions);
}

function initCalendarSync() {
const btn = document.getElementById('sync-cal-btn');
const status = document.getElementById('cal-sync-status');
btn.addEventListener('click', async () => {
if (data.calendars.length === 0) {
status.textContent = 'Add a calendar to track in Settings first.';
return;
}
if (!(await canAttemptGoogleAction())) {
status.textContent = 'Sign in to Google in Settings first.';
return;
}
btn.disabled = true;
status.textContent = 'Syncing…';
try {
const results = await syncCalendars(data.calendars, data.prefs.calendarEventCount);
data.calendarStatus = { ...data.calendarStatus, ...results };
renderCalendars();
queueSave();
status.textContent = `Synced just now.`;
} catch (err) {
status.textContent = `Couldn't sync: ${err.message || err}`;
console.error('Calendar sync failed:', err);
} finally {
btn.disabled = false;
}
});
}

export { renderCalendars, renderCalendarLimits, initCalendarForm, initCalendarSync, initCalendarListLoader };
