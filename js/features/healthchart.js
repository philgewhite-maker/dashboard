// A small canvas-based multi-series line chart for the Health tab's Trends
// section -- no external charting library (none exists anywhere in this
// codebase; matches its no-build-step, no-CDN-dependency pattern). Metrics
// span all three health sources (Health Connect, the smart scale, AI-read
// Samsung Health screenshots), so any two can be overlaid regardless of
// which raw array they actually live in -- e.g. weight from the scale
// against HRV from a screenshot.
//
// Scaling (see the health-trends plan): the first two selected metrics get
// a real, labelled Y-axis each (left/right, actual units). Every metric
// after that is normalized to the same plot height using its own min-max
// (no drawn axis) -- readable via an end-of-line value label and the hover
// tooltip, which always shows every active series' real value regardless of
// whether it has a drawn axis.
import { seriesForRange } from './healthrollup.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDaysAgo(endIso, days) {
return new Date(new Date(`${endIso}T00:00:00`).getTime() - days * DAY_MS).toISOString().slice(0, 10);
}

// Colors are CSS custom properties (this app's existing accent palette --
// see css/style.css :root) so the chart matches the rest of the UI rather
// than inventing its own colors; canvas needs the resolved value, not the
// var() reference, hence resolveColor() at render time.
const HEALTH_METRICS = [
{ key: 'health.weightKg', label: 'Weight (Health Connect)', unit: 'kg', source: 'health', field: 'weightKg', decimals: 1, colorVar: '--sage' },
{ key: 'renpho.weightKg', label: 'Weight (scale)', unit: 'kg', source: 'renpho', field: 'weightKg', decimals: 1, colorVar: '--teal' },
{ key: 'wellness.hrvMs', label: 'HRV', unit: 'ms', source: 'wellness', field: 'hrvMs', decimals: 0, colorVar: '--amber' },
{ key: 'health.steps', label: 'Steps', unit: '', source: 'health', field: 'steps', decimals: 0, colorVar: '--slate' },
{ key: 'health.sleepMinutes', label: 'Sleep', unit: 'min', source: 'health', field: 'sleepMinutes', decimals: 0, colorVar: '--rose' },
{ key: 'health.heartRateAvg', label: 'Heart rate', unit: 'bpm', source: 'health', field: 'heartRateAvg', decimals: 0, colorVar: '--red' },
{ key: 'health.bodyFatPct', label: 'Body fat % (Health Connect)', unit: '%', source: 'health', field: 'bodyFatPct', decimals: 1, colorVar: '--plum' },
{ key: 'renpho.bodyFatPct', label: 'Body fat % (scale)', unit: '%', source: 'renpho', field: 'bodyFatPct', decimals: 1, colorVar: '--sage' },
{ key: 'renpho.muscleMassKg', label: 'Muscle mass', unit: 'kg', source: 'renpho', field: 'muscleMassKg', decimals: 1, colorVar: '--teal' },
{ key: 'renpho.visceralFat', label: 'Visceral fat', unit: '', source: 'renpho', field: 'visceralFat', decimals: 0, colorVar: '--amber' },
{ key: 'wellness.antioxidantIndex', label: 'Antioxidant index', unit: '', source: 'wellness', field: 'antioxidantIndex', decimals: 0, colorVar: '--slate' },
{ key: 'wellness.agesDailyAvg', label: 'AGEs index', unit: '', source: 'wellness', field: 'agesDailyAvg', decimals: 0, colorVar: '--rose' },
];

function metricByKey(key) { return HEALTH_METRICS.find((m) => m.key === key) || null; }

function resolveColor(varName) {
return getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || '#8A8579';
}

function formatMetricValue(metric, value) {
if (value == null) return '—';
const rounded = metric.decimals ? value.toFixed(metric.decimals) : Math.round(value).toLocaleString();
return `${rounded}${metric.unit}`;
}

function formatAxisDate(iso, spanDays) {
const d = new Date(`${iso}T00:00:00`);
if (isNaN(d)) return iso;
if (spanDays <= 40) return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
if (spanDays <= 400) return d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
if (spanDays <= 365 * 5.2) return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
return d.toLocaleDateString('en-GB', { year: 'numeric' });
}

// A handful of evenly spaced calendar ticks across the visible span --
// simple rather than "nice round number" tick placement, which isn't worth
// the complexity for a trend chart where the shape matters more than the
// exact axis values.
function timeTicks(startIso, endIso) {
const start = new Date(`${startIso}T00:00:00`).getTime();
const end = new Date(`${endIso}T00:00:00`).getTime();
const spanDays = Math.max(1, (end - start) / DAY_MS);
const count = 6;
const ticks = [];
for (let i = 0; i <= count; i++) {
const t = start + (i / count) * (end - start);
const iso = new Date(t).toISOString().slice(0, 10);
ticks.push({ frac: i / count, label: formatAxisDate(iso, spanDays) });
}
return ticks;
}

function niceRange(points) {
if (!points.length) return null;
let min = Infinity, max = -Infinity;
for (const p of points) { if (p.value < min) min = p.value; if (p.value > max) max = p.value; }
if (min === max) { min -= 1; max += 1; }
const pad = (max - min) * 0.1;
return { min: min - pad, max: max + pad };
}

function fitCanvas(canvas) {
const dpr = window.devicePixelRatio || 1;
const rect = canvas.getBoundingClientRect();
const w = Math.max(1, Math.round(rect.width));
const h = Math.max(1, Math.round(rect.height));
canvas.width = Math.round(w * dpr);
canvas.height = Math.round(h * dpr);
const ctx = canvas.getContext('2d');
ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
return { ctx, width: w, height: h };
}

// getRows(source) -> array of {date, [field]: number, ...} for 'health' |
// 'renpho' | 'wellness', already flattened (see healthrollup.js's
// flattenHealthDailyRow for the one source -- healthDaily -- that needs it).
// Always called fresh inside render(), never cached, so a re-render after
// new data lands (a sync, an import) picks it up with no extra wiring.
function createHealthChart(canvas, { getRows, onRangeChange }) {
let metricKeys = [];
let range = null; // {start,end} iso strings; null = default last-12-months
let hoverFrac = null; // 0..1 across the plot width, or null
let dragStartFrac = null;
let dragCurrentFrac = null;
let lastPlot = null; // set each render(): {rect, scales, seriesPoints} for pointer math

function effectiveRange() {
if (range) return range;
const end = new Date().toISOString().slice(0, 10);
return { start: isoDaysAgo(end, 365), end };
}

function activeMetrics() { return metricKeys.map(metricByKey).filter(Boolean); }

function fracToDate(frac, r) {
const start = new Date(`${r.start}T00:00:00`).getTime();
const end = new Date(`${r.end}T00:00:00`).getTime();
return new Date(start + frac * (end - start)).toISOString().slice(0, 10);
}

function render() {
const { ctx, width, height } = fitCanvas(canvas);
ctx.clearRect(0, 0, width, height);
const metrics = activeMetrics();
const r = effectiveRange();
const hasAxis1 = metrics.length >= 1;
const hasAxis2 = metrics.length >= 2;
const padLeft = hasAxis1 ? 52 : 12;
const padRight = hasAxis2 ? 52 : 12;
const padTop = 12;
const padBottom = 26;
const rect = { x: padLeft, y: padTop, w: Math.max(10, width - padLeft - padRight), h: Math.max(10, height - padTop - padBottom) };

const line = resolveColor('--line');
const muted = resolveColor('--muted');
const ink = resolveColor('--ink');
const paper = resolveColor('--paper');

// Gridlines + time-axis labels.
ctx.strokeStyle = line;
ctx.fillStyle = muted;
ctx.font = "10px 'Inter', sans-serif";
ctx.textBaseline = 'middle';
const ticks = timeTicks(r.start, r.end);
ticks.forEach((t) => {
const x = rect.x + t.frac * rect.w;
ctx.beginPath();
ctx.moveTo(x, rect.y);
ctx.lineTo(x, rect.y + rect.h);
ctx.stroke();
ctx.textAlign = t.frac <= 0.02 ? 'left' : t.frac >= 0.98 ? 'right' : 'center';
ctx.fillText(t.label, x, rect.y + rect.h + 14);
});
ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);

const seriesPoints = []; // per metric: {metric, color, scale, points:[{x,y,date,value}]}
metrics.forEach((metric, idx) => {
const rows = getRows(metric.source) || [];
const points = seriesForRange(rows, metric.field, r);
const yRange = niceRange(points);
const color = resolveColor(metric.colorVar);
const scale = yRange
? (v) => rect.y + rect.h - ((v - yRange.min) / (yRange.max - yRange.min)) * rect.h
: () => rect.y + rect.h / 2;
const plotted = points.map((p) => {
const start = new Date(`${r.start}T00:00:00`).getTime();
const end = new Date(`${r.end}T00:00:00`).getTime();
const frac = end > start ? (new Date(`${p.date}T00:00:00`).getTime() - start) / (end - start) : 0;
return { x: rect.x + frac * rect.w, y: scale(p.value), date: p.date, value: p.value };
});
seriesPoints.push({ metric, color, yRange, points: plotted });

if (plotted.length) {
ctx.strokeStyle = color;
ctx.lineWidth = 1.8;
ctx.beginPath();
plotted.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
ctx.stroke();
ctx.fillStyle = color;
plotted.forEach((p) => { ctx.beginPath(); ctx.arc(p.x, p.y, plotted.length > 60 ? 1.2 : 2.2, 0, Math.PI * 2); ctx.fill(); });
}

// Labelled axis for the first two series; end-of-line value label for
// every series after that (per the plan's scaling design).
if (idx < 2 && yRange) {
ctx.fillStyle = color;
ctx.font = "10px 'Inter', sans-serif";
ctx.textAlign = idx === 0 ? 'right' : 'left';
const axisX = idx === 0 ? rect.x - 6 : rect.x + rect.w + 6;
[0, 0.5, 1].forEach((f) => {
const v = yRange.min + f * (yRange.max - yRange.min);
const y = rect.y + rect.h - f * rect.h;
ctx.fillText(formatMetricValue(metric, v), axisX, y);
});
ctx.save();
ctx.translate(idx === 0 ? 12 : width - 12, rect.y + rect.h / 2);
ctx.rotate(idx === 0 ? -Math.PI / 2 : Math.PI / 2);
ctx.textAlign = 'center';
ctx.fillText(metric.label, 0, 0);
ctx.restore();
} else if (plotted.length) {
const last = plotted[plotted.length - 1];
ctx.fillStyle = color;
ctx.font = "600 10px 'Inter', sans-serif";
ctx.textAlign = last.x > rect.x + rect.w - 60 ? 'right' : 'left';
ctx.fillText(formatMetricValue(metric, last.value), last.x + (ctx.textAlign === 'right' ? -6 : 6), last.y);
}
});

lastPlot = { rect, seriesPoints, range: r };

// Drag-selection rectangle.
if (dragStartFrac != null && dragCurrentFrac != null) {
const x1 = rect.x + Math.min(dragStartFrac, dragCurrentFrac) * rect.w;
const x2 = rect.x + Math.max(dragStartFrac, dragCurrentFrac) * rect.w;
ctx.fillStyle = ink;
ctx.globalAlpha = 0.08;
ctx.fillRect(x1, rect.y, x2 - x1, rect.h);
ctx.globalAlpha = 1;
ctx.strokeStyle = ink;
ctx.strokeRect(x1, rect.y, x2 - x1, rect.h);
}

// Hover crosshair + tooltip.
if (hoverFrac != null && dragStartFrac == null) {
const x = rect.x + hoverFrac * rect.w;
ctx.strokeStyle = muted;
ctx.beginPath();
ctx.moveTo(x, rect.y);
ctx.lineTo(x, rect.y + rect.h);
ctx.stroke();
const hoverDate = fracToDate(hoverFrac, r);
const lines = [hoverDate, ...seriesPoints.map((s) => {
if (!s.points.length) return `${s.metric.label}: —`;
const nearest = s.points.reduce((a, b) => (Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a));
return `${s.metric.label}: ${formatMetricValue(s.metric, nearest.value)}`;
})];
ctx.font = "10px 'Inter', sans-serif";
const boxW = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16;
const boxH = lines.length * 14 + 10;
const boxX = Math.min(Math.max(x + 8, rect.x), rect.x + rect.w - boxW);
const boxY = rect.y + 6;
ctx.fillStyle = paper;
ctx.strokeStyle = line;
ctx.fillRect(boxX, boxY, boxW, boxH);
ctx.strokeRect(boxX, boxY, boxW, boxH);
ctx.fillStyle = ink;
ctx.textAlign = 'left';
lines.forEach((l, i) => ctx.fillText(l, boxX + 8, boxY + 12 + i * 14));
}
}

function pointerFrac(evt) {
const rect = canvas.getBoundingClientRect();
const x = (evt.clientX ?? (evt.touches && evt.touches[0]?.clientX)) - rect.left;
if (!lastPlot) return null;
const f = (x - lastPlot.rect.x) / lastPlot.rect.w;
return Math.min(1, Math.max(0, f));
}

canvas.style.touchAction = 'none';
canvas.addEventListener('pointerdown', (evt) => {
const f = pointerFrac(evt);
if (f == null) return;
dragStartFrac = f;
dragCurrentFrac = f;
try { canvas.setPointerCapture(evt.pointerId); } catch (e) { /* pointer already gone -- drag still tracked via dragStartFrac regardless */ }
render();
});
canvas.addEventListener('pointermove', (evt) => {
const f = pointerFrac(evt);
if (f == null) return;
if (dragStartFrac != null) { dragCurrentFrac = f; render(); }
else { hoverFrac = f; render(); }
});
canvas.addEventListener('pointerup', (evt) => {
if (dragStartFrac != null && dragCurrentFrac != null && lastPlot) {
const moved = Math.abs(dragCurrentFrac - dragStartFrac) * lastPlot.rect.w;
if (moved > 6) {
const r = lastPlot.range;
const newRange = {
start: fracToDate(Math.min(dragStartFrac, dragCurrentFrac), r),
end: fracToDate(Math.max(dragStartFrac, dragCurrentFrac), r),
};
range = newRange;
if (onRangeChange) onRangeChange(range);
}
}
dragStartFrac = null;
dragCurrentFrac = null;
try { canvas.releasePointerCapture(evt.pointerId); } catch (e) { /* already released */ }
render();
});
canvas.addEventListener('pointerleave', () => { hoverFrac = null; if (dragStartFrac == null) render(); });

return {
setMetrics(keys) { metricKeys = keys.slice(); render(); },
setRange(r) { range = r; if (onRangeChange) onRangeChange(range); render(); },
resetZoom() { range = null; if (onRangeChange) onRangeChange(null); render(); },
getRange() { return range; },
getMetrics() { return metricKeys.slice(); },
render,
};
}

export { HEALTH_METRICS, metricByKey, createHealthChart, isoDaysAgo };
