// Model drift: are the booking model's inputs still what is actually arriving?
//
// Four charts per room, each the model's own number against the real one, so a change of level shows up where it
// started instead of at the next monthly review:
//   Requests a week   what arrived against what the calibrated model expects to be received that week, at list price,
//                     for the nights that were still open then (so a calendar full of a long stay, or a season the
//                     model already knows is slow, is not mistaken for a fall in demand).
//   Lead time         how far ahead each request came, as a multiple of the model's median for that check-in month.
//   Price             each request's payout per night, cleaning and discounts taken out, as a multiple of the model's price.
//   Stay length       each request's nights as a multiple of the model's average stay.
// 1x is "the model has it right". Markers show what happened to the listing (stays ending, your own changes).
// The public patterns the model carries are the starting lead times in Settings and London's seasonal shape from Inside Airbnb
// (marketdata.js), drawn on the requests chart.
import { data, queueSave } from '../state.js';
import { escapeHtml, todayStr, uid } from '../utils.js';
import { buildContext, calibrate, driftKit, discountsOf, rawNightlyRate } from './bookingmodel.js';
import { MARKET_SEASON, creditHtml } from './marketdata.js';
import { roomBlocks } from '../icsparse.js';
import { activeListingId } from '../roomowner.js';

const DAY = 86400000;
const dn = (s) => { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d) / DAY; };
const ds = (n) => new Date(n * DAY).toISOString().slice(0, 10);
const weekStart = (n) => n - ((n + 3) % 7); // Monday
const median = (xs) => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sd = (xs) => { if (xs.length < 2) return null; const m = mean(xs); return Math.sqrt(xs.reduce((a, v) => a + (v - m) ** 2, 0) / (xs.length - 1)); };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (n) => { const d = new Date(n * DAY); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
const longDate = (n) => `${shortDate(n)} ${new Date(n * DAY).getUTCFullYear()}`;
const RECENT = 42; // days a "recent" figure covers
const MAX_WEEKS = 78;

// ---- statistics (pure, exported for the checks) -----------------------------------------------------------

// A ~90% interval for a rate K / E where K is a count: normal on the square-root scale.
function poissonBand(K, E) {
  if (!(E > 0)) return null;
  const lo = Math.max(0, Math.sqrt(K + 0.25) - 0.8225) ** 2 / E;
  const hi = (Math.sqrt(K + 1.25) + 0.8225) ** 2 / E;
  return { rho: K / E, lo, hi };
}

// The one place a run of weekly counts, each with an expected count, most likely changed level: the split with the
// best Poisson likelihood for "actual = ratio x expected" on each side. LR is twice the log-likelihood gained over one ratio.
function bestSplit(counts, expected, minSide = 3) {
  const n = counts.length;
  const ll = (K, E) => (K > 0 ? K * Math.log(K / E) - K : 0);
  const sum = (a, i, j) => { let s = 0; for (let x = i; x < j; x++) s += a[x]; return s; };
  const whole = ll(sum(counts, 0, n), sum(expected, 0, n));
  let best = null;
  for (let k = minSide; k <= n - minSide; k++) {
    const K1 = sum(counts, 0, k); const E1 = sum(expected, 0, k); const K2 = sum(counts, k, n); const E2 = sum(expected, k, n);
    if (!(E1 > 0) || !(E2 > 0)) continue;
    const lr = 2 * (ll(K1, E1) + ll(K2, E2) - whole);
    if (!best || lr > best.lr) best = { at: k, lr, before: K1 / E1, after: K2 / E2 };
  }
  return best;
}

// ---- what actually arrived ---------------------------------------------------------------------------------

// Every ask for a room's listings: requests and enquiries by the day they landed, plus bookings that never had a
// request (instant bookings), by the day they were made.
function asksFor(ctx, ids) {
  const reqs = ctx.requests.filter((q) => ids.has(q.listingId) && q.receivedAt && q.checkin);
  const codes = new Set(reqs.map((q) => q.confirmationCode).filter(Boolean));
  const keys = new Set(reqs.map((q) => `${q.listingId}|${q.checkin}`));
  const asks = reqs.map((q) => ({ t: dn(q.receivedAt), listingId: q.listingId, kind: q.kind === 'enquiry' ? 'enquiry' : 'request', checkin: dn(q.checkin), nights: q.checkout ? dn(q.checkout) - dn(q.checkin) : null, payout: q.kind === 'enquiry' ? null : Number(q.payout) || null }));
  ctx.earnings.forEach((e) => {
    if (!ids.has(e.listingId) || !e.bookingDate || !e.start) return;
    if (codes.has(e.code) || keys.has(`${e.listingId}|${e.start}`)) return;
    asks.push({ t: dn(e.bookingDate), listingId: e.listingId, kind: 'request', checkin: dn(e.start), nights: e.nights, payout: e.amount, instant: true });
  });
  return asks.filter((a) => a.t <= dn(ctx.today)).sort((a, b) => a.t - b.t);
}

// Was night `c` still free to ask about on day `t`? Bookings count from the day they were made (booking date, else the
// request that became them, else two weeks before arrival); your own "not offered" spells and calendar blocks count always.
function opennessOf(ctx, ri) {
  const room = ctx.rooms[ri];
  const ids = new Set(room.listingIds);
  const reqAt = new Map(ctx.requests.filter((q) => q.reservationId && q.receivedAt).map((q) => [q.reservationId, dn(q.receivedAt)]));
  const held = [];
  ctx.stays.forEach((x) => {
    if (!ids.has(x.listingId) || !x.checkin || !x.checkout) return;
    const ci = dn(x.checkin); const co = dn(x.checkout);
    const since = x.bookedOn ? dn(x.bookedOn) : reqAt.has(x.id) ? reqAt.get(x.id) : ci - 14;
    if (x.status === 'cancelled') { if (x.cancelledOn) held.push({ ci, co, since, until: dn(x.cancelledOn) }); return; }
    if (x.status === 'stay' || x.unconfirmed) held.push({ ci, co, since, until: Infinity });
  });
  (Array.isArray(ctx.s.unavailable) ? ctx.s.unavailable : []).forEach((u) => { if (u.roomKey === room.key && u.from && u.to) held.push({ ci: dn(u.from), co: dn(u.to) + 1, since: -Infinity, until: Infinity }); });
  // Calendar blocks count only on the listing in use for the room (a sibling listing can be blocked all winter without the room being).
  const inUse = activeListingId(room.listingIds, ctx.stays, ctx.today);
  roomBlocks(ctx.blocks, (ctx.feedListingIds || []).includes(inUse) ? [inUse] : []).forEach((b) => held.push({ ci: dn(b.from), co: dn(b.to), since: -Infinity, until: Infinity }));
  return (c, t) => { for (const o of held) if (c >= o.ci && c < o.co && o.since <= t && t < o.until) return 0; return 1; };
}

// Requests the model expects to be received in the week starting `t0`: each check-in date asks at its rate x weekday
// weight, and the lead-time curve says what share of that lands in this week.
// weekParts also gives the open-night capacity C (the same sum with every night's rate set to 1) and, when asked, Cm (the
// sum with London's seasonal index as the rate), so charts can show requests per open night and what the market's own shape
// would have expected through the same lead-time weights.
function weekParts(ctx, params, ri, open, t0, withMarket = false) {
  const { lambdaFor, leadCdf, dowOf, monthOf } = driftKit;
  let E = 0; let C = 0; let Cm = 0;
  for (let c = t0; c < t0 + 420; c++) {
    const share = leadCdf(params, c, c - t0) - leadCdf(params, c, c - t0 - 7);
    if (!(share > 1e-9)) continue;
    const o = open(c, t0 + 3);
    if (!o) continue;
    const wgt = params.dowW[dowOf(c)] * share;
    E += lambdaFor(ctx, params, ri, monthOf(c)) * wgt;
    C += wgt;
    if (withMarket) Cm += marketAt(c) * wgt;
  }
  return { E, C, Cm };
}
const ALL_OPEN = () => 1;
function expectedWeek(ctx, params, ri, open, t0) { return weekParts(ctx, params, ri, open, t0).E; }

// ---- everything one room's charts need ---------------------------------------------------------------------

function computeRoom(ctx, params, ri) {
  const { leadFor, basePrice } = driftKit;
  const room = ctx.rooms[ri];
  const ids = new Set(room.listingIds);
  const today = dn(ctx.today);
  const asks = asksFor(ctx, ids);
  if (!asks.length) return { empty: true, room, ids, today };
  const first = Math.max(weekStart(asks[0].t), weekStart(today) - 7 * MAX_WEEKS);
  const open = opennessOf(ctx, ri);
  const weeks = [];
  for (let w = first; w <= weekStart(today); w += 7) {
    const inWeek = asks.filter((a) => a.t >= w && a.t < w + 7);
    const parts = weekParts(ctx, params, ri, open, w, true);
    weeks.push({
      t: w, partial: w + 7 > today + 1,
      requests: inWeek.filter((a) => a.kind === 'request').length,
      enquiries: inWeek.filter((a) => a.kind === 'enquiry').length,
      expected: parts.E, cap: parts.C, capMarket: parts.Cm,
    });
    // The same week with every night open: the model's demand before availability takes its share, and London's
    // index for the stay dates this week's requests are for (the same lead-time weights), so the two are comparable.
    const all = weekParts(ctx, params, ri, ALL_OPEN, w, true);
    const wk = weeks[weeks.length - 1];
    wk.demandAll = all.E; wk.seasonLead = all.C > 0 ? all.Cm / all.C : null;
  }
  // A year's average of that all-open demand, so it can be drawn as "% of an average week" like London's index.
  let yearSum = 0;
  for (let k = 0; k < 52; k++) yearSum += weekParts(ctx, params, ri, ALL_OPEN, first + 7 * k).E;
  const demandMean = yearSum / 52;
  const done = weeks.filter((w) => !w.partial && w.expected > 0);
  const last4 = done.slice(-4);
  const K = last4.reduce((a, w) => a + w.requests, 0); const E = last4.reduce((a, w) => a + w.expected, 0);
  const demand = { recent: poissonBand(K, E), K, E, split: null };
  // Where the level changed within the last half year (further back is a different listing history, not "recent").
  const lastHalf = done.slice(-26);
  if (lastHalf.length >= 8) { demand.split = bestSplit(lastHalf.map((w) => w.requests), lastHalf.map((w) => w.expected)); if (demand.split) demand.split.week = lastHalf[demand.split.at].t; }

  // Per-request comparisons with the model.
  const disc = discountsOf(ctx.s, 'airbnb');
  const clean = params.prices[ri].clean || 0;
  const pts = { lead: [], price: [], length: [] };
  // The model's typical stay is its median: a few long stays drag its mean well above what a usual request asks for.
  const losMed = Math.max(1, params.losCdf.findIndex((c) => c >= 0.5));
  asks.filter((a) => a.kind === 'request').forEach((a) => {
    const lead = a.checkin - a.t;
    if (lead >= 0) {
      const med = leadFor(params, a.checkin).median;
      pts.lead.push({ t: a.t, r: (lead + 0.5) / (med + 0.5), actual: lead, model: med });
    }
    if (a.nights >= 1 && a.payout) {
      let model = 0;
      for (let i = 0; i < a.nights; i++) model += basePrice(ctx, params, ri, a.checkin + i);
      model /= a.nights;
      const raw = rawNightlyRate({ amount: a.payout, cleaning: clean, nights: a.nights, leadDays: lead >= 0 ? lead : null }, disc);
      if (raw && model > 0) pts.price.push({ t: a.t, r: raw.raw / model, actual: raw.raw, model });
      pts.length.push({ t: a.t, r: a.nights / losMed, actual: a.nights, model: losMed });
    } else if (a.nights >= 1) pts.length.push({ t: a.t, r: a.nights / losMed, actual: a.nights, model: losMed });
  });
  return { room, ids, today, first, weeks, demand, demandMean, pts, asks, clean };
}

// Last RECENT days of per-request ratios against 1x.
function readPoints(list, today) {
  const recent = list.filter((p) => p.t > today - RECENT);
  const logs = list.map((p) => Math.log(p.r));
  const s = logs.length >= 8 ? sd(logs) : 0.5;
  if (recent.length < 5) return { n: recent.length, tooFew: true };
  const m = mean(recent.map((p) => Math.log(p.r)));
  const z = m / ((s || 0.5) / Math.sqrt(recent.length));
  return { n: recent.length, ratio: Math.exp(m), actual: median(recent.map((p) => p.actual)), model: median(recent.map((p) => p.model)), z, off: Math.abs(z) > 2 && Math.abs(m) > Math.log(1.15) };
}

// Markers: when each listing's recent stays ended, its first request, and what you logged.
function eventsFor(ctx, calc) {
  const out = [];
  const lbl = (id) => ctx.listingLabels[id] || 'Listing';
  calc.ids.forEach((id) => {
    const mine = calc.asks.filter((a) => a.listingId === id);
    if (mine.length) out.push({ t: mine[0].t, label: 'first request', listingId: id, auto: true, kind: 'first' });
    // The last few stays to end on this listing, by guest (a stay's review can follow within days).
    ctx.earnings.filter((e) => e.listingId === id && e.start && dn(e.start) + e.nights <= calc.today && dn(e.start) + e.nights >= calc.first)
      .map((e) => ({ c: dn(e.start) + e.nights, who: String(e.guest || '').trim().split(/\s+/)[0] }))
      .sort((a, b) => b.c - a.c).slice(0, 8)
      .forEach((x) => out.push({ t: x.c, label: x.who ? `${x.who}'s stay ends` : 'a stay ends', listingId: id, auto: true, kind: 'stay' }));
  });
  (data.prefs.listingEvents || []).forEach((e) => { if (e.date && (!e.listingId || calc.ids.has(e.listingId))) out.push({ t: dn(e.date), label: e.note || 'change', listingId: e.listingId || '', id: e.id }); });
  return out.filter((e) => e.t >= calc.first && e.t <= calc.today + 1).sort((a, b) => a.t - b.t).map((e, i) => ({ ...e, n: i + 1, lbl: e.listingId ? lbl(e.listingId) : 'All rooms' }));
}

// ---- the monthly proposal: what the settings would need to be to match recent requests ------------------------

const PROPOSAL_WEEKS = 12; // complete weeks looked at
const HALF_LIFE_WEEKS = 4; // a week counts half as much for every four weeks older it is
const PACE_SHRINK_K = 10; // pseudo-requests pulling a proposed demand factor back towards the current one
const MIN_STAY_REQUESTS = 8;

const wmedian = (items) => {
  const s = items.slice().sort((a, b) => a.v - b.v); const tot = s.reduce((a, x) => a + x.w, 0); let acc = 0;
  for (const x of s) { acc += x.w; if (acc >= tot / 2) return x.v; }
  return null;
};

// Works out, from the last 12 weeks of requests (recent weeks counting more), the demand factor (empty nights divided by it)
// that makes the model expect what actually arrived, and the median stay the requests ask for. Nothing is changed:
// the caller shows the numbers for review. Async only so the page stays responsive while the model is recalibrated.
async function proposeRecent(progress = () => {}) {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const ctx = buildContext(); const params = calibrate(ctx);
  const today = dn(ctx.today);
  const last = weekStart(today) - 7; // the latest complete week
  const starts = Array.from({ length: PROPOSAL_WEEKS }, (_, i) => last - 7 * i);
  const wt = (t) => Math.min(1, Math.pow(0.5, (last - t) / 7 / HALF_LIFE_WEEKS));
  const rooms = ctx.rooms.map((room, ri) => {
    const asks = asksFor(ctx, new Set(room.listingIds)).filter((a) => a.kind === 'request');
    const first = asks.length ? weekStart(asks[0].t) : Infinity; // weeks before a room's first request are not evidence of anything
    return { ri, room, asks, first, open: opennessOf(ctx, ri), K: starts.map((t) => asks.filter((a) => a.t >= t && a.t < t + 7).length) };
  }).filter((r) => r.asks.length);
  const kc = ctx.scale.demand || 1;
  const used = (r, i) => starts[i] >= r.first;
  const rawK = rooms.reduce((a, r) => a + r.K.reduce((b, k, i) => b + (used(r, i) ? k : 0), 0), 0);
  const out = { window: { from: ds(starts[starts.length - 1]), to: ds(last + 6) }, current: kc, pace: null, stay: null };

  if (rawK >= 8) {
    const wK = rooms.reduce((a, r) => a + r.K.reduce((b, k, i) => b + (used(r, i) ? k * wt(starts[i]) : 0), 0), 0);
    const evalAt = async (k) => {
      progress(`Recalibrating the model at ×${k.toFixed(2)}…`);
      await tick();
      // A lighter calibration (fewer simulated months and bisection steps): the answer is rounded and reviewed by hand anyway.
      const ctx2 = { ...ctx, scale: { ...ctx.scale, demand: k }, calRuns: 50, calIters: 8 };
      const p2 = { ...params, lambda: new Map() };
      const E = rooms.map((r) => starts.map((t, i) => (used(r, i) ? expectedWeek(ctx2, p2, r.ri, r.open, t) : 0)));
      const w = E.reduce((a, row) => a + row.reduce((b, e, i) => b + e * wt(starts[i]), 0), 0);
      const raw = E.reduce((a, row) => a + row.reduce((b, e) => b + e, 0), 0);
      return { w, raw, E };
    };
    const g = (e) => Math.log(Math.max(e.w, 1e-6)) - Math.log(Math.max(wK, 1e-6));
    const e0 = await evalAt(kc);
    const pts = [{ lk: Math.log(kc), f: g(e0) }];
    const LO = Math.log(0.25); const HI = Math.log(16);
    let lk = pts[0].lk + (pts[0].f > 0 ? -0.5 : 0.5);
    for (let it = 0; it < 5 && Math.abs(pts[pts.length - 1].f) >= 0.06; it++) {
      lk = Math.min(HI, Math.max(LO, lk));
      if (pts.some((p) => Math.abs(p.lk - lk) < 1e-3)) break;
      const e = await evalAt(Math.exp(lk));
      pts.push({ lk, f: g(e) });
      const [a, b] = pts.slice(-2);
      const slope = (b.f - a.f) / (b.lk - a.lk);
      if (!(slope > 0.02)) break;
      lk = b.lk - Math.max(-1.5, Math.min(1.5, b.f / slope));
    }
    const best = pts.reduce((a, b) => (Math.abs(b.f) < Math.abs(a.f) ? b : a));
    const fit = Math.exp(best.lk);
    const shr = rawK / (rawK + PACE_SHRINK_K);
    const proposed = Math.min(16, Math.max(0.25, Math.round(Math.exp(Math.log(kc) + shr * (Math.log(fit) - Math.log(kc))) * 20) / 20));
    const occ = params.occ.map((o) => o.overall).filter((v) => v != null);
    const occAvg = occ.length ? occ.reduce((a, b) => a + b, 0) / occ.length : null;
    const at = (k) => (occAvg == null ? null : Math.min(0.97, Math.max(0.02, 1 - (1 - occAvg) / k)));
    out.pace = {
      N: rawK, expected: e0.raw, ratio: e0.raw > 0 ? rawK / e0.raw : null, fit, proposed, atBound: best.lk <= LO + 1e-6 || best.lk >= HI - 1e-6,
      occBase: occAvg, occNow: at(kc), occProposed: at(proposed),
      rooms: rooms.map((r, i) => ({ label: r.room.label, K: r.K.reduce((b, k, j) => b + (used(r, j) ? k : 0), 0), E: e0.E[i].reduce((b, e) => b + e, 0) })),
    };
  } else out.pace = { tooFew: true, N: rawK };

  // Typical stay: the median nights asked for, newer requests counting more.
  const since = starts[starts.length - 1];
  const items = [];
  rooms.forEach((r) => r.asks.forEach((a) => { if (a.t >= since && a.nights >= 1) items.push({ v: a.nights, w: wt(a.t) }); }));
  const modelMedian = Math.max(1, params.losCdf.findIndex((c) => c >= 0.5));
  if (items.length >= MIN_STAY_REQUESTS) {
    const med = wmedian(items);
    const nights = items.map((x) => x.v);
    out.stay = { n: items.length, median: med, mean: mean(nights), long: nights.filter((v) => v >= 14).length, proposed: Math.min(7, Math.max(1, Math.round(med))), model: modelMedian, pinned: Number(ctx.s.stayMedian) || null };
  } else out.stay = { tooFew: true, n: items.length, model: modelMedian, pinned: Number(ctx.s.stayMedian) || null };
  return out;
}

// ---- charts -------------------------------------------------------------------------------------------------

const W = 640; const PL = 38; const PR = 34; const PT = 16; const PB = 20; // the right margin carries the season axis on the requests chart (and keeps the other charts aligned with it)

function frame({ h, x0, x1, yMin, yMax, ticks, fmt }) {
  const X = (d) => PL + ((d - x0) / (x1 - x0)) * (W - PL - PR);
  const Y = (v) => PT + (1 - (Math.min(yMax, Math.max(yMin, v)) - yMin) / (yMax - yMin)) * (h - PT - PB);
  let grid = ticks.map((v) => `<line x1="${PL}" x2="${W - PR}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" stroke="var(--line)" stroke-width="1"/><text x="${PL - 5}" y="${(Y(v) + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--muted)">${fmt(v)}</text>`).join('');
  for (let d = x0; d <= x1; d++) {
    const dt = new Date(d * DAY);
    if (dt.getUTCDate() !== 1) continue;
    grid += `<line x1="${X(d).toFixed(1)}" x2="${X(d).toFixed(1)}" y1="${PT}" y2="${h - PB}" stroke="var(--line)" stroke-width="1" stroke-dasharray="1 4"/><text x="${(X(d) + 3).toFixed(1)}" y="${h - 6}" font-size="10" fill="var(--muted)">${MON[dt.getUTCMonth()]}${dt.getUTCMonth() === 0 ? ` ${String(dt.getUTCFullYear()).slice(2)}` : ''}</text>`;
  }
  return { X, Y, grid };
}


// London's seasonal index at a day number, interpolated between month centres so the line doesn't step at month ends.
function marketAt(n) {
  const d = new Date(n * DAY);
  const m = d.getUTCMonth();
  const dim = new Date(Date.UTC(d.getUTCFullYear(), m + 1, 0)).getUTCDate();
  const pos = m + (d.getUTCDate() - 0.5) / dim - 0.5;
  const i = Math.floor(pos); const fr = pos - i;
  return MARKET_SEASON[(i + 12) % 12] * (1 - fr) + MARKET_SEASON[(i + 13) % 12] * fr;
}


// ---- layer toggles and one shared crosshair per chart ---------------------------------------------------------

const LAYER_KEY = 'md-layers';
const LAYER_DEFAULTS = { 'ev-stay': false }; // the automatic stay-ending markers are clutter until asked for
function loadLayers() { try { return JSON.parse(localStorage.getItem(LAYER_KEY)) || {}; } catch (e) { return {}; } }
function saveLayers() { try { localStorage.setItem(LAYER_KEY, JSON.stringify(ui.layers)); } catch (e) { /* private window: the choice just isn't remembered */ } }
const layerOn = (k) => (k in ui.layers ? !!ui.layers[k] : LAYER_DEFAULTS[k] !== false);
const lay = (k) => ` data-md-layer="${k}"`;

// A row of tick boxes above a chart, doubling as its key. A `fixed` item is always drawn and has no box.
function togglesHtml(items) {
  const ev = [{ k: 'ev-own', label: 'Your changes and first request', color: 'var(--plum)' }, { k: 'ev-stay', label: 'Stay endings', color: 'var(--plum)', dash: true }];
  return `<div class="md-togs">${items.concat(ev).map((it) => {
    const sw = `<i style="border-color:${it.color};${it.dash ? 'border-top-style:dashed;' : ''}${it.bar ? 'border-top-width:7px;' : ''}"></i>`;
    return it.fixed ? `<span>${sw}${escapeHtml(it.label)}</span>` : `<label><input type="checkbox" data-md-tog="${it.k}"${layerOn(it.k) ? ' checked' : ''}>${sw}${escapeHtml(it.label)}</label>`;
  }).join('')}</div>`;
}

function applyLayers(scope) {
  scope.querySelectorAll('[data-md-layer]').forEach((el) => { el.style.display = layerOn(el.dataset.mdLayer) ? '' : 'none'; });
  scope.querySelectorAll('[data-md-tog]').forEach((el) => { el.checked = layerOn(el.dataset.mdTog); });
}

// Hover points for a chart: x in drawing units, plain-text lines, the layer they belong to. Events are points too, so a
// marker can be read by pointing near it; everything else snaps to the nearest week or request.
const hovAttr = (pts) => ` data-md-hov="${escapeHtml(JSON.stringify(pts.map((p) => ({ x: Math.round(p.x * 10) / 10, l: p.lines, k: p.layer || '', e: p.ev ? 1 : 0 }))))}"`;
const eventHov = (events, X) => events.map((e) => ({ x: X(e.t), lines: [`${e.n}. ${shortDate(e.t)} · ${e.lbl}: ${e.label}`], layer: e.kind === 'stay' ? 'ev-stay' : 'ev-own', ev: true }));
const crossLine = (h) => `<line data-md-cross x1="0" x2="0" y1="${PT}" y2="${h - PB}" stroke="var(--ink)" stroke-width="1" opacity="0.45" style="display:none"/>`;
const plotHtml = (svg) => `<div class="md-plot">${svg}<div class="md-tip"></div></div>`;

function wireHover(scope) {
  scope.querySelectorAll('.md-plot').forEach((plot) => {
    const svg = plot.querySelector('svg[data-md-hov]'); if (!svg) return;
    let pts = []; try { pts = JSON.parse(svg.dataset.mdHov); } catch (e) { return; }
    const tip = plot.querySelector('.md-tip'); const cross = svg.querySelector('[data-md-cross]');
    const hide = () => { tip.style.display = 'none'; if (cross) cross.style.display = 'none'; };
    const show = (ev) => {
      const r = svg.getBoundingClientRect(); if (!r.width) return;
      const vx = ((ev.clientX - r.left) / r.width) * W;
      const live = pts.filter((p) => !p.k || layerOn(p.k));
      let best = null;
      const pick = (list, reach) => list.forEach((p) => { const d = Math.abs(p.x - vx); if (d <= reach && (!best || d < best.d)) best = { p, d }; });
      pick(live.filter((p) => p.e), 5); // a marker if the pointer is on one, else the nearest week or request
      if (!best) pick(live.filter((p) => !p.e), Infinity);
      if (!best) { hide(); return; }
      if (cross) { cross.setAttribute('x1', best.p.x); cross.setAttribute('x2', best.p.x); cross.style.display = ''; }
      tip.textContent = best.p.l.join('\n'); tip.style.display = 'block';
      const px = (best.p.x / W) * r.width; const tw = tip.offsetWidth;
      tip.style.left = `${Math.max(0, Math.min(r.width - tw, px + 10 + tw > r.width ? px - tw - 10 : px + 10))}px`;
    };
    svg.addEventListener('pointermove', show); svg.addEventListener('pointerdown', show); svg.addEventListener('pointerleave', hide);
  });
}

function eventLayer(events, X, h) {
  return events.map((e) => `<g${lay(e.kind === 'stay' ? 'ev-stay' : 'ev-own')}><line x1="${X(e.t).toFixed(1)}" x2="${X(e.t).toFixed(1)}" y1="${PT - 2}" y2="${h - PB}" stroke="var(--plum)" stroke-width="1" stroke-dasharray="3 3" opacity="${e.auto ? 0.45 : 0.9}"/><text x="${X(e.t).toFixed(1)}" y="${PT - 5}" text-anchor="middle" font-size="9" font-weight="600" fill="var(--plum)">${e.n}</text></g>`).join('');
}

const niceStep = (top) => { for (const s of [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10]) if (top / s <= 5) return s; return 20; };

function demandChart(calc, events) {
  const h = 190;
  const { weeks } = calc;
  const x0 = weeks[0].t; const x1 = weeks[weeks.length - 1].t + 7;
  const top = Math.max(2, ...weeks.map((w) => Math.max(w.requests + w.enquiries, w.expected))) * 1.1;
  const step = top > 12 ? 4 : top > 6 ? 2 : 1;
  const ticks = []; for (let v = 0; v <= top; v += step) ticks.push(v);
  const yMax = Math.ceil(top / step) * step;
  const f = frame({ h, x0, x1, yMin: 0, yMax, ticks, fmt: (v) => String(v) });
  const bw = Math.max(2, (f.X(x0 + 7) - f.X(x0)) * 0.72);
  const bars = weeks.map((w) => {
    const x = f.X(w.t + 3.5) - bw / 2;
    const yR = f.Y(w.requests); const yE = f.Y(w.requests + w.enquiries); const base = f.Y(0);
    return `<g opacity="${w.partial ? 0.45 : 1}">${w.requests ? `<rect x="${x.toFixed(1)}" y="${yR.toFixed(1)}" width="${bw.toFixed(1)}" height="${(base - yR).toFixed(1)}" rx="2" fill="var(--slate)"/>` : ''}${w.enquiries ? `<rect${lay('req:enq')} x="${x.toFixed(1)}" y="${yE.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, yR - yE - 1).toFixed(1)}" rx="2" fill="var(--slate-bg)" stroke="var(--slate)" stroke-width="0.6"/>` : ''}</g>`;
  }).join('');
  // The model's line is smoothed a little for drawing (1-2-1 over neighbouring weeks, the ends left as they are): a week's
  // expectation jumps with which nights happen to be open, and the hover gives each week's own figure.
  const done = weeks.filter((w) => !w.partial);
  const sm = done.map((w, i) => (done[i - 1] && done[i + 1] ? (done[i - 1].expected + 2 * w.expected + done[i + 1].expected) / 4 : w.expected));
  const line = done.map((w, i) => `${f.X(w.t + 3.5).toFixed(1)},${f.Y(sm[i]).toFixed(1)}`).join(' ');
  // London's seasonal shape on its own right-hand axis (100% = an average month of the year), parked in the upper part of the
  // chart where the bars and the model line rarely reach, so it reads as a shape to compare with, not a level.
  const seasonY = (idx) => yMax * (0.72 + (idx - 1) * 0.5);
  const seasonOf = (w) => (w.seasonLead != null ? w.seasonLead : marketAt(w.t + 3));
  const mkt = done.map((w) => `${f.X(w.t + 3.5).toFixed(1)},${f.Y(seasonY(seasonOf(w))).toFixed(1)}`).join(' ');
  // Our own demand with every night open, as a share of its average week over a year: the curve to hold against London's.
  const ownIdx = (w) => (calc.demandMean > 0 ? w.demandAll / calc.demandMean : null);
  const own = calc.demandMean > 0 ? done.map((w) => `${f.X(w.t + 3.5).toFixed(1)},${f.Y(seasonY(ownIdx(w))).toFixed(1)}`).join(' ') : '';
  const seasonAxis = [60, 80, 100, 120].map((p) => `<text x="${W - PR + 5}" y="${(f.Y(seasonY(p / 100)) + 3.5).toFixed(1)}" font-size="10" fill="var(--sage)">${p}%</text>`).join('') + `<text x="${W - PR + 5}" y="${PT - 5}" font-size="9" fill="var(--sage)">season</text>`;
  const pts = weeks.map((w) => ({ x: f.X(w.t + 3.5), lines: [`Week of ${shortDate(w.t)}${w.partial ? ' (so far)' : ''}`, `${w.requests} request${w.requests === 1 ? '' : 's'}${w.enquiries ? `, ${w.enquiries} enquir${w.enquiries === 1 ? 'y' : 'ies'}` : ''}`, `Model expects ${w.expected.toFixed(1)} (nights still open)`, ...(ownIdx(w) != null ? [`All nights open: ${w.demandAll.toFixed(1)}, ${Math.round(ownIdx(w) * 100)}% of our average week`] : []), `London, for those stay dates: ${Math.round(seasonOf(w) * 100)}%`] })).concat(eventHov(events, f.X));
  return plotHtml(`<svg viewBox="0 0 ${W} ${h}" class="md-svg" role="img" aria-label="Requests received each week against the model's expectation, with London's seasonal shape on a right-hand axis"${hovAttr(pts)}>${f.grid}${bars}${mkt ? `<g${lay('req:season')}><polyline points="${mkt}" fill="none" stroke="var(--sage)" stroke-width="2.25" stroke-dasharray="6 4" stroke-linecap="round" stroke-linejoin="round"/></g>` : ''}${own ? `<polyline${lay('req:demand')} points="${own}" fill="none" stroke="var(--amber)" stroke-width="1.75" stroke-dasharray="2 4" stroke-linecap="round" stroke-linejoin="round"/>` : ''}${seasonAxis}<polyline${lay('req:model')} points="${line}" fill="none" stroke="var(--amber)" stroke-width="2" stroke-linejoin="round"/>${eventLayer(events, f.X, h)}${crossLine(h)}</svg>`);
}

// Requests per open night, in layers: London's shape (scaled to the same average, through the model's own lead-time weights),
// the model's own rate, what actually arrived, and actual over model as a ratio on the right-hand axis.
function sourceChart(calc, events) {
  const h = 210;
  const done = calc.weeks.filter((w) => !w.partial && w.cap > 0);
  if (done.length < 4) return '';
  const sumE = done.reduce((a, w) => a + w.expected, 0); const sumCm = done.reduce((a, w) => a + w.capMarket, 0);
  const k = sumCm > 0 ? sumE / sumCm : 0;
  const rows = done.map((w, i) => {
    const win = done.slice(Math.max(0, i - 3), i + 1);
    const cap = win.reduce((a, x) => a + x.cap, 0); const E = win.reduce((a, x) => a + x.expected, 0); const A = win.reduce((a, x) => a + x.requests, 0);
    return { t: w.t, model: w.expected / w.cap, market: (k * w.capMarket) / w.cap, raw: w.requests / w.cap, actual: win.length >= 2 ? A / cap : null, err: win.length >= 2 && E >= 1 ? A / E : null };
  });
  const top = Math.max(0.1, ...rows.map((r) => Math.max(r.model, r.market, r.actual || 0))) * 1.15;
  const step = niceStep(top); const yMax = Math.ceil(top / step) * step;
  const ticks = []; for (let v = 0; v <= yMax + 1e-9; v += step) ticks.push(+v.toFixed(3));
  const x0 = done[0].t; const x1 = done[done.length - 1].t + 7;
  const f = frame({ h, x0, x1, yMin: 0, yMax, ticks, fmt: (v) => String(+v.toFixed(2)) });
  const errMax = 3; const errY = (r) => PT + (1 - Math.min(errMax, r) / errMax) * (h - PT - PB);
  const poly = (key, y, attrs, layer) => { const p = rows.filter((r) => r[key] != null).map((r) => `${f.X(r.t + 3.5).toFixed(1)},${y(r[key]).toFixed(1)}`); return p.length > 1 ? `<polyline${layer ? lay(layer) : ''} points="${p.join(' ')}" fill="none" ${attrs} stroke-linejoin="round" stroke-linecap="round"/>` : ''; };
  const dots = rows.map((r) => `<circle cx="${f.X(r.t + 3.5).toFixed(1)}" cy="${f.Y(r.raw).toFixed(1)}" r="2" fill="var(--slate)" opacity="0.3"/>`).join('');
  const rightAxis = [0, 1, 2, 3].map((v) => `<text x="${W - PR + 5}" y="${(errY(v) + 3.5).toFixed(1)}" font-size="10" fill="var(--ink)">${v}×</text>`).join('') + `<text x="${W - PR + 5}" y="${PT - 5}" font-size="9" fill="var(--ink)">actual÷model</text><line x1="${PL}" x2="${W - PR}" y1="${errY(1).toFixed(1)}" y2="${errY(1).toFixed(1)}" stroke="var(--ink)" stroke-width="1" stroke-dasharray="1 3" opacity="0.5"/>`;
  const pts = rows.map((r) => ({ x: f.X(r.t + 3.5), lines: [`Week of ${shortDate(r.t)}`, `London's shape ${r.market.toFixed(2)}`, `Model ${r.model.toFixed(2)}`, `Actual, 4 weeks ${r.actual == null ? 'n/a' : r.actual.toFixed(2)} (this week ${r.raw.toFixed(2)})`, `Actual ÷ model ${r.err == null ? 'n/a' : `${r.err.toFixed(2)}×`}`] })).concat(eventHov(events, f.X));
  return plotHtml(`<svg viewBox="0 0 ${W} ${h}" class="md-svg" role="img" aria-label="Requests per open night: London's shape, the model's rate and what arrived, with actual over model on the right-hand axis"${hovAttr(pts)}>${f.grid}${poly('market', f.Y, 'stroke="var(--sage)" stroke-width="2.25" stroke-dasharray="6 4"', 'src:market')}${poly('model', f.Y, 'stroke="var(--amber)" stroke-width="2"', 'src:model')}<g${lay('src:actual')}>${dots}</g>${poly('actual', f.Y, 'stroke="var(--slate)" stroke-width="2.5"', 'src:actual')}<g${lay('src:err')}>${poly('err', errY, 'stroke="var(--ink)" stroke-width="1.75"')}${rightAxis}</g>${eventLayer(events, f.X, h)}${crossLine(h)}</svg>`);
}

function ratioChart(calc, list, events, label, id) {
  const h = 150;
  const x0 = calc.first; const x1 = calc.today + 1;
  const lg = (v) => Math.log2(v);
  const f = frame({ h, x0, x1, yMin: -2, yMax: 2, ticks: [-2, -1, 0, 1, 2], fmt: (v) => ['¼×', '½×', '1×', '2×', '4×'][v + 2] });
  const dots = list.map((p) => `<circle cx="${f.X(p.t).toFixed(1)}" cy="${f.Y(lg(p.r)).toFixed(1)}" r="3" fill="var(--slate)" opacity="0.45"/>`).join('');
  const roll = [];
  for (let w = calc.first; w <= calc.today; w += 7) {
    const win = list.filter((p) => p.t > w + 7 - RECENT && p.t <= w + 7);
    if (win.length >= 4) roll.push(`${f.X(w + 3.5).toFixed(1)},${f.Y(median(win.map((p) => lg(p.r)))).toFixed(1)}`);
  }
  const dts = [...new Set(list.map((p) => p.t))].sort((a, b) => a - b);
  const pts = dts.map((t) => ({ x: f.X(t), lines: [shortDate(t)].concat(list.filter((p) => p.t === t).map((p) => `${label.fmt(p.actual)} against the model's ${label.fmt(p.model)} (${p.r.toFixed(2)}×)`)), layer: `${id}:dots` })).concat(eventHov(events, f.X));
  return plotHtml(`<svg viewBox="0 0 ${W} ${h}" class="md-svg" role="img" aria-label="${escapeHtml(label.name)} against the model"${hovAttr(pts)}>${f.grid}<line x1="${PL}" x2="${W - PR}" y1="${f.Y(0).toFixed(1)}" y2="${f.Y(0).toFixed(1)}" stroke="var(--ink)" stroke-width="1" opacity="0.5"/><g${lay(`${id}:dots`)}>${dots}</g>${roll.length > 1 ? `<polyline${lay(`${id}:median`)} points="${roll.join(' ')}" fill="none" stroke="var(--sage)" stroke-width="2" stroke-linejoin="round"/>` : ''}${eventLayer(events, f.X, h)}${crossLine(h)}</svg>`);
}

// ---- the section --------------------------------------------------------------------------------------------

const ui = { room: 0, ctx: null, params: null, calcs: {}, busy: false, layers: loadLayers() };

const money = (v) => `£${Math.round(v)}`;
const days = (v) => `${v < 10 ? v.toFixed(1) : Math.round(v)} days`;
const nights = (v) => `${v.toFixed(1)} nights`;

function chip(kind, text) { return `<span class="sh-chip ${kind}">${escapeHtml(text)}</span>`; }

function listingLink(ctx, id) {
  const name = ctx.listingLabels[id] || 'Listing';
  return `<span class="inline-goto-link" data-goto-tab="settings" data-goto-target="[data-airbnb-listing-id='${escapeHtml(id)}'][data-airbnb-listing-field='label']" title="Open this listing in Settings">${escapeHtml(name)}</span>`;
}

function statusTable(ctx, calc) {
  const rows = [];
  const d = calc.demand;
  if (d.recent) {
    const r = d.recent; const above = r.lo > 1; const below = r.hi < 1;
    rows.push(`<tr><td>Requests a week</td><td class="num">${d.K} in the last 4 weeks</td><td class="num">${d.E.toFixed(1)} expected</td><td class="num">${r.rho.toFixed(2)}× <span class="settings-note" style="margin:0;">(${r.lo.toFixed(2)}–${r.hi.toFixed(2)})</span></td><td>${above ? chip('warn', 'Running above the model') : below ? chip('warn', 'Running below the model') : chip('ok', 'In line')}</td></tr>`);
  }
  // Enquiries: not forecast, but how many turn into bookings says whether they are worth counting as demand.
  const enq = ctx.requests.filter((q) => q.kind === 'enquiry' && calc.ids.has(q.listingId) && q.receivedAt);
  if (enq.length) {
    // An enquiry lapses after 24 hours: one still undecided after that counts as not booked; only the last day's are open.
    const tally = (list) => { const live = (q) => Date.now() - Date.parse(q.receivedAt) < 864e5; const booked = list.filter((q) => q.decision === 'accepted').length; const open = list.filter((q) => q.decision !== 'accepted' && q.decision !== 'not-booked' && live(q)).length; const not = list.length - booked - open; return { n: list.length, booked, not, open, rate: booked + not ? booked / (booked + not) : null }; };
    const rc = tally(enq.filter((q) => dn(q.receivedAt) > calc.today - RECENT)); const all = tally(enq.filter((q) => dn(q.receivedAt) > calc.today - 182));
    const pct = (t) => (t.rate == null ? '–' : `${Math.round(t.rate * 100)}%`);
    rows.push(`<tr><td>Enquiries</td><td class="num">${rc.n} in the last 6 weeks</td><td class="num">${rc.booked} booked, ${rc.not} not, ${rc.open} open</td><td class="num">${pct(rc)} <span class="settings-note" style="margin:0;">(${pct(all)} of ${all.n} in 26 weeks)</span></td><td>${chip('', 'Not modelled')}</td></tr>`);
  }
  [['lead', 'Lead time', days], ['price', 'Price per night', money], ['length', 'Stay length', nights]].forEach(([k, name, fmt]) => {
    const rd = readPoints(calc.pts[k], calc.today);
    if (rd.tooFew) rows.push(`<tr><td>${name}</td><td class="num" colspan="3"><span class="settings-note" style="margin:0;">${rd.n} request${rd.n === 1 ? '' : 's'} in the last 6 weeks: too few to judge</span></td><td>${chip('', 'Too few')}</td></tr>`);
    else rows.push(`<tr><td>${name}</td><td class="num">${fmt(rd.actual)} typical (${rd.n} requests)</td><td class="num">${fmt(rd.model)} modelled</td><td class="num">${rd.ratio.toFixed(2)}×</td><td>${rd.off ? chip('warn', rd.ratio > 1 ? 'Higher than the model' : 'Lower than the model') : chip('ok', 'In line')}</td></tr>`);
  });
  return `<div style="overflow-x:auto;"><table class="limits-table"><thead><tr><th>Input</th><th class="num">Actual, recent</th><th class="num">Model</th><th class="num">Ratio</th><th>Read</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function storyHtml(ctx, calc) {
  const d = calc.demand; const out = [];
  if (d.split && d.split.lr > 9 && Math.abs(Math.log(d.split.after / Math.max(d.split.before, 0.01))) > Math.log(1.4)) {
    const s = d.split;
    out.push(`Requests changed level from the week of <b>${longDate(s.week)}</b>: ${s.before.toFixed(2)}× the model's expectation before, ${s.after.toFixed(2)}× since${s.after > s.before ? '' : ' (down)'}. The model's seasonality and the nights that were open are already allowed for, so this is not just the time of year (a statistical flag, not proof of cause).`);
  } else if (d.split) out.push('No clear change of level in the weekly requests against what the model expected.');
  const near = (calc.events || []).filter((e) => d.split && d.split.lr > 9 && Math.abs(e.t - d.split.week) <= 14);
  if (near.length) out.push(`Within two weeks of that: ${near.map((e) => `${e.n}. ${escapeHtml(e.lbl)}: ${escapeHtml(e.label)} (${shortDate(e.t)})`).join('; ')}.`);
  return out.length ? `<div class="settings-note" style="margin:8px 0;">${out.join(' ')}</div>` : '';
}

function eventsHtml(ctx, calc, events) {
  const listings = [...calc.ids];
  const opts = ['<option value="">All rooms</option>'].concat(listings.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(ctx.listingLabels[id] || 'Listing')}</option>`)).join('');
  const rows = events.map((e) => `<li class="md-ev"><b>${e.n}.</b> ${longDate(e.t)} · ${e.listingId ? listingLink(ctx, e.listingId) : 'All rooms'}: ${escapeHtml(e.label)}${e.auto ? '' : ` <button class="sync-btn sm inline" type="button" data-md-del="${escapeHtml(e.id)}" title="Remove this marker">Remove</button>`}</li>`).join('');
  return `<div class="md-events"><div class="settings-note" style="margin:0 0 4px;">Markers on the charts. First requests and stay endings come from your data (stay endings are hidden until you tick "Stay endings" above a chart); add the work you do on a listing so its effect can be seen.</div><ul class="md-evlist">${rows || '<li class="settings-note" style="margin:0;">None in this period.</li>'}</ul>
<div class="sync-row" style="align-items:flex-start;flex-wrap:wrap;gap:6px;margin-top:6px;"><input type="date" data-md-date value="${todayStr()}"><select data-md-listing>${opts}</select><input type="text" list="md-notes" data-md-note placeholder="What changed" autocomplete="off" style="min-width:160px;"><datalist id="md-notes"><option value="New photos"><option value="Title changed"><option value="Description rewritten"><option value="Price changed"><option value="Minimum stay changed"><option value="Amenities added"><option value="Calendar opened up"><option value="Cancellation policy changed"></datalist><button class="sync-btn sm inline" type="button" data-md-add>Add marker</button></div></div>`;
}

function sectionHtml() {
  const ctx = ui.ctx;
  const rooms = ctx.rooms;
  const calc = ui.calcs[ui.room];
  const picker = `<div class="sync-row" style="align-items:center;gap:8px;margin-bottom:6px;"><label class="settings-note" style="margin:0;">Room <select data-md-room>${rooms.map((r, i) => `<option value="${i}"${i === ui.room ? ' selected' : ''}>${escapeHtml(r.label)}</option>`).join('')}</select></label><button class="sync-btn sm inline" type="button" data-md-refresh>Recalculate</button></div>`;
  if (!calc || calc.empty) return `${picker}<div class="settings-note" style="margin:0;">No requests on file for this room yet, so there is nothing to compare.</div>`;
  const events = eventsFor(ctx, calc);
  calc.events = events;
  const cal = (data.prefs.bookingEvaluator || {}).calibration || {};
  const f = (v) => (Number(v) || 1).toFixed(2);
  const lead = { name: 'Lead time', fmt: (v) => `${v < 10 ? v.toFixed(1) : Math.round(v)} days` };
  const price = { name: 'Price per night', fmt: money };
  const len = { name: 'Stay length', fmt: (v) => `${v.toFixed(1)} nights` };
  return `${picker}
${statusTable(ctx, calc)}
${storyHtml(ctx, calc)}
<div class="md-chart"><div class="md-title">Requests received each week</div>${togglesHtml([{ fixed: true, label: 'requests', color: 'var(--slate)', bar: true }, { k: 'req:enq', label: 'enquiries', color: 'var(--slate)', bar: true }, { k: 'req:model', label: 'model expects', color: 'var(--amber)' }, { k: 'req:demand', label: 'our demand, all nights open (right axis)', color: 'var(--amber)', dash: true }, { k: 'req:season', label: 'London season (right axis)', color: 'var(--sage)', dash: true }])}<div class="settings-note" style="margin:0 0 2px;">Solid bars are requests and instant bookings by the day they landed; outlined bars on top are enquiries, which the model does not forecast (an enquiry that turns into a booking also appears as a solid bar). The orange line is the model's expectation of requests and instant bookings only, at list price, for the nights still open then, lightly smoothed for drawing. A faded last bar is this week so far. The two dashed lines share the right-hand axis (100% is an average week of the year) and are there to compare with each other: the orange one is the model's demand for this room with every night open, before availability takes its share, and the green one is how London private rooms rise and fall, read for the stay dates each week's requests are for (requests arrive ahead of the stay, so it runs earlier than the calendar). The solid orange line falls when the dashed ones rise if the busy nights are already booked: fewer nights are left to ask about. Point at a week for its figures. ${creditHtml()}</div>${demandChart(calc, events)}</div>
${sourceChart(calc, events) ? `<div class="md-chart"><div class="md-title">Where requests come from: London, our season, the model, what arrived</div>${togglesHtml([{ k: 'src:market', label: "London's shape", color: 'var(--sage)', dash: true }, { k: 'src:model', label: "model's rate", color: 'var(--amber)' }, { k: 'src:actual', label: 'actual (4-week)', color: 'var(--slate)' }, { k: 'src:err', label: 'actual ÷ model (right axis)', color: 'var(--ink)' }])}<div class="settings-note" style="margin:0 0 2px;">Requests per open night: how many requests each night on offer draws over its lead time, so a week with fewer open nights does not read as weaker demand. The dashed line is London's seasonal shape, scaled to the same average as the model and run through the model's own lead-time weights. The gap between it and the orange line is what the model has learned about your own seasonality (and the demand factor); the gap between orange and blue is what the model gets wrong. The dark line, on the right-hand axis, is that error as a ratio: 1× is right, above 1× means more requests than modelled. Actual is a 4-week rolling figure with single weeks as faint dots. ${creditHtml()}</div>${sourceChart(calc, events)}</div>` : ''}
<div class="md-chart"><div class="md-title">Lead time against the model</div>${togglesHtml([{ k: 'lead:dots', label: 'each request', color: 'var(--slate)', bar: true }, { k: 'lead:median', label: '6-week median', color: 'var(--sage)' }])}<div class="settings-note" style="margin:0 0 2px;">How far ahead requests come, as a multiple of the model's median for that check-in month (above 1× is further ahead than modelled).</div>${ratioChart(calc, calc.pts.lead, events, lead, 'lead')}</div>
<div class="md-chart"><div class="md-title">Price per night against the model</div>${togglesHtml([{ k: 'price:dots', label: 'each request', color: 'var(--slate)', bar: true }, { k: 'price:median', label: '6-week median', color: 'var(--sage)' }])}<div class="settings-note" style="margin:0 0 2px;">Each request's payout per night with the cleaning fee and short-notice and length discounts taken out, over the model's price for those nights.</div>${ratioChart(calc, calc.pts.price, events, price, 'price')}</div>
<div class="md-chart"><div class="md-title">Stay length against the model</div>${togglesHtml([{ k: 'len:dots', label: 'each request', color: 'var(--slate)', bar: true }, { k: 'len:median', label: '6-week median', color: 'var(--sage)' }])}<div class="settings-note" style="margin:0 0 2px;">Nights requested over the model's median stay.</div>${ratioChart(calc, calc.pts.length, events, len, 'len')}</div>
${eventsHtml(ctx, calc, events)}
<div class="settings-note" style="margin:8px 0 0;">Corrections in force: empty nights divided by ${f(cal.demand)}, lead time ×${f(cal.lead)}, and typical stay ${(data.prefs.bookingEvaluator || {}).stayMedian ? ((data.prefs.bookingEvaluator || {}).stayMedian + " nights") : "as learned"} (stay in <span class="inline-goto-link" data-goto-tab="settings" data-goto-target="#booking-evaluator-settings">Booking evaluator settings</span>). Where an input is flagged, work out a correction from recent requests in <span class="inline-goto-link" data-goto-tab="settings" data-goto-target="#model-review">Model review</span>. The model also borrows London's seasonal shape for months it has no evidence of its own. ${creditHtml()}</div>`;
}

function renderBody(el) {
  el.innerHTML = sectionHtml();
  applyLayers(el); wireHover(el);
}

// calibrate() and the demand rates are the slow part (a second or two), so they run when the section is opened.
function calculate(el, force = false) {
  if (ui.busy) return;
  const need = force || !ui.ctx;
  if (!need && ui.calcs[ui.room]) { renderBody(el); return; }
  ui.busy = true;
  el.innerHTML = '<div class="settings-note" style="margin:0;">Comparing the model with what has arrived…</div>';
  setTimeout(() => {
    try {
      if (need) { ui.ctx = buildContext(); ui.params = calibrate(ui.ctx); ui.calcs = {}; }
      if (!ui.calcs[ui.room]) ui.calcs[ui.room] = computeRoom(ui.ctx, ui.params, ui.room);
      renderBody(el);
    } catch (err) {
      console.error('Model drift failed:', err);
      el.innerHTML = `<div class="settings-note" style="margin:0;color:var(--red);">Could not compare: ${escapeHtml(err.message || String(err))}</div>`;
    } finally { ui.busy = false; }
  }, 30);
}

function initModelDrift() {
  const anchor = document.getElementById('letting-analytics-panel');
  if (!anchor || document.getElementById('model-drift')) return;
  anchor.insertAdjacentHTML('beforeend', '<details class="settings-subgroup" id="model-drift" style="margin-top:14px;"><summary style="font-size:13px;font-weight:600;">Model drift: do the model\'s inputs still match what is arriving?</summary><div id="model-drift-body" style="margin-top:8px;"></div></details>');
  const root = document.getElementById('model-drift');
  const body = document.getElementById('model-drift-body');
  root.addEventListener('toggle', () => { if (root.open) calculate(body, true); });
  root.addEventListener('change', (e) => {
    const tg = e.target.closest('[data-md-tog]');
    if (tg) { ui.layers[tg.dataset.mdTog] = tg.checked; saveLayers(); applyLayers(body); return; }
    const sel = e.target.closest('[data-md-room]');
    if (sel) { ui.room = Number(sel.value) || 0; calculate(body); }
  });
  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-md-refresh]')) { calculate(body, true); return; }
    const del = e.target.closest('[data-md-del]');
    if (del) { data.prefs.listingEvents = (data.prefs.listingEvents || []).filter((x) => x.id !== del.dataset.mdDel); queueSave(); renderBody(body); return; }
    if (e.target.closest('[data-md-add]')) {
      const date = body.querySelector('[data-md-date]').value;
      const note = body.querySelector('[data-md-note]').value.trim();
      if (!date || !note) return;
      data.prefs.listingEvents = [...(data.prefs.listingEvents || []), { id: uid(), listingId: body.querySelector('[data-md-listing]').value, date, note }];
      queueSave();
      renderBody(body);
    }
  });
}

export { initModelDrift, poissonBand, bestSplit, proposeRecent };
