// Guest price, elasticity prior and the cleaning-fee scenario (PRICING-PLAN.md section E, phase 5).
// Pure maths: no DOM, no stored data read or written. Settings come in as the booking evaluator's settings object
// (data.prefs.bookingEvaluator, keys `guestPrice` and `elasticityPrior`); anything missing falls back to the defaults
// below, which live ONLY here for now. They are deliberately not in DEFAULT_PREFS.bookingEvaluator yet: bookingmodel.js
// seeds its random draws with JSON.stringify(settings), so any new key there reshuffles every v6 evaluation and
// projection. Add them to DEFAULT_PREFS (with a deep-fill like stagePriors) in the same change that wires this module
// into the model and bumps MODEL_VERSION.
//
// NOT yet wired into the booking model's simulation (bookingmodel.js v6 still uses its single `elasticity: 1.5`,
// applied only to discounts). Doing so changes model outputs, so per the plan it waits for a backtest of the live
// against the candidate model (PRICING-PLAN.md, "How each phase is proved", 3 and 5).
//
// Sign convention here: elasticity is NEGATIVE (a dearer all-in price means fewer bookings). The v6 model's
// `elasticity` setting is the same idea as a positive magnitude.

import { stepPct, discountsOf } from './bookingmodel.js';

// ---- Defaults (see the header: not yet in js/state.js DEFAULT_PREFS) ---------------------------------------
const DEFAULT_GUEST_PRICE = {
  // ASSUMPTION, unverified for this account: Airbnb's split-fee guest service fee, recalled from Airbnb's help centre
  // as "generally under 14.2% of the booking subtotal" (nightly price after discounts + cleaning fee). The real rate
  // varies by booking and Airbnb has been moving hosts to a host-only fee; check one real guest receipt and correct it.
  airbnbGuestFeePct: 14.2,
  // Direct bookings: no platform guest fee (own site, word of mouth).
  directGuestFeePct: 0,
  // ASSUMPTION, unverified: the split-fee host service fee, recalled as 3% of the same subtotal. Used only to turn the
  // scenario's guest spend into host payout.
  hostFeePct: 3,
  // Which listings are which kind of room, by Airbnb listing id. Source: PRICING-PLAN.md, Airbnb settings read 14 Nov
  // 2026 (Double = 1635499706498185151) and owner answer 2 (the Double's bathroom is shared with the host only).
  roomTypes: {
    '1635499706498185151': 'shared',
    '1437224781619025669': 'ensuite',
    '1651495519889440619': 'ensuite',
  },
  // Cleaning fee guests pay, per listing. Source: PRICING-PLAN.md, "Airbnb settings as read Sat 14 Nov 2026".
  // shortStayMaxNights: ASSUMPTION, Airbnb's short-stay cleaning fee taken to apply to stays of 1-2 nights (not read
  // from the settings page; check the fee page's own wording).
  cleaningFees: {
    '1635499706498185151': { perStay: 75, shortStay: 55, shortStayMaxNights: 2 },
    '1437224781619025669': { perStay: 95, shortStay: 75, shortStayMaxNights: 2 },
    '1651495519889440619': { perStay: 95, shortStay: 75, shortStayMaxNights: 2 },
  },
};

const DEFAULT_ELASTICITY_PRIOR = {
  // Source: PRICING-PLAN.md section E, "en-suite about -1.0, shared bathroom about -1.8": Gemini's figures, which the
  // plan itself calls UNSOURCED ranges, used as a prior only.
  ensuite: -1.0,
  shared: -1.8,
  // Month-of-stay multiplier on the elasticity, Jan..Dec. The plan says only "weaker in peak months, stronger in low
  // season"; the sizes and which months count are ASSUMPTIONS of this build: low season Jan-Mar and Nov x1.2, peak
  // Jun-Aug x0.8 (the months the evaluator's own leadMedian guide already treats as booked furthest ahead), the rest
  // x1.0 (December left at 1.0: busy before Christmas, quiet between, no figure either way).
  season: [1.2, 1.2, 1.2, 1.0, 1.0, 0.8, 0.8, 0.8, 1.0, 1.0, 1.2, 1.0],
  // "Stronger at short notice" (plan). ASSUMPTION: booked within 7 days of arrival, x1.2.
  shortNoticeDays: 7,
  shortNoticeMult: 1.2,
  // ASSUMPTION: how sure the prior is, as a standard deviation on the base (season-neutral) elasticity. 0.5 means a
  // fit from your own data with a standard error of 0.5 moves the value halfway from the prior to the fit.
  priorSd: 0.5,
  // A listing's own fitted base elasticity, written by a later fitting phase once the price ledger has history:
  // {listingId: {value, se, n, fittedOn}}. Empty until then.
  fits: {},
};

const ROOM_TYPES = ['ensuite', 'shared'];
const num = (v, d) => { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) ? d : n; };
const clampPct = (v, d) => Math.min(90, Math.max(0, num(v, d))) / 100;

// The two settings blocks with every key filled.
function guestPriceSettings(s = {}) {
  const g = (s && s.guestPrice) || {};
  return {
    ...DEFAULT_GUEST_PRICE, ...g,
    roomTypes: { ...DEFAULT_GUEST_PRICE.roomTypes, ...(g.roomTypes || {}) },
    cleaningFees: { ...DEFAULT_GUEST_PRICE.cleaningFees, ...(g.cleaningFees || {}) },
  };
}
function elasticitySettings(s = {}) {
  const e = (s && s.elasticityPrior) || {};
  const season = Array.isArray(e.season) && e.season.length === 12 ? e.season.map((v, i) => num(v, DEFAULT_ELASTICITY_PRIOR.season[i])) : DEFAULT_ELASTICITY_PRIOR.season.slice();
  return { ...DEFAULT_ELASTICITY_PRIOR, ...e, season, fits: { ...(e.fits || {}) } };
}

const roomTypeOf = (s, listingId) => {
  const t = guestPriceSettings(s).roomTypes[listingId];
  return ROOM_TYPES.includes(t) ? t : null;
};
const guestFeePctOf = (s, channel = 'airbnb') => {
  const g = guestPriceSettings(s);
  return clampPct(channel === 'airbnb' ? g.airbnbGuestFeePct : g.directGuestFeePct, 0);
};

// The cleaning fee a stay of `nights` pays: the short-stay fee when one is set and the stay is short enough.
// fees: {perStay, shortStay, shortStayMaxNights}.
function cleaningFeeFor(fees, nights) {
  if (!fees) return 0;
  const per = Math.max(0, num(fees.perStay, 0));
  const short = fees.shortStay == null || fees.shortStay === '' ? null : Math.max(0, num(fees.shortStay, per));
  const maxN = num(fees.shortStayMaxNights, 0);
  return short != null && nights <= maxN ? short : per;
}

// ---- All-in guest price ------------------------------------------------------------------------------------
// All-in guest price per night = nightly price after discounts + cleaning fee / nights + platform guest fee, the fee
// being guestFeePct of (nightly after discounts + cleaning fee / nights), i.e. of the booking subtotal.
// `nightly` is the raw nightly price before discounts. Discounts: the listing's short-notice step (needs leadDays) and
// length step (from `disc`, the shape discountsOf() returns), plus `extraDiscount` (a fraction, e.g. a custom
// promotion), all combining by multiplying as in bookingmodel.js. `guestFeePct` is a fraction (0.142).
function allInGuestPrice({ nightly, nights, cleaningFee = 0, leadDays = null, disc = null, extraDiscount = 0, guestFeePct = 0 }) {
  const n = Math.max(1, Math.round(num(nights, 1)));
  const sn = disc && leadDays != null ? stepPct(disc.shortNotice, 'days', leadDays) : 0;
  const ln = disc ? stepPct(disc.length, 'nights', n) : 0;
  const ex = Math.min(0.9, Math.max(0, num(extraDiscount, 0)));
  const nightlyAfter = num(nightly, 0) * (1 - sn) * (1 - ln) * (1 - ex);
  const cleanPerNight = Math.max(0, num(cleaningFee, 0)) / n;
  const subtotal = nightlyAfter + cleanPerNight;
  const fee = subtotal * Math.max(0, num(guestFeePct, 0));
  const perNight = subtotal + fee;
  return { perNight, total: perNight * n, nights: n, nightlyAfter, cleanPerNight, guestFee: fee, subtotal, discounts: { shortNotice: sn, length: ln, extra: ex } };
}

// The same, reading the listing's discounts, cleaning fee and the channel's guest fee from settings.
function allInForListing(s, listingId, { nightly, nights, leadDays = null, channel = 'airbnb', extraDiscount = 0, cleaningFee = null }) {
  const fees = guestPriceSettings(s).cleaningFees[listingId];
  return allInGuestPrice({
    nightly, nights, leadDays, extraDiscount,
    cleaningFee: cleaningFee == null ? cleaningFeeFor(fees, nights) : cleaningFee,
    disc: discountsOf(s, channel === 'airbnb' ? 'airbnb' : 'direct', channel === 'airbnb' ? listingId : null),
    guestFeePct: guestFeePctOf(s, channel),
  });
}

// ---- Elasticity --------------------------------------------------------------------------------------------
// Precision-weighted blend of the prior base elasticity with a fit from your own data ({value, se}); with no usable fit
// the prior stands. Returns {value, weightOnFit}.
function blendElasticity(prior, priorSd, fit) {
  const v = fit && Number.isFinite(Number(fit.value)) ? Number(fit.value) : null;
  const se = fit ? Number(fit.se) : NaN;
  if (v == null || !(se > 0) || !(priorSd > 0)) return { value: prior, weightOnFit: 0 };
  const pp = 1 / (priorSd * priorSd); const pf = 1 / (se * se);
  return { value: (prior * pp + v * pf) / (pp + pf), weightOnFit: pf / (pp + pf) };
}

// The elasticity for one listing (or a room type given directly), stay month (0-11) and lead time:
// base (prior, blended with the listing's own fit when there is one) x season[month] x short-notice multiplier.
// Never positive. `source` says which parts came from where.
function elasticityFor(s, { listingId = null, roomType = null, month = null, leadDays = null } = {}) {
  const e = elasticitySettings(s);
  const type = ROOM_TYPES.includes(roomType) ? roomType : roomTypeOf(s, listingId);
  // An unknown room type takes the en-suite figure (the less sensitive one) and says so.
  const prior = num(e[type || 'ensuite'], DEFAULT_ELASTICITY_PRIOR[type || 'ensuite']);
  const fit = listingId ? e.fits[listingId] : null;
  const base = blendElasticity(prior, num(e.priorSd, DEFAULT_ELASTICITY_PRIOR.priorSd), fit);
  const seasonMult = month == null ? 1 : num(e.season[((Number(month) % 12) + 12) % 12], 1);
  const shortNotice = leadDays != null && Number(leadDays) <= num(e.shortNoticeDays, 0);
  const snMult = shortNotice ? num(e.shortNoticeMult, 1) : 1;
  const value = Math.min(0, base.value * seasonMult * snMult);
  return {
    value, prior, base: base.value, weightOnFit: base.weightOnFit, roomType: type, seasonMult, shortNoticeMult: snMult,
    source: `${type ? `${type === 'shared' ? 'shared bathroom' : 'en-suite'} prior ${prior}` : `room type unknown, en-suite prior ${prior} used`} (unsourced, PRICING-PLAN.md E)${base.weightOnFit > 0 ? `, ${Math.round(base.weightOnFit * 100)}% weight on your own fit ${Number(fit.value).toFixed(2)}` : ''}${seasonMult !== 1 ? `, x${seasonMult} for the month (assumption)` : ''}${snMult !== 1 ? `, x${snMult} at short notice (assumption)` : ''}`,
  };
}

// Demand multiplier: (all-in price / reference price) ^ elasticity. 1 when either price is missing.
function demandMultiplier(allIn, reference, elasticity) {
  const a = Number(allIn); const r = Number(reference); const e = Number(elasticity) || 0;
  if (!(a > 0) || !(r > 0)) return 1;
  return Math.pow(a / r, e);
}

// ---- Cleaning-fee scenario ---------------------------------------------------------------------------------
// Compares the current cleaning fee with alternatives on the same expected bookings. For each stay length in `mix`
// ([{nights, bookings, month?, leadDays?}], the expected bookings at today's settings), each option's all-in price is
// set against the current one's and the bookings scale by (option / current) ^ elasticity. The reference price cancels
// out of that ratio, so no hotel basket (phase 6) is needed here.
//
// current / alternatives: {label, perStay, shortStay?, shortStayMaxNights?, nightlyAdd?}. nightlyAdd is added to the
// raw nightly price before discounts (folding the fee into the price); see foldedAlternative().
// elasticity: a number, or a function ({nights, month, leadDays}) => number.
// Income: host payout = (nightly after discounts x nights + cleaning fee) x (1 - hostFeePct); net = payout less
// cleanCost per booking (your own cost of a changeover).
// Not modelled: capacity (more short stays can crowd out others; the booking model's simulation handles that once this
// is wired in), and any change in how many guests search a listing whose fee is shown differently.
function cleaningFeeScenario({ nightly, mix, current, alternatives = [], elasticity, disc = null, guestFeePct = 0, hostFeePct = 0, cleanCost = 0, extraDiscount = 0 }) {
  const rows = (mix || []).filter((m) => Number(m.nights) >= 1 && Number(m.bookings) >= 0).map((m) => ({ nights: Math.round(Number(m.nights)), bookings: Number(m.bookings), month: m.month ?? null, leadDays: m.leadDays ?? null }));
  const epsOf = typeof elasticity === 'function' ? elasticity : () => Number(elasticity) || 0;
  const hf = Math.max(0, num(hostFeePct, 0));
  const priceOf = (opt, r) => allInGuestPrice({ nightly: num(nightly, 0) + num(opt.nightlyAdd, 0), nights: r.nights, cleaningFee: cleaningFeeFor(opt, r.nights), leadDays: r.leadDays, disc, extraDiscount, guestFeePct });
  const run = (opt) => {
    let bookings = 0; let nights = 0; let guestSpend = 0; let payout = 0; let cleaning = 0;
    const byLength = rows.map((r) => {
      const cur = priceOf(current, r); const p = priceOf(opt, r);
      const eps = epsOf({ nights: r.nights, month: r.month, leadDays: r.leadDays });
      const mult = demandMultiplier(p.perNight, cur.perNight, eps);
      const b = r.bookings * mult;
      const clean = cleaningFeeFor(opt, r.nights);
      bookings += b; nights += b * r.nights; guestSpend += b * p.total;
      payout += b * (p.nightlyAfter * r.nights + clean) * (1 - hf);
      cleaning += b * clean;
      return { nights: r.nights, month: r.month, leadDays: r.leadDays, allInPerNight: p.perNight, currentAllInPerNight: cur.perNight, elasticity: eps, multiplier: mult, bookings: b };
    });
    byLength.forEach((x) => { x.share = bookings > 0 ? x.bookings / bookings : 0; });
    const costs = bookings * Math.max(0, num(cleanCost, 0));
    return { label: opt.label || '', option: opt, bookings, nights, guestSpend, cleaningFeeIncome: cleaning, payout, cleanCost: costs, net: payout - costs, byLength };
  };
  const base = run(current);
  const options = alternatives.map((opt) => {
    const r = run(opt);
    return { ...r, change: { bookings: r.bookings - base.bookings, nights: r.nights - base.nights, payout: r.payout - base.payout, net: r.net - base.net } };
  });
  return { current: base, options };
}

// "Fold the fee into the nightly price": the nightlyAdd (before discounts) that, at today's mix and with no change in
// demand, brings in the same nightly + cleaning income as the current fee. Solves
// sum(bookings x nights x add x discountFactor) = sum(bookings x (currentFee - newFee)) for add, with newFee = 0 unless
// `keep` gives one ({perStay, shortStay, shortStayMaxNights}).
function foldedAlternative({ mix, current, disc = null, extraDiscount = 0, keep = null, label = 'Cleaning fee folded into the nightly price' }) {
  let money = 0; let weighted = 0;
  (mix || []).forEach((m) => {
    const n = Math.round(Number(m.nights)); const b = Number(m.bookings);
    if (!(n >= 1) || !(b > 0)) return;
    const f = allInGuestPrice({ nightly: 1, nights: n, leadDays: m.leadDays ?? null, disc, extraDiscount }).nightlyAfter; // discount factor
    money += b * (cleaningFeeFor(current, n) - (keep ? cleaningFeeFor(keep, n) : 0));
    weighted += b * n * f;
  });
  const add = weighted > 0 ? money / weighted : 0;
  return { label, perStay: keep ? num(keep.perStay, 0) : 0, shortStay: keep ? keep.shortStay ?? null : null, shortStayMaxNights: keep ? keep.shortStayMaxNights ?? 0 : 0, nightlyAdd: add };
}

// The scenario for one Airbnb listing, from settings: its cleaning fees, discounts, guest and host fees and the
// elasticity prior by month and lead time. `nightly` (raw, before discounts) and `mix` come from the caller (the booking
// model's base price and stay-length draws). Alternatives default to: fee folded into the nightly price, and no
// short-stay fee (every stay pays the per-stay fee).
function cleaningFeeScenarioFor(s, listingId, { nightly, mix, alternatives = null, cleanCost = 0, channel = 'airbnb' }) {
  const g = guestPriceSettings(s);
  const current = { label: 'Current cleaning fee', ...(g.cleaningFees[listingId] || { perStay: 0 }) };
  const disc = discountsOf(s, channel === 'airbnb' ? 'airbnb' : 'direct', channel === 'airbnb' ? listingId : null);
  const alts = alternatives || [
    foldedAlternative({ mix, current, disc }),
    { label: 'One fee for every stay length', perStay: current.perStay, shortStay: null, shortStayMaxNights: 0 },
  ];
  return {
    listingId,
    roomType: roomTypeOf(s, listingId),
    ...cleaningFeeScenario({
      nightly, mix, current, alternatives: alts, disc, cleanCost,
      guestFeePct: guestFeePctOf(s, channel),
      hostFeePct: channel === 'airbnb' ? clampPct(g.hostFeePct, 0) : 0,
      elasticity: ({ month, leadDays }) => elasticityFor(s, { listingId, month, leadDays }).value,
    }),
  };
}

// ---- Self-test: hand-checked numbers -----------------------------------------------------------------------
function selfTest() {
  const out = [];
  const ok = (name, got, want, tol = 1e-6) => { const pass = typeof want === 'number' ? Math.abs(got - want) < tol : got === want; out.push({ name, pass, got, want }); };
  const s = { discounts: { airbnb: { shortNotice: [], length: [] }, direct: { shortNotice: [], length: [] }, listings: {
    '1635499706498185151': { shortNotice: [{ days: 10, pct: 5 }, { days: 5, pct: 10 }], length: [{ nights: 5, pct: 5 }, { nights: 7, pct: 10 }, { nights: 28, pct: 18 }], topRatedPct: 15 },
    '1437224781619025669': { shortNotice: [{ days: 2, pct: 10 }], length: [{ nights: 7, pct: 10 }, { nights: 28, pct: 20 }], topRatedPct: 0 },
  } } };
  const D = '1635499706498185151'; const P = '1437224781619025669';

  // 1. Double, £125, 3 nights, 30 days ahead: no discount, £75 fee: 125 + 25 = 150, + 14.2% = 171.30 a night.
  let a = allInForListing(s, D, { nightly: 125, nights: 3, leadDays: 30 });
  ok('All-in: Double 3 nights, 125 + 75/3 + 14.2%', a.perNight, 171.3);
  ok('All-in: total = per night x nights', a.total, 513.9);
  // 2. Double, 7 nights, 4 days ahead: 10% short notice and 10% weekly: 125 x 0.81 = 101.25; (708.75 + 75) x 1.142 = 895.0425.
  a = allInForListing(s, D, { nightly: 125, nights: 7, leadDays: 4 });
  ok('All-in: Double 7 nights at short notice, both discounts', a.nightlyAfter, 101.25);
  ok('All-in: Double 7 nights total (708.75 + 75) x 1.142', a.total, 895.0425);
  // 3. En-suite Phil, £160, 2 nights: short-stay fee £75: (160 + 37.5) x 1.142 = 225.545.
  a = allInForListing(s, P, { nightly: 160, nights: 2, leadDays: 30 });
  ok('All-in: short-stay cleaning fee on 2 nights', a.perNight, 225.545);
  ok('Short-stay fee stops at the 3rd night', cleaningFeeFor({ perStay: 95, shortStay: 75, shortStayMaxNights: 2 }, 3), 95);
  // 4. Direct channel: no guest fee, shared (empty) discounts: 125 + 25 = 150.
  ok('All-in: direct, no guest fee', allInForListing(s, D, { nightly: 125, nights: 3, leadDays: 30, channel: 'direct' }).perNight, 150);

  // 5. Elasticity prior: shared bathroom in January, 30 days ahead: -1.8 x 1.2 = -2.16.
  ok('Elasticity: shared, January', elasticityFor(s, { listingId: D, month: 0, leadDays: 30 }).value, -2.16);
  // En-suite in July at 3 days: -1.0 x 0.8 x 1.2 = -0.96.
  ok('Elasticity: en-suite, July, short notice', elasticityFor(s, { listingId: P, month: 6, leadDays: 3 }).value, -0.96);
  // Unknown listing: en-suite figure, room type null.
  const u = elasticityFor(s, { listingId: 'nope', month: 4 });
  ok('Elasticity: unknown listing falls back to en-suite', u.value === -1 && u.roomType === null, true);
  // 6. Own fit overrides the prior by precision: prior -1.0 sd 0.5 vs fit -2.0 se 0.5 -> -1.5; se 0.25 -> (-4 - 32) / 20 = -1.8.
  const sf = (se) => ({ ...s, elasticityPrior: { fits: { [P]: { value: -2, se, n: 12 } } } });
  ok('Elasticity: equal-precision fit lands halfway', elasticityFor(sf(0.5), { listingId: P, month: 4 }).value, -1.5);
  ok('Elasticity: tighter fit pulls further, -1.8', elasticityFor(sf(0.25), { listingId: P, month: 4 }).value, -1.8);
  ok('Elasticity: fit weight 16/20', elasticityFor(sf(0.25), { listingId: P }).weightOnFit, 0.8);
  // 7. Demand multiplier: 10% dearer at -1.8 = 1.1^-1.8 = 0.842351.
  ok('Demand multiplier 1.1^-1.8', demandMultiplier(110, 100, -1.8), 0.842351137596245, 1e-9);
  ok('Demand multiplier: no reference = 1', demandMultiplier(110, null, -1.8), 1);

  // 8. Cleaning-fee scenario, no fees, elasticity -1, £100 a night, £60 fee, 10 two-night and 10 five-night stays.
  // Folded: add = 1200 / 70 = 17.142857. All-in per night: current 130 (2n) and 112 (5n), folded 117.142857 for both.
  // At elasticity -1 guest spend is unchanged (8200), so income is too, and nights stay at 70; bookings rise to
  // 10 x 130/117.142857 + 10 x 112/117.142857 = 20.658537, so with a £50 clean the net falls by 0.658537 x 50.
  const mix = [{ nights: 2, bookings: 10 }, { nights: 5, bookings: 10 }];
  const cur = { label: 'now', perStay: 60 };
  const fold = foldedAlternative({ mix, current: cur });
  ok('Fold: nightly add 1200 / 70', fold.nightlyAdd, 1200 / 70);
  let sc = cleaningFeeScenario({ nightly: 100, mix, current: cur, alternatives: [fold], elasticity: -1, cleanCost: 50 });
  let o = sc.options[0];
  ok('Scenario e=-1: current payout 8200', sc.current.payout, 8200);
  ok('Scenario e=-1: folded payout unchanged', o.payout, 8200, 1e-6);
  ok('Scenario e=-1: nights unchanged at 70', o.nights, 70, 1e-6);
  ok('Scenario e=-1: bookings 20.658537', o.bookings, 20.658536585365855, 1e-6);
  ok('Scenario e=-1: net change -0.658537 x 50', o.change.net, -0.658536585365855 * 50, 1e-6);
  ok('Scenario e=-1: short stays rise to 53.72% of bookings', o.byLength[0].share, 11.097560975609756 / 20.658536585365855, 1e-9);
  // 9. Same mix with Airbnb's fees (guest 14.2%, host 3%) and elasticity -1.8 (checked in Python):
  // folded: 2-night x1.206173, 5-night x0.922367; payout 7981.479 against 7954; net 6917.209 against 6954.
  sc = cleaningFeeScenario({ nightly: 100, mix, current: cur, alternatives: [fold, { label: 'short £40', perStay: 60, shortStay: 40, shortStayMaxNights: 2 }], elasticity: -1.8, guestFeePct: 0.142, hostFeePct: 0.03, cleanCost: 50 });
  o = sc.options[0];
  ok('Scenario e=-1.8: current payout (7000 + 1200) x 0.97', sc.current.payout, 7954);
  ok('Scenario e=-1.8: folded 2-night multiplier', o.byLength[0].multiplier, 1.206172914624661, 1e-9);
  ok('Scenario e=-1.8: folded payout', o.payout, 7981.4790090228225, 1e-6);
  ok('Scenario e=-1.8: folded net', o.net, 6917.208816013854, 1e-6);
  // A £40 short-stay fee: 2-night stays x1.154973, 5-night unchanged; payout 8120.777, net 7043.290.
  const sh = sc.options[1];
  ok('Scenario e=-1.8: short-stay fee leaves 5-night stays alone', sh.byLength[1].multiplier, 1);
  ok('Scenario e=-1.8: short-stay fee payout', sh.payout, 8120.77689323181, 1e-6);
  ok('Scenario e=-1.8: short-stay fee net', sh.net, 7043.290447090958, 1e-6);
  // 10. Fold with a length discount: 7-night stays take 10%, so add = 10 x 60 / (10 x 7 x 0.9) = 9.52381.
  const f10 = foldedAlternative({ mix: [{ nights: 7, bookings: 10 }], current: cur, disc: { shortNotice: [], length: [{ nights: 7, pct: 10 }] } });
  ok('Fold: allows for the length discount', f10.nightlyAdd, 600 / 63);
  // 11. From settings: Double, January, 3-night stays: the elasticity used is the shared January prior.
  const fs = cleaningFeeScenarioFor(s, D, { nightly: 125, mix: [{ nights: 3, bookings: 4, month: 0, leadDays: 30 }] });
  ok('Scenario from settings: shared January elasticity', fs.options[0].byLength[0].elasticity, -2.16);
  ok('Scenario from settings: current payout (375 + 75) x 0.97 x 4', fs.current.payout, 1746);

  const failed = out.filter((t) => !t.pass);
  return { ok: failed.length === 0, passed: out.length - failed.length, total: out.length, failed };
}

export {
  allInGuestPrice, allInForListing, cleaningFeeFor, elasticityFor, blendElasticity, demandMultiplier,
  cleaningFeeScenario, cleaningFeeScenarioFor, foldedAlternative, guestPriceSettings, elasticitySettings,
  roomTypeOf, guestFeePctOf, selfTest, DEFAULT_GUEST_PRICE, DEFAULT_ELASTICITY_PRIOR,
};
