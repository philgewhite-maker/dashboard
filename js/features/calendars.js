// Each tracked entry is a calendar NAME (as it appears in Google Calendar,
// e.g. "Work", "Family") — "Sync calendars" resolves each name to a real
// Google Calendar and shows its next upcoming event. Add calendars to
// track in Settings; this panel only shows what Sync last found.
import { data, queueSave } from '../state.js';
import { escapeHtml, bindForm, scrollAndFlash, daysUntil } from '../utils.js';
import { isSignedIn } from '../sync/googleauth.js';
import { syncCalendars } from '../googlecalendar.js';

function renderCalendars() {
const list = document.getElementById('calendars-list');
document.getElementById('calendars-count').textContent = data.calendars.length + (data.calendars.length === 1 ? ' calendar' : ' calendars');
if (data.calendars.length === 0) {
list.innerHTML = '<div class="empty">Nothing tracked yet. Add one in Settings, then Sync.</div>';
return;
}
const withDate = (name) => {
const s = data.calendarStatus[name];
return s && s.found && s.date ? daysUntil(s.date) : Infinity;
};
const sorted = [...data.calendars].sort((a, b) => withDate(a) - withDate(b));

list.innerHTML = sorted.map((name) => {
const status = data.calendarStatus[name];
let eventHtml, badgeHtml = '';
if (!status) {
eventHtml = '<span class="cal-event empty-state">Not synced yet</span>';
} else if (status.error) {
eventHtml = `<span class="cal-event empty-state">Sync error: ${escapeHtml(status.error)}</span>`;
} else if (!status.found) {
eventHtml = '<span class="cal-event empty-state">No upcoming events found</span>';
} else {
const dn = daysUntil(status.date);
const badgeText = dn <= 0 ? 'Today' : dn === 1 ? 'Tomorrow' : `in ${dn} days`;
badgeHtml = `<span class="cal-badge ${dn <= 0 ? 'today' : ''}">${badgeText}</span>`;
eventHtml = `<span class="cal-event">${escapeHtml(status.title)}<span class="cal-date">${escapeHtml(String(status.date).slice(0, 10))}</span></span>`;
}
return `<div class="cal-row" data-cal-row="${escapeHtml(name)}">
<span class="cal-name">${escapeHtml(name)}</span>
${eventHtml}
<div class="cal-actions">
${badgeHtml}
<span class="del-x" style="opacity:1;" data-del-cal="${escapeHtml(name)}">&times;</span>
</div>
</div>`;
}).join('');

list.querySelectorAll('[data-del-cal]').forEach((el) => {
el.addEventListener('click', () => {
const name = el.dataset.delCal;
data.calendars = data.calendars.filter((c) => c !== name);
delete data.calendarStatus[name];
renderCalendars();
queueSave();
});
});
}

function initCalendarForm() {
bindForm('calendar-form', () => {
const input = document.getElementById('cal-name-input');
const name = input.value.trim();
if (!name) return;
if (!data.calendars.some((c) => c.toLowerCase() === name.toLowerCase())) {
data.calendars.push(name);
}
input.value = '';
renderCalendars();
queueSave();
setTimeout(() => scrollAndFlash(`[data-cal-row="${CSS.escape(name)}"]`), 50);
});
}

function initCalendarSync() {
const btn = document.getElementById('sync-cal-btn');
const status = document.getElementById('cal-sync-status');
btn.addEventListener('click', async () => {
if (data.calendars.length === 0) {
status.textContent = 'Add a calendar to track in Settings first.';
return;
}
if (!isSignedIn()) {
status.textContent = 'Sign in to Google in Settings first.';
return;
}
btn.disabled = true;
status.textContent = 'Syncing…';
try {
const results = await syncCalendars(data.calendars);
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

export { renderCalendars, initCalendarForm, initCalendarSync };
