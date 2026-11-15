// Long-let offer check (PRICING-PLAN.md section G, phase 4): the rent for a period against what the
// short-let model (bookingmodel.js, v6) projects for the same room and nights, with the range.
// Pure: reads the model's context, writes nothing, draws nothing.
//
// Long-let side:  rent pro-rated by calendar month over [from, to), minus the channel's fee, bills and one clean.
// Short-let side: the model's projection of NEW bookings into the room's free nights in the period, as of
//                 today, minus one clean per projected booking (the model's own figure is gross).
// Whatever the model cannot see is listed in `assumptions`, never folded silently into the numbers.

import { data } from '../state.js';
import { buildContext, projectVoids, MODEL_VERSION } from './bookingmodel.js';

// The model's backtest runs on 90-day windows (PRICING-PLAN.md, "How each phase is proved"), so that is as far
// ahead as its figures have been checked against what actually happened.
const HORIZON_DAYS = 90;

const dayNum = (s) => Math.round(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000);
const dayStr = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
const r2 = (v) => Math.round(v * 100) / 100;
const gbp = (v) => `£${Math.round(v).toLocaleString('en-GB')}`;

// Months of rent in [from, to): each calendar month touched counts nights-in-period / days-in-that-month.
// 1 Jan to 1 Apr = 3; 1 Jan to 31 Mar = 2 + 30/31 (the night of the 31st is not in it); 15 Jan to 15 Feb = 17/31 + 14/28.
function monthsBetween(from, to) {
  const a = dayNum(from); const b = dayNum(to);
  let months = 0; const parts = [];
  let d = a;
  while (d < b) {
    const s = dayStr(d); const y = +s.slice(0, 4); const m = +s.slice(5, 7);
    const next = Math.round(Date.UTC(y, m, 1) / 86400000); // first of the following month
    const first = Math.round(Date.UTC(y, m - 1, 1) / 86400000);
    const end = Math.min(b, next);
    const frac = (end - d) / (next - first);
    parts.push({ month: s.slice(0, 7), nights: end - d, daysInMonth: next - first, fraction: frac });
    months += frac;
    d = end;
  }
  return { months, parts };
}

function longLetSide({ from, to, monthlyRent, feePct = 0, billsPerMonth = 0, cleaning = 0 }) {
  const { months, parts } = monthsBetween(from, to);
  const gross = monthlyRent * months;
  const fee = gross * (Number(feePct) || 0) / 100;
  const bills = (Number(billsPerMonth) || 0) * months;
  return { months, parts, gross: r2(gross), fee: r2(fee), bills: r2(bills), cleaning: r2(cleaning), net: r2(gross - fee - bills - cleaning) };
}

// The monthly rent at which the long let's net equals `target`.
function breakEvenRent({ target, months, feePct = 0, billsPerMonth = 0, cleaning = 0 }) {
  const keep = 1 - (Number(feePct) || 0) / 100;
  if (!(months > 0) || !(keep > 0)) return null;
  return r2((target + (Number(billsPerMonth) || 0) * months + cleaning) / (months * keep));
}

function verdictOf(net, sl) {
  if (net > sl.high) return 'take';
  if (net < sl.low) return 'decline';
  return 'marginal';
}

// The model's projection for one room over [from, to), net of one clean per projected booking.
// Returns {median, low, high, nightsBooked, bookings, gross: {...}, basis, crossRoom} or {error}.
function modelShortLet({ roomKey, from, to, runs, cleanCost }, ctx) {
  const res = projectVoids(ctx, { from, to, runs, roomKeys: [roomKey] });
  if (res.error) return { error: res.error };
  const t = res.total;
  const cleans = (t.bookings || 0) * cleanCost;
  const nightsBooked = res.voids.filter((v) => v.roomKey === roomKey).reduce((a, v) => a + v.expectedNights, 0);
  return {
    median: r2(t.expected - cleans), low: r2(t.p10 - cleans), high: r2(t.p90 - cleans),
    nightsBooked: r2(nightsBooked), bookings: t.bookings,
    gross: { expected: t.expected, p10: t.p10, p90: t.p90 }, cleans: r2(cleans),
    basis: 'model', crossRoom: false,
  };
}

// opts.shortLet (optional): a function ({roomKey, from, to, runs, cleanCost}, ctx) -> {median, low, high, nightsBooked}
// used in place of the model's projection (selfTest, or a what-if).
// ctx.channels (optional) stands in for data.prefs.lettingChannels.
function checkLongLet({ roomKey, from, to, monthlyRent, channelId, billsPerMonth = 0, cleanAtEnd = true, runs = 800, shortLet = null } = {}, ctx = buildContext()) {
  const reasons = []; const assumptions = [];
  const room = (ctx.rooms || []).find((r) => r.key === roomKey);
  const label = room ? room.label || roomKey : roomKey;
  const fail = (msg) => ({ error: msg, nights: 0, longLet: null, shortLet: null, difference: null, breakEvenMonthlyRent: null, verdict: 'decline', reasons: [msg], assumptions });
  if (!room) return fail(`No room "${roomKey}" is set up for the evaluator.`);
  if (!from || !to || !(dayNum(to) > dayNum(from))) return fail('The period is empty: the end must be after the start.');

  // Bookings already held in the period. The let cannot start before the last of them checks out.
  const ids = new Set(room.listingIds || []);
  const held = (ctx.stays || []).filter((x) => x.status === 'stay' && !x.unconfirmed && ids.has(x.listingId) && x.checkin < to && x.checkout > from)
    .sort((a, b) => a.checkin.localeCompare(b.checkin));
  let start = from;
  if (from < ctx.today) { start = ctx.today; reasons.push(`The period starts before today (${ctx.today}), so only the nights from today are compared.`); }
  if (held.length) {
    const lastOut = held.reduce((m, x) => (x.checkout > m ? x.checkout : m), '');
    const heldIncome = held.reduce((a, x) => a + (Number(x.income) || 0), 0);
    reasons.push(`${held.length} booking${held.length === 1 ? ' is' : 's are'} already held in ${label} in this period (${held.map((x) => `${x.checkin} to ${x.checkout}`).join('; ')}), worth ${gbp(heldIncome)} in all. They would have to be cancelled or honoured; this check honours them, so the let cannot start before ${lastOut}.`);
    if (lastOut > start) start = lastOut;
  } else reasons.push(`No bookings are held in ${label} between ${from} and ${to}.`);
  if (!(start < to)) return fail(`${reasons.join(' ')} That leaves no nights for the long let.`);
  const nights = dayNum(to) - dayNum(start);

  const blocked = (ctx.blocks || []).filter((b) => ids.has(b.listingId) && b.from < to && b.to > start);
  if (blocked.length) reasons.push(`The calendar feed marks ${blocked.map((b) => `${b.from} to ${b.to}`).join('; ')} as not available on a listing for this room: the model may count those nights as unbookable, which lowers the short-let figure.`);

  // Long-let side.
  const channels = ctx.channels || (data.prefs && data.prefs.lettingChannels) || [];
  const ch = channels.find((c) => c.id === channelId);
  const feePct = ch ? Number(ch.feePct) || 0 : 0;
  const cleanCost = Number(ctx.firstClean) || 0;
  const cleaning = cleanAtEnd ? cleanCost : 0;
  const ll = longLetSide({ from: start, to, monthlyRent: Number(monthlyRent) || 0, feePct, billsPerMonth, cleaning });
  if (!ch) assumptions.push(`Channel "${channelId}" is not in Settings' channel list, so no fee is taken off.`);
  else if (!feePct) assumptions.push(`${ch.name}'s fee is 0% in Settings (the default until you enter the real figure), so no fee is taken off.`);
  else assumptions.push(`${ch.name}'s fee is ${feePct}% of the rent (Settings).`);
  assumptions.push(`Rent is pro-rated by calendar month: ${ll.parts.map((p) => `${p.month} ${p.nights}/${p.daysInMonth}`).join(', ')} = ${r2(ll.months)} months. The end date is the move-out day, so its night is not charged.`);
  assumptions.push(billsPerMonth ? `Bills of ${gbp(billsPerMonth)} a month are taken off, pro-rated the same way.` : 'No bills are taken off the rent (billsPerMonth is 0).');
  assumptions.push(cleanAtEnd ? `One clean at the end of the let, at ${gbp(cleanCost)} (the cleaning cost in Settings).` : 'No clean is charged at the end of the let.');
  assumptions.push('The long let is assumed to run the whole period and pay in full: no early exit, no missed rent, no void or changeover inside it.');
  assumptions.push('Not covered: tenancy or lodger rules, deposits, tax treatment, extra wear and tear, or your own use of the room.');

  // Short-let side.
  const sl = (shortLet || modelShortLet)({ roomKey, from: start, to, runs, cleanCost }, ctx);
  if (!sl || sl.error) return { ...fail(`The short-let projection failed: ${sl ? sl.error : 'no result'}`), longLet: { gross: ll.gross, fee: ll.fee, bills: ll.bills, cleaning: ll.cleaning, net: ll.net }, nights, verdict: 'marginal' };
  if (sl.basis === 'model') {
    assumptions.push(`Short-let figures are model v${MODEL_VERSION}'s projection of new bookings into ${label}'s free nights, as of ${ctx.today}, over ${runs} simulated runs. "median" is the average of the runs, low and high are the 10th and 90th percentiles.`);
    assumptions.push(`The model's figure is gross (nightly rates plus the cleaning fee guests pay). ${gbp(sl.cleans)} is taken off for cleaning: ${r2(sl.bookings)} bookings on average at ${gbp(cleanCost)} each. The same average is taken off low and high, which is an approximation.`);
    assumptions.push('Only this room is simulated. Any knock-on effect on the other room (requests that would move across when this one is taken) is not counted.');
    const lastChecked = dayNum(ctx.today) + HORIZON_DAYS;
    const beyond = Math.max(0, dayNum(to) - Math.max(dayNum(start), lastChecked));
    assumptions.push(`The model has been checked against real outcomes only over ${HORIZON_DAYS}-day windows (to ${dayStr(lastChecked)}). ${beyond} of the ${nights} nights are beyond that. They are projected by the same engine (its monthly seasonality and booking lead times), not by a separate extension, and are less reliable.`);
  } else assumptions.push('The short-let figures were supplied to this check, not projected by the model.');

  const shortOut = { median: r2(sl.median), low: r2(sl.low), high: r2(sl.high), nightsBooked: r2(sl.nightsBooked || 0), occupancy: r2((sl.nightsBooked || 0) / nights) };
  const difference = { median: r2(ll.net - sl.median), low: r2(ll.net - sl.high), high: r2(ll.net - sl.low) };
  const breakEven = breakEvenRent({ target: sl.median, months: ll.months, feePct, billsPerMonth, cleaning });
  const verdict = verdictOf(ll.net, sl);

  reasons.push(`Long let: ${gbp(ll.gross)} rent over ${nights} nights (${r2(ll.months)} months), less ${gbp(ll.fee)} fee, ${gbp(ll.bills)} bills and ${gbp(ll.cleaning)} cleaning = ${gbp(ll.net)}.`);
  reasons.push(`Short let: ${gbp(sl.median)} expected after cleaning, range ${gbp(sl.low)} to ${gbp(sl.high)}, from about ${Math.round(shortOut.nightsBooked)} of ${nights} nights booked (${Math.round(shortOut.occupancy * 100)}%).`);
  if (verdict === 'take') reasons.push(`The long let nets ${gbp(ll.net - sl.high)} more than even the top of the short-let range.`);
  else if (verdict === 'decline') reasons.push(`The long let nets ${gbp(sl.low - ll.net)} less than even the bottom of the short-let range.`);
  else reasons.push(`The long let's ${gbp(ll.net)} falls inside the short-let range, ${gbp(Math.abs(ll.net - sl.median))} ${ll.net >= sl.median ? 'above' : 'below'} the expected figure: too close to call on money alone.`);
  if (breakEven != null) reasons.push(`Break-even rent is ${gbp(breakEven)} a month: above that the long let beats the expected short-let income.`);

  return {
    roomKey, from: start, to, nights,
    longLet: { gross: ll.gross, fee: ll.fee, bills: ll.bills, cleaning: ll.cleaning, net: ll.net },
    shortLet: shortOut, difference, breakEvenMonthlyRent: breakEven, verdict, reasons, assumptions,
  };
}

// Hand-checkable cases; the short-let side is stubbed, so none of this touches the model or stored data.
function selfTest() {
  const out = [];
  const ok = (name, got, want) => { const pass = typeof want === 'number' ? Math.abs(got - want) < 0.006 : got === want; out.push({ name, pass, got, want }); };
  const ctx = (stays = []) => ({ today: '2026-11-15', firstClean: 50, rooms: [{ key: 'room:t', label: 'Test', listingIds: ['L1'] }], stays, blocks: [], channels: [{ id: 'free', name: 'Free', feePct: 0 }, { id: 'ten', name: 'Ten', feePct: 10 }] });
  const stub = (median, low, high, nightsBooked = 45) => () => ({ median, low, high, nightsBooked });
  const base = { roomKey: 'room:t', from: '2027-01-01', to: '2027-04-01', monthlyRent: 1600, channelId: 'free' };

  // Pro-rating
  ok('3 whole months', monthsBetween('2027-01-01', '2027-04-01').months, 3);
  ok('1 Jan to 31 Mar = 2 + 30/31', monthsBetween('2027-01-01', '2027-03-31').months, 2 + 30 / 31);
  ok('15 Jan to 15 Feb = 17/31 + 14/28', monthsBetween('2027-01-15', '2027-02-15').months, 17 / 31 + 14 / 28);
  ok('leap Feb 2028: 1 to 15 = 14/29', monthsBetween('2028-02-01', '2028-02-15').months, 14 / 29);

  // Long-let net: 3 x 1600 = 4800, no fee, no bills, one clean at 50 = 4750
  let r = checkLongLet({ ...base, shortLet: stub(3000, 2000, 4000) }, ctx());
  ok('nights 1 Jan to 1 Apr', r.nights, 90);
  ok('gross', r.longLet.gross, 4800);
  ok('net, no fee', r.longLet.net, 4750);
  ok('verdict take (4750 > high 4000)', r.verdict, 'take');
  ok('difference median', r.difference.median, 1750);
  ok('difference low = net - high', r.difference.low, 750);
  ok('difference high = net - low', r.difference.high, 2750);
  ok('break-even (3000 + 50) / 3', r.breakEvenMonthlyRent, 1016.67);
  ok('occupancy 45 / 90', r.shortLet.occupancy, 0.5);

  // Fee 10%, bills 100 a month: 4800 - 480 - 300 - 50 = 3970
  r = checkLongLet({ ...base, channelId: 'ten', billsPerMonth: 100, shortLet: stub(3000, 2000, 4000) }, ctx());
  ok('fee 10%', r.longLet.fee, 480);
  ok('bills', r.longLet.bills, 300);
  ok('net with fee and bills', r.longLet.net, 3970);
  ok('verdict marginal (2000 <= 3970 <= 4000)', r.verdict, 'marginal');
  ok('break-even (3000 + 300 + 50) / (3 x 0.9)', r.breakEvenMonthlyRent, 1240.74);

  // No clean at the end
  r = checkLongLet({ ...base, cleanAtEnd: false, shortLet: stub(3000, 2000, 4000) }, ctx());
  ok('net, no clean', r.longLet.net, 4800);

  // Thresholds are strict: equal to high or low is marginal
  ok('net == high is marginal', checkLongLet({ ...base, shortLet: stub(4000, 3000, 4750) }, ctx()).verdict, 'marginal');
  ok('net == low is marginal', checkLongLet({ ...base, shortLet: stub(6000, 4750, 7000) }, ctx()).verdict, 'marginal');
  ok('net < low is decline', checkLongLet({ ...base, shortLet: stub(6000, 4750.01, 7000) }, ctx()).verdict, 'decline');

  // A held booking 10 to 15 Jan pushes the start to 15 Jan: 17/31 + 2 months
  r = checkLongLet({ ...base, shortLet: stub(3000, 2000, 4000) }, ctx([{ status: 'stay', listingId: 'L1', checkin: '2027-01-10', checkout: '2027-01-15', income: 300 }]));
  ok('held booking moves the start', r.from, '2027-01-15');
  ok('nights after held booking', r.nights, 76);
  ok('gross after held booking', r.longLet.gross, r2(1600 * (17 / 31 + 2)));
  // A held booking to the end leaves nothing
  r = checkLongLet({ ...base, shortLet: stub(3000, 2000, 4000) }, ctx([{ status: 'stay', listingId: 'L1', checkin: '2027-03-20', checkout: '2027-04-02', income: 900 }]));
  ok('held to the end: decline', r.verdict, 'decline');
  ok('held to the end: 0 nights', r.nights, 0);
  // Another room's booking is ignored
  r = checkLongLet({ ...base, shortLet: stub(3000, 2000, 4000) }, ctx([{ status: 'stay', listingId: 'L2', checkin: '2027-01-10', checkout: '2027-01-15', income: 300 }]));
  ok('other room ignored', r.from, '2027-01-01');

  const failed = out.filter((t) => !t.pass);
  return { ok: failed.length === 0, passed: out.length - failed.length, total: out.length, failed };
}

export { checkLongLet, selfTest, monthsBetween, longLetSide, breakEvenRent, verdictOf, HORIZON_DAYS };
