// Samsung Health wellness screenshots (Antioxidant index, AGEs index,
// Sleeping HRV) -- AI-vision-extracted from Capture Inbox photos, unlike
// renpho.js's deterministic CSV parse. Because a vision read is a guess,
// not a certainty, this is a per-selection action the user triggers
// ("Extract wellness data", captureinbox.js) rather than something that
// auto-consumes a photo the moment it lands, the way a recognised CSV does.
import { data, queueSave } from '../state.js';
import { extractWellnessScreenshot } from '../ai.js';
import { escapeHtml } from '../utils.js';

function blankWellnessDay(date) {
return {
date,
hrvMs: undefined, hrvGrade: undefined, hrvExact: undefined,
antioxidantIndex: undefined, antioxidantGrade: undefined, antioxidantExact: undefined,
agesDailyAvg: undefined, agesGrade: undefined, agesExact: undefined,
};
}

function dayFor(date) {
let row = data.wellnessDaily.find((d) => d.date === date);
if (!row) { row = blankWellnessDay(date); data.wellnessDaily.push(row); }
return row;
}

// A day's value is either a real printed number (exact:true) or read off
// the chart's vertical position between the stated Min and Max (exact:
// false -- see wellnessPrompt's own comment in ai.js for how that's
// computed). Both go onto that date; the render function marks estimated
// ones visibly (a "~") so a wrong one is easy to spot against the source
// screenshot rather than looking identical to a confirmed reading. A
// period-only rollup (no per-day dots placeable at all -- the AGEs chart
// when it states only a 7-day average, no Min/Max) attaches to asOfDate
// instead, also marked not-exact for the same reason.
function mergeWellnessExtraction(extraction) {
const { metric, days, average, headlineGrade } = extraction;
if (metric !== 'hrv' && metric !== 'antioxidant' && metric !== 'ages') return { daysWritten: 0, wroteAverage: false };

// The headline grade describes one specific reading ("last night's HRV
// grade"), not the whole week -- attach it only to the day it actually
// applies to (the chart's most recent point), not to every day written.
let daysWritten = 0;
days.forEach(({ date, value, exact }) => {
const row = dayFor(date);
const grade = date === extraction.asOfDate ? headlineGrade : undefined;
if (metric === 'hrv') { row.hrvMs = value; row.hrvExact = exact; if (grade) row.hrvGrade = grade; }
else if (metric === 'antioxidant') { row.antioxidantIndex = value; row.antioxidantExact = exact; if (grade) row.antioxidantGrade = grade; }
else if (metric === 'ages') { row.agesDailyAvg = value; row.agesExact = exact; if (grade) row.agesGrade = grade; }
daysWritten++;
});

let wroteAverage = false;
if (days.length === 0 && average != null && extraction.asOfDate) {
const row = dayFor(extraction.asOfDate);
if (metric === 'ages') { row.agesDailyAvg = average; row.agesExact = false; row.agesGrade = headlineGrade || row.agesGrade; wroteAverage = true; }
else if (metric === 'antioxidant') { row.antioxidantIndex = average; row.antioxidantExact = false; row.antioxidantGrade = headlineGrade || row.antioxidantGrade; wroteAverage = true; }
else if (metric === 'hrv') { row.hrvMs = average; row.hrvExact = false; row.hrvGrade = headlineGrade || row.hrvGrade; wroteAverage = true; }
}

data.wellnessDaily.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
return { daysWritten, wroteAverage };
}

// Runs the vision extraction and merges the result, returning a short
// human-readable summary for the caller's status line -- the source
// screenshot's thumbnail stays visible in Capture Inbox right up until
// the caller removes the item, so "here's what I read off it" is easy to
// sanity-check against.
async function extractAndMergeWellnessFile(file) {
const extraction = await extractWellnessScreenshot(file);
if (extraction.metric === 'unrecognized') {
return { ok: false, message: `${file.name || 'that image'}: didn't look like a recognised Samsung Health chart.` };
}
const { daysWritten, wroteAverage } = mergeWellnessExtraction(extraction);
queueSave();
const METRIC_LABEL = { hrv: 'HRV', antioxidant: 'Antioxidant index', ages: 'AGEs index' };
const label = METRIC_LABEL[extraction.metric];
let detail;
if (daysWritten > 0) detail = `${daysWritten} day${daysWritten === 1 ? '' : 's'}`;
else if (wroteAverage) detail = `period average (${extraction.average}${extraction.unit ? extraction.unit : ''})`;
else detail = 'nothing readable';
return { ok: daysWritten > 0 || wroteAverage, message: `${label}: ${detail}${extraction.headlineGrade ? ` — ${extraction.headlineGrade}` : ''}.` };
}

function formatWellnessDate(iso) {
const d = new Date(`${iso}T00:00:00`);
return isNaN(d) ? iso : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

// A "~" prefix marks a value read off the chart's vertical position rather
// than a number Samsung actually printed -- title text spells out why, so
// it reads as "estimated" rather than a typo on hover/tap.
function metricCellHtml(value, exact, unit, grade) {
if (value == null) return '—';
const prefix = exact === false ? '<span title="Estimated from the dot\'s position within its category band (e.g. Adequate), not a printed number">~</span>' : '';
const gradeHtml = grade ? ` <span class="settings-note" style="display:inline;">(${escapeHtml(grade)})</span>` : '';
return `${prefix}${value}${unit || ''}${gradeHtml}`;
}

function wellnessRowHtml(r) {
return `<tr>
<td>${escapeHtml(formatWellnessDate(r.date))}</td>
<td>${metricCellHtml(r.hrvMs, r.hrvExact, 'ms', r.hrvGrade)}</td>
<td>${metricCellHtml(r.antioxidantIndex, r.antioxidantExact, '', r.antioxidantGrade)}</td>
<td>${metricCellHtml(r.agesDailyAvg, r.agesExact, '', r.agesGrade)}</td>
</tr>`;
}

function renderWellnessDaily() {
const el = document.getElementById('wellness-daily-body');
if (!el) return;
const rows = data.wellnessDaily || [];
if (!rows.length) {
el.innerHTML = '<tr><td colspan="4" class="empty">No wellness data yet — select an HRV, AGEs, or Antioxidant index screenshot in Capture Inbox and use "Extract wellness data".</td></tr>';
return;
}
el.innerHTML = rows.map(wellnessRowHtml).join('');
}

export { mergeWellnessExtraction, extractAndMergeWellnessFile, renderWellnessDaily };
