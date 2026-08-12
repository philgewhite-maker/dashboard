// Reads (never writes) Google Calendar to show each tracked calendar's
// next upcoming event. Uses the same Google sign-in as Drive sync
// (googleauth.js) — the `calendar.readonly` scope was added there
// specifically for this. Replaces what the original claude.ai artifact did
// via an MCP connector only available inside claude.ai chats.
import { googleFetch } from './sync/googleauth.js';

const CALENDAR_LIST_API = 'https://www.googleapis.com/calendar/v3/users/me/calendarList';
const EVENTS_API = 'https://www.googleapis.com/calendar/v3/calendars';

async function listCalendars() {
const res = await googleFetch(`${CALENDAR_LIST_API}?fields=items(id,summary)&minAccessRole=freeBusyReader`);
if (!res.ok) throw new Error(`Calendar list failed: ${res.status}`);
const json = await res.json();
return json.items || [];
}

function resolveCalendarId(name, calendarList) {
const lower = name.trim().toLowerCase();
const exact = calendarList.find((c) => (c.summary || '').trim().toLowerCase() === lower);
if (exact) return exact.id;
const partial = calendarList.find((c) => (c.summary || '').trim().toLowerCase().includes(lower));
return partial ? partial.id : null;
}

async function getUpcomingEvents(calendarId, count, daysAhead) {
const params = new URLSearchParams({
timeMin: new Date().toISOString(),
singleEvents: 'true',
orderBy: 'startTime',
maxResults: String(Math.max(1, count)),
fields: 'items(summary,start)',
});
// Asking the API for the window is cheaper than fetching everything and
// discarding it here, and keeps maxResults meaningful within that window.
if (daysAhead > 0) {
const until = new Date();
until.setDate(until.getDate() + daysAhead);
params.set('timeMax', until.toISOString());
}
const res = await googleFetch(`${EVENTS_API}/${encodeURIComponent(calendarId)}/events?${params}`);
if (!res.ok) throw new Error(`Calendar events failed: ${res.status}`);
const json = await res.json();
return (json.items || []).map((event) => ({
title: event.summary || '(untitled event)',
// dateTime for timed events, date for all-day ones.
date: event.start?.dateTime || event.start?.date,
})).filter((e) => e.date);
}

// Resolves and fetches in one pass for every tracked calendar name. Returns
// a map keyed by the exact name string given, so callers can merge this
// straight into data.calendarStatus.
// `calendars` is [{name, maxDays, maxEvents}] — each carries its own limits,
// so "5 upcoming for Work, just the next one for Family" is expressible.
// A blank/zero maxEvents falls back to defaultCount; blank maxDays means no
// window at all.
async function syncCalendars(calendars, defaultCount = 1) {
const calendarList = await listCalendars();
const status = {};
for (const entry of calendars) {
const name = entry.name;
const count = Math.max(1, Number(entry.maxEvents) || Number(defaultCount) || 1);
const daysAhead = Math.max(0, Number(entry.maxDays) || 0);
const syncedAt = new Date().toISOString();
const calendarId = resolveCalendarId(name, calendarList);
if (!calendarId) {
status[name] = { found: false, events: [], syncedAt };
continue;
}
try {
const events = await getUpcomingEvents(calendarId, count, daysAhead);
status[name] = events.length
// title/date mirror the first event purely so anything still reading
// the old single-event shape keeps working.
? { found: true, events, title: events[0].title, date: events[0].date, syncedAt }
: { found: false, events: [], syncedAt };
} catch (err) {
status[name] = { found: false, events: [], error: err.message, syncedAt };
}
}
return status;
}

export { syncCalendars, listCalendars };
