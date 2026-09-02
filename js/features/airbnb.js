// Airbnb reservation dates, via each listing's own calendar-export (ICS)
// feed -- not the unofficial zxol/airbnbapi wrapper, which was
// investigated and rejected (dead since 2019, confirmed broken by its own
// users, real account-ban risk for a reverse-engineered token). Airbnb's
// own export is officially supported, needs no login token, and gives
// reservation date ranges -- but never a guest's name, on any plan, for
// any host; that's a genuine Airbnb privacy limit, which is why
// guestName/notes below are always typed in by hand, never scraped.
import { data, queueSave, blankAirbnbListing, blankAirbnbReservation } from '../state.js';
import { escapeHtml, todayStr, dateStrAdd } from '../utils.js';
import { fetchIcs } from '../files.js';
import { canAttemptGoogleAction, hasCalendarWrite } from '../sync/googleauth.js';
import { listCalendars, createEvent, findEvents } from '../googlecalendar.js';

// Same fixed palette every other coloured chip in the app already uses
// (css/style.css's --X custom properties + .dot.X), plus blue/pink added
// specifically for this feature -- there's no free colour picker anywhere
// else in the app to reuse instead.
const AIRBNB_COLOURS = ['blue', 'pink', 'sage', 'amber', 'slate', 'rose', 'teal', 'plum', 'red'];

// ---- ICS parsing --------------------------------------------------------

// Un-folds RFC5545 continuation lines (a line starting with a single space
// or tab is a continuation of the previous line, joined with the leading
// whitespace stripped) before splitting into logical lines -- a long
// SUMMARY/DESCRIPTION line wraps this way in a real export, and left
// un-joined would otherwise read as two malformed properties.
function unfoldIcsLines(text) {
const raw = String(text || '').replace(/\r\n/g, '\n').split('\n');
const lines = [];
raw.forEach((line) => {
if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length) {
lines[lines.length - 1] += line.slice(1);
} else if (line.trim()) {
lines.push(line);
}
});
return lines;
}

// DTSTART/DTEND on an Airbnb reservation are date-only ("VALUE=DATE:
// 20260910" -- an all-day block, not a timed event), but this also copes
// with a bare "20260910T000000Z" shape, taking only the date portion
// either way.
function icsDateOnly(value) {
const digits = String(value || '').replace(/[^0-9]/g, '');
if (digits.length < 8) return '';
return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

function parseIcsProperty(line) {
const colon = line.indexOf(':');
if (colon === -1) return null;
const name = line.slice(0, colon).split(';')[0].toUpperCase();
return { name, value: line.slice(colon + 1) };
}

// Not a real reservation -- confirmed live against a real feed, Airbnb
// inserts one of these at the far edge of its own booking window (a year
// out), no guest behind it at all. A host's own manual block on Airbnb's
// calendar (unrelated to this feature, someone blocking dates for
// maintenance/personal use) reads the same way -- no guest, just a "not
// available" marker -- so this is dropped by SUMMARY text, always, not
// just the one specific known case.
function isNotAvailablePlaceholder(summary) {
return /not available/i.test(summary || '');
}

// Airbnb's export is simple -- flat VEVENT blocks, no recurrence rules, no
// timezone complexity. Returns {uid, checkin, checkout}[], silently
// skipping any block missing a UID or a usable date pair (a
// cancelled/malformed entry), or one of Airbnb's own "Not available"
// placeholders (see isNotAvailablePlaceholder above), rather than failing
// the whole sync over it.
function parseIcs(text) {
const lines = unfoldIcsLines(text);
const events = [];
let current = null;
lines.forEach((line) => {
if (line === 'BEGIN:VEVENT') { current = {}; return; }
if (line === 'END:VEVENT') {
if (current && current.uid && current.checkin && current.checkout && !isNotAvailablePlaceholder(current.summary)) events.push(current);
current = null;
return;
}
if (!current) return;
const prop = parseIcsProperty(line);
if (!prop) return;
if (prop.name === 'UID') current.uid = prop.value.trim();
else if (prop.name === 'DTSTART') current.checkin = icsDateOnly(prop.value);
else if (prop.name === 'DTEND') current.checkout = icsDateOnly(prop.value);
else if (prop.name === 'SUMMARY') current.summary = prop.value.trim();
});
return events;
}

// ---- Sync ---------------------------------------------------------------

// Merges one listing's feed into data.airbnbReservations, keyed on the
// feed's OWN event uid (not this record's id) so re-running Sync updates
// in place instead of piling up duplicates every time.
async function syncAirbnbListing(listing) {
const text = await fetchIcs(listing.icsUrl);
const today = todayStr();
// Completed stays aren't tracked at all -- this feature is about what's
// coming up (occupancy stripes, nudges, the Overview list, the Google
// Calendar push), not a booking history, and Airbnb's export can carry
// years of past reservations that would otherwise just sit in the synced
// document forever, growing it for no benefit (same "don't let an
// ever-growing log make every save heavier" reasoning health.php's own
// separate append-only log exists for). Filtered here, before a past
// event is ever turned into a stored record, not just hidden from a
// display list downstream.
const events = parseIcs(text).filter((e) => e.checkout >= today);
const existingByUid = new Map(
data.airbnbReservations.filter((r) => r.listingId === listing.id).map((r) => [r.uid, r])
);
let added = 0, updated = 0;
events.forEach(({ uid: evUid, checkin, checkout }) => {
const existing = existingByUid.get(evUid);
if (existing) {
if (existing.checkin !== checkin || existing.checkout !== checkout) { existing.checkin = checkin; existing.checkout = checkout; updated++; }
existingByUid.delete(evUid);
} else {
data.airbnbReservations.push(blankAirbnbReservation({ listingId: listing.id, uid: evUid, checkin, checkout }));
added++;
}
});
// Whatever's left in existingByUid is either a cancelled booking (isn't
// in this sync's events at all any more) or one that's simply completed
// since the last sync (past events are excluded above, so it can no
// longer match anything) -- either way, gone.
let removed = 0;
existingByUid.forEach((r) => {
data.airbnbReservations = data.airbnbReservations.filter((x) => x.id !== r.id);
removed++;
});
return { added, updated, removed };
}

async function syncAllAirbnbListings() {
for (const listing of data.airbnbListings) {
try {
const result = await syncAirbnbListing(listing);
data.airbnbSyncStatus[listing.id] = { ok: true, syncedAt: new Date().toISOString(), ...result };
} catch (err) {
const message = err.message || String(err);
data.airbnbSyncStatus[listing.id] = { ok: false, syncedAt: new Date().toISOString(), error: message };
// The sync-button status line points here on a failure -- previously
// a broken promise, nothing was ever actually logged per listing, so
// "see console" showed an empty console. Logged per listing (not
// just once for the whole batch) so a mix of one broken feed and two
// working ones doesn't bury which is which.
console.error(`Airbnb sync failed for "${listing.label || listing.prefix || listing.id}":`, err);
}
}
queueSave();
}

// ---- Planner occupancy stripes ------------------------------------------

// One segment per occupied LISTING, not per room -- a same-day changeover
// between two listings sharing a room colour genuinely shows two segments
// of that colour on the turnover date, one for whoever's checking out and
// one for whoever's checking in. That's why checkout is treated as
// INCLUSIVE here, unlike the exclusive-checkout convention used
// everywhere else (the ICS parser, the Google Calendar push) -- this is
// "what's happening with this room today" (checkout, mid-stay, check-in),
// not strictly "who slept here last night", confirmed against the exact
// "3 stripes on a changeover day" example this was built from: without an
// inclusive checkout, a departing guest's stripe vanishes a day too
// early and a same-day changeover only ever shows the arriving side.
// Deliberately no text on the segment itself, only in its title tooltip
// -- the Planner grid doesn't need the prefix, only the Google Calendar
// push does (see pushReservation below).
function airbnbSegmentsForDay(dateStr) {
return data.airbnbReservations
.filter((r) => r.checkin <= dateStr && dateStr <= r.checkout)
.map((r) => {
const listing = data.airbnbListings.find((l) => l.id === r.listingId);
if (!listing) return null;
return { colour: listing.colour, title: `${listing.label || listing.prefix}${r.guestName ? ' — ' + r.guestName : ''}` };
})
.filter(Boolean);
}

// ---- Settings: listing config --------------------------------------------

function renderAirbnbListings() {
const el = document.getElementById('airbnb-listings');
if (!el) return;
if (data.airbnbListings.length === 0) {
el.innerHTML = '<div class="settings-note" style="margin:0;">No listings yet — add one below.</div>';
return;
}
el.innerHTML = `<table class="limits-table">
<thead><tr><th>Label</th><th>Calendar export URL</th><th>Prefix</th><th>Colour</th><th></th></tr></thead>
<tbody>${data.airbnbListings.map((l) => `<tr>
<td><input type="text" autocomplete="off" data-airbnb-listing-field="label" data-airbnb-listing-id="${l.id}" value="${escapeHtml(l.label)}" placeholder="e.g. Entire studio"></td>
<td><input type="text" autocomplete="off" data-airbnb-listing-field="icsUrl" data-airbnb-listing-id="${l.id}" value="${escapeHtml(l.icsUrl)}" placeholder="https://www.airbnb..../calendar/ical/....ics"></td>
<td><input type="text" autocomplete="off" data-airbnb-listing-field="prefix" data-airbnb-listing-id="${l.id}" value="${escapeHtml(l.prefix)}" placeholder="e.g. ES-L" style="width:70px;"></td>
<td><select data-airbnb-listing-field="colour" data-airbnb-listing-id="${l.id}">
${AIRBNB_COLOURS.map((c) => `<option value="${c}"${c === l.colour ? ' selected' : ''}>${c.charAt(0).toUpperCase()}${c.slice(1)}</option>`).join('')}
</select></td>
<td><span class="del-x" style="opacity:1;" data-del-airbnb-listing="${l.id}">&times;</span></td>
</tr>`).join('')}</tbody>
</table>
<div class="settings-note" style="margin:6px 0 0;">Prefix and colour both identify the physical ROOM, not the listing — give two listings for the same room the same colour. Once you rename any manually-entered Google Calendar events for a room to include its prefix, "Push to Google Calendar" recognises and adopts them instead of duplicating.</div>`;

el.querySelectorAll('[data-airbnb-listing-field]').forEach((input) => {
input.addEventListener('change', () => {
const listing = data.airbnbListings.find((l) => l.id === input.dataset.airbnbListingId);
if (!listing) return;
listing[input.dataset.airbnbListingField] = input.value.trim();
queueSave();
});
});
el.querySelectorAll('[data-del-airbnb-listing]').forEach((x) => {
x.addEventListener('click', () => {
const id = x.dataset.delAirbnbListing;
data.airbnbListings = data.airbnbListings.filter((l) => l.id !== id);
data.airbnbReservations = data.airbnbReservations.filter((r) => r.listingId !== id);
delete data.airbnbSyncStatus[id];
renderAirbnbListings();
renderAirbnb();
queueSave();
});
});
}

function initAirbnbListingsForm() {
const addBtn = document.getElementById('add-airbnb-listing-btn');
if (!addBtn) return;
renderAirbnbListings();
addBtn.addEventListener('click', () => {
data.airbnbListings.push(blankAirbnbListing());
renderAirbnbListings();
queueSave();
});
}

// ---- Overview panel -------------------------------------------------------

// Confirmed live: dropping the year made a genuine year-out date ("2
// Sept 2027") look identical to today's date ("2 Sept 2026") -- read as
// a bogus same-day "reservation" until the raw feed was checked. Only
// shown when it's not the current year, so the common case (a booking a
// few weeks or months out) stays as terse as before.
function formatAirbnbDate(iso) {
const d = new Date(`${iso}T00:00:00`);
if (isNaN(d)) return iso;
const opts = { day: 'numeric', month: 'short' };
if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
return d.toLocaleDateString('en-GB', opts);
}

function reservationRowHtml(r) {
const listing = data.airbnbListings.find((l) => l.id === r.listingId);
if (!listing) return '';
const nights = Math.round((new Date(`${r.checkout}T00:00:00`) - new Date(`${r.checkin}T00:00:00`)) / 86400000);
return `<div class="cal-row" data-airbnb-row="${r.id}">
<div class="cal-head">
<span class="cal-name"><span class="dot ${escapeHtml(listing.colour)}"></span>${escapeHtml(listing.label || listing.prefix || 'Listing')}</span>
<span class="cal-badge">${formatAirbnbDate(r.checkin)} &rarr; ${formatAirbnbDate(r.checkout)} &middot; ${nights} night${nights === 1 ? '' : 's'}</span>
</div>
<div class="cal-event-row">
<input type="text" autocomplete="off" class="tag-add-input" placeholder="Guest name" data-airbnb-res-field="guestName" data-airbnb-res-id="${r.id}" value="${escapeHtml(r.guestName)}" style="max-width:160px;">
<input type="text" autocomplete="off" class="tag-add-input" placeholder="Notes" data-airbnb-res-field="notes" data-airbnb-res-id="${r.id}" value="${escapeHtml(r.notes)}" style="max-width:220px;">
${r.googleEventId
? '<span class="settings-note" style="margin:0;">Pushed to Google Calendar.</span>'
: `<button class="sync-btn sm" type="button" data-airbnb-push="${r.id}">Push to Google Calendar</button>`}
<span class="sync-status" data-airbnb-push-status="${r.id}"></span>
</div>
</div>`;
}

// A failed listing contributes zero reservations, which used to fail
// completely silently on this panel -- the only place its error ever
// showed was the sync button's OWN status line, gone the moment you
// navigate away or reload. Same "Sync error: ..." convention
// calendars.js's own renderCalendars() already uses for exactly this.
function airbnbSyncErrorsHtml() {
const failed = data.airbnbListings.filter((l) => {
const s = data.airbnbSyncStatus[l.id];
return s && !s.ok;
});
if (!failed.length) return '';
return failed.map((l) => `<div class="cal-row"><div class="cal-event-row"><span class="cal-event empty-state">${escapeHtml(l.label || l.prefix || 'Listing')}: sync error — ${escapeHtml(data.airbnbSyncStatus[l.id].error)}</span></div></div>`).join('');
}

function renderAirbnb() {
const el = document.getElementById('airbnb-list');
const countEl = document.getElementById('airbnb-count');
if (!el) return;
const upcoming = data.airbnbReservations
.filter((r) => r.checkout >= todayStr())
.sort((a, b) => (a.checkin < b.checkin ? -1 : a.checkin > b.checkin ? 1 : 0));
if (countEl) countEl.textContent = upcoming.length ? String(upcoming.length) : '';
const errorsHtml = airbnbSyncErrorsHtml();
el.innerHTML = errorsHtml + (upcoming.length
? upcoming.map(reservationRowHtml).join('')
: (errorsHtml ? '' : '<div class="empty">Nothing upcoming — add a listing in Settings and Sync.</div>'));

el.querySelectorAll('[data-airbnb-res-field]').forEach((input) => {
input.addEventListener('change', () => {
const r = data.airbnbReservations.find((x) => x.id === input.dataset.airbnbResId);
if (!r) return;
r[input.dataset.airbnbResField] = input.value;
queueSave();
});
});
el.querySelectorAll('[data-airbnb-push]').forEach((btn) => {
btn.addEventListener('click', () => {
const r = data.airbnbReservations.find((x) => x.id === btn.dataset.airbnbPush);
const statusEl = el.querySelector(`[data-airbnb-push-status="${btn.dataset.airbnbPush}"]`);
if (r && statusEl) pushReservation(r, statusEl);
});
});
}

// ---- Google Calendar push -------------------------------------------------

// Two distinct jobs, in order: (1) never re-push a reservation this
// feature already pushed (reservation.googleEventId is a real fact once
// set, not a hopeful flag), (2) before creating anything new, search for
// an event the user already typed into Google Calendar by hand and adopt
// it instead -- see the Settings note on renaming manual entries to
// include the listing's prefix, which is what makes this search
// possible at all (Google's `q` is a general text search, no per-field
// match). Never auto-picks between multiple candidates -- same
// never-auto-merge discipline the duplicate-connection finder uses.
async function pushReservation(reservation, statusEl) {
const listing = data.airbnbListings.find((l) => l.id === reservation.listingId);
if (!listing) return;
if (reservation.googleEventId) { statusEl.textContent = 'Already pushed.'; return; }
if (!(await canAttemptGoogleAction())) { statusEl.textContent = 'Sign in to Google in Settings first.'; return; }
if (!hasCalendarWrite()) { statusEl.textContent = 'Turn on "Allow creating events in Google Calendar" in Settings, then sign out and back in.'; return; }
const calendarId = data.prefs.airbnbCalendarId;
if (!calendarId) { statusEl.textContent = 'Pick which calendar to push to, next to Sync, first.'; return; }

statusEl.textContent = 'Checking…';
const title = `${listing.prefix || listing.label} — ${reservation.guestName || 'Guest'}`;
const description = [listing.label, reservation.notes].filter(Boolean).join(' — ');
try {
const candidates = listing.prefix
? await findEvents(calendarId, {
timeMin: `${dateStrAdd(reservation.checkin, -2)}T00:00:00Z`,
timeMax: `${dateStrAdd(reservation.checkout, 2)}T00:00:00Z`,
q: listing.prefix,
})
: [];
if (candidates.length === 1) {
const match = candidates[0];
reservation.googleEventId = match.id;
reservation.googleCalendarId = calendarId;
const matchStart = match.start?.date || (match.start?.dateTime || '').slice(0, 10);
const matchEnd = match.end?.date || (match.end?.dateTime || '').slice(0, 10);
statusEl.textContent = (matchStart !== reservation.checkin || matchEnd !== reservation.checkout)
? `Matched an existing "${match.summary}" event, but its dates differ (${matchStart} → ${matchEnd}) — left as-is, adjust it by hand if that's wrong.`
: `Matched an existing "${match.summary}" event — adopted, nothing new created.`;
} else if (candidates.length > 1) {
statusEl.textContent = `${candidates.length} existing events near these dates already mention "${listing.prefix}" — too ambiguous to adopt one automatically. Rename or remove the extras in Google Calendar, then push again.`;
} else {
const created = await createEvent(calendarId, { title, description, date: reservation.checkin, endDate: reservation.checkout });
reservation.googleEventId = created.id;
reservation.googleCalendarId = calendarId;
statusEl.textContent = 'Pushed.';
}
queueSave();
renderAirbnb();
} catch (err) {
statusEl.textContent = `Couldn't push: ${err.message || err}`;
}
}

// Populates the calendar picker from the real Google Calendar list, on
// demand rather than automatically -- same explicit-click-adjacent
// pattern as Calendars/Mail's own "load calendars" step, just triggered
// by Sync itself here since there's no separate "load" button.
async function loadAirbnbCalendarOptions() {
const select = document.getElementById('airbnb-push-calendar');
if (!select || !(await canAttemptGoogleAction())) return;
try {
const list = await listCalendars();
const current = data.prefs.airbnbCalendarId;
select.innerHTML = '<option value="">Push to…</option>'
+ list.map((c) => `<option value="${escapeHtml(c.id)}"${c.id === current ? ' selected' : ''}>${escapeHtml(c.summary || '(untitled)')}</option>`).join('');
} catch (err) {
console.error('Could not load calendars for the Airbnb push picker:', err);
}
}

function initAirbnbSync() {
const btn = document.getElementById('airbnb-sync-btn');
const status = document.getElementById('airbnb-sync-status');
if (!btn) return;
btn.addEventListener('click', async () => {
if (!data.airbnbListings.length) { status.textContent = 'Add a listing in Settings first.'; return; }
btn.disabled = true;
status.textContent = 'Syncing…';
try {
await syncAllAirbnbListings();
renderAirbnb();
// Stripes live on the Planner tab -- dynamic import avoids a static
// import cycle, since planner.js itself statically imports
// airbnbSegmentsForDay from this file. Same pattern connections.js/
// nudges.js already use to reach travel.js/planner.js.
const { renderPlanner } = await import('./planner.js');
renderPlanner();
const failed = data.airbnbListings.filter((l) => data.airbnbSyncStatus[l.id] && !data.airbnbSyncStatus[l.id].ok);
if (!failed.length) {
status.textContent = 'Synced just now.';
} else {
// The actual error, right here -- not just a count pointing at devtools
// most people never open. Every failed listing likely has the SAME
// cause (an unconfigured/undeployed ics-proxy.php, a wrong secret), so
// showing just the first one's real message is more useful than a
// generic "N failed", not less informative.
const first = data.airbnbSyncStatus[failed[0].id];
status.textContent = `Synced, but ${failed.length} of ${data.airbnbListings.length} listing${failed.length === 1 ? '' : 's'} failed: ${first.error}`;
}
} catch (err) {
status.textContent = `Couldn't sync: ${err.message || err}`;
console.error('Airbnb sync failed:', err);
} finally {
btn.disabled = false;
}
});
loadAirbnbCalendarOptions();
const calSelect = document.getElementById('airbnb-push-calendar');
if (calSelect) {
calSelect.addEventListener('change', () => {
data.prefs.airbnbCalendarId = calSelect.value;
queueSave();
});
}
}

export { renderAirbnb, renderAirbnbListings, initAirbnbListingsForm, initAirbnbSync, airbnbSegmentsForDay };
