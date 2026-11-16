// Per-night price breakdown (Finances -> "Price breakdown by night", #price-breakdown-panel).
//
// For one of the evaluator's rooms and the next 30/60/90 nights, each free night is drawn as the steps the booking
// model takes from the room's base rate to what a booking made today would pay: season, weekday, rating stage, any
// actioned event uplift (a rate-review proposal whose subtask is ticked off), the booking discounts, and for an empty
// gap the cut the model would make to fill it (optimiseVoid), with its expected gain. Each night shows the CURRENT figure
// (only what is applied), the PROPOSED one (with every event proposal and gap cut not yet applied) and each change's
// status: an event from its rate-review subtask, a gap cut from its dead-void task or a recorded void plan. A diverging step chart: steps
// that raise the price stack above the base line, steps that lower it below, a dot marks the net. Booked nights are
// muted with the stay as a chip; a table view carries every figure.
//
// Nothing here re-derives the model's maths: every step comes from bookingmodel.js nightBreakdown (which takes
// basePrice and playArrivals' discounts apart), the expected £ per night from makeProjection's voids, and the gap
// advice from optimiseVoid. It is what the model expects from your own history plus named events and gap filling,
// not a market price (real Airbnb calendar prices are phase 2/7 of PRICING-PLAN.md).
//
// Heavy: computed only when the panel is opened, in slices with a busy line, and cached per room/range/day.
import { data } from '../state.js';
import { escapeHtml, todayStr, dateStrAdd, scrollAndFlash } from '../utils.js';

const RANGES = [30, 60, 90];
const GAP_MAX_NIGHTS = 14; // longer empty stretches aren't gaps to fill with a cut; they're shown without advice
const GAP_MAX_COUNT = 6; // optimiseVoid runs ~9 simulations per gap: cap the work per room
const UP_KEYS = ['season', 'weekday', 'stage', 'event'];
const STEP_COLUMNS = [
['base', 'Base'], ['season', 'Season'], ['weekday', 'Weekday'], ['stage', 'Rating stage'], ['event', 'Event'],
['discounts', 'Booking discounts'], ['void', 'Gap / void cut'],
];
const DISCOUNT_KEYS = ['shortNotice', 'length', 'topRated', 'newListing'];

const state = { room: '', range: 60, view: 'chart', busy: false, cache: new Map(), result: null, opened: false, runId: 0 };

const money0 = (n) => `£${Math.round(n).toLocaleString('en-GB')}`;
const signed = (n) => { const r = Math.round(n); return r === 0 ? '£0' : `${r > 0 ? '+' : '−'}£${Math.abs(r).toLocaleString('en-GB')}`; };
const shortDay = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const dayOnly = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric' });
const weekday = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short' });
// "2-night gap 4–6 Dec": the first night to the morning after the last, as the rest of the app names a void.
function gapName(v) {
const a = new Date(`${v.from}T00:00:00`); const b = new Date(`${v.to}T00:00:00`);
const span = a.getMonth() === b.getMonth() ? `${a.getDate()}–${shortDay(v.to)}` : `${shortDay(v.from)}–${shortDay(v.to)}`;
return `${v.nights}-night gap ${span}`;
}
// A MessageChannel hop, not setTimeout: Chrome throttles setTimeout chains in a hidden tab to about one a second or
// slower (seen live: a 1.4 s projection took minutes in a background tab), but not message events.
const yieldToPage = () => new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });

// ---- Record references (CLAUDE.md: every record shown here links back) ----------------------------
let chips = null; // { stayChipHtml, taskChipHtml } once loaded
async function loadChips() {
if (chips) return chips;
const [{ stayChipHtml, bindStayChips }, { taskChipHtml, bindTaskChips }] = await Promise.all([import('./airbnb.js'), import('./tasks.js')]);
bindStayChips(); bindTaskChips();
chips = { stayChipHtml, taskChipHtml };
return chips;
}
// A stay from the model's context: a reservation opens through the standard stay chip; a ledger-only stay (id "led:…")
// opens its Letting income entry, as openStay does for a long let.
function stayRefHtml(x) {
const r = (data.airbnbReservations || []).find((y) => y.id === x.id);
if (r) return chips.stayChipHtml(r);
if (String(x.id).startsWith('led:')) {
const label = `${x.guest || 'Guest'} · ${shortDay(x.checkin)} → ${shortDay(x.checkout)}`;
return `<span class="stay-chip" data-pb-open-ledger="${escapeHtml(x.id.slice(4))}" title="Open this Letting income entry">${escapeHtml(label)}</span>`;
}
return `<span class="settings-note" style="margin:0;">${escapeHtml(x.guest || 'Booked')}</span>`;
}
const taskById = (id) => (id ? (data.tasks || []).find((t) => t.id === id) : null);
// The stored proposal behind one of the model's (it keeps only the fields it prices with).
function proposalRecordOf(pr) {
return (data.airbnbRateProposals || []).find((p) => p.listingId === pr.listingId && p.startDate === pr.startDate && p.endDate === pr.endDate && p.reason === pr.reason) || null;
}
function proposalRefHtml(rec, fallbackText) {
const t = rec && (taskById(rec.subtaskId) || taskById(rec.taskId));
return t ? chips.taskChipHtml(t) : `<span class="settings-note" style="margin:0;">${escapeHtml(fallbackText)}</span>`;
}

// ---- Status of a suggested change -----------------------------------------------------------------
// An event proposal: from its subtask (ticked off = actioned on Airbnb, which is also when the model starts pricing it;
// a deleted subtask leaves it proposed). A gap cut: a void plan you recorded for the nights, else the dead-void task
// for the gap (bookingprojection.js assessDeadVoids), else only the model's suggestion.
const STATUS_TEXT = { applied: 'Applied', proposed: 'Proposed', deleted: 'Proposed (task deleted)', suggested: 'Suggested (no task yet)', setting: 'Your setting' };
function proposalStatus(rec) {
const sub = taskById(rec.subtaskId);
if (!sub) return 'deleted';
return sub.bucket === 'done' ? 'applied' : 'proposed';
}
const isApplied = (st) => !st || st === 'applied' || st === 'setting';
const deadKey = (v) => `${v.roomKey}|${v.from}|${v.to}`;

// ---- Compute -----------------------------------------------------------------------------------------
// Two versions of every free night, from the same calibration and the same random draws (the model's seeds leave the
// proposals and void plans out, so the difference is the change, not reshuffled randomness): CURRENT = what is applied
// (ticked-off event proposals, recorded void plans, gap cuts whose task is ticked off); PROPOSED = that plus every
// change still only proposed or suggested.
async function projectSliced(model, c, opts, onBusy, label) {
const proj = model.makeProjection(c, opts);
if (proj.error) return proj;
for (let done = false; !done;) { const t = performance.now(); while (!(done = proj.step(50)) && performance.now() - t < 40); onBusy(`${label} ${Math.round(proj.progress * 100)}%`); await yieldToPage(); }
return proj.finish();
}
async function compute(roomKey, range, onBusy) {
const model = await import('./bookingmodel.js');
await loadChips();
const today = todayStr();
const to = dateStrAdd(today, range);
onBusy('Calibrating the model on your history…');
await yieldToPage();
const ctx = model.buildContext({ today });
const room = ctx.rooms.find((r) => r.key === roomKey) || ctx.rooms[0];
if (!room) return { error: 'No rooms are set up for the evaluator.', settingsLink: true };
const ri = ctx.rooms.indexOf(room);
const params = model.calibrate(ctx);
await yieldToPage();
const popts = { from: today, to, params, roomKeys: [room.key] };
const first = await projectSliced(model, ctx, popts, onBusy, 'Projecting the free nights…');
if (first.error) return { error: first.error };
const voids = first.voids.filter((v) => v.roomKey === room.key);
// The model's own gap advice, for each empty gap with a booking (or block) either side.
const gaps = voids.filter((v) => !v.open && v.nights <= GAP_MAX_NIGHTS).slice(0, GAP_MAX_COUNT);
const advice = new Map();
for (let i = 0; i < gaps.length; i++) {
onBusy(`Working out what fills ${gapName(gaps[i])} (${i + 1} of ${gaps.length})…`);
await yieldToPage();
try { const a = model.optimiseVoid(ctx, gaps[i], { params }); if (!a.error) advice.set(gaps[i].id, a); } catch (err) { console.error('Price breakdown: gap advice failed:', err); }
}
// Gap cuts as void plans (the shape Settings stores, which makeProjection already plays), split by status.
const storedPlans = Array.isArray(ctx.s.voidPlans) ? ctx.s.voidPlans : [];
const deadTasks = new Map((data.tasks || []).filter((t) => t.source && t.source.kind === 'dead void').map((t) => [t.source.key, t]));
const gapInfo = new Map(); // void id -> {status, task, plan}
const curExtra = []; const propExtra = [];
voids.forEach((v) => {
const plan = storedPlans.find((p) => p.roomKey === room.key && p.from < v.to && p.to > v.from && (p.minNights != null || Number(p.discountPct) > 0));
const a = advice.get(v.id);
const task = deadTasks.get(deadKey(v)) || null;
if (plan) { gapInfo.set(v.id, { status: 'applied', task, plan }); return; }
if (!a || !a.best) { gapInfo.set(v.id, { status: null, task, plan: null }); return; }
const cut = { id: `pb-${v.id}`, pbCut: true, roomKey: room.key, from: v.from, to: v.to, minNights: a.best.minNights < a.curMin ? a.best.minNights : null, discountPct: a.best.pct };
const status = task ? (task.bucket === 'done' ? 'applied' : 'proposed') : 'suggested';
gapInfo.set(v.id, { status, task, plan: null });
(status === 'applied' ? curExtra : propExtra).push(cut);
});
// Event proposals on this room's listings in the window (endDate inclusive, as basePrice and the subtask title read it).
const recs = (data.airbnbRateProposals || []).filter((p) => room.listingIds.includes(p.listingId) && p.startDate && (p.endDate || p.startDate) >= today && p.startDate < to);
const pending = recs.filter((p) => proposalStatus(p) !== 'applied').map((p) => ({ listingId: p.listingId, startDate: p.startDate, endDate: p.endDate, upliftPct: p.upliftPct, upliftAmount: p.upliftAmount, reason: p.reason }));
const ctxCur = curExtra.length ? { ...ctx, s: { ...ctx.s, voidPlans: [...storedPlans, ...curExtra] } } : ctx;
const ctxProp = pending.length || propExtra.length ? { ...ctxCur, proposals: [...ctx.proposals, ...pending], s: { ...ctxCur.s, voidPlans: [...(ctxCur.s.voidPlans || []), ...propExtra] } } : ctxCur;
const cur = ctxCur === ctx ? first : await projectSliced(model, ctxCur, popts, onBusy, 'Projecting with the applied changes…');
const prop = ctxProp === ctxCur ? cur : await projectSliced(model, ctxProp, popts, onBusy, 'Projecting with the proposed changes…');
if (cur.error || prop.error) return { error: cur.error || prop.error };
const voidOf = (res, v) => res.voids.find((x) => x.id === v.id) || v;
const gapPct = Number(ctx.s.gapDiscountPct) || 0;
const gapMax = Number(ctx.s.gapMaxNights) || 0;
// The extra cut on a night, as playArrivals applies it: a plan's cut, else the standing gap discount on a short gap.
const extraFor = (c, v, date) => {
const p = (c.s.voidPlans || []).find((x) => x.roomKey === room.key && x.from <= date && x.to > date && Number(x.discountPct) > 0);
if (p) return { extraPct: Number(p.discountPct), extraLabel: p.pbCut ? 'Gap cut (model’s pick)' : 'Void plan you set' };
if (!v.open && v.nights <= gapMax && gapPct > 0) return { extraPct: gapPct, extraLabel: 'Gap discount (your setting)' };
return { extraPct: 0, extraLabel: '' };
};
const T = ctx.today;
const stays = ctx.stays.filter((x) => x.status === 'stay' && !x.unconfirmed && room.listingIds.includes(x.listingId) && x.checkout > T && x.checkin < to);
const dayN = (d) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86400000);
const nights = [];
for (let k = 0; k < range; k++) {
const date = dateStrAdd(today, k);
const n = dayN(date);
const stay = stays.find((x) => x.checkin <= date && x.checkout > date);
const v = voids.find((x) => x.from <= date && x.to > date);
if (!v) {
const per = stay && Number(stay.income) > 0 ? Number(stay.income) / Math.max(1, dayN(stay.checkout) - dayN(stay.checkin)) : null;
nights.push({ date, status: stay ? 'booked' : 'blocked', stay, perNight: per });
continue;
}
const idx = n - dayN(v.from);
const gi = gapInfo.get(v.id) || {};
const bCur = model.nightBreakdown(ctxCur, params, ri, n, extraFor(ctxCur, v, date));
const bProp = model.nightBreakdown(ctxProp, params, ri, n, extraFor(ctxProp, v, date));
// Each step carries its status, so a proposed one is drawn and listed as proposed.
bProp.steps.forEach((s) => {
if (s.key === 'event') { const rec = proposalRecordOf(s.proposal); s.status = rec ? proposalStatus(rec) : 'applied'; s.rec = rec; }
else if (s.key === 'void') s.status = /setting/.test(s.label) ? 'setting' : gi.plan ? 'applied' : gi.status || 'suggested';
});
const vc = voidOf(cur, v); const vp = voidOf(prop, v);
nights.push({ date, status: 'free', breakdown: bProp, current: bCur, void: v, gap: gi, advice: advice.get(v.id) || null,
expected: vc.nightIncome[idx], prob: vc.nightProb[idx], expectedProp: vp.nightIncome[idx], probProp: vp.nightProb[idx] });
}
// Every event proposal touching the window, with its status (one on booked nights still shows its band).
const events = recs.map((p) => ({ key: p.id, rec: p, reason: p.reason || 'Event', from: p.startDate < today ? today : p.startDate, to: (p.endDate || p.startDate) >= to ? dateStrAdd(to, -1) : (p.endDate || p.startDate), status: proposalStatus(p) }));
// An applied proposal the model priced whose stored record can't be matched still gets a band, named from the step.
nights.forEach((nt) => (nt.breakdown ? nt.breakdown.steps : []).forEach((s) => {
if (s.key !== 'event' || s.rec) return;
const key = `${s.proposal.startDate}|${s.proposal.reason}`;
const e = events.find((x) => x.key === key);
if (e) e.to = nt.date; else events.push({ key, rec: null, reason: s.proposal.reason || 'Event', from: nt.date, to: nt.date, status: 'applied' });
}));
const price = params.prices[ri];
return { room, today, to, range, nights, voids, advice, gapInfo, events, base: nights.find((x) => x.breakdown)?.breakdown.steps[0].amount ?? price.base, priceSource: price.source, samples: price.n, stage: (params.roomStage || [])[ri] || 'rated', runs: cur.runs, hasProposals: pending.length + propExtra.length > 0 };
}

// ---- Render --------------------------------------------------------------------------------------------
const STATUS_CLASS = (st) => (isApplied(st) ? '' : ' pb-prop');
function stepGroups(b) {
// Columns for the table: discounts summed into one (each stays named in the tooltip and notes), the rest one per step.
const g = Object.fromEntries(STEP_COLUMNS.map(([k]) => [k, 0]));
b.steps.forEach((s) => { const k = DISCOUNT_KEYS.includes(s.key) ? 'discounts' : s.key; g[k] += s.amount; });
return g;
}
// The drawn segments, in a fixed order: applied steps first, then the proposed part of the event and of the gap cut
// (outlined), so a proposed change always sits at the outer end of its stack.
function segmentsOf(b) {
const segs = [];
const push = (key, amount, proposed) => { if (Math.abs(amount) >= 0.005) segs.push({ key, amount, proposed }); };
const sum = (xs) => xs.reduce((a, s) => a + s.amount, 0);
UP_KEYS.filter((k) => k !== 'event').forEach((k) => push(k, sum(b.steps.filter((s) => s.key === k)), false));
const ev = b.steps.filter((s) => s.key === 'event');
push('event', sum(ev.filter((s) => isApplied(s.status))), false);
push('event', sum(ev.filter((s) => !isApplied(s.status))), true);
push('discounts', sum(b.steps.filter((s) => DISCOUNT_KEYS.includes(s.key))), false);
const vd = b.steps.filter((s) => s.key === 'void');
push('void', sum(vd.filter((s) => isApplied(s.status))), false);
push('void', sum(vd.filter((s) => !isApplied(s.status))), true);
return segs;
}

function niceStep(span) {
const raw = span / 4;
const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) || p * 10;
}

// Bands that would overlap (a label is often wider than the nights it spans) go on separate lanes.
const LANE_H = 28;
function lanes(items) {
const ends = [];
items.sort((a, b) => a.left - b.left).forEach((it) => {
const w = Math.max(it.width, it.est * 6.2 + 34);
let k = ends.findIndex((e) => e <= it.left);
if (k < 0) { k = ends.length; ends.push(0); }
ends[k] = it.left + w + 4;
it.lane = k;
});
const html = items.map((it) => it.html.replace('data-pb-band', `style="left:${it.left}px;min-width:${it.width}px;top:${it.lane * LANE_H}px;"`)).join('');
return { html, height: ends.length * LANE_H };
}
function chartHtml(r) {
const free = r.nights.filter((x) => x.breakdown);
let hi = 0; let lo = 0;
free.forEach((nt) => {
const seg = segmentsOf(nt.breakdown);
hi = Math.max(hi, seg.filter((s) => s.amount > 0).reduce((a, s) => a + s.amount, 0));
lo = Math.min(lo, seg.filter((s) => s.amount < 0).reduce((a, s) => a + s.amount, 0));
});
const step = niceStep(Math.max(10, hi - lo));
hi = Math.ceil((hi + 0.001) / step) * step; lo = Math.floor((lo - 0.001) / step) * step;
const H = 180;
const y = (v) => ((hi - v) / (hi - lo)) * H; // offset from the base line -> px from the top
const ticks = [];
for (let v = lo; v <= hi + 1e-9; v += step) ticks.push(v);
const colW = 18;
const W = r.nights.length * colW;
const bar = 12;
const nets = free.map((nt) => nt.current.price);
const maxNet = Math.max(...nets); const minNet = Math.min(...nets);
let labelledHi = false; let labelledLo = false;
const cols = r.nights.map((nt, i) => {
const left = i * colW;
const weekend = new Date(`${nt.date}T00:00:00`).getDay();
const we = weekend === 5 || weekend === 6;
if (!nt.breakdown) {
return `<button type="button" class="pb-col pb-${nt.status}" style="left:${left}px;width:${colW}px;" data-pb-i="${i}" aria-label="${escapeHtml(`${weekday(nt.date)} ${shortDay(nt.date)}: ${nt.status === 'booked' ? 'booked' : 'not available'}`)}"><span class="pb-muted-bar" style="left:${(colW - bar) / 2}px;width:${bar}px;top:0;height:${H}px;"></span></button>`;
}
const seg = segmentsOf(nt.breakdown);
let up = 0; let down = 0;
const ups = seg.filter((s) => s.amount > 0); const downs = seg.filter((s) => s.amount < 0);
const parts = [];
ups.forEach((s, k) => {
const top = y(up + s.amount); const h = y(up) - top; up += s.amount;
const end = k === ups.length - 1 ? ' pb-end-up' : '';
parts.push(`<span class="pb-seg pb-up${end}${s.proposed ? ' pb-prop' : ''}" style="left:${(colW - bar) / 2}px;width:${bar}px;top:${top + 1}px;height:${Math.max(1, h - 2)}px;"></span>`);
});
downs.forEach((s, k) => {
const top = y(down); const h = y(down + s.amount) - top; down += s.amount;
const end = k === downs.length - 1 ? ' pb-end-down' : '';
parts.push(`<span class="pb-seg pb-down${end}${s.proposed ? ' pb-prop' : ''}" style="left:${(colW - bar) / 2}px;width:${bar}px;top:${top + 1}px;height:${Math.max(1, h - 2)}px;"></span>`);
});
const net = nt.current.price - r.base;
parts.push(`<span class="pb-net" style="left:${colW / 2 - 5}px;top:${y(net) - 5}px;"></span>`);
if (Math.abs(nt.breakdown.price - nt.current.price) >= 0.5) parts.push(`<span class="pb-net pb-net-prop" style="left:${colW / 2 - 5}px;top:${y(nt.breakdown.price - r.base) - 5}px;"></span>`);
let label = '';
if (!labelledHi && nt.current.price === maxNet) { labelledHi = true; label = `<span class="pb-direct" style="top:${Math.max(0, y(up)) - 16}px;">${money0(maxNet)}</span>`; }
else if (!labelledLo && nt.current.price === minNet && minNet !== maxNet) { labelledLo = true; label = `<span class="pb-direct" style="top:${Math.min(H - 14, y(down)) + 2}px;">${money0(minNet)}</span>`; }
return `<button type="button" class="pb-col pb-free${we ? ' pb-we' : ''}" style="left:${left}px;width:${colW}px;" data-pb-i="${i}" aria-label="${escapeHtml(`${weekday(nt.date)} ${shortDay(nt.date)}: current ${money0(nt.current.price)}, proposed ${money0(nt.breakdown.price)} if booked now`)}">${parts.join('')}${label}</button>`;
}).join('');
const grid = ticks.map((v) => `<div class="pb-grid${Math.abs(v) < 1e-9 ? ' pb-zero' : ''}" style="top:${y(v)}px;"></div>`).join('');
const axis = ticks.map((v) => `<div class="pb-tick" style="top:${y(v) - 7}px;">${Math.abs(v) < 1e-9 ? `Base ${money0(r.base)}` : money0(r.base + v)}</div>`).join('');
// x axis: the day of the month, with the month named on the 1st and the first night.
const xlab = r.nights.map((nt, i) => {
const d = new Date(`${nt.date}T00:00:00`);
const first = i === 0 || d.getDate() === 1;
const show = first || d.getDay() === 1;
return show ? `<span class="pb-xl${first ? ' pb-xm' : ''}" style="left:${i * colW}px;">${escapeHtml(first ? shortDay(nt.date) : dayOnly(nt.date))}</span>` : '';
}).join('');
// Bands: events above the plot; stays and gaps below. Each spans its nights and names (and links to) its record.
const idxOf = (d) => r.nights.findIndex((x) => x.date === d);
const span = (from, toIncl) => { let a = idxOf(from); let b = idxOf(toIncl); if (a < 0) a = 0; if (b < 0) b = r.nights.length - 1; return { left: a * colW, width: (b - a + 1) * colW }; };
const evBands = lanes(r.events.map((e) => {
const { left, width } = span(e.from, e.to);
const rec = e.rec;
const uplift = rec ? (rec.upliftPct != null ? `+${rec.upliftPct}%` : rec.upliftAmount != null ? `+£${rec.upliftAmount}` : '') : '';
const minStay = rec && rec.minStayNights != null ? `min ${rec.minStayNights} night${Number(rec.minStayNights) === 1 ? '' : 's'}` : '';
const text = [e.reason, uplift, minStay].filter(Boolean).join(' · ');
const t = rec && taskById(rec.subtaskId);
const ref = t ? chips.taskChipHtml(t) : `<span>${escapeHtml(text)}</span>`;
const est = STATUS_TEXT[e.status].length + 3 + (t ? t.title.length + 3 : text.length) + (minStay && t ? minStay.length + 3 : 0);
return { left, width, est, html: `<div class="pb-band pb-band-event${STATUS_CLASS(e.status)}" data-pb-band title="${escapeHtml(`${STATUS_TEXT[e.status]}: ${text}`)}"><span class="pb-status pb-st-${e.status}">${STATUS_TEXT[e.status]}</span>${ref}${minStay && t ? `<span class="pb-band-note">${escapeHtml(minStay)}</span>` : ''}</div>` };
}));
const stayBands = [];
const seen = new Set();
r.nights.forEach((nt) => {
if (nt.status !== 'booked' || seen.has(nt.stay.id)) return;
seen.add(nt.stay.id);
const last = dateStrAdd(nt.stay.checkout, -1);
const { left, width } = span(nt.date, last > r.nights[r.nights.length - 1].date ? r.nights[r.nights.length - 1].date : last);
stayBands.push({ left, width, est: `${nt.stay.guest || 'Guest'} · ${shortDay(nt.stay.checkin)} → ${shortDay(nt.stay.checkout)}`.length + 2, html: `<div class="pb-band pb-band-stay" data-pb-band>${stayRefHtml(nt.stay)}</div>` });
});
const gapBands = lanes(r.voids.filter((v) => !v.open).map((v) => {
const { left, width } = span(v.from, dateStrAdd(v.to, -1));
const a = r.advice.get(v.id);
const gi = r.gapInfo.get(v.id) || {};
const task = gi.task;
let what;
if (gi.plan) what = `void plan recorded: ${[gi.plan.minNights != null ? `min ${gi.plan.minNights} night${Number(gi.plan.minNights) === 1 ? '' : 's'}` : '', Number(gi.plan.discountPct) > 0 ? `${gi.plan.discountPct}% off` : ''].filter(Boolean).join(', ')}`;
else if (!a) what = v.nights > GAP_MAX_NIGHTS ? 'too long to treat as a gap' : 'not assessed';
else if (a.best) what = `${[a.best.minNights < a.curMin ? `allow ${a.best.minNights}-night stays` : '', a.best.pct > 0 ? `cut ${a.best.pct}%` : ''].filter(Boolean).join(' + ')}: ${signed(a.gain)} expected`;
else what = 'no cut beats leaving it';
const st = gi.status;
const stHtml = st ? `<span class="pb-status pb-st-${st}">${STATUS_TEXT[st]}</span>` : '';
const planLink = gi.plan ? ' <span class="inline-goto-link" data-goto-tab="finances" data-goto-target="#letting-forecast-panel">void plans</span>' : '';
const est = gapName(v).length + what.length + 2 + (st ? STATUS_TEXT[st].length + 3 : 0) + (task ? task.title.length + 4 : 0) + (gi.plan ? 12 : 0);
return { left, width, est, html: `<div class="pb-band pb-band-gap${STATUS_CLASS(st)}" data-pb-band>${stHtml}<strong>${escapeHtml(gapName(v))}</strong> <span>${escapeHtml(what)}</span>${task ? ` ${chips.taskChipHtml(task)}` : ''}${planLink}</div>` };
}));
const stayLanes = lanes(stayBands);
return `<div class="pb-chart">
<div class="pb-yaxis" style="height:${H}px;margin-top:${r.events.length ? evBands.height + 4 : 6}px;">${axis}</div>
<div class="pb-scroll" tabindex="0" aria-label="Per-night price steps; scroll sideways for later nights">
<div class="pb-inner" style="width:${W}px;">
${r.events.length ? `<div class="pb-bands pb-bands-top" style="height:${evBands.height}px;">${evBands.html}</div>` : '<div style="height:6px;"></div>'}
<div class="pb-plot" style="height:${H}px;">${grid}${cols}</div>
<div class="pb-xaxis">${xlab}</div>
${stayBands.length ? `<div class="pb-bands" style="height:${stayLanes.height}px;">${stayLanes.html}</div>` : ''}
${gapBands.height ? `<div class="pb-bands" style="height:${gapBands.height}px;">${gapBands.html}</div>` : ''}
</div>
</div>
</div>`;
}

function tableHtml(r) {
const head = `<tr><th>Night</th>${STEP_COLUMNS.map(([, l]) => `<th class="num">${escapeHtml(l)}</th>`).join('')}<th class="num">Current</th><th class="num">Proposed</th><th>Status</th><th class="num">Expected now → proposed</th><th>Set in Airbnb</th><th>Notes</th></tr>`;
const rows = r.nights.map((nt) => {
const day = `${weekday(nt.date)} ${shortDay(nt.date)}`;
if (!nt.breakdown) {
const what = nt.status === 'booked' ? `Booked${nt.perNight ? `, ${money0(nt.perNight)}/night received` : ''}` : 'Not available (blocked)';
return `<tr class="pb-row-muted"><td>${escapeHtml(day)}</td><td colspan="${STEP_COLUMNS.length + 5}">${escapeHtml(what)}</td><td>${nt.status === 'booked' ? stayRefHtml(nt.stay) : ''}</td></tr>`;
}
const g = stepGroups(nt.breakdown);
const changes = nt.breakdown.steps.filter((s) => !isApplied(s.status));
const status = changes.length ? [...new Set(changes.map((s) => STATUS_TEXT[s.status]))].join(', ') : 'Nothing proposed';
const notes = nt.breakdown.steps.filter((s) => s.key !== 'base' && Math.abs(s.amount) >= 0.005).map((s) => `${s.label}${!isApplied(s.status) ? ` (${STATUS_TEXT[s.status].toLowerCase()})` : ''}: ${s.reason}`).join('; ');
return `<tr><td>${escapeHtml(day)}</td>${STEP_COLUMNS.map(([k]) => `<td class="num">${k === 'base' ? money0(g[k]) : signed(g[k])}</td>`).join('')}<td class="num"><strong>${money0(nt.current.price)}</strong></td><td class="num">${changes.length ? `<strong>${money0(nt.breakdown.price)}</strong>` : '–'}</td><td>${escapeHtml(status)}</td><td class="num">${money0(nt.expected)} → ${money0(nt.expectedProp)}</td><td class="pb-empty-slot">not known yet</td><td class="pb-notes">${escapeHtml(notes)}</td></tr>`;
}).join('');
return `<div class="pb-table-wrap"><table class="pb-table"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
}

function legendHtml() {
return `<div class="pb-legend" aria-hidden="true"><span><i class="pb-key pb-key-up"></i>Raises the price</span><span><i class="pb-key pb-key-down"></i>Lowers it</span><span><i class="pb-key pb-key-up pb-prop"></i>Proposed, not applied yet</span><span><i class="pb-key pb-key-net"></i>Current price if booked now</span><span><i class="pb-key pb-key-net pb-net-prop"></i>With the proposals</span><span><i class="pb-key pb-key-muted"></i>Booked or blocked</span></div>`;
}

function summaryHtml(r) {
const stage = { new: 'new listing', rated: 'rated', superhost: 'Superhost' }[r.stage] || r.stage;
return `<div class="settings-note" style="margin:0 0 6px;">${escapeHtml(r.room.label)}: base ${money0(r.base)} a night on a rated footing, from ${escapeHtml(r.priceSource)}. Today’s stage: ${escapeHtml(stage)}. Expected figures from ${r.runs.toLocaleString('en-GB')} simulated futures.</div>`;
}

function renderResult() {
const out = document.getElementById('pb-out');
if (!out) return;
const r = state.result;
if (!r) { out.innerHTML = ''; return; }
if (r.error) {
out.innerHTML = `<div class="settings-note">${escapeHtml(r.error)}${r.settingsLink ? ' Add one in <span class="inline-goto-link" data-goto-tab="settings" data-goto-target="#booking-evaluator-settings">Settings, Booking evaluator</span>.' : ''}</div>`;
return;
}
out.innerHTML = summaryHtml(r) + (state.view === 'chart' ? legendHtml() + chartHtml(r) : tableHtml(r)) + '<div class="pb-tip" id="pb-tip" role="tooltip" hidden></div>';
}

// The tooltip: every step of the night with its reason and £, then the price and the expected figure. Built with
// textContent (event names come from an AI web search).
function showTip(col) {
const tip = document.getElementById('pb-tip');
const r = state.result;
if (!tip || !r || !r.nights) return;
const nt = r.nights[Number(col.dataset.pbI)];
if (!nt) return;
tip.textContent = '';
const add = (cls, text, value) => {
const row = document.createElement('div'); row.className = `pb-tip-row ${cls}`;
if (value != null) { const v = document.createElement('strong'); v.textContent = value; row.appendChild(v); }
const t = document.createElement('span'); t.textContent = text; row.appendChild(t);
tip.appendChild(row);
return row;
};
add('pb-tip-head', `${weekday(nt.date)} ${shortDay(nt.date)}`);
if (!nt.breakdown) {
add('', nt.status === 'booked' ? `Booked: ${nt.stay.guest || 'guest'}${nt.perNight ? `, ${money0(nt.perNight)}/night received` : ''}` : 'Not available: blocked on the calendar or not offered');
} else {
nt.breakdown.steps.forEach((s) => {
if (s.key !== 'base' && Math.abs(s.amount) < 0.005) return;
const st = s.status && s.status !== 'setting' ? ` [${STATUS_TEXT[s.status]}]` : '';
const row = add(s.key === 'base' ? '' : s.amount > 0 ? 'pb-tip-up' : 'pb-tip-down', `${s.label}${st}: ${s.reason}`, s.key === 'base' ? money0(s.amount) : signed(s.amount));
if (s.key !== 'base') { const k = document.createElement('i'); k.className = `pb-tip-key ${s.amount > 0 ? 'pb-key-up' : 'pb-key-down'}${isApplied(s.status) ? '' : ' pb-prop'}`; row.prepend(k); }
});
const changes = nt.breakdown.steps.filter((s) => !isApplied(s.status));
add('pb-tip-total', `current, if booked now · expected ${money0(nt.expected)} (booked in ${Math.round(nt.prob * 100)}% of runs, with the cleaning income when a stay starts that night)`, money0(nt.current.price));
if (changes.length) add('', `proposed (${[...new Set(changes.map((s) => STATUS_TEXT[s.status]))].join(', ')}) · expected ${money0(nt.expectedProp)} (${Math.round(nt.probProp * 100)}%)`, money0(nt.breakdown.price));
else add('', 'proposed: nothing proposed for this night', '–');
add('pb-tip-empty', 'Set in Airbnb: not known yet', '—');
const v = nt.void; const a = nt.advice;
if (v && a) add('', `${gapName(v)}${nt.gap && nt.gap.plan ? ' (you recorded a void plan; the model’s own pick, without it)' : ''}: ${a.best ? `the model’s pick is worth ${signed(a.gain)} over leaving it (${money0(a.base.net)} → ${money0(a.best.net)} after cleaning)` : 'no cut the model tried beats leaving it'}`);
}
tip.hidden = false;
const host = tip.parentElement.getBoundingClientRect();
const c = col.getBoundingClientRect();
const w = Math.min(300, host.width - 8);
tip.style.width = `${w}px`;
let left = c.left - host.left + c.width / 2 - w / 2;
left = Math.max(4, Math.min(host.width - w - 4, left));
tip.style.left = `${left}px`;
tip.style.top = `${c.bottom - host.top + 4}px`;
}
function hideTip() { const tip = document.getElementById('pb-tip'); if (tip) tip.hidden = true; }

function controlsHtml(rooms) {
const opts = rooms.map((r) => `<option value="${escapeHtml(r.key)}"${r.key === state.room ? ' selected' : ''}>${escapeHtml(r.label)}</option>`).join('');
const ranges = RANGES.map((n) => `<button type="button" class="chart-mode-btn${n === state.range ? ' active' : ''}" data-pb-range="${n}">${n} nights</button>`).join('');
const views = [['chart', 'Chart'], ['table', 'Table']].map(([k, l]) => `<button type="button" class="chart-mode-btn${k === state.view ? ' active' : ''}" data-pb-view="${k}">${l}</button>`).join('');
return `<div class="sync-row pb-controls" style="align-items:center;flex-wrap:wrap;gap:8px;">
<select id="pb-room" class="mini" title="The booking evaluator's rooms">${opts}</select>
<div class="chart-mode-toggle" style="margin:0;">${ranges}</div>
<div class="chart-mode-toggle" style="margin:0;">${views}</div>
<button type="button" class="sync-btn sm inline" id="pb-refresh" title="Run the model again (after a booking, a price change or a ticked-off rate proposal)">Recalculate</button>
<span class="sync-status" id="pb-status"></span>
</div>`;
}

async function run({ force = false } = {}) {
const key = `${state.room}|${state.range}|${todayStr()}`;
const out = document.getElementById('pb-out');
const status = document.getElementById('pb-status');
if (!force && state.cache.has(key)) { state.result = state.cache.get(key); renderResult(); if (status) status.textContent = ''; return; }
const id = ++state.runId;
state.busy = true;
if (out) out.classList.add('pb-loading'); // hold the previous render, dimmed, while the model runs
const say = (t) => { const s = document.getElementById('pb-status'); if (s && id === state.runId) s.textContent = t; };
try {
const r = await compute(state.room, state.range, say);
if (id !== state.runId) return;
if (!r.error) state.cache.set(key, r);
state.result = r;
renderResult();
say('');
} catch (err) {
console.error('Price breakdown failed:', err);
if (id === state.runId) { state.result = { error: `The model could not run: ${err.message || err}` }; renderResult(); say(''); }
} finally {
if (id === state.runId) { state.busy = false; const o = document.getElementById('pb-out'); if (o) o.classList.remove('pb-loading'); }
}
}

async function open() {
const root = document.getElementById('pb-root');
if (!root) return;
const { evaluatorRooms, roomSettings } = await import('./bookingsettings.js');
const rooms = evaluatorRooms().filter((r) => roomSettings(r.key).include !== false);
if (!rooms.length) {
root.innerHTML = '<div class="settings-note">No rooms are set up for the evaluator. Add one in <span class="inline-goto-link" data-goto-tab="settings" data-goto-target="#booking-evaluator-settings">Settings, Booking evaluator</span>.</div>';
return;
}
if (!rooms.some((r) => r.key === state.room)) state.room = rooms[0].key;
root.innerHTML = `${controlsHtml(rooms)}<div class="pb-caption">What the model expects each night to earn from your own history, plus named events and gap filling: not a market price. <strong>Current</strong> counts only what’s applied (a ticked-off rate proposal or gap task, a recorded void plan); <strong>proposed</strong> adds every change still proposed or suggested, drawn outlined. The price actually set in Airbnb’s calendar isn’t stored yet (phase 2/7 of the pricing plan), so that slot is left empty. Short-notice and length discounts are shown as they would apply to a booking made today, the length one averaged over your stay-length mix.</div><div id="pb-out"></div>`;
run();
}

let bound = false;
function initPriceBreakdown() {
const details = document.getElementById('pb-details');
if (!details || bound) return;
bound = true;
details.addEventListener('toggle', () => { if (details.open && !state.opened) { state.opened = true; open(); } });
const root = document.getElementById('pb-root');
root.addEventListener('change', (e) => { if (e.target.id === 'pb-room') { state.room = e.target.value; run(); } });
root.addEventListener('click', (e) => {
const rg = e.target.closest('[data-pb-range]');
if (rg) { state.range = Number(rg.dataset.pbRange); root.querySelectorAll('[data-pb-range]').forEach((b) => b.classList.toggle('active', b === rg)); run(); return; }
const vw = e.target.closest('[data-pb-view]');
if (vw) { state.view = vw.dataset.pbView; root.querySelectorAll('[data-pb-view]').forEach((b) => b.classList.toggle('active', b === vw)); renderResult(); return; }
if (e.target.closest('#pb-refresh')) { run({ force: true }); return; }
const led = e.target.closest('[data-pb-open-ledger]');
if (led) {
const id = led.dataset.pbOpenLedger;
import('../tabs.js').then(({ switchTab }) => { switchTab('finances'); requestAnimationFrame(() => scrollAndFlash(`[data-letting-date="${CSS.escape(id)}"]`)); });
return;
}
const col = e.target.closest('.pb-col');
if (col) showTip(col);
});
root.addEventListener('pointerover', (e) => { const col = e.target.closest('.pb-col'); if (col) showTip(col); });
root.addEventListener('pointerleave', hideTip);
root.addEventListener('focusin', (e) => { const col = e.target.closest('.pb-col'); if (col) showTip(col); });
root.addEventListener('focusout', (e) => { if (e.target.closest('.pb-col')) hideTip(); });
root.addEventListener('scroll', hideTip, true);
}

export { initPriceBreakdown };
