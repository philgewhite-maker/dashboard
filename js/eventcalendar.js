// The yearly events calendar's date rules, shared by everything that needs to know when an event falls: the booking model's
// pricing (js/features/bookingmodel.js eventFactorsAt / eventHistoryCheck), Settings' list (js/features/bookingsettings.js),
// and the direct booking site's event pages when that is built (see eventDatesBetween). No DOM and no app state, so it can be
// imported anywhere, or ported line for line to the site's own code.
//
// An event (prefs.bookingEvaluator.events[]):
//   {id, name, roomKey ('' = every room), rule, nights 1-60, upliftPct,
//    month 1-12, day 1-31            rule 'fixed':  the same date every year (25 Dec)
//    month, weekday 0 (Sun)-6, nth   rule 'nth':    1st-4th or last (-1) weekday of a month (last Sun of Apr)
//    offset                          rule 'easter': days from Easter Sunday (Good Friday = -2)
//    date 'YYYY-MM-DD'               rule 'once':   one date only
//    announced: true                 the real date is announced each year (a fixture list, a festival): the rule above is
//                                    only the rough guess, used until that year's date is added to
//    dates: ['YYYY-MM-DD', ...]      the announced first nights. A year with any here uses these and not the rule (a year can
//                                    have several: each home match), and they count as confirmed.}
// Every occurrence carries a status: 'confirmed' (a fixed rule, Easter, a one-off, or an announced date) or 'estimated'
// (an announced event's rule guess for a year with no date added yet).

const DAY_MS = 86400000;
const dayNum = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d) / DAY_MS; };
const dayStr = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const dowOf = (n) => new Date(n * DAY_MS).getUTCDay();
const yearOf = (n) => new Date(n * DAY_MS).getUTCFullYear();
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

const EVENT_RULES = ['fixed', 'nth', 'easter', 'once'];
const ORD = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', '-1': 'last' };
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const eventNights = (ev) => Math.min(60, Math.max(1, Math.round(Number(ev && ev.nights)) || 1));
const clampInt = (v, lo, hi, dflt) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };

// Easter Sunday of year y as a day number (Gregorian; the anonymous / Meeus algorithm).
function easterSunday(y) {
const a = y % 19; const b = Math.floor(y / 100); const c = y % 100;
const d = Math.floor(b / 4); const e = b % 4; const f = Math.floor((b + 8) / 25); const g = Math.floor((b - f + 1) / 3);
const h = (19 * a + b - d - g + 15) % 30; const i = Math.floor(c / 4); const k = c % 4;
const l = (32 + 2 * e + 2 * i - h - k) % 7; const m = Math.floor((a + 11 * h + 22 * l) / 451);
const month = Math.floor((h + l - 7 * m + 114) / 31); const day = ((h + l - 7 * m + 114) % 31) + 1;
return Date.UTC(y, month - 1, day) / DAY_MS;
}

// The rule's first night in year y (day number), or null.
function ruleStart(ev, y) {
if (ev.rule === 'easter') return easterSunday(y) + clampInt(ev.offset, -60, 60, 0);
const m = clampInt(ev.month, 1, 12, 1) - 1;
if (ev.rule === 'nth') {
const wd = clampInt(ev.weekday, 0, 6, 0);
const nth = Math.round(Number(ev.nth)) || 1;
if (nth < 0) { const last = Date.UTC(y, m + 1, 0) / DAY_MS; return last - ((dowOf(last) - wd + 7) % 7); }
const first = Date.UTC(y, m, 1) / DAY_MS;
return first + ((wd - dowOf(first) + 7) % 7) + (Math.min(4, nth) - 1) * 7;
}
if (ev.rule === 'fixed' || !ev.rule) {
const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
return Date.UTC(y, m, Math.min(dim, clampInt(ev.day, 1, 31, 1))) / DAY_MS;
}
return null;
}

const announcedDates = (ev) => (Array.isArray(ev && ev.dates) ? ev.dates.filter(isDate) : []);

// The occurrences of an event that touch fromDay..toDay (day numbers, inclusive):
// [{start, end (exclusive = start + nights), year, status 'confirmed'|'estimated'}], sorted.
function eventOccurrences(ev, fromDay, toDay) {
const out = [];
if (!ev) return out;
const nights = eventNights(ev);
const push = (start, status) => {
if (Number.isFinite(start) && start + nights > fromDay && start <= toDay) out.push({ start, end: start + nights, year: yearOf(start), status });
};
if (ev.rule === 'once') { if (isDate(ev.date)) push(dayNum(ev.date), 'confirmed'); return out; }
const pinned = announcedDates(ev).map(dayNum);
const pinnedYears = new Set(pinned.map(yearOf));
pinned.forEach((d) => push(d, 'confirmed'));
const y0 = yearOf(fromDay) - 1;
const y1 = yearOf(toDay);
for (let y = y0; y <= y1; y++) {
if (pinnedYears.has(y)) continue; // that year's real dates replace the rule
push(ruleStart(ev, y), ev.announced ? 'estimated' : 'confirmed');
}
return out.sort((a, b) => a.start - b.start);
}

// The rule in words, for lists: "every last Sun of Apr", "Easter Sunday −2 days", "once, 2027-06-11".
function eventRuleWords(ev) {
if (!ev) return '';
let w;
if (ev.rule === 'once') w = `once, ${ev.date || '?'}`;
else if (ev.rule === 'easter') {
const o = clampInt(ev.offset, -60, 60, 0);
w = o === 0 ? 'every Easter Sunday' : o === -2 ? 'every Good Friday' : o === 1 ? 'every Easter Monday' : `every Easter Sunday ${o > 0 ? '+' : '−'}${Math.abs(o)} day${Math.abs(o) === 1 ? '' : 's'}`;
} else if (ev.rule === 'nth') w = `every ${ORD[ev.nth] || ev.nth} ${WEEKDAYS[ev.weekday] || '?'} of ${MONTHS[ev.month - 1] || '?'}`;
else w = `every ${ev.day} ${MONTHS[ev.month - 1] || '?'}`;
return ev.announced && ev.rule !== 'once' ? `${w} (roughly; real date announced)` : w;
}

// Every occurrence of every event between two dates, as the direct booking site's event pages want them:
// [{eventId, name, roomKey, first 'YYYY-MM-DD' (first night), checkout 'YYYY-MM-DD', nights, year, status}], by date.
// An 'estimated' one is the rule's guess: a page shows it as "dates to be confirmed", not as a date.
function eventDatesBetween(events, fromDate, toDate) {
const a = dayNum(fromDate); const b = dayNum(toDate);
const out = [];
(Array.isArray(events) ? events : []).forEach((ev) => {
if (!ev) return;
eventOccurrences(ev, a, b).forEach((o) => out.push({ eventId: ev.id, name: ev.name || 'Event', roomKey: ev.roomKey || '', first: dayStr(o.start), checkout: dayStr(o.end), nights: o.end - o.start, year: o.year, status: o.status }));
});
return out.sort((x, y) => (x.first < y.first ? -1 : x.first > y.first ? 1 : 0));
}

// The next occurrence on or after a date, or null (Settings shows it, and asks for the date while it's still estimated).
function nextOccurrence(ev, fromDate) {
const a = dayNum(fromDate);
return eventOccurrences(ev, a, a + 800).find((o) => o.end > a) || null;
}

// One event cleaned to the shape above (Settings' normaliser and the model both use it).
function normaliseEvent(ev) {
const x = { ...ev };
x.rule = EVENT_RULES.includes(x.rule) ? x.rule : 'fixed';
x.nights = eventNights(x);
x.dates = [...new Set(announcedDates(x))].sort();
x.announced = !!x.announced && x.rule !== 'once';
return x;
}

function selfTestEventCalendar() {
const fails = [];
const ok = (c, m) => { if (!c) fails.push(m); };
ok(dayStr(easterSunday(2026)) === '2026-04-05', 'Easter 2026 = 5 Apr');
ok(dayStr(easterSunday(2027)) === '2027-03-28', 'Easter 2027 = 28 Mar');
ok(dayStr(easterSunday(2028)) === '2028-04-16', 'Easter 2028 = 16 Apr');
const gf = eventOccurrences({ rule: 'easter', offset: -2, nights: 4 }, dayNum('2027-01-01'), dayNum('2027-12-31'));
ok(gf.length === 1 && dayStr(gf[0].start) === '2027-03-26' && gf[0].status === 'confirmed', 'Good Friday 2027 = 26 Mar, confirmed');
const sn = { rule: 'nth', month: 2, weekday: 6, nth: 1, nights: 2, announced: true, dates: ['2027-02-13', '2027-03-06'] };
const o27 = eventOccurrences(sn, dayNum('2027-01-01'), dayNum('2027-12-31'));
ok(o27.length === 2 && o27.every((o) => o.status === 'confirmed') && dayStr(o27[0].start) === '2027-02-13', 'announced dates replace the rule in their year');
const o28 = eventOccurrences(sn, dayNum('2028-01-01'), dayNum('2028-12-31'));
ok(o28.length === 1 && o28[0].status === 'estimated' && dayStr(o28[0].start) === '2028-02-05', 'a year without a date falls back to the rule, estimated');
const fx = eventOccurrences({ rule: 'fixed', month: 12, day: 25, nights: 2 }, dayNum('2026-12-26'), dayNum('2026-12-26'));
ok(fx.length === 1 && fx[0].status === 'confirmed', 'a fixed rule is confirmed and spans its nights');
const pages = eventDatesBetween([{ id: 'a', name: 'A', ...sn }], '2027-01-01', '2028-12-31');
ok(pages.length === 3 && pages[0].first === '2027-02-13' && pages[0].checkout === '2027-02-15' && pages[2].status === 'estimated', 'page list: dates, checkout, status');
ok(nextOccurrence(sn, '2027-02-14').start === dayNum('2027-02-13'), 'next occurrence includes one under way');
return { pass: fails.length === 0, fails };
}

export { EVENT_RULES, easterSunday, eventNights, eventOccurrences, eventRuleWords, eventDatesBetween, nextOccurrence, normaliseEvent, selfTestEventCalendar };
