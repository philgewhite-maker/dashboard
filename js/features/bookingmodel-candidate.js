// CANDIDATE COPY (model v5) for modelbacktest only: nothing in the app imports this file. Delete once v5 is live or dropped.
// The booking evaluator's engine: should this booking request be accepted?
//
// It compares two futures over a window of nights around the request:
//   accept: the request's payout (allowing for it being cancelled, late or early), plus
//           whatever bookings still arrive for the nights left free either side of it;
//   reject: whatever bookings arrive for the whole free window.
// Both count cleaning (a day's clean shared between the rooms turned over that day),
// changeover hassle, and what an empty night is worth to you (a second room empty the same
// night counts for less). Future bookings are simulated: booking requests arrive for each
// check-in date at a rate that follows London's season (Inside Airbnb), scaled to the requests
// each room has drawn for the dates and stay lengths that were open to request (see demandFor),
// with your lead times, stay lengths and weekday mix
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
import { roomBlocks } from '../icsparse.js';
import { activeListingId } from '../roomowner.js';
import { collectStays } from './lettingoccupancy.js';
import { evaluatorRooms, roomSettings } from './bookingsettings.js';
import { MARKET_SEASON, MARKET_CREDIT } from './marketdata.js';

const MODEL_VERSION = 5;
// Demand (see demandFor): the minimum stay assumed in force before shorter requests start appearing, how far back
// requests are counted, and how many pseudo-requests hold the level to the occupancy-based start and each month to London.
const PAST_MIN_NIGHTS = 5;
const DEMAND_WEEKS = 104;
const LEVEL_PRIOR_K = 3;
const MONTH_SHRINK_K = 5;
const LAMBDA_MAX = 4;
// The review's demand factor multiplies the request rate. One fitted under an earlier model version meant something else
// (it divided the empty nights of an occupancy target), so it is not carried over.
const demandFactorOf = (cal) => (cal && Number(cal.modelVersion) === MODEL_VERSION ? Number(cal.demand) || 1 : 1);
const DAY_MS = 86400000;
// Spread of the lead-time curve (log scale). Lead times are shaped like a wide lognormal on (days ahead + 0.5): the
// bookings per day keep rising towards arrival, and a narrow curve badly understates the last week (your own stays and
// requests: 22% within 3 days, 39% within 7; a spread of 0.9 gave 4% and 17%). The spread is fitted to your requests
// (see the lead-time fit in calibrate), blended with this prior (Airbnb-wide lead times fit a lognormal of about 1.3)
// as LEAD_SIGMA_K pseudo-requests.
const LEAD_SIGMA_PRIOR = 1.3;
const LEAD_SIGMA_K = 10;
const LEAD_SIGMA_MIN = 0.7;
const LEAD_SIGMA_MAX = 2;
const ONE_NIGHT_DEMAND_PCT = 10; // extra requests, as 1-night stays, a 2+ night minimum hides (a guess)
const LOS_MAX = 28;
// The stay-length assumption is a rule of thumb, not a measurement: a stay twice as long is half as common (frequency
// proportional to 1 / nights, over 1..LOS_MAX). It stands behind every length as LOS_PRIOR_K pseudo-requests, so a
// length that could rarely or never be requested keeps this shape and one that could be is set by what was asked for.
const LOS_PRIOR_K = 10;
const LOS_ITERS = 30; // passes of the stay-length estimate (an offline copy of it settled to 4 decimal places in 10 on simulated data)
const DOW_PRIOR_K = 3; // pseudo check-ins per weekday
const LEAD_SPAN = 420; // days ahead of a check-in that requests are followed for
const LOG_DAY = Float64Array.from({ length: LEAD_SPAN }, (_, d) => Math.log(d + 0.5));
const LEAD_SHIFT_K = 5; // pseudo-requests holding the shared lead-time shift at 0 (no shift)
const LEAD_SHIFT_MAX = 1.2; // the shift never exceeds this in log-days (about x3.3 either way)
const CANCEL_PRIOR = { rate: 0.08, k: 10, late: 0.3, lateK: 3 };
const OCC_PRIOR = 0.6;
const DEFAULT_PRICE = 80;
const BEFORE = 28; // nights simulated before the window, so a stay can run into it
const AFTER = 28; // and after it, so a stay can run out of it
const BLOCK_CAP = 28; // nights either side of a request simulated when nothing is booked nearby
// Counters tallied alongside the money, for the table's expandable rows: bookings (n_) and nights (d_) by
// where they fall, changeover days, and what the empty nights are worth, split.
const DETAIL_KEYS = ['n_before', 'n_inside', 'n_after', 'n_other', 'd_before', 'd_inside', 'd_after', 'd_other', 'cleanFirstN', 'cleanExtraN', 'hassleWdN', 'hassleWeN', 'ownWd', 'ownWdN', 'ownWe', 'ownWeN', 'ownSecond', 'ownSecondN'];
const RUNS = 1500;
const CAL_RUNS = 150;
const PROJECT_RUNS = 3000; // about 2 s warm; the run-to-run spread of a void's figure at 1,000 was 2-4%
const OCC_FULL_EVIDENCE = 3; // bookings a month needs to count in full towards the occupancy it shows

// ---- Dates as day numbers ------------------------------------------------------------------
const dayNum = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d) / DAY_MS; }; // a date, or a timestamp's date
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

// ---- Discounts (Airbnb's structure, Settings -> Booking evaluator -> Discounts) -----------------
// A step applies when the booking is within `days` of arrival (short notice) or the stay is at least `nights`
// long (length); the largest applicable step of each kind is taken, and the two combine multiplicatively.
function stepPct(steps, key, value) {
let best = 0;
(steps || []).forEach((st) => {
const k = Number(st[key]);
const p = Number(st.pct) || 0;
if (!(k > 0)) return;
if (key === 'days' ? value <= k : value >= k) best = Math.max(best, p);
});
return best / 100;
}
function discountsOf(s, channel = 'airbnb') {
const d = (s.discounts || {})[channel] || {};
return { shortNotice: d.shortNotice || [], length: d.length || [] };
}
// Nightly payout with the cleaning fee taken out, and the discounts undone, for one stay.
function rawNightlyRate({ amount, cleaning, nights, leadDays }, disc) {
const nightly = (Number(amount) - (Number(cleaning) || 0)) / nights;
if (!(nightly > 0)) return null;
const sn = leadDays == null ? 0 : stepPct(disc.shortNotice, 'days', leadDays);
const ln = stepPct(disc.length, 'nights', nights);
return { raw: nightly / ((1 - sn) * (1 - ln)), nightly, sn, ln };
}

// ---- Context: everything the model reads ------------------------------------------------------

// From the live data. `overrides.settings` replaces individual settings for one evaluation
// (the workbench's "try a different assumption").
function buildContext({ today = todayStr(), overrides = {} } = {}) {
const s = { ...DEFAULT_PREFS.bookingEvaluator, ...(data.prefs.bookingEvaluator || {}), ...(overrides.settings || {}) };
const firstClean = Number.isFinite(Number(overrides.firstClean)) ? Number(overrides.firstClean) : (Number.isFinite(Number(data.prefs.airbnbCleaningCost)) ? Number(data.prefs.airbnbCleaningCost) : 50);
const rooms = evaluatorRooms().map((room) => ({ key: room.key, label: room.label, listingIds: room.listingIds, ...roomSettings(room.key), ...((overrides.rooms || {})[room.key] || {}) })).filter((r) => r.include !== false);
// Each stay's confirmation code, where its record has one: asksFor matches a stay to the request it came from by it.
const stayCode = new Map();
(data.airbnbReservations || []).forEach((r) => { if (r.confirmationCode) stayCode.set(r.id, r.confirmationCode); });
(data.lettingLedger || []).forEach((e) => { if (e.confirmationCode) stayCode.set(`led:${e.id}`, e.confirmationCode); });
const stays = collectStays().map((x) => ({ id: x.id, listingId: x.listingId, checkin: x.checkin, checkout: x.checkout, income: x.income, bookedOn: x.bookedOn, cancelledOn: x.cancelledOn, status: x.status, unconfirmed: !!x.unconfirmed, guest: x.guest || '', platform: x.platform, code: stayCode.get(x.id) || '' }));
const requests = (data.bookingRequests || []).map((q) => ({ ...q }));
// A rate-review proposal is only a suggestion until you act on it: it lifts the model's price for those dates only once its
// subtask has been ticked off (the rate review's own meaning of "actioned"), so an unactioned event uplift can't inflate a verdict.
const proposals = (data.airbnbRateProposals || []).filter((p) => { const sub = (data.tasks || []).find((t) => t.id === p.subtaskId); return !!sub && sub.bucket === 'done'; }).map((p) => ({ listingId: p.listingId, startDate: p.startDate, endDate: p.endDate, upliftPct: p.upliftPct, upliftAmount: p.upliftAmount, reason: p.reason }));
const listingLabels = Object.fromEntries((data.airbnbListings || []).map((l) => [l.id, l.label || 'Listing']));
// The stored earnings-export rows for stays (data.airbnbEarnings), and which stays they cover, so a stay isn't counted twice.
const earningRows = (data.airbnbEarnings || []).filter((e) => String(e.type).toLowerCase() === 'reservation' && Number(e.amount) > 0 && Number(e.nights) > 0 && e.start);
const earnings = earningRows.map((e) => ({ listingId: e.listingId, guest: e.guest || "", code: e.confirmationCode, start: e.start, nights: Number(e.nights), amount: Number(e.amount), cleaningFee: e.cleaningFee == null ? 0 : Number(e.cleaningFee), bookingDate: e.bookingDate }));
const codes = new Set(earnings.map((e) => e.code).filter(Boolean));
const earnedStayIds = new Set();
(data.airbnbReservations || []).forEach((r) => { if (r.confirmationCode && codes.has(r.confirmationCode)) earnedStayIds.add(r.id); });
(data.lettingLedger || []).forEach((e) => { if (e.confirmationCode && codes.has(e.confirmationCode)) earnedStayIds.add(`led:${e.id}`); });
// The factors the monthly review applied, times any what-if for this one evaluation.
const cal = s.calibration || {};
const ov = overrides.scale || {};
const scale = { ...ov };
[['demand', 'demand'], ['lead', 'lead'], ['cancel', 'cancel']].forEach(([k]) => { const c = k === 'demand' ? demandFactorOf(cal) : Number(cal[k]) || 1; if (c !== 1 || ov[k] != null) scale[k] = c * (ov[k] != null ? ov[k] : 1); });
// Nights Airbnb's feed marks "Not available" (a host's manual blocks): not free nights, so not voids.
const blocks = (data.airbnbBlocks || []).map((b) => ({ listingId: b.listingId, from: b.from, to: b.to }));
const feedListingIds = (data.airbnbListings || []).filter((l) => l.icsUrl).map((l) => l.id);
return { today, s, firstClean, rooms, stays, requests, proposals, listingLabels, earnings, earnedStayIds, scale, blocks, feedListingIds };
}

// ---- Calibration ----------------------------------------------------------------------------

function roomIndexOf(ctx) {
const m = new Map();
ctx.rooms.forEach((r, i) => r.listingIds.forEach((id) => m.set(id, i)));
return m;
}

// Where a room's own months are thin (a month seen once, or never), the other rooms' seasonal pattern gives the month a
// shape: each other room's occupancy in that month as a multiple of its own average, pooled by how much evidence each has
// and smoothed over the neighbouring months, then applied to THIS room's own average. It counts for less than the
// room's own months (it replaces only the one pseudo-month the room's average already contributed, and its trust is
// capped at SIB_TRUST and scaled by the evidence behind the shape) but for more than nothing: a month with no data
// of its own gets the room's average reshaped by it instead of the flat average. No other room, or no evidence: unchanged.
const SIB_TRUST = 0.6;
// How far a month with no evidence of its own, and no sibling room to borrow from, follows London's seasonal shape (Inside Airbnb).
const MARKET_TRUST = 0.5;
function blendSiblingShape(occ) {
const wsum = (xs) => xs.reduce((a, x) => a + x.w, 0);
const meanOf = (xs) => { const W = wsum(xs); return W > 0 ? xs.reduce((a, x) => a + x.w * x.share, 0) / W : null; };
const smooth = (arr, m) => 0.25 * arr[(m + 11) % 12] + 0.5 * arr[m] + 0.25 * arr[(m + 1) % 12];
// The market index averaged over the months each room actually has evidence in (weighted by that evidence).
const marketObs = occ.map((o) => {
if (!o.sums) return 0;
let n = 0; let d = 0;
o.sums.forEach((xs, m) => { const w = wsum(xs); n += w * smooth(MARKET_SEASON, m); d += w; });
return d > 0 ? n / d : 0;
});
occ.forEach((o, i) => {
if (!o.sums || o.overall == null) return;
o.market = new Array(12).fill(null);
const num = new Array(12).fill(0);
const den = new Array(12).fill(0);
occ.forEach((p, j) => {
if (j === i || !p.sums || !(p.overall > 0)) return;
p.sums.forEach((xs, m) => { const mu = meanOf(xs); if (mu == null) return; const w = wsum(xs); num[m] += w * (mu / p.overall); den[m] += w; });
});
o.sibling = new Array(12).fill(null);
o.byMonth = o.sums.map((xs, m) => {
const dn = smooth(den, m);
const idx = dn > 0 ? smooth(num, m) / dn : null;
const a = idx == null ? 0 : SIB_TRUST * Math.min(1, dn / OCC_FULL_EVIDENCE);
let prior = a > 0 ? Math.min(0.97, Math.max(0.02, o.overall * (1 + a * (idx - 1)))) : o.overall;
o.sibling[m] = a > 0 ? { idx, a } : null;
// No other room to borrow the shape from for this month: use London's seasonal shape (Inside Airbnb), relative to the
// months this room's own average was measured in, so a room only seen in busy months is not scaled up for the quiet ones.
let fromMarket = false;
if (a === 0 && marketObs[i] > 0) {
const rel = smooth(MARKET_SEASON, m) / marketObs[i];
prior = Math.min(0.97, Math.max(0.02, o.overall * (1 + MARKET_TRUST * (rel - 1))));
fromMarket = true;
o.market[m] = { idx: rel, a: MARKET_TRUST };
}
const W = wsum(xs);
if (W > 0) return (xs.reduce((s, x) => s + x.w * x.share, 0) + prior) / (W + 1);
return a > 0 || fromMarket ? prior : null;
});
});
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

// What each room's bookings would earn per night before any discount, worked back from what actually reached you.
// Every stay with an earnings-export row (data.airbnbEarnings) gives: (amount received - cleaning fee) / nights,
// then the discounts that stay will have taken are undone (short notice from its booking date, length of stay, the
// steps in Settings -> Booking evaluator -> Discounts): raw rate = that / ((1 - short notice) x (1 - length)).
// A stay with no export row uses its income with the room's usual cleaning fee taken out. The guest-rating and
// special-offer discounts have no source and stay inside the median.
const disc = discountsOf(s, 'airbnb');
const samples = ctx.rooms.map(() => []); // {raw, ws (share of nights Fri/Sat), month, via, sn, ln}
const cleanFees = ctx.rooms.map(() => []);
const weekendShare = (start, n) => { let k = 0; for (let i = 0; i < n; i++) if (weekendNight(start + i)) k++; return n > 0 ? k / n : 0; };
(ctx.earnings || []).forEach((e) => {
const r = ri.get(e.listingId);
const start = e.start ? dayNum(e.start) : null;
if (r == null || start == null || start < since || !(e.nights > 0)) return;
const out = rawNightlyRate({ amount: e.amount, cleaning: e.cleaningFee, nights: e.nights, leadDays: e.bookingDate ? start - dayNum(e.bookingDate) : null }, disc);
if (!out) return;
samples[r].push({ raw: out.raw, ws: weekendShare(start, e.nights), month: monthOf(start), via: 'earnings', sn: out.sn, ln: out.ln });
if (e.cleaningFee > 0) cleanFees[r].push(Number(e.cleaningFee));
});
const everyCleaning = cleanFees.flat();
live.forEach((x) => {
if ((ctx.earnedStayIds || new Set()).has(x.id)) return;
const n = dayNum(x.checkout) - dayNum(x.checkin);
const start = dayNum(x.checkin);
if (!(Number(x.income) > 0) || n <= 0 || start < since) return;
const r = ri.get(x.listingId);
const usual = median(cleanFees[r]) ?? median(everyCleaning) ?? 0;
const out = rawNightlyRate({ amount: x.income, cleaning: usual, nights: n, leadDays: x.bookedOn ? start - dayNum(x.bookedOn) : null }, disc);
if (out) samples[r].push({ raw: out.raw, ws: weekendShare(start, n), month: monthOf(start), via: 'stay', sn: out.sn, ln: out.ln });
});
const everyRaw = samples.flat().map((x) => x.raw);
const prices = ctx.rooms.map((room, i) => {
const sm = samples[i];
// Friday/Saturday premium: weekend-heavy stays against weekday-heavy ones, when there are enough of each.
const low = sm.filter((x) => x.ws <= 0.2).map((x) => x.raw);
const high = sm.filter((x) => x.ws >= 0.5).map((x) => x.raw);
const uplift = low.length >= 3 && high.length >= 3 ? Math.min(1.6, Math.max(0.9, median(high) / median(low))) : 1;
const wd = sm.map((x) => ({ v: x.raw / (1 + x.ws * (uplift - 1)), month: x.month }));
const byMonth = Array.from({ length: 12 }, (_, m) => { const xs = wd.filter((x) => x.month === m).map((x) => x.v); return xs.length >= 3 ? median(xs) : null; });
const overall = median(wd.map((x) => x.v));
const base = overall ?? median(everyRaw) ?? DEFAULT_PRICE;
const clean = room.cleaningIncome != null && room.cleaningIncome !== '' ? Number(room.cleaningIncome) : (median(cleanFees[i]) ?? median(everyCleaning) ?? 0);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const nEarn = sm.filter((x) => x.via === 'earnings').length;
return {
weekday: room.priceWeekday != null ? Number(room.priceWeekday) : null,
weekend: room.priceWeekend != null ? Number(room.priceWeekend) : null,
byMonth, base, uplift, clean, n: sm.length, nEarn, avgShortNotice: mean(sm.map((x) => x.sn)), avgLength: mean(sm.map((x) => x.ln)),
source: room.priceWeekday != null || room.priceWeekend != null ? 'your setting' : overall != null ? `${sm.length} of your stays (${nEarn} from the earnings export)` : everyRaw.length ? `other rooms' stays (${everyRaw.length})` : 'assumption',
};
});

// The calibration so far. availabilityOf and exposureGrid read the stay-length curve and the weekday mix from it,
// and the lead-time fit below needs both of those, so it is filled in as each piece is worked out.
const P = {};
const avs = ctx.rooms.map((_, i) => availabilityOf(ctx, P, i));

// Stay length: requests (an enquiry at its weight), plus stays that didn't come from one.
// A length could only be asked for while it was allowed: at least the minimum stay then in force, and no longer
// than the open run from that check-in (see availabilityOf). Counting the lengths as they came would read "nobody
// asked for 2 nights while the minimum was 5" as "nobody wants 2 nights". So each ask carries the range of lengths
// that were allowed when it arrived, and a length's share is
//   (asks of that length + prior) / (asks, seen or not, that arrived while that length was allowed + LOS_PRIOR_K).
// The asks not seen are worked out from the curve itself: an ask whose allowed lengths cover a share p of the curve
// stands for 1/p asks, so the estimate is repeated until it settles. An ask with no date or room to place it, or
// whose length falls outside what the records say was allowed, counts as if every length had been open to it.
const losObs = [];
let losN = 0;
const addLos = (n, w, listingId, c, at) => {
if (!(n >= 1) || !(w > 0)) return;
const k = Math.min(n, LOS_MAX);
const r = ri.get(listingId);
const range = r != null && at ? avs[r].allowedAt(c, dayNum(at)) : null;
const ok = !!range && k >= range[0] && k <= range[1];
losObs.push({ k, w, lo: ok ? range[0] : 1, hi: ok ? range[1] : LOS_MAX });
losN += w;
};
ctx.requests.forEach((q) => { if (q.checkin && q.checkout) addLos(dayNum(q.checkout) - dayNum(q.checkin), q.kind === 'enquiry' ? s.enquiryWeight : 1, q.listingId, dayNum(q.checkin), q.receivedAt); });
live.forEach((x) => { if (!fromRequest.has(x.id) && dayNum(x.checkin) >= since) addLos(dayNum(x.checkout) - dayNum(x.checkin), 1, x.listingId, dayNum(x.checkin), x.bookedOn); });
const losPrior = new Array(LOS_MAX + 1).fill(0);
let harmonic = 0;
for (let i = 1; i <= LOS_MAX; i++) harmonic += 1 / i;
for (let i = 1; i <= LOS_MAX; i++) losPrior[i] = 1 / (i * harmonic);
let losW = losPrior.slice();
const losCum = new Float64Array(LOS_MAX + 1);
for (let it = 0; it < LOS_ITERS && losObs.length; it++) {
for (let i = 1; i <= LOS_MAX; i++) losCum[i] = losCum[i - 1] + losW[i];
const count = new Array(LOS_MAX + 1).fill(0);
const exposed = new Array(LOS_MAX + 1).fill(LOS_PRIOR_K);
losObs.forEach((o) => {
const p = losCum[o.hi] - losCum[o.lo - 1];
if (!(p > 0)) return;
count[o.k] += o.w;
for (let j = o.lo; j <= o.hi; j++) exposed[j] += o.w / p;
});
const raw = losPrior.map((pr, i) => (i ? (count[i] + LOS_PRIOR_K * pr) / exposed[i] : 0));
const rawTotal = raw.reduce((x, y) => x + y, 0);
losW = raw.map((v) => v / rawTotal);
}
// A pinned typical stay (Settings): tilt the learned shape towards short or long stays until its median is that many nights.
// The long stays stay in the mix, just rarer (or commoner); nothing is cut.
const pinned = Number(s.stayMedian);
if (pinned >= 1 && pinned <= 7) {
const medianOf = (w) => { const t = w.reduce((a, b) => a + b, 0); let acc = 0; for (let i = 0; i < w.length; i++) { acc += w[i]; if (acc / t >= 0.5) return i; } return LOS_MAX; };
// Only the 1-7 night part is reshaped, keeping its total, so the share of long stays does not move with the median.
  const headTotal = losW.slice(1, 8).reduce((a, b) => a + b, 0);
  const tilted = (th) => { const t = losW.map((w, i) => (i >= 1 && i <= 7 ? w * Math.exp(-th * i) : w)); const hs = t.slice(1, 8).reduce((a, b) => a + b, 0); return t.map((w, i) => (i >= 1 && i <= 7 && hs > 0 ? w * headTotal / hs : w)); };
let lo = -2; let hi = 4;
for (let it = 0; it < 40; it++) { const mid = (lo + hi) / 2; if (medianOf(tilted(mid)) > pinned) lo = mid; else hi = mid; }
losW = tilted(hi);
}
const losTotal = losW.reduce((a, b) => a + b, 0);
const losCdf = [];
losW.reduce((acc, w, i) => { losCdf[i] = (acc + w) / losTotal; return acc + w; }, 0);
const losMean = losW.reduce((a, w, i) => a + w * i, 0) / losTotal;
P.losCdf = losCdf;

// Check-in weekday mix.
const dowCount = new Array(7).fill(0);
let dowN = 0;
ctx.requests.forEach((q) => { if (q.checkin) { dowCount[dowOf(dayNum(q.checkin))] += q.kind === 'enquiry' ? s.enquiryWeight : 1; dowN += q.kind === 'enquiry' ? s.enquiryWeight : 1; } });
live.forEach((x) => { if (!fromRequest.has(x.id) && dayNum(x.checkin) >= since) { dowCount[dowOf(dayNum(x.checkin))] += 1; dowN += 1; } });
const dowRaw = dowCount.map((c) => c + DOW_PRIOR_K);
const dowMean = dowRaw.reduce((a, b) => a + b, 0) / 7;
const dowW = dowRaw.map((v) => v / dowMean);
P.dowW = dowW;

// Lead time, by the month of the stay (Christmas on its own): the Settings guide for the month, moved by one shared
// shift, with one shared spread.
// The shift and spread are fitted to every request (declined and never-booked ones included) because that is what
// the curve is used for: the simulation draws requests from it, and demandFor divides the requests that arrived by
// the share of them the curve says were due. Fitting it to the stays that were booked instead made it read too late
// in a simulated world with a known curve (an offline copy of selfTest's closed loop, estimated the old way, put the
// median about twice too far out and the demand level 20% to 40% too low; the stay lengths, then counted as they
// came, share in that second figure).
// Requests cannot simply be averaged either. Each one is seen only if the dates were open and the stay allowed when
// it arrived, and far-ahead requests find more open than last-minute ones. So the fit asks which shift and spread
// make the requests' own lead times most likely, given the exposure each past week offered (the same exposure
// demandFor uses, from exposureGrid), with the room's level left free:
//   score = sum over requests of log P(arrives that many days ahead) - sum over rooms of requests x log(exposure)
// The spread is held towards LEAD_SIGMA_PRIOR by LEAD_SIGMA_K pseudo-requests and the shift towards 0 by LEAD_SHIFT_K.
// Christmas has its own, very different, guide and takes the spread but not the shift. A month no longer leans on
// its own few requests separately: one shared shift is all the fit is asked to support. Edit the guide to match your
// real speed and the shift shrinks to 0.
const guideOf = (li) => (li === 12 ? Number(s.christmasLead) || 300 : Number((s.leadMedian || [])[li]) || 21);
const grids = ctx.rooms.map((_, i) => exposureGrid(ctx, P, i)).filter(Boolean);
const leadObs = new Float64Array(13 * LEAD_SPAN); // requests by lead-time curve and days ahead
const leadCount = new Array(13).fill(0);
const gridN = grids.map((g) => {
let n = 0;
g.asks.forEach((a) => {
const d = a.checkin - a.t;
if (d < 0 || d >= LEAD_SPAN) return;
const li = isChristmas(a.checkin) ? 12 : monthOf(a.checkin);
leadObs[li * LEAD_SPAN + d] += 1; leadCount[li] += 1; n += 1;
});
return n;
});
const leadC = new Float64Array(LEAD_SPAN);
const leadScore = (shift, sigma) => {
let ll = 0;
const X = grids.map(() => 0);
for (let li = 0; li < 13; li++) {
const mu = Math.log(guideOf(li) + 0.5) + (li === 12 ? 0 : shift);
for (let d = 0; d < LEAD_SPAN; d++) leadC[d] = normCdf((LOG_DAY[d] - mu) / sigma);
for (let d = 0; d < LEAD_SPAN; d++) { const n = leadObs[li * LEAD_SPAN + d]; if (n) ll += n * Math.log(Math.max(1e-12, leadC[d] - (d ? leadC[d - 1] : 0))); }
// Christmas dates sit in two classes of the grid (December's and January's), both on the Christmas curve.
const classes = li < 12 ? [li] : [12, 13];
grids.forEach((g, r) => {
classes.forEach((k) => {
const b = k * LEAD_SPAN;
for (let d = 0; d < LEAD_SPAN; d++) { const a = g.A[b + d]; if (a) X[r] += a * (leadC[d] - (d >= 7 ? leadC[d - 7] : 0)); }
});
});
}
grids.forEach((g, r) => { if (gridN[r] > 0 && X[r] > 0) ll -= gridN[r] * Math.log(X[r]); });
return ll - LEAD_SIGMA_K * Math.log(sigma) - (LEAD_SIGMA_K * LEAD_SIGMA_PRIOR ** 2 + LEAD_SHIFT_K * shift * shift) / (2 * sigma * sigma);
};
let leadShift = 0; let leadSigma = LEAD_SIGMA_PRIOR;
if (gridN.some((n) => n > 0)) {
// A coarse sweep of the whole allowed range, then three rounds of halving steps around the best point.
const clampShift = (v) => Math.min(LEAD_SHIFT_MAX, Math.max(-LEAD_SHIFT_MAX, v));
const clampSigma = (v) => Math.min(LEAD_SIGMA_MAX, Math.max(LEAD_SIGMA_MIN, v));
let best = -Infinity;
const tryAt = (sh, sg) => { const v = leadScore(sh, sg); if (v > best) { best = v; leadShift = sh; leadSigma = sg; } };
for (let i = -6; i <= 6; i++) for (let j = 0; j <= 7; j++) tryAt(clampShift(i * 0.2), clampSigma(LEAD_SIGMA_MIN + j * 0.2));
for (let step = 0.1; step > 0.02; step /= 2) {
const s0 = leadShift; const g0 = leadSigma;
for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) if (di || dj) tryAt(clampShift(s0 + di * step), clampSigma(g0 + dj * step));
}
}
const leadN = leadCount.reduce((x, y) => x + y, 0);
const lead = leadCount.map((n, li) => {
const prior = guideOf(li) * (ctx.scale.lead || 1);
const mu = Math.log(prior + 0.5) + (li === 12 ? 0 : leadShift);
return { mu, median: Math.max(0, Math.exp(mu) - 0.5), n, prior };
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

// Occupancy each room achieved, by month of the year, counting only months it was on offer.
// A month with no stay (any channel) and no request or enquiry at all is taken as a month the
// room wasn't listed, not as a month nobody wanted it, and is left out; so are the periods
// you marked as not offered (Settings -> Booking evaluator), night by night. A long direct
// booking counts as occupied like any other stay.
// How much a month tells you depends on how many separate bookings it rests on: a month that was one long
// booking (a three-month block, say) says little about how often guests ask for the room, so each month counts
// for min(1, bookings touching it / OCC_FULL_EVIDENCE) when averaging, in the all-months figure and in the
// month-of-year one alike.
const occ = ctx.rooms.map((room, i) => {
const mine = live.filter((x) => ri.get(x.listingId) === i);
if (!mine.length) return { byMonth: new Array(12).fill(null), byMonthN: new Array(12).fill(0), byMonthW: new Array(12).fill(0), byMonthBookings: new Array(12).fill(0), overall: null, months: 0, skipped: 0 };
const first = Math.min(...mine.map((x) => dayNum(x.checkin)));
const nights = new Set();
mine.forEach((x) => { for (let d = dayNum(x.checkin); d < dayNum(x.checkout); d++) nights.add(d); });
const off = new Set();
(Array.isArray(s.unavailable) ? s.unavailable : []).forEach((u) => {
if (u.roomKey !== room.key || !u.from || !u.to) return;
for (let d = dayNum(u.from); d <= dayNum(u.to); d++) off.add(d);
});
const asked = new Set();
ctx.requests.forEach((q) => { if (q.checkin && ri.get(q.listingId) === i) asked.add(q.checkin.slice(0, 7)); });
const sums = Array.from({ length: 12 }, () => []); // {share, w} per month of the year
const curMonthStart = dayNum(`${today.slice(0, 7)}-01`);
let d0 = dayNum(`${dayStr(Math.max(first, T - 730)).slice(0, 7)}-01`);
const all = [];
let skipped = 0;
while (d0 < curMonthStart) {
const dt = new Date(d0 * DAY_MS);
const next = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 1) / DAY_MS;
let k = 0; let open = 0;
for (let d = d0; d < next; d++) { if (off.has(d)) continue; open++; if (nights.has(d)) k++; }
const ym = dayStr(d0).slice(0, 7);
if (open < 7 || (k === 0 && !asked.has(ym))) { skipped++; d0 = next; continue; }
const share = k / open;
const bookings = mine.filter((x) => dayNum(x.checkin) < next && dayNum(x.checkout) > d0).length;
const w = Math.min(1, Math.max(bookings, 0.2) / OCC_FULL_EVIDENCE);
sums[dt.getUTCMonth()].push({ share, w, bookings });
all.push({ share, w, bookings });
d0 = next;
}
const wmean = (xs) => { const W = xs.reduce((a, x) => a + x.w, 0); return W > 0 ? xs.reduce((a, x) => a + x.w * x.share, 0) / W : null; };
// A month of the year seen once or twice is blended with the room's all-months average (weight
// one), so a single full or empty month doesn't set the demand on its own.
const overall = wmean(all);
const weightOf = (xs) => xs.reduce((a, x) => a + x.w, 0);
return {
byMonth: sums.map((xs) => (xs.length ? (xs.reduce((a, x) => a + x.w * x.share, 0) + overall) / (weightOf(xs) + 1) : null)),
byMonthN: sums.map((xs) => xs.length), byMonthW: sums.map((xs) => weightOf(xs)), byMonthBookings: sums.map((xs) => xs.reduce((a, x) => a + x.bookings, 0)),
overall, months: all.length, skipped, sums,
};
});
blendSiblingShape(occ);

ctx.params = Object.assign(P, { prices, losCdf, losMean, losN, dowW, dowN, lead, leadN, leadShift, leadSigma, cancelRate, lateShare, nAll, nCancel, occ, lambda: new Map() });
return ctx.params;
}

function leadFor(params, c) {
return params.lead[isChristmas(c) ? 12 : monthOf(c)];
}
// Share of a check-in date's eventual requests that arrive no more than `daysLeft` ahead.
function leadCdf(params, c, daysLeft) {
if (daysLeft < 0) return 0;
const { mu } = leadFor(params, c);
return normCdf((Math.log(daysLeft + 0.5) - mu) / params.leadSigma);
}
// A lead time from the curve, no longer than `daysLeft`.
function sampleLead(params, c, daysLeft, rng) {
const { mu } = leadFor(params, c);
const cap = daysLeft == null ? 1 : normCdf((Math.log(daysLeft + 0.5) - mu) / params.leadSigma);
const L = Math.max(0, Math.exp(mu + params.leadSigma * normInv(rng() * cap)) - 0.5);
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
const monthly = p.weekday ?? p.byMonth[monthOf(n)] ?? p.base;
let v = weekendNight(n) ? (p.weekend ?? monthly * p.uplift) : monthly;
const room = ctx.rooms[roomIdx];
const day = dayStr(n);
ctx.proposals.forEach((pr) => {
if (!room.listingIds.includes(pr.listingId) || !pr.startDate || day < pr.startDate || day > (pr.endDate || pr.startDate)) return;
if (Number.isFinite(Number(pr.upliftPct)) && pr.upliftPct != null) v *= 1 + Number(pr.upliftPct) / 100;
else if (Number.isFinite(Number(pr.upliftAmount)) && pr.upliftAmount != null) v += Number(pr.upliftAmount);
});
return v;
}
function shortNoticePct(s, daysAhead) { return stepPct(discountsOf(s).shortNotice, 'days', daysAhead); }
function lengthPct(s, nights) { return stepPct(discountsOf(s).length, 'nights', nights); }
function maxBoost(s, planPct = 0) {
const d = discountsOf(s);
const top = (steps) => Math.max(0, ...steps.map((st) => (Number(st.days ?? st.nights) > 0 ? Number(st.pct) || 0 : 0))) / 100;
const lm = 1 - (1 - top(d.shortNotice)) * (1 - top(d.length));
const gap = Math.max(Number(s.gapDiscountPct) || 0, Number(planPct) || 0) / 100;
return Math.pow((1 - lm) * (1 - gap), -(Number(s.elasticity) || 0));
}

// ---- One simulated future -------------------------------------------------------------------

// Void plans: what you set on Airbnb for a stretch of nights (a minimum stay and/or a price cut). `plans` = [{ri, from, to (exclusive),
// minNights|null, pct}] in day numbers; they change only how arrivals are played, never the demand.
function normalisePlans(ctx) {
const T = dayNum(ctx.today);
const out = [];
(Array.isArray(ctx.s.voidPlans) ? ctx.s.voidPlans : []).forEach((p) => {
const ri = ctx.rooms.findIndex((r) => r.key === p.roomKey);
if (ri < 0 || !p.from || !p.to || dayNum(p.to) <= T) return;
const min = p.minNights == null || p.minNights === '' ? null : Math.max(1, Number(p.minNights) || 1);
const pct = Math.min(90, Math.max(0, Number(p.discountPct) || 0));
if (min == null && !pct) return;
out.push({ ri, from: dayNum(p.from), to: dayNum(p.to), minNights: min, pct });
});
return out;
}
function planAt(plans, ri, c) {
if (!plans) return null;
for (const p of plans) if (p.ri === ri && c >= p.from && c < p.to) return p;
return null;
}

// Request arrivals for every room and check-in date in [from, to), all arriving on or after
// `todayN` (those that arrived before today already did whatever they did). `lam(roomIdx, c)`
// is the eventual number of requests for check-in date c, before price thinning.
// `extra` ({roomIdx: fraction}): requests for 1 night on top of the usual ones, in rooms whose minimum stay has
// been lowered below the one the demand was calibrated under (see ONE_NIGHT_DEMAND_PCT).
function drawArrivals(ctx, params, { from, to, todayN, lam, rooms, extra = null, rngX = null }, rng) {
const out = [];
const boost = maxBoost(ctx.s, ctx.planMaxPct);
const oneNight = (Number(ctx.s.oneNightDemandPct ?? ONE_NIGHT_DEMAND_PCT) || 0) / 100;
rooms.forEach((ri) => {
for (let c = Math.max(from, todayN); c < to; c++) {
const daysLeft = todayN == null ? null : c - todayN;
const share = daysLeft == null ? 1 : leadCdf(params, c, daysLeft);
const k = poisson(rng, lam(ri, c) * params.dowW[dowOf(c)] * boost * share);
for (let j = 0; j < k; j++) {
const L = sampleLead(params, c, daysLeft, rng);
out.push({ room: ri, c, los: sampleLos(params, rng), at: c - L, lead: L, u: rng(), tie: rng() });
}
const planLow = ctx.plans && ctx.plans.length ? planAt(ctx.plans, ri, c) : null;
const exFrac = (extra && extra[ri]) || (planLow && planLow.minNights != null && planLow.minNights < (Number(ctx.rooms[ri].minNights) || 1) ? oneNight : 0);
if (exFrac) {
// The 1-night extras come from their own random stream when one is given, so lowering a minimum stay leaves the
// ordinary arrivals exactly as they were (what lets a what-if be compared with the same draws).
const rx = rngX || rng;
const k1 = poisson(rx, lam(ri, c) * params.dowW[dowOf(c)] * boost * share * exFrac);
for (let j = 0; j < k1; j++) {
const L = sampleLead(params, c, daysLeft, rx);
out.push({ room: ri, c, los: 1, at: c - L, lead: L, u: rx(), tie: rx() });
}
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
const boost = maxBoost(s, ctx.planMaxPct);
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
const plan = ctx.plans && ctx.plans.length ? planAt(ctx.plans, a.room, a.c) : null;
const min = plan && plan.minNights != null ? plan.minNights : (minNights[a.room] || 1);
if (a.los < min && !exactFill) continue;
const before = i0 - gs;
const after = ge - i1;
const orphan = (boundedL && before > 0 && before < min) || (boundedR && after > 0 && after < min);
if (orphan && a.lead > 7) continue;
const inGap = boundedL && boundedR && ge - gs <= gapMax;
const factor = (1 - shortNoticePct(s, a.lead)) * (1 - lengthPct(s, a.los)) * (plan && plan.pct > 0 ? 1 - plan.pct / 100 : inGap ? 1 - gapPct : 1);
if (a.u > Math.pow(factor, -eps) / boost) continue; // the guest doesn't take it at this price
for (let i = i0; i < i1 && i < len; i++) o[i] = 1;
booked.push({ room: a.room, ci: a.c, co: a.c + a.los, factor, at: a.at, lead: a.lead });
}
if (blocked) for (let d = block.ci; d < block.co; d++) occ[block.room][d - base] = 1;
return booked;
}

// ---- Demand: requests per check-in date -------------------------------------------------------
//
// rate(room, month) = London's seasonal shape (Inside Airbnb, marketdata.js) x the room's own level x a monthly
// adjustment from the room's own requests x the review's demand factor.
// The level and the adjustment come from requests, not from occupancy: each past week, every check-in date could
// only draw the requests that were still possible then (the nights had to be open, and the stay had to fit the
// open run and meet the minimum stay in force), so the requests that arrived are divided by that exposure. A month
// that was full, or held by one long booking, offered almost no exposure: it says nothing either way, and London's
// shape stands in for it. A tight gap offers little exposure, so a request that lands in one counts for more.

const weekStartN = (n) => n - ((n + 3) % 7); // Monday

// Every ask for a room's listings: requests and enquiries by the day they landed, plus bookings that never had a
// request (instant bookings, and stays known only from the calendar or the ledger), by the day they were made.
// A booking is counted once: an earnings row or a stay that a request already stands for (its reservation, its
// confirmation code, or the same listing and check-in) is left out, and so is a stay an earnings row stands for.
// A stay with no booking date is left out altogether: an ask needs the day it arrived, and inventing one would put
// it in the wrong week's count and give it a made-up lead time.
function asksFor(ctx, ids) {
const reqs = ctx.requests.filter((q) => ids.has(q.listingId) && q.receivedAt && q.checkin);
const codes = new Set(reqs.map((q) => q.confirmationCode).filter(Boolean));
const keys = new Set(reqs.map((q) => `${q.listingId}|${q.checkin}`));
const reserved = new Set(reqs.map((q) => q.reservationId).filter(Boolean));
const asks = reqs.map((q) => ({ t: dayNum(q.receivedAt), listingId: q.listingId, kind: q.kind === 'enquiry' ? 'enquiry' : 'request', checkin: dayNum(q.checkin), nights: q.checkout ? dayNum(q.checkout) - dayNum(q.checkin) : null, payout: q.kind === 'enquiry' ? null : Number(q.payout) || null }));
// Bookings the earnings rows account for (as an ask of their own, or as the request they matched), by code and by listing and check-in.
const earnedCodes = new Set();
const earnedKeys = new Set();
(ctx.earnings || []).forEach((e) => {
if (!ids.has(e.listingId) || !e.bookingDate || !e.start) return;
if (e.code) earnedCodes.add(e.code);
earnedKeys.add(`${e.listingId}|${e.start}`);
if (codes.has(e.code) || keys.has(`${e.listingId}|${e.start}`)) return;
asks.push({ t: dayNum(e.bookingDate), listingId: e.listingId, kind: 'request', checkin: dayNum(e.start), nights: e.nights, payout: e.amount, instant: true });
});
const stayKeys = new Set(); // two records of one stay (same listing and check-in) count once
(ctx.stays || []).forEach((x) => {
if (x.status !== 'stay' || x.unconfirmed || !ids.has(x.listingId) || !x.bookedOn || !x.checkin || !x.checkout) return;
const key = `${x.listingId}|${x.checkin}`;
if (reserved.has(x.id) || keys.has(key) || earnedKeys.has(key) || stayKeys.has(key)) return;
if (x.code && (codes.has(x.code) || earnedCodes.has(x.code))) return;
stayKeys.add(key);
asks.push({ t: dayNum(x.bookedOn), listingId: x.listingId, kind: 'request', checkin: dayNum(x.checkin), nights: dayNum(x.checkout) - dayNum(x.checkin), payout: Number(x.income) || null, unmatched: true });
});
return asks.filter((a) => a.t <= dayNum(ctx.today)).sort((a, b) => a.t - b.t);
}

// What a room had on offer on a past day `t`.
//   open(c, t)  was night c still free? Bookings count from the day they were made (booking date, else the request
//               that became them, else two weeks before arrival); "not offered" spells and calendar blocks count always.
//   minAt(t)    the minimum stay then: the shortest stay anyone had requested by then (a request that exactly filled
//               a gap aside, since those are allowed under the minimum), and no more than PAST_MIN_NIGHTS.
//   fit(t, from, span)  returns c -> the share of stay lengths that could be requested for check-in c as things
//               stood on day t: they fit the open run from c and meet the minimum (or exactly fill a gap shorter than it).
//   allowedAt(c, t)  the same rule as a range: [shortest, longest] stay that could be requested for check-in c on
//               day t, or null when none could. A booking that starts on c is left out of the picture, because it is
//               the ask's own booking (it may be dated the same day as the request that became it).
// params.losCdf is read when fit is called, not here, so calibrate can ask for allowedAt before the curve exists.
function availabilityOf(ctx, params, ri) {
const room = ctx.rooms[ri];
const ids = new Set(room.listingIds);
const reqAt = new Map(ctx.requests.filter((q) => q.reservationId && q.receivedAt).map((q) => [q.reservationId, dayNum(q.receivedAt)]));
const held = [];
ctx.stays.forEach((x) => {
if (!ids.has(x.listingId) || !x.checkin || !x.checkout) return;
const ci = dayNum(x.checkin); const co = dayNum(x.checkout);
const since = x.bookedOn ? dayNum(x.bookedOn) : reqAt.has(x.id) ? reqAt.get(x.id) : ci - 14;
if (x.status === 'cancelled') { if (x.cancelledOn) held.push({ ci, co, since, until: dayNum(x.cancelledOn), booking: true }); return; }
if (x.status === 'stay' || x.unconfirmed) held.push({ ci, co, since, until: Infinity, booking: true });
});
(Array.isArray(ctx.s.unavailable) ? ctx.s.unavailable : []).forEach((u) => { if (u.roomKey === room.key && u.from && u.to) held.push({ ci: dayNum(u.from), co: dayNum(u.to) + 1, since: -Infinity, until: Infinity }); });
// Calendar blocks count only on the listing in use for the room (a sibling listing can be blocked all winter without the room being).
const inUse = activeListingId(room.listingIds, ctx.stays, ctx.today);
roomBlocks(ctx.blocks || [], (ctx.feedListingIds || []).includes(inUse) ? [inUse] : []).forEach((b) => held.push({ ci: dayNum(b.from), co: dayNum(b.to), since: -Infinity, until: Infinity }));
const open = (c, t) => { for (const o of held) if (c >= o.ci && c < o.co && o.since <= t && t < o.until) return 0; return 1; };
const shortest = asksFor(ctx, ids)
.filter((a) => a.kind === 'request' && a.nights >= 1 && a.nights < PAST_MIN_NIGHTS && !(!open(a.checkin - 1, a.t) && !open(a.checkin + a.nights, a.t)))
.map((a) => [a.t, a.nights]);
const minAt = (t) => { let m = PAST_MIN_NIGHTS; for (const [at, n] of shortest) { if (at > t + 7) break; if (n < m) m = n; } return m; };
const allowedAt = (c, t) => {
const taken = (d) => { for (const o of held) if (d >= o.ci && d < o.co && o.since <= t && t < o.until && !(o.booking && o.ci === c)) return true; return false; };
let r = 0;
while (r < LOS_MAX && !taken(c + r)) r++;
const min = minAt(t);
if (r >= min) return [min, r];
return r > 0 && taken(c - 1) ? [r, r] : null;
};
const fit = (t, from = t, span = LEAD_SPAN) => {
const cdf = params.losCdf;
const base = from - 1;
const len = span + LOS_MAX + 2;
const occ = new Uint8Array(len);
for (const o of held) {
if (!(o.since <= t && t < o.until)) continue;
for (let i = Math.max(0, o.ci - base), e = Math.min(len, o.co - base); i < e; i++) occ[i] = 1;
}
const run = new Uint8Array(len + 1);
for (let i = len - 1; i >= 0; i--) run[i] = occ[i] ? 0 : Math.min(LOS_MAX, run[i + 1] + 1);
const min = minAt(t);
return (c) => {
const i = c - base;
if (i < 1 || i >= len) return 0;
const r = run[i];
if (!r) return 0;
if (r >= min) return cdf[r] - (cdf[min - 1] || 0);
return occ[i - 1] && r < LOS_MAX ? cdf[r] - (cdf[r - 1] || 0) : 0;
};
};
return { open, minAt, fit, allowedAt };
}

// What a room's past weeks offered, before the lead-time curve is applied: for each complete week w since its first
// ask (DEMAND_WEEKS at most) and each check-in date c up to LEAD_SPAN days on, London's index x weekday weight x fit,
// added up by how many days ahead c was (d = c - w) and by which lead-time curve c uses. A[k x LEAD_SPAN + d]:
// k = 0..11 the month of c; 12 and 13 are Christmas dates in December and in January, which share the Christmas
// curve but belong to different months of the demand. The lead-time fit (calibrate) tries many curves against this
// one grid, and demandFor applies the fitted one. Also returns the asks counted against it.
// Kept on the context once there is something to keep. null: no asks yet, or no complete week since the first.
function exposureGrid(ctx, params, ri) {
if (ctx.gridCache && ctx.gridCache.has(ri)) return ctx.gridCache.get(ri);
const end = weekStartN(dayNum(ctx.today)); // complete weeks only
const asks = asksFor(ctx, new Set(ctx.rooms[ri].listingIds)).filter((a) => a.kind === 'request' && a.checkin >= a.t);
if (!asks.length || !(weekStartN(asks[0].t) < end)) return null;
const first = Math.max(weekStartN(asks[0].t), end - 7 * DEMAND_WEEKS);
const av = availabilityOf(ctx, params, ri);
// Each date's class and weight, worked out once: the date arithmetic is the slow part.
const days = end - first + LEAD_SPAN;
const cls = new Uint8Array(days);
const weight = new Float64Array(days);
for (let i = 0; i < days; i++) {
const c = first + i; const m = monthOf(c);
cls[i] = isChristmas(c) ? (m === 11 ? 12 : 13) : m;
weight[i] = MARKET_SEASON[m] * params.dowW[dowOf(c)];
}
const A = new Float64Array(14 * LEAD_SPAN);
let weeks = 0;
for (let w = first; w < end; w += 7) {
const fit = av.fit(w + 3, w, LEAD_SPAN);
for (let d = 0; d < LEAD_SPAN; d++) {
const F = fit(w + d);
if (F > 0) { const i = w + d - first; A[cls[i] * LEAD_SPAN + d] += weight[i] * F; }
}
weeks++;
}
const out = { A, asks: asks.filter((a) => a.t >= first && a.t < end), first, end, weeks };
(ctx.gridCache || (ctx.gridCache = new Map())).set(ri, out);
return out;
}
// A grid's exposure by month of the year under a lead-time curve: each cell times the share of that date's requests
// due in the week (those arriving between d - 6 and d days ahead).
function exposureByMonth(grid, lead, sigma) {
const X = new Array(12).fill(0);
const C = new Float64Array(LEAD_SPAN);
for (let k = 0; k < 14; k++) {
const mu = lead[k >= 12 ? 12 : k].mu;
for (let d = 0; d < LEAD_SPAN; d++) C[d] = normCdf((LOG_DAY[d] - mu) / sigma);
const b = k * LEAD_SPAN;
let x = 0;
for (let d = 0; d < LEAD_SPAN; d++) { const a = grid.A[b + d]; if (a) x += a * (C[d] - (d >= 7 ? C[d - 7] : 0)); }
X[k < 12 ? k : k === 12 ? 11 : 0] += x;
}
return X;
}

// The rate of requests per check-in date (flat through the year) at which an empty calendar for this room fills to
// `target`. Bisection over simulated months. Used only as the starting level before a room has requests of its own.
function rateForOccupancy(ctx, params, ri, target) {
// A synthetic month: 30 nights, 28 before it, all arrivals seen.
const start = Date.UTC(2030, 5, 1) / DAY_MS;
const base = start - BEFORE;
const len = BEFORE + 30 + AFTER;
const minNights = { [ri]: Number(ctx.rooms[ri].minNights) || 1 };
const occupancyAt = (lam) => {
const rng = mulberry32(hashStr(`cal|${ri}|${lam.toFixed(4)}`));
let filled = 0;
for (let r = 0; r < (ctx.calRuns || CAL_RUNS); r++) {
const occ = []; occ[ri] = new Uint8Array(len);
const arr = drawArrivals(ctx, params, { from: base, to: base + len, todayN: null, lam: () => lam, rooms: [ri] }, rng);
playArrivals(ctx, params, arr, occ, base, { minNights, len });
for (let i = BEFORE; i < BEFORE + 30; i++) filled += occ[ri][i];
}
return filled / ((ctx.calRuns || CAL_RUNS) * 30);
};
let lo = 0; let hi = LAMBDA_MAX;
if (occupancyAt(hi) < target) return hi;
for (let it = 0; it < (ctx.calIters || 12); it++) {
const mid = (lo + hi) / 2;
if (occupancyAt(mid) < target) lo = mid; else hi = mid;
}
return (lo + hi) / 2;
}

// A room's demand: its level L (requests per check-in date in an average month, all stay lengths, before
// availability), and how far each month of the year sits from London's shape (adj, 1 = as London).
//   exposure X[m] = sum over past weeks and check-in dates in month m of
//                   London's index x weekday weight x the share of that date's requests due that week x fit
//   L      = (requests + LEVEL_PRIOR_K) / (total exposure + LEVEL_PRIOR_K / L0), L0 being the rate that fills an
//            empty calendar to the room's achieved occupancy (all a room without requests has to go on);
//   adj[m] = (requests for month m + MONTH_SHRINK_K) / (L x X[m] + MONTH_SHRINK_K): a month with little exposure
//            or few requests stays near London's shape.
// Kept on the context (not the calibration), so what-ifs that only rescale demand reuse it.
function demandFor(ctx, params, ri) {
const cache = ctx.demandCache || (ctx.demandCache = new Map());
if (cache.has(ri)) return cache.get(ri);
const o = params.occ[ri];
const L0 = Math.max(0.01, rateForOccupancy(ctx, params, ri, Math.min(0.97, Math.max(0.02, o.overall ?? OCC_PRIOR))));
const out = { L: L0, L0, adj: new Array(12).fill(1), N: new Array(12).fill(0), X: new Array(12).fill(0), n: 0, weeks: 0, from: null };
const grid = exposureGrid(ctx, params, ri);
if (grid) {
out.X = exposureByMonth(grid, params.lead, params.leadSigma);
out.weeks = grid.weeks;
grid.asks.forEach((a) => { out.N[monthOf(a.checkin)]++; out.n++; });
const X = out.X.reduce((a, b) => a + b, 0);
if (X > 0) {
out.L = (out.n + LEVEL_PRIOR_K) / (X + LEVEL_PRIOR_K / L0);
out.adj = out.N.map((n, m) => (n + MONTH_SHRINK_K) / (out.L * out.X[m] + MONTH_SHRINK_K));
}
out.from = dayStr(grid.first);
}
cache.set(ri, out);
return out;
}

// Requests per check-in date in this month of the year, all stay lengths, before availability and price.
function lambdaFor(ctx, params, ri, month) {
const key = `${ri}|${month}`;
if (params.lambda.has(key)) return params.lambda.get(key);
const d = demandFor(ctx, params, ri);
const lam = Math.min(LAMBDA_MAX, d.L * MARKET_SEASON[month] * d.adj[month] * (ctx.scale.demand || 1));
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

const ri2 = roomIndexOf(ctx);
// Calendars as they stand: live stays (not this request's own, not unconfirmed holds).
const existing = ctx.stays.filter((x) => x.status === 'stay' && !x.unconfirmed && x.id !== request.reservationId && ri2.has(x.listingId));

// The free stretch around the request in its room: the nights between the booking before it
// and the booking after it (or today; or at most BLOCK_CAP nights either side when nothing
// is booked nearby). Only these nights can come out differently if you accept or reject:
// a booking can't cross an existing one, so everything beyond them is the same either way.
// The comparison is run over this stretch; the nights beyond are shown as one projected
// scenario, shared by every future, and don't enter the totals.
const mine = existing.filter((x) => ri2.get(x.listingId) === ri);
let wS = Math.max(T, ci - BLOCK_CAP);
mine.forEach((x) => { const xo = dayNum(x.checkout); if (xo <= ci && xo > wS) wS = xo; });
let wE = co + BLOCK_CAP;
mine.forEach((x) => { const xi = dayNum(x.checkin); if (xi >= co && xi < wE) wE = xi; });
const capped = { before: wS === Math.max(T, ci - BLOCK_CAP) && wS > T, after: wE === co + BLOCK_CAP };
// What the charts show: the free stretch, widened to a fortnight either side of the request.
const dispS = Math.max(T, Math.min(ci - 14, wS));
const dispE = Math.max(dispS + 30, co + 14, wE);
const base = Math.max(T - 1, Math.min(wS, dispS) - BEFORE); // the night before today counts as taken
const len = Math.max(wE, dispE) + AFTER - base;

const occ0 = ctx.rooms.map(() => new Uint8Array(len));
existing.forEach((x) => {
const r = ri2.get(x.listingId);
for (let d = dayNum(x.checkin); d < dayNum(x.checkout); d++) if (d >= base && d < base + len) occ0[r][d - base] = 1;
});
// A room is blocked by the blocks on the listing in use for it (a sibling listing may be blocked all winter without the room being).
ctx.rooms.forEach((room, r) => {
const active = ownerListingOf(ctx, room);
roomBlocks(ctx.blocks, (ctx.feedListingIds || []).includes(active) ? [active] : []).forEach((b) => {
for (let d = dayNum(b.from); d < dayNum(b.to); d++) if (d >= base && d < base + len) occ0[r][d - base] = 1;
});
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
const existingList = [];
existing.forEach((x) => {
const n = dayNum(x.checkout) - dayNum(x.checkin);
const r = ri2.get(x.listingId);
let inWin = 0;
for (let d = Math.max(dayNum(x.checkin), wS); d < Math.min(dayNum(x.checkout), wE); d++) {
inWin += Number(x.income) > 0 ? Number(x.income) / n : basePrice(ctx, params, r, d);
}
existingIncome += inWin;
if (inWin > 0) existingList.push({ id: x.id, room: ctx.listingLabels[x.listingId] || ctx.rooms[r].label, guest: x.guest, checkin: x.checkin, checkout: x.checkout, income: Number(x.income) > 0 ? Number(x.income) : null, inWindow: inWin });
});
const existingCheckouts = existing.map((x) => ({ room: ri2.get(x.listingId), co: dayNum(x.checkout) }));

const firstClean = ctx.firstClean;
const extraClean = Number(s.cleanExtra);
const ownUseOf = (r, n) => (weekendNight(n) ? Number(s.ownUseWeekend) : Number(s.ownUseWeekday)) * (Number(ctx.rooms[r].weight) || 1) * (ctx.scale.ownUse ?? 1);
const secondPct = (Number(s.ownUseSecondPct) || 0) / 100;

// Totals for one future: bookings (simulated), plus the request if it stays booked.
const tally = (occ, booked, reqState) => {
const t = { before: 0, inside: 0, after: 0, other: 0, request: 0, clean: 0, hassle: 0, ownUse: 0, nightsTaken: [] };
DETAIL_KEYS.forEach((k) => { t[k] = 0; });
booked.forEach((b) => {
let first = true;
for (let d = Math.max(b.ci, wS); d < Math.min(b.co, wE); d++) {
const v = basePrice(ctx, params, b.room, d) * b.factor;
const cat = b.room !== ri ? 'other' : d < ci ? 'before' : d >= co ? 'after' : 'inside';
t[cat] += v;
t[`d_${cat}`] += 1;
if (first) { t[`n_${cat}`] += 1; first = false; }
}
// The cleaning fee guests pay is income too (your own clean cost is deducted separately, per changeover below).
if (b.ci >= wS) { const cat0 = b.room !== ri ? 'other' : b.ci < ci ? 'before' : b.ci >= co ? 'after' : 'inside'; t[cat0] += params.prices[b.room].clean; }
});
if (reqState === 'none') t.request = weighted;
else if (reqState === 'late') t.request = weighted * latePay;
const outs = new Map();
const addOut = (n, r) => { if (n >= wS && n <= wE) { if (!outs.has(n)) outs.set(n, new Set()); outs.get(n).add(r); } };
existingCheckouts.forEach((x) => addOut(x.co, x.room));
booked.forEach((b) => addOut(b.co, b.room));
if (reqState === 'none') addOut(co, ri);
outs.forEach((set, n) => {
t.clean += firstClean + extraClean * (set.size - 1);
t.cleanFirstN += 1; t.cleanExtraN += set.size - 1;
t.hassle += weekendDay(n) ? Number(s.hassleWeekend) : Number(s.hassleWeekday);
if (weekendDay(n)) t.hassleWeN += 1; else t.hassleWdN += 1;
});
for (let d = wS; d < wE; d++) {
const empties = [];
roomsIdx.forEach((r) => { if (!occ[r][d - base]) empties.push(ownUseOf(r, d)); });
empties.sort((a, b) => b - a);
empties.forEach((v, k) => {
t.ownUse += k === 0 ? v : v * secondPct;
if (k === 0) { if (weekendNight(d)) { t.ownWe += v; t.ownWeN += 1; } else { t.ownWd += v; t.ownWdN += 1; } }
else { t.ownSecond += v * secondPct; t.ownSecondN += 1; }
});
}
for (let d = wS; d < wE; d++) t.nightsTaken.push(occ[ri][d - base]);
return t;
};
const total = (t) => existingIncome + t.request + t.before + t.inside + t.after + t.other - t.clean - t.hassle + t.ownUse;

const seed = hashStr(`${MODEL_VERSION}|${request.listingId}|${request.checkin}|${request.checkout}|${payout}|${ctx.today}|${JSON.stringify(s)}|${JSON.stringify(ctx.scale)}`);
const rng = mulberry32(seed);
const keys = ['request', 'before', 'inside', 'after', 'other', 'clean', 'hassle', 'ownUse', ...DETAIL_KEYS];
const zero = () => Object.fromEntries(keys.map((k) => [k, 0]));
const sumA = zero(); const sumR = zero(); const sumN = zero(); const sumL = zero(); const sumE = zero();
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
keys.forEach((k) => { sumA[k] += mix(k); sumR[k] += tR[k]; sumN[k] += tN[k]; if (tLt) sumL[k] += tLt[k]; if (tEa) sumE[k] += tEa[k]; });
const a = wNone * total(tN) + (tLt ? wLate * total(tLt) : 0) + (tEa ? wEarly * total(tEa) : 0);
const r = total(tR);
totA.push(a); totR.push(r); diffs.push(a - r);
for (let i = 0; i < wE - wS; i++) {
nightA[i] += wNone * tN.nightsTaken[i] + (tLt ? wLate * tLt.nightsTaken[i] : 0) + (tEa ? wEarly * tEa.nightsTaken[i] : 0);
nightR[i] += tR.nightsTaken[i];
}
if (examples.length < 3) {
const describe = (booked) => booked.filter((b) => b.room === ri && b.co > wS && b.ci < wE).map((b) => {
let amount = 0;
for (let d = b.ci; d < b.co; d++) amount += basePrice(ctx, params, ri, d) * b.factor;
const nightsAmount = amount;
const cleaningIncome = b.ci >= wS ? params.prices[ri].clean : 0;
amount += cleaningIncome;
return { checkin: dayStr(b.ci), checkout: dayStr(b.co), nights: b.co - b.ci, arrived: dayStr(Math.max(T, Math.floor(b.at))), perNight: Math.round(nightsAmount / (b.co - b.ci)), amount: Math.round(amount), cleaning: Math.round(cleaningIncome), discounted: b.factor < 0.999 };
}).sort((a, b) => a.checkin.localeCompare(b.checkin));
examples.push({ reject: describe(R.booked), accept: describe(A0.booked), total: { accept: Math.round(total(tN)), reject: Math.round(r) } });
}
}
const meanA = Object.fromEntries(keys.map((k) => [k, sumA[k] / runs]));
const meanR = Object.fromEntries(keys.map((k) => [k, sumR[k] / runs]));
const meanOf = (sum) => Object.fromEntries(keys.map((k) => [k, sum[k] / runs]));
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

// The nights beyond the free stretch: one projected scenario (a single simulated future, drawn
// with its own fixed seed), shown in every chart as the same thing. It is not part of the
// comparison or its totals: it is what the rest of the calendar might look like.
const bgRng = mulberry32(hashStr(`bg|${MODEL_VERSION}|${ctx.today}|${request.listingId}|${JSON.stringify(s)}|${JSON.stringify(ctx.scale)}`));
const bgOcc = occ0.map((o) => o.slice());
const bgArr = drawArrivals(ctx, params, { from: base, to: dispE + AFTER, todayN: T, lam, rooms: [ri] }, bgRng);
const bgBooked = playArrivals(ctx, params, bgArr, bgOcc, base, { minNights, len }).filter((b) => b.room === ri && (b.co <= wS || b.ci >= wE) && b.co > dispS && b.ci < dispE);
const projected = bgBooked.map((b) => {
let amount = 0;
for (let d = b.ci; d < b.co; d++) amount += basePrice(ctx, params, ri, d) * b.factor;
const nightsAmount = amount;
const cleaningIncome = b.ci >= dispS ? params.prices[ri].clean : 0;
amount += cleaningIncome;
return { checkin: dayStr(b.ci), checkout: dayStr(b.co), nights: b.co - b.ci, arrived: dayStr(Math.max(T, Math.floor(b.at))), perNight: Math.round(nightsAmount / (b.co - b.ci)), amount: Math.round(amount), cleaning: Math.round(cleaningIncome), discounted: b.factor < 0.999 };
}).sort((a, b) => a.checkin.localeCompare(b.checkin));
const projectedNight = new Set();
bgBooked.forEach((b) => { for (let d = b.ci; d < b.co; d++) projectedNight.add(d); });
const nights = [];
for (let d = dispS; d < dispE; d++) {
const inBlock = d >= wS && d < wE;
nights.push({ date: dayStr(d), weekend: weekendNight(d), existing: !!occ0[ri][d - base], request: d >= ci && d < co, inBlock, projected: !inBlock && projectedNight.has(d), accept: inBlock ? nightA[d - wS] / runs : null, reject: inBlock ? nightR[d - wS] / runs : null });
}
return {
modelVersion: MODEL_VERSION,
room: { key: room.key, label: room.label },
window: { start: dayStr(wS), end: dayStr(wE), nights: wE - wS, capped },
display: { start: dayStr(dispS), end: dayStr(dispE), nights: dispE - dispS },
projected,
request: { checkin: request.checkin, checkout: request.checkout, nights: co - ci, payout, weighted, guestFactor, guestWhy, channelFactor },
cancel: { rate: pC, lateShare: qL, wNone, wLate, wEarly, latePay, earlyPossible },
existingIncome,
existingList: existingList.sort((a, b) => a.checkin.localeCompare(b.checkin)),
costs: { firstClean, extraClean, hassleWd: Number(s.hassleWeekday), hassleWe: Number(s.hassleWeekend), secondPct },
accept: { mean: accept, p10: pct(totA, 0.1), p90: pct(totA, 0.9), parts: meanA, scen: { none: meanOf(sumN), late: wLate > 0 ? meanOf(sumL) : null, early: wEarly > 0 ? meanOf(sumE) : null } },
reject: { mean: reject, p10: pct(totR, 0.1), p90: pct(totR, 0.9), parts: meanR },
diff,
pRejectBetter: diffs.filter((x) => x < 0).length / runs,
breakEven,
recommendation,
ownUseNights,
nights,
examples,
neighbours: neighbourStays(ctx, ri, ci, co),
existingStays: existing.filter((x) => ri2.get(x.listingId) === ri && dayNum(x.checkout) > dispS && dayNum(x.checkin) < dispE).map((x) => ({ id: x.id, checkin: x.checkin, checkout: x.checkout, guest: x.guest, amount: Number(x.income) > 0 ? Math.round(Number(x.income)) : null })).sort((a, b) => a.checkin.localeCompare(b.checkin)),
runs,
assumptions: describeAssumptions(ctx, params, ri, ci),
assumptionsSnap: assumptionsSnapshot(ctx, params),
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
function discountText(s) {
const d = discountsOf(s);
const sn = d.shortNotice.filter((x) => Number(x.days) > 0).map((x) => `${x.pct}% within ${x.days} days`);
const ln = d.length.filter((x) => Number(x.nights) > 0).map((x) => `${x.pct}% for ${x.nights}+ nights`);
return [...sn, ...ln].join(', ') || 'none set';
}

function describeAssumptions(ctx, params, ri, ci) {
const s = ctx.s;
const m = monthOf(ci);
const lead = leadFor(params, ci);
const price = params.prices[ri];
const o = params.occ[ri];
const fmtMoney = (v) => `£${Math.round(v)}`;
const d = demandFor(ctx, params, ri);
const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m];
const demandSource = `London's season for ${mon} ×${MARKET_SEASON[m].toFixed(2)} (${MARKET_CREDIT}); this room's level ${d.L.toFixed(2)} a date, ${d.n ? `from ${d.n} request${d.n === 1 ? '' : 's'} since ${d.from} set against the dates and stay lengths that were open to request each week` : `from the ${Math.round((o.overall ?? OCC_PRIOR) * 100)}% occupancy it has achieved (no requests of its own yet)`}${d.n ? `; ${mon} adjusted ×${d.adj[m].toFixed(2)} on ${d.N[m]} request${d.N[m] === 1 ? '' : 's'} for ${mon} dates` : ''}${(ctx.scale.demand || 1) !== 1 ? `; review factor ×${(ctx.scale.demand || 1).toFixed(2)}` : ''}`;
return [
{ id: 'price', label: 'Raw nightly rate (before discounts and the cleaning fee)', value: `${fmtMoney(basePrice(ctx, params, ri, ci))}${price.uplift > 1.005 ? ` (Fri/Sat ×${price.uplift.toFixed(2)})` : ''}`, source: price.source },
{ id: 'discounts', label: 'Discounts the rate is worked back through', value: discountText(ctx.s), source: price.n ? `undone on ${price.n} stays: on average ${(price.avgShortNotice * 100).toFixed(1)}% short notice, ${(price.avgLength * 100).toFixed(1)}% length` : 'your setting' },
{ id: 'cleanfee', label: 'Cleaning fee guests pay (income per booking)', value: fmtMoney(price.clean), source: ctx.rooms[ri].cleaningIncome != null && ctx.rooms[ri].cleaningIncome !== '' ? 'your setting' : price.n ? 'median of your earnings export' : 'none known' },
{ id: 'demand', label: `Requests expected per check-in date in ${mon} (any stay length, before availability)`, value: lambdaFor(ctx, params, ri, m).toFixed(2), source: demandSource, editable: 'demand' },
{ id: 'lead', label: 'Median days ahead bookings arrive', value: `${Math.round(lead.median)} days`, source: `your guide (Settings)${Math.abs(params.leadShift || 0) > 0.05 && ci != null && !isChristmas(ci) ? `, scaled x${Math.exp(params.leadShift).toFixed(2)} to match how far ahead your ${params.leadN} requests arrived, allowing for the dates that were already taken when each one came` : ''}`, editable: 'lead' },
{ id: 'leadspread', label: 'Share of bookings made in the last 3 / 7 days', value: `${Math.round(normCdf((Math.log(3.5) - lead.mu) / params.leadSigma) * 100)}% / ${Math.round(normCdf((Math.log(7.5) - lead.mu) / params.leadSigma) * 100)}%`, source: params.leadN ? `a lead-time spread of ${params.leadSigma.toFixed(2)}, fitted to your ${params.leadN} requests (declined ones included) and blended with the Airbnb-wide shape` : `a lead-time spread of ${params.leadSigma.toFixed(2)}, the Airbnb-wide shape (no requests of your own yet)` },
{ id: 'los', label: 'Average stay length', value: `${params.losMean.toFixed(1)} nights`, source: params.losN ? `your requests and stays (${Math.round(params.losN)}), each set against the stay lengths that could be booked when it arrived; a length you have rarely or never allowed follows a rule of thumb instead (a stay twice as long is half as common)` : 'a rule of thumb (a stay twice as long is half as common)' },
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

// ---- Projecting every void ---------------------------------------------------------------------
//
// The same simulation as evaluate(), turned on every room's free nights between today and the end
// of the month after the current one, with no request in the picture. A "void" is a run of free
// nights in one room (between bookings, or today, or the window end). Each run of the simulation
// plays random arrivals into the real calendars; averaging many runs gives, for every night, the
// chance it gets booked and what it earns, and so an expected income for every void, the whole
// window and each month, plus the expected cumulative nights booked by arrival date (the pace
// chart's Nights booked line). One run, the one closest to the average, is kept as a
// representative scenario to draw as ghost bookings. It is gross income: cleaning, changeover
// hassle and what empty nights are worth to you belong to the accept/reject comparison.

function defaultProjectionEnd(today, months = 3) {
const [y, m] = today.split('-').map(Number);
return new Date(Date.UTC(y, m - 1 + months, 1)).toISOString().slice(0, 10); // first of the month `months` on: by default the window runs to the end of the third month
}

// The listing in a room that currently takes its bookings: the one with most stays starting within
// two months either side of today (a one-off booking elsewhere in the year doesn't change who the
// room is let for); failing that, the one with the latest stay.
function ownerListingOf(ctx, room) { return activeListingId(room.listingIds, ctx.stays, ctx.today); }

// Returns {step(n) -> done, finish() -> result, runs}, so a caller can run it in slices and keep the
// page responsive; projectVoids() runs it straight through.
// `play` (optional) changes only how the arrivals are played, never the demand they are calibrated to:
// {minNights: {roomKey: n}, s: {gapDiscountPct, gapMaxNights, ...}}. That is what lets a what-if (allow
// 1-night stays, cut the price) be compared fairly with the same demand. `params` reuses a calibration
// already made; `roomKeys` limits the simulation to those rooms.
function makeProjection(ctx = buildContext(), { from, to, runs = PROJECT_RUNS, play = null, params: givenParams = null, roomKeys = null, boostPct = 0 } = {}) {
const params = givenParams || calibrate(ctx);
const plans = normalisePlans(ctx);
const pctx = { ...ctx, s: play && play.s ? { ...ctx.s, ...play.s } : ctx.s, plans, planMaxPct: Math.max(Number(boostPct) || 0, ...plans.map((p) => p.pct)) };
const T = dayNum(ctx.today);
const wS = Math.max(T, dayNum(from || ctx.today));
const wE = dayNum(to || defaultProjectionEnd(ctx.today));
if (!ctx.rooms.length) return { error: 'No rooms are set up for the evaluator (Settings, Booking evaluator, Rooms).' };
if (!(wE > wS)) return { error: 'The window to project is empty.' };
const W = wE - wS;
const nRooms = ctx.rooms.length;
const ri2 = roomIndexOf(ctx);
const existing = ctx.stays.filter((x) => x.status === 'stay' && !x.unconfirmed && ri2.has(x.listingId));
const base = Math.max(T - 1, wS - BEFORE);
const len = wE + AFTER - base;
const occ0 = ctx.rooms.map(() => new Uint8Array(len));
existing.forEach((x) => {
const r = ri2.get(x.listingId);
for (let d = dayNum(x.checkin); d < dayNum(x.checkout); d++) if (d >= base && d < base + len) occ0[r][d - base] = 1;
});
// A room is blocked by the blocks on the listing in use for it (a sibling listing may be blocked all winter without the room being).
ctx.rooms.forEach((room, r) => {
const active = ownerListingOf(ctx, room);
roomBlocks(ctx.blocks, (ctx.feedListingIds || []).includes(active) ? [active] : []).forEach((b) => {
for (let d = dayNum(b.from); d < dayNum(b.to); d++) if (d >= base && d < base + len) occ0[r][d - base] = 1;
});
});
for (let d = base; d < T; d++) occ0.forEach((o) => { o[d - base] = 1; }); // the past can't be booked

// The voids: runs of free nights per room inside the window.
const voids = [];
const voidAt = ctx.rooms.map(() => new Int16Array(W).fill(-1));
ctx.rooms.forEach((room, r) => {
let d = wS;
while (d < wE) {
if (occ0[r][d - base]) { d++; continue; }
let e = d;
while (e < wE && !occ0[r][e - base]) e++;
const id = voids.length;
voids.push({ r, a: d, b: e, open: e === wE && !occ0[r][wE - base] });
for (let k = d; k < e; k++) voidAt[r][k - wS] = id;
d = e;
}
});

const lamCache = new Map();
const lam = (r, c) => { const k = `${r}|${monthOf(c)}`; if (!lamCache.has(k)) lamCache.set(k, lambdaFor(ctx, params, r, monthOf(c))); return lamCache.get(k); };
const roomsIdx = ctx.rooms.map((_, i) => i).filter((i) => !roomKeys || roomKeys.includes(ctx.rooms[i].key));
const minNights = Object.fromEntries(ctx.rooms.map((r, i) => [i, play && play.minNights && play.minNights[r.key] != null ? Number(play.minNights[r.key]) : (Number(r.minNights) || 1)]));
// A room whose minimum is lowered below the one its demand was calibrated under also gets the 1-night requests it was hiding.
const oneNightFrac = (Number(ctx.s.oneNightDemandPct ?? ONE_NIGHT_DEMAND_PCT) || 0) / 100;
const extra = {};
ctx.rooms.forEach((r, i) => { if (minNights[i] < (Number(r.minNights) || 1)) extra[i] = oneNightFrac; });
const rng = mulberry32(hashStr(`proj|${MODEL_VERSION}|${ctx.today}|${wS}|${wE}|${JSON.stringify({ ...ctx.s, voidPlans: undefined })}|${JSON.stringify(ctx.scale)}`));
const rngX = mulberry32(hashStr(`projx|${MODEL_VERSION}|${ctx.today}|${wS}|${wE}|${JSON.stringify({ ...ctx.s, voidPlans: undefined })}|${JSON.stringify(ctx.scale)}`));

const monthKeys = [];
for (let d = wS; d < wE; d++) { const ym = dayStr(d).slice(0, 7); if (monthKeys[monthKeys.length - 1] !== ym) monthKeys.push(ym); }
const monthIdx = new Int8Array(W);
for (let i = 0; i < W; i++) monthIdx[i] = monthKeys.indexOf(dayStr(wS + i).slice(0, 7));
const nArr = wE - T + 1;
const arrivedNights = monthKeys.map(() => new Float64Array(nArr)); // expected nights, by arrival day, per stay month
const arrivedByRoom = ctx.rooms.map(() => monthKeys.map(() => new Float64Array(nArr))); // the same, per room

const nightBooked = ctx.rooms.map(() => new Float64Array(W));
const nightIncome = ctx.rooms.map(() => new Float64Array(W));
const voidIncome = voids.map(() => new Float64Array(runs));
const voidNights = voids.map(() => new Float64Array(runs));
const runTotal = new Float64Array(runs);
const stayEnds = ctx.rooms.map(() => new Float64Array(W)); // new stays ending each day, summed over runs
const stayNightsEnd = ctx.rooms.map(() => new Float64Array(W));
const runBookings = [];
const state = { run: 0 };

const step = (n) => {
for (let k = 0; k < n && state.run < runs; k++, state.run++) {
const run = state.run;
const arrivals = drawArrivals(pctx, params, { from: base, to: wE + AFTER, todayN: T, lam, rooms: roomsIdx, extra, rngX }, rng);
const occ = occ0.map((o) => o.slice());
const booked = playArrivals(pctx, params, arrivals, occ, base, { minNights, len });
const list = [];
let total = 0;
booked.forEach((b) => {
const a = Math.max(b.ci, wS); const z = Math.min(b.co, wE);
const ei = b.co - wS;
if (ei >= 0 && ei < W) { stayEnds[b.room][ei] += 1; stayNightsEnd[b.room][ei] += b.co - b.ci; }
if (z <= a) return;
let amount = 0;
const off = Math.min(nArr - 1, Math.max(0, Math.floor(b.at) - T));
for (let d = a; d < z; d++) {
const v = basePrice(ctx, params, b.room, d) * b.factor;
const i = d - wS;
amount += v;
nightIncome[b.room][i] += v; nightBooked[b.room][i] += 1;
const vid = voidAt[b.room][i];
if (vid >= 0) { voidIncome[vid][run] += v; voidNights[vid][run] += 1; }
arrivedNights[monthIdx[i]][off] += 1;
arrivedByRoom[b.room][monthIdx[i]][off] += 1;
}
if (b.ci >= wS) {
const c0 = params.prices[b.room].clean; const i0 = a - wS;
amount += c0;
nightIncome[b.room][i0] += c0;
const vid0 = voidAt[b.room][i0];
if (vid0 >= 0) voidIncome[vid0][run] += c0;
}
total += amount;
list.push({ room: b.room, ci: a, co: z, amount });
});
runTotal[run] = total;
runBookings.push(list);
}
return state.run >= runs;
};

const finish = () => {
const n = Math.max(1, state.run);
const r2 = (v) => Math.round(v * 100) / 100;
const meanTotal = runTotal.reduce((a, b) => a + b, 0) / n;
// The representative run: closest to the average in total income AND in nights booked in each month, so the
// ghost bookings drawn on the charts agree with the expected nights shown beside them.
const runMonthNights = runBookings.map((list) => {
const per = monthKeys.map(() => 0);
list.forEach((b) => { for (let d = b.ci; d < b.co; d++) per[monthIdx[d - wS]] += 1; });
return per;
});
const meanMonth = monthKeys.map((_, mi) => { let a = 0; for (let i = 0; i < n; i++) a += runMonthNights[i][mi]; return a / n; });
let best = 0; let bestGap = Infinity;
for (let i = 0; i < n; i++) {
let g = Math.abs(runTotal[i] - meanTotal) / Math.max(1, meanTotal);
meanMonth.forEach((mm, mi) => { g += Math.abs(runMonthNights[i][mi] - mm) / Math.max(1, mm); });
if (g < bestGap) { bestGap = g; best = i; }
}
const roomInfo = ctx.rooms.map((room) => ({ key: room.key, label: room.label, listingId: ownerListingOf(ctx, room) }));
const mean = (xs) => { let a = 0; for (let i = 0; i < n; i++) a += xs[i]; return a / n; };
const voidOut = voids.map((v, id) => {
const inc = Array.from(voidIncome[id].subarray(0, n));
const nights = v.b - v.a;
const prob = []; const income = [];
for (let d = v.a; d < v.b; d++) { prob.push(r2(nightBooked[v.r][d - wS] / n)); income.push(r2(nightIncome[v.r][d - wS] / n)); }
return {
id: `${roomInfo[v.r].key}|${dayStr(v.a)}`, roomKey: roomInfo[v.r].key, roomLabel: roomInfo[v.r].label, listingId: roomInfo[v.r].listingId,
from: dayStr(v.a), to: dayStr(v.b), nights, open: v.open,
expected: r2(mean(inc)), p10: r2(pct(inc, 0.1)), p90: r2(pct(inc, 0.9)), expectedNights: r2(mean(Array.from(voidNights[id].subarray(0, n)))),
nightProb: prob, nightIncome: income,
};
});
// By month: per room, income and nights expected (the by-day figures live in the voids), and the
// cumulative nights booked by arrival day.
const months = {};
monthKeys.forEach((ym, mi) => {
const rooms = {};
let incomeAll = 0; let nightsAll = 0;
ctx.rooms.forEach((room, r) => {
let inc = 0; let nts = 0;
for (let i = 0; i < W; i++) {
if (monthIdx[i] !== mi) continue;
inc += nightIncome[r][i] / n; nts += nightBooked[r][i] / n;
}
const cumRoom = []; let runRoom = 0;
for (let i = 0; i < nArr; i++) { runRoom += arrivedByRoom[r][mi][i] / n; cumRoom.push(r2(runRoom)); }
rooms[room.key] = { income: r2(inc), nights: r2(nts), bookedByDate: cumRoom };
incomeAll += inc; nightsAll += nts;
});
const cum = []; let run = 0;
for (let i = 0; i < nArr; i++) { run += arrivedNights[mi][i] / n; cum.push(r2(run)); }
months[ym] = { income: r2(incomeAll), nights: r2(nightsAll), rooms, bookedByDate: cum };
});
const scenario = (runBookings[best] || []).map((b) => ({ roomKey: roomInfo[b.room].key, listingId: roomInfo[b.room].listingId, from: dayStr(b.ci), to: dayStr(b.co), nights: b.co - b.ci, amount: Math.round(b.amount) }))
.sort((a, b) => a.from.localeCompare(b.from));
const totals = Array.from(runTotal.subarray(0, n));
return {
modelVersion: MODEL_VERSION, today: ctx.today, from: dayStr(wS), to: dayStr(wE), runs: n,
rooms: roomInfo, voids: voidOut, months, scenario,
stayEnds: Object.fromEntries(ctx.rooms.map((room, r) => [room.key, { ends: Array.from(stayEnds[r], (v) => Math.round((v / n) * 1000) / 1000), nights: Array.from(stayNightsEnd[r], (v) => Math.round((v / n) * 1000) / 1000) }])),
total: { expected: r2(meanTotal), p10: r2(pct(totals, 0.1)), p90: r2(pct(totals, 0.9)), bookings: r2(runBookings.reduce((a, l) => a + l.filter((b) => b.ci >= wS).length, 0) / n) },
assumptions: assumptionsSnapshot(ctx, params),
};
};
return { step, finish, runs, params, get done() { return state.run >= runs; }, get progress() { return state.run / runs; } };
}

function projectVoids(ctx = buildContext(), opts = {}) {
const p = makeProjection(ctx, opts);
if (p.error) return p;
while (!p.step(200)) { /* run to the end */ }
return p.finish();
}

// ---- Dead voids (what is one: isDeadVoid in bookingprojection.js) -----------------------------
// What each way of selling a dead void is worth, on the same demand: as it is now, allowing 1-night
// stays (when the room has a longer minimum), and a discount on the void's nights (the gap discount the
// model already has, widened to cover this void), alone or together. Net = expected income less what
// cleaning the bookings costs. `runs` is per option; the same calibration is reused throughout.
function optimiseVoid(ctx, v, { runs = 1000, params = null } = {}) {
const room = ctx.rooms.find((r) => r.key === v.roomKey);
if (!room) return { error: 'That room is no longer set up.' };
const calib = params || calibrate(ctx);
const curMin = Number(room.minNights) || 1;
const curPct = Number(ctx.s.gapDiscountPct) || 0;
const curMax = Number(ctx.s.gapMaxNights) || 0;
const clean = ctx.firstClean;
const simulate = (minNights, pct) => {
const reach = Math.max(curMax, v.nights);
// Without any plan already set on this void, so the options are compared with each other and with doing nothing.
const bare = { ...ctx, s: { ...ctx.s, voidPlans: (ctx.s.voidPlans || []).filter((q) => !(q.roomKey === v.roomKey && q.from < v.to && q.to > v.from)) } };
const p = makeProjection(bare, { from: v.from, to: v.to, runs, params: calib, roomKeys: [room.key], boostPct: 40, play: { minNights: { [room.key]: minNights }, s: { gapDiscountPct: pct, gapMaxNights: pct > 0 ? reach : curMax } } });
if (p.error) return null;
while (!p.step(100)) { /* run to the end */ }
const r = p.finish();
const vo = r.voids.find((x) => x.roomKey === room.key && x.from === v.from);
if (!vo) return null;
const bookings = r.total.bookings || 0;
return { minNights, pct, income: vo.expected, nights: vo.expectedNights, bookings, net: Math.round((vo.expected - bookings * clean) * 100) / 100 };
};
// As it is now: the room's own minimum and whatever gap discount applies to a gap this long.
const base = simulate(curMin, v.nights <= curMax ? curPct : 0);
if (!base) return { error: 'Could not simulate this void.' };
const options = [];
const mins = curMin > 1 ? [curMin, 1] : [1];
const pcts = [0, 10, 20, 30, 40];
mins.forEach((m) => pcts.forEach((pct) => {
if (m === curMin && pct === 0) return;
const o = simulate(m, pct);
if (o) options.push(o);
}));
options.sort((a, b) => b.net - a.net);
const top = options[0] || null;
// Only worth acting on if it clearly beats leaving it alone.
const best = top && top.net - base.net >= Math.max(3, Math.abs(base.net) * 0.03) ? top : null;
return { base, options, best, curMin, clean, gain: best ? Math.round((best.net - base.net) * 100) / 100 : 0 };
}

// What the model assumed when it made a projection, kept with it so a later review can say why it
// was off: per room and month of the year, the occupancy and request rate; and the shared figures.
function assumptionsSnapshot(ctx, params) {
const s = ctx.s;
const months = [];
for (let m = 0; m < 12; m++) {
months.push({ lead: Math.round(params.lead[m].median), n: params.lead[m].n });
}
return {
calibration: { demand: ctx.scale.demand || 1, lead: ctx.scale.lead || 1, cancel: ctx.scale.cancel || 1 },
elasticity: Number(s.elasticity) || 0, leadSigma: Math.round(params.leadSigma * 100) / 100, cancelRate: Math.round(params.cancelRate * 1000) / 1000, lateShare: Math.round(params.lateShare * 1000) / 1000,
meanStay: Math.round(params.losMean * 10) / 10, leadMedianByMonth: months.map((x) => x.lead), christmasLead: Math.round(params.lead[12].median),
rooms: ctx.rooms.map((room, i) => ({ key: room.key, occupancy: params.occ[i].overall == null ? null : Math.round(params.occ[i].overall * 100) / 100, monthsOnOffer: params.occ[i].months, minNights: Number(room.minNights) || 1, price: Math.round(params.prices[i].base) })),
};
}

// ---- Self-test: cases with an answer that can be worked out by hand ----------------------------

function testContext({ occupancy, today = '2026-11-01', minNights = 1 }) {
const s = { ...DEFAULT_PREFS.bookingEvaluator, discounts: { airbnb: { shortNotice: [], length: [] }, direct: { shortNotice: [], length: [] } }, gapDiscountPct: 0 };
const ctx = {
today, s, firstClean: 50,
rooms: [{ key: 'A', label: 'Room A', listingIds: ['LA'], include: true, weight: 1, minNights, priceWeekday: 100, priceWeekend: 100 }],
stays: [], requests: [], proposals: [], listingLabels: { LA: 'Room A' }, scale: {},
};
calibrate(ctx);
ctx.params.cancelRate = 0;
ctx.params.occ = [{ byMonth: new Array(12).fill(occupancy), byMonthN: new Array(12).fill(1), byMonthW: new Array(12).fill(1), byMonthBookings: new Array(12).fill(3), overall: occupancy, months: 12 }];
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

// 5. Voids partition the free nights exactly: one booking in the middle leaves two voids, and their
// nights add up to the window less the booked nights.
const ctx5 = testContext({ occupancy: 0.5 });
ctx5.stays = [{ id: 's1', listingId: 'LA', checkin: '2026-11-10', checkout: '2026-11-14', status: 'stay', income: 400, guest: 'X' }];
const p5 = projectVoids(ctx5, { from: '2026-11-01', to: '2026-12-01', runs: 40 });
const free5 = 30 - 4;
check('Voids partition the free nights', p5.voids.length === 2 && p5.voids.reduce((a, v) => a + v.nights, 0) === free5 && p5.voids[0].to === '2026-11-10' && p5.voids[1].from === '2026-11-14', p5.voids.map((v) => `${v.from}>${v.to}`).join(' '));

// 6. No demand: nothing is expected anywhere. A void that reaches the window end is flagged open.
const ctx6 = testContext({ occupancy: 0.5 });
ctx6.stays = ctx5.stays;
ctx6.params.lambda = new Map(Array.from({ length: 12 }, (_, m) => [`0|${m}`, 0]));
const p6 = projectVoids(ctx6, { from: '2026-11-01', to: '2026-12-01', runs: 20 });
check('No demand: every void expects nothing', p6.voids.every((v) => v.expected === 0 && v.expectedNights === 0) && p6.total.expected === 0 && p6.voids[1].open === true && p6.voids[0].open === false, `${p6.total.expected}`);

// 7. Saturating demand: voids fill at the base price.
const ctx7 = testContext({ occupancy: 0.97, today: '2026-10-01' }); // a month ahead, so every night has had time to be asked for
ctx7.stays = ctx5.stays;
ctx7.params.lambda = new Map(Array.from({ length: 12 }, (_, m) => [`0|${m}`, 40]));
const p7 = projectVoids(ctx7, { from: '2026-11-01', to: '2026-12-01', runs: 40 });
const share7 = p7.voids.reduce((a, v) => a + v.expectedNights, 0) / free5;
check('Saturated demand: voids fill at about £100 a night', share7 > 0.95 && p7.total.expected > 0.95 * 100 * free5 && p7.total.expected <= 100 * free5 + 0.01, `${(share7 * 100).toFixed(0)}% £${p7.total.expected}`);

// 8. The projection is deterministic.
const q1 = projectVoids(testContext({ occupancy: 0.5 }), { from: '2026-11-01', to: '2026-12-01', runs: 40 });
const q2 = projectVoids(testContext({ occupancy: 0.5 }), { from: '2026-11-01', to: '2026-12-01', runs: 40 });
check('Projection is deterministic', q1.total.expected === q2.total.expected, `${q1.total.expected} / ${q2.total.expected}`);

// 10. Raw nightly rate: the payout with the cleaning fee out, discounts undone (Stacey Smith, Josie Wilson from your export).
const disc10 = { shortNotice: [{ days: 10, pct: 5 }, { days: 5, pct: 10 }], length: [] };
const stacey = rawNightlyRate({ amount: 433.55, cleaning: 95, nights: 3, leadDays: 13 }, disc10);
const josie = rawNightlyRate({ amount: 1847.99, cleaning: 70, nights: 16, leadDays: 128 }, disc10);
check('Raw rate: payout less cleaning fee over nights', Math.abs(stacey.raw - 112.85) < 0.005 && Math.abs(josie.raw - 111.1244) < 0.001, `${stacey.raw.toFixed(3)} / ${josie.raw.toFixed(3)}`);
// 11. Short-notice steps: 4 days takes 10%, 8 days 5%, 12 days nothing; a 10% discount is undone.
const steps = [stepPct(disc10.shortNotice, 'days', 4), stepPct(disc10.shortNotice, 'days', 8), stepPct(disc10.shortNotice, 'days', 12)];
const short4 = rawNightlyRate({ amount: 90, cleaning: 0, nights: 2, leadDays: 4 }, disc10);
check('Discount steps and undoing them', steps.join() === '0.1,0.05,0' && Math.abs(short4.raw - 50) < 1e-9, `${steps.join()} ${short4.raw}`);
// 12. The cleaning fee guests pay is income on every simulated booking.
const ctx12 = testContext({ occupancy: 0.97, today: '2026-10-01' });
ctx12.stays = ctx5.stays;
ctx12.params.lambda = new Map(Array.from({ length: 12 }, (_, m) => [`0|${m}`, 40]));
ctx12.params.prices[0].clean = 40;
const p12 = projectVoids(ctx12, { from: '2026-11-01', to: '2026-12-01', runs: 40 });
check('Cleaning fee income is added per booking', p12.total.expected > p7.total.expected + 30, `£${p12.total.expected} vs £${p7.total.expected}`);

// 9. A window that crosses the year end splits into months correctly.
const q3 = projectVoids(testContext({ occupancy: 0.5, today: '2026-12-10' }), { runs: 20 });
check('Default window runs to the end of the third month', q3.to === '2027-03-01' && Object.keys(q3.months).join() === '2026-12,2027-01,2027-02' && defaultProjectionEnd('2026-12-10', 6) === '2027-06-01', `${q3.to} ${Object.keys(q3.months).join()}`);

// 10. Demand is recovered from requests: a year of requests drawn at a known level on London's shape, of which only
// stays of PAST_MIN_NIGHTS or more could be made, gives that level back; and it still does when a four-month booking
// hides every request that would have touched it (the level must not fall because the calendar was full).
const TRUE_LEVEL = 0.5;
const demandCase = (blockFrom, blockTo) => {
const c13 = testContext({ occupancy: 0.6 });
const tN = dayNum(c13.today);
const arr = drawArrivals(c13, c13.params, { from: tN - 500, to: tN + 400, todayN: null, lam: (ri, c) => TRUE_LEVEL * MARKET_SEASON[monthOf(c)], rooms: [0] }, mulberry32(hashStr('demand-test')));
const seen = arr.filter((a) => a.at >= tN - 364 && a.at < tN && a.los >= PAST_MIN_NIGHTS && !(blockFrom != null && a.c < blockTo && a.c + a.los > blockFrom));
c13.requests = seen.map((a, i) => ({ id: `q${i}`, listingId: 'LA', kind: 'request', receivedAt: `${dayStr(a.at)}T12:34:56.000Z`, checkin: dayStr(a.c), checkout: dayStr(a.c + a.los) }));
// The long booking is itself an ask on the day it was made (asksFor), and the weeks counted start at the first ask:
// it is dated at the start of the year of requests, not before it, so no weeks without requests are counted.
if (blockFrom != null) c13.stays = [{ id: 'long', listingId: 'LA', checkin: dayStr(blockFrom), checkout: dayStr(blockTo), status: 'stay', bookedOn: dayStr(tN - 364), income: 1, guest: 'L' }];
return demandFor(c13, c13.params, 0);
};
const dOpen = demandCase(null, null);
check('Demand level recovered from requests on an open calendar', Math.abs(dOpen.L / TRUE_LEVEL - 1) < 0.2, `${dOpen.L.toFixed(3)} from ${dOpen.n} requests (true ${TRUE_LEVEL})`);
const t13 = dayNum('2026-11-01');
const dHeld = demandCase(t13 - 240, t13 - 120);
check('Demand level unchanged by a long booking that hid requests', Math.abs(dHeld.L / TRUE_LEVEL - 1) < 0.2 && dHeld.n < dOpen.n * 0.85, `${dHeld.L.toFixed(3)} from ${dHeld.n} requests (open calendar: ${dOpen.n})`);

// 13. Closed loop: a made-up room with a known demand level, lead-time curve and stay-length curve is run forward for
// 900 days as a real calendar (requests arrive, the ones that fit and meet the minimum stay are seen, most of those
// book and take their nights), with the minimum stay dropping from 5 nights to 1 a year before today. Only what the
// app would hold is kept: the requests of the last 740 days and the stays with their booking dates. Calibrating on
// those must give the world back. The true stay lengths are deliberately not the 1 / nights rule of thumb, so this
// also shows the requests overriding it. Tolerances: level within 25% of the true one, lead-time shift and spread
// within 0.3, stay-length shares within 0.25 in total (half the summed absolute differences). They were set from an
// offline copy of this test (not this code run): see the B2 notes in audit-2026-11b/FIXES.md for its numbers.
const WORLD = { level: 0.8, shift: -0.4, sigma: 1.1, minBefore: PAST_MIN_NIGHTS, minAfter: 1 };
const worldLos = new Array(LOS_MAX + 1).fill(0.1 / (LOS_MAX - 7));
[0, 0.12, 0.24, 0.2, 0.13, 0.09, 0.06, 0.06].forEach((v, i) => { worldLos[i] = v; });
const cw = testContext({ occupancy: 0.6 });
const tW = dayNum(cw.today);
const wp = cw.params;
wp.losCdf = []; worldLos.reduce((acc, v, i) => { wp.losCdf[i] = acc + v; return acc + v; }, 0);
wp.leadSigma = WORLD.sigma;
wp.lead = wp.lead.map((l, i) => ({ ...l, mu: Math.log(l.prior + 0.5) + (i === 12 ? 0 : WORLD.shift) }));
const arrW = drawArrivals(cw, wp, { from: tW - 900, to: tW + 450, todayN: null, lam: (ri, c) => WORLD.level * MARKET_SEASON[monthOf(c)], rooms: [0] }, mulberry32(hashStr('closed-loop')));
const baseW = tW - 900; const lenW = 900 + 450 + LOS_MAX + 2;
const calW = new Uint8Array(lenW);
const reqW = []; const stayW = [];
for (const a of arrW) {
if (a.at >= tW) break;
const i0 = a.c - baseW; const i1 = i0 + a.los;
let free = true;
for (let i = i0; i < i1; i++) if (calW[i]) { free = false; break; }
if (!free) continue;
let gs = i0; while (gs > 0 && !calW[gs - 1]) gs--;
let ge = i1; while (ge < lenW && !calW[ge]) ge++;
const boundedL = gs > 0; const boundedR = ge < lenW;
const exactFill = i0 === gs && i1 === ge && boundedL && boundedR;
const min = a.at < tW - 364 ? WORLD.minBefore : WORLD.minAfter;
if (a.los < min && !exactFill) continue; // could not be requested: never seen
const t = Math.floor(a.at);
// Seen. Declined (the same rule as playArrivals) if it would strand a gap shorter than the minimum, unless it is within a week.
const orphan = (boundedL && i0 - gs > 0 && i0 - gs < min) || (boundedR && ge - i1 > 0 && ge - i1 < min);
let sid = null;
if (!(orphan && a.lead > 7)) {
for (let i = i0; i < i1; i++) calW[i] = 1;
sid = `w${stayW.length}`;
stayW.push({ id: sid, listingId: 'LA', checkin: dayStr(a.c), checkout: dayStr(a.c + a.los), status: 'stay', bookedOn: dayStr(t), income: 100 * a.los, guest: 'W' });
}
if (t >= tW - 740) reqW.push({ id: `r${reqW.length}`, listingId: 'LA', kind: 'request', receivedAt: `${dayStr(t)}T12:00:00.000Z`, checkin: dayStr(a.c), checkout: dayStr(a.c + a.los), ...(sid ? { reservationId: sid } : {}) });
}
const ce = { ...testContext({ occupancy: 0.6 }), params: undefined, gridCache: undefined, demandCache: undefined, stays: stayW, requests: reqW, calRuns: 40 };
const pe = calibrate(ce);
const de = demandFor(ce, pe, 0);
const losE = pe.losCdf.map((v, i) => (i ? v - pe.losCdf[i - 1] : 0));
const losGap = worldLos.reduce((acc, v, i) => acc + (i ? Math.abs(v - losE[i]) : 0), 0) / 2;
check('Closed loop: demand level recovered from a simulated calendar', Math.abs(de.L / WORLD.level - 1) < 0.25, `L ${de.L.toFixed(3)} against a true ${WORLD.level} (ratio ${(de.L / WORLD.level).toFixed(2)}; occupancy-based start ${de.L0.toFixed(3)}) from ${de.n} asks, ${stayW.length} stays`);
check('Closed loop: lead-time curve recovered from requests', Math.abs(pe.leadShift - WORLD.shift) < 0.3 && Math.abs(pe.leadSigma - WORLD.sigma) < 0.3, `shift ${pe.leadShift.toFixed(3)} (true ${WORLD.shift}), spread ${pe.leadSigma.toFixed(3)} (true ${WORLD.sigma})`);
check('Closed loop: stay lengths recovered through a minimum stay that dropped from 5 to 1', losGap < 0.25, `shares differ by ${losGap.toFixed(3)} in total; 1 to 4 nights ${(pe.losCdf[4] * 100).toFixed(0)}% (true ${Math.round(worldLos.slice(1, 5).reduce((x, y) => x + y, 0) * 100)}%); 1 to 7 nights: ${losE.slice(1, 8).map((v) => v.toFixed(2)).join(' ')}`);

// 14. A stay with no request and no earnings row is an ask on the day it was booked, once; with no booking date it
// is not an ask at all; and a stay a request or an earnings row already stands for adds nothing.
const cu = testContext({ occupancy: 0.6 });
cu.requests = [
{ id: 'q1', listingId: 'LA', kind: 'request', receivedAt: '2026-09-01T10:00:00.000Z', checkin: '2026-09-20', checkout: '2026-09-23', reservationId: 'm1' },
{ id: 'q2', listingId: 'LA', kind: 'request', receivedAt: '2026-09-10T10:00:00.000Z', checkin: '2026-10-05', checkout: '2026-10-08' },
{ id: 'q3', listingId: 'LA', kind: 'request', receivedAt: '2026-07-15T10:00:00.000Z', checkin: '2026-08-02', checkout: '2026-08-05', confirmationCode: 'HMC3' },
];
cu.earnings = [{ listingId: 'LA', guest: 'E', code: 'HME1', start: '2026-08-10', nights: 2, amount: 200, cleaningFee: 0, bookingDate: '2026-08-01' }];
const stayU = (id, checkin, checkout, more) => ({ id, listingId: 'LA', checkin, checkout, status: 'stay', income: 300, guest: id, ...more });
cu.stays = [
stayU('m1', '2026-09-21', '2026-09-23', { bookedOn: '2026-09-02' }), // its request, by reservation
stayU('m2', '2026-10-05', '2026-10-08', { bookedOn: '2026-09-11' }), // its request, by listing and check-in
stayU('m3', '2026-08-03', '2026-08-05', { bookedOn: '2026-07-16', code: 'HMC3' }), // its request, by confirmation code
stayU('m4', '2026-08-10', '2026-08-12', { bookedOn: '2026-08-02' }), // the earnings row, by listing and check-in
stayU('m5', '2026-08-20', '2026-08-22', { bookedOn: '2026-08-03', code: 'HME1' }), // the earnings row, by confirmation code
stayU('u1', '2026-07-10', '2026-07-14', { bookedOn: '2026-06-20' }), // nothing stands for it: an ask on 20 Jun
stayU('u1b', '2026-07-10', '2026-07-14', { bookedOn: '2026-06-21' }), // a second record of the same stay
stayU('u2', '2026-07-20', '2026-07-24', {}), // no booking date: not an ask
];
const asksU = asksFor(cu, new Set(['LA']));
const fromStays = asksU.filter((a) => a.unmatched);
const dU = demandFor(cu, cu.params, 0);
check('Unmatched stays: a dated one is one ask on its booking date, an undated one none, matched ones none', asksU.length === 5 && fromStays.length === 1 && fromStays[0].t === dayNum('2026-06-20') && fromStays[0].checkin === dayNum('2026-07-10') && fromStays[0].nights === 4 && dU.n === 5, `${asksU.length} asks (3 requests, 1 earnings row, ${fromStays.length} from stays${fromStays[0] ? `, dated ${dayStr(fromStays[0].t)}` : ''}); demand counts ${dU.n}`);
return results;
}

// The calibrated model's own pieces, read by the drift charts (js/features/modeldrift.js) to compare inputs with reality.
const driftKit = { lambdaFor, demandFor, asksFor, availabilityOf, leadCdf, leadFor, basePrice, roomIndexOf, dayNum, dayStr, dowOf, monthOf };
export { driftKit, buildContext, calibrate, evaluate, sensitivity, makeProjection, projectVoids, optimiseVoid, defaultProjectionEnd, rawNightlyRate, stepPct, discountsOf, selfTest, MODEL_VERSION, demandFactorOf };
