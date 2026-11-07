// Saved projections of the voids (the free nights between now and the end of next month): run on
// request, kept in data.bookingProjections, drawn onto the Letting charts, and compared with what
// happened by the monthly model review (js/features/modelreview.js). The engine is
// js/features/bookingmodel.js (makeProjection).
import { data, queueSave, blankBookingProjection } from '../state.js';
import { todayStr, dateStrAdd } from '../utils.js';

const KEEP_DAYS = 400;
// A projection this many days old is called stale on the charts: the calendar has moved on.
const STALE_DAYS = 7;

const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);

function showProjection() { return data.prefs.showProjection !== false; }

// The newest saved projection whose window has not finished.
function latestProjection() {
const today = todayStr();
const list = (data.bookingProjections || []).filter((p) => p.to && p.to > today);
list.sort((a, b) => String(b.madeAt).localeCompare(String(a.madeAt)));
return list[0] || null;
}

// What the charts draw: the latest projection, if the pref is on and `ym` is a month it covers.
function projectionForMonth(ym) {
if (!showProjection()) return null;
const p = latestProjection();
return p && p.months && p.months[ym] ? p : null;
}

function ageDays(p) { return Math.max(0, daysBetween(String(p.madeAt).slice(0, 10) || p.today, todayStr())); }

function statusText(p = latestProjection()) {
if (!p) return 'No projection yet.';
const age = ageDays(p);
const when = age === 0 ? 'today' : `${age} day${age === 1 ? '' : 's'} ago`;
const short = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
return `Projected ${when}: ${short(p.today)} to ${short(dateStrAdd(p.to, -1))}, about £${Math.round(p.total.expected).toLocaleString('en-GB')} more from ${p.voids.length} void${p.voids.length === 1 ? '' : 's'}${age >= STALE_DAYS ? ' (out of date: run it again)' : ''}.`;
}

// Per room, the projected income and probability of being booked for each date: the voids' per-night
// arrays laid out by date. Map key `${roomKey}|${date}` -> {p, income}.
function projectedNights(p) {
const out = new Map();
(p.voids || []).forEach((v) => {
for (let i = 0; i < v.nights; i++) out.set(`${v.roomKey}|${dateStrAdd(v.from, i)}`, { p: v.nightProb[i] || 0, income: v.nightIncome[i] || 0, voidId: v.id });
});
return out;
}

// Expected projected nights and income by date (all rooms, or one room), for the pace charts.
function projectedByDate(p, roomKey = '') {
const out = new Map();
(p.voids || []).forEach((v) => {
if (roomKey && v.roomKey !== roomKey) return;
for (let i = 0; i < v.nights; i++) {
const d = dateStrAdd(v.from, i);
const cur = out.get(d) || { nights: 0, income: 0 };
cur.nights += v.nightProb[i] || 0; cur.income += v.nightIncome[i] || 0;
out.set(d, cur);
}
});
return out;
}

// Lets the page paint between slices. In a background tab there is nothing to paint and the browser clamps
// timers to a second or a minute (a half-minute run took many minutes), so there it just carries on.
function yieldToPage() {
if (typeof document !== 'undefined' && document.hidden) return Promise.resolve();
return new Promise((resolve) => setTimeout(resolve, 0));
}

// A void the projection expects to fill with less than one night, and less than half its nights: as
// it stands it will most likely stay empty. A void running past the projection window isn't judged
// (its far end isn't known).
const DEAD_VOID_NIGHTS = 1;
function isDeadVoid(v) {
return !!v && !v.open && v.nights >= 1 && v.expectedNights < DEAD_VOID_NIGHTS && v.expectedNights < v.nights * 0.5;
}
// The dead voids still ahead in a projection.
function deadVoidsOf(p = latestProjection()) {
const today = todayStr();
return p ? (p.voids || []).filter((v) => v.to > today && isDeadVoid(v)) : [];
}
const deadKey = (v) => `${v.roomKey}|${v.from}|${v.to}`;
const shortDay = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const money0 = (n) => `£${Math.round(n).toLocaleString('en-GB')}`;

// What to change on Airbnb for a dead void, in words, from the option the model found best.
function adviceText(v, a) {
if (!a || !a.best) return 'No change the model tried (1-night stays, a price cut) beats leaving it as it is.';
const { best, base } = a;
const parts = [];
if (best.minNights < a.curMin) parts.push(`allow ${best.minNights}-night stays`);
if (best.pct > 0) parts.push(`take about ${best.pct}% off`);
return `${parts.join(' and ')}: expected ${money0(base.net)} → ${money0(best.net)} after cleaning (${base.nights.toFixed(1)} → ${best.nights.toFixed(1)} nights booked of ${v.nights}).`;
}

// For each dead void: what the model says to change, and a task for you to make the change on Airbnb.
async function assessDeadVoids(record, ctx, params, model) {
const dead = deadVoidsOf(record).slice(0, 8);
record.deadVoids = [];
if (!dead.length) return;
const { captureTask } = await import('./tasks.js');
for (const v of dead) {
let advice = null;
try { advice = model.optimiseVoid(ctx, v, { params }); } catch (err) { console.error('Dead void modelling failed:', err); }
if (advice && advice.error) advice = null;
const key = deadKey(v);
let task = (data.tasks || []).find((t) => t.source && t.source.kind === 'dead void' && t.source.key === key);
const text = adviceText(v, advice);
if (!task && advice && advice.best) {
const what = [advice.best.minNights < advice.curMin ? 'allow 1-night stays' : '', advice.best.pct > 0 ? `${advice.best.pct}% off` : ''].filter(Boolean).join(' + ');
task = captureTask({
title: `Airbnb: ${what} for ${shortDay(v.from)}–${shortDay(v.to)} (${v.roomLabel})`,
notes: `A dead void: ${v.nights} free night${v.nights === 1 ? '' : 's'}, ${shortDay(v.from)} to ${shortDay(v.to)} in ${v.roomLabel}, expected to fill only ${v.expectedNights.toFixed(1)} of them. ${text}`,
source: { kind: 'dead void', label: 'Dead void', key, roomKey: v.roomKey, from: v.from, to: v.to },
});
}
record.deadVoids.push({ id: v.id, roomKey: v.roomKey, from: v.from, to: v.to, nights: v.nights, expectedNights: v.expectedNights, text, gain: advice && advice.best ? advice.gain : 0, best: advice && advice.best ? { minNights: advice.best.minNights, pct: advice.best.pct } : null, taskId: task ? task.id : '' });
}
}

// One run at a time: a second request (a push while one is going) waits for and shares the first.
let inflight = null;
// Runs the projection (in slices, so the page keeps responding), saves it and returns the record.
// `onProgress(0..1)` for a status line.
function runProjection(opts = {}) {
if (!inflight) inflight = runProjectionOnce(opts).finally(() => { inflight = null; });
return inflight;
}

async function runProjectionOnce({ onProgress = () => {} } = {}) {
const model = await import('./bookingmodel.js');
const ctx = model.buildContext();
const proj = model.makeProjection(ctx);
if (proj.error) return { error: proj.error };
while (!proj.step(25)) {
onProgress(proj.progress);
await yieldToPage();
}
const result = proj.finish();
if (result.error) return { error: result.error };
const record = blankBookingProjection({ ...result, madeAt: new Date().toISOString() });
try { await assessDeadVoids(record, ctx, proj.params, model); } catch (err) { console.error('Dead void check failed:', err); }
// One per day: a re-run replaces today's, and older ones past the retention are dropped.
const cutoff = dateStrAdd(todayStr(), -KEEP_DAYS);
data.bookingProjections = (data.bookingProjections || []).filter((p) => p.today !== record.today && String(p.today) >= cutoff);
data.bookingProjections.push(record);
queueSave();
import('./ticker.js').then((m) => m.renderTicker()).catch(() => {});
return { record };
}

// Re-runs the projection after something changed the bookings (a stay pushed to the calendar) and
// redraws everything that shows it. Quiet: a failure here is only logged.
async function refreshProjection() {
try {
const r = await runProjection();
if (r.error) return r;
const occ = await import('./lettingoccupancy.js');
occ.renderLettingOccupancy();
import('./letting.js').then((m) => m.renderLetting()).catch(() => {});
return r;
} catch (err) {
console.error('Projection refresh failed:', err);
return { error: String(err.message || err) };
}
}

// The month whose model review is due: in the first ten days of a month, last month, if saved
// projections cover at least ten of its nights that have now passed and the review hasn't been opened
// since. Light on purpose (reads only the saved projections): the Today nudges call it on every build.
function reviewDueMonth() {
const today = todayStr();
if (Number(today.slice(8, 10)) > 10) return '';
const prev = dateStrAdd(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
if (data.prefs.modelReviewSeen === prev) return '';
const nights = new Set();
(data.bookingProjections || []).forEach((p) => (p.voids || []).forEach((v) => {
for (let i = 0; i < v.nights; i++) { const d = dateStrAdd(v.from, i); if (d.startsWith(prev) && d < today && d > String(p.madeAt).slice(0, 10)) nights.add(`${v.roomKey}|${d}`); }
}));
return nights.size >= 10 ? prev : '';
}

export { latestProjection, projectionForMonth, projectedNights, projectedByDate, runProjection, refreshProjection, isDeadVoid, deadVoidsOf, DEAD_VOID_NIGHTS, statusText, ageDays, showProjection, reviewDueMonth, STALE_DAYS };
