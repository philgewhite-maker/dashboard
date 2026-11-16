# Booking model v8: audit findings and proposed patches

Audit of `js/features/bookingmodel.js` (MODEL_VERSION 8, selfTest 42/42 passing on the local preview, 16 Nov 2026),
`guestprice.js`, `modelbacktest.js`, `channels.js` and `docs/booking-model.md`. Nothing in this file has been applied:
every hunk below is a proposal against the file as it stood (line numbers from that read), each with the selfTest
case that proves it. The owner's confirmed facts (received money only, gap discount 20% on 1-3 night gaps, top-rated
share 50%+, extra-guest fee folded in, s.unavailable blocks projections, Martin Golder's request, Zara's Double new
until 15 Jul 2026, month / short-notice elasticity multipliers accepted) were taken as given and are not re-argued.

The local preview at :5173 holds seeded synthetic data (six "Room N" listings), not the owner's records, so every
numeric reproduction below is a constructed context (the selfTest's own `testContext` shape) or the seeded data, and
each says which. Anything that needs the real records is marked "check live".

## Ranked findings

### 1. HIGH: the discount boost is counted twice: in the level learnt from requests AND again in the simulation

**Code.** `drawArrivals` (line 1040-1043) draws requests at `lam x B` and `playArrivals` (line 1113) keeps each with
probability `mult / B`, where at today's settings `mult(n, lead)` = v6's `(1 - shortNotice)(1 - length) ^ -1.5`
(`buildResponse` solves the per-length reference so that this holds, header line 35-39, selfTest "v7 level: expected
multiplier at today's prices equals v6's"). A discounted request is therefore MORE likely to be kept than an
undiscounted one, so the expected number kept per check-in date is `lam x E6` with `E6 = sum p_n q_i f6(n, i) > 1`.
But `lam` comes from `demandFor` (line 1381): `L = (requests + 3) / (exposure + 3 / L0)`, and those requests were
made at today's discounts (the model assumes they always applied, doc "Discounts are taken as always having been
today's"). So the observed rate is a post-discount rate, and the simulation applies the discount response to it a
second time. The same double application tilts the mix: the stay-length curve (line 615-636) and the lead-time
curve (line 684-734) are learnt from the same discounted requests, then the simulation re-weights long stays by
`(1 - length)^-1.5` and late ones by `(1 - shortNotice)^-1.5`. The code already makes exactly this argument for the
other two discounts: line 1072-1074 leaves the top-rated-guest and new-listing discounts out of the response because
"the demand level already reflects them". The short-notice and length steps are no different.

`rateForOccupancy` (the level `L0` a room with no requests falls back on, and the prior the level is shrunk towards)
is NOT affected: it simulates with the same boost, so it is a pre-boost rate. The two levels blended at line 1381 are
therefore in different units: `L0` pre-boost, `requests / exposure` post-boost.

**Reproduction (constructed, :5173).** A `testContext` room, lambda forced to 0.05 a date, empty calendar, projection
of Jan-Mar 2027, 400 runs, once with no discounts and once with the Double's steps from DEFAULT_PREFS (5%/10d,
10%/5d; 5% 5+, 10% 7+, 18% 28+), everything else equal:

| | bookings | nights | income |
|---|---|---|---|
| no discounts | 3.18 | 19.16 | 1916 |
| Double's discounts, same lambda | 3.39 (+6.6%) | 20.48 (+6.9%) | 1834 |
| Double's discounts, lambda / E6 by month | 3.14 (-1.2%) | 20.53 | |

`E6` by hand from the fitted curves: 1.12 in Jan-Mar, 1.10 in Jun-Aug, 1.11 otherwise. Dividing the level by it
brings the bookings back to the undiscounted count; the nights stay +7% because the mix tilt (long stays boosted by
the length steps) remains. selfTest case 23's own figures show the same thing: at the baseline the expected
multiplier is 1.085 and 1.098 (its `disc23`), i.e. 8.5-10% more requests kept than arrive.

**Expected effect on the live projections.** Request-calibrated rooms project E6 - 1 too many bookings: about +11%
for the Double (two short-notice steps, three length steps) and about +5% for En-Suite - Phil (10% within 2 days;
weekly / monthly only), plus a tilt of the stay-length and lead-time mix towards longer and later bookings (nights
+7% at the Double's steps). The monthly review's demand factor absorbs part of it after the fact, which is why the
backtest can still sit at 1.01 overall; the backtest runs with the review factor neutral, so other biases (finding
4, the Christmas cliff in finding 5) must be pulling the other way.

**Fix: at the baseline every request is kept with the same probability.** The reference for a request of n nights in
lead class i becomes its OWN all-in price at the stored settings, so `mult = 1` at the baseline for every (n, i), and
only a departure from the baseline (a what-if discount or cleaning fee, the gap discount, a void plan) moves demand.
Level, stay-length mix and lead-time mix are then exactly what the requests showed. Everything else in v7/v8 (room
type, month and short-notice elasticity, cleaning fee per night, night-by-night price) is unchanged; what goes is
the deliberate "keep v6's level" construction, which kept v6's double count with it. A demand factor the monthly
review fitted under v6-v8 should be re-fitted (it was fitted on the inflated level): `demandFactorOf` could drop 6
and 7 from its list after the first review under the new version.

```diff
--- a/js/features/bookingmodel.js
+++ b/js/features/bookingmodel.js
@@ -955,32 +955,20 @@ function buildResponse(ctx, params, ri, c, base, exMax, reach = null, nights = null) {
 const allIn = (n, i, ex, cur) => allInGuestPrice({ nightly: nightlyOf[n], nights: n, cleaningFee: cleaningFeeFor(cur ? fees : feesRef, n), leadDays: reps[i], disc: cur ? disc : discRef, extraDiscount: ex, guestFeePct: cur ? gf : gfRef }).perNight;
-const eps6 = Number(refS.elasticity) || 0;
-// One ref per stay length n (see the header): every length, not only those on the curve, as a 1-night extra can come.
-const refs = new Float64Array(LOS_MAX + 1);
-let E6 = 0; let logRef = 0; let wRef = 0; let solved = eps.some((e) => e !== 0);
-for (let n = 1; n <= LOS_MAX && solved; n++) {
-let E6n = 0; const terms = [];
-for (let i = 0; i < K; i++) {
-if (!(q[i] > 0)) continue;
-E6n += q[i] * Math.pow((1 - stepPct(discRef.shortNotice, 'days', reps[i])) * (1 - stepPct(discRef.length, 'nights', n)), -eps6);
-terms.push({ w: q[i], la: Math.log(allIn(n, i, 0, false)), e: eps[i] });
-}
-if (!terms.length || !(E6n > 0)) { solved = false; break; }
-let x;
-const e0 = terms[0].e;
-if (terms.every((t) => t.e === e0)) {
-let S = 0; terms.forEach((t) => { S += t.w * Math.exp(t.e * t.la); });
-x = (Math.log(S) - Math.log(E6n)) / e0;
-} else {
-const g = (y) => { let v = 0; for (const t of terms) v += t.w * Math.exp(t.e * (t.la - y)); return v; };
-let lo = Math.min(...terms.map((t) => t.la)) - 20; let hi = Math.max(...terms.map((t) => t.la)) + 20;
-for (let it = 0; it < 80; it++) { const mid = (lo + hi) / 2; if (g(mid) < E6n) lo = mid; else hi = mid; }
-x = (lo + hi) / 2;
-}
-refs[n] = Math.exp(x);
-const p = (cdf[n] || 0) - (cdf[n - 1] || 0);
-if (p > 0) { E6 += p * E6n; logRef += p * x; wRef += p; }
-}
-// `ref`, for display and the selfTest: the stay-length-weighted (geometric) mean of the per-length refs.
+// The reference for a request of n nights in lead class i is its OWN all-in price at the baseline settings, so at the
+// baseline every request is kept with the same probability (mult 1) whatever its length or lead. The requests the
+// level, the stay-length curve and the lead-time curve were learnt from were made at those settings, so they already
+// carry the discounts' effect; re-applying (1 - discount)^-elasticity in the simulation counted it twice (the level
+// ran E6 = sum p q f6, about 1.05-1.12, too high, and the mix tilted to long and late stays). Only a departure from
+// the baseline (a what-if discount or cleaning fee, the gap discount, a void plan) now moves demand, by the room's
+// elasticity for that month, lead and stay length. The same reasoning the top-rated-guest and new-listing discounts
+// already follow (playArrivals).
+const refs = new Float64Array((LOS_MAX + 1) * K);
+let logRef = 0; let wRef = 0; const solved = eps.some((e) => e !== 0);
+for (let n = 1; n <= LOS_MAX && solved; n++) {
+const p = (cdf[n] || 0) - (cdf[n - 1] || 0);
+for (let i = 0; i < K; i++) { refs[n * K + i] = allIn(n, i, 0, false); if (p > 0 && q[i] > 0) { logRef += p * q[i] * Math.log(refs[n * K + i]); wRef += p * q[i]; } }
+}
+// `ref`, for display and the selfTest: the (stay-length and lead-class weighted) geometric mean of the references.
 const ref = solved && wRef > 0 ? Math.exp(logRef / wRef) : null;
+const E6 = 1; // the expected multiplier at the baseline: 1 by construction (kept so the selfTest and display still read it)
 const classOf = (lead) => { for (let i = 0; i < cuts.length; i++) if (lead <= cuts[i]) return i; return K - 1; };
 const tab = new Float64Array((LOS_MAX + 1) * K).fill(1);
 let B = 1;
 if (ref != null) {
-B = 0;
+B = 1;
 for (let n = 1; n <= LOS_MAX; n++) {
 for (let i = 0; i < K; i++) {
-const m0 = demandMultiplier(allIn(n, i, 0, true), refs[n], eps[i]);
+const m0 = demandMultiplier(allIn(n, i, 0, true), refs[n * K + i], eps[i]);
 tab[n * K + i] = m0;
-B = Math.max(B, m0, exMax > 0 ? demandMultiplier(allIn(n, i, exMax, true), refs[n], eps[i]) : 0);
+B = Math.max(B, m0, exMax > 0 ? demandMultiplier(allIn(n, i, exMax, true), refs[n * K + i], eps[i]) : 0);
 }
 }
 }
 const mult = (los, lead, ex = 0) => {
 if (ref == null) return 1;
 const n = Math.min(LOS_MAX, Math.max(1, los)); const i = classOf(lead);
-return ex > 0 ? demandMultiplier(allIn(n, i, ex, true), refs[n], eps[i]) : tab[n * K + i];
+return ex > 0 ? demandMultiplier(allIn(n, i, ex, true), refs[n * K + i], eps[i]) : tab[n * K + i];
 };
```

The header comment (lines 26-49) and the "Guest response (v7)" block (lines 855-879) need the same rewrite: the
model no longer "keeps v6's level"; `refS.elasticity` (v6's 1.5) is no longer read by the response at all. The
`selfTest` cases that assert v6-equivalence change as follows:

```diff
@@ selfTest, case 22 (v7 at v6's elasticity: the projection / evaluation / ref match v6)
-// 22. With the elasticity forced to v6's ... projection and evaluation match v6 run on the same inputs.
-const flat = { ... };
-const eqCtx = ...
-check('v7 at v6\'s elasticity: the projection matches v6', ...);
-check('v7 at v6\'s elasticity: the evaluation matches v6', ...);
-check('v7 at v6\'s elasticity: reference = base price, largest multiplier = v6 maxBoost', ...);
+// 22. Discounts in Settings do not change how many requests are kept at the stored settings: the same forced request
+// rate projects the same bookings and nights with the Double's steps as with none (within run noise; the income is
+// lower because the discounts are paid). Before this fix the Double's steps projected +6.6% bookings and +6.9% nights.
+const dblSteps = DEFAULT_PREFS.bookingEvaluator.discounts.listings['1635499706498185151'];
+const discDbl = { airbnb: { shortNotice: dblSteps.shortNotice, length: dblSteps.length }, direct: { shortNotice: [], length: [] } };
+const proj22 = (more) => { const c = testContext({ occupancy: 0.5, more }); c.params.lambda = new Map(Array.from({ length: 12 }, (_, i) => [`0|${i}`, 0.05])); const p = projectVoids(c, { from: '2027-01-01', to: '2027-04-01', runs: 400 }); return { b: p.total.bookings, n: p.voids.reduce((a, v) => a + v.expectedNights, 0), inc: p.total.expected }; };
+const q0 = proj22({}); const qD = proj22({ discounts: discDbl });
+check('Discounts in Settings leave the level and the mix at the same request rate', close(qD.b, q0.b, 0.03) && close(qD.n, q0.n, 0.03) && qD.inc < q0.inc, `no discounts ${q0.b} bookings ${q0.n.toFixed(1)} nights; Double's steps ${qD.b} bookings ${qD.n.toFixed(1)} nights`);
+const gr22 = guestResponse(testContext({ occupancy: 0.5, more: { discounts: discDbl } }), undefined, 0, dayNum('2026-11-20'));
+check('At the baseline every length and lead class is kept with the same probability', [1, 2, 7, 28].every((n) => [1, 6, 9, 30].every((L) => Math.abs(gr22.mult(n, L) - 1) < 1e-12)) && gr22.B >= 1, `B ${gr22.B.toFixed(4)}`);
@@ selfTest, case 28 (v7 level over the next 90 days ... equal v6's)
-const f6 = Math.pow((1 - stepPct(d28.shortNotice, 'days', lead)) * (1 - stepPct(d28.length, 'nights', n)), -eps28);
+const f6 = 1; // kept requests per request arriving: no tilt by length or lead at the stored settings
-check('v7 level over the next 90 days: bookings and nights equal v6\'s, date by date', ...
+check('Level over the next 90 days: kept requests equal arriving requests, date by date', close(a7, a6, 1e-6) && close(m7, m6, 1e-6) && worst < 1e-6, ...);
```
(`guestResponse(ctx, undefined, ...)` above is shorthand: pass `c.params` of the same context, as case 22 does
today. Cases 23 and 30 pass unchanged, because `E6` is now 1 and the expected multiplier over the curves is 1; cases
24-27 pass unchanged: they compare a changed setting against the baseline, and the baseline multiplier is 1.)

### 2. HIGH (data-dependent): the demand level counts every week since the room's first ask as exposure, but the occupancy calibration drops the months the room was not listed

**Code.** `exposureGrid` (line 1243, 1256-1263) adds up exposure for EVERY week from the room's first ask to today
(104 at most), whether or not the room was listed that week. The occupancy calibration on the same data (line 784)
skips a month with no stay night and no request "as a month the room wasn't listed, not as a month nobody wanted it".
The two estimators therefore disagree on the same records, and the request-based one (which sets `L` once a room
has requests) is the one that runs low: `L = requests / exposure` with dead weeks in the denominator.

**Reproduction (constructed, :5173).** A year of requests at a known rate on an open calendar, nothing else:
`L` 0.640, 51 weeks counted. Add ONE 3-night stay two years ago (booked 730 days back): `L` 0.340, 104 weeks counted,
same 167 requests. One old booking halves the room's demand level. On the seeded :5173 data the same thing shows
live: every room has `L` = 0.105 from 45 asks over 100 weeks while the occupancy calibration counts 10 of 22 months
(12 skipped as unlisted) and puts `L0` at 0.55-0.61, six times `L`; the shrinkage (`LEVEL_PRIOR_K` = 3 against 45
requests) cannot bridge that.

**Check live.** `demandFor(ctx, params, ri).from` for the Double against the Zara listing's `liveOn` in
`priceTrace(ctx).stages`. If the room's listing group includes an earlier listing (the unlisted
779771773933922489 "Double room in modern flat" would be the candidate) the Double's exposure starts at THAT
listing's first ask and every week between its going quiet and Zara's listing going live is counted as nobody
wanting the room, unless the owner has added a "not offered" spell for it (`s.unavailable` is empty on the seeded
data; the doc tells the owner to add them, so this may already be covered). With 21 requests the Double is the room
that can least afford it.

**Fix.** Make the exposure grid skip the weeks the occupancy calibration skips: a week whose mid-point falls in a
calendar month in which the room had no stay night (any status 'stay', long lets included: a let means it was on the
market at some point) and no ask arrived. This is the same judgement the occupancy already makes, now made once.
Trade-off, stated plainly: a listed month with genuinely zero demand and zero stays is then dropped as evidence,
which leans the level up for a genuinely quiet room; the owner's "not offered" spells remain the precise tool, and
this makes the two estimators agree when they are missing.

```diff
--- a/js/features/bookingmodel.js
+++ b/js/features/bookingmodel.js
@@ -1238,12 +1238,24 @@ function exposureGrid(ctx, params, ri) {
 if (ctx.gridCache && ctx.gridCache.has(ri)) return ctx.gridCache.get(ri);
 const end = weekStartN(dayNum(ctx.today)); // complete weeks only
 const asks = asksFor(ctx, new Set(ctx.rooms[ri].listingIds)).filter((a) => a.kind === 'request' && a.checkin >= a.t);
 if (!asks.length || !(weekStartN(asks[0].t) < end)) return null;
 const first = Math.max(weekStartN(asks[0].t), end - 7 * DEMAND_WEEKS);
 const av = availabilityOf(ctx, params, ri);
+// A month with no stay night and no ask is taken as a month the room was not listed, as the occupancy calibration
+// already takes it (calibrate, occ): its weeks offer no exposure. Otherwise a room whose listings have a gap between
+// them (an old listing gone quiet, a new one not yet live) reads as a room nobody wanted for that long.
+const ids = new Set(ctx.rooms[ri].listingIds);
+const listedMonth = new Set();
+ctx.stays.forEach((x) => { if (x.status !== 'stay' || !ids.has(x.listingId) || !x.checkin || !x.checkout) return; for (let d = dayNum(x.checkin); d < dayNum(x.checkout); d++) listedMonth.add(dayStr(d).slice(0, 7)); });
+asks.forEach((a) => { listedMonth.add(dayStr(a.t).slice(0, 7)); listedMonth.add(dayStr(a.checkin).slice(0, 7)); });
+const listedWeek = (w) => listedMonth.has(dayStr(w + 3).slice(0, 7));
 // Each date's class and weight, worked out once: the date arithmetic is the slow part.
@@ -1254,9 +1266,10 @@
 const A = new Float64Array(14 * LEAD_SPAN);
 let weeks = 0;
 for (let w = first; w < end; w += 7) {
+if (!listedWeek(w)) continue;
 const fit = av.fit(w + 3, w, LEAD_SPAN);
```

`stageDemand` (line 1341) counts `weeks[stageOfWeek(w)]++` over the same range and should skip the same weeks
(`if (!grid.listedWeek(w)) continue;` with `listedWeek` returned on the grid object), or its weekly request rates per
stage read low in the same way.

selfTest case:

```diff
+// 10b. One booking two years ago must not halve the level: a year of requests at a known rate, then the same with a
+// single 3-night stay 730 days back. The weeks between are months with no stay and no ask, so they offer no exposure.
+const reqYear = (c) => { const TT = dayNum(c.today); const rng = mulberry32(hashStr('old-stay')); const reqs = []; for (let t = TT - 364; t < TT; t++) { if (rng() < 0.5) { const lead = Math.floor(rng() * 30); reqs.push({ id: `o${t}`, listingId: 'LA', kind: 'request', receivedAt: `${dayStr(t)}T12:00:00.000Z`, checkin: dayStr(t + lead), checkout: dayStr(t + lead + 2) }); } } return reqs; };
+const cOld = (withOld) => { const c = testContext({ occupancy: 0.6 }); const TT = dayNum(c.today); c.requests = reqYear(c); if (withOld) c.stays = [{ id: 'old', listingId: 'LA', checkin: dayStr(TT - 720), checkout: dayStr(TT - 717), status: 'stay', bookedOn: dayStr(TT - 730), income: 300, guest: 'old' }]; delete c.params; delete c.gridCache; delete c.demandCache; calibrate(c); return demandFor(c, c.params, 0); };
+const dNew = cOld(false); const dWithOld = cOld(true);
+check('An old booking two years back does not halve the demand level', Math.abs(dWithOld.L / dNew.L - 1) < 0.1, `L ${dNew.L.toFixed(3)} on ${dNew.weeks} weeks; with one old stay ${dWithOld.L.toFixed(3)} on ${dWithOld.weeks} weeks (before the fix: 0.340 on 104 weeks against 0.640 on 51)`);
```

### 3. MEDIUM: simulated income credits the full per-stay cleaning fee on every booking, including short stays that the guest price says pay the short-stay fee

**Code.** `tally` (line 1515), `examples` (line 1577), the background projection (line 1614) and `makeProjection`
(line 1891) all add `params.prices[b.room].clean` per booking, whatever its length. The guest a 1-2 night booking is
drawn from paid `cleaningFeeFor(fees, n)` = the short-stay fee (`buildResponse` line 954, `receivedCleaningFees`), i.e.
£55 x k on the Double and £75 x k on the en-suites against £75 x k / £95 x k. Income for a short stay is therefore
overstated by (perStay - shortStay) x k, about £16 on the Double and £16 on the en-suites per short booking at k 0.8,
and the stay-length mix the response was so carefully solved for is not what the income side sees. In the backtest
this leans projected income up against actual for exactly the stays (1-2 nights) that are most of the bookings
(32% of draws at the seeded curve).

A second, related point: `k = clean / listedRef.perStay` (line 895) takes the calibrated `clean` (the MEDIAN cleaning
fee of the room's earnings rows) as the received PER-STAY fee. If more than half the room's earnings rows are short
stays, that median is the short-stay fee and every simulated fee is scaled down by shortStay / perStay (27% on the
Double). Check live: `priceTrace(ctx).rooms[i].clean` against the room's earnings rows with nights >= 3.

**Fix.** Carry the fee the guest was priced at on the booking and credit that.

```diff
--- a/js/features/bookingmodel.js
+++ b/js/features/bookingmodel.js
@@ -1113,3 +1113,4 @@ function playArrivals(ctx, params, arrivals, occ, base, { block = null, minNights, len }) {
 if (a.u > gr.mult(a.los, a.lead, ex) / gr.B) continue; // the guest doesn't take it at this price
 for (let i = i0; i < i1 && i < len; i++) o[i] = 1;
-booked.push({ room: a.room, ci: a.c, co: a.c + a.los, factor: factor * topRated[a.room] * (a.at < newUntil[a.room] ? 1 - newPct : 1), at: a.at, lead: a.lead });
+// clean: the (received) cleaning fee this booking pays, the one its guest was priced at: the short-stay fee on a short stay.
+booked.push({ room: a.room, ci: a.c, co: a.c + a.los, factor: factor * topRated[a.room] * (a.at < newUntil[a.room] ? 1 - newPct : 1), at: a.at, lead: a.lead, clean: cleaningFeeFor(gr.fees, a.los) });
@@ -1515 @@ tally
-if (b.ci >= wS) { const cat0 = ...; t[cat0] += params.prices[b.room].clean; }
+if (b.ci >= wS) { const cat0 = ...; t[cat0] += b.clean ?? params.prices[b.room].clean; }
@@ -1577 @@ examples
-const cleaningIncome = b.ci >= wS ? params.prices[ri].clean : 0;
+const cleaningIncome = b.ci >= wS ? (b.clean ?? params.prices[ri].clean) : 0;
@@ -1614 @@ background projection
-const cleaningIncome = b.ci >= dispS ? params.prices[ri].clean : 0;
+const cleaningIncome = b.ci >= dispS ? (b.clean ?? params.prices[ri].clean) : 0;
@@ -1891 @@ makeProjection
-const c0 = params.prices[b.room].clean; const i0 = a - wS;
+const c0 = b.clean ?? params.prices[b.room].clean; const i0 = a - wS;
```

And the scale factor from matched lengths rather than a bare median, in `calibrate` where `clean` is set (line 563):
`clean` stays the median of the earnings rows whose nights exceed the listing's `shortStayMaxNights` when there are 3
or more of them (`median(cleanFees[i].filter(...))`), else the median of all. That needs the nights kept beside the
fee at line 500 (`cleanFees[r].push({ fee, nights })`).

selfTest case (saturating demand, so the mix is the same in both runs; only the fee credited differs):

```diff
+// 12b. A short-stay cleaning fee is what a short booking brings in, not the per-stay fee. Saturating demand, a stay
+// median pinned at 1 night so most bookings are 1-2 nights; LA listed £60 per stay / £40 short stay, received = listed
+// (clean 60). Income falls by (60 - 40) x the short bookings; before the fix the two totals were identical.
+const feeCtx = (short) => { const c = testContext({ occupancy: 0.97, today: '2026-10-01', more: { stayMedian: 1, guestPrice: { cleaningFees: { LA: short ? { perStay: 60, shortStay: 40, shortStayMaxNights: 2 } : { perStay: 60 } } } } }); c.params.prices[0].clean = 60; c.params.lambda = new Map(Array.from({ length: 12 }, (_, m) => [`0|${m}`, 40])); return c; };
+const pFull = projectVoids(feeCtx(false), { from: '2026-11-01', to: '2026-12-01', runs: 40 }); const pShort = projectVoids(feeCtx(true), { from: '2026-11-01', to: '2026-12-01', runs: 40 });
+check('Short-stay cleaning fee: a short booking is credited the short-stay fee', pShort.total.expected < pFull.total.expected - 20 && close(pShort.total.bookings, pFull.total.bookings, 0.02), `£${pShort.total.expected} with a £40 short-stay fee vs £${pFull.total.expected} without, ${pShort.total.bookings} / ${pFull.total.bookings} bookings`);
```

### 4. MEDIUM: enquiries are dropped from the demand level (and the lead-time fit), though the doc says they count

**Code.** `asksFor` keeps enquiries as `kind: 'enquiry'` (line 1144); `exposureGrid` (line 1241) keeps only
`kind === 'request'`, and `demandFor` counts `grid.asks` (line 1378), so an enquiry adds nothing to the level, the
month adjustment, the lead-time fit (line 688) or the stage demand fit, while the stay-length and weekday mixes count
it at `enquiryWeight` 0.3 (lines 615, 658). The doc's table says the request rate is learnt from "Requests, enquiries
and instant bookings". Reproduction (constructed, :5173): 10 requests + 10 enquiries over a year gives
`demandFor(...).n` = 10, `losN` = 13, `dowN` = 13. Direction: under-projects any room whose asks are partly enquiries,
by the enquiry share x 0.3. Either the doc changes (see below) or the level counts them at their weight:

```diff
@@ -1241 @@ exposureGrid
-const asks = asksFor(ctx, new Set(ctx.rooms[ri].listingIds)).filter((a) => a.kind === 'request' && a.checkin >= a.t);
+const ew = Number(ctx.s.enquiryWeight) || 0;
+const asks = asksFor(ctx, new Set(ctx.rooms[ri].listingIds)).filter((a) => a.checkin >= a.t && (a.kind === 'request' || ew > 0)).map((a) => ({ ...a, w: a.kind === 'enquiry' ? ew : 1 }));
@@ -1378 @@ demandFor
-grid.asks.forEach((a) => { out.N[monthOf(a.checkin)]++; out.n++; });
+grid.asks.forEach((a) => { out.N[monthOf(a.checkin)] += a.w; out.n += a.w; });
@@ -692 @@ lead-time observations (calibrate)
-leadObs[li * LEAD_SPAN + d] += 1; leadCount[li] += 1; n += 1;
+leadObs[li * LEAD_SPAN + d] += a.w; leadCount[li] += a.w; n += a.w;
@@ -1342 @@ stageDemand
-grid.asks.forEach((a) => { if (a.t >= grid.first && a.t < end) n[stageOfWeek(weekStartN(a.t))]++; });
+grid.asks.forEach((a) => { if (a.t >= grid.first && a.t < end) n[stageOfWeek(weekStartN(a.t))] += a.w; });
```
(`availabilityOf`'s `shortest` and the undated-stay rules keep `kind === 'request'`: an enquiry is not evidence of
the minimum stay in force.) selfTest: the case-14 context plus 10 enquiries expects `demandFor(...).n` = 5 + 3.

### 5. MEDIUM-HIGH assumption with a cliff: Christmas lead median 300 days, no shift

**Code.** `isChristmas` (line 138) puts 20 Dec - 2 Jan on its own lead-time curve with median `christmasLead` 300
days (DEFAULT_PREFS, doc "Guesses") and no fitted shift (line 701, 732), spread shared. From 16 Nov the share of a
date's eventual requests still to come (`leadCdf`) is 69% for 19 Dec and 4.8% for 20 Dec; 7.8% on 2 Jan and 78% on
3 Jan (constructed, :5173, default curves). So the projection and the evaluator both say that a Christmas void is now
95% unbookable, and that a request for those dates has almost no competition, whatever the room's own history, and a
19 Dec check-in is 14x as bookable as a 20 Dec one. This is not a code error, but a 300-day median with sigma 1.3
means half of Christmas bookings arrive 10 months out and only 0.2% in the last week; the owner's own requests for
Christmas dates will say whether that is remotely true (check live: `asksFor` entries with check-in 20 Dec - 2 Jan,
their `checkin - t`). If it is not, set `christmasLead` nearer the December guide, or let the shared shift apply.
The doc should at least state the consequence.

### 6. MEDIUM: the projection never cancels a simulated booking, and the doc implies cancellations are modelled

**Code.** `playArrivals` books for good; `cancelRate` and `lateShare` are used only for the evaluated request
(`evaluate` line 1469-1473). `makeProjection` and the backtest's "actual" (nights still booked today) therefore differ
by the cancellation rate net of re-booking: with the owner's rate at the 8% prior this is a few percent of nights,
upward on the model. `modelbacktest.js` says so in its caveats (line 262); `docs/booking-model.md` does not: its
table row "Cancellations: Your cancelled stays" sits under "What it learns from your data" with nothing saying it only
applies to the request being judged.

### 7. MEDIUM-LOW: the superhost price prior (x1.14) lifts the base price above anything the stays paid when the fit is thin

**Code.** `stagePriors` (line 291) puts superhost at x1.14 against rated; `calibrate` (line 550) puts EVERY sample on
today's stage, `cur = wd x stagePrice[today] / stagePrice[sample's stage]`, so with the room superhost today and the
fit at the prior, every rated-era stay counts 14% above what it paid. The fit (line 528-548) needs 4+ samples each
side within 180 days of `superhostFrom` and is held by 8 pseudo-samples: with 20 each side and a true x1.00 the
used figure is still x1.04. On the seeded :5173 data (`priceTrace`): rated-era stays paid £85, undone £82.4, on
today's stage £94.0; base £94.9 against a median paid of £85, with `stageFit.superhost.n` = 0 (observed null). Check
live: `priceTrace(ctx).stagePriceFit.superhost` for the owner's two rooms (superhost from 1 Jan 2026, so both sides
should exist). The recency weighting (half-life 180 days, by booking date) limits the damage on the live rooms since
most weight is now on post-January samples, but the prior itself is unsourced and one-directional.

### 8. LOW: an accepted ask's own booking removes its exposure in its own week

**Code.** `exposureGrid` snapshots availability on the Wednesday (`av.fit(w + 3, ...)`, line 1257) while the ask is
counted on the day it landed. A request accepted on Monday or Tuesday of week w has its nights `held` by Wednesday
(`since` = booking date), so the check-in it asked for offers no exposure in the week the ask is counted. `allowedAt`
(line 1200) already excludes "the ask's own booking" for the stay-length fit; `fit` does not. Leans the level up by a
few percent (the booked share of asks x the lead-curve mass in one week). The closed-loop selfTest (case 13) recovers
0.91 of the true level, so other effects outweigh it; noted, not patched.

### 9. LOW / check live: Zara's Double, stage dates and ownership

`listingStages` derives `ratedOn` as the earlier of the third reviewed and the third completed stay + 4 days. The
owner says the listing was new until 15 Jul 2026. If `priceTrace(ctx).stages[<Zara id>].ratedOn` is earlier (stays
completed before the reviews were left), the stays booked between the two dates are not divided by 0.85 and read 15%
low in the price calibration, and the reverse if later. `superhostOn` must be null for it (not the owner's own:
`ctx.ownListings[<Zara id>]` false, or `ownListingIds` set). The Martin Golder case (request on the Double, stay in
the En-Suite) is handled: `asksFor` drops the stay by `reservationId` and counts the request against the Double;
the stay's price sample goes to the En-Suite. No change needed.

### 10. LOW: backtest counting

The backtest's "actual" is nights still booked today, booked after T by `knownFrom` (confirmedOn, else createdAt,
else the request, else check-in - 14). Two leaks beyond those it lists: `ctx.s.unavailable` is today's, so a spell
the owner added after seeing a window empty blocks the projection for that window (fine when the spell is true, a
flatterer when it was added to explain a miss); and `activeListingId` on T uses stays with check-in within 60 days of
T including those booked by T for after T, which is legitimate. Nothing to patch; the caveats list could name the
first.

### Not bugs, checked

- Signs: own-use value is added to both futures (reject gains the empty nights); case 1 proves the difference is
  payout - clean - hassle - own use. Elasticity negative, discount -> all-in below reference -> multiplier above 1.
- Units: every price is received money; the cleaning fee is scaled by one factor per room; `stepPct` 'days' is
  "within k days" inclusive, matching Airbnb's "0 to 5 days".
- Look-ahead in `calibrate`: price samples, stage dates, occupancy, asks, availability are all taken from records
  dated on or before `ctx.today`; the backtest truncates by booking date before calibrating. `minAt(t)` reads asks up
  to 7 days after t (deliberate, bounded).
- Top-rated discount: undone at its expected value on samples (`rawNightlyRate`) and applied at the same value to
  simulated bookings; the 50% share is the fallback and the default.
- Long lets: no ask, no price, no occupancy; nights held from `confirmedOn` else 30 days before (cases 19). Same-day
  stays: `daysLeft` 0 -> `log(0.5)`; a lead of 0 is drawn and played. Blocks: only the listing in use.
- `s.unavailable` blocks projections (v868) and the evaluator deliberately does not; the occupancy calibration takes
  those nights off the market night by night.

## Corrections needed in docs/booking-model.md

1. "Gap discount | 15% on gaps of 2 nights or fewer" -> 20% on gaps of 1 to 3 nights (DEFAULT_PREFS `gapDiscountPct`
   20, `gapMaxNights` 3; the owner's setting).
2. "Request rate (demand level) per room | Requests, enquiries and instant bookings" -> as the code stands, requests
   and instant bookings only; enquiries count towards the stay-length and weekday mixes at 0.3 and nowhere else
   (finding 4), unless the patch is taken.
3. Add to the learnt-inputs table: lead times, stay lengths, weekday mix, cancellation rate and the lead-time spread
   are learnt from ALL rooms' records pooled, not per room (one shift, one spread, one stay-length curve, one weekday
   mix: `calibrate`); only the demand level, its month adjustment, the price and the seasonal occupancy shape are per
   room. PRICING-PLAN.md section D says this; the doc does not.
4. "Cancellations" row: say that the rate applies only to the request the evaluator is judging (late or early, with
   the late-cancel payout); the projection of empty nights does not cancel any simulated booking, so its nights run a
   little above what stays booked (finding 6).
5. "Cleaning income per stay | Median cleaning fee in your earnings export": add that every simulated booking is
   credited this one figure whatever its length, while the guest price charges the short-stay fee on short stays
   (finding 3), until patched.
6. "Lead-time medians by month | 17-35 days; Christmas 300": state the consequence of 300 (from mid-November the model
   treats 20 Dec - 2 Jan as 95% already booked or never to be; 19 Dec is on the ordinary December curve) and that the
   fitted shift does not apply to Christmas (finding 5).
7. "What changed from v6 to v7": "the demand level and the stay-length mix at today's settings ... equal v6's" is
   true and is the problem (finding 1). If patch 1 is taken, replace with: at the stored settings every request is
   kept alike; the level, stay-length and lead-time mix are what your requests showed; only a change from those
   settings moves demand. The "v6 price sensitivity 1.5" row is then unused by the response.
8. "What it learns ... (last 104 weeks)": add that the weeks counted run from the room's first request, and that a
   week in a month with no stay and no request is (after patch 2) left out as a month the room was not listed, as
   the occupancy already does; otherwise, as now, such weeks count as weeks nobody wanted the room, so "not offered"
   spells must cover any gap between an old listing going quiet and a new one going live.
9. "Known limitations": add the superhost prior (x1.14, unsourced, applied to every earlier sample until 4+ stays each
   side of 1 Jan 2026 are within 180 days of it) and the ask-own-week exposure effect (finding 8), both small.
10. "Fixed in the code" table: `LEAD_SIGMA_MIN` 0.7 / `LEAD_SIGMA_MAX` 2 and `LEAD_SHIFT_MAX` 1.2 are clamps the fit
    can hit (the seeded data sits on the 0.7 floor) and are not listed.
