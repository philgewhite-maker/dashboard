// "Export bookings (Excel)" on the occupancy page: every booking and enquiry on record in one workbook, with what we know
// about each (dates, room, channel, guest, party size, ratings, what was paid and quoted, the free nights around it and
// the void it filled), a month-by-month summary per room, the latest saved forecast (the booking model's simulation, by
// month and by void), and native charts reading those sheets. Nothing is written to the dashboard's data.
import { data } from '../state.js';
import { todayStr } from '../utils.js';
import { buildXlsx } from '../xlsx.js';
import { collectStays } from './lettingoccupancy.js';
import { latestProjection } from './bookingprojection.js';
import { partySizeOf } from './partysize.js';
import { buildContext } from './bookingmodel.js';

const DAY = 86400000;
const dn = (d) => Math.round(Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`) / DAY);
const ds = (n) => new Date(n * DAY).toISOString().slice(0, 10);
const valid = (d) => /^\d{4}-\d{2}-\d{2}/.test(String(d || ''));
const ymOf = (d) => String(d).slice(0, 7);
const daysIn = (ym) => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate();
const addMonth = (ym, k) => { const d = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + k, 1)); return d.toISOString().slice(0, 7); };
const r2 = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100) / 100);
const weekendNights = (ci, co) => { let k = 0; for (let n = dn(ci); n < dn(co); n++) { const w = new Date(n * DAY).getUTCDay(); if (w === 5 || w === 6) k++; } return k; };
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function gather() {
const today = todayStr();
const listings = data.airbnbListings || [];
const listingLabel = new Map(listings.map((l) => [l.id, l.label || l.prefix || 'Listing']));
// Rooms as the booking model groups them (each room's listings), else one room per listing.
let rooms = [];
try { rooms = buildContext().rooms.map((r) => ({ key: r.key, label: r.label || r.key, listingIds: r.listingIds || [] })); } catch (e) { rooms = []; }
const stays = collectStays();
if (!rooms.length) rooms = [...new Set(stays.map((s) => s.listingId))].map((id) => ({ key: id, label: listingLabel.get(id) || id, listingIds: [id] }));
const roomOf = new Map(); rooms.forEach((r) => r.listingIds.forEach((id) => roomOf.set(id, r)));
const roomFor = (listingId) => roomOf.get(listingId) || { key: listingId, label: listingLabel.get(listingId) || 'Other', listingIds: [listingId] };
const channelName = new Map((data.prefs.lettingChannels || []).map((c) => [c.id, c.name || c.id]));
const recOf = new Map();
(data.airbnbReservations || []).forEach((r) => recOf.set(r.id, r));
(data.lettingLedger || []).forEach((e) => recOf.set(`led:${e.id}`, e));
const earnByCode = new Map();
(data.airbnbEarnings || []).forEach((e) => { if (String(e.type).toLowerCase() === 'reservation' && e.confirmationCode && Number(e.amount) > 0) earnByCode.set(e.confirmationCode, e); });
const requests = (data.bookingRequests || []).filter((q) => !q.supersededBy);
const reqByStay = new Map(); const reqByCode = new Map();
requests.forEach((q) => { if (q.reservationId) reqByStay.set(q.reservationId, q); if (q.confirmationCode) reqByCode.set(q.confirmationCode, q); });
return { today, rooms, roomFor, listingLabel, stays, recOf, earnByCode, requests, reqByStay, reqByCode, channelName };
}

// Free nights either side of a stay in its room, on today's calendar, and the void it filled on the day it was booked
// (the free run around its dates, counting only stays already booked by then; undated stays count as known 14 days ahead).
function voidsFor(stay, live, room) {
const ci = dn(stay.checkin); const co = dn(stay.checkout);
const same = live.filter((x) => x !== stay && room.listingIds.includes(x.listingId));
const prevCo = Math.max(-Infinity, ...same.filter((x) => dn(x.checkout) <= ci).map((x) => dn(x.checkout)));
const nextCi = Math.min(Infinity, ...same.filter((x) => dn(x.checkin) >= co).map((x) => dn(x.checkin)));
const before = Number.isFinite(prevCo) ? ci - prevCo : null;
const after = Number.isFinite(nextCi) ? nextCi - co : null;
let filled = null;
if (valid(stay.bookedOn) && stay.bookedOn.slice(0, 10) <= stay.checkin) {
const b = dn(stay.bookedOn);
const known = same.filter((x) => (valid(x.bookedOn) && x.bookedOn.slice(0, 10) <= x.checkin ? dn(x.bookedOn) : dn(x.checkin) - 14) <= b && dn(x.checkout) > b);
const a = Math.max(b, ...known.filter((x) => dn(x.checkout) <= ci).map((x) => dn(x.checkout)));
const z = Math.min(Infinity, ...known.filter((x) => dn(x.checkin) >= co).map((x) => dn(x.checkin)));
filled = Number.isFinite(z) ? z - a : null;
}
return { before, after, filled };
}

const BOOKING_COLS = [
{ header: 'Kind', width: 11 }, { header: 'Status', width: 11 }, { header: 'Room', width: 12 }, { header: 'Listing', width: 22 }, { header: 'Channel', width: 12 },
{ header: 'Guest', width: 20 }, { header: 'Code', width: 12 }, { header: 'Enquiry received', type: 'date', width: 12 }, { header: 'Booked on', type: 'date', width: 12 },
{ header: 'Booking date issue', width: 18 }, { header: 'Check-in', type: 'date', width: 12 }, { header: 'Check-out', type: 'date', width: 12 },
{ header: 'Nights', type: 'int', width: 8 }, { header: 'Fri/Sat nights', type: 'int', width: 9 }, { header: 'Lead (days)', type: 'int', width: 9 },
{ header: 'Guests', type: 'int', width: 8 }, { header: 'Guest rating', type: 'num', width: 9 }, { header: 'Guest reviews', type: 'int', width: 9 }, { header: 'Your review of stay', type: 'num', width: 10 },
{ header: 'Income on record', type: 'money', width: 12 }, { header: 'Airbnb amount received', type: 'money', width: 12 }, { header: 'Cleaning fee charged', type: 'money', width: 11 },
{ header: 'Gross earnings', type: 'money', width: 12 }, { header: 'Per night ex cleaning', type: 'money', width: 12 }, { header: 'Enquiry payout quoted', type: 'money', width: 12 },
{ header: 'Enquiry nightly rate', type: 'money', width: 11 }, { header: 'Enquiry decision', width: 12 },
{ header: 'Free nights before check-in', type: 'int', width: 11 }, { header: 'Free nights after check-out', type: 'int', width: 11 }, { header: 'Void filled when booked (nights)', type: 'int', width: 13 },
{ header: 'Record id', width: 18 },
];

function bookingRows(g) {
const { stays, recOf, earnByCode, roomFor, listingLabel, reqByStay, reqByCode, requests, channelName } = g;
const live = stays.filter((s) => s.status !== 'cancelled');
const used = new Set();
const rows = stays.slice().sort((a, b) => String(a.checkin).localeCompare(String(b.checkin))).map((s) => {
const rec = recOf.get(s.id) || {};
const code = rec.confirmationCode || '';
const q = reqByStay.get(s.id) || (code && reqByCode.get(code)) || null;
if (q) used.add(q.id);
const e = code ? earnByCode.get(code) : null;
const room = roomFor(s.listingId);
const nights = dn(s.checkout) - dn(s.checkin);
const bad = valid(s.bookedOn) && s.bookedOn.slice(0, 10) > s.checkin;
const lead = valid(s.bookedOn) && !bad ? dn(s.checkin) - dn(s.bookedOn) : null;
const long = !!s.longLet || rec.letType === 'long' || (s.platform === 'other' && nights >= 28);
const v = s.status === 'cancelled' ? { before: null, after: null, filled: null } : voidsFor(s, live, room);
const clean = e && e.cleaningFee != null ? Number(e.cleaningFee) : null;
const paid = e ? Number(e.amount) : s.income != null ? Number(s.income) : null;
const perNight = paid != null && nights > 0 ? (paid - (clean || 0)) / nights : null;
const ch = rec.channel || (s.platform === 'other' ? '' : 'airbnb');
return [
s.status === 'cancelled' ? 'Cancelled' : long ? 'Long let' : 'Booking', s.status === 'cancelled' ? 'cancelled' : s.checkout <= g.today ? 'completed' : s.checkin <= g.today ? 'in stay' : 'upcoming',
room.label, listingLabel.get(s.listingId) || '', ch ? channelName.get(ch) || ch : (s.platform === 'other' ? 'Other' : ''),
s.guest || (q && q.guestName) || '', code, q && valid(q.receivedAt) ? q.receivedAt.slice(0, 10) : '', valid(s.bookedOn) ? s.bookedOn.slice(0, 10) : '',
bad ? 'after check-in' : valid(s.bookedOn) ? '' : 'missing', s.checkin, s.checkout, nights, weekendNights(s.checkin, s.checkout), lead,
partySizeOf(s.id) ?? (q && Number(q.guests) > 0 ? Number(q.guests) : null), q ? q.guestRating : null, q ? q.guestReviews : null, Number(rec.reviewRating) > 0 ? Number(rec.reviewRating) : null,
s.income != null ? r2(s.income) : null, e ? r2(e.amount) : null, clean, e && e.grossEarnings != null ? r2(e.grossEarnings) : null, r2(perNight),
q ? r2(q.payout) : null, q ? r2(q.nightlyRate) : null, q ? q.decision || '' : '',
v.before, v.after, v.filled, s.id,
];
});
// Enquiries that never became a stay on record.
requests.filter((q) => !used.has(q.id) && q.checkin && q.checkout).sort((a, b) => String(a.checkin).localeCompare(String(b.checkin))).forEach((q) => {
const room = roomFor(q.listingId);
const nights = dn(q.checkout) - dn(q.checkin);
rows.push([
q.kind === 'inquiry' || q.kind === 'enquiry' ? 'Enquiry' : 'Request', q.decision || (q.checkin < g.today ? 'lapsed' : 'open'), room.label, listingLabel.get(q.listingId) || '', 'Airbnb',
q.guestName || '', q.confirmationCode || '', valid(q.receivedAt) ? q.receivedAt.slice(0, 10) : '', '', '', q.checkin, q.checkout, nights, weekendNights(q.checkin, q.checkout),
valid(q.receivedAt) ? dn(q.checkin) - dn(q.receivedAt) : null, Number(q.guests) > 0 ? Number(q.guests) : null, q.guestRating, q.guestReviews, null,
null, null, null, null, q.payout != null && nights > 0 ? r2(q.payout / nights) : null, r2(q.payout), r2(q.nightlyRate), q.decision || '', null, null, null, q.id,
]);
});
return rows;
}

function monthlySheet(g, proj) {
const { stays, rooms, roomFor, requests, today } = g;
const live = stays.filter((s) => s.status !== 'cancelled' && valid(s.checkin) && valid(s.checkout));
const first = live.reduce((m, s) => (s.checkin < m ? s.checkin : m), today).slice(0, 7);
const projMonths = proj ? Object.keys(proj.months || {}).sort() : [];
const last = [ymOf(today), ...projMonths].sort().pop();
const months = []; for (let ym = first; ym <= last; ym = addMonth(ym, 1)) months.push(ym);
const idx = new Map(months.map((m, i) => [m, i]));
const per = rooms.map(() => months.map(() => ({ nights: 0, income: 0 })));
const rIdx = new Map(rooms.map((r, i) => [r.key, i]));
live.forEach((s) => {
const ri = rIdx.get(roomFor(s.listingId).key); if (ri == null) return;
const n0 = dn(s.checkin); const n1 = dn(s.checkout); const perN = s.income != null && n1 > n0 ? Number(s.income) / (n1 - n0) : 0;
for (let n = n0; n < n1; n++) { const i = idx.get(ymOf(ds(n))); if (i == null) continue; per[ri][i].nights++; per[ri][i].income += perN; }
});
const made = months.map(() => []); const lens = months.map(() => []);
live.forEach((s) => {
if (valid(s.bookedOn) && s.bookedOn.slice(0, 10) <= s.checkin) { const i = idx.get(ymOf(s.bookedOn)); if (i != null) made[i].push(dn(s.checkin) - dn(s.bookedOn)); }
const j = idx.get(ymOf(s.checkin)); if (j != null) lens[j].push(dn(s.checkout) - dn(s.checkin));
});
const enq = months.map(() => 0);
requests.forEach((q) => { if (valid(q.receivedAt)) { const i = idx.get(ymOf(q.receivedAt)); if (i != null) enq[i]++; } });
const columns = [{ header: 'Month', width: 9 }];
rooms.forEach((r) => columns.push({ header: `${r.label} nights`, type: 'int' }, { header: `${r.label} income`, type: 'money', width: 12 }, { header: `${r.label} occupancy`, type: 'pct' }));
columns.push({ header: 'All nights', type: 'int' }, { header: 'All income', type: 'money', width: 12 }, { header: 'All occupancy', type: 'pct' }, { header: 'Average per night', type: 'money', width: 11 },
{ header: 'Bookings made', type: 'int' }, { header: 'Enquiries received', type: 'int' }, { header: 'Average lead (days)', type: 'num' }, { header: 'Average stay (nights)', type: 'num' },
{ header: 'Forecast new nights', type: 'num' }, { header: 'Forecast new income', type: 'money', width: 12 }, { header: 'On books + forecast nights', type: 'num' });
const rows = months.map((ym, i) => {
const days = daysIn(ym);
const row = [ym];
let N = 0; let I = 0;
rooms.forEach((_, ri) => { const c = per[ri][i]; row.push(c.nights, r2(c.income), c.nights / days); N += c.nights; I += c.income; });
const pm = proj && proj.months ? proj.months[ym] : null;
const future = ym >= ymOf(today);
row.push(N, r2(I), rooms.length ? N / (days * rooms.length) : null, N ? r2(I / N) : null, made[i].length, enq[i], r2(mean(made[i])), r2(mean(lens[i])),
pm ? r2(pm.nights) : null, pm ? r2(pm.income) : null, future && pm ? r2(N + pm.nights) : null);
return row;
});
return { name: 'Monthly', columns, rows, months };
}

function forecastSheets(proj, rooms) {
if (!proj) return [];
const ms = Object.keys(proj.months || {}).sort();
const columns = [{ header: 'Month', width: 9 }];
rooms.forEach((r) => columns.push({ header: `${r.label} expected new nights`, type: 'num' }, { header: `${r.label} expected new income`, type: 'money', width: 13 }));
columns.push({ header: 'All expected new nights', type: 'num' }, { header: 'All expected new income', type: 'money', width: 13 });
const rows = ms.map((ym) => { const m = proj.months[ym]; const row = [ym]; rooms.forEach((r) => { const x = (m.rooms || {})[r.key] || {}; row.push(r2(x.nights), r2(x.income)); }); row.push(r2(m.nights), r2(m.income)); return row; });
const vcols = [{ header: 'Room', width: 12 }, { header: 'Free from', type: 'date', width: 12 }, { header: 'Free to', type: 'date', width: 12 }, { header: 'Free nights', type: 'int' },
{ header: 'Expected nights booked', type: 'num' }, { header: 'Expected income', type: 'money', width: 12 }, { header: 'Income p10', type: 'money', width: 11 }, { header: 'Income p90', type: 'money', width: 11 }];
const vrows = (proj.voids || []).slice().sort((a, b) => String(a.from).localeCompare(String(b.from))).map((v) => [v.roomLabel || v.roomKey, v.from, v.to, v.nights, r2(v.expectedNights), r2(v.expected), r2(v.p10), r2(v.p90)]);
return [{ name: 'Forecast by month', columns, rows }, { name: 'Forecast voids', columns: vcols, rows: vrows }];
}

function exportBookingsXlsx() {
const g = gather();
const proj = latestProjection();
const bookings = { name: 'Bookings & enquiries', columns: BOOKING_COLS, rows: bookingRows(g) };
const monthly = monthlySheet(g, proj);
const fc = forecastSheets(proj, g.rooms);
const last = monthly.rows.length; // data rows 1..last
const roomCols = (k) => g.rooms.map((_, i) => 1 + i * 3 + k);
const base = 1 + g.rooms.length * 3;
const W = 9; const H = 18;
const charts = [
{ kind: 'column', stacked: true, title: 'Nights booked by month', yTitle: 'Nights', from: { sheet: 'Monthly', catCol: 0, r0: 1, r1: last, cols: roomCols(0) }, at: { col: 0, row: 0, w: W, h: H } },
{ kind: 'column', stacked: true, title: 'Income by month (spread over the nights)', yTitle: '£', yFormat: '"£"#,##0', from: { sheet: 'Monthly', catCol: 0, r0: 1, r1: last, cols: roomCols(1) }, at: { col: W + 1, row: 0, w: W, h: H } },
{ kind: 'line', title: 'Occupancy by room', yFormat: '0%', from: { sheet: 'Monthly', catCol: 0, r0: 1, r1: last, cols: roomCols(2) }, at: { col: 0, row: H + 1, w: W, h: H } },
{ kind: 'column', title: 'Enquiries received and bookings made', from: { sheet: 'Monthly', catCol: 0, r0: 1, r1: last, cols: [base + 5, base + 4] }, at: { col: W + 1, row: H + 1, w: W, h: H } },
{ kind: 'line', title: 'Average lead time and stay length', from: { sheet: 'Monthly', catCol: 0, r0: 1, r1: last, cols: [base + 6, base + 7] }, at: { col: 0, row: 2 * (H + 1), w: W, h: H } },
];
if (proj) charts.push({ kind: 'column', stacked: true, title: 'Nights: on the books and forecast new', yTitle: 'Nights', from: { sheet: 'Monthly', catCol: 0, r0: 1, r1: last, cols: [base, base + 8] }, at: { col: W + 1, row: 2 * (H + 1), w: W, h: H } });
const about = {
name: 'About', freeze: false, filter: false,
columns: [{ header: 'Item', width: 34 }, { header: 'Value', width: 70 }],
rows: [
['Exported', `${todayStr()} (build ${(document.getElementById('build-stamp') || {}).textContent || ''})`],
['Bookings and stays', String(g.stays.length)], ['Enquiries on record', String(g.requests.length)],
['Income on record', 'What the stay or income entry holds (Airbnb: your payout).'],
['Airbnb amount received / cleaning / gross', 'From the Airbnb earnings export row with the same booking code.'],
['Booking date issue', '"after check-in": the date on record is later than the stay began, so it is when the entry was typed, not when it was booked. Fix it under Bookings with data gaps on the occupancy page.'],
['Void filled when booked', 'The free run of nights around the stay on the day it was booked, counting only stays already booked then (undated ones as known 14 days ahead). Blank: no booking date, or no later stay yet.'],
['Monthly income', 'Each stay\'s income spread evenly over its nights.'],
['Forecast', proj ? `The booking model's saved projection made ${String(proj.madeAt || proj.today).slice(0, 10)} (model v${proj.modelVersion}, ${proj.runs} simulated runs), ${proj.from} to ${proj.to}: expected £${Math.round(proj.total.expected)}, 1 in 10 below £${Math.round(proj.total.p10)}, 1 in 10 above £${Math.round(proj.total.p90)}. New bookings only, on top of the nights already on the books.` : 'No saved projection: run one from the occupancy page and export again.'],
],
};
const sheets = [{ name: 'Charts', freeze: false, filter: false, columns: [], rows: [], charts }, bookings, monthly, ...fc, about];
delete monthly.months;
const blob = buildXlsx(sheets);
const a = document.createElement('a');
a.href = URL.createObjectURL(blob);
a.download = `bookings-${todayStr()}.xlsx`;
document.body.appendChild(a); a.click(); a.remove();
setTimeout(() => URL.revokeObjectURL(a.href), 5000);
return { bookings: bookings.rows.length, months: monthly.rows.length, forecast: !!proj };
}

export { exportBookingsXlsx, bookingRows, gather };
