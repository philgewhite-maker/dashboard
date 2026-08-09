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

async function getNextEvent(calendarId) {
const params = new URLSearchParams({
timeMin: new Date().toISOString(),
singleEvents: 'true',
orderBy: 'startTime',
maxResults: '1',
fields: 'items(summary,start)',
});
const res = await googleFetch(`${EVENTS_API}/${encodeURIComponent(calendarId)}/events?${params}`);
if (!res.ok) throw new Error(`Calendar events failed: ${res.status}`);
const json = await res.json();
const event = (json.items || [])[0];
if (!event) return null;
const date = event.start?.dateTime || event.start?.date; // dateTime for timed events, date for all-day
return { title: event.summary || '(untitled event)', date };
}

// Resolves and fetches in one pass for every tracked calendar name. Returns
// a map keyed by the exact name string given, so callers can merge this
// straight into data.calendarStatus.
async function syncCalendars(names) {
const calendarList = await listCalendars();
const status = {};
for (const name of names) {
const calendarId = resolveCalendarId(name, calendarList);
if (!calendarId) {
status[name] = { found: false, syncedAt: new Date().toISOString() };
continue;
}
try {
const next = await getNextEvent(calendarId);
status[name] = next
? { found: true, title: next.title, date: next.date, syncedAt: new Date().toISOString() }
: { found: false, syncedAt: new Date().toISOString() };
} catch (err) {
status[name] = { found: false, error: err.message, syncedAt: new Date().toISOString() };
}
}
return status;
}

export { syncCalendars };
