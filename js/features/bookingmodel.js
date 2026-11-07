// The booking evaluator's engine: should this booking request be accepted?
//
// It compares two futures over a window of nights around the request:
//   accept: the request's payout (allowing for it being cancelled, late or early), plus
//           whatever bookings still arrive for the nights left free either side of it;
//   reject: whatever bookings arrive for the whole free window.
// Both count cleaning (a day's clean shared between the rooms turned over that day),
// changeover hassle, and what an empty night is worth to you (a second room empty the same
// night counts for less). Future bookings are simulated: booking requests arrive for each
// check-in date at a rate calibrated so that an empty calendar fills to the occupancy your
// rooms actually achieved in that month, with your lead times, stay lengths and weekday mix
// (each blended with a starting assumption from Settings -> Booking evaluator). Every run
// uses the same random arrivals for accept and reject, so the difference between them is
// stable even when each total is uncertain.
//
// The simulated host accepts each simulated request by a fixed rule (it fits, meets the
// minimum stay or exactly fills a gap, and leaves no gap shorter than the minimum stay unless
// it arrives within 7 days). No simulated request gets its own accept/reject analysis, so the
// cost is linear in the window length. The rule is simpler than your judgement, so the
// reject future is slightly undervalued: a mild lean towards accepting.
//
// Pure: no DOM. evaluate() takes a context (buildContext() reads the live data; selfTest()
// builds made-up ones).
import { data, DEFAULT_PREFS } from '../state.js';
import { todayStr } from '../utils.js';
import { collectStays } from './lettingoccupancy.js';
import { evaluatorRooms, roomSettings } from './bookingsettings.js';

const MODEL_VERSION = 1;
const DAY_MS = 86400000;
const LEAD_SIGMA = 0.9; // spread of the lead-time curve (log scale); fixed
const LOS_MAX = 28;
const LOS_PRIOR = [0, 0.12, 0.24, 0.2, 0.13, 0.09, 0.06, 0.06]; // 1..7 nights; the rest spread over 8..28
const LOS_PRIOR_LONG = 0.1;
const LOS_PRIOR_K = 10; // pseudo-stays behind the stay-length assumption
const DOW_PRIOR_K = 3; // pseudo check-ins per weekday
const LEAD_PRIOR_K = 8; // pseudo-bookings behind each month's lead-time assumption
const CANCEL_PRIOR = { rate: 0.08, k: 10, late: 0.3, lateK: 3 };
const OCC_PRIOR = 0.6;
const DEFAULT_PRICE = 80;
const BEFORE = 28; // nights simulated before the window, so a stay can run into it
const AFTER = 28; // and after it, so a stay can run out of it
const RUNS = 1500;
const CAL_RUNS = 150;

// ---- Dates as day numbers ------------------------------------------------------------------
const dayNum = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) / DAY_MS; };
const dayStr = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const dowOf = (n) => new Date(n * DAY_MS).getUTCDay(); // 0 Sun .. 6 Sat
const monthOf = (n) => new Date(n * DAY_MS).getUTCMonth(); // 0..11
const weekendNight = (n) => { const d = dowOf(n); return d === 5 || d === 6; }; // Fri, Sat nights
const weekendDay = (n) => { const d = dowOf(n); return d === 0 || d === 6; }; // Sat, Sun changeovers
const isChristmas = (n) => { const s = dayStr(n).slice(5); return s >= '12-20' || s <= '01-02'; };

// ---- Random numbers -------------------------------------------------------------------------
function mulberry32(seed) {
let a = seed >>> 0;
return () => {
a = (a + 0x6D2B79F5) | 0;
let t = Math.imul(a ^ (a >>> 15), 1 | a);
t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
}
function hashStr(s) {
let h = 2166136261;
for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
return h >>> 0;
}
function poisson(rng, lam) {
if (!(lam > 0)) return 0;
if (lam > 30) return Math.max(0, Math.round(lam + Math.sqrt(lam) * normInv(rng())));
const L = Math.exp(-lam);
let k = 0; let p = 1;
do { k++; p *= rng(); } while (p > L);
return k - 1;
}
function normCdf(x) {
const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}
// Acklam's inverse normal.
function normInv(p) {
const pp = Math.min(Math.max(p, 1e-12), 1 - 1e-12);
const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
const lo = 0.02425;
if (pp < lo) { const q = Math.sqrt(-2 * Math.log(pp)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
if (pp > 1 - lo) { const q = Math.sqrt(-2 * Math.log(1 - pp)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
const q = pp - 0.5; const r = q * q;
return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
const median = (xs) => { if (!xs.length) return null; const s = xs.slice().sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (xs, p) => { if (!xs.length) return 0; const s = xs.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]; };

// ---- Context: everything the model reads ------------------------------------------------------

// From the live data. `overrides.settings` replaces individual settings for one evaluation
// (the workbench's "try a different assumption").
function buildContext({ today = todayStr(), overrides = {} } = {}) {
const s = { ...DEFAULT_PREFS.bookingEvaluator, ...(data.prefs.bookingEvaluator || {}), ...(overrides.settings || {}) };
const firstClean = Number.isFinite(Number(overrides.firstClean)) ? Number(overrides.firstClean) : (Number.isFinite(Number(data.prefs.airbnbCleaningCost)) ? Number(data.prefs.airbnbCleaningCost) : 50);
const rooms = evaluatorRooms().map((room) => ({ key: room.key, label: room.label, listingIds: room.listingIds, ...roomSettings(room.key), ...((overrides.rooms || {})[room.key] || {}) })).filter((r) => r.include !== false);
const stays = collectStays().map((x) => ({ id: x.id, listingId: x.listingId, checkin: x.checkin, checkout: x.checkout, income: x.income, bookedOn: x.bookedOn, cancelledOn: x.cancelledOn, status: x.status, unconfirmed: !!x.unconfirmed, guest: x.guest || '', platform: x.platform }));
const requests = (data.bookingRequests || []).map((q) => ({ ...q }));
const proposals = (data.airbnbRateProposals || []).map((p) => ({ listingId: p.listingId, startDate: p.startDate, endDate: p.endDate, upliftPct: p.upliftPct, upliftAmount: p.upliftAmount, reason: p.reason }));
const listingLabels = Object.fromEntries((data.airbnbListings || []).map((l) => [l.id, l.label || 'Listing']));
return { today, s, firstClean, rooms, stays, requests, proposals, listingLabels, scale: overrides.scale || {} };
}

// ---- Calibration ----------------------------------------------------------------------------

function roomIndexOf(ctx) {
const m = new Map();
ctx.rooms.forEach((r, i) => r.listingIds.forEach((id) => m.set(id, i)));
return m;
}

// What the model assumes, each with where it came from. Cached on the context.
function calibrate(ctx) {
if (ctx.params) return ctx.params;
const { s, today } = ctx;
const T = dayNum(today);
const ri = roomIndexOf(ctx);
const since = T - 730;
const live = ctx.stays.filter((x) => x.status === 'stay' && !x.unconfirmed && ri.has(x.listingId));
const fromRequest = new Set(ctx.requests.map((q) => q.reservationId).filter(Boolean));

// Nightly payout by room (and by month of the year when there are 3+ stays in it).
const perNight = ctx.rooms.map(() => ({ all: [], byMonth: Array.from({ length: 12 }, () => []) }));
live.forEach((x) => {
const n = dayNum(x.checkout) - dayNum(x.checkin);
if (!(Number(x.income) > 0) || n <= 0 || dayNum(x.checkin) < since) return;
const p = perNight[ri.get(x.listingId)];
const v = Number(x.income) / n;
p.all.push(v);
p.byMonth[monthOf(dayNum(x.checkin))].push(v);
});
const everyone = perNight.flatMap((p) => p.all);
const prices = ctx.rooms.map((room, i) => {
const p = perNight[i];
const overall = median(p.all);
const fallback = overall ?? median(everyone);
const base = fallback ?? DEFAULT_PRICE;
return {
weekday: room.priceWeekday != null ? Number(room.priceWeekday) : null,
weekend: room.priceWeekend != null ? Number(room.priceWeekend) : null,
byMonth: p.byMonth.map((xs) => (xs.length >= 3 ? median(xs) : null)),
base,
source: room.priceWeekday != null || room.priceWeekend != null ? 'your setting' : overall != null ? `your stays (${p.all.length})` : everyone.length ? `other rooms' stays (${everyone.length})` : 'assumption',
};
});

// Stay length: requests (an enquiry at its weight), plus stays that didn't come from one.
const losCount = new Array(LOS_MAX + 1).fill(0);
let losN = 0;
const addLos = (n, w) => { if (n >= 1) { losCount[Math.min(n, LOS_MAX)] += w; losN += w; } };
ctx.requests.forEach((q) => { if (q.checkin && q.checkout) addLos(dayNum(q.checkout) - dayNum(q.checkin), q.kind === 'enquiry' ? s.enquiryWeight : 1); });
live.forEach((x) => { if (!fromRequest.has(x.id) && dayNum(x.checkin) >= since) addLos(dayNum(x.checkout) - dayNum(x.checkin), 1); });
const losPrior = new Array(LOS_MAX + 1).fill(0);
LOS_PRIOR.forEach((v, i) => { losPrior[i] = v; });
for (let i = 8; i <= LOS_MAX; i++) losPrior[i] = LOS_PRIOR_LONG / (LOS_MAX - 7);
const losW = losCount.map((c, i) => c + LOS_PRIOR_K * losPrior[i]);
const losTotal = losW.reduce((a, b) => a + b, 0);
const losCdf = [];
losW.reduce((acc, w, i) => { losCdf[i] = (acc + w) / losTotal; return acc + w; }, 0);
const losMean = losW.reduce((a, w, i) => a + w * i, 0) / losTotal;

// Check-in weekday mix.
const dowCount = new Array(7).fill(0);
let dowN = 0;
ctx.requests.forEach((q) => { if (q.checkin) { dowCount[dowOf(dayNum(q.checkin))] += q.kind === 'enquiry' ? s.enquiryWeight : 1; dowN += q.kind === 'enquiry' ? s.enquiryWeight : 1; } });
live.forEach((x) => { if (!fromRequest.has(x.id) && dayNum(x.checkin) >= since) { dowCount[dowOf(dayNum(x.checkin))] += 1; dowN += 1; } });
const dowRaw = dowCount.map((c) => c + DOW_PRIOR_K);
const dowMean = dowRaw.reduce((a, b) => a + b, 0) / 7;
const dowW = dowRaw.map((v) => v / dowMean);

// Lead time, by the month of the stay (Christmas on its own).
const leads = Array.from({ length: 13 }, () => []); // 12 = Christmas
const addLead = (checkin, from) => {
if (!checkin || !from) return;
const c = dayNum(checkin);
const L = c - dayNum(String(from).slice(0, 10));
if (L < 0 || L > 400) return;
leads[isChristmas(c) ? 12 : monthOf(c)].push(Math.max(L, 0.5));
};
ctx.requests.forEach((q) => { if (q.kind === 'request') addLead(q.checkin, q.receivedAt); });
live.forEach((x) => { if (!fromRequest.has(x.id)) addLead(x.checkin, x.bookedOn); });
const lead = leads.map((xs, m) => {
const prior = m === 12 ? Number(s.christmasLead) || 300 : Number((s.leadMedian || [])[m]) || 21;
const scaled = prior * (ctx.scale.lead || 1);
const mu = (LEAD_PRIOR_K * Math.log(scaled) + xs.reduce((a, L) => a + Math.log(L * (ctx.scale.lead || 1)), 0)) / (LEAD_PRIOR_K + xs.length);
return { mu, median: Math.exp(mu), n: xs.length, prior: scaled };
});

// Cancellations: how often, and how many come within the late window.
let nAll = 0; let nCancel = 0; let nLate = 0; let nTimed = 0;
ctx.stays.forEach((x) => {
if (!ri.has(x.listingId) || dayNum(x.checkin) < since || dayNum(x.checkin) >= T) return;
nAll++;
if (x.status !== 'cancelled') return;
nCancel++;
if (x.cancelledOn) { nTimed++; if (dayNum(x.checkin) - dayNum(x.cancelledOn) <= s.lateCancelDays) nLate++; }
});
const cancelRate = Math.min(0.9, ((nCancel + CANCEL_PRIOR.k * CANCEL_PRIOR.rate) / (nAll + CANCEL_PRIOR.k)) * (ctx.scale.cancel || 1));
const lateShare = (nLate + CANCEL_PRIOR.lateK * CANCEL_PRIOR.late) / (nTimed + CANCEL_PRIOR.lateK);

// Occupancy each room achieved, by month of the year (completed months since its first stay).
const occ = ctx.rooms.map((room, i) => {
const mine = live.filter((x) => ri.get(x.listingId) === i);
if (!mine.length) return { byMonth: new Array(12).fill(null), overall: null };
const first = Math.min(...mine.map((x) => dayNum(x.checkin)));
const nights = new Set();
mine.forEach((x) => { for (let d = dayNum(x.checkin); d < dayNum(x.checkout); d++) nights.add(d); });
const sums = Array.from({ length: 12 }, () => []);
const curMonthStart = dayNum(`${today.slice(0, 7)}-01`);
let d0 = dayNum(`${dayStr(Math.max(first, T - 730)).slice(0, 7)}-01`);
const all = [];
while (d0 < curMonthStart) {
const dt = new Date(d0 * DAY_MS);
const next = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 1) / DAY_MS;
let k = 0;
for (let d = d0; d < next; d++) if (nights.has(d)) k++;
const share = k / (next - d0);
sums[dt.getUTCMonth()].push(share);
all.push(share);
d0 = next;
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
return { byMonth: sums.map(mean), overall: mean(all), months: all.length };
});

ctx.params = { prices, losCdf, losMean, losN, dowW, dowN, lead, cancelRate, lateShare, nAll, nCancel, occ, lambda: new Map() };
return ctx.params;
}

function leadFor(params, c) {
return params.lead[isChristmas(c) ? 12 : monthOf(c)];
}
// Share of a check-in date's eventual requests that arrive no more than `daysLeft` ahead.
function leadCdf(params, c, daysLeft) {
if (daysLeft < 0) return 0;
const { mu } = leadFor(params, c);
return normCdf((Math.log(daysLeft + 0.5) - mu) / LEAD_SIGMA);
}
// A lead time from the curve, no longer than `daysLeft`.
function sampleLead(params, c, daysLeft, rng) {
const { mu } = leadFor(params, c);
const cap = daysLeft == null ? 1 : normCdf((Math.log(daysLeft + 0.5) - mu) / LEAD_SIGMA);
const L = Math.exp(mu + LEAD_SIGMA * normInv(rng() * cap));
return daysLeft == null ? L : Math.min(L, daysLeft);
}
function sampleLos(params, rng) {
const u = rng();
for (let i = 1; i <= LOS_MAX; i++) if (u <= params.losCdf[i]) return i;
return LOS_MAX;
}

// The payout a night would earn, before discounts: your setting, else what the room has
// earned in that month of the year, else overall; plus any event uplift on the date.
function basePrice(ctx, params, roomIdx, n) {
const p = params.prices[roomIdx];
const set = weekendNight(n) ? (p.weekend ?? p.weekday) : p.weekday;
let v = set ?? p.byMonth[monthOf(n)] ?? p.base;
const room = ctx.rooms[roomIdx];
const day = dayStr(n);
ctx.proposals.forEach((pr) => {
if (!room.listingIds.includes(pr.listingId) || !pr.startDate || day < pr.startDate || day > (pr.endDate || pr.startDate)) return;
if (Number.isFinite(Number(pr.upliftPct)) && pr.upliftPct != null) v *= 1 + Number(pr.upliftPct) / 100;
else if (Number.isFinite(Number(pr.upliftAmount)) && pr.upliftAmount != null) v += Number(pr.upliftAmount);
});
return v;
}
function lastMinutePct(s, daysAhead) {
let best = 0;
(s.lastMinute || []).forEach((st) => { if (Number(st.days) > 0 && daysAhead <= Number(st.days)) best = Math.max(best, Number(st.pct) || 0); });
return best / 100;
}
function maxBoost(s) {
const lm = Math.max(0, ...(s.lastMinute || []).map((st) => (Number(st.days) > 0 ? Number(st.pct) || 0 : 0))) / 100;
const gap = (Number(s.gapDiscountPct) || 0) / 100;
return Math.pow((1 - lm) * (1 - gap), -(Number(s.elasticity) || 0));
}

// ---- One simulated future -------------------------------------------------------------------

// Request arrivals for every room and check-in date in [from, to), all arriving on or after
// `todayN` (those that arrived before today already did whatever they did). `lam(roomIdx, c)`
// is the eventual number of requests for check-in date c, before price thinning.
function drawArrivals(ctx, params, { from, to, todayN, lam, rooms }, rng) {
const out = [];
const boost = maxBoost(ctx.s);
rooms.forEach((ri) => {
for (let c = Math.max(from, todayN); c < to; c++) {
const daysLeft = todayN == null ? null : c - todayN;
const share = daysLeft == null ? 1 : leadCdf(params, c, daysLeft);
const k = poisson(rng, lam(ri, c) * params.dowW[dowOf(c)] * boost * share);
for (let j = 0; j < k; j++) {
const L = sampleLead(params, c, daysLeft, rng);
out.push({ room: ri, c, los: sampleLos(params, rng), at: c - L, lead: L, u: rng(), tie: rng() });
}
}
});
out.sort((a, b) => a.at - b.at || a.tie - b.tie);
return out;
}

// Plays the arrivals into one room calendar set. occ[ri] is a Uint8Array over [base, base+len)
// (1 = taken). `block` (optional): the request, {room, ci, co, until}: its nights count as taken
// for arrivals before `until` and are freed from then on (a cancellation). Returns the bookings.
function playArrivals(ctx, params, arrivals, occ, base, { block = null, minNights, len }) {
const s = ctx.s;
const eps = Number(s.elasticity) || 0;
const boost = maxBoost(s);
const gapPct = (Number(s.gapDiscountPct) || 0) / 100;
const gapMax = Number(s.gapMaxNights) || 0;

const booked = [];
let blocked = !!block;
if (block) for (let d = block.ci; d < block.co; d++) occ[block.room][d - base] = 1;
for (const a of arrivals) {
if (blocked && a.at >= block.until) {
for (let d = block.ci; d < block.co; d++) occ[block.room][d - base] = 0;
blocked = false;
}
const o = occ[a.room];
const i0 = a.c - base;
const i1 = i0 + a.los;
if (i0 < 0) continue;
let free = true;
for (let i = i0; i < Math.min(i1, len); i++) if (o[i]) { free = false; break; }
if (!free) continue;
let gs = i0; while (gs > 0 && !o[gs - 1]) gs--;
let ge = i1; while (ge < len && !o[ge]) ge++;
const boundedL = gs > 0;
const boundedR = ge < len;
const exactFill = i0 === gs && i1 === ge && boundedL && boundedR;
const min = minNights[a.room] || 1;
if (a.los < min && !exactFill) continue;
const before = i0 - gs;
const after = ge - i1;
const orphan = (boundedL && before > 0 && before < min) || (boundedR && after > 0 && after < min);
if (orphan && a.lead > 7) continue;
const inGap = boundedL && boundedR && ge - gs <= gapMax;
const factor = (1 - lastMinutePct(s, a.lead)) * (inGap ? 1 - gapPct : 1);
if (a.u > Math.pow(factor, -eps) / boost) continue; // the guest doesn't take it at this price
for (let i = i0; i < i1 && i < len; i++) o[i] = 1;
booked.push({ room: a.room, ci: a.c, co: a.c + a.los, factor, at: a.at, lead: a.lead });
}
if (blocked) for (let d = block.ci; d < block.co; d++) occ[block.room][d - base] = 1;
return booked;
}

// The rate of requests per check-in date that makes an empty calendar for this room fill to
// the occupancy it achieved in that month of the year. Bisection over simulated months.
function lambdaFor(ctx, params, ri, month) {
const key = `${ri}|${month}`;
if (params.lambda.has(key)) return params.lambda.get(key);
const o = params.occ[ri];
const target = Math.min(0.97, Math.max(0.02, (o.byMonth[month] ?? o.overall ?? OCC_PRIOR) * (ctx.scale.demand || 1)));
// A synthetic month: 30 nights of this month (any year), 28 before it, all arrivals seen.
const y = 2030;
const start = Date.UTC(y, month, 1) / DAY_MS;
const base = start - BEFORE;
const len = BEFORE + 30 + AFTER;
const minNights = { [ri]: Number(ctx.rooms[ri].minNights) || 1 };
const occupancyAt = (lam) => {
const rng = mulberry32(hashStr(`cal|${key}|${lam.toFixed(4)}`));
let filled = 0;
for (let r = 0; r < (ctx.calRuns || CAL_RUNS); r++) {
const occ = []; occ[ri] = new Uint8Array(len);
const arr = drawArrivals(ctx, params, { from: base, to: base + len, todayN: null, lam: () => lam, rooms: [ri] }, rng);
playArrivals(ctx, params, arr, occ, base, { minNights, len });
for (let i = BEFORE; i < BEFORE + 30; i++) filled += occ[ri][i];
}
return filled / ((ctx.calRuns || CAL_RUNS) * 30);
};
let lo = 0; let hi = 4;
if (occupancyAt(hi) < target) { params.lambda.set(key, hi); return hi; }
for (let it = 0; it < 12; it++) {
const mid = (lo + hi) / 2;
if (occupancyAt(mid) < target) lo = mid; else hi = mid;
}
const lam = (lo + hi) / 2;
params.lambda.set(key, lam);
return lam;
}

// ---- Evaluate one request -------------------------------------------------------------------

// request: {listingId, checkin, checkout, payout, platform, guestReviews, guestRating, reservationId}
function evaluate(request, ctx = buildContext(), { runs = RUNS } = {}) {
const params = calibrate(ctx);
const s = ctx.s;
const T = dayNum(ctx.today);
const ri = roomIndexOf(ctx).get(request.listingId);
if (ri == null) return { error: 'That listing is not one of the rooms the evaluator looks at (Settings, Booking evaluator, Rooms).' };
const ci = dayNum(request.checkin);
const co = dayNum(request.checkout);
if (!(co > ci)) return { error: 'Check-out must be after check-in.' };
if (ci < T) return { error: 'That check-in has already passed.' };
const payout = Number(request.payout);
if (!(payout > 0)) return { error: 'Enter the payout for the stay.' };
const room = ctx.rooms[ri];

// Window: two weeks either side of the request, at least 30 nights, never before today.
const wS = Math.max(T, ci - 14);
const wE = Math.max(wS + 30, co + 14);
const base = Math.max(T - 1, wS - BEFORE); // the night before today counts as taken
const len = wE + AFTER - base;

// Calendars as they stand: live stays (not this request's own, not unconfirmed holds).
const existing = ctx.stays.filter((x) => x.status === 'stay' && !x.unconfirmed && x.id !== request.reservationId && roomIndexOf(ctx).has(x.listingId));
const occ0 = ctx.rooms.map(() => new Uint8Array(len));
const ri2 = roomIndexOf(ctx);
existing.forEach((x) => {
const r = ri2.get(x.listingId);
for (let d = dayNum(x.checkin); d < dayNum(x.checkout); d++) if (d >= base && d < base + len) occ0[r][d - base] = 1;
});
for (let d = base; d < T; d++) occ0.forEach((o) => { o[d - base] = 1; }); // the past can't be booked
const clash = [];
for (let d = ci; d < co; d++) if (occ0[ri][d - base]) clash.push(dayStr(d));
if (clash.length) return { error: `Those dates overlap a booking already in that room (${clash[0]}).` };

// The request's value, and its cancellation outcomes.
const reviews = request.guestReviews == null || request.guestReviews === '' ? null : Number(request.guestReviews);
const rating = request.guestRating == null || request.guestRating === '' ? null : Number(request.guestRating);
let guestFactor = 1; let guestWhy = 'reviewed guest';
if (reviews === 0) { guestFactor = Number(s.guestNoReviews); guestWhy = 'no reviews yet'; }
if (rating != null && rating < Number(s.lowRatingBelow)) { guestFactor = Number(s.guestLowRating); guestWhy = `rated ${rating}`; }
const channelFactor = request.platform === 'other' ? Number(s.directWeight) : 1;
const weighted = payout * guestFactor * channelFactor;
const latePay = (Number(s.lateCancelPayPct) || 0) / 100;
const lateDays = Number(s.lateCancelDays) || 0;
const earlyPossible = ci - lateDays > T;
const pC = params.cancelRate;
const qL = earlyPossible ? params.lateShare : 1;
const wNone = 1 - pC; const wLate = pC * qL; const wEarly = pC * (1 - qL);
const tLate = Math.max(T, ci - Math.ceil(lateDays / 2));
const tEarly = earlyPossible ? T + Math.floor((ci - lateDays - T) / 2) : Infinity;

// Request rates per room and check-in date.
const lamCache = new Map();
const lam = (r, c) => { const k = `${r}|${monthOf(c)}`; if (!lamCache.has(k)) lamCache.set(k, lambdaFor(ctx, params, r, monthOf(c))); return lamCache.get(k); };
const roomsIdx = ctx.rooms.map((_, i) => i);
const minNights = Object.fromEntries(ctx.rooms.map((r, i) => [i, Number(r.minNights) || 1]));

// What existing stays earn inside the window (same in both futures).
let existingIncome = 0;
existing.forEach((x) => {
const n = dayNum(x.checkout) - dayNum(x.checkin);
const r = ri2.get(x.listingId);
for (let d = Math.max(dayNum(x.checkin), wS); d < Math.min(dayNum(x.checkout), wE); d++) {
existingIncome += Number(x.income) > 0 ? Number(x.income) / n : basePrice(ctx, params, r, d);
}
});
const existingCheckouts = existing.map((x) => ({ room: ri2.get(x.listingId), co: dayNum(x.checkout) }));

const firstClean = ctx.firstClean;
const extraClean = Number(s.cleanExtra);
const ownUseOf = (r, n) => (weekendNight(n) ? Number(s.ownUseWeekend) : Number(s.ownUseWeekday)) * (Number(ctx.rooms[r].weight) || 1) * (ctx.scale.ownUse ?? 1);
const secondPct = (Number(s.ownUseSecondPct) || 0) / 100;

// Totals for one future: bookings (simulated), plus the request if it stays booked.
const tally = (occ, booked, reqState) => {
const t = { before: 0, inside: 0, after: 0, other: 0, request: 0, clean: 0, hassle: 0, ownUse: 0, nightsTaken: [] };
booked.forEach((b) => {
for (let d = Math.max(b.ci, wS); d < Math.min(b.co, wE); d++) {
const v = basePrice(ctx, params, b.room, d) * b.factor;
if (b.room !== ri) t.other += v;
else if (d < ci) t.before += v;
else if (d >= co) t.after += v;
else t.inside += v;
}
});
if (reqState === 'none') t.request = weighted;
else if (reqState === 'late') t.request = weighted * latePay;
const outs = new Map();
const addOut = (n, r) => { if (n >= wS && n < wE) { if (!outs.has(n)) outs.set(n, new Set()); outs.get(n).add(r); } };
existingCheckouts.forEach((x) => addOut(x.co, x.room));
booked.forEach((b) => addOut(b.co, b.room));
if (reqState === 'none') addOut(co, ri);
outs.forEach((set, n) => {
t.clean += firstClean + extraClean * (set.size - 1);
t.hassle += weekendDay(n) ? Number(s.hassleWeekend) : Number(s.hassleWeekday);
});
for (let d = wS; d < wE; d++) {
const empties = [];
roomsIdx.forEach((r) => { if (!occ[r][d - base]) empties.push(ownUseOf(r, d)); });
empties.sort((a, b) => b - a);
empties.forEach((v, k) => { t.ownUse += k === 0 ? v : v * secondPct; });
}
for (let d = wS; d < wE; d++) t.nightsTaken.push(occ[ri][d - base]);
return t;
};
const total = (t) => existingIncome + t.request + t.before + t.inside + t.after + t.other - t.clean - t.hassle + t.ownUse;

const seed = hashStr(`${MODEL_VERSION}|${request.listingId}|${request.checkin}|${request.checkout}|${payout}|${ctx.today}|${JSON.stringify(s)}|${JSON.stringify(ctx.scale)}`);
const rng = mulberry32(seed);
const keys = ['request', 'before', 'inside', 'after', 'other', 'clean', 'hassle', 'ownUse'];
const sumA = Object.fromEntries(keys.map((k) => [k, 0]));
const sumR = Object.fromEntries(keys.map((k) => [k, 0]));
const totA = []; const totR = []; const diffs = [];
const nightA = new Float64Array(wE - wS); const nightR = new Float64Array(wE - wS);
const examples = [];
for (let run = 0; run < runs; run++) {
const arrivals = drawArrivals(ctx, params, { from: base, to: wE + AFTER, todayN: T, lam, rooms: roomsIdx }, rng);
const play = (block) => { const occ = occ0.map((o) => o.slice()); const booked = playArrivals(ctx, params, arrivals, occ, base, { block, minNights, len }); return { occ, booked }; };
const R = play(null);
const A0 = play({ room: ri, ci, co, until: Infinity });
const tR = tally(R.occ, R.booked, 'reject');
const tN = tally(A0.occ, A0.booked, 'none');
let tLt = null; let tEa = null;
if (wLate > 0) { const AL = play({ room: ri, ci, co, until: tLate }); tLt = tally(AL.occ, AL.booked, 'late'); }
if (wEarly > 0) { const AE = play({ room: ri, ci, co, until: tEarly }); tEa = tally(AE.occ, AE.booked, 'early'); }
const mix = (k) => wNone * tN[k] + (tLt ? wLate * tLt[k] : 0) + (tEa ? wEarly * tEa[k] : 0);
keys.forEach((k) => { sumA[k] += mix(k); sumR[k] += tR[k]; });
const a = wNone * total(tN) + (tLt ? wLate * total(tLt) : 0) + (tEa ? wEarly * total(tEa) : 0);
const r = total(tR);
totA.push(a); totR.push(r); diffs.push(a - r);
for (let i = 0; i < wE - wS; i++) {
nightA[i] += wNone * tN.nightsTaken[i] + (tLt ? wLate * tLt.nightsTaken[i] : 0) + (tEa ? wEarly * tEa.nightsTaken[i] : 0);
nightR[i] += tR.nightsTaken[i];
}
if (examples.length < 3) {
const describe = (booked) => booked.filter((b) => b.room === ri && b.co > wS && b.ci < wE).map((b) => ({
checkin: dayStr(b.ci), checkout: dayStr(b.co), nights: b.co - b.ci, arrived: dayStr(Math.max(T, Math.floor(b.at))),
perNight: Math.round(basePrice(ctx, params, ri, b.ci) * b.factor),
}));
examples.push({ reject: describe(R.booked), accept: describe(A0.booked), total: { accept: Math.round(total(tN)), reject: Math.round(r) } });
}
}
const meanA = Object.fromEntries(keys.map((k) => [k, sumA[k] / runs]));
const meanR = Object.fromEntries(keys.map((k) => [k, sumR[k] / runs]));
const accept = totA.reduce((x, y) => x + y, 0) / runs;
const reject = totR.reduce((x, y) => x + y, 0) / runs;
const diff = accept - reject;
// Payout enters the accept total linearly: solve for the payout where accept = reject.
const perPound = guestFactor * channelFactor * (wNone + wLate * latePay);
const breakEven = perPound > 0 ? payout + (reject - accept) / perPound : null;
const margin = 10;
let recommendation = 'DECLINE';
if (diff > margin) recommendation = 'ACCEPT';
else if (breakEven != null && breakEven > payout && breakEven <= payout * 1.5 && diff < -margin) recommendation = 'COUNTER';
else if (Math.abs(diff) <= margin) recommendation = 'EITHER';

// Request nights you'd value having empty.
const ownUseNights = [];
for (let d = ci; d < co; d++) if (weekendNight(d)) ownUseNights.push({ date: dayStr(d), value: Math.round(ownUseOf(ri, d)) });

const nights = [];
for (let i = 0; i < wE - wS; i++) {
const d = wS + i;
nights.push({ date: dayStr(d), weekend: weekendNight(d), existing: !!occ0[ri][d - base], request: d >= ci && d < co, accept: nightA[i] / runs, reject: nightR[i] / runs });
}
return {
modelVersion: MODEL_VERSION,
room: { key: room.key, label: room.label },
window: { start: dayStr(wS), end: dayStr(wE), nights: wE - wS },
request: { checkin: request.checkin, checkout: request.checkout, nights: co - ci, payout, weighted, guestFactor, guestWhy, channelFactor },
cancel: { rate: pC, lateShare: qL, wNone, wLate, wEarly, latePay, earlyPossible },
existingIncome,
accept: { mean: accept, p10: pct(totA, 0.1), p90: pct(totA, 0.9), parts: meanA },
reject: { mean: reject, p10: pct(totR, 0.1), p90: pct(totR, 0.9), parts: meanR },
diff,
pRejectBetter: diffs.filter((x) => x < 0).length / runs,
breakEven,
recommendation,
ownUseNights,
nights,
examples,
neighbours: neighbourStays(ctx, ri, ci, co),
runs,
assumptions: describeAssumptions(ctx, params, ri, ci),
};
}

// The bookings either side of the request in its room (the edges of the free window).
function neighbourStays(ctx, ri, ci, co) {
const mine = ctx.stays.filter((x) => x.status === 'stay' && !x.unconfirmed && ctx.rooms[ri].listingIds.includes(x.listingId));
const before = mine.filter((x) => dayNum(x.checkout) <= ci).sort((a, b) => b.checkout.localeCompare(a.checkout))[0] || null;
const after = mine.filter((x) => dayNum(x.checkin) >= co).sort((a, b) => a.checkin.localeCompare(b.checkin))[0] || null;
return { before: before ? before.id : null, after: after ? after.id : null };
}

// Every figure behind the answer, with where it came from, for the workbench.
function describeAssumptions(ctx, params, ri, ci) {
const s = ctx.s;
const m = monthOf(ci);
const lead = leadFor(params, ci);
const price = params.prices[ri];
const o = params.occ[ri];
const fmtMoney = (v) => `£${Math.round(v)}`;
const occVal = o.byMonth[m] ?? o.overall;
return [
{ id: 'price', label: 'Payout per night, before discounts', value: fmtMoney(basePrice(ctx, params, ri, ci)), source: price.source },
{ id: 'occupancy', label: `Occupancy this room reached in ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m]}`, value: occVal == null ? `${Math.round(OCC_PRIOR * 100)}%` : `${Math.round(occVal * 100)}%`, source: o.byMonth[m] != null ? 'your stays, same month in earlier years' : o.overall != null ? `your stays, all months (${o.months})` : 'assumption', editable: 'demand' },
{ id: 'lead', label: 'Median days ahead bookings arrive', value: `${Math.round(lead.median)} days`, source: lead.n ? `your guide blended with ${lead.n} of your bookings` : 'your guide (Settings)', editable: 'lead' },
{ id: 'los', label: 'Average stay length', value: `${params.losMean.toFixed(1)} nights`, source: params.losN ? `your requests and stays (${Math.round(params.losN)}) blended with an assumption` : 'assumption' },
{ id: 'dow', label: 'Busiest check-in day', value: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][params.dowW.indexOf(Math.max(...params.dowW))], source: params.dowN ? `your requests and stays (${Math.round(params.dowN)})` : 'assumption' },
{ id: 'cancel', label: 'Bookings cancelled', value: `${Math.round(params.cancelRate * 100)}% (${Math.round(params.lateShare * 100)}% of those late)`, source: params.nAll ? `your stays (${params.nCancel} of ${params.nAll}) blended with an assumption` : 'assumption', editable: 'cancel' },
{ id: 'elasticity', label: 'Price sensitivity', value: String(s.elasticity), source: 'assumption (Settings)', editable: 'elasticity' },
{ id: 'ownUse', label: 'Empty night worth to you', value: `£${s.ownUseWeekday} Sun–Thu, £${s.ownUseWeekend} Fri–Sat × ${ctx.rooms[ri].weight || 1}`, source: 'your setting', editable: 'ownUse' },
{ id: 'clean', label: 'Cleaning', value: `£${ctx.firstClean} first room, +£${s.cleanExtra} each extra the same day`, source: 'your setting' },
{ id: 'hassle', label: 'Changeover hassle', value: `£${s.hassleWeekday} Mon–Fri, £${s.hassleWeekend} Sat–Sun`, source: 'your setting' },
{ id: 'minNights', label: 'Minimum stay', value: `${ctx.rooms[ri].minNights || 1} night${(ctx.rooms[ri].minNights || 1) === 1 ? '' : 's'}`, source: 'your setting' },
];
}

// Which assumptions would change the answer. Each re-run is smaller than the main one.
const SENSITIVITY = [
{ label: 'Bookings arrive twice as far ahead', scale: { lead: 2 } },
{ label: 'Bookings arrive half as far ahead', scale: { lead: 0.5 } },
{ label: 'Demand 20% lower', scale: { demand: 0.8 } },
{ label: 'Demand 20% higher', scale: { demand: 1.2 } },
{ label: 'Empty nights worth half as much to you', scale: { ownUse: 0.5 } },
{ label: 'Empty nights worth 50% more to you', scale: { ownUse: 1.5 } },
{ label: 'Twice as many cancellations', scale: { cancel: 2 } },
{ label: 'Price sensitivity halved', settings: (s) => ({ elasticity: (Number(s.elasticity) || 0) / 2 }) },
{ label: 'Price sensitivity doubled', settings: (s) => ({ elasticity: (Number(s.elasticity) || 0) * 2 }) },
];
// Async: yields between re-runs so the page stays responsive. The request rates calibrated for
// the main answer are reused unless the change alters what they were calibrated to (demand or
// price sensitivity).
async function sensitivity(request, baseCtx, baseResult, { runs = 400, onProgress = () => {} } = {}) {
const out = [];
for (const v of SENSITIVITY) {
await new Promise((r) => setTimeout(r, 0));
onProgress(`${out.length + 1} of ${SENSITIVITY.length}: ${v.label}…`);
const ctx = { ...baseCtx, params: undefined, calRuns: 60, scale: { ...(baseCtx.scale || {}), ...(v.scale || {}) }, s: { ...baseCtx.s, ...(v.settings ? v.settings(baseCtx.s) : {}) } };
const recalibrate = (v.scale && v.scale.demand) || v.settings;
if (!recalibrate && baseCtx.params) { calibrate(ctx); ctx.params.lambda = new Map(baseCtx.params.lambda); }
const r = evaluate(request, ctx, { runs });
if (r.error) { out.push({ label: v.label, error: r.error }); continue; }
out.push({ label: v.label, diff: r.diff, recommendation: r.recommendation, flips: (r.recommendation === 'ACCEPT') !== (baseResult.recommendation === 'ACCEPT') });
}
return out;
}

// ---- Self-test: cases with an answer that can be worked out by hand ----------------------------

function testContext({ occupancy, today = '2026-11-01', minNights = 1 }) {
const s = { ...DEFAULT_PREFS.bookingEvaluator, lastMinute: [{ days: 0, pct: 0 }], gapDiscountPct: 0 };
const ctx = {
today, s, firstClean: 50,
rooms: [{ key: 'A', label: 'Room A', listingIds: ['LA'], include: true, weight: 1, minNights, priceWeekday: 100, priceWeekend: 100 }],
stays: [], requests: [], proposals: [], listingLabels: { LA: 'Room A' }, scale: {},
};
calibrate(ctx);
ctx.params.cancelRate = 0;
ctx.params.occ = [{ byMonth: new Array(12).fill(occupancy), overall: occupancy, months: 12 }];
return ctx;
}
function selfTest() {
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });
const req = { listingId: 'LA', checkin: '2026-11-20', checkout: '2026-11-22', payout: 300, platform: 'airbnb', guestReviews: 5 };

// 1. No demand at all: the difference is the payout less one clean, one changeover's hassle
// and the two nights' own-use value, exactly.
const ctx0 = testContext({ occupancy: 0.02 });
ctx0.params.lambda = new Map(Array.from({ length: 12 }, (_, m) => [`0|${m}`, 0]));
const r0 = evaluate(req, ctx0, { runs: 50 });
const s = ctx0.s;
const n1 = dayNum('2026-11-20'); const n2 = n1 + 1; // Fri 20, Sat 21 Nov 2026
const own = (weekendNight(n1) ? s.ownUseWeekend : s.ownUseWeekday) + (weekendNight(n2) ? s.ownUseWeekend : s.ownUseWeekday);
const hassle = weekendDay(dayNum('2026-11-22')) ? s.hassleWeekend : s.hassleWeekday;
const expected = 300 - 50 - hassle - own;
check('No demand: difference = payout - clean - hassle - own use', Math.abs(r0.diff - expected) < 0.01, `${r0.diff.toFixed(2)} vs ${expected}`);

// 2. Demand so high every night fills: rejecting earns about two nights at £100.
const ctx1 = testContext({ occupancy: 0.97 });
ctx1.params.lambda = new Map(Array.from({ length: 12 }, (_, m) => [`0|${m}`, 40]));
const r1 = evaluate(req, ctx1, { runs: 200 });
const insideR = r1.reject.parts.inside;
check('Saturated demand: rejecting fills the two nights at about £100 each', insideR > 190 && insideR <= 200.01, `£${insideR.toFixed(0)}`);

// 3. Same inputs, same answer.
const r2 = evaluate(req, testContext({ occupancy: 0.5 }), { runs: 100 });
const r3 = evaluate(req, testContext({ occupancy: 0.5 }), { runs: 100 });
check('Deterministic', r2.diff === r3.diff, `${r2.diff.toFixed(4)} / ${r3.diff.toFixed(4)}`);

// 4. Calibration: an empty month fills to the target occupancy it was calibrated to.
const ctx4 = testContext({ occupancy: 0.6 });
const lam = lambdaFor(ctx4, ctx4.params, 0, 10);
check('Calibration finds a request rate for 60% occupancy', lam > 0 && lam < 4, lam.toFixed(3));
return results;
}

export { buildContext, calibrate, evaluate, sensitivity, selfTest, MODEL_VERSION };
