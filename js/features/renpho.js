// Renpho smart-scale CSV export -- consumed automatically the moment a
// matching file lands in Capture Inbox (see captureItemKind() in
// captureinbox.js), no manual triage step needed since it's a fully
// deterministic shape, unlike a photo of unknown content.
//
// Column layout confirmed against a real export ("RENPHO Health-
// philgewhite.csv", 2026-08-22), header row verbatim:
//   No.,Date,Time,Weight(kg),BMI,Body Fat Percentage(%),Body Fat Mass(kg),
//   Muscle Percentage(%),Muscle Mass(kg),Skeletal Muscle Percentage(%),
//   Skeletal Muscle Mass(kg),Bone Percentage(%),Bone Mass(kg),
//   Protein Percentage(%),Protein Mass(kg),Body Water Percentage(%),
//   Body Water Mass(kg),Fat-Free Mass(kg),Subcutaneous Fat(%),Visceral Fat,
//   BMR(kcal),Metabolic Age,WHR (Waist-to-Hip Ratio),Optimal Weight(kg),
//   Weight Level,Body Type,Target to optimal weight(kg),
//   Target to optimal muscle mass(kg),Target to optimal fat mass(kg),Remarks,
// Only the measurements are kept -- Renpho's own coaching fields (optimal
// weight, weight-level/body-type verdicts, targets) are opinions about the
// numbers, not readings, and are left out. A partial reading (stood on the
// scale barefoot but briefly, so only weight/BMI got captured) shows as
// "--" for everything else in the source file; those come through as
// undefined here rather than a fabricated zero.
import { data } from '../state.js';
import { todayStr } from '../utils.js';
import { tieredRowsForDisplay, isFullHistoryMode, isPeriodRow, periodLabel } from './healthrollup.js';

const HEADER_SIGNATURE = 'No.,Date,Time,Weight(kg),BMI,';

// Strips a leading UTF-8 BOM (﻿) before comparing -- a real export
// shared from an Android device carried one and silently failed a bare
// startsWith() check, confirmed live. Some exporters add it, some don't;
// tolerating it either way costs nothing.
function looksLikeRenphoCsv(headText) {
return (headText || '').replace(/^﻿/, '').startsWith(HEADER_SIGNATURE);
}

// Minimal quote-aware split -- Renpho's own export never quotes a field in
// the sample seen so far, but Remarks is free text and could contain a
// comma, so this is cheap insurance rather than a bare .split(',').
function splitCsvLine(line) {
const out = [];
let cur = '';
let inQuotes = false;
for (let i = 0; i < line.length; i++) {
const c = line[i];
if (c === '"') { inQuotes = !inQuotes; continue; }
if (c === ',' && !inQuotes) { out.push(cur); cur = ''; continue; }
cur += c;
}
out.push(cur);
return out;
}

function num(v) {
if (v == null) return undefined;
const t = String(v).trim();
if (t === '' || t === '--') return undefined;
const n = Number(t);
return isNaN(n) ? undefined : n;
}

// Returns one entry per CSV row, newest first -- callers that want one
// entry per day should go through mergeRenphoDaily() below.
function parseRenphoCsv(text) {
const lines = (text || '').split(/\r?\n/).filter((l) => l.trim());
if (!lines.length || !looksLikeRenphoCsv(lines[0])) return [];
const rows = [];
for (const line of lines.slice(1)) {
const f = splitCsvLine(line);
if (f.length < 22 || !f[1]) continue; // no date -> not a real row
const date = f[1].trim().replace(/\./g, '-'); // 2026.08.22 -> 2026-08-22
rows.push({
date, time: (f[2] || '').trim(),
weightKg: num(f[3]), bmi: num(f[4]),
bodyFatPct: num(f[5]), bodyFatMassKg: num(f[6]),
musclePct: num(f[7]), muscleMassKg: num(f[8]),
skeletalMusclePct: num(f[9]), skeletalMuscleMassKg: num(f[10]),
bonePct: num(f[11]), boneMassKg: num(f[12]),
proteinPct: num(f[13]), proteinMassKg: num(f[14]),
waterPct: num(f[15]), waterMassKg: num(f[16]),
fatFreeMassKg: num(f[17]), subcutaneousFatPct: num(f[18]),
visceralFat: num(f[19]), bmrKcal: num(f[20]),
metabolicAge: num(f[21]), whr: num(f[22]),
});
}
return rows;
}

// Merges freshly-parsed rows into the running store, keyed by date. Renpho's
// own export is always the full history rather than a delta, so a re-share
// simply overwrites same-date entries with whatever the newest parse found
// -- safe to repeat, never accumulates duplicates. Multiple weigh-ins on one
// day collapse to the latest timestamp, the same "latest reading of the day
// wins" convention healthparse.js uses for Health Connect's weight/body-fat.
function mergeRenphoDaily(rows) {
const byDate = new Map((data.renphoDaily || []).map((r) => [r.date, r]));
const byDateNew = new Map();
[...rows].sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`))
.forEach((r) => byDateNew.set(r.date, r));
byDateNew.forEach((r, date) => byDate.set(date, r));
data.renphoDaily = [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
return byDateNew.size;
}

// HRV CSV placeholder -- unlike parseRenphoCsv above, no real HRV export has
// been seen yet, so this deliberately never matches rather than guessing at
// a column layout (the exact mistake this app avoids elsewhere -- see
// EXERCISE_TYPE_LABELS in healthparse.js). Fill in a real HEADER_SIGNATURE
// and a parseHrvCsv() here, following parseRenphoCsv's shape, once an actual
// HRV CSV export exists to check the format against.
function looksLikeHrvCsv(_headText) {
return false;
}

function formatRenphoDate(iso) {
const d = new Date(`${iso}T00:00:00`);
return isNaN(d) ? iso : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

// Handles both a raw day (r.weightKg etc directly on it) and an aggregated
// period row (the same fields under r.metrics) -- see healthrollup.js's
// isPeriodRow/periodLabel for how the two are told apart and labelled.
function renphoRowHtml(r) {
const period = isPeriodRow(r);
const get = (key) => (period ? r.metrics[key] : r[key]);
const weightKg = get('weightKg');
const bmi = get('bmi');
const bodyFatPct = get('bodyFatPct');
const muscleMassKg = get('muscleMassKg');
const visceralFat = get('visceralFat');
const metabolicAge = get('metabolicAge');
const label = period ? periodLabel(r) : formatRenphoDate(r.date);
return `<tr${period ? ' class="health-row-summary"' : ''}>
<td>${label}</td>
<td>${weightKg != null ? `${weightKg}kg` : '—'}</td>
<td>${bmi != null ? bmi : '—'}</td>
<td>${bodyFatPct != null ? `${bodyFatPct}%` : '—'}</td>
<td>${muscleMassKg != null ? `${muscleMassKg}kg` : '—'}</td>
<td>${visceralFat != null ? visceralFat : '—'}</td>
<td>${metabolicAge != null ? metabolicAge : '—'}</td>
</tr>`;
}

function renderRenphoDaily() {
const el = document.getElementById('renpho-daily-body');
if (!el) return;
const rows = data.renphoDaily || [];
if (!rows.length) {
el.innerHTML = '<tr><td colspan="7" class="empty">No Renpho data yet — share a Renpho CSV export from your phone and it\'ll land here automatically.</td></tr>';
} else if (isFullHistoryMode()) {
el.innerHTML = rows.map(renphoRowHtml).join('');
} else {
const { daily, monthly, quarterly, annual } = tieredRowsForDisplay(rows, todayStr());
el.innerHTML = [...daily, ...monthly, ...quarterly, ...annual].map(renphoRowHtml).join('');
}
// Fire-and-forget: keeps the trend chart in sync with whichever table last
// changed, without every data-mutation call site (CSV import, manual
// triage) needing its own separate chart-refresh call. Dynamic rather than
// a static import -- health.js doesn't need to know about renpho.js, only
// the reverse, so this avoids a compile-time cycle between the two.
import('./health.js').then(({ renderHealthChart }) => renderHealthChart());
}

export { looksLikeRenphoCsv, parseRenphoCsv, mergeRenphoDaily, looksLikeHrvCsv, renderRenphoDaily };
