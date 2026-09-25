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
function parseIcsReservations(text) {
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

export { unfoldIcsLines, parseIcsProperty, icsDateOnly, isNotAvailablePlaceholder, parseIcsReservations };
