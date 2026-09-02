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

// Creates an all-day event -- the Planner tab (js/features/planner.js)
// works in whole days, not time slots, so start/end are both a bare date
// rather than a dateTime. `endDate` is optional (defaults to `date`, a
// single-day event) -- added for the Airbnb push (js/features/airbnb.js),
// which needs a real check-in/check-out span; the Planner call site
// never passes it, so its behaviour is unchanged. Requires the opt-in
// calendar.events write scope (see hasCalendarWrite() in
// sync/googleauth.js) -- callers are expected to check that before
// offering the push button, same as Contacts write already does.
async function createEvent(calendarId, { title, description, date, endDate }) {
const res = await googleFetch(`${EVENTS_API}/${encodeURIComponent(calendarId)}/events`, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ summary: title, description, start: { date }, end: { date: endDate || date } }),
});
if (!res.ok) throw new Error(`Couldn't create calendar event: ${res.status}`);
return res.json();
}

// Searches for existing events, unlike getUpcomingEvents just below (always
// forward-looking from "now", and deliberately narrow-fielded -- no id, no
// description). Built for the Airbnb push's de-dup step: recognising a
// reservation the user already typed into Google Calendar by hand (see
// airbnb.js) so a push adopts that event instead of creating a duplicate.
// `q` is Google's own free-text search across summary/description/etc. --
// there's no per-field search, which is exactly why the push logic asks
// for a listing PREFIX to appear in the event title in the first place.
async function findEvents(calendarId, { timeMin, timeMax, q }) {
const params = new URLSearchParams({
timeMin, timeMax,
singleEvents: 'true',
orderBy: 'startTime',
fields: 'items(id,summary,description,start,end)',
});
if (q) params.set('q', q);
const res = await googleFetch(`${EVENTS_API}/${encodeURIComponent(calendarId)}/events?${params}`);
if (!res.ok) throw new Error(`Calendar search failed: ${res.status}`);
const json = await res.json();
return json.items || [];
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

export { syncCalendars, listCalendars, createEvent, findEvents };
