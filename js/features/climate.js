// Room humidity (Govee thermo-hygrometers) beside the heating zones, and a history of
// temperature, humidity, dew point and outdoor weather to help diagnose damp.
//
// The home agent (home-agent/climate.py) reads the Govee cloud API and the neoHub every
// 10 minutes and keeps the log on the NAS, because damp happens at night when this app is
// closed. `climate.live` gives the current sensors; `climate.history {from, to}` gives
// bucketed series. Outdoor temperature, humidity, dew point and rain come straight from
// Open-Meteo (no key) for the same span.
//
// data.climateReading {fetchedAt, sensors:[{id,name,sku,tempC,rh,online}]} -- the latest read,
// device-local like heatingReading. data.climateSensorZones {sensorId: zoneName | '-'} --
// which heating zone each sensor sits in ('-' = none); a sensor with no entry is matched to
// the zone whose name its Govee name contains.
import { run } from '../homeagent.js';
import { data, queueSave, onDataChange } from '../state.js';
import { escapeHtml } from '../utils.js';

const HOME = { lat: 51.5074, lon: -0.1278 }; // London, as the weather ticker uses
const RANGES = [['2d', 2], ['7d', 7], ['30d', 30], ['90d', 90]];
const DAMP_RH = 70; // sustained relative humidity above this lets mould grow
const WARN_RH = 60;
const ROOM_COLOURS = ['var(--blue)', 'var(--amber)', 'var(--plum)', 'var(--teal)', 'var(--rose)', 'var(--sage)'];
const OUT_COLOUR = 'var(--muted)';

let climateError = '';
let climateBusy = false;
let range = '7d';
const histCache = {}; // range -> {at, hist, outdoor}
let histBusy = false;
let histError = '';

const reading = () => data.climateReading || null;
const sensorsNow = () => (reading() ? reading().sensors || [] : []);
const zoneNames = () => ((data.heatingReading && data.heatingReading.zones) || []).map((z) => z.zone).filter(Boolean);

function zoneOfSensor(s, zones = zoneNames()) {
const set = (data.climateSensorZones || {})[s.id];
if (set === '-') return '';
if (set && zones.includes(set)) return set;
const n = String(s.name || '').toLowerCase();
return zones.find((z) => n.includes(String(z).toLowerCase()) || String(z).toLowerCase().includes(n)) || '';
}

const sensorForZone = (zone) => sensorsNow().find((s) => zoneOfSensor(s) === zone) || null;

function dewPoint(t, rh) {
if (t == null || rh == null || rh <= 0) return null;
const a = 17.62, b = 243.12;
const g = Math.log(rh / 100) + (a * t) / (b + t);
return (b * g) / (a - g);
}

const rhTone = (rh) => (rh == null ? '' : rh >= DAMP_RH ? 'damp' : rh >= WARN_RH ? 'humid' : '');
const rhText = (rh) => (rh == null ? '–' : `${Math.round(rh)}%`);

// The humidity chip beside a heating zone's temperature (heating.js).
function zoneHumidityHtml(zone) {
const s = sensorForZone(zone);
if (!s || s.rh == null) return '';
const title = `Humidity and temperature at the ${s.name} sensor${s.online ? '' : ', offline'}; the large figure is the thermostat's`;
return `<span class="heat-rh ${rhTone(s.rh)}${s.online ? '' : ' off'}" title="${escapeHtml(title)}">${rhText(s.rh)}${s.tempC != null ? `<span class="heat-rh-t"> · ${s.tempC.toFixed(1)}°</span>` : ''}</span>`;
}

// Sensors in no heating zone get their own row (heating.js), so a room without a thermostat still shows.
function climateExtraRowsHtml() {
const zones = zoneNames();
return sensorsNow().filter((s) => !zoneOfSensor(s, zones)).map((s) => `<div class="heat-item"><div class="heat-row climate-only">
<span class="heat-zone">${escapeHtml(s.name || 'Sensor')}</span>
<span class="heat-flags">${s.online ? '' : '<span class="heat-flag bad">offline</span>'}</span>
<span class="heat-rh ${rhTone(s.rh)}">${rhText(s.rh)}</span>
<span class="heat-actual">${s.tempC == null ? '–' : `${s.tempC.toFixed(1)}°`}</span>
<span class="heat-target"></span>
</div></div>`).join('');
}

function climateStatusText() {
if (climateError) return `humidity: ${climateError}`;
return '';
}

async function refreshClimate() {
if (climateBusy) return;
climateBusy = true;
try {
const res = await run('climate.live', {}, { timeoutMs: 45000 });
data.climateReading = { fetchedAt: Date.now(), sensors: res.sensors || [] };
climateError = (res.errors || []).length ? res.errors.join('; ') : '';
queueSave();
} catch (err) {
const m = (err && err.message) || String(err);
climateError = /doesn't know the verb/i.test(m) ? 'the home agent needs updating (1.23)' : /isn't configured/i.test(m) ? 'add GOVEE_API_KEY to the home agent' : m.split(/(?<=[.!?])\s/)[0];
} finally {
climateBusy = false;
}
window.dispatchEvent(new CustomEvent('climate-updated'));
}

// ---- history ------------------------------------------------------------------------------

async function fetchOutdoor(fromS, toS) {
const days = Math.min(92, Math.ceil((Date.now() / 1000 - fromS) / 86400) + 1);
const url = `https://api.open-meteo.com/v1/forecast?latitude=${HOME.lat}&longitude=${HOME.lon}`
+ `&hourly=temperature_2m,relative_humidity_2m,dew_point_2m,precipitation&past_days=${days}&forecast_days=1&timeformat=unixtime&timezone=UTC`;
const res = await fetch(url);
if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
const j = await res.json();
const h = j.hourly || {};
const out = [];
(h.time || []).forEach((t, i) => {
if (t < fromS || t > toS) return;
out.push({ t, temp: h.temperature_2m[i], rh: h.relative_humidity_2m[i], dew: h.dew_point_2m[i], rain: h.precipitation[i] });
});
return out;
}

async function loadHistory(force = false) {
const cached = histCache[range];
if (!force && cached && Date.now() - cached.at < 10 * 60 * 1000) { renderHistory(); return; }
if (histBusy) return;
histBusy = true; histError = '';
renderHistory();
const days = RANGES.find((r) => r[0] === range)[1];
const to = Math.floor(Date.now() / 1000);
const from = to - days * 86400;
try {
const [hist, outdoor] = await Promise.all([
run('climate.history', { from, to }, { timeoutMs: 60000 }),
fetchOutdoor(from, to).catch((e) => ({ error: e.message })),
]);
histCache[range] = { at: Date.now(), hist, outdoor };
} catch (err) {
const m = (err && err.message) || String(err);
histError = /doesn't know the verb/i.test(m) ? 'The home agent needs updating to 1.23 to keep a history.' : m;
} finally {
histBusy = false;
}
renderHistory();
}

// One room per Govee sensor (named by its zone where it has one) plus each heating zone with
// no sensor (temperature only). Heating on/off comes from the zone either way.
function roomsOf(hist) {
const zones = zoneNames();
const sensors = hist.sensors || [];
const live = new Map(sensorsNow().map((s) => [s.id, s]));
const rooms = [];
const zoneTaken = new Set();
sensors.filter((s) => s.src === 'govee').forEach((s) => {
const zone = zoneOfSensor(live.get(s.id) || { id: s.id, name: s.name }, zones);
if (zone) zoneTaken.add(zone);
const ser = hist.series[s.key] || {};
const zser = zone ? hist.series[`neohub:${zone}`] || {} : {};
rooms.push({ key: s.key, label: zone || s.name, temp: ser.temp || zser.temp || [], thermo: ser.temp ? zser.temp || [] : [], rh: ser.rh || [], heat: zser.heat || [], target: zser.target || [] });
});
sensors.filter((s) => s.src === 'neohub' && !zoneTaken.has(s.id)).forEach((s) => {
const ser = hist.series[s.key] || {};
rooms.push({ key: s.key, label: s.id, temp: ser.temp || [], thermo: [], rh: [], heat: ser.heat || [], target: ser.target || [] });
});
rooms.forEach((r, i) => { r.colour = ROOM_COLOURS[i % ROOM_COLOURS.length]; r.dew = r.temp.map((t, j) => { const d = dewPoint(t, r.rh[j]); return d == null ? null : Math.round(d * 10) / 10; }); });
return rooms;
}

const PADL = 40, PADR = 10;
let W = 900;
let PLOT_W = W - PADL - PADR;

function niceTicks(lo, hi, count = 4) {
const span = hi - lo || 1;
const raw = span / count;
const mag = 10 ** Math.floor(Math.log10(raw));
const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
const out = [];
for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
return { ticks: out, lo: Math.min(lo, out[0] ?? lo), hi: Math.max(hi, out[out.length - 1] ?? hi) };
}

function xTicks(t0, t1) {
const spanD = (t1 - t0) / 86400;
const out = [];
const d = new Date(t0 * 1000); d.setHours(0, 0, 0, 0);
const every = spanD <= 3 ? 1 : spanD <= 10 ? 1 : spanD <= 35 ? 7 : 14;
for (let t = d.getTime() / 1000 + 86400; t < t1; t += 86400 * every) out.push(t);
return out;
}

const dayLabel = (t, spanD) => new Date(t * 1000).toLocaleDateString('en-GB', spanD <= 10 ? { weekday: 'short', day: 'numeric' } : { day: 'numeric', month: 'short' });

// lines: [{colour, dash, pts:[[t, v]...]}]; refs: [{v, label}]; bars: [[t, v]]
function chartSvg({ title, unit, lines, refs = [], bars = null, t0, t1, h = 130, strips = [] }) {
const vals = lines.flatMap((l) => l.pts.map((p) => p[1])).concat(refs.map((r) => r.v)).filter((v) => v != null);
if (bars) vals.push(0, ...bars.map((b) => b[1]));
if (!vals.length) return `<div class="climate-chart-empty">${escapeHtml(title)}: nothing logged in this range yet.</div>`;
const stripH = strips.length ? strips.length * 5 + 6 : 0;
const top = 8, bottom = h - 20 - stripH;
let lo = Math.min(...vals), hi = Math.max(...vals);
if (bars) lo = 0;
const pad = (hi - lo) * 0.08 || 1;
const nt = niceTicks(bars ? 0 : lo - pad, hi + pad);
lo = nt.lo; hi = nt.hi;
const x = (t) => PADL + ((t - t0) / (t1 - t0)) * PLOT_W;
const y = (v) => bottom - ((v - lo) / (hi - lo)) * (bottom - top);
const spanD = (t1 - t0) / 86400;
const grid = nt.ticks.map((v) => `<line x1="${PADL}" x2="${W - PADR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="cc-grid"/><text x="${PADL - 5}" y="${(y(v) + 3.5).toFixed(1)}" class="cc-tick" text-anchor="end">${v}${unit}</text>`).join('');
const xt = xTicks(t0, t1).map((t) => `<line x1="${x(t).toFixed(1)}" x2="${x(t).toFixed(1)}" y1="${top}" y2="${bottom}" class="cc-grid v"/><text x="${(x(t) + 3).toFixed(1)}" y="${h - 6}" class="cc-tick">${escapeHtml(dayLabel(t, spanD))}</text>`).join('');
const refLines = refs.map((r) => (r.v >= lo && r.v <= hi ? `<line x1="${PADL}" x2="${W - PADR}" y1="${y(r.v).toFixed(1)}" y2="${y(r.v).toFixed(1)}" class="cc-ref"/><text x="${W - PADR - 2}" y="${(y(r.v) - 3).toFixed(1)}" class="cc-tick" text-anchor="end">${escapeHtml(r.label)}</text>` : '')).join('');
const barW = bars && bars.length > 1 ? Math.max(1, (PLOT_W / ((t1 - t0) / 3600)) - 1) : 2;
const barsSvg = bars ? bars.filter((b) => b[1] > 0).map(([t, v]) => `<rect x="${(x(t) - barW / 2).toFixed(1)}" y="${y(v).toFixed(1)}" width="${barW.toFixed(1)}" height="${(bottom - y(v)).toFixed(1)}" fill="var(--blue)" opacity="0.7"/>`).join('') : '';
const path = (pts) => {
let d = '', pen = false, lastT = null;
pts.forEach(([t, v]) => {
if (v == null || (lastT != null && t - lastT > 3 * 3600)) pen = false; // gaps break the line
if (v == null) return;
d += `${pen ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`; pen = true; lastT = t;
});
return d;
};
const linesSvg = lines.map((l) => `<path d="${path(l.pts)}" fill="none" stroke="${l.colour}" stroke-width="${l.dotted ? 1.5 : l.dash ? 1.5 : 2}"${l.dotted ? ' stroke-dasharray="1 3" stroke-linecap="round"' : l.dash ? ' stroke-dasharray="4 3"' : ''} stroke-linejoin="round"/>`).join('');
const stripsSvg = strips.map((s, i) => {
const yy = bottom + 4 + i * 5;
return s.pts.filter((p) => p[1] != null && p[1] >= 0.5).map(([t]) => `<rect x="${x(t).toFixed(1)}" y="${yy}" width="${Math.max(1, s.w).toFixed(1)}" height="3" fill="${s.colour}"/>`).join('');
}).join('');
return `<figure class="climate-chart"><figcaption>${escapeHtml(title)}</figcaption>
<svg viewBox="0 0 ${W} ${h}" role="img" aria-label="${escapeHtml(title)}" data-cc-t0="${t0}" data-cc-t1="${t1}">
${grid}${xt}${refLines}${barsSvg}${linesSvg}${stripsSvg}
<line class="cc-cursor" x1="0" x2="0" y1="${top}" y2="${bottom + stripH}" style="display:none"/>
<rect class="cc-hit" x="${PADL}" y="0" width="${PLOT_W}" height="${h}" fill="transparent"/>
</svg></figure>`;
}

function summaryHtml(rooms, step, outdoor) {
const hrs = (n) => Math.round((n * step) / 3600);
const avg = (a) => { const v = a.filter((x) => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
const rows = rooms.map((r) => {
const rh = r.rh.filter((v) => v != null);
const heatOn = r.heat.filter((v) => v != null);
const t = avg(r.temp);
return `<tr><td><span class="cc-key" style="background:${r.colour}"></span>${escapeHtml(r.label)}</td>
<td>${t == null ? '–' : `${t.toFixed(1)}°`}</td>
<td>${avg(r.thermo) == null ? '–' : `${avg(r.thermo).toFixed(1)}°`}</td>
<td>${rh.length ? `${Math.round(avg(rh))}%` : '–'}</td>
<td>${rh.length ? `${Math.round(Math.max(...rh))}%` : '–'}</td>
<td class="${rh.length && hrs(rh.filter((v) => v >= DAMP_RH).length) ? 'cc-bad' : ''}">${rh.length ? `${hrs(rh.filter((v) => v >= DAMP_RH).length)} h` : '–'}</td>
<td>${heatOn.length ? `${Math.round((heatOn.reduce((s, v) => s + v, 0) / heatOn.length) * 100)}%` : '–'}</td></tr>`;
}).join('');
const o = Array.isArray(outdoor) && outdoor.length ? outdoor : null;
const outRow = o ? `<tr class="cc-out"><td><span class="cc-key dash"></span>Outdoors</td><td>${avg(o.map((p) => p.temp)).toFixed(1)}°</td><td>–</td><td>${Math.round(avg(o.map((p) => p.rh)))}%</td><td>${Math.round(Math.max(...o.map((p) => p.rh)))}%</td><td>–</td><td>${o.reduce((s, p) => s + (p.rain || 0), 0).toFixed(1)} mm rain</td></tr>` : '';
return `<div class="climate-table-wrap"><table class="climate-table"><thead><tr><th>Room</th><th>Avg temp</th><th>Thermostat</th><th>Avg RH</th><th>Peak RH</th><th>Hours ≥${DAMP_RH}%</th><th>Heating on</th></tr></thead><tbody>${rows}${outRow}</tbody></table></div>`;
}

function mappingHtml() {
const zones = zoneNames();
const sensors = sensorsNow();
if (!sensors.length) return '';
return `<div class="climate-map">${sensors.map((s) => {
const set = (data.climateSensorZones || {})[s.id];
const cur = set === '-' ? '-' : zoneOfSensor(s, zones);
return `<label class="climate-map-row"><span>${escapeHtml(s.name)} sensor is in</span><select class="settings-input" data-climate-zone="${escapeHtml(s.id)}">
<option value="-"${cur === '-' || !cur ? ' selected' : ''}>no heating zone</option>
${zones.map((z) => `<option value="${escapeHtml(z)}"${z === cur ? ' selected' : ''}>${escapeHtml(z)}</option>`).join('')}</select></label>`;
}).join('')}</div>`;
}

let tipData = null;

function renderHistory() {
const body = document.getElementById('climate-history-body');
if (!body) return;
const c = histCache[range];
const head = `<div class="climate-head"><div class="climate-ranges" role="group" aria-label="Range">${RANGES.map(([k]) => `<button type="button" class="climate-range-btn${k === range ? ' on' : ''}" data-climate-range="${k}">${k}</button>`).join('')}</div>
<button type="button" class="sync-btn sm inline" data-climate-reload${histBusy ? ' disabled' : ''}>${histBusy ? 'Loading…' : 'Reload'}</button></div>`;
if (!c) { body.innerHTML = `${head}${mappingHtml()}<div class="empty">${histBusy ? 'Asking the home agent for the log…' : histError ? escapeHtml(histError) : 'Not loaded.'}</div>`; return; }
const { hist, outdoor } = c;
W = Math.max(300, Math.round(body.clientWidth || 900)); PLOT_W = W - PADL - PADR;
const rooms = roomsOf(hist);
const t0 = hist.t0, step = hist.step, t1 = hist.t0 + hist.n * step;
const ts = Array.from({ length: hist.n }, (_, i) => t0 + i * step + step / 2);
const o = Array.isArray(outdoor) ? outdoor : [];
const pts = (arr) => ts.map((t, i) => [t, arr[i] ?? null]);
const oPts = (k) => o.map((p) => [p.t, p[k]]);
const outLine = (k) => (o.length ? [{ colour: OUT_COLOUR, dash: true, pts: oPts(k) }] : []);
const stripW = (step / (t1 - t0)) * PLOT_W;
const strips = rooms.filter((r) => r.heat.some((v) => v != null)).map((r) => ({ colour: r.colour, pts: pts(r.heat), w: stripW }));
const legend = `<div class="climate-legend">${rooms.map((r) => `<span><span class="cc-key" style="background:${r.colour}"></span>${escapeHtml(r.label)}</span>`).join('')}${o.length ? '<span><span class="cc-key dash"></span>Outdoors</span>' : ''}${rooms.some((r) => r.thermo.some((v) => v != null)) ? '<span class="cc-legend-note">solid: sensor · dotted: thermostat</span>' : ''}${strips.length ? '<span class="cc-legend-note">bars under the temperature chart: heating on</span>' : ''}</div>`;
const since = hist.firstLogged ? `Logging since ${new Date(hist.firstLogged * 1000).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}. ` : '';
const outNote = outdoor && outdoor.error ? `Outdoor weather unavailable: ${escapeHtml(outdoor.error)}. ` : 'Outdoors: Open-Meteo, central London. ';
tipData = { rooms, ts, step, o };
body.innerHTML = `${head}${mappingHtml()}${legend}
${chartSvg({ title: 'Temperature', unit: '°', t0, t1, lines: [...rooms.map((r) => ({ colour: r.colour, pts: pts(r.temp) })), ...rooms.filter((r) => r.thermo.some((v) => v != null)).map((r) => ({ colour: r.colour, dotted: true, pts: pts(r.thermo) })), ...outLine('temp')], strips })}
${chartSvg({ title: 'Relative humidity', unit: '%', t0, t1, lines: [...rooms.filter((r) => r.rh.some((v) => v != null)).map((r) => ({ colour: r.colour, pts: pts(r.rh) })), ...outLine('rh')], refs: [{ v: DAMP_RH, label: `${DAMP_RH}%: mould risk if sustained` }, { v: WARN_RH, label: `${WARN_RH}%` }] })}
${chartSvg({ title: 'Dew point: walls, windows and corners colder than this get condensation', unit: '°', t0, t1, lines: [...rooms.filter((r) => r.dew.some((v) => v != null)).map((r) => ({ colour: r.colour, pts: pts(r.dew) })), ...outLine('dew')] })}
${o.length ? chartSvg({ title: 'Rain outdoors (mm per hour)', unit: '', t0, t1, h: 90, lines: [], bars: o.map((p) => [p.t, p.rain]) }) : ''}
<div class="climate-tip" hidden></div>
${summaryHtml(rooms, step, outdoor)}
<p class="settings-note">${since}${outNote}Readings every 10 minutes, averaged into ${Math.round(step / 60)}-minute steps. Humidity above ${DAMP_RH}% for long spells, or a room's dew point close to its coldest surface, is what grows mould.${histError ? ` <span class="cc-bad">${escapeHtml(histError)}</span>` : ''}</p>`;
}

function fmtV(v, u) { return v == null ? '–' : `${(Math.round(v * 10) / 10).toFixed(1)}${u}`; }

function onMove(e) {
const svg = e.target.closest('.climate-chart svg');
const body = document.getElementById('climate-history-body');
const tip = body && body.querySelector('.climate-tip');
if (!svg || !tipData || !tip) return;
const rect = svg.getBoundingClientRect();
const sx = ((e.clientX - rect.left) / rect.width) * W;
const t0 = Number(svg.dataset.ccT0), t1 = Number(svg.dataset.ccT1);
const t = t0 + ((sx - PADL) / PLOT_W) * (t1 - t0);
if (t < t0 || t > t1) return;
const i = Math.max(0, Math.min(tipData.ts.length - 1, Math.floor((t - t0) / tipData.step)));
body.querySelectorAll('.cc-cursor').forEach((l) => { l.setAttribute('x1', sx); l.setAttribute('x2', sx); l.style.display = ''; });
let near = null;
tipData.o.forEach((p) => { if (!near || Math.abs(p.t - t) < Math.abs(near.t - t)) near = p; });
const when = new Date(tipData.ts[i] * 1000).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
tip.innerHTML = `<div class="cc-tip-when">${escapeHtml(when)}</div><table>${tipData.rooms.map((r) => `<tr><td><span class="cc-key" style="background:${r.colour}"></span>${escapeHtml(r.label)}</td><td>${fmtV(r.temp[i], '°')}${r.thermo[i] != null ? ` <span class="cc-muted">(stat ${fmtV(r.thermo[i], '°')})</span>` : ''}</td><td>${r.rh[i] == null ? '' : `${Math.round(r.rh[i])}%`}</td><td>${r.dew[i] == null ? '' : `dew ${fmtV(r.dew[i], '°')}`}</td><td>${r.heat[i] != null && r.heat[i] >= 0.5 ? 'heating' : ''}</td></tr>`).join('')}
${near && Math.abs(near.t - t) < 5400 ? `<tr><td><span class="cc-key dash"></span>Outdoors</td><td>${fmtV(near.temp, '°')}</td><td>${Math.round(near.rh)}%</td><td>dew ${fmtV(near.dew, '°')}</td><td>${near.rain ? `${near.rain} mm` : ''}</td></tr>` : ''}</table>`;
tip.hidden = false;
const bRect = body.getBoundingClientRect();
const left = e.clientX - bRect.left;
tip.style.left = `${Math.min(Math.max(0, left + 12), bRect.width - tip.offsetWidth)}px`;
tip.style.top = `${e.clientY - bRect.top + 14}px`;
}

function onLeave() {
const body = document.getElementById('climate-history-body');
if (!body) return;
body.querySelectorAll('.cc-cursor').forEach((l) => { l.style.display = 'none'; });
const tip = body.querySelector('.climate-tip');
if (tip) tip.hidden = true;
}

function initClimate() {
const det = document.getElementById('climate-history');
const body = document.getElementById('climate-history-body');
if (!det || !body) return;
const open = document.getElementById('climate-history-btn');
if (open) open.addEventListener('click', () => { det.showModal(); loadHistory(); });
det.addEventListener('click', (e) => { if (e.target === det || e.target.closest('[data-climate-close]')) det.close(); });
window.addEventListener('resize', () => { if (det.open) renderHistory(); });
body.addEventListener('click', (e) => {
const r = e.target.closest('[data-climate-range]');
if (r) { range = r.dataset.climateRange; loadHistory(); return; }
if (e.target.closest('[data-climate-reload]')) loadHistory(true);
});
body.addEventListener('change', (e) => {
const sel = e.target.closest('[data-climate-zone]');
if (!sel) return;
data.climateSensorZones = { ...(data.climateSensorZones || {}), [sel.dataset.climateZone]: sel.value };
queueSave();
window.dispatchEvent(new CustomEvent('climate-updated'));
renderHistory();
});
body.addEventListener('pointermove', onMove);
body.addEventListener('pointerleave', onLeave);
onDataChange(() => { if (det.open) renderHistory(); });
}

// For checking the charts with made-up data from the console (no agent needed).
function showHistoryForTest(hist, outdoor) { histCache[range] = { at: Date.now(), hist, outdoor }; renderHistory(); }

export { showHistoryForTest, initClimate, refreshClimate, zoneHumidityHtml, climateExtraRowsHtml, climateStatusText, dewPoint };
