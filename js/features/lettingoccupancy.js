// Occupancy and booking pace, under the Letting income charts.
//
// 1. A daily timeline for one month: a lane per listing, a line per booking
//    from check-in to check-out, cancelled bookings hatched.
// 2. A "worm" for the same month: a cumulative line against the same point in
//    a comparison month (last month, the last 3, or this month last year),
//    with the gap shaded and named, so you can see at a glance whether you are
//    ahead of or behind the usual pace.
//
// Everything is derived from data the app already keeps; nothing here writes.
// Stays come from four places (see collectStays), because a booking leaves
// the live list the moment it ends or is cancelled.
import { data } from '../state.js';
import { escapeHtml, dateStrAdd, todayStr } from '../utils.js';
import { listingColorVar, resolveColor, addMonths, monthLabel, ownerKeyFor, ownerNameFor, lettingChartMonthTotal, lettingIncomeItems, nightRateRooms, money0 } from './letting.js';
import { isUnconfirmedStay } from '../icsparse.js';

const DAY_MS = 86400000;
const MIN_COVERAGE = 0.8; // share of a month's nights that must have a known income/dates before it is compared
// Nights booked: an older month's line counts only stays with a known booking date, so it is an
// under-count. From this share it is still drawn (with a note saying so); below it, not at all.
const MIN_COVERAGE_BOOKINGS = 0.5;

function ymOf(dateStr) { return String(dateStr).slice(0, 7); }
function daysIn(ym) { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); }
function dayStr(ym, d) { return `${ym}-${String(d).padStart(2, '0')}`; }
function nightsBetween(a, b) { return Math.round((new Date(`${b}T00:00:00`) - new Date(`${a}T00:00:00`)) / DAY_MS); }
function longMonth(ym) { const [y, m] = ym.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }); }

// ---- Data ------------------------------------------------------------------

// One list of every stay we know about:
//  stays     data.airbnbReservations, with status booked, completed or cancelled
//  ledger    older stays only the Letting ledger remembers ("earned before tracking" rows
//            with a start date or night count), and older cancellations (a payout row only)
// A ledger-only stay is matched to a recorded one by listing + check-in + check-out so it is
// never drawn twice; a cancellation payout linked to its stay by id is not drawn again.
function collectStays() {
roomKeys = null; // listings/colours may have changed since the last read
const stays = [];
const seen = new Map();
const keyOf = (s) => `${s.listingId}|${s.checkin}|${s.checkout}`;
const add = (s) => {
if (!s.listingId || !s.checkin || !s.checkout || s.checkout <= s.checkin) return null;
// Two records are the same stay only when room, check-in AND check-out all match (and status: a
// cancelled booking is never the live one). A copy that knows the income fills it in on the one
// already held. Anything else is a separate record and is drawn separately, so two guests whose
// dates clash both show, and the clash is flagged rather than one quietly replacing the other.
const k = `${s.status}|${keyOf(s)}`;
const held = seen.get(k);
if (held) {
if (held.income == null && s.income != null) held.income = s.income;
return { stay: held, merged: true };
}
seen.set(k, s);
stays.push(s);
return { stay: s, merged: false };
};
// Every stay is one record in data.airbnbReservations, whatever its status
// (booked, completed, cancelled); nothing is deleted when a stay ends.
(data.airbnbReservations || []).forEach((r) => add({
id: r.id, listingId: r.listingId, checkin: r.checkin, checkout: r.checkout, guest: r.guestName || '',
unconfirmed: isUnconfirmedStay(r), income: r.status === 'cancelled' ? null : (r.income ?? null), bookedOn: r.confirmedOn || String(r.createdAt || '').slice(0, 10),
cancelledOn: r.cancelledOn || '', status: r.status === 'cancelled' ? 'cancelled' : 'stay',
source: r.status === 'completed' ? 'finished' : r.status === 'cancelled' ? 'cancelled' : 'live', platform: r.platform === 'other' ? 'other' : 'airbnb',
}));
const reservationIds = new Set((data.airbnbReservations || []).map((r) => r.id));
// Listings by the same owner key the ledger rows carry (a connection id, or a
// lowercased typed name), so a ledger row finds its owner's rooms either way.
const ownerListings = new Map();
(data.airbnbListings || []).forEach((l) => {
const k = ownerKeyFor(l);
if (!ownerListings.has(k)) ownerListings.set(k, []);
ownerListings.get(k).push(l);
});
// Revenue is read straight from the income items the Income by month chart adds up, so
// the two can't drift apart. Stays below are only for drawing and counting nights.
const skippedRows = [];
const items = lettingIncomeItems(skippedRows);
let unplaced = 0;
let unplacedIncome = 0;
// Income from the ledger (historic or aged-out bookings) that spans real nights becomes a stay to draw,
// on the room the row names or, failing that, its owner's only room.
// What became of each item, so "why isn't this booking drawn?" has an answer on screen.
const trace = [];
items.forEach((it) => {
const row = { it, fate: '', room: '' };
trace.push(row);
if (it.kind === 'cancellation') { row.fate = 'payout'; return; }
if (it.source === 'reservation') { row.fate = 'drawn'; row.room = it.listing.id; return; } // drawn from the booking itself, above
if (!it.start) { row.fate = 'lump'; return; }
const listingId = roomForCancellation({ listingId: it.explicit ? it.listing.id : '', ownerKey: it.ownerKey, date: it.date }, ownerListings);
if (!listingId) { unplacedIncome += 1; row.fate = 'noroom'; return; }
const res = add({ id: `led:${it.id}`, listingId, checkin: it.start, checkout: it.end, guest: it.note, income: it.gross, bookedOn: '', status: 'stay', source: 'ledger', platform: it.platform });
row.fate = !res ? 'invalid' : (res.merged ? 'merged' : 'drawn');
row.room = listingId;
});
(data.lettingLedger || []).forEach((e) => {
if (e.kind === 'cancellation') {
const checkin = e.checkin || dateStrAdd(e.date, -1);
const listingId = roomForCancellation(e, ownerListings);
if (!listingId) { unplaced += 1; return; }
// Already recorded from the feed: the same room and check-in, and the same check-out when the payout row knows it
// (two guests can cancel the same arrival date, and the second must not be taken for the first).
if (e.reservationId && reservationIds.has(e.reservationId)) return;
if ((data.airbnbReservations || []).some((s) => s.status === 'cancelled' && s.listingId === listingId && s.checkin === checkin && (!e.checkout || s.checkout === e.checkout))) return;
// Without a recorded end date the stay's own length is unknown, so one night is drawn.
const checkout = e.checkout && e.checkout > checkin ? e.checkout : dateStrAdd(checkin, 1);
add({ id: `led:${e.id}`, listingId, checkin, checkout, guest: e.note || '', income: null, bookedOn: '', cancelledOn: e.date, status: 'cancelled', source: 'ledger', platform: e.platform === 'other' ? 'other' : 'airbnb', approx: !(e.checkout && e.checkout > checkin) });
}
});
stays.unplacedCancellations = unplaced;
stays.unplacedIncome = unplacedIncome;
stays.items = items;
stays.trace = trace;
// A physical room holds one guest a night. Two stays in the same room whose nights overlap are a data
// clash (one of the two has wrong dates); name each on the other so it can be fixed at the source.
const live = stays.filter((s) => s.status === 'stay');
live.forEach((a) => {
a.clashes = live.filter((b) => b !== a && roomKeyFor(b.listingId) === roomKeyFor(a.listingId) && a.checkin < b.checkout && b.checkin < a.checkout);
});
trace.forEach((row) => {
if (!row.room || !row.it.start) return;
const stay = seen.get(`stay|${row.room}|${row.it.start}|${row.it.end}`);
row.clashes = (stay && stay.clashes) || [];
});
// Ledger rows the Income by month chart does not count at all, so they can't be on the timeline either.
skippedRows.forEach(({ e, reason, covered }) => {
const nights = Number(e.nights);
const start = nights > 0 ? (e.startDate || dateStrAdd(e.date, -nights)) : '';
const end = nights > 0 ? (e.startDate ? dateStrAdd(e.startDate, nights) : e.date) : '';
const listing = (data.airbnbListings || []).find((l) => l.id === e.listingId) || { label: ownerNameFor(e.ownerKey) };
trace.push({ it: { start, end, date: e.date || '', gross: Number(e.gross) || 0, note: e.note || '', listing, source: 'ledger' }, fate: covered ? 'covered' : 'skipped', reason, room: '' });
});
return stays;
}

// A cancellation payout from before the room was stored on it. Its owner's only
// room is the answer; failing that, since Aug 2026 Zara's payouts belong to the
// double room and Lewis's to the ensuite.
const ROOM_RULES_FROM = '2026-08-01';
const ROOM_BY_OWNER = [{ owner: /zara/i, room: /double/i }, { owner: /lewis/i, room: /en-?suite/i }];
function roomForCancellation(e, ownerListings) {
if (e.listingId) return e.listingId;
const mine = ownerListings.get(e.ownerKey) || ownerListings.get(String(e.ownerKey || '').toLowerCase()) || [];
if (mine.length === 1) return mine[0].id;
if (e.date && e.date >= ROOM_RULES_FROM) {
const rule = ROOM_BY_OWNER.find((r) => r.owner.test(ownerNameFor(e.ownerKey)));
if (rule) {
const hits = (mine.length ? mine : (data.airbnbListings || [])).filter((l) => rule.room.test(l.label || ''));
if (hits.length === 1) return hits[0].id;
}
}
return '';
}

function nightsInMonth(stay, ym) {
const first = dayStr(ym, 1);
const next = dayStr(addMonths(ym, 1), 1);
const from = stay.checkin > first ? stay.checkin : first;
const to = stay.checkout < next ? stay.checkout : next;
return to > from ? nightsBetween(from, to) : 0;
}

// Revenue only: a stay's income accrues night by night, up to today. `uncapped` carries on past
// today (the nights already booked), for the projection to the month's end.
function countFor(stay, ym, upToDay, metric, today, uncapped = false) {
const D = dayStr(ym, upToDay);
const upTo = uncapped || D < dateStrAdd(today, 1) ? D : today;
const first = dayStr(ym, 1);
const lastNight = dateStrAdd(upTo, 1); // nights strictly before this date
const from = stay.checkin > first ? stay.checkin : first;
const to = stay.checkout < lastNight ? stay.checkout : lastNight;
const nights = to > from ? nightsBetween(from, to) : 0;
const total = nightsBetween(stay.checkin, stay.checkout);
return stay.income != null && total > 0 ? (Number(stay.income) * nights) / total : 0;
}

// The physical room a listing is (listings drawn the same colour are one room, as on the
// average-night-rate chart, whose occupancy bars count the same way).
let roomKeys = null;
function roomKeyFor(listingId) {
if (!roomKeys) {
roomKeys = new Map();
nightRateRooms().forEach((room) => room.listingIds.forEach((id) => roomKeys.set(id, room.key)));
}
return roomKeys.get(listingId) || listingId;
}

// Nights booked / occupied, counted the way the occupancy bars on the night-rate chart count them:
// a set of (room, night) pairs, so a room is never more than one night occupied per night however
// many records overlap it. `D` is the day of the month being read up to.
function distinctRoomNights(stays, ym, upToDay, metric, today, asOf) {
return roomNightMap(stays, ym, upToDay, metric, today, state.channel, asOf).size;
}

// "Nights booked" looks back from the month: bookings arrive weeks before the nights do, so its
// axis starts this many weeks ahead of the 1st (index 0 is that day; the 1st is at index LEAD_DAYS).
const LEAD_WEEKS = 16;
const LEAD_DAYS = LEAD_WEEKS * 7;
function leadFor(metric) { return metric === 'bookings' ? LEAD_DAYS : 0; }

// The same set, as (room, night) -> the channel that filled it, optionally for one channel only
// (the pace chart's Channel picker). A night two records claim is credited to whichever came first.
function roomNightMap(stays, ym, upToDay, metric, today, channel = state.channel, asOf = '') {
const D = asOf || dayStr(ym, upToDay); // asOf: a date outside the month, for "booked as of" before it starts
const first = dayStr(ym, 1);
const next = dayStr(addMonths(ym, 1), 1);
const n = daysIn(ym);
// Occupied nights only exist up to today; booked nights cover the whole month (they are future nights too).
// 'projected': the nights up to day D that are booked (future ones too), counting only stays that
// are confirmed, since an unconfirmed one may be an enquiry that never happens.
const limit = metric === 'nights' ? dateStrAdd(D < today ? D : today, 1) : metric === 'projected' ? dateStrAdd(D, 1) : next;
const keys = new Map();
stays.forEach((s) => {
if (channel && channelOf(s) !== channel) return;
if (metric === 'projected' && s.unconfirmed) return;
if (metric === 'bookings') {
if (!s.bookedOn || s.bookedOn > D) return;
if (s.status === 'cancelled' && (!s.cancelledOn || s.cancelledOn <= D)) return;
} else if (s.status === 'cancelled') return;
const from = s.checkin > first ? s.checkin : first;
const to = s.checkout < limit ? s.checkout : (limit < next ? limit : next);
if (to <= from) return;
const startDay = Number(from.slice(8, 10));
const endDay = to >= next ? n + 1 : Number(to.slice(8, 10));
const room = roomKeyFor(s.listingId);
for (let day = startDay; day < endDay; day++) { const k = `${room}|${day}`; if (!keys.has(k)) keys.set(k, channelOf(s)); }
});
return keys;
}

// Cumulative series for one month, day 1..N. Days after today in the current
// month are null (nothing has happened yet for occupied nights / revenue; for
// bookings the line stops too, since bookings made after today don't exist).
// `project`: for Nights occupied and Revenue earned, carry the line on past today using the stays
// already booked (nights, and the income entered for them), instead of leaving the rest empty.
function seriesFor(stays, ym, metric, today, project = false) {
const n = daysIn(ym);
const out = [];
if (metric === 'bookings') {
// One point per day from LEAD_WEEKS before the 1st to the month's last day: the month's nights
// that were already booked as of that date (none after today, which hasn't happened yet).
const first = dayStr(ym, 1);
for (let i = 0; i < LEAD_DAYS + n; i++) {
const asOf = dateStrAdd(first, i - LEAD_DAYS);
out.push(asOf > today ? null : distinctRoomNights(stays, ym, n, metric, today, asOf));
}
return out;
}
for (let d = 1; d <= n; d++) {
if (!project && dayStr(ym, d) > today) { out.push(null); continue; }
let sum = 0;
if (metric === 'revenue') {
const day = dayStr(ym, d);
(stays.items || []).forEach((it) => {
if (state.channel && (it.platform === 'other' ? 'other' : 'airbnb') !== state.channel) return;
if (it.start) { sum += countFor({ checkin: it.start, checkout: it.end, income: it.gross, status: 'stay' }, ym, d, 'revenue', today, project); return; }
// No nights to spread it over: a payout lands on its own date, all at once, once that date has passed.
if (it.date.slice(0, 7) === ym && it.date <= day && it.date <= today) sum += it.gross;
});
} else {
sum = distinctRoomNights(stays, ym, d, project ? 'projected' : metric, today);
}
out.push(Math.round(sum * 100) / 100);
}
return out;
}

// For the "bookings made" metric a month can only be compared if most of its
// nights belong to stays with a known booking date. Older stays predate that
// being recorded, so they say so instead of showing a flat, misleading line.
function coverageFor(stays, ym, metric) {
if (metric === 'revenue') {
// Revenue exists from the first income item onward; before that there is nothing to compare with.
const next = dayStr(addMonths(ym, 1), 1);
return (stays.items || []).some((it) => (it.start || it.date) < next) ? 1 : 0;
}
let total = 0; let known = 0;
stays.forEach((s) => {
const n = nightsInMonth(s, ym);
if (!n) return;
if (s.status === 'cancelled' && metric !== 'bookings') return;
total += n;
if (metric === 'bookings' ? !!s.bookedOn : (metric === 'revenue' ? s.income != null : true)) known += n;
});
return total ? known / total : 0;
}

function compareMonths(ym, mode) {
if (mode === 'lastyear') return [addMonths(ym, -12)];
if (mode === 'prev3') return [addMonths(ym, -1), addMonths(ym, -2), addMonths(ym, -3)];
return [addMonths(ym, -1)];
}
const COMPARE_LABEL = { prev: 'last month', prev3: 'the last 3 months (average)', lastyear: 'this month last year' };

function comparisonSeries(stays, ym, mode, metric, today) {
const months = compareMonths(ym, mode);
const need = metric === 'bookings' ? MIN_COVERAGE_BOOKINGS : MIN_COVERAGE;
const usable = months.filter((m) => coverageFor(stays, m, metric) >= need);
const n = leadFor(metric) + daysIn(ym);
if (!usable.length) return { values: null, usable, months };
const minCoverage = Math.min(...usable.map((m) => coverageFor(stays, m, metric)));
const all = usable.map((m) => seriesFor(stays, m, metric, today));
const values = [];
for (let d = 0; d < n; d++) {
const picked = all.map((s) => s[Math.min(d, s.length - 1)]).filter((v) => v !== null);
values.push(picked.length ? Math.round((picked.reduce((a, b) => a + b, 0) / picked.length) * 100) / 100 : null);
}
return { values, usable, months, minCoverage };
}

// ---- State & markup ----------------------------------------------------------

const state = { ym: '', metric: 'bookings', compare: 'prev', channel: '', hoverStay: null, hoverDay: null };
const PLOTS = { timeline: null, pace: null };
const METRIC_LABEL = { bookings: 'Nights booked', nights: 'Nights occupied', revenue: 'Revenue earned' };
const METRIC_UNIT = { bookings: 'nights', nights: 'nights', revenue: '£' };

function currentYm() { return todayStr().slice(0, 7); }

function monthOptions() {
const cur = currentYm();
const opts = [{ ym: addMonths(cur, 1), label: `Next month (${longMonth(addMonths(cur, 1))})` }, { ym: cur, label: `This month (${longMonth(cur)})` }, { ym: addMonths(cur, -1), label: `Last month (${longMonth(addMonths(cur, -1))})` }];
opts.unshift({ ym: addMonths(cur, 2), label: longMonth(addMonths(cur, 2)) });
for (let i = 2; i <= 13; i++) opts.push({ ym: addMonths(cur, -i), label: longMonth(addMonths(cur, -i)) });
return opts;
}

function sectionHtml() {
return `<div class="letting-chart-wrap" id="letting-occupancy-section">
<div class="panel-head" style="margin:14px 0 6px;"><h2 style="font-size:13px;">Occupancy and booking pace</h2></div>
<details class="settings-subgroup panel-about"><summary>About this</summary>
<div class="settings-note" style="margin:0 0 6px;">Top: each room is a lane and each booking a line from check-in to check-out, so turnovers show as a gap. Hatched lines are cancelled bookings (recorded from the day they leave the Airbnb feed; older ones appear only when they have a cancellation payout, and show as a single night). Bottom: the same month as a cumulative line against a comparison month, with the gap shaded and named. <strong>Nights booked</strong> zooms out: its axis starts a week or so before the first booking for the month (or the comparison month) appears, up to 16 weeks before the 1st, and runs through the month, showing how many of the month's nights were already booked at each point, against the comparison month at the same distance from its own 1st (so you can see whether next month is filling faster or slower than last month did). A booking counts from the day it was confirmed (its confirmation email) and a cancelled one is taken back out from the day it was cancelled; booking dates are only known for stays seen since this was added, so an older month's line is an under-count: it is drawn with a note once half its nights have a known booking date, and below that says "collecting data" instead. <strong>Nights occupied</strong> and <strong>Revenue earned</strong> compare straight away, and for a month not yet over a dotted line carries them to the month's end using only stays already booked and confirmed (revenue counts the income entered for them; a stay with none adds nothing, and unconfirmed enquiries are left out).</div>
</details>
<div class="sync-row" style="gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:6px;">
<select id="occ-month" class="mini" title="The month both charts show"></select>
<span class="settings-note" id="occ-summary" style="margin:0;"></span>
</div>
<details class="settings-subgroup" id="occ-income-trace" style="margin:0 0 6px;"></details>
<div class="letting-chart-legend" id="occ-legend" style="flex-direction:row;flex-wrap:wrap;"></div>
<div class="chart-canvas-wrap occ-wrap" style="position:relative;"><canvas id="occ-timeline-canvas"></canvas><div class="occ-tip" id="occ-tip" hidden></div></div>
<div class="sync-row" style="gap:8px;flex-wrap:wrap;align-items:center;margin:12px 0 4px;">
<select id="pace-metric" class="mini" title="What the line adds up"><option value="bookings">Nights booked</option><option value="nights">Nights occupied</option><option value="revenue">Revenue earned</option></select>
<span class="settings-note" style="margin:0;">against</span>
<select id="pace-compare" class="mini" title="What to compare it with"><option value="prev">Last month</option><option value="prev3">Last 3 months (average)</option><option value="lastyear">This month last year</option></select>
<select id="pace-channel" class="mini" title="Count every booking, or only those that came through one channel"><option value="">All channels</option>${Object.entries(CHANNELS).map(([k, v]) => `<option value="${k}">${escapeHtml(v.label)} only</option>`).join('')}</select>
</div>
<div class="occ-verdict" id="pace-verdict"></div>
<div class="chart-canvas-wrap occ-wrap" style="position:relative;height:240px;"><canvas id="pace-canvas"></canvas><div class="occ-tip" id="pace-tip" hidden></div></div>
<details class="settings-subgroup" style="margin-top:6px;"><summary class="settings-note" style="cursor:pointer;">Table view</summary><div id="occ-table" style="overflow-x:auto;"></div></details>
</div>`;
}

// ---- Canvas helpers -----------------------------------------------------------

function setup(canvas) {
const rect = canvas.getBoundingClientRect();
const width = Math.round(rect.width);
const height = Math.round(rect.height);
if (!width || !height) return null; // on a hidden tab; redrawn when the tab is shown
const dpr = window.devicePixelRatio || 1;
canvas.width = Math.round(width * dpr);
canvas.height = Math.round(height * dpr);
const ctx = canvas.getContext('2d');
ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
ctx.clearRect(0, 0, width, height);
return { ctx, width, height };
}

function hatch(ctx, color) {
const size = 6;
const tile = document.createElement('canvas');
tile.width = size; tile.height = size;
const t = tile.getContext('2d');
t.fillStyle = color; t.globalAlpha = 0.18; t.fillRect(0, 0, size, size); t.globalAlpha = 1;
t.strokeStyle = color; t.lineWidth = 1.6;
[-size, 0, size].forEach((o) => { t.beginPath(); t.moveTo(o, size); t.lineTo(o + size, 0); t.stroke(); });
return ctx.createPattern(tile, 'repeat');
}

// How a booking's channel is drawn on a bar. Solid is Airbnb; a booking taken another way (direct,
// another platform) is the same room colour with light diagonal stripes, matching the striped
// "Other" on the Letting income chart. Add an entry here when a new channel (e.g. the direct site) arrives.
const CHANNELS = {
airbnb: { label: 'Airbnb', striped: false },
other: { label: 'Direct / other', striped: true },
};
const channelOf = (stay) => (CHANNELS[stay.platform] ? stay.platform : 'airbnb');

function stripes(ctx, color) {
const size = 6;
const tile = document.createElement('canvas');
tile.width = size; tile.height = size;
const t = tile.getContext('2d');
t.fillStyle = color; t.fillRect(0, 0, size, size);
t.strokeStyle = 'rgba(255,255,255,0.55)'; t.lineWidth = 1.6;
[-size, 0, size].forEach((o) => { t.beginPath(); t.moveTo(o, size); t.lineTo(o + size, 0); t.stroke(); });
return ctx.createPattern(tile, 'repeat');
}

// The rooms the timeline is laid out in: one lane per physical room, whichever listings (owners)
// and channels fill it. A room is the set of listings that share a colour, as on the night-rate chart.
function lanes() {
const listings = data.airbnbListings || [];
return nightRateRooms().map((room) => {
const members = room.listingIds.map((id) => listings.find((l) => l.id === id)).filter(Boolean);
const owners = [...new Set(members.map((l) => ownerNameFor(ownerKeyFor(l))).filter(Boolean))];
return { ...room, members, owners };
});
}

function palette() {
return {
ink: resolveColor('--ink'), muted: resolveColor('--muted'), line: resolveColor('--line'), card: resolveColor('--card'),
good: resolveColor('--sage'), bad: resolveColor('--red'),
};
}

// ---- Timeline -----------------------------------------------------------------

function drawTimeline(stays) {
const canvas = document.getElementById('occ-timeline-canvas');
if (!canvas) return;
const rooms = lanes();
const laneH = 40;
const headH = 22;
const wrap = canvas.parentElement;
wrap.style.height = `${Math.max(120, headH + rooms.length * laneH + 12)}px`;
const s = setup(canvas);
if (!s) return;
const { ctx, width, height } = s;
const c = palette();
const ym = state.ym;
const n = daysIn(ym);
const narrow = width < 520;
const left = narrow ? 64 : 120;
const right = 8;
const colW = (width - left - right) / n;
const xDay = (d) => left + (d - 1) * colW; // left edge of day d
const today = todayStr();
ctx.font = '11px Inter, sans-serif';
ctx.textBaseline = 'middle';
// weekend shading + day header
for (let d = 1; d <= n; d++) {
const dow = new Date(`${dayStr(ym, d)}T00:00:00`).getDay();
if (dow === 0 || dow === 6) { ctx.fillStyle = c.line; ctx.globalAlpha = 0.35; ctx.fillRect(xDay(d), headH, colW, height - headH); ctx.globalAlpha = 1; }
if (!narrow || d === 1 || d % 5 === 0) {
ctx.fillStyle = dayStr(ym, d) === today ? c.ink : c.muted;
ctx.textAlign = 'center';
ctx.fillText(String(d), xDay(d) + colW / 2, headH / 2);
}
}
const hits = [];
rooms.forEach((room, i) => {
const top = headH + i * laneH;
const mid = top + laneH / 2;
ctx.strokeStyle = c.line; ctx.lineWidth = 1;
ctx.beginPath(); ctx.moveTo(left, top + laneH); ctx.lineTo(width - right, top + laneH); ctx.stroke();
// Room name, with who rents it out underneath (several owners can share one room).
const roomLabel = room.label || 'Room';
const showOwners = !narrow && room.owners.length > 0;
ctx.fillStyle = c.ink; ctx.textAlign = 'left';
ctx.font = '11px Inter, sans-serif';
ctx.fillText(roomLabel.length > (narrow ? 9 : 17) ? `${roomLabel.slice(0, narrow ? 8 : 16)}…` : roomLabel, 6, showOwners ? mid - 6 : mid);
if (showOwners) {
ctx.fillStyle = c.muted; ctx.font = '10px Inter, sans-serif';
const ownersText = room.owners.join(' · ');
ctx.fillText(ownersText.length > 20 ? `${ownersText.slice(0, 19)}…` : ownersText, 6, mid + 7);
ctx.font = '11px Inter, sans-serif';
}
stays.filter((st) => roomKeyFor(st.listingId) === room.key && nightsInMonth(st, ym) > 0).forEach((st) => {
// Each stay keeps its own listing's colour, so Phil's blue and Zara's pink share one row.
const own = room.members.find((l) => l.id === st.listingId);
const color = resolveColor(listingColorVar((own && own.colour) || room.colour));
// A stay runs from the middle of check-in day to the middle of check-out day, so a same-day turnover shows as a gap.
const startD = st.checkin < dayStr(ym, 1) ? 0.5 : (Number(st.checkin.slice(8, 10)) + 0.5);
const endD = st.checkout >= dayStr(addMonths(ym, 1), 1) ? n + 1 : (Number(st.checkout.slice(8, 10)) + 0.5);
const x1 = left + (startD - 1) * colW;
const x2 = left + (endD - 1) * colW;
const cancelled = st.status === 'cancelled';
const y = cancelled ? mid + 9 : mid - 4;
const h = cancelled ? 7 : 10;
if (cancelled) {
ctx.fillStyle = hatch(ctx, color);
ctx.fillRect(x1, y - h / 2, Math.max(3, x2 - x1), h);
ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([3, 2]);
ctx.strokeRect(x1 + 0.5, y - h / 2 + 0.5, Math.max(3, x2 - x1) - 1, h - 1);
ctx.setLineDash([]);
} else {
ctx.fillStyle = CHANNELS[channelOf(st)].striped ? stripes(ctx, color) : color;
ctx.beginPath();
if (ctx.roundRect) ctx.roundRect(x1, y - h / 2, Math.max(3, x2 - x1), h, 4); else ctx.rect(x1, y - h / 2, Math.max(3, x2 - x1), h);
ctx.fill();
}
hits.push({ x1, x2: Math.max(x1 + 3, x2), y: y - h / 2 - 3, y2: y + h / 2 + 3, stay: st, room });
});
});
if (today.startsWith(ym)) {
const x = xDay(Number(today.slice(8, 10))) + colW / 2;
ctx.strokeStyle = c.ink; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
ctx.beginPath(); ctx.moveTo(x, headH); ctx.lineTo(x, height); ctx.stroke(); ctx.setLineDash([]);
}
PLOTS.timeline = { hits, width };
}

// Whose rental this was: the owner of the listing the stay sits on.
function stayOwner(stay) {
const listing = (data.airbnbListings || []).find((l) => l.id === stay.listingId);
return (listing && ownerNameFor(ownerKeyFor(listing))) || 'Unassigned';
}

function timelineTip(evt) {
const canvas = document.getElementById('occ-timeline-canvas');
const tip = document.getElementById('occ-tip');
if (!canvas || !tip || !PLOTS.timeline) return;
const r = canvas.getBoundingClientRect();
const x = evt.clientX - r.left; const y = evt.clientY - r.top;
const hit = PLOTS.timeline.hits.find((h) => x >= h.x1 && x <= h.x2 && y >= h.y && y <= h.y2);
if (!hit) { tip.hidden = true; return; }
const st = hit.stay;
const nights = nightsBetween(st.checkin, st.checkout);
const fmt = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const lines = [
`<strong>${escapeHtml(st.guest || (st.status === 'cancelled' ? 'Cancelled booking' : 'Booking'))}</strong>`,
`${escapeHtml(hit.room.label || 'Room')} · ${escapeHtml(stayOwner(st))} · ${escapeHtml(CHANNELS[channelOf(st)].label)}`,
`${fmt(st.checkin)} to ${fmt(st.checkout)}${st.approx ? ' (check-out unknown, one night shown)' : ` · ${nights} night${nights === 1 ? '' : 's'}`}`,
];
if (st.status === 'cancelled') lines.push(`Cancelled${st.cancelledOn ? ` ${fmt(st.cancelledOn)}` : ''}`);
if (st.income != null) lines.push(`Income £${Number(st.income).toLocaleString('en-GB', { maximumFractionDigits: 2 })}`);
if (st.bookedOn) lines.push(`Booked ${fmt(st.bookedOn)}`);
if ((st.clashes || []).length) lines.push(`<strong>Clashes with ${st.clashes.map((c) => `${escapeHtml(c.guest || 'another stay')} (${fmt(c.checkin)} to ${fmt(c.checkout)})`).join(', ')}</strong>`);
tip.innerHTML = lines.join('<br>');
tip.hidden = false;
tip.style.left = `${Math.min(x + 12, PLOTS.timeline.width - 200)}px`;
tip.style.top = `${Math.max(0, y - 10)}px`;
}

// ---- Pace worm ----------------------------------------------------------------

function niceMax(v) {
if (v <= 0) return 1;
const mag = 10 ** Math.floor(Math.log10(v));
const f = v / mag;
return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
}

function drawPace(stays) {
const canvas = document.getElementById('pace-canvas');
const verdictEl = document.getElementById('pace-verdict');
const tableEl = document.getElementById('occ-table');
if (!canvas) return;
const ym = state.ym; const metric = state.metric; const today = todayStr();
const fullLead = leadFor(metric);
let lead = fullLead;
let cur = seriesFor(stays, ym, metric, today);
const cmp = comparisonSeries(stays, ym, state.compare, metric, today);
if (fullLead) {
// Nights booked: start the axis just before bookings begin to appear (in this month or in the
// comparison one), not a fixed 16 weeks back, so there are not weeks of flat zero on the left.
let firstIdx = Infinity;
[cur, cmp.values || []].forEach((arr) => { const i = arr.findIndex((v) => v !== null && v > 0); if (i >= 0 && i < firstIdx) firstIdx = i; });
const daysBefore = Number.isFinite(firstIdx) ? Math.max(0, fullLead - firstIdx) : 0;
lead = Math.min(fullLead, Math.max(14, Math.ceil(daysBefore / 7) * 7 + 7)); // whole weeks, one of lead-in
const cut = fullLead - lead;
if (cut > 0) { cur = cur.slice(cut); if (cmp.values) cmp.values = cmp.values.slice(cut); }
}
const n = cur.length;
// Nights occupied and Revenue earned: the rest of the month (or all of a month yet to start) as
// already booked. Only for a month that is not over.
const proj = metric !== 'bookings' && cur.some((v) => v === null) ? seriesFor(stays, ym, metric, today, true) : null;
const unit = METRIC_UNIT[metric];
const fmtVal = (v) => (metric === 'revenue' ? `£${Math.round(v).toLocaleString('en-GB')}` : `${Math.round(v * 10) / 10} night${Math.round(v * 10) / 10 === 1 ? '' : 's'}`);
const lastIdx = cur.reduce((acc, v, i) => (v !== null ? i : acc), -1); // latest day with data (today, or the month end)
let verdict = '';
let delta = null;
if (lastIdx >= 0 && cmp.values && cmp.values[lastIdx] !== null) {
delta = cur[lastIdx] - cmp.values[lastIdx];
const off = lastIdx - lead; // days from the 1st
const where = off < 0 ? `at the same point, ${-off} day${off === -1 ? '' : 's'} before it starts` : (ym === currentYm() ? `by day ${off + 1}` : 'over the whole month');
const mag = fmtVal(Math.abs(delta));
verdict = Math.abs(delta) < (metric === 'revenue' ? 1 : 0.05)
? `&#9644; Level with ${COMPARE_LABEL[state.compare]} ${where}.`
: delta > 0 ? `&#9650; <strong class="pace-up">${escapeHtml(mag)} ahead</strong> of ${COMPARE_LABEL[state.compare]} ${where}.`
: `&#9660; <strong class="pace-down">${escapeHtml(mag)} behind</strong> ${COMPARE_LABEL[state.compare]} ${where}.`;
} else if (!cmp.values) {
const cov = compareMonths(ym, state.compare).map((m) => `${longMonth(m)}: ${Math.round(coverageFor(stays, m, metric) * 100)}% of its nights have ${metric === 'bookings' ? 'a known booking date' : metric === 'revenue' ? 'income entered' : 'dates'}`);
verdict = metric === 'bookings'
? `Collecting data for this comparison (${escapeHtml(cov.join('; '))}). It fills in as bookings are seen from now on; try &ldquo;Nights occupied&rdquo; for an immediate comparison.`
: `Nothing on file to compare with for ${escapeHtml(compareMonths(ym, state.compare).map(longMonth).join(', '))} (${escapeHtml(cov.join('; '))}).`;
}
if (metric === 'bookings' && cmp.values && cmp.minCoverage < 0.9) {
verdict += ` Booking dates are only known for ${Math.round(cmp.minCoverage * 100)}% of ${COMPARE_LABEL[state.compare]}'s nights, so its line is an under-count and "ahead" flatters this month.`;
}
const projEnd = proj ? proj[n - 1] : null;
if (ym > currentYm() && metric !== 'bookings') {
verdict = projEnd ? `This month has not started, so there is no pace to compare yet. The dotted line is what is already booked: ${fmtVal(projEnd)}.` : 'This month has not started, so there is no pace to compare yet. The timeline above shows what is already booked.';
} else if (projEnd !== null && lastIdx >= 0 && projEnd > cur[lastIdx] + 1e-9) {
const full = cmp.values && cmp.values[n - 1] !== null ? `, against ${fmtVal(cmp.values[n - 1])} for ${COMPARE_LABEL[state.compare]} in full` : '';
verdict += ` Stays already booked take it to ${fmtVal(projEnd)} by the end of the month${full}.${metric === 'revenue' ? ' A stay with no income entered yet adds nothing.' : ''}`;
}
verdictEl.innerHTML = verdict || 'No bookings found for this month yet.';
const s = setup(canvas);
if (!s) return;
const { ctx, width, height } = s;
const c = palette();
const narrow = width < 520;
const plot = { x: narrow ? 38 : 48, y: 14, w: width - (narrow ? 38 : 48) - 16, h: height - 14 - 26 };
const maxV = niceMax(Math.max(1, ...cur.filter((v) => v !== null), ...(cmp.values || []).filter((v) => v !== null), ...(proj || []).filter((v) => v !== null)));
const X = (i) => plot.x + (n === 1 ? 0 : (i / (n - 1)) * plot.w);
const Y = (v) => plot.y + plot.h - (v / maxV) * plot.h;
ctx.font = '11px Inter, sans-serif';
// grid + y axis
ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
for (let g = 0; g <= 4; g++) {
const v = (maxV * g) / 4; const y = Y(v);
ctx.strokeStyle = c.line; ctx.globalAlpha = g === 0 ? 1 : 0.6; ctx.lineWidth = 1;
ctx.beginPath(); ctx.moveTo(plot.x, y); ctx.lineTo(plot.x + plot.w, y); ctx.stroke(); ctx.globalAlpha = 1;
ctx.fillStyle = c.muted;
ctx.fillText(metric === 'revenue' ? `£${Math.round(v)}` : String(Math.round(v * 10) / 10), plot.x - 5, y);
}
// x axis
ctx.textAlign = 'center'; ctx.textBaseline = 'top';
if (lead) {
// Weeks before the month, then the weeks within it; the 1st is marked with a line.
const stride = narrow ? 4 : 2;
for (let i = 0; i < n; i++) {
const o = i - lead;
const wk = o / 7;
let label = '';
if (o < 0 && Number.isInteger(wk) && (-wk) % stride === 0) label = `${-wk}w`;
else if (o === 0) label = `${shortDate(dayStr(ym, 1))}`;
else if (o > 0 && Number.isInteger(wk)) label = `wk ${wk + 1}`;
else if (i === n - 1 && (o % 7) >= 4) label = 'end'; // skipped when it would sit on top of the last week label
if (label) { ctx.fillStyle = c.muted; ctx.fillText(label, X(i), plot.y + plot.h + 6); }
}
const x0 = X(lead);
ctx.strokeStyle = c.muted; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
ctx.beginPath(); ctx.moveTo(x0, plot.y); ctx.lineTo(x0, plot.y + plot.h); ctx.stroke(); ctx.setLineDash([]);
ctx.fillStyle = c.muted; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
ctx.fillText('weeks before the month', x0 - 6, plot.y + 2);
ctx.textAlign = 'left'; ctx.fillText('the month', x0 + 6, plot.y + 2);
ctx.textAlign = 'center';
} else {
for (let i = 0; i < n; i++) {
const d = i + 1;
if (d === 1 || d % 5 === 0 || d === n) { ctx.fillStyle = c.muted; ctx.fillText(String(d), X(i), plot.y + plot.h + 6); }
}
}
// shaded gap between the two lines, only where both exist
if (cmp.values) {
for (let i = 0; i < n - 1; i++) {
if (cur[i] === null || cur[i + 1] === null || cmp.values[i] === null || cmp.values[i + 1] === null) continue;
const up = (cur[i] + cur[i + 1]) / 2 >= (cmp.values[i] + cmp.values[i + 1]) / 2;
ctx.fillStyle = up ? c.good : c.bad; ctx.globalAlpha = 0.22;
ctx.beginPath();
ctx.moveTo(X(i), Y(cur[i])); ctx.lineTo(X(i + 1), Y(cur[i + 1]));
ctx.lineTo(X(i + 1), Y(cmp.values[i + 1])); ctx.lineTo(X(i), Y(cmp.values[i]));
ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
}
// comparison line
ctx.strokeStyle = c.muted; ctx.lineWidth = 1.75; ctx.setLineDash([5, 4]);
ctx.beginPath(); let started = false;
cmp.values.forEach((v, i) => { if (v === null) return; if (!started) { ctx.moveTo(X(i), Y(v)); started = true; } else ctx.lineTo(X(i), Y(v)); });
ctx.stroke(); ctx.setLineDash([]);
}
// this month's line, with an emphasised endpoint
ctx.strokeStyle = c.ink; ctx.lineWidth = 2.5; ctx.lineJoin = 'round';
ctx.beginPath(); let st = false;
cur.forEach((v, i) => { if (v === null) return; if (!st) { ctx.moveTo(X(i), Y(v)); st = true; } else ctx.lineTo(X(i), Y(v)); });
ctx.stroke();
// the rest of the month as already booked, dotted, joined to today's point
if (proj && proj[n - 1] !== null && proj[n - 1] > 0) {
ctx.strokeStyle = c.ink; ctx.lineWidth = 2; ctx.globalAlpha = 0.7; ctx.setLineDash([2, 4]);
ctx.beginPath(); let ps = false;
for (let i = Math.max(lastIdx, 0); i < n; i++) { const v = proj[i]; if (v === null) continue; if (!ps) { ctx.moveTo(X(i), Y(v)); ps = true; } else ctx.lineTo(X(i), Y(v)); }
ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
}
if (lastIdx >= 0) {
ctx.fillStyle = c.ink; ctx.beginPath(); ctx.arc(X(lastIdx), Y(cur[lastIdx]), 4, 0, Math.PI * 2); ctx.fill();
ctx.strokeStyle = c.card; ctx.lineWidth = 2; ctx.stroke();
}
// direct labels at the line ends
ctx.textBaseline = 'middle';
// Label each line at its latest point; flip to the left of the point when it would run off the right edge.
const usedY = [];
const putLabel = (text, idx, value, color, dy) => {
const w = ctx.measureText(text).width;
const flip = X(idx) + 8 + w > width - 4;
ctx.textAlign = flip ? 'right' : 'left';
ctx.fillStyle = color;
let y = Math.min(Y(value) + dy, plot.y + plot.h - 10);
while (usedY.some((u) => Math.abs(u - y) < 12)) y -= 12;
usedY.push(y);
ctx.fillText(text, flip ? X(idx) - 8 : X(idx) + 8, y);
};
const behind = lastIdx >= 0 && cmp.values && cmp.values[lastIdx] !== null && cur[lastIdx] < cmp.values[lastIdx];
if (lastIdx >= 0) putLabel(`${longMonth(ym).split(' ')[0]} ${fmtVal(cur[lastIdx]).replace(/ nights?/, '')}`, lastIdx, cur[lastIdx], c.ink, behind ? 12 : -10);
if (proj && proj[n - 1] !== null && proj[n - 1] > 0 && (lastIdx < 0 || proj[n - 1] > cur[lastIdx] + 1e-9)) putLabel(`Booked ${fmtVal(proj[n - 1]).replace(/ nights?/, '')}`, n - 1, proj[n - 1], c.ink, -10);
if (cmp.values && lastIdx >= 0 && cmp.values[lastIdx] !== null) putLabel(`${state.compare === 'lastyear' ? 'Last yr' : state.compare === 'prev3' ? 'Avg 3m' : 'Last mo'} ${fmtVal(cmp.values[lastIdx]).replace(/ nights?/, '')}`, lastIdx, cmp.values[lastIdx], c.muted, behind ? -10 : 12);
if (state.hoverDay !== null && state.hoverDay >= 0 && state.hoverDay < n) {
ctx.strokeStyle = c.muted; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
ctx.beginPath(); ctx.moveTo(X(state.hoverDay), plot.y); ctx.lineTo(X(state.hoverDay), plot.y + plot.h); ctx.stroke(); ctx.setLineDash([]);
}
PLOTS.pace = { plot, n, cur, cmp: cmp.values, proj, X, fmtVal, lead };
// table view (a row a week for the long lead-in axis, a row a day otherwise)
const rows = [];
for (let i = 0; i < n; i++) {
if (lead && (i - lead) % 7 !== 0 && i !== n - 1) continue;
rows.push(`<tr><td>${lead ? escapeHtml(shortDate(dateStrAdd(dayStr(ym, 1), i - lead))) : i + 1}</td><td style="text-align:right;">${cur[i] === null ? '' : escapeHtml(fmtVal(cur[i]))}</td>${proj ? `<td style="text-align:right;">${proj[i] === null ? '' : escapeHtml(fmtVal(proj[i]))}</td>` : ''}<td style="text-align:right;">${cmp.values && cmp.values[i] !== null ? escapeHtml(fmtVal(cmp.values[i])) : ''}</td></tr>`);
}
tableEl.innerHTML = `<table class="limits-table" style="min-width:0;"><thead><tr><th>${lead ? 'Date' : 'Day'}</th><th style="text-align:right;">${escapeHtml(METRIC_LABEL[metric])}</th>${proj ? '<th style="text-align:right;">With stays already booked</th>' : ''}<th style="text-align:right;">${escapeHtml(COMPARE_LABEL[state.compare])}</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function paceTip(evt) {
const canvas = document.getElementById('pace-canvas');
const tip = document.getElementById('pace-tip');
if (!canvas || !tip || !PLOTS.pace) return;
const { plot, n, cur, cmp, proj, fmtVal, lead } = PLOTS.pace;
const r = canvas.getBoundingClientRect();
const x = evt.clientX - r.left;
const i = Math.round(((x - plot.x) / plot.w) * (n - 1));
if (i < 0 || i >= n) { state.hoverDay = null; tip.hidden = true; drawPace(collectStays()); return; }
state.hoverDay = i;
const date = dateStrAdd(dayStr(state.ym, 1), i - lead);
let day = new Date(`${date}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
if (lead && i < lead) day += ` (${Math.ceil((lead - i) / 7)} wk${Math.ceil((lead - i) / 7) === 1 ? '' : 's'} before the month)`;
tip.innerHTML = `<strong>${escapeHtml(day)}</strong><br>${cur[i] === null ? 'Not yet' : escapeHtml(`${METRIC_LABEL[state.metric]}: ${fmtVal(cur[i])}`)}${proj && proj[i] !== null && (cur[i] === null || proj[i] !== cur[i]) ? `<br>${escapeHtml(`With stays already booked: ${fmtVal(proj[i])}`)}` : ''}${cmp && cmp[i] !== null ? `<br>${escapeHtml(COMPARE_LABEL[state.compare])}: ${escapeHtml(fmtVal(cmp[i]))}` : ''}`;
tip.hidden = false;
tip.style.left = `${Math.min(x + 12, r.width - 190)}px`;
tip.style.top = '8px';
drawPace(collectStays());
}

// ---- Render / init --------------------------------------------------------------

function renderLegend(stays) {
const el = document.getElementById('occ-legend');
if (!el) return;
const rooms = lanes();
// One entry per room, then a coloured dot per listing in it (named by its owner).
const items = rooms.map((r) => {
const dots = r.members.map((l) => `<span class="dot ${escapeHtml(l.colour || 'slate')}"></span><span class="settings-note" style="margin:0 6px 0 0;">${escapeHtml(ownerNameFor(ownerKeyFor(l)) || l.label || 'Listing')}</span>`).join('');
return `<span class="letting-chart-legend-item">${escapeHtml(r.label || 'Room')}: ${dots}</span>`;
});
Object.values(CHANNELS).forEach((ch) => items.push(`<span class="letting-chart-legend-item"><span class="${ch.striped ? 'occ-key-striped' : 'occ-key-solid'}"></span>${escapeHtml(ch.label)}</span>`));
items.push('<span class="letting-chart-legend-item"><span class="occ-key-hatch"></span>Cancelled</span>');
el.innerHTML = items.join('');
const sum = document.getElementById('occ-summary');
if (sum) {
const inMonth = stays.filter((s) => s.status === 'stay' && nightsInMonth(s, state.ym) > 0);
// Distinct (room, night) pairs, the same count the night-rate chart's occupancy bars use: never above one a night.
const nightMap = roomNightMap(stays, state.ym, daysIn(state.ym), 'month', todayStr(), ''); // every booked night in the month, all channels, none cancelled
const nights = nightMap.size;
const byChannel = {};
nightMap.forEach((ch) => { byChannel[ch] = (byChannel[ch] || 0) + 1; });
const split = Object.keys(byChannel).length > 1 ? `; ${Object.entries(byChannel).map(([ch, k]) => `${k} ${CHANNELS[ch].label}`).join(', ')}` : '';
const cancelled = stays.filter((s) => s.status === 'cancelled' && nightsInMonth(s, state.ym) > 0).length;
const roomNights = (nightRateRooms().length || 1) * daysIn(state.ym);
const unplaced = stays.unplacedCancellations ? `; ${stays.unplacedCancellations} older cancellation payout${stays.unplacedCancellations === 1 ? '' : 's'} couldn't be placed on a room` : '';
const payouts = (stays.items || []).filter((it) => !it.start && it.date.slice(0, 7) === state.ym);
const payoutNote = state.metric === 'revenue' && payouts.length ? `. Revenue includes £${Math.round(payouts.reduce((a, p) => a + p.gross, 0)).toLocaleString('en-GB')} from ${payouts.length} payout${payouts.length === 1 ? '' : 's'} with no stay dates (cancellations and historic entries)` : '';
const undrawn = stays.unplacedIncome ? `; ${stays.unplacedIncome} ledger income entr${stays.unplacedIncome === 1 ? 'y' : 'ies'} couldn't be placed on a room (counted in revenue, not drawn)` : '';
const check = reconcileNote(stays);
sum.textContent = `${inMonth.length} booking${inMonth.length === 1 ? '' : 's'}, ${nights} night${nights === 1 ? '' : 's'} (${Math.round((nights / roomNights) * 100)}% of room-nights${split})${cancelled ? `, ${cancelled} cancelled` : ''}${unplaced}${undrawn}${payoutNote}.${check ? ` Against Income by month: ${check}.` : ''}`;
}
}

// On the revenue metric, finished months are checked against the Income by month
// chart so a gap between the two shows up here rather than being taken on trust.
function reconcileNote(stays) {
if (state.metric !== 'revenue' || state.channel) return ''; // Income by month counts every channel
const months = [state.ym, ...compareMonths(state.ym, state.compare)].filter((m) => m < currentYm());
return months.map((ym) => {
const series = seriesFor(stays, ym, 'revenue', todayStr());
const mine = series[series.length - 1] || 0;
const main = lettingChartMonthTotal(ym);
const gap = Math.round(main - mine);
return `${monthLabel(ym)} ${money0(mine)} here, ${money0(main)} there${Math.abs(gap) > 1 ? ` (${money0(Math.abs(gap))} ${gap > 0 ? 'missing here' : 'extra here'})` : ' ✓'}`;
}).join(' · ');
}

function shortDate(d) { return new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); }

// Every income entry that falls in the chosen month and where it ended up, with the
// reason for any that are not on the timeline.
function renderIncomeTrace(stays) {
const el = document.getElementById('occ-income-trace');
if (!el) return;
const first = dayStr(state.ym, 1);
const next = dayStr(addMonths(state.ym, 1), 1);
const rows = (stays.trace || [])
.filter(({ it }) => (it.start ? it.start < next && it.end > first : (it.date || '').slice(0, 7) === state.ym))
.sort((a, b) => (a.it.start || a.it.date).localeCompare(b.it.start || b.it.date));
const roomName = (id) => ((data.airbnbListings || []).find((l) => l.id === id) || {}).label || 'a room';
const goto = '<span class="inline-goto-link" role="button" tabindex="0" data-goto-tab="finances" data-goto-target="#letting-list">Letting income</span>';
// The room holds one guest a night: name every other stay whose nights overlap this one.
const clash = (r) => ((r.clashes || []).length
? ` <strong>Clashes with ${r.clashes.map((c) => `${escapeHtml(c.guest || 'another stay')} (${shortDate(c.checkin)} to ${shortDate(c.checkout)})`).join(', ')}</strong> in the same room, so one of them has the wrong dates.`
: '');
const why = (r) => {
const { it } = r;
if (r.fate === 'drawn') return `Drawn on the ${escapeHtml(roomName(r.room))} row${it.source === 'ledger' && !it.explicit ? ' (room chosen from its owner)' : ''}.${clash(r)}`;
if (r.fate === 'covered') return 'Nothing to fix: this is the accrual posted for a booking that is still on file, so the money is already counted once through that booking (its row above).';
if (r.fate === 'skipped') return `Not counted anywhere. ${escapeHtml(r.reason)} Fix it on its ${goto} row.`;
if (r.fate === 'merged') return `Exactly the same room and dates as another record, so drawn once on ${escapeHtml(roomName(r.room))}.${clash(r)}`;
if (r.fate === 'payout') return `Cancellation payout, counted on ${shortDate(it.date)}.`;
if (r.fate === 'lump') return `No check-in date or nights, so it can't be drawn. Counted in revenue on ${shortDate(it.date)} only. Add them on its ${goto} row.`;
if (r.fate === 'noroom') return `The row names no room and its owner has several, so it counts in revenue but isn't drawn. Pick the room on its ${goto} row.`;
return 'Its dates are not valid, so it is not drawn.';
};
// The note often already repeats the listing name ("Double - Zara, Guest"); show it once.
const entryName = (it) => {
const label = it.listing.label || 'Listing';
const note = String(it.note || '').split(/\s*,\s*/).filter((p) => p && p !== label).join(', ');
return note ? `${label}, ${note}` : label;
};
const when = (it) => (it.start ? `${shortDate(it.start)} to ${shortDate(it.end)}` : (it.date ? `paid ${shortDate(it.date)}` : 'no date'));
el.innerHTML = `<summary class="settings-note" style="cursor:pointer;">Where this month's income entries went (${rows.length})</summary>
<div style="overflow-x:auto;"><table class="limits-table"><thead><tr><th>Dates</th><th>Entry</th><th>£</th><th>On the timeline?</th></tr></thead><tbody>${rows.map((r) => `<tr>
<td>${escapeHtml(when(r.it))}</td>
<td>${escapeHtml(entryName(r.it))}</td>
<td>${escapeHtml(money0(r.it.gross))}</td>
<td>${why(r)}</td></tr>`).join('') || '<tr><td colspan="4">No income entries fall in this month.</td></tr>'}</tbody></table></div>`;
}

function renderLettingOccupancy() {
if (!document.getElementById('occ-timeline-canvas')) return;
const stays = collectStays();
renderIncomeTrace(stays);
renderLegend(stays);
drawTimeline(stays);
drawPace(stays);
}

function initLettingOccupancy() {
const panel = document.getElementById('letting-panel');
if (!panel || document.getElementById('letting-occupancy-section')) return;
panel.insertAdjacentHTML('beforeend', sectionHtml());
state.ym = currentYm();
const monthSel = document.getElementById('occ-month');
monthSel.innerHTML = monthOptions().map((o) => `<option value="${o.ym}"${o.ym === state.ym ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
monthSel.addEventListener('change', () => { state.ym = monthSel.value; renderLettingOccupancy(); });
document.getElementById('pace-metric').addEventListener('change', (e) => { state.metric = e.target.value; renderLettingOccupancy(); });
document.getElementById('pace-compare').addEventListener('change', (e) => { state.compare = e.target.value; renderLettingOccupancy(); });
document.getElementById('pace-channel').addEventListener('change', (e) => { state.channel = e.target.value; renderLettingOccupancy(); });
const tl = document.getElementById('occ-timeline-canvas');
tl.addEventListener('pointermove', timelineTip);
tl.addEventListener('pointerleave', () => { document.getElementById('occ-tip').hidden = true; });
const pc = document.getElementById('pace-canvas');
pc.addEventListener('pointermove', paceTip);
pc.addEventListener('pointerleave', () => { state.hoverDay = null; document.getElementById('pace-tip').hidden = true; drawPace(collectStays()); });
// A canvas on a hidden tab measures 0x0: draw again once Finances is shown, on resize and on a theme change.
document.addEventListener('tabshown', (e) => { if (e.detail?.tab === 'finances') renderLettingOccupancy(); });
window.addEventListener('resize', renderLettingOccupancy);
window.addEventListener('themechange', renderLettingOccupancy);
renderLettingOccupancy();
}

export { initLettingOccupancy, renderLettingOccupancy, collectStays, seriesFor, comparisonSeries, coverageFor, nightsInMonth };
