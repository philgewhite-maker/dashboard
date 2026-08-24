// Pure aggregation over the three health arrays (data.healthDaily,
// data.renphoDaily, data.wellnessDaily) -- no persisted state of its own,
// nothing to migrate. Raw daily rows are never deleted (may be wanted later
// for a different chart angle, or exported for outside analysis), so every
// summary here is *derived on the fly* from whatever full history is
// already loaded, not folded-and-discarded. Two distinct consumers, one
// shared primitive (aggregateByPeriod):
//   - tieredRowsForDisplay(): the Health tab's default table view -- daily
//     rows for the last month, coarsening by AGE (how long ago) beyond that.
//   - seriesForRange(): the trend chart's per-series points -- coarsening by
//     how WIDE the visible zoom window is, regardless of how old it is (a
//     1-year-wide zoom into 2019 still wants near-monthly points, not to be
//     forced into the "5+ years old" annual tier just because it's old).

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(dateIso, todayIso) {
return Math.round((new Date(`${todayIso}T00:00:00`) - new Date(`${dateIso}T00:00:00`)) / DAY_MS);
}

// Every numeric field found directly on a row -- works unchanged across all
// three sources' different shapes (steps/weightKg for health, bmi/
// muscleMassKg for renpho, hrvMs/antioxidantIndex for wellness) since it
// never needs to know their names. The two nested {min,max,avg,count} shapes
// healthDaily carries (heartRate, oxygenSaturation) are flattened by the
// caller into plain numeric fields first -- see flattenHealthDailyRow below
// -- so this stays free of any source-specific knowledge.
function flattenNumericFields(row) {
const out = {};
for (const [k, v] of Object.entries(row || {})) {
if (typeof v === 'number' && !Number.isNaN(v)) out[k] = v;
}
return out;
}

// health.js/renpho.js/wellness.js each pass their raw row through this
// before handing it to aggregateByPeriod -- keeps the one nested-object
// special case (healthDaily's heartRate/oxygenSaturation samples) out of
// the generic aggregator.
function flattenHealthDailyRow(d) {
return {
...d,
heartRateAvg: d.heartRate ? d.heartRate.avg : undefined,
oxygenSaturationAvg: d.oxygenSaturation ? d.oxygenSaturation.avg : undefined,
};
}

function monthKey(dateIso) { return dateIso.slice(0, 7); } // YYYY-MM
function quarterKey(dateIso) {
const [y, m] = dateIso.split('-');
return `${y}-Q${Math.floor((Number(m) - 1) / 3) + 1}`;
}
function yearKey(dateIso) { return dateIso.slice(0, 4); } // YYYY

// Groups rows by periodKeyFn(row.date), averages every numeric field found
// across the rows in that group. `count` is how many raw days fed the
// average -- surfaced in the UI so a 2-day average doesn't read the same as
// a 30-day one. Rows are pre-flattened (see flattenHealthDailyRow) by the
// caller, not here -- keeps this function generic across all three sources.
function aggregateByPeriod(rows, periodKeyFn) {
const groups = new Map(); // periodKey -> { dates: [], sums: {field: total}, counts: {field: n} }
for (const row of rows) {
if (!row.date) continue;
const key = periodKeyFn(row.date);
if (!groups.has(key)) groups.set(key, { dates: [], sums: {}, counts: {} });
const g = groups.get(key);
g.dates.push(row.date);
const fields = flattenNumericFields(row);
for (const [field, value] of Object.entries(fields)) {
g.sums[field] = (g.sums[field] || 0) + value;
g.counts[field] = (g.counts[field] || 0) + 1;
}
}
const out = [];
groups.forEach((g, period) => {
g.dates.sort();
const metrics = {};
for (const field of Object.keys(g.sums)) {
metrics[field] = Math.round((g.sums[field] / g.counts[field]) * 100) / 100;
}
out.push({ period, start: g.dates[0], end: g.dates[g.dates.length - 1], count: g.dates.length, metrics });
});
out.sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : 0)); // newest first
return out;
}

// Age-from-today tiering for the Health tab's default table view -- see
// this module's header comment for the exact cutoffs. `rows` should already
// be flattened (flattenHealthDailyRow for healthDaily; renpho/wellness rows
// pass straight through, they carry no nested sample objects).
function tieredRowsForDisplay(rows, todayIso) {
const daily = [], toMonthly = [], toQuarterly = [], toAnnual = [];
for (const row of rows) {
if (!row.date) continue;
const age = daysAgo(row.date, todayIso);
if (age <= 31) daily.push(row);
else if (age <= 365) toMonthly.push(row);
else if (age <= 365 * 5) toQuarterly.push(row);
else toAnnual.push(row);
}
return {
daily: daily.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
monthly: aggregateByPeriod(toMonthly, monthKey),
quarterly: aggregateByPeriod(toQuarterly, quarterKey),
annual: aggregateByPeriod(toAnnual, yearKey),
};
}

// Span-width tiering for the trend chart -- resolution depends on how wide
// the *visible* range is, not how old it is. Returns [{date, value}] points
// for one metric field, using each period bucket's start date as its plotted
// x position.
function seriesForRange(rows, field, { start, end }) {
const spanDays = Math.max(1, (new Date(end) - new Date(start)) / DAY_MS);
const inRange = rows.filter((r) => r.date && r.date >= start && r.date <= end);
if (spanDays <= 40) {
return inRange
.filter((r) => typeof r[field] === 'number')
.map((r) => ({ date: r.date, value: r[field] }))
.sort((a, b) => (a.date < b.date ? -1 : 1));
}
const periodFn = spanDays <= 400 ? monthKey : spanDays <= 365 * 5.2 ? quarterKey : yearKey;
return aggregateByPeriod(inRange, periodFn)
.filter((r) => typeof r.metrics[field] === 'number')
.map((r) => ({ date: r.start, value: r.metrics[field] }))
.sort((a, b) => (a.date < b.date ? -1 : 1));
}

// A period-bucket row (from aggregateByPeriod/tieredRowsForDisplay) is
// {period, start, end, count, metrics} -- this tells one apart from a raw
// day row everywhere a table renderer needs to branch on it.
function isPeriodRow(r) { return typeof r.period === 'string'; }

// Shared label formatter -- used identically by health.js, renpho.js, and
// wellness.js's own table row rendering, so it lives here rather than being
// copied three times.
function periodLabel(r) {
const suffix = ` (avg of ${r.count} day${r.count === 1 ? '' : 's'})`;
if (/^\d{4}-\d{2}$/.test(r.period)) {
return new Date(`${r.period}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) + suffix;
}
if (/^\d{4}-Q\d$/.test(r.period)) {
const [y, q] = r.period.split('-Q');
return `${y} Q${q}${suffix}`;
}
return `${r.period}${suffix}`;
}

// Whether the Health tab's three tables show the full raw history or the
// tiered summary -- one shared flag, not three, since it's presented as a
// single switch in the UI (health.js) and read by all three tables' own
// render functions (health.js, renpho.js, wellness.js). Deliberately
// unpersisted -- like Capture Inbox's own in-page selection state, this is
// a display preference for the current session, not saved data.
let fullHistoryMode = false;
function isFullHistoryMode() { return fullHistoryMode; }
function setFullHistoryMode(v) { fullHistoryMode = !!v; }

export {
flattenNumericFields, flattenHealthDailyRow, monthKey, quarterKey, yearKey,
aggregateByPeriod, tieredRowsForDisplay, seriesForRange,
isFullHistoryMode, setFullHistoryMode, isPeriodRow, periodLabel,
};
