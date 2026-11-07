// iCalendar parsing, with no dependencies of any kind.
//
// That's the point of this file rather than a convenience: the service
// worker's background refresh (js/bgsync.js) needs to read an Airbnb feed
// while no page is open, and anything it imports gets evaluated in a
// worker with no `document` and no `window`. These functions were
// previously split between utils.js (which is full of DOM helpers) and
// airbnb.js (which imports half the app), so neither was safe to pull in
// there. Both of those now import from here, so there's still exactly one
// implementation -- the alternative, a second copy inside the worker,
// would drift the first time a real feed showed up something unexpected.

// A property can be "folded" across lines: a continuation starts with a
// space or a tab and belongs to the line before it.
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

function parseIcsProperty(line) {
const colon = line.indexOf(':');
if (colon === -1) return null;
const name = line.slice(0, colon).split(';')[0].toUpperCase();
return { name, value: line.slice(colon + 1) };
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
function parseIcsReservations(text) { return parseIcsEvents(text, false); }

// The feed's own "Not available" blocks: nights Airbnb won't take bookings for (a host's manual block, or a window
// edge). {uid, checkin, checkout}[], checkout exclusive. They are not stays, so they never become reservations,
// but the booking projection must not count them as free nights.
function parseIcsBlocks(text) { return parseIcsEvents(text, true); }

function parseIcsEvents(text, blocks) {
const lines = unfoldIcsLines(text);
const events = [];
let current = null;
lines.forEach((line) => {
if (line === 'BEGIN:VEVENT') { current = {}; return; }
if (line === 'END:VEVENT') {
if (current && current.uid && current.checkin && current.checkout && isNotAvailablePlaceholder(current.summary) === blocks) events.push(current);
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

// The nights on which every one of `listingIds` is blocked. A room can be sold through more than one listing (En-Suite - Phil
// and - Lewis), each with its own Airbnb calendar, and only the one in use matters (js/roomowner.js): pass just that listing
// (none: nothing is known, so nothing is blocked). Returns [{from, to}] ranges, to exclusive, in date order.
function roomBlocks(blocks, listingIds) {
if (!listingIds || !listingIds.length) return [];
const merged = (id) => {
const xs = (blocks || []).filter((b) => b.listingId === id && b.from && b.to && b.to > b.from).map((b) => [b.from, b.to]).sort((a, b) => a[0].localeCompare(b[0]));
const out = [];
xs.forEach(([f, t]) => { const last = out[out.length - 1]; if (last && f <= last[1]) { if (t > last[1]) last[1] = t; } else out.push([f, t]); });
return out;
};
let acc = merged(listingIds[0]);
for (let i = 1; i < listingIds.length && acc.length; i++) {
const next = merged(listingIds[i]);
const out = [];
acc.forEach(([f1, t1]) => next.forEach(([f2, t2]) => { const f = f1 > f2 ? f1 : f2; const t = t1 < t2 ? t1 : t2; if (f < t) out.push([f, t]); }));
acc = out.sort((a, b) => a[0].localeCompare(b[0]));
}
return acc.map(([from, to]) => ({ from, to }));
}

// A feed event is "Reserved" for a confirmed booking and equally for an enquiry
// Airbnb is holding the dates for, and nothing in the feed says which. A feed
// stay is unconfirmed until something outside the feed vouches for it: the
// booking confirmation email (which brings the code, name and payout) or you
// typing a name or income. Derived, so there is nothing to keep in step.
function isUnconfirmedStay(r) {
  return !!r && (r.source || 'ics') === 'ics' && (r.status || 'booked') === 'booked' && !r.movedFrom
    && !r.confirmationCode && !r.guestName && r.income == null && !r.accruedAt;
}

// An unconfirmed stay that has dropped out of the feed before it started was an
// enquiry hold that lapsed: nothing happened, so it is forgotten instead of
// being kept as a cancelled booking (which would show in the cancellations and
// booking-pace charts). Only when nothing else refers to it.
function isForgettableStay(r, doc, today) {
  if (!isUnconfirmedStay(r) || !r.checkout || r.checkout < today || r.googleEventId || r.notes) return false;
  const id = r.id;
  if ((doc.lettingLedger || []).some((e) => e.reservationId === id)) return false;
  if ((doc.airbnbKeyAssignments || []).some((a) => a.reservationId === id)) return false;
  if ((doc.airbnbCleanerEvents || []).some((e) => e.reservationId === id)) return false;
  if ((doc.airbnbCleanerBlocks || []).some((b) => String(b).startsWith(`${id}:`))) return false;
  return true;
}

export { unfoldIcsLines, parseIcsProperty, icsDateOnly, isNotAvailablePlaceholder, parseIcsReservations, parseIcsBlocks, roomBlocks, isUnconfirmedStay, isForgettableStay };
