// Marriott Vacation Club "Book with Points" availability -- a Travel-tab
// panel wrapping the standalone scan script (js/features/marriottscan.js,
// run by hand in DevTools against owners.marriottvacationclub.com, a
// 3rd-party site this app has no live connection to). Three jobs, same
// shape as any other feature module:
//   1. Config -- the script's own parameters, edited here instead of in
//      the script file, baked into a copy-pasteable snippet on demand
//      (marriottscan.js's buildScanSnippet()).
//   2. Import -- the script's CSV or JSON output, pasted or uploaded,
//      same paste-textarea + file-input shape as manualimport.js's
//      dating-import pair.
//   3. Pivot -- a nights x resort x month summary table, with a click-
//      to-expand detail row per cell showing the real dates (and a
//      "+ trip" quick-add, since CLAUDE.md's record-reference standard
//      requires anywhere a trip could be created to link back to it via
//      the canonical tripChipHtml()/bindTripChips(), not a bespoke one).
//
// Data model: see state.js's blankMarriottAvailability() for the nested
// date-map shape and why it's nested rather than flat rows, and
// pruneMarriottAvailability() for how stale (past) dates/coverage age
// out. Import merges by REPLACING the (nights, month) slice the import
// covers -- see mergeMarriottAvailability()'s own comment for why that's
// the only merge rule that handles a resort selling out between scans
// (which produces no row at all in a re-scan, not a marked one).
import { data, queueSave, blankMarriottAvailability, pruneMarriottAvailability, blankLoyaltyBalance } from '../state.js';
import { escapeHtml, splitCsvLine, todayStr, dateStrAdd } from '../utils.js';
import { createTrip, tripChipHtml, bindTripChips } from './travel.js';

// Whether the "Only these:" radio is selected, tracked SEPARATELY from
// cfg.roomTypes (null vs an array) -- null also means "typed nothing
// yet" while "Only these" is picked but the text field is still empty,
// and deriving the radio's checked state from cfg.roomTypes on every
// render collapsed that case back to "Auto-detect" the instant the
// radio was clicked (confirmed live: the radio visually refused to
// stay selected). null here means "not yet initialised from the saved
// config" -- set once on the first fillConfigForm() call, then left
// alone so the user's own radio clicks are never overridden by a
// re-render.
let mvcRoomTypeOnlyMode = null;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DEFAULT_SCAN_CONFIG = { nightCounts: [2, 3, 4, 5, 7], guests: 2, monthsToScan: 3, roomTypes: null, speedMultiplier: 1.6 };

function monthLabel(ym) {
const [y, m] = String(ym || '').split('-').map(Number);
if (!y || !m) return String(ym || '');
return `${MONTH_SHORT[m - 1]} ${String(y).slice(2)}`;
}

function formatDateLabel(iso) {
const d = new Date(`${iso}T00:00:00Z`);
if (Number.isNaN(d.getTime())) return iso;
return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

// ---- Config -----------------------------------------------------------

// Normalizes whatever's in data.prefs.marriottScanConfig -- prefs merge
// shallowly (state.js: `{...DEFAULT_PREFS, ...(data.prefs||{})}`), so a
// corrupt or half-edited nested object is never trusted outright, same
// reasoning as every other nested pref this app validates on read rather
// than on save alone.
function normalizeScanConfig(raw) {
const cfg = raw && typeof raw === 'object' ? raw : {};
const nightCounts = [...new Set((Array.isArray(cfg.nightCounts) ? cfg.nightCounts : DEFAULT_SCAN_CONFIG.nightCounts)
.map((v) => Math.round(Number(v)))
.filter((n) => Number.isFinite(n) && n >= 1 && n <= 28))].sort((a, b) => a - b);
const guests = Math.min(12, Math.max(1, Math.round(Number(cfg.guests)) || DEFAULT_SCAN_CONFIG.guests));
const monthsToScan = Math.min(12, Math.max(1, Math.round(Number(cfg.monthsToScan)) || DEFAULT_SCAN_CONFIG.monthsToScan));
const roomTypes = Array.isArray(cfg.roomTypes) && cfg.roomTypes.length
? cfg.roomTypes.map((t) => String(t).trim()).filter(Boolean)
: null;
let speedMultiplier = Number(cfg.speedMultiplier);
if (!Number.isFinite(speedMultiplier)) speedMultiplier = DEFAULT_SCAN_CONFIG.speedMultiplier;
speedMultiplier = Math.round(Math.min(5, Math.max(0.5, speedMultiplier)) * 10) / 10;
return {
nightCounts: nightCounts.length ? nightCounts : DEFAULT_SCAN_CONFIG.nightCounts,
guests, monthsToScan, roomTypes: roomTypes && roomTypes.length ? roomTypes : null, speedMultiplier,
};
}

function readScanConfig() {
return normalizeScanConfig(data.prefs.marriottScanConfig);
}

function saveScanConfig(partial) {
data.prefs.marriottScanConfig = normalizeScanConfig({ ...readScanConfig(), ...partial });
queueSave();
return data.prefs.marriottScanConfig;
}

// Rough runtime estimate from the script's own wait constants (see
// marriottscan.js) -- N night-counts x M months, each month a full
// search across R resorts, each resort a filter-apply per room type T.
function estimateRunSeconds(cfg, resorts = 3, roomTypesPerResort = 3) {
const N = cfg.nightCounts.length;
const M = cfg.monthsToScan;
const m = cfg.speedMultiplier;
const perResort = 1.0 + 7 * m + roomTypesPerResort * (0.2 + 2 * m);
const perMonth = 2.1 + 4 * m + resorts * perResort;
return Math.round(N * M * perMonth);
}

function formatDuration(totalSeconds) {
const mins = Math.max(1, Math.round(totalSeconds / 60));
if (mins < 60) return `${mins} min`;
const h = Math.floor(mins / 60);
const rem = mins % 60;
return `${h}h${rem ? ` ${rem}m` : ''}`;
}

// {resorts, roomTypesPerResort} seen in the last import, for a realistic
// runtime estimate instead of a made-up guess once there's real data to
// draw from.
function averageResortAndRoomTypeCounts(store) {
const resortSet = new Set();
let roomTypeTotal = 0;
let resortsWithRoomTypes = 0;
Object.values(store.dates || {}).forEach((byResort) => {
Object.entries(byResort).forEach(([resort, byRoomType]) => {
resortSet.add(resort);
const n = Object.keys(byRoomType).length;
if (n) { roomTypeTotal += n; resortsWithRoomTypes++; }
});
});
return {
resorts: resortSet.size || 3,
roomTypesPerResort: resortsWithRoomTypes ? Math.round(roomTypeTotal / resortsWithRoomTypes) : 3,
hasData: resortSet.size > 0,
};
}

function roomTypesSeen(store) {
const set = new Set();
Object.values(store.dates || {}).forEach((byResort) => Object.values(byResort).forEach((byRoomType) => Object.keys(byRoomType).forEach((rt) => set.add(rt))));
return [...set].sort();
}

// ---- Import: detection + parsing ---------------------------------------

function looksLikeMarriottCsv(headLine) {
const header = splitCsvLine(String(headLine || '')).map((h) => h.trim().toLowerCase());
return header.includes('nights') && header.includes('resort') && header.includes('roomtype') && header.includes('date');
}

// Three shapes recognised: the {kind:'marriott-availability', ...} JSON
// export (exact months via monthsScanned, see marriottscan.js), the bare
// window.__marriottAvailability object (months inferred from its own
// dates), or the plain downloaded CSV (months also inferred).
function detectMarriottImportKind(text) {
const trimmed = String(text || '').trim();
if (!trimmed) return 'unknown';
if (trimmed[0] === '{' || trimmed[0] === '[') {
try {
const raw = JSON.parse(trimmed);
if (raw && typeof raw === 'object' && raw.kind === 'marriott-availability' && raw.results) return 'export-json';
if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
const keys = Object.keys(raw);
if (keys.length && keys.every((k) => /^\d+$/.test(k))) return 'results-json';
}
} catch (e) { /* not valid JSON -- fall through to the CSV check below */ }
}
if (looksLikeMarriottCsv(trimmed.split(/\r?\n/)[0])) return 'csv';
return 'unknown';
}

// Header-name-matched (not positional), same convention as
// manualimport.js's parseManualCsv -- a re-ordered export still parses.
// A `(none available)` date (or a blank one) becomes a date:null entry,
// which the merge step still uses to create an (empty but meaningful)
// container for that resort/roomType -- see mergeMarriottAvailability.
function parseMarriottCsv(text) {
const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
const skipped = { badDate: 0, past: 0 };
if (!lines.length) return { entries: [], months: null, scriptVersion: '', scannedAt: '', pointsBalance: null, apiCaptures: null, skipped };
const header = splitCsvLine(lines[0]).map((h) => h.trim());
const col = (label) => header.findIndex((h) => h.toLowerCase() === label.toLowerCase());
const idx = { nights: col('nights'), resort: col('resort'), roomType: col('roomType'), date: col('date'), points: col('points') };
const today = todayStr();
const entries = [];
lines.slice(1).forEach((line) => {
const cells = splitCsvLine(line);
const get = (i) => (i >= 0 && i < cells.length ? String(cells[i] || '').trim() : '');
const nights = get(idx.nights);
const resort = get(idx.resort);
const roomType = get(idx.roomType);
const rawDate = get(idx.date);
if (!nights || !resort || !roomType) return;
if (!rawDate || rawDate === '(none available)') { entries.push({ nights, resort, roomType, date: null, points: null }); return; }
if (!ISO_DATE_RE.test(rawDate)) { skipped.badDate++; return; }
if (rawDate < today) { skipped.past++; return; }
const points = Number(get(idx.points).replace(/,/g, ''));
entries.push({ nights, resort, roomType, date: rawDate, points: Number.isFinite(points) ? points : null });
});
return { entries, months: null, scriptVersion: '', scannedAt: '', pointsBalance: null, apiCaptures: null, skipped };
}

function flattenResults(results) {
const entries = [];
Object.entries(results || {}).forEach(([nights, byResort]) => {
Object.entries(byResort || {}).forEach(([resort, byRoomType]) => {
Object.entries(byRoomType || {}).forEach(([roomType, rows]) => {
if (!rows || !rows.length) { entries.push({ nights, resort, roomType, date: null, points: null }); return; }
rows.forEach((r) => entries.push({ nights, resort, roomType, date: r?.date || null, points: Number.isFinite(r?.points) ? r.points : null }));
});
});
});
return entries;
}

// Handles both the full {kind:'marriott-availability', ...} export and
// the bare window.__marriottAvailability results object -- the export
// additionally carries exact monthsScanned and a best-effort
// pointsBalance (see marriottscan.js), neither of which the bare results
// object or the CSV can provide.
function parseMarriottJson(raw) {
const today = todayStr();
const skipped = { badDate: 0, past: 0 };
const isExport = !!(raw && typeof raw === 'object' && raw.kind === 'marriott-availability');
const results = isExport ? raw.results : raw;
const entries = [];
flattenResults(results).forEach((e) => {
if (e.date == null) { entries.push(e); return; }
if (!ISO_DATE_RE.test(e.date)) { skipped.badDate++; return; }
if (e.date < today) { skipped.past++; return; }
entries.push(e);
});
return {
entries,
months: isExport && Array.isArray(raw.monthsScanned) ? raw.monthsScanned : null,
scriptVersion: isExport ? String(raw.scriptVersion || '') : '',
scannedAt: isExport ? String(raw.scannedAt || '') : '',
pointsBalance: isExport && raw.pointsBalance && Number.isFinite(raw.pointsBalance.balance) ? raw.pointsBalance : null,
apiCaptures: isExport && raw.apiCaptures && typeof raw.apiCaptures === 'object' ? raw.apiCaptures : null,
skipped,
};
}

// Only used when the import itself doesn't say which months it covers
// (the CSV, and a bare results object) -- a contiguous range from the
// earliest to the latest dated entry found. Every nights value in one
// script run scans the same months, so one range covers the whole
// import; it's approximate at the edges (a month with genuinely nothing
// open anywhere produces no dates to infer it from), which the import
// status message says plainly rather than implying exact coverage.
function inferMonthRange(entries) {
const dated = entries.map((e) => e.date).filter((d) => d && ISO_DATE_RE.test(d)).sort();
if (!dated.length) return [];
let [y, m] = dated[0].slice(0, 7).split('-').map(Number);
const [ey, em] = dated[dated.length - 1].slice(0, 7).split('-').map(Number);
const months = [];
while (y < ey || (y === ey && m <= em)) {
months.push(`${y}-${String(m).padStart(2, '0')}`);
m++; if (m > 12) { m = 1; y++; }
}
return months;
}

// Merge rule: REPLACE by (nights, month) slice. For every nights value
// and every month this import covers, every existing date in that slice
// (across every resort/roomType) is dropped before the new rows go in.
// This is the only rule that handles a resort selling out between two
// scans correctly -- that produces NO row in the new CSV (not a
// "(none available)" one), so appending would leave a stale "available"
// date forever, and a full overwrite would wipe an unrelated nights
// value's data the moment a narrower re-scan is imported.
function mergeMarriottAvailability(parsed, meta = {}) {
const store = data.marriottAvailability;
const months = parsed.months && parsed.months.length ? parsed.months : inferMonthRange(parsed.entries);
const nightsInImport = [...new Set(parsed.entries.map((e) => e.nights))];
const now = new Date().toISOString();

let replacedCount = 0;
nightsInImport.forEach((nights) => {
const byResort = store.dates[nights] || {};
Object.values(byResort).forEach((byRoomType) => {
Object.values(byRoomType || {}).forEach((byDate) => {
Object.keys(byDate).forEach((date) => {
if (months.includes(date.slice(0, 7))) { delete byDate[date]; replacedCount++; }
});
});
});
});

// Counts unique DATE KEYS actually added, not raw entries processed --
// confirmed live as a real discrepancy (status said "1112 dates",
// the panel's own total said "1080"): the scan script's own v11
// changelog already flags that a calendar's spillover days can be
// read twice, so the same (nights, resort, roomType, date) can appear
// more than once in one import; the object-key assignment below
// already dedupes it correctly, the COUNT just wasn't matching that.
let dateCount = 0;
parsed.entries.forEach((e) => {
if (!store.dates[e.nights]) store.dates[e.nights] = {};
if (!store.dates[e.nights][e.resort]) store.dates[e.nights][e.resort] = {};
if (!store.dates[e.nights][e.resort][e.roomType]) store.dates[e.nights][e.resort][e.roomType] = {}; // kept even when empty -- see blankMarriottAvailability's own comment
if (e.date) {
const isNew = !Object.prototype.hasOwnProperty.call(store.dates[e.nights][e.resort][e.roomType], e.date);
store.dates[e.nights][e.resort][e.roomType][e.date] = e.points;
if (isNew) dateCount++;
}
});

nightsInImport.forEach((nights) => months.forEach((month) => { store.coverage[`${nights}|${month}`] = now; }));

if (parsed.pointsBalance) {
store.pointsBalance = parsed.pointsBalance; // a point-in-time reading -- overwritten wholesale, never merged
// Also feeds the Loyalty balances panel, as its own "Marriott Vacation
// Club" program (state.js's DEFAULT_LOYALTY_PROGRAMS/_V5) -- reported
// directly as wanted there too, not just on this panel. Pushed as a
// new reading each import (not overwritten in place), same as every
// other loyalty reading in this app; deduped on (programId, label,
// date) so re-importing the exact same export twice doesn't double up.
const pb = parsed.pointsBalance;
const addLoyaltyReading = (label, balance) => {
if (balance == null) return;
const already = data.loyaltyBalances.some((b) => b.programId === 'loyalty-marriott-vc' && b.label === label && b.date === pb.asOf);
if (already) return;
data.loyaltyBalances.push(blankLoyaltyBalance({ programId: 'loyalty-marriott-vc', label, date: pb.asOf, balance, unit: 'points', sourceMessageId: 'marriott-scan' }));
};
addLoyaltyReading('Points balance', pb.balance);
addLoyaltyReading('Next Use Year', pb.potentialBalance);
}
if (parsed.apiCaptures) store.apiCaptures = parsed.apiCaptures; // same reasoning -- whatever the console captured THIS run replaces last run's

store.lastImport = {
at: now, fileName: meta.fileName || '', source: meta.source || 'paste',
scriptVersion: parsed.scriptVersion || '', dateCount, replacedCount, nightCounts: nightsInImport, months,
};
pruneMarriottAvailability(store);
queueSave();
return { dateCount, replacedCount, months, nightsInImport, skipped: parsed.skipped };
}

// Entry point for both the paste and file-upload routes. Returns a
// status message rather than throwing -- same "surface via plain text,
// never alert/throw" rule manualimport.js's own import follows.
function importMarriottText(text, meta = {}) {
const kind = detectMarriottImportKind(text);
if (kind === 'unknown') {
return { ok: false, message: "Couldn't tell what this is — paste the JSON export (run copy(window.__marriottAvailabilityExport) in the Console after scanning), the bare window.__marriottAvailability object, or the downloaded CSV." };
}
let parsed;
if (kind === 'csv') {
parsed = parseMarriottCsv(text);
} else {
let raw;
try { raw = JSON.parse(text); } catch (e) { return { ok: false, message: 'Could not parse that as JSON.' }; }
parsed = parseMarriottJson(raw);
}
if (!parsed.entries.length) return { ok: false, message: 'Nothing recognisable in that — 0 rows parsed.' };
const result = mergeMarriottAvailability(parsed, { ...meta, source: kind === 'csv' ? 'csv' : 'json' });
const monthLabels = result.months.map(monthLabel).join(', ') || '(months not identified)';
const nightsLabel = result.nightsInImport.join(', ');
let message = `Imported ${result.dateCount} open check-in date${result.dateCount === 1 ? '' : 's'} — ${nightsLabel} night${result.nightsInImport.length === 1 ? '' : 's'} × ${monthLabels}.`;
if (result.replacedCount) message += ` Replaced ${result.replacedCount} older date${result.replacedCount === 1 ? '' : 's'} in those same slices.`;
const skipParts = [];
if (result.skipped.badDate) skipParts.push(`${result.skipped.badDate} unreadable date${result.skipped.badDate === 1 ? '' : 's'}`);
if (result.skipped.past) skipParts.push(`${result.skipped.past} past date${result.skipped.past === 1 ? '' : 's'}`);
if (skipParts.length) message += ` Skipped ${skipParts.join(', ')}.`;
if (kind === 'csv') message += ' Months inferred from the dates found — paste the JSON export instead for exact scanned-month coverage.';
if (parsed.pointsBalance) message += ` Points balance updated: ${parsed.pointsBalance.balance.toLocaleString('en-GB')} as of ${parsed.pointsBalance.asOf} (also recorded under Marriott Vacation Club in Loyalty balances).`;
if (parsed.apiCaptures && ownerContractsFromCaptures(parsed.apiCaptures).length) message += ` Found ${ownerContractsFromCaptures(parsed.apiCaptures).length} owner contract${ownerContractsFromCaptures(parsed.apiCaptures).length === 1 ? '' : 's'} in the site's own console output.`;
return { ok: true, message };
}

// ---- Pivot builder ------------------------------------------------------

// Returns nights-groups (sorted numerically) -> resort-rows (the UNION
// of every resort seen across every nights value, sorted alphabetically
// -- so "nothing for 7 nights at Marbella" is a visible row, not a
// silent gap) -> a cell per month. `count` is distinct check-in dates
// (a date open under two room types counts once, unless roomTypeFilter
// narrows it to one). healthrollup.js's aggregateByPeriod only groups
// one level and isn't a fit for this two-level shape.
function buildAvailabilityPivot(store, { roomTypeFilter = '' } = {}) {
const nightsList = Object.keys(store.dates || {}).map(Number).sort((a, b) => a - b);
const resortSet = new Set();
nightsList.forEach((n) => Object.keys(store.dates[n] || {}).forEach((r) => resortSet.add(r)));
const resorts = [...resortSet].sort((a, b) => a.localeCompare(b));

const monthSet = new Set();
Object.keys(store.coverage || {}).forEach((k) => { const mo = k.split('|')[1]; if (mo) monthSet.add(mo); });
nightsList.forEach((n) => Object.values(store.dates[n] || {}).forEach((byRoomType) =>
Object.values(byRoomType).forEach((byDate) => Object.keys(byDate).forEach((d) => monthSet.add(d.slice(0, 7))))));
const months = [...monthSet].sort();

const unstableNamePattern = /^Resort \d+$/;

const groups = nightsList.map((nights) => {
const byResort = store.dates[nights] || {};
let totalDates = 0;
const rows = resorts.map((resort) => {
const byRoomType = byResort[resort] || {};
const cells = {};
let rowTotal = 0;
let anyCoverage = false;
months.forEach((month) => {
const coveredAt = store.coverage[`${nights}|${month}`] || null;
if (coveredAt) anyCoverage = true;
const datesThisMonth = new Set();
let minPoints = null;
Object.entries(byRoomType).forEach(([rt, byDate]) => {
if (roomTypeFilter && rt !== roomTypeFilter) return;
Object.entries(byDate).forEach(([date, points]) => {
if (date.slice(0, 7) !== month) return;
datesThisMonth.add(date);
if (points != null && (minPoints == null || points < minPoints)) minPoints = points;
});
});
const count = datesThisMonth.size;
const status = count > 0 ? (coveredAt ? 'open' : 'outside') : (coveredAt ? 'none' : 'unscanned');
const dates = [...datesThisMonth].sort().map((date) => {
const byRt = {};
Object.entries(byRoomType).forEach(([rt, byDate]) => {
if (roomTypeFilter && rt !== roomTypeFilter) return;
if (Object.prototype.hasOwnProperty.call(byDate, date)) byRt[rt] = byDate[date];
});
return { date, checkOut: dateStrAdd(date, nights), byRoomType: byRt };
});
cells[month] = { status, count, minPoints, coveredAt, dates };
rowTotal += count;
});
totalDates += rowTotal;
return { resort, unstableName: unstableNamePattern.test(resort), total: rowTotal, noneAvailable: rowTotal === 0 && anyCoverage, cells };
});
return { nights, totalDates, resortCount: resorts.length, rows };
});

return { months, roomTypes: roomTypesSeen(store), groups };
}

// ---- Rendering ----------------------------------------------------------

const expandedMvcCells = new Set(); // `${nights}|${resort}|${month}` -- extends financeaccounts.js's expandedAccounts Set idiom to a compound key
const collapsedMvcNights = new Set();
let mvcRoomTypeFilter = '';

// Matched by SHAPE (an array of objects carrying contractNumber/
// contractPoints/ownershipDetails), not by a hardcoded label -- the
// site's own console line happened to say "Owner Contracts" when this
// was confirmed, but that label isn't guaranteed to stay fixed, and
// apiCaptures is deliberately freeform (see marriottscan.js's
// installConsoleCapture()).
function ownerContractsFromCaptures(apiCaptures) {
if (!apiCaptures || typeof apiCaptures !== 'object') return [];
for (const value of Object.values(apiCaptures)) {
const arr = Array.isArray(value?.data) ? value.data : (Array.isArray(value) ? value : null);
if (!arr) continue;
if (arr.some((c) => c && typeof c === 'object' && ('contractNumber' in c || 'contractPoints' in c))) return arr;
}
return [];
}

function contractsHtml(store) {
const contracts = ownerContractsFromCaptures(store.apiCaptures);
if (!contracts.length) return '';
const rows = contracts.map((c) => {
const resort = c.ownershipDetails?.resortName || c.resortName || 'Contract';
const points = Number.isFinite(Number(c.contractPoints)) ? `${Number(c.contractPoints).toLocaleString('en-GB')} points/year` : '';
const bits = [points, c.contractStatus, c.contractNumber].filter(Boolean);
return `<div class="settings-note" style="margin:0;">${escapeHtml(resort)}${bits.length ? ` &mdash; ${bits.map(escapeHtml).join(' · ')}` : ''}</div>`;
}).join('');
return `<div class="mvc-contracts" style="margin:4px 0 10px;">${rows}</div>`;
}

function pointsBalanceHtml(store) {
const pb = store.pointsBalance;
const contractsBlock = contractsHtml(store);
if (!pb || !Number.isFinite(pb.balance)) {
return `<div class="settings-note" style="margin:0 0 10px;">No points balance read yet &mdash; only ever comes from the JSON export (<code>copy(window.__marriottAvailabilityExport)</code> after a scan). The CSV never carries it.</div>${contractsBlock}`;
}
const sourceNote = pb.source === 'header-guess' ? ' &mdash; best-effort page-header read, not yet confirmed live' : '';
const potentialHtml = Number.isFinite(pb.potentialBalance) ? ` <span class="settings-note">(potential: ${pb.potentialBalance.toLocaleString('en-GB')})</span>` : '';
return `<div class="mvc-balance"><span class="mvc-balance-num">${pb.balance.toLocaleString('en-GB')}</span><span>points</span>${potentialHtml}<span class="settings-note">as of ${escapeHtml(pb.asOf)}${sourceNote}</span></div>${contractsBlock}`;
}

function dateLineHtml(nights, resort, d) {
const existingTrip = data.trips.find((t) => t.startDate === d.date && (t.destinations || []).includes(resort));
const rtParts = Object.entries(d.byRoomType).filter(([, pts]) => pts != null).map(([rt, pts]) => `${escapeHtml(rt)} ${pts}`).join(' &middot; ');
const tripHtml = existingTrip
? tripChipHtml(existingTrip)
: `<button type="button" class="sync-btn sm inline" data-mvc-add-trip="${escapeHtml([nights, resort, d.date, d.checkOut].join('|'))}">+ trip</button>`;
return `<div class="mvc-date-line">${formatDateLabel(d.date)} &rarr; ${formatDateLabel(d.checkOut)}${rtParts ? ` &middot; ${rtParts}` : ''} ${tripHtml}</div>`;
}

function cellHtml(nights, resort, month, cell) {
if (cell.status === 'unscanned') {
return `<td class="mvc-month"><span class="mvc-cell mvc-unscanned" title="Not scanned for ${nights} nights in ${escapeHtml(monthLabel(month))}">&middot;</span></td>`;
}
const key = `${nights}|${resort}|${month}`;
const open = expandedMvcCells.has(key);
const label = cell.status === 'none' ? '&ndash;' : String(cell.count);
const pointsLine = cell.status !== 'none' && cell.minPoints != null ? `<small>from ${cell.minPoints}</small>` : '';
const asOf = cell.coveredAt ? ` &middot; as of ${escapeHtml(cell.coveredAt.slice(0, 10))}` : '';
const title = cell.status === 'none'
? `No check-in dates found${asOf}`
: `${cell.dates.map((d) => d.date).join(', ')}${asOf}${cell.status === 'outside' ? ' (outside the scanned range -- may be incomplete)' : ''}`;
return `<td class="mvc-month"><button type="button" class="mvc-cell mvc-${cell.status}" data-mvc-cell="${escapeHtml(key)}" aria-expanded="${open}" title="${escapeHtml(title)}">${label}${pointsLine}</button></td>`;
}

function resortRowHtml(nights, months, row) {
const cellsHtml = months.map((month) => cellHtml(nights, row.resort, month, row.cells[month])).join('');
const nameHtml = `${escapeHtml(row.resort)}`
+ (row.noneAvailable ? ' <span class="candidate-tag">none available</span>' : '')
+ (row.unstableName ? ` <span class="tag-chip tag-chip-amber" title="The scan script could not read this resort&#39;s name reliably -- the same label across different months/runs may not be the same resort">&#9888; name</span>` : '');
let html = `<tr data-mvc-row="${escapeHtml(`${nights}|${row.resort}`)}">
<td class="mvc-resort">${nameHtml}</td>
${cellsHtml}
<td class="mvc-month mvc-total">${row.total}</td>
</tr>`;
months.forEach((month) => {
const key = `${nights}|${row.resort}|${month}`;
if (!expandedMvcCells.has(key)) return;
const cell = row.cells[month];
const body = cell.status === 'none'
? `No check-in dates found for ${nights} nights at ${escapeHtml(row.resort)} in ${escapeHtml(monthLabel(month))}${cell.coveredAt ? ` (as of ${escapeHtml(cell.coveredAt.slice(0, 10))})` : ''}.`
: `<div class="settings-note" style="margin:0 0 4px;">${nights} nights &middot; ${escapeHtml(row.resort)} &middot; ${escapeHtml(monthLabel(month))} &mdash; ${cell.dates.length} check-in date${cell.dates.length === 1 ? '' : 's'}</div>${cell.dates.map((d) => dateLineHtml(nights, row.resort, d)).join('')}`;
html += `<tr class="mvc-detail-row"><td colspan="${months.length + 2}">${body}</td></tr>`;
});
return html;
}

function nightsGroupHtml(group, months) {
const collapsed = collapsedMvcNights.has(String(group.nights));
const rowsHtml = collapsed ? '' : group.rows.map((row) => resortRowHtml(group.nights, months, row)).join('');
return `<tbody data-mvc-nights="${group.nights}">
<tr class="mvc-nights-head"><td colspan="${months.length + 2}">
<button type="button" class="mvc-nights-toggle" data-mvc-nights-toggle="${group.nights}" aria-expanded="${!collapsed}">${collapsed ? '&#9656;' : '&#9662;'} ${group.nights} night${group.nights === 1 ? '' : 's'}</button>
<span class="settings-note">${group.totalDates} date${group.totalDates === 1 ? '' : 's'} across ${group.resortCount} resort${group.resortCount === 1 ? '' : 's'}</span>
</td></tr>
${rowsHtml}
</tbody>`;
}

function pivotHtml(pivot) {
if (!pivot.groups.length) {
return `<div class="empty">No availability imported yet &mdash; set up and copy the script in <span class="inline-goto-link" data-goto-tab="travel" data-goto-target="#mvc-copy-btn">1 &middot; Scan settings</span>, run it on owners.marriottvacationclub.com, then paste the result into <span class="inline-goto-link" data-goto-tab="travel" data-goto-target="#mvc-import-paste">2 &middot; Import results</span> below.</div>`;
}
const monthHeaders = pivot.months.map((m) => `<th>${escapeHtml(monthLabel(m))}</th>`).join('');
const filterHtml = pivot.roomTypes.length
? `<select id="mvc-roomtype-filter"><option value="">All room types</option>${pivot.roomTypes.map((rt) => `<option value="${escapeHtml(rt)}"${rt === mvcRoomTypeFilter ? ' selected' : ''}>${escapeHtml(rt)}</option>`).join('')}</select>`
: '';
return `<div class="sync-row" style="align-items:flex-start;">${filterHtml}</div>
<div style="overflow-x:auto;">
<table class="health-table mvc-pivot">
<thead><tr><th>Resort</th>${monthHeaders}<th>Total</th></tr></thead>
${pivot.groups.map((g) => nightsGroupHtml(g, pivot.months)).join('')}
</table>
</div>`;
}

function fillConfigForm() {
const cfg = readScanConfig();
const nightsInput = document.getElementById('mvc-cfg-nights');
if (nightsInput && document.activeElement !== nightsInput) nightsInput.value = cfg.nightCounts.join(', ');
const guestsInput = document.getElementById('mvc-cfg-guests');
if (guestsInput && document.activeElement !== guestsInput) guestsInput.value = cfg.guests;
const monthsInput = document.getElementById('mvc-cfg-months');
if (monthsInput && document.activeElement !== monthsInput) monthsInput.value = cfg.monthsToScan;
const speedInput = document.getElementById('mvc-cfg-speed');
if (speedInput && document.activeElement !== speedInput) speedInput.value = cfg.speedMultiplier;
const rtAutoRadio = document.getElementById('mvc-cfg-rt-auto');
const rtOnlyRadio = document.getElementById('mvc-cfg-rt-only');
const rtInput = document.getElementById('mvc-cfg-roomtypes');
if (mvcRoomTypeOnlyMode === null) mvcRoomTypeOnlyMode = !!cfg.roomTypes; // seed once from the saved config, never again -- see the flag's own comment
if (rtAutoRadio && rtOnlyRadio) { rtOnlyRadio.checked = mvcRoomTypeOnlyMode; rtAutoRadio.checked = !mvcRoomTypeOnlyMode; }
if (rtInput && document.activeElement !== rtInput) rtInput.value = cfg.roomTypes ? cfg.roomTypes.join(', ') : '';
const suggestEl = document.getElementById('mvc-rt-suggestions');
if (suggestEl) {
const seen = roomTypesSeen(data.marriottAvailability);
suggestEl.innerHTML = seen.map((rt) => `<span class="tag-chip" style="cursor:pointer;" data-mvc-rt-suggest="${escapeHtml(rt)}">${escapeHtml(rt)}</span>`).join('');
}
const estimateEl = document.getElementById('mvc-cfg-estimate');
if (estimateEl) {
const { resorts, roomTypesPerResort, hasData } = averageResortAndRoomTypeCounts(data.marriottAvailability);
const seconds = estimateRunSeconds(cfg, resorts, roomTypesPerResort);
estimateEl.textContent = `Estimated run time: about ${formatDuration(seconds)}${hasData ? ` (based on ${resorts} resort${resorts === 1 ? '' : 's'} × ${roomTypesPerResort} room type${roomTypesPerResort === 1 ? '' : 's'} seen in your last import)` : ' (assuming 3 resorts × 3 room types -- no import yet)'}.`;
}
}

function renderMarriottAvailability() {
const panel = document.getElementById('mvc-availability-panel');
if (!panel) return;
const store = data.marriottAvailability;
const totalDates = Object.values(store.dates || {}).reduce((sum, byResort) => sum + Object.values(byResort).reduce((s2, byRoomType) =>
s2 + Object.values(byRoomType).reduce((s3, byDate) => s3 + Object.keys(byDate).length, 0), 0), 0);
const countEl = document.getElementById('mvc-count');
if (countEl) countEl.textContent = totalDates ? `${totalDates} date${totalDates === 1 ? '' : 's'}` : '';
const balanceEl = document.getElementById('mvc-balance-mount');
if (balanceEl) balanceEl.innerHTML = pointsBalanceHtml(store);
fillConfigForm();
const lastImportEl = document.getElementById('mvc-last-import');
if (lastImportEl) {
lastImportEl.textContent = store.lastImport
? `Last imported ${new Date(store.lastImport.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}${store.lastImport.fileName ? ` from ${store.lastImport.fileName}` : ''}.`
: '';
}
const pivot = buildAvailabilityPivot(store, { roomTypeFilter: mvcRoomTypeFilter });
const mount = document.getElementById('mvc-pivot');
if (mount) mount.innerHTML = pivotHtml(pivot);
bindMarriottPivot(panel);
bindTripChips();
}

// Delegated, bound once per panel (guarded by a dataset flag, same shape
// as manualimport.js's el.dataset.manualChangeBound) -- re-renders
// rebuild the whole panel's innerHTML, so a per-element listener would
// stack a fresh copy on every render otherwise.
function bindMarriottPivot(panel) {
if (panel.dataset.mvcPivotBound) return;
panel.dataset.mvcPivotBound = '1';
panel.addEventListener('click', (e) => {
const cellBtn = e.target.closest('[data-mvc-cell]');
if (cellBtn) {
const key = cellBtn.dataset.mvcCell;
if (expandedMvcCells.has(key)) expandedMvcCells.delete(key); else expandedMvcCells.add(key);
renderMarriottAvailability();
return;
}
const toggleBtn = e.target.closest('[data-mvc-nights-toggle]');
if (toggleBtn) {
const nights = toggleBtn.dataset.mvcNightsToggle;
if (collapsedMvcNights.has(nights)) collapsedMvcNights.delete(nights); else collapsedMvcNights.add(nights);
renderMarriottAvailability();
return;
}
const addTripBtn = e.target.closest('[data-mvc-add-trip]');
if (addTripBtn) {
const [nights, resort, date, checkOut] = addTripBtn.dataset.mvcAddTrip.split('|');
addTripBtn.disabled = true;
createTrip({ title: `${resort} · ${nights} nights`, destinations: [resort] }).then((trip) => {
trip.startDate = date;
trip.endDate = checkOut;
queueSave();
renderMarriottAvailability();
});
return;
}
const suggestChip = e.target.closest('[data-mvc-rt-suggest]');
if (suggestChip) {
const rtOnlyRadio = document.getElementById('mvc-cfg-rt-only');
const rtInput = document.getElementById('mvc-cfg-roomtypes');
if (!rtInput || !rtOnlyRadio) return;
mvcRoomTypeOnlyMode = true;
rtOnlyRadio.checked = true;
const current = rtInput.value.split(',').map((t) => t.trim()).filter(Boolean);
if (!current.includes(suggestChip.dataset.mvcRtSuggest)) current.push(suggestChip.dataset.mvcRtSuggest);
rtInput.value = current.join(', ');
saveScanConfig({ roomTypes: current });
fillConfigForm();
}
});
panel.addEventListener('change', (e) => {
if (e.target.id === 'mvc-roomtype-filter') { mvcRoomTypeFilter = e.target.value; renderMarriottAvailability(); }
});
}

function initMarriottAvailability() {
const panel = document.getElementById('mvc-availability-panel');
if (!panel) return; // panel not in this build's DOM

const nightsInput = document.getElementById('mvc-cfg-nights');
nightsInput?.addEventListener('change', () => {
const cfg = saveScanConfig({ nightCounts: nightsInput.value.split(',').map((v) => v.trim()).filter(Boolean) });
nightsInput.value = cfg.nightCounts.join(', ');
fillConfigForm();
});
document.getElementById('mvc-cfg-guests')?.addEventListener('change', (e) => { saveScanConfig({ guests: e.target.value }); fillConfigForm(); });
document.getElementById('mvc-cfg-months')?.addEventListener('change', (e) => { saveScanConfig({ monthsToScan: e.target.value }); fillConfigForm(); });
document.getElementById('mvc-cfg-speed')?.addEventListener('change', (e) => { saveScanConfig({ speedMultiplier: e.target.value }); fillConfigForm(); });

const rtInput = document.getElementById('mvc-cfg-roomtypes');
const rtAutoRadio = document.getElementById('mvc-cfg-rt-auto');
const rtOnlyRadio = document.getElementById('mvc-cfg-rt-only');
// Only saves/re-renders when "Only these" is the ACTUAL current choice
// -- an empty text field is a legitimate mid-edit state (the radio is
// picked, nothing typed yet), not a reason to fall back to null and
// re-derive the radio as "Auto-detect" again.
const applyRoomTypeMode = () => {
const types = (rtInput?.value || '').split(',').map((t) => t.trim()).filter(Boolean);
saveScanConfig({ roomTypes: types.length ? types : null });
fillConfigForm();
};
// The real bug this fixes (confirmed live: "Only these" refused to
// stay selected) was mvcRoomTypeOnlyMode being derived from
// cfg.roomTypes on every render -- see its own comment above. The
// `if (!radio.checked) return` guard here is just cheap defensive
// insurance against either handler ever firing while its own radio
// isn't actually the checked one, not itself the fix.
rtAutoRadio?.addEventListener('change', () => { if (!rtAutoRadio.checked) return; mvcRoomTypeOnlyMode = false; saveScanConfig({ roomTypes: null }); fillConfigForm(); });
rtOnlyRadio?.addEventListener('change', () => { if (!rtOnlyRadio.checked) return; mvcRoomTypeOnlyMode = true; applyRoomTypeMode(); });
rtInput?.addEventListener('change', () => { if (mvcRoomTypeOnlyMode) applyRoomTypeMode(); });

const copyBtn = document.getElementById('mvc-copy-btn');
copyBtn?.addEventListener('click', async () => {
const status = document.getElementById('mvc-copy-status');
const { buildScanSnippet } = await import('./marriottscan.js');
const snippet = buildScanSnippet(readScanConfig());
const preview = document.getElementById('mvc-snippet-preview');
if (preview) preview.textContent = snippet;
try {
await navigator.clipboard.writeText(snippet);
copyBtn.textContent = 'Copied';
setTimeout(() => { copyBtn.textContent = 'Copy scan script'; }, 2000);
if (status) status.textContent = 'Copied — on owners.marriottvacationclub.com → Book with Points, pick your resorts and starting month, then paste into the Console (F12).';
} catch (err) {
if (status) status.textContent = 'Copy failed — open "Show the generated script" below and copy it by hand.';
}
});

const textarea = document.getElementById('mvc-import-paste');
const readBtn = document.getElementById('mvc-import-read-btn');
const fileInput = document.getElementById('mvc-import-file-input');
const status = document.getElementById('mvc-import-status');
readBtn?.addEventListener('click', () => {
const text = textarea.value.trim();
if (!text) { if (status) status.textContent = 'Paste something first.'; return; }
const result = importMarriottText(text, { source: 'paste' });
if (status) status.textContent = result.message;
if (result.ok) { textarea.value = ''; renderMarriottAvailability(); }
});
fileInput?.addEventListener('change', async () => {
const files = [...fileInput.files];
fileInput.value = '';
if (!files.length) return;
const messages = [];
for (const file of files) {
const text = await file.text();
const result = importMarriottText(text, { source: 'file', fileName: file.name });
messages.push(result.ok ? result.message : `${file.name}: ${result.message}`);
}
if (status) status.textContent = messages.join(' ');
renderMarriottAvailability();
});

document.getElementById('mvc-clear-btn')?.addEventListener('click', () => {
if (!confirm('Clear all imported Marriott availability data? This cannot be undone.')) return;
data.marriottAvailability = blankMarriottAvailability();
queueSave();
renderMarriottAvailability();
});

renderMarriottAvailability();
}

export {
renderMarriottAvailability, initMarriottAvailability, buildAvailabilityPivot,
detectMarriottImportKind, parseMarriottCsv, parseMarriottJson, mergeMarriottAvailability, importMarriottText,
readScanConfig, saveScanConfig, estimateRunSeconds,
};
