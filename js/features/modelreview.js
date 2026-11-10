// The monthly model review: what the booking model said would happen against what did.
//
// Two kinds of estimate are saved, and both are checked here once their nights have passed:
//  - void projections (data.bookingProjections): for each free night, the chance it would be booked and
//    what it would earn. Each night is scored against the earliest forecast that covered it (the
//    longest lead) and the latest one made before it (the shortest).
//  - accept/reject verdicts (data.bookingRequests[].evaluation): for each request you evaluated and
//    then accepted or turned down, the expected income of its free stretch against what that stretch
//    actually earned.
// Nothing is changed by looking. The review can propose a demand factor and applies it only when
// you press Apply (prefs.bookingEvaluator.calibration, used by every later evaluation and projection).
import { data, queueSave } from '../state.js';
import { escapeHtml, todayStr, dateStrAdd, scrollAndFlash } from '../utils.js';
import { nightRateRooms } from './letting.js';
import { collectStays } from './lettingoccupancy.js';
import { stayChipHtml, bindStayChips } from './airbnb.js';
import { MODEL_VERSION } from './bookingmodel.js';

const MIN_NIGHTS_FOR_PROPOSAL = 40;
const MIN_NIGHTS_FOR_BUCKET = 25;
const PROPOSAL_SHRINK_K = 60; // pseudo-nights pulling a proposed factor back towards 1
const PROPOSAL_MIN_MOVE = 0.08;

const money = (v) => `£${Math.round(v).toLocaleString('en-GB')}`;
const dayMs = 86400000;
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / dayMs);
const monthName = (ym) => new Date(`${ym}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
const short = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const pctTxt = (v) => `${Math.round(v * 100)}%`;
const ratioTxt = (exp, act) => (exp > 0.5 ? `${Math.round((act / exp) * 100)}%` : '–');

function calibrationNow() {
const c = (data.prefs.bookingEvaluator || {}).calibration || {};
return { demand: Number(c.demand) || 1, lead: Number(c.lead) || 1, cancel: Number(c.cancel) || 1, appliedOn: c.appliedOn || '', note: c.note || '', history: Array.isArray(c.history) ? c.history : [] };
}

// ---- What actually happened, night by night ----------------------------------------------------

function actualNights() {
const roomOf = new Map();
nightRateRooms().forEach((room) => room.listingIds.forEach((id) => roomOf.set(id, room.key)));
const out = new Map(); // `${roomKey}|${date}` -> {income|null, stayId}
collectStays().forEach((s) => {
if (s.status !== 'stay' || s.unconfirmed) return;
const room = roomOf.get(s.listingId);
if (!room) return;
const n = daysBetween(s.checkin, s.checkout);
if (n <= 0) return;
const per = s.income == null ? null : Number(s.income) / n;
for (let i = 0; i < n; i++) {
const key = `${room}|${dateStrAdd(s.checkin, i)}`;
if (!out.has(key)) out.set(key, { income: per, stayId: s.id, bookedOn: s.bookedOn || '' });
}
});
return out;
}

// ---- Projections against outcomes --------------------------------------------------------------

// Every elapsed night a saved projection covered, with the earliest and the latest forecast for it.
function forecastNights(actual, { future = false } = {}) {
const today = todayStr();
// Only projections made by the current version of the model are scored: an earlier one rested on a different price basis
// (before rates were worked back from the earnings export), and scoring it would mislead the calibration.
const projections = (data.bookingProjections || []).filter((p) => (p.modelVersion || 1) === MODEL_VERSION).sort((a, b) => String(a.madeAt).localeCompare(String(b.madeAt)));
const nights = new Map();
projections.forEach((p) => {
const made = String(p.madeAt).slice(0, 10) || p.today;
const demand = p.assumptions && p.assumptions.calibration ? Number(p.assumptions.calibration.demand) || 1 : 1;
(p.voids || []).forEach((v) => {
for (let i = 0; i < v.nights; i++) {
const date = dateStrAdd(v.from, i);
if ((date >= today && !future) || date <= made) continue; // only nights that have passed (unless the early read asks for the ones still to come), and were still in the future when forecast
const key = `${v.roomKey}|${date}`;
// A night inside a void plan (what you set on Airbnb) is forecast with it, and the same night without it is kept alongside.
const plan = (p.plans || []).find((q) => q.roomKey === v.roomKey && date >= q.from && date < q.to) || null;
const f = { p: v.nightProb[i] || 0, income: v.nightIncome[i] || 0, made, lead: daysBetween(made, date), voidNights: v.nights, demand, plan, noP: plan && v.noPlan ? (v.noPlan.nightProb[i] || 0) : null, noIncome: plan && v.noPlan ? (v.noPlan.nightIncome[i] || 0) : null };
const cur = nights.get(key) || { roomKey: v.roomKey, date, first: null, last: null };
if (!cur.first) cur.first = f;
cur.last = f;
nights.set(key, cur);
}
});
});
nights.forEach((row) => {
const a = actual.get(`${row.roomKey}|${row.date}`);
row.booked = a ? 1 : 0;
row.actualIncome = a && a.income != null ? a.income : null;
row.incomeKnown = !a || a.income != null;
row.stayId = a ? a.stayId : '';
});
return [...nights.values()];
}

function summarise(rows, which) {
const out = { n: 0, expN: 0, actN: 0, expInc: 0, actInc: 0, unknownInc: 0, brier: 0 };
rows.forEach((r) => {
const f = r[which];
if (!f) return;
out.n += 1; out.expN += f.p; out.actN += r.booked; out.brier += (f.p - r.booked) ** 2;
if (r.incomeKnown) { out.expInc += f.income; out.actInc += r.actualIncome || 0; } else out.unknownInc += 1;
});
out.brier = out.n ? out.brier / out.n : 0;
return out;
}

function bucketed(rows, which, keyOf, labels) {
const groups = new Map(labels.map((l) => [l, []]));
rows.forEach((r) => { if (!r[which]) return; const k = keyOf(r, r[which]); if (groups.has(k)) groups.get(k).push(r); });
return labels.map((l) => ({ label: l, ...summarise(groups.get(l), which) }));
}

// Nights forecast under a void plan, scored on their own: with-plan and without-plan expectations against what happened.
// (What would have happened without the plan can't be observed, so both stay as the model's estimates.)
function planReview(all) {
const groups = new Map();
all.forEach((r) => {
const f = r.last;
if (!f || !f.plan) return;
const g = groups.get(f.plan.id) || { plan: f.plan, n: 0, withN: 0, withInc: 0, noN: 0, noInc: 0, noKnown: 0, actN: 0, actInc: 0, unknown: 0, from: r.date, to: r.date };
g.n += 1; g.withN += f.p; g.actN += r.booked;
if (r.date < g.from) g.from = r.date;
if (r.date > g.to) g.to = r.date;
if (f.noP != null) { g.noN += f.noP; g.noKnown += 1; }
if (r.incomeKnown) { g.withInc += f.income; g.actInc += r.actualIncome || 0; if (f.noIncome != null) g.noInc += f.noIncome; } else g.unknown += 1;
groups.set(f.plan.id, g);
});
return [...groups.values()].sort((a, b) => String(b.plan.madeOn).localeCompare(String(a.plan.madeOn)));
}

function projectionReview() {
const actual = actualNights();
const all = forecastNights(actual);
// The existing scoring and the demand proposal leave out forecasts made under a plan: a plan changes how nights are sold,
// not how much demand there is, so counting those nights would pull the demand factor the wrong way.
const rows = all.map((r) => ({ ...r, first: r.first && !r.first.plan ? r.first : null, last: r.last && !r.last.plan ? r.last : null }));
const months = [...new Set(rows.map((r) => r.date.slice(0, 7)))].sort().reverse();
const byMonth = months.map((ym) => {
const mine = rows.filter((r) => r.date.startsWith(ym));
return { ym, first: summarise(mine, 'first'), last: summarise(mine, 'last') };
});
const dow = (r) => new Date(`${r.date}T00:00:00`).getDay();
const view = {
rows: all, byMonth, plans: planReview(all),
overall: { first: summarise(rows, 'first'), last: summarise(rows, 'last') },
byLead: bucketed(rows, 'first', (r, f) => (f.lead <= 7 ? '0–7 days ahead' : f.lead <= 21 ? '8–21 days ahead' : f.lead <= 45 ? '22–45 days ahead' : '46+ days ahead'), ['0–7 days ahead', '8–21 days ahead', '22–45 days ahead', '46+ days ahead']),
byLen: bucketed(rows, 'first', (r, f) => (f.voidNights <= 2 ? '1–2 night gaps' : f.voidNights <= 5 ? '3–5 night gaps' : '6+ night gaps'), ['1–2 night gaps', '3–5 night gaps', '6+ night gaps']),
byDay: bucketed(rows, 'first', (r) => ([5, 6].includes(dow(r)) ? 'Fri and Sat nights' : 'Sun–Thu nights'), ['Sun–Thu nights', 'Fri and Sat nights']),
calibration: [],
};
const edges = [[0, 0.1], [0.1, 0.25], [0.25, 0.5], [0.5, 0.75], [0.75, 1.01]];
view.calibration = edges.map(([lo, hi]) => {
const mine = rows.filter((r) => r.first && r.first.p >= lo && r.first.p < hi);
const s = summarise(mine, 'first');
return { label: `${Math.round(lo * 100)}–${Math.min(100, Math.round(hi * 100))}%`, n: s.n, predicted: s.n ? s.expN / s.n : 0, actual: s.n ? s.actN / s.n : 0 };
});
view.proposals = proposals(rows);
return view;
}

// A demand factor that would have fitted: observed booked nights over expected, for forecasts made under
// the factor now in force, pulled back towards 1 by how little evidence there is.
function proposals(rows) {
const cal = calibrationNow();
const same = rows.filter((r) => r.first && Math.abs(r.first.demand - cal.demand) < 0.005);
const s = summarise(same, 'first');
const out = [];
if (s.n < MIN_NIGHTS_FOR_PROPOSAL || s.expN < 5) {
out.push({ kind: 'note', text: `Not enough evidence for a proposal yet: ${s.n} night${s.n === 1 ? '' : 's'} checked against forecasts made with the current factor (needs ${MIN_NIGHTS_FOR_PROPOSAL}).` });
return out;
}
const ratio = s.actN / s.expN;
// The factor divides the empty nights, so it is the empty nights that are compared: expected against what stayed empty.
const vacExp = s.n - s.expN; const vacAct = Math.max(s.n - s.actN, 0.5);
const vacRatio = vacExp / vacAct;
const shrunk = 1 + (vacRatio - 1) * (s.n / (s.n + PROPOSAL_SHRINK_K));
if (Math.abs(shrunk - 1) < PROPOSAL_MIN_MOVE) {
out.push({ kind: 'note', text: `Bookings arrived about as often as projected (${Math.round(ratio * 100)}% of the expected nights over ${s.n} nights): no change proposed.` });
return out;
}
const suggested = Math.max(0.4, Math.min(8, Math.round(cal.demand * shrunk * 100) / 100));
out.push({
kind: 'demand', value: suggested, from: cal.demand, n: s.n,
text: `Over ${s.n} nights, ${s.actN} were booked against ${s.expN.toFixed(1)} expected (${Math.round(ratio * 100)}%), so ${vacAct.toFixed(0)} stayed empty against ${vacExp.toFixed(1)} expected. Dividing the empty nights by ×${suggested.toFixed(2)} (now ×${cal.demand.toFixed(2)}) would have fitted better.`,
});
return out;
}

// ---- Accepted and declined estimates against outcomes --------------------------------------------

function requestReview(early = false) {
const today = todayStr();
const roomOf = new Map();
nightRateRooms().forEach((room) => room.listingIds.forEach((id) => roomOf.set(id, room.key)));
const stays = collectStays().filter((s) => s.status === 'stay' && !s.unconfirmed);
const rows = [];
(data.bookingRequests || []).forEach((q) => {
const e = q.evaluation;
if (!e || !e.block || !e.acceptParts) return;
if ((e.block.to > today) !== early) return; // the final score waits for every night to pass; the early read takes the ones that have not
const decided = q.decision;
if (!decided || decided === '') return;
const room = e.roomKey || roomOf.get(q.listingId);
const evaluatedOn = String(e.at).slice(0, 10);
const accepted = decided === 'accepted';
// What the free stretch earned from bookings that arrived after the verdict (the request's own stay aside).
let actualNew = 0; let nightsNew = 0; let unknown = 0;
const own = accepted ? stays.find((s) => s.id === q.reservationId) : null;
stays.forEach((s) => {
if (roomOf.get(s.listingId) !== room || (own && s.id === own.id)) return;
if (!s.bookedOn || s.bookedOn < evaluatedOn) return; // already booked when you evaluated it
for (let d = Math.max(s.checkin, e.block.from); d < Math.min(s.checkout, e.block.to); d = dateStrAdd(d, 1)) {
nightsNew += 1;
const n = daysBetween(s.checkin, s.checkout);
if (s.income == null) unknown += 1; else actualNew += Number(s.income) / n;
}
});
const side = accepted ? e.acceptParts : e.rejectParts;
const expectedNew = side.before + side.inside + side.after;
const row = { q, e, accepted, expectedNew, actualNew, nightsNew, unknown, own, expectedRequest: accepted ? e.acceptParts.request : 0, actualRequest: null, outcome: '', record: null };
if (accepted) {
const record = (data.airbnbReservations || []).find((x) => x.id === q.reservationId) || null;
row.record = record;
row.outcome = own ? 'stayed' : record && record.status === 'cancelled' ? 'cancelled' : q.reservationId ? 'no stay found' : 'no stay linked';
if (own && own.income != null) row.actualRequest = Number(own.income);
else if (q.reservationId) {
const paid = (data.lettingLedger || []).filter((x) => x.reservationId === q.reservationId && x.kind === 'cancellation').reduce((a, x) => a + Number(x.gross || 0), 0);
if (paid > 0) row.actualRequest = paid;
}
}
rows.push(row);
});
return rows.sort((a, b) => String(b.e.at).localeCompare(String(a.e.at)));
}

// ---- Rendering ---------------------------------------------------------------------------------

function summaryRow(label, s, w) {
const gap = s.actN - s.expN;
return `<tr><td>${escapeHtml(label)}</td><td class="num">${s.n}</td><td class="num">${s.expN.toFixed(1)}</td><td class="num">${s.actN}</td><td class="num ${Math.abs(gap) < 0.5 ? 'be-zero' : gap > 0 ? 'be-pos' : 'be-neg'}">${ratioTxt(s.expN, s.actN)}</td><td class="num">${money(s.expInc)}</td><td class="num">${money(s.actInc)}${s.unknownInc ? ` <span class="settings-note" style="margin:0;" title="Booked nights with no income entered, left out of this figure">+${s.unknownInc} unpriced</span>` : ''}</td>${w ? `<td class="num">${s.n ? s.brier.toFixed(2) : '–'}</td>` : ''}</tr>`;
}

function tableHead(first, withBrier = true) {
return `<thead><tr><th>${escapeHtml(first)}</th><th class="num" title="Nights that have passed and were forecast">Nights</th><th class="num" title="Booked nights the model expected">Expected</th><th class="num">Booked</th><th class="num" title="Booked over expected">Hit</th><th class="num">Expected income</th><th class="num">Actual income</th>${withBrier ? '<th class="num" title="Average squared miss on each night\'s chance (0 = perfect, 0.25 = no better than guessing 50%)">Score</th>' : ''}</tr></thead>`;
}

// ---- Booking pace and typical stay, proposed from the last 12 weeks of requests ------------------------------------

const recent = { busy: false, msg: '', result: null, error: '' };
const pctOf = (v) => (v == null ? '–' : `${Math.round(v * 100)}%`);

function recentHtml() {
const cal = calibrationNow();
const be = data.prefs.bookingEvaluator || {};
const head = `<div style="margin:12px 0 4px;"><b style="font-size:12px;">Booking pace and typical stay, from recent requests</b></div><div class="settings-note" style="margin:2px 0 6px;">Looks at the last 12 weeks of requests, newer weeks counting more (a week's weight halves every four weeks), and works out what the settings would need to be for the model to expect what arrived. Nothing changes until you press Apply: edit either number first if you disagree. The monthly nudge on Today points here.</div><div class="sync-row" style="align-items:center;margin:2px 0;"><button class="sync-btn sm inline" type="button" data-mr-recent${recent.busy ? ' disabled' : ''}>${recent.result ? 'Work it out again' : 'Work it out from recent requests'}</button><span class="settings-note" style="margin:0;">${recent.busy ? escapeHtml(recent.msg) : recent.error ? `<span style="color:var(--red);">${escapeHtml(recent.error)}</span>` : ''}</span></div>`;
const r = recent.result;
if (!r) return head;
const rows = [];
const p = r.pace;
if (p.tooFew) rows.push(`<tr><td>Demand</td><td colspan="3" class="settings-note">Only ${p.N} request${p.N === 1 ? '' : 's'} in the last 12 weeks: too few to propose a change.</td></tr>`);
else {
const rooms = p.rooms.map((x) => `${escapeHtml(x.label)} ${x.K} against ${x.E.toFixed(1)}`).join('; ');
rows.push(`<tr><td>Demand<div class="settings-note" style="margin:0;">empty nights divided by</div></td><td class="num">×${r.current.toFixed(2)}</td><td class="num"><input type="number" step="0.05" min="0.25" max="16" value="${p.proposed.toFixed(2)}" data-mr-new-demand style="width:64px;"></td><td class="settings-note">${p.N} requests arrived against ${p.expected.toFixed(1)} expected at ×${r.current.toFixed(2)} (${rooms}). Matching them exactly would take ×${p.fit.toFixed(2)}${p.atBound ? ' (the limit of what is tried)' : ''}; pulled back towards the current factor by how few requests there are, that gives ×${p.proposed.toFixed(2)}. A typical month's target occupancy goes ${pctOf(p.occNow)} to ${pctOf(p.occProposed)}.</td></tr>`);
}
const s = r.stay;
if (s.tooFew) rows.push(`<tr><td>Typical stay</td><td colspan="3" class="settings-note">Only ${s.n} request${s.n === 1 ? '' : 's'} with nights in the last 12 weeks: too few to propose a change.</td></tr>`);
else rows.push(`<tr><td>Typical stay<div class="settings-note" style="margin:0;">median nights</div></td><td class="num">${s.pinned ? `${s.pinned} (set)` : `${s.model} (learned)`}</td><td class="num"><input type="number" step="1" min="1" max="7" value="${s.proposed}" data-mr-new-stay style="width:64px;"></td><td class="settings-note">${s.n} requests since ${escapeHtml(short(r.window.from))} ask for a median of ${s.median} night${s.median === 1 ? '' : 's'} (mean ${s.mean.toFixed(1)}${s.long ? `, ${s.long} of ${s.n} are 14 nights or more` : ''}). The model's median is set higher than the requests' on purpose if you want the long stays in the mix to average out, so change it only if you agree.</td></tr>`);
return `${head}<div style="overflow-x:auto;margin-top:6px;"><table class="limits-table be-table"><thead><tr><th>Setting</th><th class="num">Now</th><th class="num">Proposed (editable)</th><th>Why</th></tr></thead><tbody>${rows.join('')}</tbody></table></div><div class="sync-row" style="align-items:center;margin:6px 0;"><button class="sync-btn sm inline" type="button" data-mr-recent-apply>Apply these</button><span class="settings-note" style="margin:0;">Window ${escapeHtml(short(r.window.from))} – ${escapeHtml(short(r.window.to))}. Current: stay ${be.stayMedian ? `${be.stayMedian} nights` : 'as learned'}, empty nights divided by ×${cal.demand.toFixed(2)}.</span></div>`;
}

// ---- Early read: the forecasts scored as if the future so far had happened (js/features/modelearly.js) ----

const early = { busy: false, error: '', html: '' };

function earlyBlockHtml() {
return `<div style="margin:12px 0 4px;"><b style="font-size:12px;">Early read: forecasts scored before their nights have passed</b></div><div class="settings-note" style="margin:2px 0 6px;">Compares the bookings made so far with what the model's lead-time curve says should have arrived by now, for nights still to come as well as the ones that passed, and blends the two. It can show the model undershooting or overshooting weeks before the final score can, but it is a faster, rougher signal: the caveats are listed under the result.</div><div class="sync-row" style="align-items:center;margin:2px 0;"><button class="sync-btn sm inline" type="button" data-mr-early${early.busy ? ' disabled' : ''}>${early.html ? 'Read it again' : 'Read the forecasts early'}</button><span class="settings-note" style="margin:0;">${early.busy ? 'Reading…' : early.error ? `<span style="color:var(--red);">${escapeHtml(early.error)}</span>` : ''}</span></div>${early.html}`;
}

async function runEarly() {
if (early.busy) return;
early.busy = true; early.error = '';
renderModelReview();
try {
await new Promise((r) => setTimeout(r, 30));
const mod = await import('./modelearly.js');
early.html = mod.earlyHtml(await mod.earlyRead());
} catch (err) {
console.error('Early read failed:', err);
early.error = `Could not read them: ${err.message || err}`;
}
early.busy = false;
renderModelReview();
}

async function runRecent() {
if (recent.busy) return;
recent.busy = true; recent.error = ''; recent.msg = 'Reading the last 12 weeks of requests…';
renderModelReview();
try {
const { proposeRecent } = await import('./modeldrift.js');
recent.result = await proposeRecent((m) => { recent.msg = m; const el = document.querySelector('#model-review-body [data-mr-recent]'); if (el && el.parentElement.lastElementChild) el.parentElement.lastElementChild.textContent = m; });
} catch (err) {
console.error('Recent-requests proposal failed:', err);
recent.error = `Could not work it out: ${err.message || err}`;
}
recent.busy = false;
renderModelReview();
}

function applyRecent(root) {
const r = recent.result; if (!r) return;
const be = data.prefs.bookingEvaluator || (data.prefs.bookingEvaluator = {});
const cal = calibrationNow();
const demandEl = root.querySelector('[data-mr-new-demand]'); const stayEl = root.querySelector('[data-mr-new-stay]');
const notes = [];
if (demandEl && demandEl.value !== '') {
const v = Math.min(16, Math.max(0.25, Math.round(Number(demandEl.value) * 100) / 100));
if (Number.isFinite(v) && Math.abs(v - cal.demand) > 0.004) {
be.calibration = { demand: v, lead: cal.lead, cancel: cal.cancel, appliedOn: todayStr(), note: 'from recent requests', history: [...cal.history, { on: todayStr(), demand: v, from: cal.demand, n: r.pace && r.pace.N || 0, note: `last 12 weeks of requests, ${r.pace && r.pace.N || 0}` }] };
notes.push(`empty nights ÷ ×${v.toFixed(2)}`);
}
}
if (stayEl && stayEl.value !== '') {
const v = Math.min(7, Math.max(1, Math.round(Number(stayEl.value))));
if (Number.isFinite(v) && v !== Number(be.stayMedian)) { be.stayMedian = v; notes.push(`typical stay ${v}`); }
}
if (!notes.length) { recent.error = 'Nothing to apply: both numbers match what is already set.'; renderModelReview(); return; }
recent.result = null; recent.error = '';
queueSave();
renderModelReview();
const out = document.querySelector('#model-review-body [data-mr-recent]');
if (out && out.parentElement.lastElementChild) out.parentElement.lastElementChild.textContent = `Applied: ${notes.join(', ')}.`;
}

function reviewHtml() {
const cal = calibrationNow();
const pr = projectionReview();
const reqs = requestReview();
const projCount = (data.bookingProjections || []).filter((p) => (p.modelVersion || 1) === MODEL_VERSION).length;
const older = (data.bookingProjections || []).length - projCount;
const lines = [];
lines.push(`<div class="settings-note" style="margin:4px 0 8px;">Compares what the model projected, and what it estimated when you evaluated a request, with what happened. ${projCount} saved projection${projCount === 1 ? '' : 's'}; ${pr.rows.length} night${pr.rows.length === 1 ? '' : 's'} checked so far.${older ? ` ${older} earlier projection${older === 1 ? '' : 's'} from the previous price basis ${older === 1 ? 'is' : 'are'} not scored.` : ''} Calibration in force: empty nights divided by ×${cal.demand.toFixed(2)}${cal.appliedOn ? ` (applied ${escapeHtml(cal.appliedOn)})` : ''}.</div>`);
if (!pr.rows.length) {
const first = (data.bookingProjections || []).slice().sort((a, b) => String(a.madeAt).localeCompare(String(b.madeAt)))[0];
lines.push(`<div class="settings-note" style="margin:6px 0;">Nothing to compare yet. ${first ? `Projections are checked once their nights have passed: the first one was made on ${escapeHtml(String(first.madeAt).slice(0, 10))} and covers up to ${escapeHtml(dateStrAdd(first.to, -1))}.` : 'Run "Project the next three months" in the occupancy section, and come back after the month has gone.'}</div>`);
} else {
lines.push(`<div style="overflow-x:auto;"><table class="limits-table be-table">${tableHead('Month (forecast made earliest)')}<tbody>${pr.byMonth.map((m) => summaryRow(`${monthName(m.ym)}`, m.first, true)).join('')}${summaryRow('All months', pr.overall.first, true)}</tbody></table></div>`);
lines.push(`<div style="overflow-x:auto;margin-top:8px;"><table class="limits-table be-table">${tableHead('Month (latest forecast before each night)')}<tbody>${pr.byMonth.map((m) => summaryRow(`${monthName(m.ym)}`, m.last, true)).join('')}${summaryRow('All months', pr.overall.last, true)}</tbody></table></div>`);
const small = (s) => (s.n < MIN_NIGHTS_FOR_BUCKET ? ' <span class="settings-note" style="margin:0;">few nights, take with care</span>' : '');
const bucketTable = (title, list) => `<details class="settings-subgroup"><summary>${escapeHtml(title)}</summary><div style="overflow-x:auto;"><table class="limits-table be-table">${tableHead(title)}<tbody>${list.map((b) => summaryRow(b.label, b, true).replace(/<td>([^<]*)<\/td>/, `<td>$1${small(b)}</td>`)).join('')}</tbody></table></div></details>`;
if (pr.plans.length) {
const roomLabel = (key) => (nightRateRooms().find((r) => r.key === key) || {}).label || 'Room';
lines.push(`<div style="margin:10px 0 4px;"><b style="font-size:12px;">Voids where you set a price or minimum stay</b></div>`);
lines.push(`<div style="overflow-x:auto;"><table class="limits-table be-table"><thead><tr><th>Your plan</th><th class="num" title="Nights of the void that have passed">Nights</th><th class="num" title="Booked nights the model expected with the plan">Expected with plan</th><th class="num" title="The same nights projected without the plan">Expected without</th><th class="num">Booked</th><th class="num">Income with plan</th><th class="num">Income without</th><th class="num">Actual income</th></tr></thead><tbody>${pr.plans.map((g) => `<tr><td>${escapeHtml(`${roomLabel(g.plan.roomKey)} ${short(g.plan.from)}–${short(dateStrAdd(g.plan.to, -1))}: ${[g.plan.discountPct > 0 ? `${g.plan.discountPct}% off` : '', g.plan.minNights != null ? `${g.plan.minNights}-night min` : ''].filter(Boolean).join(', ')}`)}</td><td class="num">${g.n}</td><td class="num">${g.withN.toFixed(1)}</td><td class="num">${g.noKnown ? g.noN.toFixed(1) : '–'}</td><td class="num">${g.actN}</td><td class="num">${money(g.withInc)}</td><td class="num">${g.noKnown ? money(g.noInc) : '–'}</td><td class="num">${money(g.actInc)}${g.unknown ? ` <span class="settings-note" style="margin:0;">+${g.unknown} unpriced</span>` : ''}</td></tr>`).join('')}</tbody></table></div>`);
lines.push(`<div class="settings-note" style="margin:4px 0 0;">Each plan is scored on its own and left out of the other tables here and the demand suggestion. "Without" is the model's estimate of the same nights with no plan: what would really have happened without it can't be seen, so judge the plan by whether booked nights and income came in nearer the with-plan or the without-plan figure.</div>`);
}
lines.push(bucketTable('By how far ahead it was forecast', pr.byLead));
lines.push(bucketTable('By length of the gap', pr.byLen));
lines.push(bucketTable('By night of the week', pr.byDay));
lines.push(`<details class="settings-subgroup"><summary>Chance forecast against how often it happened</summary><div style="overflow-x:auto;"><table class="limits-table be-table"><thead><tr><th>Forecast chance</th><th class="num">Nights</th><th class="num">Average forecast</th><th class="num">Actually booked</th></tr></thead><tbody>${pr.calibration.map((b) => `<tr><td>${escapeHtml(b.label)}</td><td class="num">${b.n}</td><td class="num">${b.n ? pctTxt(b.predicted) : '–'}</td><td class="num ${b.n >= MIN_NIGHTS_FOR_BUCKET ? '' : 'be-zero'}">${b.n ? pctTxt(b.actual) : '–'}</td></tr>`).join('')}</tbody></table></div><div class="settings-note" style="margin:4px 0 0;">A well calibrated model books about as often as it says: nights forecast at 20% should be booked about one time in five.</div></details>`);
}
// Proposals.
const props = pr.proposals;
lines.push(`<div style="margin:10px 0 4px;"><b style="font-size:12px;">What it suggests</b></div>`);
props.forEach((p) => {
if (p.kind === 'note') lines.push(`<div class="settings-note" style="margin:2px 0;">${escapeHtml(p.text)}</div>`);
else lines.push(`<div class="sync-row" style="align-items:center;margin:2px 0;"><span style="font-size:12px;">${escapeHtml(p.text)}</span><button class="sync-btn sm inline" type="button" data-mr-apply="${p.value}" data-mr-n="${p.n}">Apply ×${p.value.toFixed(2)}</button></div>`);
});
if (cal.demand !== 1 || cal.history.length) {
lines.push(`<div class="sync-row" style="align-items:center;margin:2px 0;"><span class="settings-note" style="margin:0;">Applied so far: ${cal.history.length ? cal.history.map((h) => `${escapeHtml(h.on)} ×${Number(h.demand).toFixed(2)} (${h.note ? escapeHtml(h.note) : `from ${h.n} nights`})`).join('; ') : 'none'}.</span><button class="sync-btn sm inline" type="button" data-mr-reset>Back to ×1.00</button></div>`);
}
lines.push(recentHtml());
lines.push(earlyBlockHtml());
// Requests.
lines.push(`<div style="margin:12px 0 4px;"><b style="font-size:12px;">Verdicts on requests you evaluated</b></div>`);
if (!reqs.length) {
const waiting = (data.bookingRequests || []).filter((q) => q.evaluation && q.evaluation.block && q.evaluation.block.to > todayStr()).length;
lines.push(`<div class="settings-note" style="margin:2px 0;">None to check yet${waiting ? `: ${waiting} saved verdict${waiting === 1 ? '' : 's'} still have nights to come` : ': save a verdict from the workbench ("Save to the request log", or "I accepted it" / "I declined it"), and it is checked once its dates have passed'}.</div>`);
} else {
lines.push(`<div style="overflow-x:auto;"><table class="limits-table be-table"><thead><tr><th>Request</th><th>You</th><th class="num">Said</th><th class="num">New bookings expected</th><th class="num">New bookings actual</th><th>The request itself</th></tr></thead><tbody>${reqs.map((r) => {
const q = r.q;
const said = r.accepted ? `${r.e.recommendation} (accept ${money(r.e.accept)} vs reject ${money(r.e.reject)})` : `${r.e.recommendation} (reject ${money(r.e.reject)} vs accept ${money(r.e.accept)})`;
const own = r.accepted && r.record ? stayChipHtml(r.record) : '';
const itself = r.accepted ? `${r.outcome}${r.actualRequest != null ? `: ${money(r.actualRequest)} against ${money(r.expectedRequest)} expected` : ''}` : '';
return `<tr><td><span class="inline-goto-link" data-mr-open-request="${escapeHtml(q.id)}" title="Open this request">${escapeHtml(`${q.guestName || 'Guest'} · ${short(q.checkin)} – ${short(q.checkout)}`)}</span></td><td>${r.accepted ? 'accepted it' : 'did not take it'}</td><td class="num">${escapeHtml(said)}</td><td class="num">${money(r.expectedNew)}</td><td class="num">${money(r.actualNew)}${r.unknown ? ` <span class="settings-note" style="margin:0;">+${r.unknown} unpriced nights</span>` : ''}</td><td>${own ? `${own} ` : ''}${escapeHtml(itself)}</td></tr>`;
}).join('')}</tbody></table></div>`);
}
return lines.join('');
}

let bound = false;
function renderModelReview() {
const el = document.getElementById('model-review-body');
if (!el) return;
el.innerHTML = reviewHtml();
bindStayChips();
}

function initModelReview() {
const anchor = document.getElementById('booking-evaluator');
if (!anchor || document.getElementById('model-review')) return;
anchor.insertAdjacentHTML('afterend', `<details class="settings-subgroup" id="model-review" style="margin-top:14px;"><summary style="font-size:13px;font-weight:600;">Model review: projections and verdicts against what happened</summary><div id="model-review-body"></div></details>`);
const root = document.getElementById('model-review');
root.addEventListener('toggle', () => {
if (!root.open) return;
renderModelReview();
// Opening it counts as having looked at last month's review (the nudge in the first days of a month).
const prev = dateStrAdd(`${todayStr().slice(0, 7)}-01`, -1).slice(0, 7);
if (data.prefs.modelReviewSeen !== prev) { data.prefs.modelReviewSeen = prev; queueSave(); }
});
if (bound) return;
bound = true;
root.addEventListener('click', async (e) => {
const apply = e.target.closest('[data-mr-apply]');
if (apply) {
const value = Number(apply.dataset.mrApply);
const be = data.prefs.bookingEvaluator || (data.prefs.bookingEvaluator = {});
const cal = calibrationNow();
be.calibration = { demand: value, lead: cal.lead, cancel: cal.cancel, appliedOn: todayStr(), note: '', history: [...cal.history, { on: todayStr(), demand: value, from: cal.demand, n: Number(apply.dataset.mrN) || 0 }] };
queueSave();
renderModelReview();
return;
}
if (e.target.closest('[data-mr-early]')) { runEarly(); return; }
if (e.target.closest('[data-mr-recent-apply]')) { applyRecent(root); return; }
if (e.target.closest('[data-mr-recent]')) { runRecent(); return; }
if (e.target.closest('[data-mr-reset]')) {
const be = data.prefs.bookingEvaluator || (data.prefs.bookingEvaluator = {});
const cal = calibrationNow();
be.calibration = { demand: 1, lead: 1, cancel: 1, appliedOn: todayStr(), note: 'reset', history: [...cal.history, { on: todayStr(), demand: 1, from: cal.demand, n: 0 }] };
queueSave();
renderModelReview();
return;
}
const open = e.target.closest('[data-mr-open-request]');
if (open) {
const { switchTab } = await import('../tabs.js');
switchTab('overview');
const det = document.getElementById('booking-requests'); if (det) det.open = true;
requestAnimationFrame(() => scrollAndFlash(`[data-bkreq="${CSS.escape(open.dataset.mrOpenRequest)}"]`));
}
});
}

export { initModelReview, renderModelReview, projectionReview, requestReview, forecastNights, actualNights, calibrationNow };
