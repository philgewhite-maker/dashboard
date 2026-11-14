// Backtest of the booking model: does it project well on the real history?
//
// For each past date T it rebuilds the world as it was known on T (see truncate below for every rule), calibrates the
// model on that alone, projects T .. T + horizon, and compares the projection with what was actually booked after T
// for those nights. Nothing is saved: it reads the live data through the model's own buildContext, works on deep
// copies, and returns a plain object. It writes to no state, no storage and no network.
//
// It uses only what both model versions export (MODEL_VERSION, buildContext, calibrate, makeProjection), so the same
// harness scores the committed model and the working-tree one: pass another module as opts.model.
//
// Run it from the browser console (relative path, so it also resolves on the live site):
//   const r = await (await import('./js/features/modelbacktest.js')).backtest(); console.table(r.rows); r
//
// opts:
//   asOf           ['YYYY-MM-DD', ...]  dates to stand on. Default: the first of each of the last 9 months that
//                  leaves `horizon` days of known outcome before today.
//   horizon        days projected from each date (default 90)
//   runs           simulation runs per date (default 1500; the model's own default is 3000)
//   model          a bookingmodel module object (default: the one this page serves)
//   reviewFactors  'neutral' (default) sets the monthly review's demand/lead/cancel factors to 1, because they were
//                  learned from outcomes after T; 'current' keeps today's factors (a known leak, for comparison)
//   keepPlans      true keeps today's void plans (default false: a plan for a past window may post-date T)
//   today          override for today's date (testing only)
//   onProgress     (done, total, asOf) => void

const DAY_MS = 86400000;
const dayNum = (s) => Math.round(Date.parse(`${String(s).slice(0, 10)}T00:00:00Z`) / DAY_MS);
const dayStr = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const validDay = (s) => !!s && Number.isFinite(dayNum(s));
// The model's own fallback for a stay with no booking date, in the same order (availabilityOf): the request that
// became it, else two weeks before check-in.
const FALLBACK_DAYS = 14;

function defaultAsOf(today, horizon) {
const T = dayNum(today);
const out = [];
const [y, m] = today.split('-').map(Number);
for (let k = 0; out.length < 9 && k < 60; k++) {
const first = new Date(Date.UTC(y, m - 1 - k, 1)).toISOString().slice(0, 10);
if (dayNum(first) + horizon <= T) out.push(first);
}
return out.reverse();
}

// The day a stay was known from, and which rule gave it.
function knownFrom(x, reqAt) {
if (validDay(x.bookedOn)) return { day: dayNum(x.bookedOn), via: 'bookedOn' };
if (reqAt.has(x.id)) return { day: reqAt.get(x.id), via: 'request' };
return { day: dayNum(x.checkin) - FALLBACK_DAYS, via: 'fallback' };
}

// The world as it was known on day T. `full` is never changed: the copy is a structuredClone of it.
function truncate(full, asOf, opts, counts) {
const T = dayNum(asOf);
const ctx = structuredClone(full);
ctx.today = asOf;
// calibrate caches on the context; a copy must not inherit any.
delete ctx.params; delete ctx.gridCache; delete ctx.demandCache;

// Requests and enquiries: only those received by T. One with no received date cannot be placed in time, so it is
// left out (counted), rather than letting a possibly later request shape the stay-length and weekday mix.
const before = ctx.requests.length;
let undated = 0;
ctx.requests = ctx.requests.filter((q) => { if (!validDay(q.receivedAt)) { undated++; return false; } return dayNum(q.receivedAt) <= T; });
counts.requestsKept = ctx.requests.length; counts.requestsDropped = before - ctx.requests.length; counts.requestsUndatedDropped = undated;
const reqAt = new Map(ctx.requests.filter((q) => q.reservationId).map((q) => [q.reservationId, dayNum(q.receivedAt)]));

// Stays: only those booked by T. The booking date itself is left as it is on the record (blank stays blank), so the
// model applies its own fallback inside; the fallback here only decides whether the stay was known yet.
let viaRequest = 0; let viaFallback = 0; let revived = 0; let cancelUndated = 0; let droppedStays = 0;
ctx.stays = ctx.stays.filter((x) => {
if (!validDay(x.checkin)) return false;
const k = knownFrom(x, reqAt);
if (k.day > T) { droppedStays++; return false; }
if (k.via === 'request') viaRequest++;
if (k.via === 'fallback') viaFallback++;
if (x.status === 'cancelled') {
// Cancelled after T: it was a live booking on T. (Its income is not on the record once cancelled, so it holds
// its nights but adds no price sample.) Cancelled with no date: left cancelled, which the model treats as
// never having held its nights.
if (validDay(x.cancelledOn)) { if (dayNum(x.cancelledOn) > T) { x.status = 'stay'; x.cancelledOn = ''; revived++; } } else cancelUndated++;
}
return true;
});
counts.staysKept = ctx.stays.length; counts.staysDropped = droppedStays; counts.staysDatedByRequest = viaRequest; counts.staysDatedByFallback = viaFallback;
counts.cancellationsUndone = revived; counts.cancellationsUndated = cancelUndated;

// Earnings rows: only bookings made by T (same two-week fallback when the row has no booking date).
let earnFallback = 0;
const eBefore = ctx.earnings.length;
ctx.earnings = ctx.earnings.filter((e) => {
if (validDay(e.bookingDate)) return dayNum(e.bookingDate) <= T;
if (!validDay(e.start)) return false;
if (dayNum(e.start) - FALLBACK_DAYS > T) return false;
earnFallback++; return true;
});
counts.earningsKept = ctx.earnings.length; counts.earningsDropped = eBefore - ctx.earnings.length; counts.earningsDatedByFallback = earnFallback;
// Which stays an earnings row stands for, rebuilt from the rows that are left (buildContext matches them by confirmation code).
const codes = new Set(ctx.earnings.map((e) => e.code).filter(Boolean));
ctx.earnedStayIds = new Set(ctx.stays.filter((x) => x.code && codes.has(x.code)).map((x) => x.id));

// The monthly review's factors were fitted to outcomes after T.
if (opts.reviewFactors !== 'current') { ctx.scale = {}; if (ctx.s) ctx.s.calibration = {}; }
// Void plans are today's; one covering a past window may have been made after T.
if (!opts.keepPlans && ctx.s) ctx.s.voidPlans = [];
return ctx;
}

// Per room: the nights in [wS, wE) held by live stays in a context, as day -> {incremental, perNight}.
function nightsOf(ctx, wS, wE, roomOf, reqAt, T) {
const rooms = ctx.rooms.map(() => new Map());
ctx.stays.forEach((x) => {
if (x.status !== 'stay' || x.unconfirmed || !roomOf.has(x.listingId) || !validDay(x.checkin) || !validDay(x.checkout)) return;
const ci = dayNum(x.checkin); const co = dayNum(x.checkout);
if (co <= wS || ci >= wE || co <= ci) return;
const inc = Number(x.income) > 0 ? Number(x.income) / (co - ci) : null;
const after = T == null ? false : knownFrom(x, reqAt).day > T;
const m = rooms[roomOf.get(x.listingId)];
for (let d = Math.max(ci, wS); d < Math.min(co, wE); d++) if (!m.has(d)) m.set(d, { after, perNight: inc });
});
return rooms;
}

async function backtest(opts = {}) {
const t0 = performance.now();
const model = opts.model || await import('./bookingmodel.js');
const { MODEL_VERSION, buildContext, calibrate, makeProjection } = model;
const horizon = Math.max(1, Number(opts.horizon) || 90);
const runs = Math.max(50, Number(opts.runs) || 1500);
const full = buildContext(opts.today ? { today: opts.today } : {});
const today = full.today;
const asOf = (opts.asOf && opts.asOf.length ? opts.asOf.slice() : defaultAsOf(today, horizon)).sort();
const roomOf = new Map();
full.rooms.forEach((r, i) => r.listingIds.forEach((id) => roomOf.set(id, i)));
const fullReqAt = new Map(full.requests.filter((q) => q.reservationId && validDay(q.receivedAt)).map((q) => [q.reservationId, dayNum(q.receivedAt)]));

const perT = [];
const rows = [];
for (let n = 0; n < asOf.length; n++) {
const date = asOf[n];
const tStart = performance.now();
const T = dayNum(date);
const wS = T; const wE = T + horizon;
const counts = {};
const entry = { asOf: date, to: dayStr(wE), outcomeComplete: wE <= dayNum(today), truncation: counts };
perT.push(entry);
const ctx = truncate(full, date, opts, counts);
let proj = null;
try {
const params = calibrate(ctx);
const p = makeProjection(ctx, { from: date, to: dayStr(wE), runs, params });
if (p.error) entry.error = p.error;
else {
// In slices, giving the page a turn between them, so a long backtest does not freeze the tab.
while (!p.step(250)) await new Promise((res) => setTimeout(res, 0));
proj = p.finish();
}
// What the calibration settled on, so drift between dates is visible. demandCache is where the model keeps each
// room's demand level (both versions); it is filled by the projection.
const li = new Date(T * DAY_MS).getUTCMonth();
const cdf = params.losCdf || [];
entry.calibration = {
leadShift: r2(params.leadShift ?? null), leadSigma: r2(params.leadSigma), leadRequests: params.leadN ?? null,
leadMedianThisMonth: r2(params.lead[li].median), leadMedianByMonth: params.lead.slice(0, 12).map((x) => Math.round(x.median)),
stayMean: r2(params.losMean), stayMedian: cdf.findIndex((c, i) => i >= 1 && c >= 0.5), stayObservations: r2(params.losN),
cancelRate: r2(params.cancelRate),
rooms: ctx.rooms.map((room, i) => {
const d = ctx.demandCache && ctx.demandCache.get(i);
return { key: room.key, demandLevel: d ? r2(d.L) : null, startingLevel: d ? r2(d.L0) : null, requestsCounted: d ? d.n : null, weeksCounted: d ? d.weeks : null, requestsPerCheckinThisMonth: r2(params.lambda && params.lambda.get(`${i}|${li}`)), occupancy: r2(params.occ[i].overall), basePrice: r2(params.prices[i].base) };
}),
};
} catch (e) {
entry.error = String(e && e.message ? e.message : e);
}

// What actually happened, from the full data: nights in the window held today by live stays, split into those
// already held on T and those booked after T (the model's simulated bookings are the second kind only).
const actual = nightsOf(full, wS, wE, roomOf, fullReqAt, T);
const heldOnT = nightsOf(ctx, wS, wE, roomOf, new Map(), null);
// Bookings made after T for the window and cancelled since: not in the actual figure (the nights did not stay booked).
const lostNights = full.rooms.map(() => 0);
full.stays.forEach((x) => {
if (x.status !== 'cancelled' || !roomOf.has(x.listingId) || !validDay(x.checkin) || !validDay(x.checkout) || knownFrom(x, fullReqAt).day <= T) return;
const a = Math.max(dayNum(x.checkin), wS); const z = Math.min(dayNum(x.checkout), wE);
if (z > a) lostNights[roomOf.get(x.listingId)] += z - a;
});

const all = { projNights: 0, projIncome: 0, actNights: 0, actIncome: 0, held: 0, free: 0, noIncome: 0 };
entry.rooms = full.rooms.map((room, i) => {
let projNights = null; let projIncome = null; let free = null;
if (proj) {
// The projection gives expected new nights and income per room per calendar month of the window; the window
// total is their sum (the months cover exactly the window's nights).
projNights = 0; projIncome = 0;
Object.values(proj.months).forEach((mo) => { const rm = mo.rooms[room.key]; if (rm) { projNights += rm.nights; projIncome += rm.income; } });
free = proj.voids.filter((v) => v.roomKey === room.key).reduce((a, v) => a + v.nights, 0);
}
let actNights = 0; let actIncome = 0; let noIncome = 0; let heldKept = 0;
actual[i].forEach((v, d) => {
if (heldOnT[i].has(d) || !v.after) { heldKept++; return; }
actNights++;
if (v.perNight == null) noIncome++; else actIncome += v.perNight;
});
const held = heldOnT[i].size;
if (proj) { all.projNights += projNights; all.projIncome += projIncome; all.free += free; }
all.actNights += actNights; all.actIncome += actIncome; all.held += held; all.noIncome += noIncome;
return { key: room.key, label: room.label, heldNightsOnT: held, heldNightsStillBooked: heldKept, freeNightsOnT: free, projNights: r2(projNights), actNights, projIncome: r2(projIncome), actIncome: r2(actIncome), actNightsWithNoIncome: noIncome, bookedAfterTThenCancelledNights: lostNights[i] };
});
entry.total = {
heldNightsOnT: all.held, freeNightsOnT: proj ? all.free : null, projNights: proj ? r2(all.projNights) : null, actNights: all.actNights,
projIncome: proj ? proj.total.expected : null, projIncomeP10: proj ? proj.total.p10 : null, projIncomeP90: proj ? proj.total.p90 : null,
actIncome: r2(all.actIncome), actNightsWithNoIncome: all.noIncome,
incomeInsideRange: proj ? all.actIncome >= proj.total.p10 && all.actIncome <= proj.total.p90 : null,
projBookings: proj ? proj.total.bookings : null,
};
entry.ms = Math.round(performance.now() - tStart);

const row = (label, x, range) => ({
asOf: date, room: label, heldOnT: x.heldNightsOnT, freeOnT: x.freeNightsOnT,
projNights: x.projNights, actNights: x.actNights, errNights: x.projNights == null ? null : r2(x.projNights - x.actNights),
projIncome: x.projIncome, actIncome: x.actIncome, errIncome: x.projIncome == null ? null : r2(x.projIncome - x.actIncome),
p10: range ? x.projIncomeP10 : null, p90: range ? x.projIncomeP90 : null, inRange: range ? x.incomeInsideRange : null,
});
entry.rooms.forEach((x) => rows.push(row(x.label || x.key, x, false)));
rows.push(row('ALL', entry.total, true));
if (opts.onProgress) opts.onProgress(n + 1, asOf.length, date);
await new Promise((res) => setTimeout(res, 0));
}

// Summary over the dates: bias (mean of projected - actual), mean absolute error, and projected / actual pooled.
const summarise = (label) => {
const xs = rows.filter((r) => r.room === label && r.projNights != null);
const sum = (f) => xs.reduce((a, r) => a + f(r), 0);
const mean = (f) => (xs.length ? sum(f) / xs.length : null);
const ratio = (a, b) => (b > 0 ? r2(a / b) : null);
const ranged = xs.filter((r) => r.inRange != null);
return {
room: label, dates: xs.length,
biasNights: r2(mean((r) => r.errNights)), maeNights: r2(mean((r) => Math.abs(r.errNights))), projNights: r2(sum((r) => r.projNights)), actNights: sum((r) => r.actNights), ratioNights: ratio(sum((r) => r.projNights), sum((r) => r.actNights)),
biasIncome: r2(mean((r) => r.errIncome)), maeIncome: r2(mean((r) => Math.abs(r.errIncome))), projIncome: r2(sum((r) => r.projIncome)), actIncome: r2(sum((r) => r.actIncome)), ratioIncome: ratio(sum((r) => r.projIncome), sum((r) => r.actIncome)),
incomeInRange: ranged.length ? `${ranged.filter((r) => r.inRange).length} of ${ranged.length}` : null,
};
};
const labels = [...new Set(rows.map((r) => r.room))];
const summary = labels.map(summarise);

const fallbackMax = Math.max(0, ...perT.map((e) => e.truncation.staysDatedByFallback || 0));
const caveats = [
`The ${asOf.length} windows are ${horizon} days long and start a month apart, so most nights are scored in two or three windows. The dates are not independent tests: one unusual booking or one quiet spell moves several rows the same way, and the pooled ratio counts those nights more than once.`,
'History is short. A consistent bias across the dates is evidence the model runs high or low on this history; it cannot show the size of that bias with any precision, and a good result here does not prove next year will project as well.',
'Early dates have very little data to calibrate on, so their rows mostly test the starting assumptions in Settings, not what the model learns. Read the calibration per date alongside the errors.',
'Settings are today\'s, not those in force on each date: room prices, minimum stays, the lead-time guide, discounts, elasticity, and the "not offered" spells. If any was tuned after seeing the outcomes, the backtest flatters the model.',
'Calendar blocks are today\'s feed snapshot. Blocks that existed on a past date and have since gone are unknown, and a block added later is treated as known all along.',
opts.reviewFactors === 'current' ? 'reviewFactors was set to "current": today\'s monthly-review factors were applied to every date, though they were fitted to later outcomes. That leaks the answer into the projection.' : 'The monthly review\'s factors were set to 1 for every date, because today\'s were fitted to later outcomes. Whatever factors were really in force then are not on record.',
'Actioned rate proposals are kept as they are today (they carry no date in the model\'s context), so a price uplift agreed after a date is treated as known on it. This touches income more than nights.',
`A stay's booking date is its confirmation date, else the day its record was created, else the request that became it, else ${FALLBACK_DAYS} days before check-in (up to ${fallbackMax} stays per date used that last fallback). A stay whose record was created late (imported after it was booked) looks booked late, which moves nights from "held on T" to "booked after T" and overstates the actual figure.`,
'A stay cancelled after a date is put back as live on it, but its income is not on record once cancelled; a cancelled stay with no cancellation date is treated as never held. Stay dates and amounts changed after booking appear as they are now.',
'Actual counts nights still booked today. A booking made after the date and later cancelled is left out (reported as bookedAfterTThenCancelledNights). The projection does not take cancellations off its simulated bookings, so some upward lean against actual is expected from that alone.',
'Actual income is each stay\'s recorded income spread evenly over its nights, counting the nights inside the window; nights with no recorded income add nothing (actNightsWithNoIncome). The projection adds the whole cleaning fee on the check-in night, so a stay cut by the window edge is not split identically.',
'The projection states a range (10th to 90th percentile) for total income only. It gives none for nights and none per room, and neither can be rebuilt from its output (the per-run night counts are not returned), so inRange is filled on the ALL rows for income only. With an 80% range, about 8 dates in 10 should land inside if the model is well calibrated, but overlapping windows make that count unreliable.',
'Projected nights and income per room are the sum of the projection\'s per-month, per-room expected figures over the window; the total income is the projection\'s own total. Both model versions return these.',
`Each date ran ${runs} simulations (the app uses 3000), so each projected figure carries a few percent of run-to-run noise, small beside the errors this is meant to detect.`,
];

return {
modelVersion: MODEL_VERSION, today, horizon, runs, asOf, reviewFactors: opts.reviewFactors === 'current' ? 'current' : 'neutral',
rooms: full.rooms.map((r) => ({ key: r.key, label: r.label })),
rows, summary, perT, caveats,
runMs: Math.round(performance.now() - t0),
};
}

export { backtest };
