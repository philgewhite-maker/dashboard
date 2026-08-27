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

// Full Health Connect / Samsung Health activity-type table, supplied
// directly by the user (not guessed -- this replaces the old single-entry
// placeholder that only had '8': 'Bike', added back when no authoritative
// source for the rest of the table had been found).
//
// Real payloads carry Health Connect's bare numeric healthConnectId (see
// parseHealthPayloads below), so that's what exerciseTypeLabel keys off.
// samsungCode/category are carried too for future use (e.g. reading a
// Samsung Health export directly) even though nothing consumes them yet.
//
// Neither id space is 1:1 with activity names:
// - healthConnectId 8 covers both "Biking (Outdoor)" and "Mountain Biking"
//   -- Health Connect's own enum doesn't distinguish them, only Samsung's
//   finer-grained code does. exerciseTypeLabel defaults to the first-listed
//   ("Biking (Outdoor)") since a real payload only ever gives us the id.
// - samsungCode is coarser still: 1001 covers Walking AND Wheelchair, 14001
//   covers both Swimming variants AND Water Polo, 10001 covers Calisthenics
//   AND Stretching, 15001 covers both Stair Climbing variants, 4006 covers
//   both American and Australian Football. exerciseTypesForSamsungCode
//   returns every match rather than silently picking one.
const EXERCISE_TYPES = [
{ name: 'Walking', healthConnectId: 79, healthConnectEnum: 'EXERCISE_TYPE_WALKING', samsungCode: 1001, category: 'Locomotion' },
{ name: 'Running', healthConnectId: 56, healthConnectEnum: 'EXERCISE_TYPE_RUNNING', samsungCode: 1002, category: 'Locomotion' },
{ name: 'Running (Treadmill)', healthConnectId: 57, healthConnectEnum: 'EXERCISE_TYPE_RUNNING_TREADMILL', samsungCode: 15005, category: 'Gym Machines' },
{ name: 'Biking (Outdoor)', healthConnectId: 8, healthConnectEnum: 'EXERCISE_TYPE_BIKING', samsungCode: 11007, category: 'Cycling & Wheeled' },
{ name: 'Biking (Stationary)', healthConnectId: 9, healthConnectEnum: 'EXERCISE_TYPE_BIKING_STATIONARY', samsungCode: 15003, category: 'Gym Machines' },
{ name: 'Mountain Biking', healthConnectId: 8, healthConnectEnum: 'EXERCISE_TYPE_BIKING', samsungCode: 13004, category: 'Outdoor & Trail' },
{ name: 'Hiking', healthConnectId: 37, healthConnectEnum: 'EXERCISE_TYPE_HIKING', samsungCode: 13001, category: 'Outdoor & Trail' },
{ name: 'Swimming (Pool)', healthConnectId: 74, healthConnectEnum: 'EXERCISE_TYPE_SWIMMING_POOL', samsungCode: 14001, category: 'Water Sports' },
{ name: 'Swimming (Open Water)', healthConnectId: 73, healthConnectEnum: 'EXERCISE_TYPE_SWIMMING_OPEN_WATER', samsungCode: 14001, category: 'Water Sports' },
{ name: 'Elliptical', healthConnectId: 25, healthConnectEnum: 'EXERCISE_TYPE_ELLIPTICAL', samsungCode: 15006, category: 'Gym Machines' },
{ name: 'Rowing Machine', healthConnectId: 54, healthConnectEnum: 'EXERCISE_TYPE_ROWING_MACHINE', samsungCode: 15004, category: 'Gym Machines' },
{ name: 'Rowing (Outdoor)', healthConnectId: 53, healthConnectEnum: 'EXERCISE_TYPE_ROWING', samsungCode: 14003, category: 'Water Sports' },
{ name: 'Paddling / Kayaking / Canoeing', healthConnectId: 46, healthConnectEnum: 'EXERCISE_TYPE_PADDLING', samsungCode: 14007, category: 'Water Sports' },
{ name: 'Sailing', healthConnectId: 58, healthConnectEnum: 'EXERCISE_TYPE_SAILING', samsungCode: 14004, category: 'Water Sports' },
{ name: 'Scuba Diving', healthConnectId: 59, healthConnectEnum: 'EXERCISE_TYPE_SCUBA_DIVING', samsungCode: 14005, category: 'Water Sports' },
{ name: 'Calisthenics', healthConnectId: 13, healthConnectEnum: 'EXERCISE_TYPE_CALISTHENICS', samsungCode: 10001, category: 'Strength & Bodyweight' },
{ name: 'Strength Training', healthConnectId: 70, healthConnectEnum: 'EXERCISE_TYPE_STRENGTH_TRAINING', samsungCode: 15002, category: 'Strength & Bodyweight' },
{ name: 'Weightlifting', healthConnectId: 81, healthConnectEnum: 'EXERCISE_TYPE_WEIGHTLIFTING', samsungCode: 10011, category: 'Strength & Bodyweight' },
{ name: 'Stretching', healthConnectId: 71, healthConnectEnum: 'EXERCISE_TYPE_STRETCHING', samsungCode: 10001, category: 'Flexibility & Recovery' },
{ name: 'High Intensity Interval Training (HIIT)', healthConnectId: 36, healthConnectEnum: 'EXERCISE_TYPE_HIGH_INTENSITY_INTERVAL_TRAINING', samsungCode: 10007, category: 'Conditioning' },
{ name: 'Boot Camp', healthConnectId: 10, healthConnectEnum: 'EXERCISE_TYPE_BOOT_CAMP', samsungCode: 10007, category: 'Conditioning' },
{ name: 'Yoga', healthConnectId: 83, healthConnectEnum: 'EXERCISE_TYPE_YOGA', samsungCode: 9002, category: 'Mind & Body' },
{ name: 'Pilates', healthConnectId: 48, healthConnectEnum: 'EXERCISE_TYPE_PILATES', samsungCode: 9001, category: 'Mind & Body' },
{ name: 'Dancing', healthConnectId: 16, healthConnectEnum: 'EXERCISE_TYPE_DANCING', samsungCode: 8002, category: 'Dance & Movement' },
{ name: 'Exercise Class / Aerobics', healthConnectId: 26, healthConnectEnum: 'EXERCISE_TYPE_EXERCISE_CLASS', samsungCode: 12001, category: 'Group Fitness' },
{ name: 'Boxing', healthConnectId: 11, healthConnectEnum: 'EXERCISE_TYPE_BOXING', samsungCode: 7002, category: 'Combat Sports' },
{ name: 'Martial Arts', healthConnectId: 44, healthConnectEnum: 'EXERCISE_TYPE_MARTIAL_ARTS', samsungCode: 7003, category: 'Combat Sports' },
{ name: 'Rock Climbing', healthConnectId: 51, healthConnectEnum: 'EXERCISE_TYPE_ROCK_CLIMBING', samsungCode: 13002, category: 'Outdoor & Trail' },
{ name: 'Stair Climbing', healthConnectId: 68, healthConnectEnum: 'EXERCISE_TYPE_STAIR_CLIMBING', samsungCode: 15001, category: 'Cardio' },
{ name: 'Stair Climbing Machine', healthConnectId: 69, healthConnectEnum: 'EXERCISE_TYPE_STAIR_CLIMBING_MACHINE', samsungCode: 15001, category: 'Gym Machines' },
{ name: 'Tennis', healthConnectId: 76, healthConnectEnum: 'EXERCISE_TYPE_TENNIS', samsungCode: 6002, category: 'Racket Sports' },
{ name: 'Badminton', healthConnectId: 2, healthConnectEnum: 'EXERCISE_TYPE_BADMINTON', samsungCode: 6003, category: 'Racket Sports' },
{ name: 'Table Tennis', healthConnectId: 75, healthConnectEnum: 'EXERCISE_TYPE_TABLE_TENNIS', samsungCode: 6004, category: 'Racket Sports' },
{ name: 'Squash', healthConnectId: 66, healthConnectEnum: 'EXERCISE_TYPE_SQUASH', samsungCode: 6001, category: 'Racket Sports' },
{ name: 'Racquetball', healthConnectId: 50, healthConnectEnum: 'EXERCISE_TYPE_RACQUETBALL', samsungCode: 6005, category: 'Racket Sports' },
{ name: 'Soccer / Football', healthConnectId: 64, healthConnectEnum: 'EXERCISE_TYPE_SOCCER', samsungCode: 4004, category: 'Team Sports' },
{ name: 'Basketball', healthConnectId: 5, healthConnectEnum: 'EXERCISE_TYPE_BASKETBALL', samsungCode: 4003, category: 'Team Sports' },
{ name: 'Baseball', healthConnectId: 4, healthConnectEnum: 'EXERCISE_TYPE_BASEBALL', samsungCode: 2001, category: 'Team Sports' },
{ name: 'Softball', healthConnectId: 65, healthConnectEnum: 'EXERCISE_TYPE_SOFTBALL', samsungCode: 2002, category: 'Team Sports' },
{ name: 'American Football', healthConnectId: 28, healthConnectEnum: 'EXERCISE_TYPE_FOOTBALL_AMERICAN', samsungCode: 4006, category: 'Team Sports' },
{ name: 'Australian Football', healthConnectId: 29, healthConnectEnum: 'EXERCISE_TYPE_FOOTBALL_AUSTRALIAN', samsungCode: 4006, category: 'Team Sports' },
{ name: 'Rugby', healthConnectId: 55, healthConnectEnum: 'EXERCISE_TYPE_RUGBY', samsungCode: 4002, category: 'Team Sports' },
{ name: 'Cricket', healthConnectId: 14, healthConnectEnum: 'EXERCISE_TYPE_CRICKET', samsungCode: 2003, category: 'Team Sports' },
{ name: 'Handball', healthConnectId: 35, healthConnectEnum: 'EXERCISE_TYPE_HANDBALL', samsungCode: 4005, category: 'Team Sports' },
{ name: 'Volleyball', healthConnectId: 78, healthConnectEnum: 'EXERCISE_TYPE_VOLLEYBALL', samsungCode: 5001, category: 'Team Sports' },
{ name: 'Golf', healthConnectId: 32, healthConnectEnum: 'EXERCISE_TYPE_GOLF', samsungCode: 3001, category: 'Precision Sports' },
{ name: 'Frisbee Disc', healthConnectId: 30, healthConnectEnum: 'EXERCISE_TYPE_FRISBEE_DISC', samsungCode: 11008, category: 'Field Sports' },
{ name: 'Ice Skating', healthConnectId: 39, healthConnectEnum: 'EXERCISE_TYPE_ICE_SKATING', samsungCode: 16004, category: 'Winter Sports' },
{ name: 'Ice Hockey', healthConnectId: 38, healthConnectEnum: 'EXERCISE_TYPE_ICE_HOCKEY', samsungCode: 16006, category: 'Winter Sports' },
{ name: 'Skiing', healthConnectId: 61, healthConnectEnum: 'EXERCISE_TYPE_SKIING', samsungCode: 16002, category: 'Winter Sports' },
{ name: 'Snowboarding', healthConnectId: 62, healthConnectEnum: 'EXERCISE_TYPE_SNOWBOARDING', samsungCode: 16007, category: 'Winter Sports' },
{ name: 'Snowshoeing', healthConnectId: 63, healthConnectEnum: 'EXERCISE_TYPE_SNOWSHOEING', samsungCode: 16009, category: 'Winter Sports' },
{ name: 'Skating (Roller / Inline)', healthConnectId: 60, healthConnectEnum: 'EXERCISE_TYPE_SKATING', samsungCode: 11001, category: 'Cycling & Wheeled' },
{ name: 'Surfing', healthConnectId: 72, healthConnectEnum: 'EXERCISE_TYPE_SURFING', samsungCode: 14011, category: 'Water Sports' },
{ name: 'Water Polo', healthConnectId: 80, healthConnectEnum: 'EXERCISE_TYPE_WATER_POLO', samsungCode: 14001, category: 'Water Sports' },
{ name: 'Wheelchair', healthConnectId: 82, healthConnectEnum: 'EXERCISE_TYPE_WHEELCHAIR', samsungCode: 1001, category: 'Locomotion' },
{ name: 'Other / Generic Workout', healthConnectId: 0, healthConnectEnum: 'EXERCISE_TYPE_OTHER_WORKOUT', samsungCode: 0, category: 'General' },
];

// Groups by a key that can collide (see the comment above) without
// silently dropping the losing entries -- callers get every match and
// decide, rather than an arbitrary last-write-wins pick.
function groupExerciseTypesBy(keyFn) {
const map = {};
for (const t of EXERCISE_TYPES) {
const key = String(keyFn(t));
(map[key] || (map[key] = [])).push(t);
}
return map;
}

const EXERCISE_TYPES_BY_HEALTH_CONNECT_ID = groupExerciseTypesBy((t) => t.healthConnectId);
const EXERCISE_TYPES_BY_SAMSUNG_CODE = groupExerciseTypesBy((t) => t.samsungCode);

function exerciseTypeLabel(type) {
const matches = EXERCISE_TYPES_BY_HEALTH_CONNECT_ID[String(type)];
return matches ? matches[0].name : `Exercise (type ${type})`;
}

// Every EXERCISE_TYPES entry sharing this Health Connect id -- usually one,
// occasionally two (see the ambiguity note above).
function exerciseTypesForHealthConnectId(id) {
return EXERCISE_TYPES_BY_HEALTH_CONNECT_ID[String(id)] || [];
}

// Every EXERCISE_TYPES entry sharing this Samsung Health code -- Samsung's
// codes are coarser than Health Connect's, so this can return several.
function exerciseTypesForSamsungCode(code) {
return EXERCISE_TYPES_BY_SAMSUNG_CODE[String(code)] || [];
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

export { parseHealthPayloads, exerciseTypeLabel, EXERCISE_TYPES, exerciseTypesForHealthConnectId, exerciseTypesForSamsungCode };
