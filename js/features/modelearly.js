// Early read: score the model's forecasts as if the future so far had been the whole story.
//
// The monthly review scores a night only once it has passed. This looks at the nights still to come too, comparing the
// bookings made so far with what the model's lead-time curve says should have arrived by now (not with the final
// chance, which a night weeks out cannot have reached yet), so it can show the model undershooting OR overshooting before
// the nights pass. It then blends those with the nights that already passed into one pooled reading. Early nights carry
// less weight automatically: their expected count is small until most of their bookings are due.
//
// Caveats the screen repeats: the lead-time curve is itself an assumption; nights of one booking are not independent
// (ranges are widened by the average stay); the forecast chances are not net of cancellations, so standing bookings are
// scaled by the cancellation rate; verdicts are in pounds and lumpy, so they get no range.
import { escapeHtml, todayStr, dateStrAdd } from '../utils.js';
import { buildContext, calibrate, driftKit } from './bookingmodel.js';
import { forecastNights, actualNights, requestReview } from './modelreview.js';

const Z90 = 1.645;
const MIN_EXPECTED = 3; // expected booked nights below which a group is too thin to read (a single booking would swing it)
const SUGGEST_MIN_SHARE = 0.7; // an early night counts towards a demand suggestion only when this much of its bookings should be in
const SUGGEST_MIN_NIGHTS = 40;
const SHRINK_K = 60;
const MIN_MOVE = 0.08;
const BUCKETS = [['0–7 days ahead', 0, 7], ['8–21 days ahead', 8, 21], ['22–45 days ahead', 22, 45], ['46+ days ahead', 46, 9999]];

const blank = () => ({ rows: 0, N: 0, E: 0, A: 0, V: 0 });
const add = (g, sh, q, a) => { g.rows += 1; g.N += sh; g.E += q; g.A += a; g.V += q * (1 - q); };

// Booked over expected, with a ~90% range that allows for a booking covering several nights.
function reading(g, stay) {
  if (!(g.E >= MIN_EXPECTED)) return { ...g, ratio: null, lo: null, hi: null, call: 'none' };
  const se = Math.sqrt(g.V * Math.max(1, stay));
  const ratio = g.A / g.E; const lo = Math.max(0, (g.A - Z90 * se) / g.E); const hi = (g.A + Z90 * se) / g.E;
  return { ...g, ratio, lo, hi, call: lo > 1 ? 'above' : hi < 1 ? 'below' : 'inline' };
}

async function earlyRead() {
  const ctx = buildContext(); const params = calibrate(ctx);
  const { dayNum, leadCdf } = driftKit;
  const today = todayStr(); const T = dayNum(today);
  const pC = params.cancelRate;
  const actual = actualNights();
  // Average nights per standing booking: one booking's nights move together, so the effective sample is smaller than the night count.
  const perStay = new Map();
  actual.forEach((a) => perStay.set(a.stayId, (perStay.get(a.stayId) || 0) + 1));
  const stay = perStay.size ? [...perStay.values()].reduce((a, b) => a + b, 0) / perStay.size : 3;

  // Share of the bookings a night gets after the forecast that should have arrived by today (1 for a night already passed).
  const shareOf = (c, made) => {
    if (c < T) return 1;
    const a = leadCdf(params, c, c - made);
    const b = leadCdf(params, c, c - T);
    return a > 1e-6 ? Math.max(0, Math.min(1, (a - b) / a)) : 0;
  };

  const rows = forecastNights(actual, { future: true }).map((r) => ({ ...r, first: r.first && !r.first.plan ? r.first : null })).filter((r) => r.first);
  const g = { final: blank(), early: blank(), all: blank(), sugg: blank() };
  const byFactor = new Map(); const byLead = new Map(BUCKETS.map((b) => [b[0], blank()]));
  const demandNow = ctx.scale.demand || 1;
  rows.forEach((r) => {
    const f = r.first; const c = dayNum(r.date); const made = dayNum(f.made);
    const future = c >= T;
    const sh = future ? shareOf(c, made) : 1;
    const q = f.p * sh;
    const a = future ? r.booked * (1 - pC) : r.booked;
    add(future ? g.early : g.final, sh, q, a);
    add(g.all, sh, q, a);
    const k = (Math.round(f.demand * 100) / 100).toFixed(2);
    if (!byFactor.has(k)) byFactor.set(k, { k: Number(k), ...blank() });
    add(byFactor.get(k), sh, q, a);
    const lead = c - made;
    const b = BUCKETS.find((x) => lead >= x[1] && lead <= x[2]);
    if (b) add(byLead.get(b[0]), sh, q, a);
    if (Math.abs(f.demand - demandNow) < 0.005 && (!future || sh >= SUGGEST_MIN_SHARE)) add(g.sugg, sh, q, a);
  });
  const out = {
    today, pC, stay, nights: rows.length,
    final: reading(g.final, stay), early: reading(g.early, stay), blended: reading(g.all, stay),
    byFactor: [...byFactor.values()].sort((a, b) => a.k - b.k).map((x) => ({ k: x.k, ...reading(x, stay) })),
    byLead: BUCKETS.map((b) => ({ label: b[0], ...reading(byLead.get(b[0]), stay) })),
    suggestion: null, current: demandNow,
  };
  // A demand suggestion from forecasts made under the factor now in force, early nights only once mostly resolved.
  const s = g.sugg;
  if (s.rows < SUGGEST_MIN_NIGHTS || s.E < 5) out.suggestion = { kind: 'note', text: `No suggestion yet: ${s.rows} night${s.rows === 1 ? '' : 's'} forecast under the factor now in force (×${demandNow.toFixed(2)}) are far enough along to use (needs ${SUGGEST_MIN_NIGHTS}).` };
  else {
    const vacExp = s.N - s.E; const vacAct = Math.max(s.N - s.A, 0.5);
    const shrunk = 1 + (vacExp / vacAct - 1) * (s.rows / (s.rows + SHRINK_K));
    if (Math.abs(shrunk - 1) < MIN_MOVE) out.suggestion = { kind: 'note', text: `Under the current factor, bookings are tracking the forecast (${s.A.toFixed(1)} against ${s.E.toFixed(1)} expected so far over ${s.rows} nights): no change suggested.` };
    else {
      const value = Math.max(0.4, Math.min(8, Math.round(demandNow * shrunk * 100) / 100));
      out.suggestion = { kind: 'demand', value, n: s.rows, text: `Under the current factor, ${s.A.toFixed(1)} bookings against ${s.E.toFixed(1)} expected so far over ${s.rows} nights. Dividing the empty nights by ×${value.toFixed(2)} (now ×${demandNow.toFixed(2)}) would have fitted better.` };
    }
  }

  // Verdicts: pounds, not nights. Final ones as the review scores them; unfinished ones as expected-by-now against standing bookings so far.
  const finals = requestReview(false);
  const earlies = requestReview(true).map((r) => {
    const made = dayNum(String(r.e.at).slice(0, 10));
    let sum = 0; let n = 0;
    for (let c = dayNum(r.e.block.from); c < dayNum(r.e.block.to); c++) { sum += shareOf(c, made); n += 1; }
    const sh = n ? sum / n : 0;
    return { ...r, sh, expectedNow: r.expectedNew * sh, actualNow: r.actualNew * (1 - pC) };
  });
  const sumOf = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
  out.verdicts = {
    early: earlies,
    final: { n: finals.length, exp: sumOf(finals, (x) => x.expectedNew), act: sumOf(finals, (x) => x.actualNew) },
    earlyTotals: { n: earlies.length, exp: sumOf(earlies, (x) => x.expectedNow), act: sumOf(earlies, (x) => x.actualNow) },
  };
  return out;
}

// ---- display ------------------------------------------------------------------------------------------------------

const money = (v) => `£${Math.round(v).toLocaleString('en-GB')}`;
const short = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

function readCells(r) {
  if (r.call === 'none') return '<td class="num be-zero">–</td><td class="settings-note" style="margin:0;">too little expected to read</td>';
  const cls = r.call === 'above' ? 'be-pos' : r.call === 'below' ? 'be-neg' : 'be-zero';
  const words = r.call === 'above' ? 'more bookings than the model expected' : r.call === 'below' ? 'fewer bookings than the model expected' : 'consistent with the model (range includes 1×)';
  return `<td class="num ${cls}">${r.ratio.toFixed(2)}× <span class="settings-note" style="margin:0;">(${r.lo.toFixed(2)}–${r.hi.toFixed(2)})</span></td><td>${escapeHtml(words)}</td>`;
}
const row = (label, r, note = '') => `<tr><td>${label}${note ? ` <span class="settings-note" style="margin:0;">${escapeHtml(note)}</span>` : ''}</td><td class="num">${r.rows}</td><td class="num">${r.E.toFixed(1)}</td><td class="num">${r.A.toFixed(1)}</td>${readCells(r)}</tr>`;
const head = (first) => `<thead><tr><th>${escapeHtml(first)}</th><th class="num" title="Forecast nights in this group">Nights</th><th class="num" title="Booked nights expected by now: the forecast chance times the share of its bookings the lead-time curve says are due">Expected so far</th><th class="num" title="Nights booked so far; those still to come are scaled by one minus the cancellation rate">Booked so far</th><th class="num">Booked over expected (90% range)</th><th>Read</th></tr></thead>`;

function earlyHtml(r) {
  const out = [];
  out.push(`<div style="overflow-x:auto;margin-top:6px;"><table class="limits-table be-table">${head('Forecast nights')}<tbody>${row('Passed (final)', r.final, 'scored as in the review above')}${row('Still to come (early)', r.early, 'booked so far against due by now')}${row('Blended', r.blended, 'both together')}</tbody></table></div>`);
  if (r.byFactor.length > 1 || (r.byFactor[0] && Math.abs(r.byFactor[0].k - r.current) > 0.005)) {
    out.push(`<details class="settings-subgroup"><summary>By the demand factor the forecast was made under</summary><div style="overflow-x:auto;"><table class="limits-table be-table">${head('Factor at forecast')}<tbody>${r.byFactor.map((x) => row(`×${x.k.toFixed(2)}${Math.abs(x.k - r.current) < 0.005 ? ' (now)' : ''}`, x)).join('')}</tbody></table></div><div class="settings-note" style="margin:4px 0 0;">Forecasts made under an earlier factor say how that factor did, not the one now in force, so they are not used for the suggestion below.</div></details>`);
  }
  out.push(`<details class="settings-subgroup"><summary>By how far ahead it was forecast</summary><div style="overflow-x:auto;"><table class="limits-table be-table">${head('Forecast lead')}<tbody>${r.byLead.map((x) => row(escapeHtml(x.label), x)).join('')}</tbody></table></div></details>`);
  const sg = r.suggestion;
  if (sg) {
    if (sg.kind === 'note') out.push(`<div class="settings-note" style="margin:6px 0;">${escapeHtml(sg.text)}</div>`);
    else out.push(`<div class="sync-row" style="align-items:center;margin:6px 0;"><span style="font-size:12px;">${escapeHtml(sg.text)}</span><button class="sync-btn sm inline" type="button" data-mr-apply="${sg.value}" data-mr-n="${sg.n}">Apply ×${sg.value.toFixed(2)}</button></div>`);
  }
  // Verdicts.
  const v = r.verdicts;
  out.push(`<div style="margin:10px 0 4px;"><b style="font-size:12px;">Verdicts, finished and still running</b></div>`);
  if (!v.early.length && !v.final.n) out.push('<div class="settings-note" style="margin:2px 0;">No saved verdicts to read yet.</div>');
  else {
    const ratio = (a, e) => (e > 50 ? `${(a / e).toFixed(2)}×` : '–');
    out.push(`<div style="overflow-x:auto;"><table class="limits-table be-table"><thead><tr><th>Request</th><th>You</th><th class="num" title="New bookings in the stretch expected in full">Expected in full</th><th class="num" title="Of that, what the lead-time curve says should have arrived by now">Expected so far</th><th class="num" title="Bookings made since the verdict, scaled by one minus the cancellation rate">Booked so far</th></tr></thead><tbody>${v.early.map((x) => `<tr><td><span class="inline-goto-link" data-mr-open-request="${escapeHtml(x.q.id)}" title="Open this request">${escapeHtml(`${x.q.guestName || 'Guest'} · ${short(x.q.checkin)} – ${short(x.q.checkout)}`)}</span> <span class="settings-note" style="margin:0;">stretch to ${escapeHtml(short(dateStrAdd(x.e.block.to, -1)))}</span></td><td>${x.accepted ? 'accepted it' : 'did not take it'}</td><td class="num">${money(x.expectedNew)}</td><td class="num">${money(x.expectedNow)} <span class="settings-note" style="margin:0;">(${Math.round(x.sh * 100)}% due)</span></td><td class="num">${money(x.actualNow)}${x.unknown ? ` <span class="settings-note" style="margin:0;">+${x.unknown} unpriced nights</span>` : ''}</td></tr>`).join('')}</tbody></table></div>`);
    const allExp = v.final.exp + v.earlyTotals.exp; const allAct = v.final.act + v.earlyTotals.act;
    out.push(`<div class="settings-note" style="margin:4px 0 0;">Finished verdicts (${v.final.n}): ${money(v.final.act)} booked against ${money(v.final.exp)} expected. Still running (${v.earlyTotals.n}): ${money(v.earlyTotals.act)} against ${money(v.earlyTotals.exp)} due by now. Blended: ${ratio(allAct, allExp)}${allExp > 50 ? '' : ' (too little expected to read)'}. Pounds from a handful of bookings are lumpy, so no range is given: read this as a direction, not a result.</div>`);
  }
  out.push(`<div class="settings-note" style="margin:8px 0 0;"><b>Read with care.</b> The early figures lean on the model's lead-time curve for how much of a night's bookings should be in by now; if real lead times are shorter than modelled, nights look under-booked early (the Lead time chart in Model drift checks that). Nights of one booking move together, so the ranges are widened for an average booking of ${r.stay.toFixed(1)} nights, and are still rough. Forecast chances ignore cancellations, so standing bookings still to come are scaled by one minus the cancellation rate (${Math.round(r.pC * 100)}%). Far-off nights say little until more of their bookings are due, which is why their expected count is small. The blend treats a passed night and a part-resolved one alike; it is a faster signal, not a better one, and the final score above still decides.</div>`);
  return out.join('');
}

export { earlyRead, earlyHtml };
