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
// There is no market feed in the app: the only public pattern the model carries is the starting lead times in Settings.
import { data, queueSave } from '../state.js';
import { escapeHtml, todayStr, uid } from '../utils.js';
import { buildContext, calibrate, driftKit, discountsOf, rawNightlyRate } from './bookingmodel.js';

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
  (ctx.blocks || []).forEach((b) => { if (ids.has(b.listingId) && b.from && b.to) held.push({ ci: dn(b.from), co: dn(b.to), since: -Infinity, until: Infinity }); });
  return (c, t) => { for (const o of held) if (c >= o.ci && c < o.co && o.since <= t && t < o.until) return 0; return 1; };
}

// Requests the model expects to be received in the week starting `t0`: each check-in date asks at its rate x weekday
// weight, and the lead-time curve says what share of that lands in this week.
function expectedWeek(ctx, params, ri, open, t0) {
  const { lambdaFor, leadCdf, dowOf, monthOf } = driftKit;
  let sum = 0;
  for (let c = t0; c < t0 + 420; c++) {
    const share = leadCdf(params, c, c - t0) - leadCdf(params, c, c - t0 - 7);
    if (!(share > 1e-9)) continue;
    const o = open(c, t0 + 3);
    if (!o) continue;
    sum += lambdaFor(ctx, params, ri, monthOf(c)) * params.dowW[dowOf(c)] * share;
  }
  return sum;
}

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
    weeks.push({
      t: w, partial: w + 7 > today + 1,
      requests: inWeek.filter((a) => a.kind === 'request').length,
      enquiries: inWeek.filter((a) => a.kind === 'enquiry').length,
      expected: expectedWeek(ctx, params, ri, open, w),
    });
  }
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
  return { room, ids, today, first, weeks, demand, pts, asks, clean };
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
    if (mine.length) out.push({ t: mine[0].t, label: 'first request', listingId: id, auto: true });
    // The last few stays to end on this listing, by guest (a stay's review can follow within days).
    ctx.earnings.filter((e) => e.listingId === id && e.start && dn(e.start) + e.nights <= calc.today && dn(e.start) + e.nights >= calc.first)
      .map((e) => ({ c: dn(e.start) + e.nights, who: String(e.guest || '').trim().split(/\s+/)[0] }))
      .sort((a, b) => b.c - a.c).slice(0, 8)
      .forEach((x) => out.push({ t: x.c, label: x.who ? `${x.who}'s stay ends` : 'a stay ends', listingId: id, auto: true }));
  });
  (data.prefs.listingEvents || []).forEach((e) => { if (e.date && (!e.listingId || calc.ids.has(e.listingId))) out.push({ t: dn(e.date), label: e.note || 'change', listingId: e.listingId || '', id: e.id }); });
  return out.filter((e) => e.t >= calc.first && e.t <= calc.today + 1).sort((a, b) => a.t - b.t).map((e, i) => ({ ...e, n: i + 1, lbl: e.listingId ? lbl(e.listingId) : 'All rooms' }));
}

// ---- charts -------------------------------------------------------------------------------------------------

const W = 640; const PL = 38; const PR = 8; const PT = 16; const PB = 20;

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

function eventLayer(events, X, h) {
  return events.map((e) => `<g><title>${escapeHtml(`${e.n}. ${shortDate(e.t)} · ${e.lbl}: ${e.label}`)}</title><line x1="${X(e.t).toFixed(1)}" x2="${X(e.t).toFixed(1)}" y1="${PT - 2}" y2="${h - PB}" stroke="var(--plum)" stroke-width="1" stroke-dasharray="3 3" opacity="${e.auto ? 0.45 : 0.9}"/><text x="${X(e.t).toFixed(1)}" y="${PT - 5}" text-anchor="middle" font-size="9" font-weight="600" fill="var(--plum)">${e.n}</text></g>`).join('');
}

function demandChart(calc, events) {
  const h = 190;
  const { weeks } = calc;
  const x0 = weeks[0].t; const x1 = weeks[weeks.length - 1].t + 7;
  const top = Math.max(2, ...weeks.map((w) => Math.max(w.requests + w.enquiries, w.expected))) * 1.1;
  const step = top > 12 ? 4 : top > 6 ? 2 : 1;
  const ticks = []; for (let v = 0; v <= top; v += step) ticks.push(v);
  const f = frame({ h, x0, x1, yMin: 0, yMax: Math.ceil(top / step) * step, ticks, fmt: (v) => String(v) });
  const bw = Math.max(2, (f.X(x0 + 7) - f.X(x0)) * 0.72);
  const bars = weeks.map((w) => {
    const x = f.X(w.t + 3.5) - bw / 2;
    const yR = f.Y(w.requests); const yE = f.Y(w.requests + w.enquiries); const base = f.Y(0);
    const tip = `Week of ${shortDate(w.t)}${w.partial ? ' (so far)' : ''}: ${w.requests} request${w.requests === 1 ? '' : 's'}${w.enquiries ? `, ${w.enquiries} enquir${w.enquiries === 1 ? 'y' : 'ies'}` : ''}; model expects ${w.expected.toFixed(1)}`;
    return `<g opacity="${w.partial ? 0.45 : 1}"><title>${escapeHtml(tip)}</title>${w.requests ? `<rect x="${x.toFixed(1)}" y="${yR.toFixed(1)}" width="${bw.toFixed(1)}" height="${(base - yR).toFixed(1)}" rx="2" fill="var(--slate)"/>` : ''}${w.enquiries ? `<rect x="${x.toFixed(1)}" y="${yE.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, yR - yE - 1).toFixed(1)}" rx="2" fill="var(--slate-bg)" stroke="var(--slate)" stroke-width="0.6"/>` : ''}<rect x="${(x - 2).toFixed(1)}" y="${PT}" width="${(bw + 4).toFixed(1)}" height="${(h - PT - PB).toFixed(1)}" fill="transparent"/></g>`;
  }).join('');
  const line = weeks.filter((w) => !w.partial).map((w) => `${f.X(w.t + 3.5).toFixed(1)},${f.Y(w.expected).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${W} ${h}" class="md-svg" role="img" aria-label="Requests received each week against the model's expectation">${f.grid}${bars}<polyline points="${line}" fill="none" stroke="var(--amber)" stroke-width="2" stroke-linejoin="round"/>${eventLayer(events, f.X, h)}</svg>`;
}

function ratioChart(calc, list, events, label) {
  const h = 150;
  const x0 = calc.first; const x1 = calc.today + 1;
  const lg = (v) => Math.log2(v);
  const f = frame({ h, x0, x1, yMin: -2, yMax: 2, ticks: [-2, -1, 0, 1, 2], fmt: (v) => ['¼×', '½×', '1×', '2×', '4×'][v + 2] });
  const dots = list.map((p) => `<circle cx="${f.X(p.t).toFixed(1)}" cy="${f.Y(lg(p.r)).toFixed(1)}" r="3" fill="var(--slate)" opacity="0.45"><title>${escapeHtml(`${shortDate(p.t)}: ${label.fmt(p.actual)} against the model's ${label.fmt(p.model)} (${p.r.toFixed(2)}×)`)}</title></circle>`).join('');
  const roll = [];
  for (let w = calc.first; w <= calc.today; w += 7) {
    const win = list.filter((p) => p.t > w + 7 - RECENT && p.t <= w + 7);
    if (win.length >= 4) roll.push(`${f.X(w + 3.5).toFixed(1)},${f.Y(median(win.map((p) => lg(p.r)))).toFixed(1)}`);
  }
  return `<svg viewBox="0 0 ${W} ${h}" class="md-svg" role="img" aria-label="${escapeHtml(label.name)} against the model">${f.grid}<line x1="${PL}" x2="${W - PR}" y1="${f.Y(0).toFixed(1)}" y2="${f.Y(0).toFixed(1)}" stroke="var(--ink)" stroke-width="1" opacity="0.5"/>${dots}${roll.length > 1 ? `<polyline points="${roll.join(' ')}" fill="none" stroke="var(--sage)" stroke-width="2" stroke-linejoin="round"/>` : ''}${eventLayer(events, f.X, h)}</svg>`;
}

// ---- the section --------------------------------------------------------------------------------------------

const ui = { room: 0, ctx: null, params: null, calcs: {}, busy: false };

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
  const rows = events.map((e) => `<li class="md-ev"><b>${e.n}.</b> ${shortDate(e.t)} · ${e.listingId ? listingLink(ctx, e.listingId) : 'All rooms'}: ${escapeHtml(e.label)}${e.auto ? '' : ` <button class="sync-btn sm inline" type="button" data-md-del="${escapeHtml(e.id)}" title="Remove this marker">Remove</button>`}</li>`).join('');
  return `<div class="md-events"><div class="settings-note" style="margin:0 0 4px;">Markers on the charts. Stay endings and first requests come from your data; add the work you do on a listing so its effect can be seen.</div><ul class="md-evlist">${rows || '<li class="settings-note" style="margin:0;">None in this period.</li>'}</ul>
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
<div class="md-chart"><div class="md-title">Requests received each week <span class="md-key"><i style="background:var(--slate)"></i>requests <i style="background:var(--slate-bg);border:1px solid var(--slate)"></i>enquiries <i style="background:var(--amber)"></i>model expects</span></div><div class="settings-note" style="margin:0 0 2px;">Counts requests, enquiries and instant bookings by the day they landed. The model line is what it expects at list price for the nights that were still open; the pale last bar is this week so far.</div>${demandChart(calc, events)}</div>
<div class="md-chart"><div class="md-title">Lead time against the model <span class="md-key"><i style="background:var(--slate)"></i>each request <i style="background:var(--sage)"></i>6-week median</span></div><div class="settings-note" style="margin:0 0 2px;">How far ahead requests come, as a multiple of the model's median for that check-in month (above 1× is further ahead than modelled).</div>${ratioChart(calc, calc.pts.lead, events, lead)}</div>
<div class="md-chart"><div class="md-title">Price per night against the model</div><div class="settings-note" style="margin:0 0 2px;">Each request's payout per night with the cleaning fee and short-notice and length discounts taken out, over the model's price for those nights.</div>${ratioChart(calc, calc.pts.price, events, price)}</div>
<div class="md-chart"><div class="md-title">Stay length against the model</div><div class="settings-note" style="margin:0 0 2px;">Nights requested over the model's median stay.</div>${ratioChart(calc, calc.pts.length, events, len)}</div>
${eventsHtml(ctx, calc, events)}
<div class="settings-note" style="margin:8px 0 0;">Corrections currently applied by the monthly review: demand ×${f(cal.demand)}, lead time ×${f(cal.lead)}. Where an input is flagged, apply a correction in <span class="inline-goto-link" data-goto-tab="settings" data-goto-target="#model-review">Model review</span>. There is no market data feed here: the only public pattern in the model is the starting lead times in Settings.</div>`;
}

function renderBody(el) {
  el.innerHTML = sectionHtml();
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

export { initModelDrift, poissonBand, bestSplit };
