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

// Runs the projection (in slices, so the page keeps responding), saves it and returns the record.
// `onProgress(0..1)` for a status line.
async function runProjection({ onProgress = () => {} } = {}) {
const model = await import('./bookingmodel.js');
const ctx = model.buildContext();
const proj = model.makeProjection(ctx);
if (proj.error) return { error: proj.error };
while (!proj.step(25)) {
onProgress(proj.progress);
await new Promise((r) => setTimeout(r, 0));
}
const result = proj.finish();
if (result.error) return { error: result.error };
const record = blankBookingProjection({ ...result, madeAt: new Date().toISOString() });
// One per day: a re-run replaces today's, and older ones past the retention are dropped.
const cutoff = dateStrAdd(todayStr(), -KEEP_DAYS);
data.bookingProjections = (data.bookingProjections || []).filter((p) => p.today !== record.today && String(p.today) >= cutoff);
data.bookingProjections.push(record);
queueSave();
return { record };
}

export { latestProjection, projectionForMonth, projectedNights, projectedByDate, runProjection, statusText, ageDays, showProjection, STALE_DAYS };
