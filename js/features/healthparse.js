// Turns the raw {receivedAt, payload}[] entries health.php hands back into
// one row per local calendar day -- steps/sleep/heart rate/distance/
// calories/weight/body fat/exercise, all in the shape confirmed live
// against a real Health Connect payload (see health.js's header comment
// for how it gets here).
//
// Fully rebuilt from scratch on every parse, not incrementally merged into
// whatever was there before: entries are small in aggregate (health.php
// caps a GET at 2000) and dedup below is idempotent, so re-deriving the
// whole thing from the server's current log is simpler and safer than
// tracking what a previous parse already folded in.

// Health Connect's own numeric exercise-type codes couldn't be confirmed
// against an authoritative source (the bridge app's own README shows a
// string example, "running", but the real payload sends bare numeric
// codes like "8" -- no verified table for what each number means was
// found in any authoritative source). Rather than guess and risk
// mislabelling a session, only add an entry here once it's actually been
// confirmed; anything absent falls back to a plain, honest
// "Exercise (type N)".
const EXERCISE_TYPE_LABELS = {
'8': 'Bike', // confirmed against real records seen in Samsung Health
};

function exerciseTypeLabel(type) {
return EXERCISE_TYPE_LABELS[type] || `Exercise (type ${type})`;
}

// en-CA formats as YYYY-MM-DD, which happens to be exactly the bucket key
// this needs -- computed from the *local* device timezone, not UTC, so a
// reading at 23:45 local time doesn't get filed under the next UTC day.
function localDateOf(iso) {
const d = new Date(iso);
return isNaN(d) ? null : d.toLocaleDateString('en-CA');
}

function minutesBetween(a, b) {
const ms = new Date(b) - new Date(a);
return isNaN(ms) ? 0 : ms / 60000;
}

// Multiple syncs commonly resend overlapping time ranges -- confirmed live,
// exact duplicate {start_time,end_time} pairs inside a single real payload.
// Keeps the first occurrence under whatever key identifies "the same
// reading" for that record type.
function dedupeBy(records, keyFn) {
const seen = new Set();
const out = [];
for (const r of records) {
const key = keyFn(r);
if (seen.has(key)) continue;
seen.add(key);
out.push(r);
}
return out;
}

function blankDay(date) {
return {
date,
steps: 0,
distanceMeters: 0,
totalCalories: 0,
sleepMinutes: 0,
sleepStages: { light: 0, deep: 0, rem: 0, awake: 0 },
heartRate: null, // {min, max, avg, count}, filled in at the end
oxygenSaturation: null, // {min, max, avg, count}
weightKg: null,
bodyFatPct: null,
exerciseMinutes: 0,
exerciseSessions: [], // [{type, label, minutes, start}]
};
}

function dayFor(days, date) {
if (!days.has(date)) days.set(date, blankDay(date));
return days.get(date);
}

// Point-sample stats (heart rate, oxygen saturation) accumulate as
// {min,max,sum,count} during the pass, then collapse to {min,max,avg,count}
// once at the end -- keeps the running-total bookkeeping out of the shape
// actually stored in data.healthDaily.
function addSample(stats, value) {
if (!stats) stats = { min: value, max: value, sum: 0, count: 0 };
stats.min = Math.min(stats.min, value);
stats.max = Math.max(stats.max, value);
stats.sum += value;
stats.count += 1;
return stats;
}

function finalizeSamples(stats) {
if (!stats || !stats.count) return null;
return { min: stats.min, max: stats.max, avg: Math.round((stats.sum / stats.count) * 10) / 10, count: stats.count };
}

function parseHealthPayloads(entries) {
const steps = [], distance = [], totalCalories = [], sleep = [], heartRate = [],
oxygenSaturation = [], weight = [], bodyFat = [], exercise = [];

for (const entry of entries || []) {
const p = entry && entry.payload;
// A non-JSON body, or a shape from some other bridge app entirely --
// skip rather than throw, so one odd entry doesn't blank the whole parse.
if (!p || typeof p !== 'object') continue;
if (Array.isArray(p.steps)) steps.push(...p.steps);
if (Array.isArray(p.distance)) distance.push(...p.distance);
if (Array.isArray(p.total_calories)) totalCalories.push(...p.total_calories);
if (Array.isArray(p.sleep)) sleep.push(...p.sleep);
if (Array.isArray(p.heart_rate)) heartRate.push(...p.heart_rate);
if (Array.isArray(p.oxygen_saturation)) oxygenSaturation.push(...p.oxygen_saturation);
if (Array.isArray(p.weight)) weight.push(...p.weight);
if (Array.isArray(p.body_fat)) bodyFat.push(...p.body_fat);
if (Array.isArray(p.exercise)) exercise.push(...p.exercise);
}

const days = new Map();

dedupeBy(steps, (r) => `${r.start_time}|${r.end_time}`).forEach((r) => {
const date = localDateOf(r.start_time);
if (!date || typeof r.count !== 'number') return;
dayFor(days, date).steps += r.count;
});

dedupeBy(distance, (r) => `${r.start_time}|${r.end_time}`).forEach((r) => {
const date = localDateOf(r.start_time);
if (!date || typeof r.meters !== 'number') return;
dayFor(days, date).distanceMeters += r.meters;
});

dedupeBy(totalCalories, (r) => `${r.start_time}|${r.end_time}`).forEach((r) => {
const date = localDateOf(r.start_time);
if (!date || typeof r.calories !== 'number') return;
dayFor(days, date).totalCalories += r.calories;
});

const hrByDay = new Map();
dedupeBy(heartRate, (r) => r.time).forEach((r) => {
const date = localDateOf(r.time);
if (!date || typeof r.bpm !== 'number') return;
hrByDay.set(date, addSample(hrByDay.get(date), r.bpm));
});
hrByDay.forEach((stats, date) => { dayFor(days, date).heartRate = finalizeSamples(stats); });

const o2ByDay = new Map();
dedupeBy(oxygenSaturation, (r) => r.time).forEach((r) => {
const date = localDateOf(r.time);
if (!date || typeof r.percentage !== 'number') return;
o2ByDay.set(date, addSample(o2ByDay.get(date), r.percentage));
});
o2ByDay.forEach((stats, date) => { dayFor(days, date).oxygenSaturation = finalizeSamples(stats); });

// Latest reading of the day wins -- a scale is normally stepped on once,
// but a manual re-weigh or an overlapping sync could offer more than one.
dedupeBy(weight, (r) => r.time).sort((a, b) => new Date(a.time) - new Date(b.time)).forEach((r) => {
const date = localDateOf(r.time);
if (!date || typeof r.kilograms !== 'number') return;
dayFor(days, date).weightKg = Math.round(r.kilograms * 10) / 10;
});
dedupeBy(bodyFat, (r) => r.time).sort((a, b) => new Date(a.time) - new Date(b.time)).forEach((r) => {
const date = localDateOf(r.time);
if (!date || typeof r.percentage !== 'number') return;
dayFor(days, date).bodyFatPct = Math.round(r.percentage * 10) / 10;
});

// Bucketed by wake-up date (session_end_time) -- the usual "last night's
// sleep" convention. A session starting before midnight and ending after
// would otherwise split awkwardly across two days.
dedupeBy(sleep, (r) => r.session_end_time).forEach((r) => {
const date = localDateOf(r.session_end_time);
if (!date) return;
const day = dayFor(days, date);
day.sleepMinutes += (r.duration_seconds || 0) / 60;
(r.stages || []).forEach((s) => {
if (day.sleepStages[s.stage] != null) day.sleepStages[s.stage] += (s.duration_seconds || 0) / 60;
});
});

dedupeBy(exercise, (r) => `${r.start_time}|${r.end_time}`).forEach((r) => {
const date = localDateOf(r.start_time);
if (!date) return;
const day = dayFor(days, date);
const minutes = r.duration_seconds ? r.duration_seconds / 60 : minutesBetween(r.start_time, r.end_time);
day.exerciseMinutes += minutes;
day.exerciseSessions.push({ type: r.type, label: exerciseTypeLabel(r.type), minutes: Math.round(minutes), start: r.start_time });
});

// Round the accumulated sums once at the end, rather than repeatedly
// rounding a running total as records are added.
const result = [...days.values()].map((d) => ({
...d,
steps: Math.round(d.steps),
distanceMeters: Math.round(d.distanceMeters),
totalCalories: Math.round(d.totalCalories),
sleepMinutes: Math.round(d.sleepMinutes),
sleepStages: Object.fromEntries(Object.entries(d.sleepStages).map(([k, v]) => [k, Math.round(v)])),
exerciseMinutes: Math.round(d.exerciseMinutes),
}));
result.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // newest first
return result;
}

export { parseHealthPayloads, exerciseTypeLabel };
