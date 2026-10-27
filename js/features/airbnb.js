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
import { escapeHtml, todayStr, dateStrAdd, uid, MISSING_KEY_LINK_HTML } from '../utils.js';
import { owners, ownerNameFor, money } from './letting.js';
import { gmailLink } from '../googlemail.js';
import { parseIcsReservations } from '../icsparse.js';

// How long a finished, not-yet-charged stay stays listed so its income can
// still be entered (see syncAirbnbListing's removal step).
const AWAITING_INCOME_DAYS = 30;
import { fetchIcs } from '../files.js';
import { canAttemptGoogleAction, hasCalendarWrite } from '../sync/googleauth.js';
import { listCalendars, createEvent, findEvents, getEvent } from '../googlecalendar.js';

// Same fixed palette every other coloured chip in the app already uses
// (css/style.css's --X custom properties + .dot.X), plus blue/pink added
// specifically for this feature -- there's no free colour picker anywhere
// else in the app to reuse instead.
const AIRBNB_COLOURS = ['blue', 'pink', 'sage', 'amber', 'slate', 'rose', 'teal', 'plum', 'red'];

// Native HTML5 drag-and-drop does NOT auto-scroll the page as the cursor
// nears the viewport edge -- confirmed as the reported bug: dragging a
// key toward a reservation below the fold on mobile just has the cursor
// stall there with no way to reach it. Ported verbatim from planner.js's
// own autoScrollDuringPlannerDrag/plannerDragActive (which solved the
// identical problem for its day-grid), kept airbnb-local rather than
// shared so the two features' drag states can never interfere with each
// other's unrelated drags.
let keysDragActive = false;
const AIRBNB_SCROLL_EDGE = 90;
const AIRBNB_SCROLL_MAX_SPEED = 24;
function autoScrollDuringKeyDrag(e) {
if (!keysDragActive) return;
const y = e.clientY;
if (y < AIRBNB_SCROLL_EDGE) {
window.scrollBy(0, -Math.ceil(((AIRBNB_SCROLL_EDGE - y) / AIRBNB_SCROLL_EDGE) * AIRBNB_SCROLL_MAX_SPEED));
} else if (y > window.innerHeight - AIRBNB_SCROLL_EDGE) {
window.scrollBy(0, Math.ceil(((y - (window.innerHeight - AIRBNB_SCROLL_EDGE)) / AIRBNB_SCROLL_EDGE) * AIRBNB_SCROLL_MAX_SPEED));
}
}

// ---- Sync ---------------------------------------------------------------
//
// The feed parser itself lives in js/icsparse.js, which imports nothing.
// It was moved out of this file so the service worker's background
// refresh (js/bgsync.js) can read the same feeds with no page open -- a
// worker has no `document`, and this file reaches most of the app. One
// parser, used both ways, rather than a copy that drifts the first time a
// real feed shows up something unexpected.

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
const events = parseIcsReservations(text).filter((e) => e.checkout >= today);
// Feed-sourced reservations ONLY. This map's leftovers get deleted at
// the end of the pass as cancelled bookings, and an external or manual
// booking on the same listing has no feed `uid` to match on -- it would
// sit in the map under the key '' and be swept every sync. Latent
// wherever a listing has both a feed and an external prefix (a booking
// from a friend on a real Airbnb listing, which the Settings tooltip
// explicitly invites); certain the moment a booking can be typed in by
// hand.
const existingByUid = new Map(
data.airbnbReservations.filter((r) => r.listingId === listing.id && (r.source || 'ics') === 'ics').map((r) => [r.uid, r])
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
// A stay that ended in the last month and hasn't been charged yet stays
// on file, so what it earned can still be typed in (or arrive from the
// payout email) before it turns into a ledger row. Without this a stay
// that ended while the app was closed could be swept out before its
// income was ever recorded.
if (r.checkout && r.checkout < today && !r.accruedAt && r.checkout >= dateStrAdd(today, -AWAITING_INCOME_DAYS)) return;
// A stay that has genuinely finished (not a cancelled future one) is
// remembered minimally: Airbnb emails a guest refund AFTER checkout, and
// matching it to a listing needs the stay's dates and listing.
if (r.checkout && r.checkout < today) {
if (!Array.isArray(data.airbnbPastStays)) data.airbnbPastStays = [];
if (!data.airbnbPastStays.some((s) => s.listingId === r.listingId && s.checkin === r.checkin && s.checkout === r.checkout)) {
data.airbnbPastStays.push({ listingId: r.listingId, checkin: r.checkin, checkout: r.checkout, guestName: r.guestName || '' });
}
}
data.airbnbReservations = data.airbnbReservations.filter((x) => x.id !== r.id);
removed++;
});
if (Array.isArray(data.airbnbPastStays)) {
const keepFrom = dateStrAdd(today, -400);
data.airbnbPastStays = data.airbnbPastStays.filter((s) => s.checkout >= keepFrom);
}
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

// A scheduled future change to the plain Share % above -- [{id,
// fromDate, pct, capAmount}], resolved by letting.js's shareRuleAt()
// as "the latest rule whose date has arrived". A rule whose fromDate
// is already past is shown read-only (no × to remove it) -- it's part
// of real history by then (a report may already reference it), not
// something to quietly edit away. capAmount is optional: "the smaller
// of X% or £Y" when set, just the percentage when blank.
function rateHistoryHtml(l) {
const rules = (l.shareRules || []).slice().sort((a, b) => String(a.fromDate).localeCompare(String(b.fromDate)));
const todayStr = new Date().toISOString().slice(0, 10);
const rows = rules.map((r) => {
const isPast = r.fromDate <= todayStr;
const capText = r.capAmount != null && r.capAmount !== '' ? `, cap £${escapeHtml(String(r.capAmount))}` : '';
return `<div class="settings-note" style="margin:2px 0 0;white-space:nowrap;">${escapeHtml(r.fromDate)}: ${escapeHtml(String(r.pct))}%${capText}${isPast ? '' : ` <span class="del-x" data-del-rate-rule="${escapeHtml(l.id)}:${escapeHtml(r.id)}" title="Remove this scheduled change">&times;</span>`}</div>`;
}).join('');
return `${rows}
<details style="margin-top:3px;">
<summary class="settings-note" style="margin:0;cursor:pointer;">+ schedule a change</summary>
<div style="margin-top:3px;display:flex;gap:3px;flex-wrap:wrap;">
<input type="date" data-rate-rule-date="${escapeHtml(l.id)}" style="width:125px;" title="The date this rule takes over -- the plain Share % (or an earlier scheduled rule) applies right up until this date.">
<input type="number" min="0" max="100" step="1" data-rate-rule-pct="${escapeHtml(l.id)}" placeholder="%" style="width:50px;">
<input type="number" min="0" step="1" data-rate-rule-cap="${escapeHtml(l.id)}" placeholder="Cap £ (optional)" style="width:100px;">
<button type="button" class="todo-add-btn" data-rate-rule-add="${escapeHtml(l.id)}">Add</button>
</div>
</details>`;
}

function renderAirbnbListings() {
const el = document.getElementById('airbnb-listings');
if (!el) return;
if (data.airbnbListings.length === 0) {
el.innerHTML = '<div class="settings-note" style="margin:0;">No listings yet — add one below.</div>';
return;
}
el.innerHTML = `<table class="limits-table">
<thead><tr><th>Label</th><th title="An Airbnb listing's iCal export. Leave it blank for a booking calendar that was never on Airbnb — a plumber, a decorator, a cat sitter — and give it an External prefix instead, so its bookings come from events you type into the shared Google Calendar. Sync skips a listing with no URL rather than reporting it as a broken feed." style="cursor:help; text-decoration:underline dotted;">Calendar export URL</th><th title="Identifies the physical ROOM, not the listing — give two listings for the same room the same prefix. Once you rename any manually-entered Google Calendar events for a room to include its prefix, &quot;Push to Google Calendar&quot; recognises and adopts them instead of duplicating." style="cursor:help; text-decoration:underline dotted;">Prefix</th><th title="A SECOND, different tag for a booking from outside Airbnb entirely (a friend, another platform) — type it into that Calendar event's title (e.g. &quot;ES-Lg - Jane Doe&quot;) and Sync pulls it in as a reservation on this listing, taking whatever follows the prefix as the name. Any dash, colon or pipe works as the separator. Deliberately not the same as Prefix — never mistaken for a real Airbnb booking when one of those gets pushed. Leave blank to skip this for a listing." style="cursor:help; text-decoration:underline dotted;">External prefix</th><th title="Identifies the physical ROOM, not the listing — give two listings for the same room the same colour." style="cursor:help; text-decoration:underline dotted;">Colour</th><th title="Whose listing this is. Their share of what each stay earns becomes a debt on the day the guests leave — see Letting income on the Finances tab." style="cursor:help; text-decoration:underline dotted;">Owner</th><th title="What they owe you of this listing's takings." style="cursor:help; text-decoration:underline dotted;">Share %</th><th title="Off for a space that isn't actually a guest-facing let -- a catch-all &quot;Flat&quot; used to log contractor/maintenance visits rather than a real room. Turning it off hides the Check-in/out clean chips for this listing's bookings and stops the checkout-clean nudge, since neither makes sense for a space nobody's actually staying in." style="cursor:help; text-decoration:underline dotted;">Needs cleaning</th><th></th></tr></thead>
<tbody>${data.airbnbListings.map((l) => `<tr>
<td><input type="text" autocomplete="off" data-airbnb-listing-field="label" data-airbnb-listing-id="${l.id}" value="${escapeHtml(l.label)}" placeholder="e.g. Entire studio"></td>
<td><input type="text" autocomplete="off" data-airbnb-listing-field="icsUrl" data-airbnb-listing-id="${l.id}" value="${escapeHtml(l.icsUrl)}" placeholder="https://www.airbnb..../calendar/ical/....ics — or blank if not on Airbnb"></td>
<td><input type="text" autocomplete="off" data-airbnb-listing-field="prefix" data-airbnb-listing-id="${l.id}" value="${escapeHtml(l.prefix)}" placeholder="e.g. ES-L" style="width:70px;"></td>
<td><input type="text" autocomplete="off" data-airbnb-listing-field="externalPrefix" data-airbnb-listing-id="${l.id}" value="${escapeHtml(l.externalPrefix)}" placeholder="e.g. ES-Lg" style="width:70px;"></td>
<td><select data-airbnb-listing-field="colour" data-airbnb-listing-id="${l.id}">
${AIRBNB_COLOURS.map((c) => `<option value="${c}"${c === l.colour ? ' selected' : ''}>${c.charAt(0).toUpperCase()}${c.slice(1)}</option>`).join('')}
</select></td>
<td><select data-airbnb-listing-field="ownerConnectionId" data-airbnb-listing-id="${l.id}" style="max-width:150px;">
<option value="">Nobody</option>
${(data.connections || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name))).map((c) => `<option value="${escapeHtml(c.id)}"${c.id === l.ownerConnectionId ? ' selected' : ''}>${escapeHtml(c.name || 'Unnamed')}</option>`).join('')}
</select>
<input type="text" autocomplete="off" data-airbnb-listing-field="ownerLabel" data-airbnb-listing-id="${l.id}" value="${escapeHtml(l.ownerLabel || '')}" placeholder="or a name" style="width:100px;margin-top:3px;" title="Use this when the owner isn't a connection — a child, say. The dropdown wins if both are set."></td>
<td>
<input type="number" min="0" max="100" step="1" data-airbnb-listing-field="sharePct" data-airbnb-listing-id="${l.id}" value="${escapeHtml(String(l.sharePct ?? 50))}" style="width:60px;" title="The CURRENT rate, used until a scheduled rule below takes over. See Finances → Letting income's own split logic for how a scheduled rule overrides this once its date arrives.">
${rateHistoryHtml(l)}
</td>
<td style="text-align:center;"><input type="checkbox" data-airbnb-listing-field="needsCleaning" data-airbnb-listing-id="${l.id}"${l.needsCleaning ? ' checked' : ''}></td>
<td><span class="del-x" style="opacity:1;" data-del-airbnb-listing="${l.id}">&times;</span></td>
</tr>`).join('')}</tbody>
</table>`;

el.querySelectorAll('[data-airbnb-listing-field]').forEach((input) => {
input.addEventListener('change', () => {
const listing = data.airbnbListings.find((l) => l.id === input.dataset.airbnbListingId);
if (!listing) return;
listing[input.dataset.airbnbListingField] = input.type === 'checkbox' ? input.checked : input.value.trim();
queueSave();
if (input.dataset.airbnbListingField === 'needsCleaning') renderAirbnb();
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
el.querySelectorAll('[data-rate-rule-add]').forEach((btn) => {
btn.addEventListener('click', () => {
const listing = data.airbnbListings.find((l) => l.id === btn.dataset.rateRuleAdd);
if (!listing) return;
const dateInput = el.querySelector(`[data-rate-rule-date="${CSS.escape(btn.dataset.rateRuleAdd)}"]`);
const pctInput = el.querySelector(`[data-rate-rule-pct="${CSS.escape(btn.dataset.rateRuleAdd)}"]`);
const capInput = el.querySelector(`[data-rate-rule-cap="${CSS.escape(btn.dataset.rateRuleAdd)}"]`);
const fromDate = dateInput?.value || '';
const pct = Number(pctInput?.value);
const cap = capInput?.value ? Number(capInput.value) : null;
if (!fromDate || !Number.isFinite(pct)) return;
if (!Array.isArray(listing.shareRules)) listing.shareRules = [];
listing.shareRules.push({ id: uid(), fromDate, pct, capAmount: Number.isFinite(cap) ? cap : null });
queueSave();
renderAirbnbListings();
});
});
el.querySelectorAll('[data-del-rate-rule]').forEach((x) => {
x.addEventListener('click', () => {
const [listingId, ruleId] = x.dataset.delRateRule.split(':');
const listing = data.airbnbListings.find((l) => l.id === listingId);
if (!listing) return;
listing.shareRules = (listing.shareRules || []).filter((r) => r.id !== ruleId);
queueSave();
renderAirbnbListings();
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

// Which "TBC" chips currently show their inline name/date capture form,
// keyed "${reservationId}:${edge}" -- session-only, same idiom as every
// other "is this expanded" Set in the app (e.g. planner.js's
// plannerAddOpenKeys).
const openCleanerForms = new Set();

function cleanerChipHtml(reservation, edge) {
const match = findCleanerMatch(reservation, edge);
const label = edge === 'checkin' ? 'Check-in clean' : 'Check-out clean';
if (match) return `<span class="cal-badge cleaner-chip">${label}: ${formatAirbnbDate(match.date)} &middot; ${escapeHtml(match.name)}</span>`;
const key = `${reservation.id}:${edge}`;
if (!openCleanerForms.has(key)) {
return `<span class="cal-badge cleaner-chip cleaner-chip-tbc" data-airbnb-cleaner-toggle="${key}" title="Click to add who's doing this clean and when">${label}: TBC</span>`;
}
// Prefilled to the stay's own boundary -- the common case -- but still
// editable, since the actual clean can land a day either side of it.
const prefillDate = edge === 'checkin' ? reservation.checkin : reservation.checkout;
return `<span class="cal-badge cleaner-chip-form">
${label}:
<input type="text" autocomplete="off" class="tag-add-input" placeholder="Who" data-airbnb-cleaner-name="${key}" style="max-width:90px;">
<input type="date" class="tag-add-input" data-airbnb-cleaner-date="${key}" value="${escapeHtml(prefillDate)}" style="max-width:130px;">
<button class="sync-btn sm inline" type="button" data-airbnb-cleaner-add="${key}">Add</button>
<span class="tag-x" data-airbnb-cleaner-cancel="${key}" title="Cancel">&times;</span>
<span class="sync-status" data-airbnb-cleaner-status="${key}"></span>
</span>`;
}

// Mirrors pushReservation's exact gating (signed in -> write scope ->
// push calendar configured), then writes the SAME "Cleaner - <Name>"
// title format syncCleanerEvents' own parseCleanerEventName already
// expects to read back -- so a cleaner added here is found by a later
// full Sync exactly as if it had been typed into Google Calendar by
// hand, and also updated locally right away so the chip flips to
// matched on the very next render without waiting for one.
async function addCleanerEvent(reservation, edge, name, date, statusEl) {
const trimmedName = String(name || '').trim();
if (!trimmedName) { statusEl.textContent = 'Name first.'; return; }
if (!date) { statusEl.textContent = 'Pick a date.'; return; }
if (!(await canAttemptGoogleAction())) { statusEl.textContent = 'Sign in to Google at the top of Overview first.'; return; }
if (!hasCalendarWrite()) { statusEl.innerHTML = 'Turn on "Allow creating events in Google Calendar" in <span class="inline-goto-link" data-goto-tab="settings" data-goto-target="#calendar-write-toggle">Settings</span>, then sign out and back in.'; return; }
const calendarId = data.prefs.airbnbCalendarId;
if (!calendarId) { statusEl.textContent = 'Pick which calendar to push to, next to Sync, first.'; return; }
statusEl.textContent = 'Adding…';
try {
await createEvent(calendarId, { title: `Cleaner - ${trimmedName}`, date });
data.airbnbCleanerEvents = [...(data.airbnbCleanerEvents || []), { date, name: trimmedName }];
openCleanerForms.delete(`${reservation.id}:${edge}`);
queueSave();
renderAirbnb();
} catch (err) {
statusEl.textContent = `Couldn't add: ${err.message || err}`;
}
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
<input type="number" step="0.01" min="0" class="tag-add-input" placeholder="Income £" data-airbnb-res-field="income" data-airbnb-res-id="${r.id}" value="${r.income ?? ''}" style="max-width:95px;" title="What this stay earned. The owner's share becomes a debt on the checkout date — see Letting income on Finances.">
<select data-airbnb-res-field="platform" data-airbnb-res-id="${r.id}" title="Which platform this stay's income came through -- the Letting income chart on Finances breaks solid (Airbnb) out from striped (Other).">
<option value="airbnb"${r.platform !== 'other' ? ' selected' : ''}>Airbnb</option>
<option value="other"${r.platform === 'other' ? ' selected' : ''}>Other</option>
</select>
${r.source === 'external'
? '<span class="settings-note" style="margin:0;" title="Found on the shared calendar by its external prefix -- nothing to push, it\'s already there.">External &#10003;</span>'
: r.googleEventId
? '<span class="settings-note" style="margin:0;">Pushed &#10003;</span>'
: `<button class="sync-btn inline" type="button" data-airbnb-push="${r.id}" title="Push to Google Calendar">Push</button>`}
<span class="sync-status" data-airbnb-push-status="${r.id}"></span>
${r.source === 'manual' ? `<span class="del-x" style="opacity:1;" data-airbnb-res-del="${r.id}" title="Delete this booking — nothing else records it, so it won't come back on the next Sync">&times;</span>` : ''}
${data.prefs.airbnbCalendarId && listing.needsCleaning ? `<div class="cal-clean-group">${cleanerChipHtml(r, 'checkin')}${cleanerChipHtml(r, 'checkout')}</div>` : ''}
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

// ---- Manual bookings ------------------------------------------------------

// A third source alongside 'ics' and 'external': typed straight in here,
// backed by no calendar event at all. It exists because the other two
// both route through something external -- an Airbnb feed, or an event
// you have to go and create in Google Calendar first -- and "the plumber
// is coming on the 25th" shouldn't need either. It can still be pushed
// to Calendar afterwards like any feed booking, which is why it gets no
// special casing in reservationRowHtml: no googleEventId means the Push
// button shows, and that's exactly right.
//
// The ICS sync deliberately ignores this source (see syncAirbnbListing's
// own filter) so a manual booking on a feed-backed listing survives.
function renderAirbnbAddBooking() {
const select = document.getElementById('airbnb-add-listing');
if (!select) return;
const previous = select.value;
select.innerHTML = data.airbnbListings.length
? data.airbnbListings.map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.label || l.prefix || 'Listing')}</option>`).join('')
: '<option value="">No listings yet</option>';
if (previous && data.airbnbListings.some((l) => l.id === previous)) select.value = previous;
}

function initAirbnbAddBooking() {
const btn = document.getElementById('airbnb-add-btn');
if (!btn) return;
renderAirbnbAddBooking();
btn.addEventListener('click', () => {
const select = document.getElementById('airbnb-add-listing');
const nameInput = document.getElementById('airbnb-add-name');
const fromInput = document.getElementById('airbnb-add-from');
const toInput = document.getElementById('airbnb-add-to');
const status = document.getElementById('airbnb-add-status');
const listingId = select.value;
const checkin = fromInput.value;
if (!listingId) { status.innerHTML = 'Add a listing in <span class="inline-goto-link" data-goto-tab="settings" data-goto-target="#airbnb-listings">Settings</span> first.'; return; }
if (!checkin) { status.textContent = 'Pick a start date.'; return; }
// A blank "to" means a single day, not a missing field -- the common
// case on a trades calendar, and making it optional is the difference
// between two taps and four.
let checkout = toInput.value || checkin;
if (checkout < checkin) { status.textContent = "The last day is before the first — check the dates."; return; }
data.airbnbReservations.push(blankAirbnbReservation({
listingId, checkin, checkout, source: 'manual', guestName: nameInput.value.trim(),
}));
nameInput.value = '';
fromInput.value = '';
toInput.value = '';
status.textContent = 'Added.';
queueSave();
renderAirbnb();
// The planner's occupancy stripes read straight from these
// reservations, so they're stale the moment one is added -- same
// dynamic import the sync path already uses to avoid an import cycle.
import('./planner.js').then(({ renderPlanner }) => renderPlanner()).catch(() => {});
});
}

function renderAirbnb() {
renderAirbnbAddBooking();
const el = document.getElementById('airbnb-list');
const countEl = document.getElementById('airbnb-count');
if (!el) return;
const upcoming = data.airbnbReservations
.filter((r) => r.checkout >= todayStr() || (!r.accruedAt && r.checkout >= dateStrAdd(todayStr(), -AWAITING_INCOME_DAYS)))
.sort((a, b) => (a.checkin < b.checkin ? -1 : a.checkin > b.checkin ? 1 : 0));
if (countEl) countEl.textContent = upcoming.length ? String(upcoming.length) : '';
const errorsHtml = airbnbSyncErrorsHtml();
el.innerHTML = errorsHtml + refundsPendingHtml() + (upcoming.length
? upcoming.map(reservationRowHtml).join('')
: (errorsHtml ? '' : '<div class="empty">Nothing upcoming — add a listing in <span class="inline-goto-link" data-goto-tab="settings" data-goto-target="#airbnb-listings">Settings</span> and Sync.</div>'));

bindRefundsPending(el);
el.querySelectorAll('[data-airbnb-res-field]').forEach((input) => {
input.addEventListener('change', () => {
const r = data.airbnbReservations.find((x) => x.id === input.dataset.airbnbResId);
if (!r) return;
const field = input.dataset.airbnbResField;
// Income is money, not text: stored as a number so the ledger can add
// it up, and a cleared box means "not known" rather than zero.
r[field] = field === 'income'
? (input.value.trim() === '' ? null : Number(input.value))
: input.value;
queueSave();
// Entering it on a stay that has already ended should charge it now
// rather than at the next app open -- that gap is exactly when you'd
// go to Finances to check the figure.
if (field === 'income') {
import('./letting.js').then((m) => { m.accrueLettings(); m.renderLetting(); });
}
});
});
// Only manual bookings carry this -- a feed or external one is deleted
// by removing it at its source, and deleting it here would just see it
// reappear on the next Sync.
el.querySelectorAll('[data-airbnb-res-del]').forEach((x) => {
x.addEventListener('click', () => {
data.airbnbReservations = data.airbnbReservations.filter((r) => r.id !== x.dataset.airbnbResDel);
queueSave();
renderAirbnb();
import('./planner.js').then(({ renderPlanner }) => renderPlanner()).catch(() => {});
});
});
el.querySelectorAll('[data-airbnb-push]').forEach((btn) => {
btn.addEventListener('click', () => {
const r = data.airbnbReservations.find((x) => x.id === btn.dataset.airbnbPush);
const statusEl = el.querySelector(`[data-airbnb-push-status="${btn.dataset.airbnbPush}"]`);
if (r && statusEl) pushReservation(r, statusEl);
});
});
el.querySelectorAll('[data-airbnb-cleaner-toggle]').forEach((chip) => {
chip.addEventListener('click', () => {
openCleanerForms.add(chip.dataset.airbnbCleanerToggle);
renderAirbnb();
});
});
el.querySelectorAll('[data-airbnb-cleaner-cancel]').forEach((x) => {
x.addEventListener('click', () => {
openCleanerForms.delete(x.dataset.airbnbCleanerCancel);
renderAirbnb();
});
});
el.querySelectorAll('[data-airbnb-cleaner-add]').forEach((btn) => {
btn.addEventListener('click', () => {
const key = btn.dataset.airbnbCleanerAdd;
const sep = key.lastIndexOf(':');
const reservation = data.airbnbReservations.find((r) => r.id === key.slice(0, sep));
const edge = key.slice(sep + 1);
const nameInput = el.querySelector(`[data-airbnb-cleaner-name="${key}"]`);
const dateInput = el.querySelector(`[data-airbnb-cleaner-date="${key}"]`);
const statusEl = el.querySelector(`[data-airbnb-cleaner-status="${key}"]`);
if (reservation && nameInput && dateInput && statusEl) {
addCleanerEvent(reservation, edge, nameInput.value, dateInput.value, statusEl);
}
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
keysDragActive = true;
});
card.addEventListener('dragend', () => { card.classList.remove('dragging'); keysDragActive = false; });
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
// Bound once here, not inside renderAirbnb()/bindKeyCards (which re-run
// every render and would stack duplicate listeners) -- same "init once"
// placement planner.js uses for its own equivalent listener.
document.addEventListener('dragover', autoScrollDuringKeyDrag);
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
// The same email's payout breakdown -- "Host payout / Total Stay Price /
// £400.00 / Host service fee (3.0% + VAT) / -£14.40 / You earn / £385.60"
// -- "You earn" is the one line that's already the net figure, so no
// fee subtraction needs doing here. A loose gap between the words and
// the amount (rather than requiring them adjacent) since stripHtml
// turns Airbnb's own table layout into plain text with whatever
// whitespace/line breaks happened to fall between the two.
const PAYOUT_RE = /you\s*earn[\s\S]{0,60}?£\s*([\d,]+\.\d{2})/i;
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

// ---- Cancellation payout extraction ------------------------------------
//
// Posted straight to lettingLedger as its own 'cancellation' kind,
// bypassing accrueLettings() entirely: that function only ever fires at
// checkout, and a cancelled stay's checkout may never be reached by a
// reservation record that's about to vanish from the feed.
//
// Self-contained from the email alone, NOT dependent on a surviving
// reservation record -- confirmed real need, not a hypothetical one:
// the first real cancellation this feature saw (HMEDC2S4QB, 14-25 Oct)
// went unposted because the reservation it needed was already gone by
// the time Sync ran. Two separate things can delete it first: the ICS
// sync right after this one in initAirbnbSync (syncAllAirbnbListings'
// own "whatever's left in existingByUid... gone" cleanup), or Chrome's
// own periodic background sync (bgsync.js's refreshAirbnbFeeds, which
// has no Gmail access at all and can fire while the app is closed) --
// either can win the race overnight, well before any Sync click. The
// listing is resolved instead by matching the email's own stated
// "Listing #<id>" against the numeric id embedded in each listing's
// icsUrl (confirmed against all three real listings: Airbnb's feed URL
// is always .../calendar/ical/<id>.ics?...); the guest name comes
// straight off "your guest X had to cancel" in the body. The old
// date-range match against a live reservation (matchReservationFor
// Cancellation) is kept only as a fallback for a listing whose icsUrl
// doesn't carry its id for some reason -- no longer load-bearing for
// the normal case.
//
// Airbnb's own email: subject "Cancelled: Reservation <CODE> for
// <D>[ <Month>]–<D> <Month>[ <Year>]" -- confirmed against ten real
// cancellation emails spanning several months that (a) the year is
// sometimes present and sometimes not, and (b) a stay crossing a month
// boundary ("23 Sept – 13 Oct") states BOTH months, not just one -- 3
// of those 10 do this. A single trailing month, assumed to cover both
// days, silently failed to match (no fallback, no "seen" marked, just
// dropped) on every one of those 3 until caught here; the start
// month is now its own optional group, defaulting to the end month
// when the stay doesn't cross a boundary. Body: "...your payout has
// been updated to £X.XX" (the REVISED, post-cancellation-policy
// payout, not the original booking's full price), "Listing #<id>",
// "your guest <Name> had to cancel".
const CANCELLATION_SUBJECT_RE = /^Cancelled:\s*Reservation\s+(\S+)\s+for\s+(\d{1,2})(?:\s+([a-z]+))?\s*[–—-]\s*(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?$/i;
const CANCELLATION_QUERY = 'subject:"Cancelled: Reservation"';
const CANCELLATION_SEARCH_LIMIT = 25;
// Loose gap between the words and the amount, same tolerance PAYOUT_RE
// above uses for stripped-HTML whitespace.
const CANCELLATION_PAYOUT_RE = /payout\s*has\s*been\s*updated\s*to[\s\S]{0,20}?£\s*([\d,]+\.\d{2})/i;
const CANCELLATION_LISTING_ID_RE = /Listing\s*#\s*(\d+)/i;
const CANCELLATION_GUEST_RE = /your\s+guest\s+(.+?)\s+had\s+to\s+cancel/i;

// Real example confirmed live (Gmail connector, "automated@airbnb.com",
// 22 Oct 2026 message): subject "You've sent Timo money", body (real
// text/plain part, not derived from HTML) "YOU'VE SENT £200 GBP TO
// TIMO" then, a few lines down, "22 Oct – 2 Nov 2026" -- the stay's own
// check-in/check-out range, with no listing id or reservation code
// anywhere in the email (unlike the cancellation template above). The
// link in the email itself (resolutions/CLA-...,
// claims/resolution_center/to_responder_offer_money) confirms this is
// specifically a Resolution Center payout -- money the host sent BACK
// to a guest, not income. Four more real examples (Alfryd, Eduardo, a
// non-Latin name, Sandra) confirmed the same subject/body shape holds
// across different guests and amounts.
const REFUND_SUBJECT_RE = /^You've sent (.+?) money$/i;
const REFUND_QUERY = 'from:(automated@airbnb.com) subject:"You\'ve sent"';
const REFUND_SEARCH_LIMIT = 25;
const REFUND_AMOUNT_RE = /sent\s*£([\d,]+\.?\d*)\s*GBP/i;
// The start month is omitted when both ends fall in the same month
// ("19–22 Oct 2026" vs "22 Oct – 2 Nov 2026") -- both seen in real emails.
const REFUND_DATE_RANGE_RE = /(\d{1,2})(?:\s+([A-Za-z]+))?\s*[–—-]\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/;

// The digits immediately before ".ics" in an Airbnb feed URL ARE the
// listing's public id -- confirmed against all three real listings
// (Settings -> Travel -> Airbnb listings), each shaped
// .../calendar/ical/<id>.ics?t=<token>.
function airbnbIdFromIcsUrl(url) {
const m = /(\d{6,})\.ics/i.exec(String(url || ''));
return m ? m[1] : '';
}
function listingByAirbnbId(airbnbId) {
if (!airbnbId) return null;
return (data.airbnbListings || []).find((l) => airbnbIdFromIcsUrl(l.icsUrl) === airbnbId) || null;
}

// Fallback only -- see this section's header comment for why the id
// match above is primary now. Both checkin AND checkout matched (not
// just checkin, the way arrival matching above only needs), with their
// OWN months (a stay can cross a month boundary), since the subject
// states the whole range here. More than one match is genuinely
// ambiguous -- skipped, same discipline as matchReservationForArrival.
function matchReservationForCancellation(startDay, startMonth, endDay, endMonth) {
const candidates = data.airbnbReservations.filter((r) => {
const inD = new Date(`${r.checkin}T00:00:00`);
const outD = new Date(`${r.checkout}T00:00:00`);
return inD.getDate() === startDay && inD.getMonth() + 1 === startMonth
&& outD.getDate() === endDay && outD.getMonth() + 1 === endMonth;
});
return candidates.length === 1 ? candidates[0] : null;
}

// Only needed when the subject itself has no year AND no reservation
// survived to read a real checkin year off. Picks whichever of last/
// this/next year actually lands closest to the email's OWN date header
// -- an anchor Airbnb itself stamped on the message, not a guess, same
// spirit as this file's everywhere-else "never guess a year" rule, just
// anchored to the email instead of a reservation.
function inferCancellationYear(day, month, emailDate) {
const anchor = new Date(emailDate);
if (isNaN(anchor)) return new Date().getFullYear();
let best = anchor.getFullYear();
let bestDiff = Infinity;
[best - 1, best, best + 1].forEach((y) => {
const diff = Math.abs(new Date(y, month - 1, day) - anchor);
if (diff < bestDiff) { bestDiff = diff; best = y; }
});
return best;
}

// Dedup is by Gmail message id (data.prefs.airbnbCancellationsSeen).
// Marked seen once the subject's own fields are read AND either a
// listing was found or genuinely couldn't be -- not any earlier, now
// that reading the email is unavoidable anyway (the id match needs the
// body) and a fetch failure specifically is worth retrying rather than
// silently eating one Gmail message forever.
async function syncCancellationsFromEmail() {
if (!(await canAttemptGoogleAction())) return { posted: 0 };
if (!Array.isArray(data.prefs.airbnbCancellationsSeen)) data.prefs.airbnbCancellationsSeen = [];
const seen = new Set(data.prefs.airbnbCancellationsSeen);

const { fetchMailSearches, getMessageDetail } = await import('../googlemail.js');
const search = { kind: 'query', value: CANCELLATION_QUERY, maxDays: 0, maxEvents: CANCELLATION_SEARCH_LIMIT };
let sections;
try {
sections = await fetchMailSearches([search], CANCELLATION_SEARCH_LIMIT);
} catch (err) {
console.error('Cancellation email search failed:', err);
return { posted: 0, error: err.message || String(err) };
}

const { ownerKeyFor } = await import('./letting.js');
let posted = 0;
let unmatched = 0;
let unowned = 0;
for (const m of sections[0]?.messages || []) {
if (seen.has(m.id)) continue;
const subjectMatch = CANCELLATION_SUBJECT_RE.exec(String(m.subject || '').trim());
if (!subjectMatch) continue;
const endMonthIdx = MONTH_NAMES.indexOf(subjectMatch[5].slice(0, 3).toLowerCase());
if (endMonthIdx === -1) { seen.add(m.id); continue; }
// The start month is its own group only when the stay crosses a
// month boundary -- otherwise it's absent and shares the end month.
const startMonthIdx = subjectMatch[3] ? MONTH_NAMES.indexOf(subjectMatch[3].slice(0, 3).toLowerCase()) : endMonthIdx;
if (startMonthIdx === -1) { seen.add(m.id); continue; }
const startDay = Number(subjectMatch[2]);
const endDay = Number(subjectMatch[4]);
const subjectYear = subjectMatch[6] ? Number(subjectMatch[6]) : null;

let detail;
try {
detail = await getMessageDetail(m.id);
} catch (err) {
console.error('Cancellation email fetch failed:', err);
unmatched++;
continue; // not marked seen -- a fetch failure is worth retrying
}
const bodyText = detail.bodyText || '';
const payoutMatch = CANCELLATION_PAYOUT_RE.exec(bodyText);
if (!payoutMatch) { seen.add(m.id); unmatched++; continue; }
const payout = Number(payoutMatch[1].replace(/,/g, ''));

const idMatch = CANCELLATION_LISTING_ID_RE.exec(bodyText);
let listing = idMatch ? listingByAirbnbId(idMatch[1]) : null;
let reservation = null;
if (!listing) {
reservation = matchReservationForCancellation(startDay, startMonthIdx + 1, endDay, endMonthIdx + 1);
if (reservation) listing = data.airbnbListings.find((l) => l.id === reservation.listingId);
}
if (!listing) { seen.add(m.id); unmatched++; continue; }
const ownerKey = ownerKeyFor(listing);
if (!ownerKey) { unowned++; continue; } // not marked done: posts once the listing has an owner

const guestMatch = CANCELLATION_GUEST_RE.exec(bodyText);
const guestName = (guestMatch && guestMatch[1].trim()) || (reservation && reservation.guestName) || '';
// A subject year, when present, is stated after the END date -- if the
// stay also crosses a YEAR boundary (Dec checkin, Jan checkout), the
// checkin itself is one year earlier.
const checkinYear = subjectYear
? (startMonthIdx > endMonthIdx ? subjectYear - 1 : subjectYear)
: (reservation ? new Date(`${reservation.checkin}T00:00:00`).getFullYear() : inferCancellationYear(startDay, startMonthIdx + 1, detail.date || m.date));
const checkin = `${checkinYear}-${String(startMonthIdx + 1).padStart(2, '0')}-${String(startDay).padStart(2, '0')}`;

// A content-level guard, not just the message-id `seen` set above --
// confirmed live as a real gap: a cancellation posted once by hand
// (console snippet, bypassing `seen` entirely) got posted a SECOND
// time automatically once this function's own id-based listing match
// no longer needed the reservation to survive. The same race is
// possible between two devices syncing close together too, each
// reading `seen` before the other's write has synced back. Skips a
// cancellation payout that's already recorded for this owner, this
// release date and this gross amount -- cheap, and a genuine second
// cancellation on the exact same date for the exact same payout is
// not a real scenario this app needs to support.
const releaseDate = dateStrAdd(checkin, 1);
const alreadyRecorded = data.lettingLedger.some((e) => e.kind === 'cancellation' && e.ownerKey === ownerKey && e.date === releaseDate && Math.abs((Number(e.gross) || 0) - payout) < 0.01);
if (alreadyRecorded) { seen.add(m.id); continue; }
const share = Number(listing.sharePct);
const pct = Number.isFinite(share) ? share : 50;
const amount = Math.round(payout * (pct / 100) * 100) / 100;
data.lettingLedger.push({
id: uid(), ownerKey, kind: 'cancellation', amount, gross: payout, pct,
platform: 'airbnb',
// Matches the email's own stated timing ("released 24 hours after
// the check-in date"), not today -- so this lands in the right tax
// year/chart month even when Sync runs well after the fact.
date: releaseDate,
// Just the guest name -- the 'cancellation' kind badge already says
// what this is, same as an 'earned' row's note is just the payer's
// name with no "earned" repeated in the text itself.
note: guestName || listing.label || 'Cancellation payout',
});
seen.add(m.id);
posted++;
}
data.prefs.airbnbCancellationsSeen = [...seen];
if (posted || unmatched) queueSave();
return { posted, unmatched, unowned };
}

// Posted to lettingLedger as a NEGATIVE 'refund' entry -- real money
// that left the business, not income, so it's excluded by construction
// from the per-night-rate chart (letting.js's own month-builder only
// ever counts 'earned'/'cancellation'/orphaned-'accrual' rows, and only
// when `gross` is set -- a refund row deliberately carries neither).
// Matched to a reservation purely by its stated check-in/check-out
// range (matchReservationForCancellation, already built for the
// cancellation email above) -- there's no listing id or reservation
// code anywhere in this email template to match on instead, unlike
// cancellations. Genuinely ambiguous (more than one reservation shares
// that exact date range) is left unmatched rather than guessed, same
// discipline as everywhere else in this file.
// A refund email arrives AFTER the stay, often once the guest has gone and
// the feed has dropped the reservation -- so this checks live reservations
// first, then the minimal record of finished stays kept by the ICS sync.
function matchStayForRefund(startDay, startMonth, endDay, endMonth) {
const hits = (list) => list.filter((r) => {
const inD = new Date(`${r.checkin}T00:00:00`);
const outD = new Date(`${r.checkout}T00:00:00`);
return inD.getDate() === startDay && inD.getMonth() + 1 === startMonth
&& outD.getDate() === endDay && outD.getMonth() + 1 === endMonth;
});
const live = hits(data.airbnbReservations);
if (live.length) return live.length === 1 ? live[0] : null;
const past = hits(data.airbnbPastStays || []);
if (past.length) return past.length === 1 ? past[0] : null;
// Stays that finished before past stays were kept at all: an income row
// already on the ledger records the listing, the checkout date and the
// number of nights, which is enough to rebuild the stay's dates.
const fromLedger = (data.lettingLedger || [])
.filter((e) => e.kind === 'accrual' && e.listingId && e.date && Number(e.nights) > 0)
.map((e) => ({ listingId: e.listingId, checkout: e.date, checkin: dateStrAdd(e.date, -Number(e.nights)), guestName: '' }));
const rebuilt = hits(fromLedger);
return rebuilt.length === 1 ? rebuilt[0] : null;
}

// A cancelled stay vanishes from every feed, but its cancellation payout
// row is on the ledger with the guest's name and a date one day after
// check-in -- so a refund for the same guest whose stay starts that day is
// the same booking.
function cancellationFor(guest, startDay, startMonth) {
const g = String(guest || '').trim().toLowerCase();
if (!g) return null;
return (data.lettingLedger || []).find((e) => {
if (e.kind !== 'cancellation' || !e.ownerKey || String(e.note || '').trim().toLowerCase() !== g) return false;
const checkin = new Date(`${dateStrAdd(e.date, -1)}T00:00:00`);
return checkin.getDate() === startDay && checkin.getMonth() + 1 === startMonth;
}) || null;
}

// The one place a refund row is written -- from Sync, or from mapping an
// unposted one by hand. Returns false when it was already on the ledger.
function postRefundRow({ ownerKey, amount, sentOn, guest, messageId, fallbackNote }) {
const already = data.lettingLedger.some((e) => e.kind === 'refund' && (e.sourceMessageId === messageId
|| (e.ownerKey === ownerKey && (e.note || '') === (guest || '') && Math.abs((Number(e.amount) || 0) + amount) < 0.01
&& Math.abs(new Date(`${e.date}T00:00:00`) - new Date(`${sentOn}T00:00:00`)) <= 14 * 86400000)));
if (already) return false;
data.lettingLedger.push({
id: uid(), ownerKey, kind: 'refund',
amount: -amount, // money OUT, not in -- the whole point of this kind
platform: 'airbnb',
date: sentOn,
note: guest || fallbackNote || 'Refund to guest',
sourceMessageId: messageId,
});
return true;
}

// Unposted refunds, offered for mapping by hand: pick who it's charged to
// (the owners already on the ledger, not free text) and post it. The
// email link is the record reference back to the real message.
function refundsPendingHtml() {
const list = data.prefs.airbnbRefundsPending || [];
if (!list.length) return '';
const opts = owners().map((k) => `<option value="${escapeHtml(k)}">${escapeHtml(ownerNameFor(k))}</option>`).join('');
return `<div class="settings-note" style="margin:6px 0 2px;font-weight:600;">Guest refunds waiting to be assigned</div>`
+ list.map((p) => `<div class="alloc-card" data-refund-card="${escapeHtml(p.id)}">
<div class="settings-note" style="margin:0;"><strong>${escapeHtml(p.guest)}</strong> &middot; ${escapeHtml(money(p.amount))} &middot; stay ${escapeHtml(p.range)} &middot; sent ${escapeHtml(p.sentOn)} &middot; <a href="${escapeHtml(gmailLink(null, null, p.id))}" target="_blank" rel="noopener">email</a></div>
<div class="settings-note" style="margin:2px 0 4px;">${escapeHtml(p.why)}${p.listingId ? ` &mdash; or set it once in <span class="inline-goto-link" data-goto-tab="settings" data-goto-target="#airbnb-listings">Settings</span>` : ''}.</div>
<div class="alloc-controls"><select class="settings-input" data-refund-owner="${escapeHtml(p.id)}"><option value="">Charge to&hellip;</option>${opts}</select>
<button class="sync-btn sm inline" type="button" data-refund-post="${escapeHtml(p.id)}">Post</button>
<button class="del-x" type="button" data-refund-dismiss="${escapeHtml(p.id)}" title="Leave this refund off the ledger">&times;</button></div>
</div>`).join('');
}

function bindRefundsPending(root) {
const finish = (id, posted) => {
data.prefs.airbnbRefundsPending = (data.prefs.airbnbRefundsPending || []).filter((p) => p.id !== id);
if (!Array.isArray(data.prefs.airbnbRefundsDone)) data.prefs.airbnbRefundsDone = [];
data.prefs.airbnbRefundsDone.push(id); // stops Sync re-offering it
queueSave();
renderAirbnb();
if (posted) import('./letting.js').then((m) => m.renderLetting());
};
root.querySelectorAll('[data-refund-post]').forEach((btn) => btn.addEventListener('click', () => {
const id = btn.dataset.refundPost;
const p = (data.prefs.airbnbRefundsPending || []).find((x) => x.id === id);
const ownerKey = root.querySelector(`[data-refund-owner="${CSS.escape(id)}"]`).value;
if (!p || !ownerKey) return;
postRefundRow({ ownerKey, amount: p.amount, sentOn: p.sentOn, guest: p.guest, messageId: p.id });
finish(id, true);
}));
root.querySelectorAll('[data-refund-dismiss]').forEach((btn) => btn.addEventListener('click', () => finish(btn.dataset.refundDismiss, false)));
}

// Returns {posted, problems:[{guest, listingId?, why}]}. Nothing is dropped
// silently any more: an email that can't be posted is reported with the
// reason, and (unlike before) is retried on the next sync rather than being
// marked done -- so fixing the cause (setting a listing's owner) lets it post.
async function syncRefundsFromEmail() {
if (!(await canAttemptGoogleAction())) return { posted: 0, problems: [] };
// V2: the first version marked unmatched/ownerless emails as done
// forever, so those are given another chance under a fresh list.
if (!Array.isArray(data.prefs.airbnbRefundsDone)) data.prefs.airbnbRefundsDone = [];
const seen = new Set(data.prefs.airbnbRefundsDone);
const problems = [];

const { fetchMailSearches, getMessageDetail } = await import('../googlemail.js');
const search = { kind: 'query', value: REFUND_QUERY, maxDays: 0, maxEvents: REFUND_SEARCH_LIMIT };
let sections;
try {
sections = await fetchMailSearches([search], REFUND_SEARCH_LIMIT);
} catch (err) {
console.error('Refund email search failed:', err);
return { posted: 0, problems, error: err.message || String(err) };
}

const { ownerKeyFor } = await import('./letting.js');
let posted = 0;
const mappable = [];
for (const m of sections[0]?.messages || []) {
if (seen.has(m.id)) continue;
const subjectMatch = REFUND_SUBJECT_RE.exec(String(m.subject || '').trim());
if (!subjectMatch) continue;
const guestName = subjectMatch[1].trim();

let detail;
try {
detail = await getMessageDetail(m.id);
} catch (err) {
console.error('Refund email fetch failed:', err);
problems.push({ guest: guestName, why: "couldn't read the email" });
continue;
}
const bodyText = detail.bodyText || '';
const amountMatch = REFUND_AMOUNT_RE.exec(bodyText);
const rangeMatch = REFUND_DATE_RANGE_RE.exec(bodyText);
if (!amountMatch || !rangeMatch) { seen.add(m.id); problems.push({ guest: guestName, why: "the email's amount or stay dates weren't in a form I recognise" }); continue; }
const amount = Number(amountMatch[1].replace(/,/g, ''));

const endMonthIdx = MONTH_NAMES.indexOf(rangeMatch[4].slice(0, 3).toLowerCase());
const startMonthIdx = rangeMatch[2] ? MONTH_NAMES.indexOf(rangeMatch[2].slice(0, 3).toLowerCase()) : endMonthIdx;
if (startMonthIdx === -1 || endMonthIdx === -1) { seen.add(m.id); problems.push({ guest: guestName, why: "the stay's month wasn't readable" }); continue; }
// The money left on the email's own date, not on whichever day Sync ran --
// matters now that a refund can be posted days after it was sent.
const sentOn = detail.date && !isNaN(new Date(detail.date)) ? new Date(detail.date).toISOString().slice(0, 10) : todayStr();

// Who it is charged to: the stay's listing if the stay can be found, else
// the cancellation payout already on the ledger for this same guest (a
// cancelled stay is gone from every feed, but its payout row remembers the
// owner and the check-in date).
const stay = matchStayForRefund(Number(rangeMatch[1]), startMonthIdx + 1, Number(rangeMatch[3]), endMonthIdx + 1);
const listing = stay ? data.airbnbListings.find((l) => l.id === stay.listingId) : null;
let ownerKey = listing ? ownerKeyFor(listing) : '';
let label = listing ? listing.label : '';
if (!ownerKey) {
const canc = cancellationFor(guestName, Number(rangeMatch[1]), startMonthIdx + 1);
if (canc) { ownerKey = canc.ownerKey; label = canc.note; }
}
if (!ownerKey) {
const p = {
id: m.id, guest: guestName, amount, sentOn, range: rangeMatch[0].trim(), listingId: listing ? listing.id : '',
why: listing ? `"${listing.label || 'the listing'}" has no owner set` : 'no single stay with those dates is on file',
};
problems.push(p);
mappable.push(p);
continue;
}
if (postRefundRow({ ownerKey, amount, sentOn, guest: guestName, messageId: m.id, fallbackNote: label })) posted++;
seen.add(m.id);
}
data.prefs.airbnbRefundsDone = [...seen];
// Replaced wholesale each sync: what's still unposted is exactly what the
// Airbnb panel offers to map by hand.
data.prefs.airbnbRefundsPending = mappable;
queueSave();
return { posted, problems };
}

// Runs the search and fills in whatever it can match; never touches a
// reservation that already has a name. A non-Latin name (the common case
// this exists for) is romanized via ai.js -- only when actually needed,
// same "check before spending an AI call" discipline the Chrome
// LanguageDetector pre-check in tinderimport.js uses ahead of
// translateText. The original script is kept in notes (appended, not
// overwriting anything already there) so the romanization can be
// double-checked against it rather than trusted blind.
//
// The payout ("You earn £X.XX") rides along on the SAME email, but isn't
// in the subject -- the search above only fetches metadata (cheap, fine
// for 25 messages at once), so a matched reservation gets ONE extra
// format=full fetch for its own body, not all of them up front.
async function syncGuestNamesFromEmail() {
const pending = data.airbnbReservations.filter((r) => !r.guestName && r.checkout >= todayStr());
if (!pending.length || !(await canAttemptGoogleAction())) return { filled: 0 };

const { fetchMailSearches, getMessageDetail } = await import('../googlemail.js');
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
let incomeFilled = 0;
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
if (reservation.income == null) {
try {
const detail = await getMessageDetail(m.id);
const payoutMatch = PAYOUT_RE.exec(detail.bodyText || '');
if (payoutMatch) {
reservation.income = Number(payoutMatch[1].replace(/,/g, ''));
incomeFilled++;
}
} catch (err) {
// Never blocks the name fill this function exists for -- the payout
// is a bonus extraction on top of it, typeable by hand same as always.
console.error('Payout extraction failed, leaving income blank:', err);
}
}
filled++;
}
if (filled) queueSave();
return { filled, romanizeFailed, incomeFilled };
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
// Same exclusive-end correction as the external scan (eventDayRange),
// so a hand-typed ALL-DAY event's dates compare fairly against
// Google's own exclusive end.
const match = candidates.length === 1 ? candidates[0] : null;
const matchRange = match ? eventDayRange(match) : null;
// Adopted only on an EXACT date match -- confirmed live as a real bug,
// not a hypothetical one: adopting the one same-prefix candidate
// REGARDLESS of how much its dates differed once silently linked a
// DIFFERENT, already-pushed booking's event to this reservation (two
// back-to-back guests on the same listing, the later one's event
// falling inside the earlier reservation's own +-2 day search window)
// -- "Pushed ✓" kept showing for a reservation whose real event, on
// Calendar, belonged to someone else's stay entirely. A near-miss is
// surfaced in the create branch below instead of acted on blind.
if (match && matchRange.checkin === reservation.checkin && matchRange.checkout === reservation.checkout) {
reservation.googleEventId = match.id;
reservation.googleCalendarId = calendarId;
statusEl.textContent = `Matched an existing "${match.summary}" event — adopted, nothing new created.`;
} else if (candidates.length > 1) {
statusEl.textContent = `${candidates.length} existing events near these dates already mention "${listing.prefix}" — too ambiguous to adopt one automatically. Rename or remove the extras in Google Calendar, then push again.`;
} else {
// A same-day visit (the sprinkler service) has no stay to put check-in
// and check-out times on -- 15:00 to 11:00 the same day ends before it
// starts, which Google refuses with a 400. It goes in as an all-day event.
const sameDay = reservation.checkin === reservation.checkout;
const created = await createEvent(calendarId, sameDay
? { title, description, date: reservation.checkin }
: {
title, description,
date: reservation.checkin, endDate: reservation.checkout,
startTime: CHECKIN_TIME, endTime: CHECKOUT_TIME,
});
reservation.googleEventId = created.id;
reservation.googleCalendarId = calendarId;
statusEl.textContent = match
? `Pushed as a new event — a nearby "${match.summary}" (${matchRange.checkin} → ${matchRange.checkout}) mentions "${listing.prefix}" too but its dates don't match this stay, so it wasn't adopted.`
: 'Pushed.';
}
queueSave();
renderAirbnb();
} catch (err) {
statusEl.textContent = `Couldn't push: ${err.message || err}`;
}
}

// "Pushed ✓" used to mean only "a create call once succeeded" -- reported
// directly as misleading once a booking's own event had genuinely
// vanished from Calendar (deleted by hand, or any other reason outside
// this app) while the dashboard kept showing Pushed forever, since
// nothing ever checked back. Re-verifies every upcoming pushed
// reservation's event still actually exists, and reverts it to "needs
// pushing" (clearing googleEventId/googleCalendarId, so
// pushReservation's own `if (reservation.googleEventId) return` no
// longer blocks a re-push) if it doesn't.
//
// Also catches a real, confirmed-live conflict: pushReservation's own
// adoption step once matched a DIFFERENT, already-pushed booking's
// event (same listing, dates inside this one's own +-2 day search
// window -- an ordinary case for back-to-back guests), silently
// linking two different reservations to ONE event. That's detected for
// free, with no network call, by simply noticing two reservations
// claiming the SAME googleEventId -- unambiguous, since an id can only
// really belong to one of them.
//
// Deliberately does NOT clear a UNIQUELY-claimed event just because its
// dates no longer match the reservation's own -- confirmed live as a
// real false positive otherwise, on an entirely different legitimate
// case: an all-day event's end date is exclusive on Calendar but
// eventDayRange() (correctly, for display) corrects that back to an
// INCLUSIVE last night, while a reservation's own `checkout` field
// stays exclusive -- comparing the two directly is comparing different
// conventions and is off by a day for every genuinely-correct all-day
// pushed/adopted event, not just a wrong one. A booking's dates can
// also legitimately change after it was pushed (an ICS-synced
// extension) with nobody re-pushing yet -- the event is still truly
// ITS OWN, just stale, and this app has no way to update an existing
// event's dates, so the right move is leaving the link alone, not
// abandoning it and letting a re-push create a duplicate beside it.
// Scoped to upcoming reservations only (checkout >= today) -- a past
// stay's event disappearing or drifting changes nothing worth
// re-pushing for.
async function verifyPushedEvents() {
const candidates = data.airbnbReservations.filter((r) => r.googleEventId && r.googleCalendarId && r.checkout >= todayStr());
const byEventId = new Map();
candidates.forEach((r) => {
if (!byEventId.has(r.googleEventId)) byEventId.set(r.googleEventId, []);
byEventId.get(r.googleEventId).push(r);
});
let missing = 0;
for (const [eventId, group] of byEventId) {
let event;
try {
event = await getEvent(group[0].googleCalendarId, eventId);
} catch (err) {
// A real fetch failure (network, auth) says nothing about whether
// the event still exists -- left alone rather than wrongly
// un-pushing a booking just because this one check failed.
console.error(`Verifying the calendar event ${eventId} failed:`, err);
continue;
}
const gone = !event || event.status === 'cancelled';
if (group.length > 1) {
// A real conflict: clear it for every reservation except the one
// (if any) whose own dates actually match the event's real ones.
const range = gone ? null : eventDayRange(event);
group.forEach((r) => {
const keeps = !gone && range.checkin === r.checkin && range.checkout === r.checkout;
if (!keeps) { r.googleEventId = ''; r.googleCalendarId = ''; missing++; }
});
} else if (gone) {
group[0].googleEventId = '';
group[0].googleCalendarId = '';
missing++;
}
}
if (missing) queueSave();
return { checked: candidates.length, missing };
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
// Must run BEFORE syncAllAirbnbListings -- that's the step that drops
// a cancelled reservation from data.airbnbReservations entirely (it's
// no longer in the feed), so this needs the record to still exist to
// match a cancellation email against it.
const canAttempt = await canAttemptGoogleAction();
const cancelResult = await syncCancellationsFromEmail();
// Same ordering reason as the cancellation sync just above -- a refund
// is matched to a reservation by its stated check-in/check-out range,
// which needs the record to still be on file.
const refundResult = await syncRefundsFromEmail();
await syncAllAirbnbListings();
// After the ICS sync, not before -- a reservation the feed just
// removed as genuinely cancelled is gone from data.airbnbReservations
// by now, so there's nothing left here to waste a calendar lookup on.
const verifyResult = await verifyPushedEvents();
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
? ` Filled in ${guestResult.filled} guest name${guestResult.filled === 1 ? '' : 's'} from email${guestResult.romanizeFailed ? ` (${guestResult.romanizeFailed} left in the original script — add an Anthropic key on THIS device in ${MISSING_KEY_LINK_HTML} to romanize ${guestResult.romanizeFailed === 1 ? 'it' : 'them'})` : ''}${guestResult.incomeFilled ? `, ${guestResult.incomeFilled} with the payout too` : ''}.`
: '';
const cancelNote = cancelResult.posted
? ` Posted ${cancelResult.posted} cancellation payout${cancelResult.posted === 1 ? '' : 's'} to <span class="inline-goto-link" data-goto-tab="finances" data-goto-target="#letting-panel">Letting income</span>.`
: '';
const refundNote = refundResult.posted
? ` Posted ${refundResult.posted} guest refund${refundResult.posted === 1 ? '' : 's'} to <span class="inline-goto-link" data-goto-tab="finances" data-goto-target="#letting-panel">Letting income</span>.`
: '';
const refundProblems = refundResult.problems || [];
const refundProblemNote = refundProblems.length
? ` ${refundProblems.length} guest refund${refundProblems.length === 1 ? '' : 's'} couldn't be posted: ${refundProblems.map((p) => `${escapeHtml(p.guest)} (${escapeHtml(p.why)})`).join('; ')}.${refundProblems.some((p) => p.listingId) ? ' Set the owner in <span class="inline-goto-link" data-goto-tab="settings" data-goto-target="#airbnb-listings">Settings</span> and Sync again.' : ''}`
: '';
const verifyNote = verifyResult.missing
? ` ${verifyResult.missing} booking${verifyResult.missing === 1 ? "'s calendar event wasn't" : "s' calendar events weren't"} actually there any more — marked as needing a push again.`
: '';
const unownedNote = cancelResult.unowned
? ` ${cancelResult.unowned} cancellation payout${cancelResult.unowned === 1 ? "" : "s"} not posted: the listing has no owner. Set one in <span class="inline-goto-link" data-goto-tab="settings" data-goto-target="#airbnb-listings">Settings → Airbnb listings</span> and Sync again.`
: "";
const signedOutNote = canAttempt ? "" : " Signed out of Google: guest names, cancellations, refunds and cleaner events were not checked.";
status.innerHTML = `Synced just now.${guestNote}${cancelNote}${unownedNote}${refundNote}${refundProblemNote}${verifyNote}${signedOutNote}`;
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
export { renderAirbnb, renderAirbnbListings, initAirbnbListingsForm, initAirbnbSync, airbnbSegmentsForDay, renderAirbnbKeys, initAirbnbKeys, initKeysSettingsForm, initAirbnbAddBooking, eventDayRange, externalNameFromSummary, parseCleanerEventName };
