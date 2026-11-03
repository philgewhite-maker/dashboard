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
import { listingColorVar, resolveColor, addMonths, monthLabel, ownerKeyFor, ownerNameFor } from './letting.js';

const DAY_MS = 86400000;
const MIN_COVERAGE = 0.8; // share of a month's nights that must have a known booking date before it is compared

function ymOf(dateStr) { return String(dateStr).slice(0, 7); }
function daysIn(ym) { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); }
function dayStr(ym, d) { return `${ym}-${String(d).padStart(2, '0')}`; }
function nightsBetween(a, b) { return Math.round((new Date(`${b}T00:00:00`) - new Date(`${a}T00:00:00`)) / DAY_MS); }
function longMonth(ym) { const [y, m] = ym.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }); }

// ---- Data ------------------------------------------------------------------

// One list of every stay we know about, whichever record it is still held in:
//  live      data.airbnbReservations (current and upcoming, and recent ones awaiting income)
//  finished  data.airbnbPastStays (kept ~400 days after they end)
//  cancelled data.airbnbCancelledStays (recorded from the day a future booking leaves the feed)
//  ledger    older stays only the Letting ledger remembers (accrual/earned rows with a
//            start date or night count), and older cancellations (a payout row only)
// A stay is matched across sources by listing + check-in + check-out so it is never drawn twice.
function collectStays() {
const stays = [];
const seen = new Set();
const keyOf = (s) => `${s.listingId}|${s.checkin}|${s.checkout}`;
const add = (s) => {
if (!s.listingId || !s.checkin || !s.checkout || s.checkout <= s.checkin) return;
const k = `${s.status}|${keyOf(s)}`;
if (seen.has(k)) return;
seen.add(k);
stays.push(s);
};
(data.airbnbReservations || []).forEach((r) => add({
id: r.id, listingId: r.listingId, checkin: r.checkin, checkout: r.checkout, guest: r.guestName || '',
income: r.income ?? null, bookedOn: r.confirmedOn || String(r.createdAt || '').slice(0, 10), status: 'stay', source: 'live',
}));
(data.airbnbPastStays || []).forEach((s) => add({
id: `past:${keyOf(s)}`, listingId: s.listingId, checkin: s.checkin, checkout: s.checkout, guest: s.guestName || '',
income: s.income ?? null, bookedOn: s.bookedOn || '', status: 'stay', source: 'finished',
}));
(data.airbnbCancelledStays || []).forEach((s) => add({
id: s.id, listingId: s.listingId, checkin: s.checkin, checkout: s.checkout, guest: s.guestName || '',
income: null, bookedOn: s.bookedOn || '', cancelledOn: s.cancelledOn || '', status: 'cancelled', source: 'cancelled',
}));
// Listings by the same owner key the ledger rows carry (a connection id, or a
// lowercased typed name), so a ledger row finds its owner's rooms either way.
const ownerListings = new Map();
(data.airbnbListings || []).forEach((l) => {
const k = ownerKeyFor(l);
if (!ownerListings.has(k)) ownerListings.set(k, []);
ownerListings.get(k).push(l);
});
const reservationIds = new Set((data.airbnbReservations || []).map((r) => r.id));
let unplaced = 0;
const lumps = [];       // dated lump sums with no night-by-night shape: cancellation payouts, undated historic income
const revenueOnly = []; // income that spans nights but has no room to draw it on
(data.lettingLedger || []).forEach((e) => {
if (e.kind === 'cancellation') {
const gross = Number(e.gross) || 0;
// The payout is revenue whether or not we know the room.
if (gross && e.date) lumps.push({ id: e.id, date: e.date, gross });
const checkin = e.checkin || dateStrAdd(e.date, -1);
const listingId = roomForCancellation(e, ownerListings);
if (!listingId) { unplaced += 1; return; }
if ((data.airbnbCancelledStays || []).some((s) => s.listingId === listingId && s.checkin === checkin)) return;
// Without a recorded end date the stay's own length is unknown, so one night is drawn.
const checkout = e.checkout && e.checkout > checkin ? e.checkout : dateStrAdd(checkin, 1);
add({ id: `led:${e.id}`, listingId, checkin, checkout, guest: e.note || '', income: null, bookedOn: '', cancelledOn: e.date, status: 'cancelled', source: 'ledger', approx: !(e.checkout && e.checkout > checkin) });
return;
}
if (e.kind === 'accrual' || e.kind === 'earned') {
const checkin = e.startDate || (e.nights ? dateStrAdd(e.date, -Number(e.nights)) : '');
if (e.listingId && checkin) {
add({ id: `led:${e.id}`, listingId: e.listingId, checkin, checkout: e.date, guest: e.note || '', income: e.gross ?? null, bookedOn: '', status: 'stay', source: 'ledger' });
return;
}
// Income the Letting income chart above counts but that has no room to draw: historic
// entries, and accruals whose reservation has aged out. Same rule that chart uses.
const orphaned = e.kind === 'accrual' && e.reservationId && !reservationIds.has(e.reservationId);
if ((e.kind === 'earned' || orphaned) && e.gross && e.date) {
if (checkin && checkin < e.date) revenueOnly.push({ checkin, checkout: e.date, income: e.gross, status: 'stay' });
else lumps.push({ id: e.id, date: e.date, gross: Number(e.gross) });
}
}
});
stays.unplacedCancellations = unplaced;
stays.lumps = lumps;
stays.revenueOnly = revenueOnly;
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

function countFor(stay, ym, upToDay, metric, today) {
const D = dayStr(ym, upToDay);
if (metric === 'bookings') {
if (!stay.bookedOn || stay.bookedOn > D) return 0;
if (stay.status === 'cancelled' && (!stay.cancelledOn || stay.cancelledOn <= D)) return 0;
return nightsInMonth(stay, ym);
}
if (stay.status === 'cancelled') return 0;
// Occupied nights and revenue both accrue night by night, only up to today.
const upTo = D < dateStrAdd(today, 1) ? D : today;
const first = dayStr(ym, 1);
const lastNight = dateStrAdd(upTo, 1); // nights strictly before this date
const from = stay.checkin > first ? stay.checkin : first;
const to = stay.checkout < lastNight ? stay.checkout : lastNight;
const nights = to > from ? nightsBetween(from, to) : 0;
if (metric === 'nights') return nights;
const total = nightsBetween(stay.checkin, stay.checkout);
return stay.income != null && total > 0 ? (Number(stay.income) * nights) / total : 0;
}

// Cumulative series for one month, day 1..N. Days after today in the current
// month are null (nothing has happened yet for occupied nights / revenue; for
// bookings the line stops too, since bookings made after today don't exist).
function seriesFor(stays, ym, metric, today) {
const n = daysIn(ym);
const out = [];
for (let d = 1; d <= n; d++) {
if (dayStr(ym, d) > today) { out.push(null); continue; }
let sum = 0;
stays.forEach((s) => { sum += countFor(s, ym, d, metric, today); });
if (metric === 'revenue') {
// Income with no room to draw (it still counts toward the month's revenue).
(stays.revenueOnly || []).forEach((s) => { sum += countFor(s, ym, d, metric, today); });
// A payout lands on its own date, all at once, and only once that date has passed.
const day = dayStr(ym, d);
(stays.lumps || []).forEach((p) => { if (p.date.slice(0, 7) === ym && p.date <= day && p.date <= today) sum += p.gross; });
}
out.push(Math.round(sum * 100) / 100);
}
return out;
}

// For the "bookings made" metric a month can only be compared if most of its
// nights belong to stays with a known booking date. Older stays predate that
// being recorded, so they say so instead of showing a flat, misleading line.
function coverageFor(stays, ym, metric) {
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
const usable = months.filter((m) => coverageFor(stays, m, metric) >= MIN_COVERAGE);
const n = daysIn(ym);
if (!usable.length) return { values: null, usable, months };
const all = usable.map((m) => seriesFor(stays, m, metric, today));
const values = [];
for (let d = 0; d < n; d++) {
const picked = all.map((s) => s[Math.min(d, s.length - 1)]).filter((v) => v !== null);
values.push(picked.length ? Math.round((picked.reduce((a, b) => a + b, 0) / picked.length) * 100) / 100 : null);
}
return { values, usable, months };
}

// ---- State & markup ----------------------------------------------------------

const state = { ym: '', metric: 'bookings', compare: 'prev', hoverStay: null, hoverDay: null };
const PLOTS = { timeline: null, pace: null };
const METRIC_LABEL = { bookings: 'Nights booked', nights: 'Nights occupied', revenue: 'Revenue earned' };
const METRIC_UNIT = { bookings: 'nights', nights: 'nights', revenue: '£' };

function currentYm() { return todayStr().slice(0, 7); }

function monthOptions() {
const cur = currentYm();
const opts = [{ ym: addMonths(cur, 1), label: `Next month (${longMonth(addMonths(cur, 1))})` }, { ym: cur, label: `This month (${longMonth(cur)})` }, { ym: addMonths(cur, -1), label: `Last month (${longMonth(addMonths(cur, -1))})` }];
for (let i = 2; i <= 13; i++) opts.push({ ym: addMonths(cur, -i), label: longMonth(addMonths(cur, -i)) });
return opts;
}

function sectionHtml() {
return `<div class="letting-chart-wrap" id="letting-occupancy-section">
<div class="panel-head" style="margin:14px 0 6px;"><h2 style="font-size:13px;">Occupancy and booking pace</h2></div>
<details class="settings-subgroup panel-about"><summary>About this</summary>
<div class="settings-note" style="margin:0 0 6px;">Top: each room is a lane and each booking a line from check-in to check-out, so turnovers show as a gap. Hatched lines are cancelled bookings (recorded from the day they leave the Airbnb feed; older ones appear only when they have a cancellation payout, and show as a single night). Bottom: the same month as a cumulative line against the same day of a comparison month, with the gap shaded and named. <strong>Nights booked</strong> counts a booking from the day it was confirmed (its confirmation email) and takes a cancelled one back out from the day it was cancelled; booking dates are only known for stays seen since this was added, so older months say "collecting data" instead of showing a misleading line. <strong>Nights occupied</strong> and <strong>Revenue earned</strong> compare straight away.</div>
</details>
<div class="sync-row" style="gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:6px;">
<select id="occ-month" class="mini" title="The month both charts show"></select>
<span class="settings-note" id="occ-summary" style="margin:0;"></span>
</div>
<div class="letting-chart-legend" id="occ-legend" style="flex-direction:row;flex-wrap:wrap;"></div>
<div class="chart-canvas-wrap occ-wrap" style="position:relative;"><canvas id="occ-timeline-canvas"></canvas><div class="occ-tip" id="occ-tip" hidden></div></div>
<div class="sync-row" style="gap:8px;flex-wrap:wrap;align-items:center;margin:12px 0 4px;">
<select id="pace-metric" class="mini" title="What the line adds up"><option value="bookings">Nights booked</option><option value="nights">Nights occupied</option><option value="revenue">Revenue earned</option></select>
<span class="settings-note" style="margin:0;">against</span>
<select id="pace-compare" class="mini" title="What to compare it with"><option value="prev">Last month</option><option value="prev3">Last 3 months (average)</option><option value="lastyear">This month last year</option></select>
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
const listings = (data.airbnbListings || []);
const laneH = 40;
const headH = 22;
const wrap = canvas.parentElement;
wrap.style.height = `${Math.max(120, headH + listings.length * laneH + 12)}px`;
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
listings.forEach((l, i) => {
const top = headH + i * laneH;
const mid = top + laneH / 2;
ctx.strokeStyle = c.line; ctx.lineWidth = 1;
ctx.beginPath(); ctx.moveTo(left, top + laneH); ctx.lineTo(width - right, top + laneH); ctx.stroke();
ctx.fillStyle = c.ink; ctx.textAlign = 'left';
const label = l.label || l.prefix || 'Listing';
ctx.fillText(label.length > (narrow ? 9 : 17) ? `${label.slice(0, narrow ? 8 : 16)}…` : label, 6, mid);
const color = resolveColor(listingColorVar(l.colour));
stays.filter((st) => st.listingId === l.id && nightsInMonth(st, ym) > 0).forEach((st) => {
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
ctx.fillStyle = color;
ctx.beginPath();
if (ctx.roundRect) ctx.roundRect(x1, y - h / 2, Math.max(3, x2 - x1), h, 4); else ctx.rect(x1, y - h / 2, Math.max(3, x2 - x1), h);
ctx.fill();
}
hits.push({ x1, x2: Math.max(x1 + 3, x2), y: y - h / 2 - 3, y2: y + h / 2 + 3, stay: st, listing: l });
});
});
if (today.startsWith(ym)) {
const x = xDay(Number(today.slice(8, 10))) + colW / 2;
ctx.strokeStyle = c.ink; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
ctx.beginPath(); ctx.moveTo(x, headH); ctx.lineTo(x, height); ctx.stroke(); ctx.setLineDash([]);
}
PLOTS.timeline = { hits, width };
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
`${escapeHtml(hit.listing.label || hit.listing.prefix || 'Listing')} · ${fmt(st.checkin)} to ${fmt(st.checkout)}${st.approx ? ' (check-out unknown, one night shown)' : ` · ${nights} night${nights === 1 ? '' : 's'}`}`,
];
if (st.status === 'cancelled') lines.push(`Cancelled${st.cancelledOn ? ` ${fmt(st.cancelledOn)}` : ''}`);
if (st.income != null) lines.push(`Income £${Number(st.income).toLocaleString('en-GB', { maximumFractionDigits: 2 })}`);
if (st.bookedOn) lines.push(`Booked ${fmt(st.bookedOn)}`);
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
const cur = seriesFor(stays, ym, metric, today);
const cmp = comparisonSeries(stays, ym, state.compare, metric, today);
const n = cur.length;
const unit = METRIC_UNIT[metric];
const fmtVal = (v) => (metric === 'revenue' ? `£${Math.round(v).toLocaleString('en-GB')}` : `${Math.round(v * 10) / 10} night${Math.round(v * 10) / 10 === 1 ? '' : 's'}`);
const lastIdx = cur.reduce((acc, v, i) => (v !== null ? i : acc), -1); // latest day with data (today, or the month end)
let verdict = '';
let delta = null;
if (lastIdx >= 0 && cmp.values && cmp.values[lastIdx] !== null) {
delta = cur[lastIdx] - cmp.values[lastIdx];
const where = ym === currentYm() ? `by day ${lastIdx + 1}` : 'over the whole month';
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
if (ym > currentYm()) verdict = 'This month has not started, so there is no pace to compare yet. The timeline above shows what is already booked.';
verdictEl.innerHTML = verdict || 'No bookings found for this month yet.';
const s = setup(canvas);
if (!s) return;
const { ctx, width, height } = s;
const c = palette();
const narrow = width < 520;
const plot = { x: narrow ? 38 : 48, y: 14, w: width - (narrow ? 38 : 48) - 16, h: height - 14 - 26 };
const maxV = niceMax(Math.max(1, ...cur.filter((v) => v !== null), ...(cmp.values || []).filter((v) => v !== null)));
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
for (let i = 0; i < n; i++) {
const d = i + 1;
if (d === 1 || d % 5 === 0 || d === n) { ctx.fillStyle = c.muted; ctx.fillText(String(d), X(i), plot.y + plot.h + 6); }
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
if (cmp.values && lastIdx >= 0 && cmp.values[lastIdx] !== null) putLabel(`${state.compare === 'lastyear' ? 'Last yr' : state.compare === 'prev3' ? 'Avg 3m' : 'Last mo'} ${fmtVal(cmp.values[lastIdx]).replace(/ nights?/, '')}`, lastIdx, cmp.values[lastIdx], c.muted, behind ? -10 : 12);
if (state.hoverDay !== null && state.hoverDay >= 0 && state.hoverDay < n) {
ctx.strokeStyle = c.muted; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
ctx.beginPath(); ctx.moveTo(X(state.hoverDay), plot.y); ctx.lineTo(X(state.hoverDay), plot.y + plot.h); ctx.stroke(); ctx.setLineDash([]);
}
PLOTS.pace = { plot, n, cur, cmp: cmp.values, X, fmtVal };
// table view
const rows = [];
for (let i = 0; i < n; i++) rows.push(`<tr><td>${i + 1}</td><td style="text-align:right;">${cur[i] === null ? '' : escapeHtml(fmtVal(cur[i]))}</td><td style="text-align:right;">${cmp.values && cmp.values[i] !== null ? escapeHtml(fmtVal(cmp.values[i])) : ''}</td></tr>`);
tableEl.innerHTML = `<table class="limits-table" style="min-width:0;"><thead><tr><th>Day</th><th style="text-align:right;">${escapeHtml(METRIC_LABEL[metric])}</th><th style="text-align:right;">${escapeHtml(COMPARE_LABEL[state.compare])}</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function paceTip(evt) {
const canvas = document.getElementById('pace-canvas');
const tip = document.getElementById('pace-tip');
if (!canvas || !tip || !PLOTS.pace) return;
const { plot, n, cur, cmp, fmtVal } = PLOTS.pace;
const r = canvas.getBoundingClientRect();
const x = evt.clientX - r.left;
const i = Math.round(((x - plot.x) / plot.w) * (n - 1));
if (i < 0 || i >= n) { state.hoverDay = null; tip.hidden = true; drawPace(collectStays()); return; }
state.hoverDay = i;
const day = new Date(`${dayStr(state.ym, i + 1)}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
tip.innerHTML = `<strong>${escapeHtml(day)}</strong><br>${cur[i] === null ? 'No data yet' : escapeHtml(`${METRIC_LABEL[state.metric]}: ${fmtVal(cur[i])}`)}${cmp && cmp[i] !== null ? `<br>${escapeHtml(COMPARE_LABEL[state.compare])}: ${escapeHtml(fmtVal(cmp[i]))}` : ''}`;
tip.hidden = false;
tip.style.left = `${Math.min(x + 12, r.width - 190)}px`;
tip.style.top = '8px';
drawPace(collectStays());
}

// ---- Render / init --------------------------------------------------------------

function renderLegend(stays) {
const el = document.getElementById('occ-legend');
if (!el) return;
const listings = data.airbnbListings || [];
const items = listings.map((l) => `<span class="letting-chart-legend-item"><span class="dot ${escapeHtml(l.colour || 'slate')}"></span>${escapeHtml(l.label || l.prefix || 'Listing')}</span>`);
items.push('<span class="letting-chart-legend-item"><span class="occ-key-solid"></span>Booking</span>');
items.push('<span class="letting-chart-legend-item"><span class="occ-key-hatch"></span>Cancelled</span>');
el.innerHTML = items.join('');
const sum = document.getElementById('occ-summary');
if (sum) {
const inMonth = stays.filter((s) => s.status === 'stay' && nightsInMonth(s, state.ym) > 0);
const nights = inMonth.reduce((a, s) => a + nightsInMonth(s, state.ym), 0);
const cancelled = stays.filter((s) => s.status === 'cancelled' && nightsInMonth(s, state.ym) > 0).length;
const roomNights = (listings.length || 1) * daysIn(state.ym);
const unplaced = stays.unplacedCancellations ? `; ${stays.unplacedCancellations} older cancellation payout${stays.unplacedCancellations === 1 ? '' : 's'} couldn't be placed on a room` : '';
const payouts = (stays.lumps || []).filter((p) => p.date.slice(0, 7) === state.ym);
const payoutNote = state.metric === 'revenue' && payouts.length ? `. Revenue includes £${Math.round(payouts.reduce((a, p) => a + p.gross, 0)).toLocaleString('en-GB')} from ${payouts.length} payout${payouts.length === 1 ? '' : 's'} with no booking (cancellations and historic entries)` : '';
sum.textContent = `${inMonth.length} booking${inMonth.length === 1 ? '' : 's'}, ${nights} night${nights === 1 ? '' : 's'} (${Math.round((nights / roomNights) * 100)}% of room-nights)${cancelled ? `, ${cancelled} cancelled` : ''}${unplaced}${payoutNote}.`;
}
}

function renderLettingOccupancy() {
if (!document.getElementById('occ-timeline-canvas')) return;
const stays = collectStays();
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
