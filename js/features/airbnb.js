// Airbnb reservation dates, via each listing's own calendar-export (ICS)
// feed -- not the unofficial zxol/airbnbapi wrapper, which was
// investigated and rejected (dead since 2019, confirmed broken by its own
// users, real account-ban risk for a reverse-engineered token). Airbnb's
// own export is officially supported, needs no login token, and gives
// reservation date ranges -- but never a guest's name, on any plan, for
// any host; that's a genuine Airbnb privacy limit, which is why a
// FEED-sourced reservation's guestName is only ever filled in after the
// fact, by hand or from the booking email. A hand-typed external event
// is the exception -- its title carries the name, and that's read off it.
import { data, queueSave, blankAirbnbListing, blankAirbnbReservation, blankAirbnbKey, blankAirbnbKeyAssignment, KEY_CUSTODIAN_TYPES } from '../state.js';
import { escapeHtml, todayStr, dateStrAdd, unfoldIcsLines, parseIcsProperty, MISSING_KEY_LINK_HTML } from '../utils.js';
import { fetchIcs } from '../files.js';
import { canAttemptGoogleAction, hasCalendarWrite } from '../sync/googleauth.js';
import { listCalendars, createEvent, findEvents } from '../googlecalendar.js';

// Same fixed palette every other coloured chip in the app already uses
// (css/style.css's --X custom properties + .dot.X), plus blue/pink added
// specifically for this feature -- there's no free colour picker anywhere
// else in the app to reuse instead.
const AIRBNB_COLOURS = ['blue', 'pink', 'sage', 'amber', 'slate', 'rose', 'teal', 'plum', 'red'];

// ---- ICS parsing --------------------------------------------------------
// unfoldIcsLines/parseIcsProperty are shared with mail.js's date-event
// extraction (js/utils.js) -- only the Airbnb-specific date-only reading
// (icsDateOnly) and reservation shape stay local to this file.

// DTSTART/DTEND on an Airbnb reservation are date-only ("VALUE=DATE:
// 20260910" -- an all-day block, not a timed event), but this also copes
// with a bare "20260910T000000Z" shape, taking only the date portion
// either way.
function icsDateOnly(value) {
const digits = String(value || '').replace(/[^0-9]/g, '');
if (digits.length < 8) return '';
return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
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
// A listing with no feed URL isn't broken -- it's a booking calendar
// that was never on Airbnb (the plumber, the decorator, the cat
// sitter), tracked here purely so its bookings get the same occupancy
// stripes, calendar push and nudges as a real listing. Its bookings
// arrive through externalPrefix instead (syncExternalBookings below),
// or are simply entered by hand. Fetching "" threw, and that error was
// then shown on the Overview panel and in the sync status as if the
// feed were misconfigured.
//
// Any status left over from before the URL was cleared goes too --
// otherwise a stale error keeps being reported for a listing this pass
// deliberately didn't touch.
if (!listing.icsUrl) { delete data.airbnbSyncStatus[listing.id]; continue; }
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

// How far ahead a hand-typed external booking is expected to already be
// visible on the shared calendar -- unlike the ICS feed sync above (no
// artificial window needed, just "not checked out yet"), findEvents
// requires a real timeMax.
const EXTERNAL_SCAN_WINDOW_DAYS = 180;

// Airbnb's standard turnaround, and the reason a pushed booking is a timed
// event rather than an all-day one. An all-day event's end date is
// EXCLUSIVE in Google Calendar, so a checkout on the 14th used to finish
// the event at the close of the 13th -- the departure day, the one the
// cleaner actually needs, simply wasn't on the calendar. These also make
// the changeover legible: a checkout at 11am and the next check-in at 3pm
// show the four-hour gap rather than two blocks colliding on one day.
const CHECKIN_TIME = '15:00';
const CHECKOUT_TIME = '11:00';

// A booking typed straight into the shared Google Calendar for a listing
// that never touches Airbnb at all -- recognised by `externalPrefix`
// appearing in the event's title, a deliberately different tag from the
// listing's real `prefix` (see blankAirbnbListing's own comment, state.js)
// so it's never mistaken for a real Airbnb reservation when one of THOSE
// gets pushed. Keyed on the Calendar event's own id, not a feed uid --
// there's no feed behind something that was never on Airbnb -- otherwise
// the same re-sync-updates-in-place / gone-means-removed shape
// syncAirbnbListing already uses above.
// What counts as "the bit before the name" in a hand-typed event title.
// Every dash a keyboard, a phone, or an autocorrect can produce is in
// here: the app's own pushed titles use an em dash, but nobody types one
// by hand, and "Flatx - AC Contractors" with a plain hyphen has to work
// exactly as well as "Flatx — AC Contractors". Colon, middle dot and
// pipe are in for the same reason -- they're what people actually reach
// for -- and the whole run is matched, so "Flatx -- AC" works too.
const SEPARATOR_SOURCE = '[-‐‑‒–—―−:·|~]+';
const LEADING_SEPARATOR_RE = new RegExp(`^\\s*${SEPARATOR_SOURCE}\\s*`);

// The name a hand-typed external booking carries after its prefix --
// "Flatx - AC Contractors" is the contractor, and it was being thrown
// away: the reservation came through with the right dates and no name at
// all, which on a trades calendar is most of the information.
//
// Returns '' when there's nothing after the prefix, which is a legitimate
// state (a bare "Flatx" block), not a failure.
function externalNameFromSummary(summary, prefix) {
let rest = String(summary || '');
const at = prefix ? rest.indexOf(prefix) : -1;
if (at >= 0) rest = rest.slice(at + prefix.length);
return rest.replace(LEADING_SEPARATOR_RE, '').trim();
}

// Google Calendar stores an all-day event's end.date as EXCLUSIVE: a
// block covering the 28th alone comes back as 28 -> 29. A reservation's
// `checkout` here is the last day it OCCUPIES -- airbnbSegmentsForDay
// paints checkin..checkout inclusive, and the push writes an 11am
// checkout ON that day -- so reading end.date straight through added a
// day at both ends of the feature: a hand-typed all-day 28th showed as
// "28 Sept -> 29 Sept · 1 night" and painted two days of occupancy on
// the planner.
//
// A TIMED event needs no adjustment: its end is a real moment on the
// real last day, which is also why the push itself writes times rather
// than an all-day block (see CHECKIN_TIME/CHECKOUT_TIME above).
function eventDayRange(e) {
const checkin = e.start?.date || (e.start?.dateTime || '').slice(0, 10);
if (!e.end?.date) return { checkin, checkout: (e.end?.dateTime || '').slice(0, 10) };
const inclusiveEnd = dateStrAdd(e.end.date, -1);
// A zero-length all-day event (end.date === start.date) shouldn't be
// able to produce a checkout BEFORE its checkin -- Google shouldn't
// emit one, but a booking that reads as negative would be worse than
// one read as same-day.
return { checkin, checkout: inclusiveEnd < checkin ? checkin : inclusiveEnd };
}

async function syncExternalBookingsForListing(listing, calendarId) {
if (!listing.externalPrefix) return { added: 0, updated: 0, removed: 0 };
const today = todayStr();
const items = await findEvents(calendarId, {
timeMin: `${today}T00:00:00Z`,
timeMax: `${dateStrAdd(today, EXTERNAL_SCAN_WINDOW_DAYS)}T00:00:00Z`,
q: listing.externalPrefix,
});
// q is a broad free-text match across summary/description/etc (see
// findEvents' own comment) -- re-check the prefix is actually IN THE
// TITLE, same discipline pushReservation's own adoption step already
// applies before trusting a search hit.
const matching = items.filter((e) => (e.summary || '').includes(listing.externalPrefix));
const existingByEventId = new Map(
data.airbnbReservations.filter((r) => r.listingId === listing.id && r.source === 'external').map((r) => [r.googleEventId, r])
);
let added = 0, updated = 0;
matching.forEach((e) => {
const { checkin, checkout } = eventDayRange(e);
if (!checkin || !checkout) return;
const name = externalNameFromSummary(e.summary, listing.externalPrefix);
const existing = existingByEventId.get(e.id);
if (existing) {
let changed = false;
if (existing.checkin !== checkin || existing.checkout !== checkout) { existing.checkin = checkin; existing.checkout = checkout; changed = true; }
// Filled only when blank, never overwritten -- the same rule
// syncGuestNamesFromEmail already follows, and for the same reason:
// a name typed into the dashboard is the more considered of the two
// and shouldn't lose to whatever the calendar event happens to be
// called this week.
if (name && !existing.guestName) { existing.guestName = name; changed = true; }
if (changed) updated++;
existingByEventId.delete(e.id);
} else {
data.airbnbReservations.push(blankAirbnbReservation({
listingId: listing.id, checkin, checkout, source: 'external',
guestName: name, googleEventId: e.id, googleCalendarId: calendarId,
}));
added++;
}
});
// Whatever's left is a booking that's been deleted/renamed off the
// calendar since the last scan -- same "gone means gone" reasoning
// syncAirbnbListing's own cancelled-booking cleanup already follows.
let removed = 0;
existingByEventId.forEach((r) => { data.airbnbReservations = data.airbnbReservations.filter((x) => x.id !== r.id); removed++; });
return { added, updated, removed };
}

// One pass over every listing that's opted in (externalPrefix set) --
// silently a no-op if the shared calendar itself isn't configured yet,
// same guard syncCleanerEvents already applies for the same reason.
async function syncExternalBookings() {
const calendarId = data.prefs.airbnbCalendarId;
if (!calendarId) return;
for (const listing of data.airbnbListings) {
if (!listing.externalPrefix) continue;
try { await syncExternalBookingsForListing(listing, calendarId); }
catch (err) { console.error(`External-booking scan failed for "${listing.label || listing.prefix || listing.id}":`, err); }
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
<thead><tr><th>Label</th><th title="An Airbnb listing's iCal export. Leave it blank for a booking calendar that was never on Airbnb — a plumber, a decorator, a cat sitter — and give it an External prefix instead, so its bookings come from events you type into the shared Google Calendar. Sync skips a listing with no URL rather than reporting it as a broken feed." style="cursor:help; text-decoration:underline dotted;">Calendar export URL</th><th title="Identifies the physical ROOM, not the listing — give two listings for the same room the same prefix. Once you rename any manually-entered Google Calendar events for a room to include its prefix, &quot;Push to Google Calendar&quot; recognises and adopts them instead of duplicating." style="cursor:help; text-decoration:underline dotted;">Prefix</th><th title="A SECOND, different tag for a booking from outside Airbnb entirely (a friend, another platform) — type it into that Calendar event's title (e.g. &quot;ES-Lg - Jane Doe&quot;) and Sync pulls it in as a reservation on this listing, taking whatever follows the prefix as the name. Any dash, colon or pipe works as the separator. Deliberately not the same as Prefix — never mistaken for a real Airbnb booking when one of those gets pushed. Leave blank to skip this for a listing." style="cursor:help; text-decoration:underline dotted;">External prefix</th><th title="Identifies the physical ROOM, not the listing — give two listings for the same room the same colour." style="cursor:help; text-decoration:underline dotted;">Colour</th><th></th></tr></thead>
<tbody>${data.airbnbListings.map((l) => `<tr>
<td><input type="text" autocomplete="off" data-airbnb-listing-field="label" data-airbnb-listing-id="${l.id}" value="${escapeHtml(l.label)}" placeholder="e.g. Entire studio"></td>
<td><input type="text" autocomplete="off" data-airbnb-listing-field="icsUrl" data-airbnb-listing-id="${l.id}" value="${escapeHtml(l.icsUrl)}" placeholder="https://www.airbnb..../calendar/ical/....ics — or blank if not on Airbnb"></td>
<td><input type="text" autocomplete="off" data-airbnb-listing-field="prefix" data-airbnb-listing-id="${l.id}" value="${escapeHtml(l.prefix)}" placeholder="e.g. ES-L" style="width:70px;"></td>
<td><input type="text" autocomplete="off" data-airbnb-listing-field="externalPrefix" data-airbnb-listing-id="${l.id}" value="${escapeHtml(l.externalPrefix)}" placeholder="e.g. ES-Lg" style="width:70px;"></td>
<td><select data-airbnb-listing-field="colour" data-airbnb-listing-id="${l.id}">
${AIRBNB_COLOURS.map((c) => `<option value="${c}"${c === l.colour ? ' selected' : ''}>${c.charAt(0).toUpperCase()}${c.slice(1)}</option>`).join('')}
</select></td>
<td><span class="del-x" style="opacity:1;" data-del-airbnb-listing="${l.id}">&times;</span></td>
</tr>`).join('')}</tbody>
</table>`;

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

// ---- Settings: keyring config -----------------------------------------------
//
// A keyring's static facts (label, contents, which listings it opens) are
// configured here, same split as Airbnb listings themselves -- current
// CUSTODY (who has it, who it's for) is edited on the Airbnb panel itself
// (renderAirbnbKeys, above), not here.
function renderKeysSettings() {
const el = document.getElementById('keys-settings');
if (!el) return;
if (data.airbnbKeys.length === 0) {
el.innerHTML = '<div class="settings-note" style="margin:0;">No keyrings yet — add one below.</div>';
return;
}
el.innerHTML = `<table class="limits-table">
<thead><tr><th>Label</th><th>Contents</th><th>Opens</th><th></th></tr></thead>
<tbody>${data.airbnbKeys.map((k) => `<tr>
<td><input type="text" autocomplete="off" data-key-settings-field="label" data-key-settings-id="${k.id}" value="${escapeHtml(k.label)}" placeholder="e.g. Keyring 4"></td>
<td><input type="text" autocomplete="off" data-key-settings-field="contents" data-key-settings-id="${k.id}" value="${escapeHtml(k.contents)}" placeholder="e.g. Building fob, apartment door"></td>
<td>${data.airbnbListings.length
? data.airbnbListings.map((l) => `<label style="display:inline-flex;align-items:center;gap:3px;margin-right:8px;white-space:nowrap;">
<input type="checkbox" data-key-settings-listing="${k.id}" data-listing-id="${l.id}"${k.listingIds.includes(l.id) ? ' checked' : ''}>${escapeHtml(l.label || l.prefix || 'Listing')}
</label>`).join('')
: '<span class="settings-note" style="margin:0;">Add a listing first</span>'}
</td>
<td><span class="del-x" style="opacity:1;" data-del-key-settings="${k.id}">&times;</span></td>
</tr>`).join('')}</tbody>
</table>`;

el.querySelectorAll('[data-key-settings-field]').forEach((input) => {
input.addEventListener('change', () => {
const key = data.airbnbKeys.find((k) => k.id === input.dataset.keySettingsId);
if (!key) return;
key[input.dataset.keySettingsField] = input.value.trim();
queueSave();
});
});
el.querySelectorAll('[data-key-settings-listing]').forEach((cb) => {
cb.addEventListener('change', () => {
const key = data.airbnbKeys.find((k) => k.id === cb.dataset.keySettingsListing);
if (!key) return;
const listingId = cb.dataset.listingId;
if (cb.checked) { if (!key.listingIds.includes(listingId)) key.listingIds.push(listingId); }
else { key.listingIds = key.listingIds.filter((id) => id !== listingId); }
queueSave();
});
});
el.querySelectorAll('[data-del-key-settings]').forEach((x) => {
x.addEventListener('click', () => {
data.airbnbKeys = data.airbnbKeys.filter((k) => k.id !== x.dataset.delKeySettings);
renderKeysSettings();
queueSave();
});
});
}

function initKeysSettingsForm() {
const addBtn = document.getElementById('add-key-settings-btn');
if (!addBtn) return;
renderKeysSettings();
addBtn.addEventListener('click', () => {
data.airbnbKeys.push(blankAirbnbKey());
renderKeysSettings();
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

// ---- Cleaner events (read-only Google Calendar search) -------------------

// Independent of nudges.js's own AIRBNB_CLEAN_LEAD_DAYS (a "remind me to
// book a clean" lead time) -- this is "how far from the stay date is a
// cleaner event still plausibly for THIS turnover," a different question.
const CLEANER_MATCH_WINDOW_DAYS = 4;

function parseCleanerEventName(summary) {
const m = new RegExp(`^cleaner\\s*${SEPARATOR_SOURCE}\\s*(.+)$`, 'i').exec(String(summary || '').trim());
return m ? m[1].trim() : null;
}

// Cleaner events are typed straight into Google Calendar by hand (see
// nudges.js's buildAirbnbNudges comment) on the SAME calendar "Push to..."
// targets (data.prefs.airbnbCalendarId) -- confirmed with the user, no
// separate per-listing calendar exists for this. Read-only: calendar.
// readonly is a base sign-in scope (sync/googleauth.js), always present,
// so no hasCalendarWrite() gate is needed here, only canAttemptGoogleAction()
// (checked implicitly -- findEvents/googleFetch already surface a clear
// error if signed out, same as every other read in this file). `q` is a
// cheap server-side prefilter (same pattern pushReservation's own search
// already uses); the regex above is the real confirmation.
async function syncCleanerEvents() {
const calendarId = data.prefs.airbnbCalendarId;
const upcoming = data.airbnbReservations.filter((r) => r.checkout >= todayStr());
if (!calendarId || !upcoming.length) { data.airbnbCleanerEvents = []; return; }
const earliest = upcoming.reduce((min, r) => (r.checkin < min ? r.checkin : min), upcoming[0].checkin);
const latest = upcoming.reduce((max, r) => (r.checkout > max ? r.checkout : max), upcoming[0].checkout);
try {
const items = await findEvents(calendarId, {
timeMin: `${dateStrAdd(earliest, -CLEANER_MATCH_WINDOW_DAYS)}T00:00:00Z`,
timeMax: `${dateStrAdd(latest, CLEANER_MATCH_WINDOW_DAYS)}T00:00:00Z`,
q: 'Cleaner',
});
data.airbnbCleanerEvents = items
.map((e) => ({ date: e.start?.date || (e.start?.dateTime || '').slice(0, 10), name: parseCleanerEventName(e.summary) }))
.filter((e) => e.date && e.name);
data.airbnbCleanerSyncStatus = { ok: true, syncedAt: new Date().toISOString() };
} catch (err) {
data.airbnbCleanerSyncStatus = { ok: false, syncedAt: new Date().toISOString(), error: err.message || String(err) };
console.error('Cleaner-event scan failed:', err);
}
// Self-contained save, same as syncAllAirbnbListings -- this runs AFTER
// that function's own queueSave(), so without this call the freshly
// scanned cleaner events would sit unsaved until some later, unrelated
// change happened to trigger one.
queueSave();
}

// `gapStart`/`gapEnd` is the span between a candidate cleaner event and
// the reservation edge it would apply to. ANY other same-listing stay
// that overlaps that span at all disqualifies the candidate -- not just
// one that sits entirely inside it (a guest who checked in before a
// would-be check-out clean is already a real scheduling problem even if
// their own stay runs past the clean's window). Standard half-open
// interval overlap test, consistent with checkout already being treated
// as exclusive everywhere else in this file -- a same-day turnover
// (checkout == next checkin) correctly does NOT count as overlap.
function otherStayOverlaps(sameListing, gapStart, gapEnd) {
return sameListing.some((o) => o.checkin < gapEnd && o.checkout > gapStart);
}

// Scoped to the same listingId only, not other listings that might share
// a physical room -- a known limitation, not solved speculatively.
function findCleanerMatch(reservation, edge) {
const events = data.airbnbCleanerEvents || [];
const sameListing = data.airbnbReservations.filter((r) => r.listingId === reservation.listingId && r.id !== reservation.id);
if (edge === 'checkin') {
const windowStart = dateStrAdd(reservation.checkin, -CLEANER_MATCH_WINDOW_DAYS);
const best = events
.filter((e) => e.date >= windowStart && e.date <= reservation.checkin)
.sort((a, b) => (a.date < b.date ? 1 : -1))[0];
if (!best) return null;
return otherStayOverlaps(sameListing, best.date, reservation.checkin) ? null : best;
}
const windowEnd = dateStrAdd(reservation.checkout, CLEANER_MATCH_WINDOW_DAYS);
const best = events
.filter((e) => e.date >= reservation.checkout && e.date <= windowEnd)
.sort((a, b) => (a.date < b.date ? -1 : 1))[0];
if (!best) return null;
return otherStayOverlaps(sameListing, reservation.checkout, best.date) ? null : best;
}

function cleanerChipHtml(reservation, edge) {
const match = findCleanerMatch(reservation, edge);
const label = edge === 'checkin' ? 'Check-in clean' : 'Check-out clean';
return match
? `<span class="cal-badge cleaner-chip">${label}: ${formatAirbnbDate(match.date)} &middot; ${escapeHtml(match.name)}</span>`
: `<span class="cal-badge cleaner-chip cleaner-chip-tbc">${label}: TBC</span>`;
}

function reservationRowHtml(r) {
const listing = data.airbnbListings.find((l) => l.id === r.listingId);
if (!listing) return '';
// "0 nights" is right arithmetic and a useless label: a listing that
// isn't on Airbnb at all (a plumber, a cat sitter -- see the Calendar
// export URL note in the Settings table) is routinely booked for a
// single day, and reading that as zero of anything makes a real booking
// look like a data error.
const nights = Math.round((new Date(`${r.checkout}T00:00:00`) - new Date(`${r.checkin}T00:00:00`)) / 86400000);
const lengthLabel = nights <= 0 ? 'same day' : `${nights} night${nights === 1 ? '' : 's'}`;
return `<div class="cal-row" data-airbnb-row="${r.id}">
<div class="cal-head">
<span class="cal-name"><span class="dot ${escapeHtml(listing.colour)}"></span>${escapeHtml(listing.label || listing.prefix || 'Listing')}</span>
<span class="cal-badge ${escapeHtml(listing.colour)}">${formatAirbnbDate(r.checkin)} &rarr; ${formatAirbnbDate(r.checkout)} &middot; ${lengthLabel}</span>
</div>
<div class="cal-event-row">
<input type="text" autocomplete="off" class="tag-add-input" placeholder="Guest name" data-airbnb-res-field="guestName" data-airbnb-res-id="${r.id}" value="${escapeHtml(r.guestName)}" style="max-width:130px;">
<input type="text" autocomplete="off" class="tag-add-input" placeholder="Notes" data-airbnb-res-field="notes" data-airbnb-res-id="${r.id}" value="${escapeHtml(r.notes)}" style="max-width:160px;">
${r.source === 'external'
? '<span class="settings-note" style="margin:0;" title="Found on the shared calendar by its external prefix -- nothing to push, it\'s already there.">External &#10003;</span>'
: r.googleEventId
? '<span class="settings-note" style="margin:0;">Pushed &#10003;</span>'
: `<button class="sync-btn inline" type="button" data-airbnb-push="${r.id}" title="Push to Google Calendar">Push</button>`}
<span class="sync-status" data-airbnb-push-status="${r.id}"></span>
${data.prefs.airbnbCalendarId ? `<div class="cal-clean-group">${cleanerChipHtml(r, 'checkin')}${cleanerChipHtml(r, 'checkout')}</div>` : ''}
</div>
${reservationKeysHtml(r)}
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
: (errorsHtml ? '' : '<div class="empty">Nothing upcoming — add a listing in <span class="inline-goto-link" data-goto-tab="settings" data-goto-target="#airbnb-listings">Settings</span> and Sync.</div>'));

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
bindKeyCards(el);
el.querySelectorAll('[data-airbnb-key-drop]').forEach((zone) => {
zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
zone.addEventListener('dragleave', () => zone.classList.remove('over'));
zone.addEventListener('drop', (e) => {
e.preventDefault();
zone.classList.remove('over');
const keyId = e.dataTransfer.getData('text/plain');
assignKeyToReservation(keyId, zone.dataset.airbnbKeyDrop);
});
});
}

// ---- Key custody ------------------------------------------------------------
//
// Physical keyrings and who currently has them -- current custody only, no
// handoff history (confirmed as sufficient). A keyring's static facts
// (label, contents, which listings it opens) are set in Settings, same
// split as Airbnb listings themselves (icsUrl/prefix/colour there, custody
// here) -- this section is drag-and-drop, mirroring planner.js's own
// mechanics exactly (draggable="true" + dragstart -> dataTransfer
// 'text/plain' + .dragging; a drop target gets dragover/dragleave/drop +
// .over -- same CSS classes already in style.css, not new ones), because a
// full row per keyring (the previous version) doesn't scale: a small
// "holding pen" of compact cards for whatever's unassigned, dragged onto
// whichever reservation it belongs to.
//
// custodian/custodianName live on the KEY (blankAirbnbKey, state.js) --
// there's one physical object, in one place, no matter how many upcoming
// reservations it's earmarked for. Earmarking is a separate, one-to-many
// join (data.airbnbKeyAssignments, blankAirbnbKeyAssignment) -- dragging
// the same key onto a second reservation adds a second assignment rather
// than moving it. Among a key's own assignments, only the EARLIEST
// (soonest checkin -- the current/imminent handoff) gets the real,
// editable custodian control; any later one reads "Pending" instead, since
// there's nothing real to say about custody for a stay that hasn't
// started -- it becomes editable in its place once the earlier one's
// assignment is removed.
const KEY_NEEDS_NAME = new Set(['cleaner', 'workman', 'other']);

function assignmentsForKey(keyId) {
return data.airbnbKeyAssignments.filter((a) => a.keyId === keyId);
}
function assignmentsForReservation(reservationId) {
return data.airbnbKeyAssignments.filter((a) => a.reservationId === reservationId);
}
// A key's own assignments, earliest-checkin first -- [0] is "current".
// Assignments whose reservation is gone are already dropped by state.js's
// own migration guard, so every entry here has a real reservation.
function sortedAssignmentsForKey(keyId) {
return assignmentsForKey(keyId)
.map((a) => ({ assignment: a, reservation: data.airbnbReservations.find((r) => r.id === a.reservationId) }))
.filter((x) => x.reservation)
.sort((a, b) => (a.reservation.checkin < b.reservation.checkin ? -1 : a.reservation.checkin > b.reservation.checkin ? 1 : 0));
}
function isCurrentAssignment(assignment) {
const sorted = sortedAssignmentsForKey(assignment.keyId);
return sorted.length > 0 && sorted[0].assignment.id === assignment.id;
}

function keyListingsLabel(k) {
if (!k.listingIds.length) return 'General';
const labels = k.listingIds.map((id) => {
const l = data.airbnbListings.find((x) => x.id === id);
return l ? (l.label || l.prefix || 'Listing') : null;
}).filter(Boolean);
return labels.length ? labels.join(', ') : 'General';
}

// Contents/listings are static config (set in Settings, not here) -- shown
// as a hover tooltip rather than taking up visible card space, per the
// "still too big" correction below.
function keyBadgeTitle(k) {
return [k.contents, keyListingsLabel(k)].filter(Boolean).join(' — ');
}

// One letter per custodian, cycled with a single click -- planner.js's own
// planner-status-dot (draft/firm, one click toggles) is the direct
// precedent; this is the same idea over six states instead of two. Same
// control used identically on a holding-pen card and a reservation's key
// chip (correction from your review: no separate narrower toggle for a
// reservation -- it could just as easily be with you or the concierge
// there as with the guest).
const KEY_CUSTODIAN_LETTERS = { me: 'M', concierge: 'C', guest: 'G', cleaner: 'L', workman: 'W', other: 'O' };
function custodianToggleHtml(k) {
const label = k.custodian.charAt(0).toUpperCase() + k.custodian.slice(1);
const nameSuffix = KEY_NEEDS_NAME.has(k.custodian) && k.custodianName ? ` (${k.custodianName})` : '';
return `<button type="button" class="key-custodian-toggle" data-key-toggle="${k.id}" title="${escapeHtml(label + nameSuffix)} — click to change">${KEY_CUSTODIAN_LETTERS[k.custodian] || '?'}</button>`;
}
// The name input only for cleaner/workman/other -- styled to read as plain
// text until focused (same input.alloc-title pattern used elsewhere), not
// a full form field, so it doesn't add visible bulk when it's not needed.
function custodianNameInputHtml(k) {
if (!KEY_NEEDS_NAME.has(k.custodian)) return '';
return `<input type="text" autocomplete="off" class="key-name-input" placeholder="Who" data-key-field="custodianName" data-key-id="${k.id}" value="${escapeHtml(k.custodianName)}">`;
}

// A holding-pen card -- an unassigned key (0 assignments). Draggable onto
// any reservation's drop zone; the free-text note covers a non-Airbnb
// custodian ("with the agent for repairs") without forcing that through a
// reservation picker.
function keyPoolCardHtml(k) {
return `<div class="key-pool-card" draggable="true" data-key-drag="${k.id}" title="${escapeHtml(keyBadgeTitle(k))}">
<span class="key-label">&#128273; ${escapeHtml(k.label || 'Keyring')}</span>
${custodianToggleHtml(k)}
${custodianNameInputHtml(k)}
<input type="text" autocomplete="off" class="key-note-input" placeholder="note" data-key-field="notes" data-key-id="${k.id}" value="${escapeHtml(k.notes)}">
</div>`;
}

// A key chip shown ON a reservation -- also draggable (onto a DIFFERENT
// reservation, to earmark the same key there too; planner.js's own placed
// entries stay draggable the same way, for moving between days). Mostly
// plain, ungapped surface to grab -- confirmed live as the actual reason
// the old wide <select> version was hard to pick up and drag to a second
// reservation, not a logic bug.
function keyChipHtml(assignment) {
const k = data.airbnbKeys.find((x) => x.id === assignment.keyId);
if (!k) return '';
const current = isCurrentAssignment(assignment);
return `<span class="key-chip" draggable="true" data-key-drag="${k.id}" title="${escapeHtml(keyBadgeTitle(k))}">
<span class="key-label">&#128273; ${escapeHtml(k.label || 'Keyring')}</span>
${current ? custodianToggleHtml(k) + custodianNameInputHtml(k) : '<span class="key-pending" title="Earmarked, but a nearer reservation has this key first">Pending</span>'}
<span class="tag-x" data-unassign-key="${assignment.id}" title="Remove from this reservation">&times;</span>
</span>`;
}

function reservationKeysHtml(r) {
const chips = assignmentsForReservation(r.id).map(keyChipHtml).join('');
return `<div class="key-drop-zone alloc-target" data-airbnb-key-drop="${r.id}">${chips}</div>`;
}

// Shared by both render passes below (a custodian/notes field can live in
// the pool OR on a reservation chip) -- change handling and drag start are
// identical either way, only where the card currently renders differs.
function bindKeyCards(el) {
el.querySelectorAll('[data-key-field]').forEach((input) => {
input.addEventListener('change', () => {
const key = data.airbnbKeys.find((k) => k.id === input.dataset.keyId);
if (!key) return;
key[input.dataset.keyField] = input.value;
queueSave();
renderAirbnbKeys();
renderAirbnb();
});
});
el.querySelectorAll('[data-key-toggle]').forEach((btn) => {
btn.addEventListener('click', (e) => {
e.stopPropagation();
const key = data.airbnbKeys.find((k) => k.id === btn.dataset.keyToggle);
if (!key) return;
const idx = KEY_CUSTODIAN_TYPES.indexOf(key.custodian);
const next = KEY_CUSTODIAN_TYPES[(idx + 1) % KEY_CUSTODIAN_TYPES.length];
key.custodian = next;
// Clears only when LEAVING the name-needing set -- cycling among
// cleaner/workman/other keeps whatever name was already typed.
if (!KEY_NEEDS_NAME.has(next)) key.custodianName = '';
queueSave();
renderAirbnbKeys();
renderAirbnb();
});
});
el.querySelectorAll('[data-key-drag]').forEach((card) => {
card.addEventListener('dragstart', (e) => {
e.dataTransfer.setData('text/plain', card.dataset.keyDrag);
e.dataTransfer.effectAllowed = 'move';
card.classList.add('dragging');
});
card.addEventListener('dragend', () => card.classList.remove('dragging'));
});
el.querySelectorAll('[data-unassign-key]').forEach((x) => {
x.addEventListener('click', () => {
data.airbnbKeyAssignments = data.airbnbKeyAssignments.filter((a) => a.id !== x.dataset.unassignKey);
queueSave();
renderAirbnbKeys();
renderAirbnb();
});
});
}

// Adds the (key, reservation) assignment if it doesn't already exist --
// dropping a key that's already on this reservation is a no-op, not a
// duplicate.
function assignKeyToReservation(keyId, reservationId) {
if (!keyId || !reservationId) return;
const key = data.airbnbKeys.find((k) => k.id === keyId);
if (!key) return;
const exists = data.airbnbKeyAssignments.some((a) => a.keyId === keyId && a.reservationId === reservationId);
if (!exists) {
data.airbnbKeyAssignments.push(blankAirbnbKeyAssignment({ keyId, reservationId }));
queueSave();
renderAirbnbKeys();
renderAirbnb();
}
}

function renderAirbnbKeys() {
const el = document.getElementById('airbnb-keys-list');
if (!el) return;
const unassigned = data.airbnbKeys.filter((k) => assignmentsForKey(k.id).length === 0);
el.innerHTML = unassigned.length
? unassigned.map(keyPoolCardHtml).join('')
: (data.airbnbKeys.length
? '<div class="empty">Every keyring is assigned to a reservation below.</div>'
: '<div class="empty">No keyrings yet — add one in <span class="inline-goto-link" data-goto-tab="settings" data-goto-target="#keys-settings">Settings</span>.</div>');
bindKeyCards(el);
}

function initAirbnbKeys() {
renderAirbnbKeys();
}

// ---- Guest names via email --------------------------------------------------
//
// The ICS feed (syncAirbnbListing, above) never carries a guest's name --
// a genuine Airbnb privacy limit (see this file's own top-of-file
// comment). Airbnb's OWN "Reservation confirmed" email to the host does
// carry it, in a fixed subject template: "Reservation confirmed - <name>
// arrives <date>". Requiring BOTH "Reservation confirmed" AND "arrives"
// in the subject (a raw Gmail query, not a user-configured mail search
// row) is what keeps this from also matching a reservation confirmation
// for a stay booked elsewhere AS A GUEST -- that uses different wording,
// with no "arrives" (that word only appears in the host-facing template,
// describing someone else arriving at your place).
const GUEST_NAME_SUBJECT_RE = /^Reservation confirmed\s*[-–—]\s*(.+?)\s+arrives\s+(.+)$/i;
const GUEST_NAME_QUERY = 'subject:"Reservation confirmed" subject:"arrives"';
const GUEST_NAME_SEARCH_LIMIT = 25;
const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// The subject carries a day+month with no year ("23 Sept" or "Sept 23"
// -- Airbnb's own template isn't pinned to one order, so both are tried).
// No year is needed: matchReservationForArrival below gets the year from
// whichever real reservation's own checkin actually lands on this
// day+month, rather than this function guessing one.
function parseArrivalDayMonth(text) {
const dayFirst = /(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,})/i.exec(text);
if (dayFirst) {
const month = MONTH_NAMES.indexOf(dayFirst[2].slice(0, 3).toLowerCase());
if (month !== -1) return { day: Number(dayFirst[1]), month: month + 1 };
}
const monthFirst = /([a-z]{3,})\s+(\d{1,2})(?:st|nd|rd|th)?/i.exec(text);
if (monthFirst) {
const month = MONTH_NAMES.indexOf(monthFirst[1].slice(0, 3).toLowerCase());
if (month !== -1) return { day: Number(monthFirst[2]), month: month + 1 };
}
return null;
}

// The one pending reservation (upcoming, no guest name entered yet --
// this never overwrites a name already typed in) whose real checkin date
// lands on this day+month, any year. More than one match is genuinely
// ambiguous -- skipped rather than guessed, same never-auto-pick-between-
// candidates discipline pushReservation's own Google Calendar match uses
// below.
function matchReservationForArrival(day, month) {
const candidates = data.airbnbReservations.filter((r) => {
if (r.guestName || r.checkout < todayStr()) return false;
const d = new Date(`${r.checkin}T00:00:00`);
return d.getDate() === day && d.getMonth() + 1 === month;
});
return candidates.length === 1 ? candidates[0] : null;
}

// Runs the search and fills in whatever it can match; never touches a
// reservation that already has a name. A non-Latin name (the common case
// this exists for) is romanized via ai.js -- only when actually needed,
// same "check before spending an AI call" discipline the Chrome
// LanguageDetector pre-check in tinderimport.js uses ahead of
// translateText. The original script is kept in notes (appended, not
// overwriting anything already there) so the romanization can be
// double-checked against it rather than trusted blind.
async function syncGuestNamesFromEmail() {
const pending = data.airbnbReservations.filter((r) => !r.guestName && r.checkout >= todayStr());
if (!pending.length || !(await canAttemptGoogleAction())) return { filled: 0 };

const { fetchMailSearches } = await import('../googlemail.js');
const search = { kind: 'query', value: GUEST_NAME_QUERY, maxDays: 0, maxEvents: GUEST_NAME_SEARCH_LIMIT };
let sections;
try {
sections = await fetchMailSearches([search], GUEST_NAME_SEARCH_LIMIT);
} catch (err) {
console.error('Guest-name email search failed:', err);
return { filled: 0, error: err.message || String(err) };
}

let filled = 0;
let romanizeFailed = 0;
for (const m of sections[0]?.messages || []) {
const subjectMatch = GUEST_NAME_SUBJECT_RE.exec(String(m.subject || '').trim());
if (!subjectMatch) continue;
const rawName = subjectMatch[1].trim();
const arrival = parseArrivalDayMonth(subjectMatch[2]);
if (!rawName || !arrival) continue;
const reservation = matchReservationForArrival(arrival.day, arrival.month);
if (!reservation) continue;

let name = rawName;
if (/[^\x00-\x7F]/.test(rawName)) {
try {
const { romanizeName } = await import('../ai.js');
name = (await romanizeName(rawName)) || rawName;
} catch (err) {
// Falls back to the raw script rather than leaving the reservation
// unfilled -- still findable, still better than nothing -- but this
// used to fail SILENTLY (console.error only), so "why is this
// showing the raw name" had no visible answer. Most likely cause:
// the Anthropic key lives in device-LOCAL settings (never synced,
// state.js's own LOCAL_SETTINGS_KEY comment), so a device that ran
// Sync without ever having a key entered on IT specifically hits
// MissingKeyError here even though another device has one set.
console.error('Guest-name romanization failed, using the raw name:', err);
romanizeFailed++;
}
}
reservation.guestName = name;
if (name !== rawName) {
reservation.notes = reservation.notes ? `${reservation.notes} · Booking name: ${rawName}` : `Booking name: ${rawName}`;
}
filled++;
}
if (filled) queueSave();
return { filled, romanizeFailed };
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
if (!(await canAttemptGoogleAction())) { statusEl.textContent = 'Sign in to Google at the top of Overview first.'; return; }
if (!hasCalendarWrite()) { statusEl.innerHTML = 'Turn on "Allow creating events in Google Calendar" in <span class="inline-goto-link" data-goto-tab="settings" data-goto-target="#calendar-write-toggle">Settings</span>, then sign out and back in.'; return; }
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
// Same exclusive-end correction as the external scan (eventDayRange),
// so adopting a hand-typed ALL-DAY event doesn't report its dates as
// differing purely because Google's end is a day past the last one.
const { checkin: matchStart, checkout: matchEnd } = eventDayRange(match);
statusEl.textContent = (matchStart !== reservation.checkin || matchEnd !== reservation.checkout)
? `Matched an existing "${match.summary}" event, but its dates differ (${matchStart} → ${matchEnd}) — left as-is, adjust it by hand if that's wrong.`
: `Matched an existing "${match.summary}" event — adopted, nothing new created.`;
} else if (candidates.length > 1) {
statusEl.textContent = `${candidates.length} existing events near these dates already mention "${listing.prefix}" — too ambiguous to adopt one automatically. Rename or remove the extras in Google Calendar, then push again.`;
} else {
const created = await createEvent(calendarId, {
title, description,
date: reservation.checkin, endDate: reservation.checkout,
startTime: CHECKIN_TIME, endTime: CHECKOUT_TIME,
});
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

// Populates the calendar picker from the real Google Calendar list.
// Confirmed live: calling this once at page load (the original design
// here) silently did nothing most of the time -- Google's silent
// reconnect is async and often hasn't resolved that early, so
// canAttemptGoogleAction() said no and this gave up for good, with no
// error and no retry. Now called both on every Sync click (by then
// sign-in has had time to settle) and lazily the moment the dropdown
// itself is opened (belt and braces for whichever comes first), and
// failures actually say why instead of leaving an unexplained empty
// picker.
// `silent` skips writing to the shared sync-status span -- used by the
// Sync click handler, which has its own, more relevant result text to
// show there (a calendar-picker sign-in nudge shouldn't clobber "Synced
// just now."); the initial load and the on-focus retry below have
// nothing competing for that span, so they show it directly.
async function loadAirbnbCalendarOptions({ silent } = {}) {
const select = document.getElementById('airbnb-push-calendar');
const status = document.getElementById('airbnb-sync-status');
if (!select) return;
if (!(await canAttemptGoogleAction())) {
if (!silent && status) status.textContent = 'Sign in to Google at the top of Overview to enable "Push to…".';
return;
}
if (!hasCalendarWrite()) {
if (!silent && status) status.innerHTML = 'Turn on "Allow creating events in Google Calendar" in <span class="inline-goto-link" data-goto-tab="settings" data-goto-target="#calendar-write-toggle">Settings</span>, then sign out and back in, to enable "Push to…".';
return;
}
try {
const list = await listCalendars();
const current = data.prefs.airbnbCalendarId;
select.innerHTML = '<option value="">Push to…</option>'
+ list.map((c) => `<option value="${escapeHtml(c.id)}"${c.id === current ? ' selected' : ''}>${escapeHtml(c.summary || '(untitled)')}</option>`).join('');
} catch (err) {
console.error('Could not load calendars for the Airbnb push picker:', err);
if (!silent && status) status.textContent = `Couldn't load your Google Calendars: ${err.message || err}`;
}
}

function initAirbnbSync() {
const btn = document.getElementById('airbnb-sync-btn');
const status = document.getElementById('airbnb-sync-status');
if (!btn) return;
btn.addEventListener('click', async () => {
if (!data.airbnbListings.length) { status.innerHTML = 'Add a listing in <span class="inline-goto-link" data-goto-tab="settings" data-goto-target="#airbnb-listings">Settings</span> first.'; return; }
btn.disabled = true;
status.textContent = 'Syncing…';
try {
await syncAllAirbnbListings();
await syncCleanerEvents();
await syncExternalBookings();
const guestResult = await syncGuestNamesFromEmail();
renderAirbnb();
loadAirbnbCalendarOptions({ silent: true });
// Stripes live on the Planner tab -- dynamic import avoids a static
// import cycle, since planner.js itself statically imports
// airbnbSegmentsForDay from this file. Same pattern connections.js/
// nudges.js already use to reach travel.js/planner.js.
const { renderPlanner } = await import('./planner.js');
renderPlanner();
const failed = data.airbnbListings.filter((l) => data.airbnbSyncStatus[l.id] && !data.airbnbSyncStatus[l.id].ok);
if (!failed.length) {
const guestNote = guestResult.filled
? ` Filled in ${guestResult.filled} guest name${guestResult.filled === 1 ? '' : 's'} from email${guestResult.romanizeFailed ? ` (${guestResult.romanizeFailed} left in the original script — add an Anthropic key on THIS device in ${MISSING_KEY_LINK_HTML} to romanize ${guestResult.romanizeFailed === 1 ? 'it' : 'them'})` : ''}.`
: '';
status.innerHTML = `Synced just now.${guestNote}`;
} else {
// The actual error, right here -- not just a count pointing at devtools
// most people never open. Every failed listing likely has the SAME
// cause (an unconfigured/undeployed ics-proxy.php, a wrong secret), so
// showing just the first one's real message is more useful than a
// generic "N failed", not less informative.
const first = data.airbnbSyncStatus[failed[0].id];
// Counted against the listings that actually HAVE a feed, not every
// listing -- a feed-less one was never attempted, so "1 of 4 failed"
// when only two have feeds reads as a worse result than it is.
const withFeeds = data.airbnbListings.filter((l) => l.icsUrl).length;
status.textContent = `Synced, but ${failed.length} of ${withFeeds} listing${failed.length === 1 ? '' : 's'} with a feed failed: ${first.error}`;
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
// Belt and braces alongside the page-load attempt above and the
// Sync-click one -- whichever of the three actually lands after
// sign-in has settled is the one that fixes it. Not { once: true }:
// cheap enough to re-attempt every time the picker is opened, and a
// one-shot listener that fires before sign-in settles would otherwise
// use up its only try and never get another.
calSelect.addEventListener('focus', () => loadAirbnbCalendarOptions());
calSelect.addEventListener('change', () => {
data.prefs.airbnbCalendarId = calSelect.value;
queueSave();
});
}
}

// The last three are exported only so they can be checked directly:
// each turns a real Google Calendar event into something this file
// stores, and each was wrong in a way that stayed invisible until a
// round-trip through Google -- an end date a day out, a name silently
// dropped, a title separator nobody types. Nothing else imports them.
export { renderAirbnb, renderAirbnbListings, initAirbnbListingsForm, initAirbnbSync, airbnbSegmentsForDay, renderAirbnbKeys, initAirbnbKeys, initKeysSettingsForm, eventDayRange, externalNameFromSummary, parseCleanerEventName };
