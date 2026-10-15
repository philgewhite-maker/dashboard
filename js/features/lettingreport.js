// A periodic PDF report per Airbnb listing-owner (Lewis/Zara) -- written
// FOR THEM to read, not for Phil: what Airbnb paid in, what's theirs to
// keep, what's being held for Dad, every transaction between two dates,
// and the same two charts the live dashboard shows, scoped to just their
// own listings and matching its own colours/groupings as closely as a
// static PDF reasonably can.
//
// Presentation + layout only -- every real number comes from
// letting.js's own exported aggregation (entriesFor, shareRuleAt,
// splitAmountFor, balanceFor, nightRateFor...), nothing duplicated
// here. jsPDF is loaded lazily (see utils.js's loadJsPdf, same
// cached-promise pattern loadHeicTo already uses) -- the ~450KB
// download only happens the first time a report is actually generated.
import { data } from '../state.js';
import { loadJsPdf } from '../utils.js';
import {
ownerKeyFor, ownerNameFor, entriesFor, nightRateFor, balanceFor, money, money0, monthRange, monthLabel, addMonths, today, isMyOwnListing, resolveColor, listingColorVar,
} from './letting.js';

// Reads a LOCAL-calendar date straight off the Date object's own
// getters (never .toISOString(), which converts through UTC first --
// confirmed live as a real bug: constructing "1 Sept, local midnight"
// and then calling .toISOString() on it rendered as 31 Aug the moment
// the device's own timezone (BST) sits ahead of UTC, a full day out).
function isoDate(d) {
return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Default period: the previous full calendar month -- the natural
// "here's what happened last month" cadence a periodic report implies.
function defaultPeriod() {
const now = new Date();
const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
return { start: isoDate(startOfLastMonth), end: isoDate(endOfLastMonth) };
}

// Listings belonging to this owner -- the filter every chart and the
// rate-history recap both need.
function listingsFor(key) {
return (data.airbnbListings || []).filter((l) => ownerKeyFor(l) === key);
}

const STAY_KINDS = new Set(['accrual', 'earned', 'cancellation']);

// A ledger entry's own `amount` field is ALWAYS Dad's cut -- the slice
// of a stay's gross that this owner is holding for him (kind 'accrual'/
// 'earned'/'cancellation'), or a direct movement of that same running
// balance (kind 'payment'/'adjustment'). Confirmed directly against the
// manual add-row's own placeholder text ("negative for a payment to
// you" -- "you" being Phil, the one typing it in) and against live
// feedback on this report's first draft, which had this backwards: a
// NEGATIVE payment is the owner paying DAD (reduces what's held for
// him), a POSITIVE one is the reverse -- Dad handing the owner money
// directly, which is why its own fallback note already reads "Owed
// more" rather than "Paid".
function paymentSplit(entries) {
const payments = entries.filter((e) => e.kind === 'payment');
const paidToDad = -payments.filter((e) => e.amount < 0).reduce((n, e) => n + (Number(e.amount) || 0), 0);
const receivedFromDad = payments.filter((e) => e.amount > 0).reduce((n, e) => n + (Number(e.amount) || 0), 0);
return { paidToDad, receivedFromDad };
}

function periodSummary(key, start, end) {
const entries = entriesFor(key).filter((e) => e.date && e.date >= start && e.date <= end);
const stays = entries.filter((e) => STAY_KINDS.has(e.kind));
// The WHOLE Airbnb payment for each stay -- what guests actually paid,
// before any split.
const airbnbIncome = stays.reduce((n, e) => n + (Number(e.gross) || 0), 0);
// Dad's cut of that, the same figure accrueLettings() wrote onto each
// entry's own `amount` field.
const dadsShare = stays.reduce((n, e) => n + (Number(e.amount) || 0), 0);
// What's left -- the owner's own money to keep, no further tracking
// needed on it.
const yourShare = airbnbIncome - dadsShare;
const { paidToDad, receivedFromDad } = paymentSplit(entries);
const adjustments = entries.filter((e) => e.kind === 'adjustment').reduce((n, e) => n + (Number(e.amount) || 0), 0);
// The period's own net effect on the balance held for Dad -- every
// entry dated in the period, whatever kind -- distinct from the
// all-time running total (balanceFor, below).
const netHeldFromPeriod = entries.reduce((n, e) => n + (Number(e.amount) || 0), 0);
return { entries, stays, airbnbIncome, yourShare, dadsShare, paidToDad, receivedFromDad, adjustments, netHeldFromPeriod, stayCount: stays.length };
}

// A human label for a transaction line when the entry itself has no
// `note` -- mirrors the exact fallback text the manual add-row already
// writes onto a new entry (letting.js), so a listed transaction never
// says something different from what that same row would show if you
// went and added it by hand.
function kindLabel(e) {
if (e.note) return e.note;
if (e.kind === 'earned') return 'Earned before tracking';
if (e.kind === 'cancellation') return 'Cancellation';
if (e.kind === 'payment') return Number(e.amount) < 0 ? 'Paid to Dad' : 'Received from Dad';
if (e.kind === 'adjustment') return 'Adjustment';
return e.kind || '';
}

// The bank-statement view read by the owner: a balance carried in from
// before the period (every dated entry earlier than `start`), then one
// line per transaction actually inside [start, end] -- split into the
// SAME columns the summary above totals (the whole Airbnb payment, the
// owner's own kept share, Dad's share) plus a running "held for Dad"
// balance -- not just the amount netted into that balance, so a
// payment in EITHER direction shows as its own line rather than only
// ever surfacing inside one aggregate figure.
function statementFor(key, start, end) {
const all = entriesFor(key).filter((e) => e.date).slice().sort((a, b) => a.date.localeCompare(b.date));
const openingBalance = all.filter((e) => e.date < start).reduce((n, e) => n + (Number(e.amount) || 0), 0);
let running = openingBalance;
const transactions = all.filter((e) => e.date >= start && e.date <= end).map((e) => {
const isStay = STAY_KINDS.has(e.kind);
const dadsShare = Number(e.amount) || 0;
running += dadsShare;
return {
date: e.date,
description: kindLabel(e),
kind: e.kind,
airbnbPayment: isStay ? (Number(e.gross) || 0) : null,
yourShare: isStay ? (Number(e.gross) || 0) - dadsShare : null,
dadsShare,
heldForDad: running,
};
});
const totals = transactions.reduce((t, r) => ({
airbnbPayment: t.airbnbPayment + (r.airbnbPayment || 0),
yourShare: t.yourShare + (r.yourShare || 0),
dadsShare: t.dadsShare + r.dadsShare,
}), { airbnbPayment: 0, yourShare: 0, dadsShare: 0 });
return { openingBalance, closingBalance: running, transactions, totals };
}

// Every rate rule that was EVER active during the period, across all
// of this owner's listings -- so a reader can see which arrangement
// produced which figure without cross-referencing Settings. A rule
// "overlaps" the period if it started before the period ended (its own
// end is implicitly whenever the next rule, if any, starts).
function rateHistoryForPeriod(key, start, end) {
const rows = [];
listingsFor(key).forEach((listing) => {
const rules = (listing.shareRules || []).slice().sort((a, b) => String(a.fromDate).localeCompare(String(b.fromDate)));
const withFallback = [{ fromDate: '', pct: Number(listing.sharePct) || 50, capAmount: null }, ...rules];
withFallback.forEach((rule, i) => {
const next = withFallback[i + 1];
const ruleEnd = next ? next.fromDate : null; // null = still current
if (ruleEnd && ruleEnd <= start) return; // this rule was already over before the period began
if (rule.fromDate && rule.fromDate > end) return; // this rule hadn't started by the period's end
rows.push({ listing: listing.label || 'Listing', fromDate: rule.fromDate || '(always)', toDate: ruleEnd || '(ongoing)', pct: rule.pct, capAmount: rule.capAmount });
});
});
return rows;
}

// The two colours this owner's bar segments should use -- their OWN
// listing colour, and Dad's own listing colour -- resolved the exact
// same way the live dashboard's stacked income chart resolves them
// (listingColorVar + resolveColor against the real CSS vars), so a
// report's bars read as the same two colours the dashboard already
// uses for "Mine" vs this owner's own group, not a palette invented
// just for the PDF.
function reportColours(key) {
const listings = data.airbnbListings || [];
const mineListing = listings.find((l) => isMyOwnListing(l));
const ownListing = listingsFor(key)[0];
return {
yours: resolveColor(listingColorVar((ownListing && ownListing.colour) || 'slate')),
dads: resolveColor(listingColorVar((mineListing && mineListing.colour) || 'slate')),
};
}

// Income by month, stacked -- the owner's own kept share and Dad's
// share of the SAME gross, one bar per month, same shape as the live
// dashboard's own per-owner stacked income chart (lettingChartData/
// drawLettingChart) but deliberately not a reuse of that function
// itself: it carries live, mutable, page-global selection state
// (lettingChartSelectedGroups) and hover/legend/target machinery a
// static PDF page has no use for. Pure function: canvas in, this
// owner's own monthly split out, in the dashboard's own two colours.
function drawIncomeBarChart(canvas, key, months) {
const width = canvas.width, height = canvas.height;
const ctx = canvas.getContext('2d');
ctx.clearRect(0, 0, width, height);
const colours = reportColours(key);
const entries = entriesFor(key).filter((e) => STAY_KINDS.has(e.kind) && e.date);
const byMonth = new Map();
months.forEach((ym) => byMonth.set(ym, { yours: 0, dads: 0 }));
entries.forEach((e) => {
const ym = e.date.slice(0, 7);
const bucket = byMonth.get(ym);
if (!bucket) return;
const dadsShare = Number(e.amount) || 0;
bucket.dads += dadsShare;
bucket.yours += (Number(e.gross) || 0) - dadsShare;
});
const values = months.map((ym) => byMonth.get(ym));
const max = Math.max(...values.map((v) => v.yours + v.dads), 1);
const padLeft = 50, padBottom = 32, padTop = 14, padRight = 10;
const plotW = width - padLeft - padRight, plotH = height - padTop - padBottom;
ctx.strokeStyle = '#ccc';
ctx.fillStyle = '#333';
ctx.font = '11px sans-serif';
ctx.textAlign = 'right';
ctx.textBaseline = 'middle';
[0, 0.5, 1].forEach((t) => {
const y = padTop + plotH - t * plotH;
ctx.beginPath(); ctx.moveTo(padLeft, y); ctx.lineTo(width - padRight, y); ctx.stroke();
ctx.fillText(money0(max * t), padLeft - 6, y);
});
const bw = plotW / months.length;
values.forEach((v, i) => {
const x = padLeft + i * bw + bw * 0.15, w = bw * 0.7;
const yoursH = (v.yours / max) * plotH;
const dadsH = (v.dads / max) * plotH;
ctx.fillStyle = colours.yours;
ctx.fillRect(x, padTop + plotH - yoursH, w, yoursH);
ctx.fillStyle = colours.dads;
ctx.fillRect(x, padTop + plotH - yoursH - dadsH, w, dadsH);
});
ctx.fillStyle = '#555';
ctx.textAlign = 'center';
ctx.textBaseline = 'top';
months.forEach((ym, i) => ctx.fillText(monthLabel(ym), padLeft + (i + 0.5) * bw, padTop + plotH + 6));
// Legend -- two swatches, since the two colours alone don't say which
// is which.
const legendY = height - 10;
ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.font = '10px sans-serif';
ctx.fillStyle = colours.yours; ctx.fillRect(padLeft, legendY - 4, 9, 9);
ctx.fillStyle = '#333'; ctx.fillText('Your share', padLeft + 13, legendY);
ctx.fillStyle = colours.dads; ctx.fillRect(padLeft + 90, legendY - 4, 9, 9);
ctx.fillStyle = '#333'; ctx.fillText("Dad's share", padLeft + 103, legendY);
}

// Same pattern, average night rate across this owner's own listings
// (nights-weighted, same "divide the sum of net by the sum of nights"
// arithmetic the live chart's own nightRateFor/accrual math already
// establishes) -- a line, not a bar, since a rate isn't something to
// stack, and there's no Dad/owner split to show on a RATE in the first
// place (it's the same number either way this gets sliced).
function drawRateLineChart(canvas, key, months) {
const width = canvas.width, height = canvas.height;
const ctx = canvas.getContext('2d');
ctx.clearRect(0, 0, width, height);
const listingIds = new Set(listingsFor(key).map((l) => l.id));
const entries = (data.lettingLedger || []).filter((e) => listingIds.has(e.listingId));
const byMonth = new Map();
months.forEach((ym) => byMonth.set(ym, { net: 0, nights: 0 }));
entries.forEach((e) => {
const rate = nightRateFor(e);
if (rate == null || !e.date) return;
const ym = e.date.slice(0, 7);
const bucket = byMonth.get(ym);
if (!bucket) return;
bucket.net += rate * (e.nights || 0);
bucket.nights += e.nights || 0;
});
const values = months.map((ym) => { const b = byMonth.get(ym); return b.nights > 0 ? b.net / b.nights : null; });
const real = values.filter((v) => v != null);
const max = Math.max(...real, 1);
const padLeft = 50, padBottom = 24, padTop = 14, padRight = 10;
const plotW = width - padLeft - padRight, plotH = height - padTop - padBottom;
ctx.strokeStyle = '#ccc';
ctx.fillStyle = '#333';
ctx.font = '11px sans-serif';
ctx.textAlign = 'right';
ctx.textBaseline = 'middle';
[0, 0.5, 1].forEach((t) => {
const y = padTop + plotH - t * plotH;
ctx.beginPath(); ctx.moveTo(padLeft, y); ctx.lineTo(width - padRight, y); ctx.stroke();
ctx.fillText(money0(max * t), padLeft - 6, y);
});
const bw = plotW / months.length;
const scaleY = (v) => padTop + plotH - (v / max) * plotH;
ctx.strokeStyle = '#a6442e';
ctx.lineWidth = 2;
ctx.beginPath();
let drawing = false;
values.forEach((v, i) => {
if (v == null) { drawing = false; return; }
const x = padLeft + (i + 0.5) * bw, y = scaleY(v);
if (!drawing) { ctx.moveTo(x, y); drawing = true; } else { ctx.lineTo(x, y); }
});
ctx.stroke();
ctx.fillStyle = '#a6442e';
values.forEach((v, i) => {
if (v == null) return;
ctx.beginPath(); ctx.arc(padLeft + (i + 0.5) * bw, scaleY(v), 3, 0, Math.PI * 2); ctx.fill();
});
ctx.fillStyle = '#555';
ctx.textAlign = 'center';
ctx.textBaseline = 'top';
months.forEach((ym, i) => ctx.fillText(monthLabel(ym), padLeft + (i + 0.5) * bw, padTop + plotH + 6));
}

// The full PDF, built page-by-page with jsPDF's own text/line/image
// primitives rather than a print-stylesheet screenshot -- keeps real
// control over pagination and file size instead of rasterising an
// entire HTML page. Addressed to the owner throughout ("you" = them,
// "Dad" = Phil) -- this document is theirs to read, not a copy of
// Phil's own dashboard view of the same numbers.
async function buildReportPdf(key, { start, end } = defaultPeriod()) {
const { jsPDF } = await loadJsPdf();
const doc = new jsPDF({ unit: 'pt', format: 'a4' });
const pageW = doc.internal.pageSize.getWidth();
const pageH = doc.internal.pageSize.getHeight();
const bottom = pageH - 40;
let y = 48;
const left = 48;
const name = ownerNameFor(key);

// Starts a fresh page and resets y whenever the next chunk (height
// `needed`) wouldn't fit above `bottom` -- the transaction table is
// unbounded in length (a whole period's worth of stays/payments), so
// this is the one thing in the file that can't assume everything fits
// on page one the way the fixed-size summary/chart sections do.
const ensureSpace = (needed) => {
if (y + needed > bottom) { doc.addPage(); y = 48; }
};

doc.setFont('helvetica', 'bold'); doc.setFontSize(18);
doc.text(`${name} — letting report`, left, y); y += 20;
doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(100);
doc.text(`Period: ${start} to ${end}   ·   Generated ${today()}`, left, y); y += 24;
doc.setTextColor(0);

const summary = periodSummary(key, start, end);
const statement = statementFor(key, start, end);
const heldNow = balanceFor(key);
doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
doc.text('Summary', left, y); y += 16;
doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
const lines = [
[`Airbnb income (${summary.stayCount} stay${summary.stayCount === 1 ? '' : 's'})`, money(summary.airbnbIncome)],
['Your share (kept)', money(summary.yourShare)],
["Dad's share (this period)", money(summary.dadsShare)],
...(summary.paidToDad ? [['Paid to Dad this period', money(summary.paidToDad)]] : []),
...(summary.receivedFromDad ? [['Received from Dad this period', money(summary.receivedFromDad)]] : []),
...(summary.adjustments ? [['Adjustments this period', money(summary.adjustments)]] : []),
['Held for Dad — from this period', money(summary.netHeldFromPeriod)],
['Held for Dad — total today', money(heldNow)],
];
lines.forEach(([label, value]) => {
doc.text(label, left, y);
doc.text(value, left + 280, y, { align: 'left' });
y += 15;
});
y += 10;

const rateRows = rateHistoryForPeriod(key, start, end);
if (rateRows.length) {
doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
doc.text('Rate history during this period', left, y); y += 16;
doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
rateRows.forEach((r) => {
const capText = r.capAmount != null ? `, cap ${money(r.capAmount)}` : '';
doc.text(`${r.listing}: ${r.pct}% to Dad${capText} — ${r.fromDate} to ${r.toDate}`, left, y);
y += 13;
});
y += 10;
}

// Statement -- opening balance, every transaction between the two
// dates (stays, payments in both directions, adjustments, cancellations),
// closing balance. Bank-statement shape, one column per figure the
// summary above already totals: date / description / the whole Airbnb
// payment / your own share / Dad's share / running balance held for him.
const col = { date: left, desc: left + 54, airbnb: left + 190, yours: left + 260, dads: left + 330, held: left + 400 };
const printTableHeader = () => {
doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(100);
doc.text('Date', col.date, y);
doc.text('Description', col.desc, y);
doc.text('Airbnb', col.airbnb, y);
doc.text('Your share', col.yours, y);
doc.text("Dad's share", col.dads, y);
doc.text('Held for Dad', col.held, y);
y += 4;
doc.setDrawColor(200);
doc.line(left, y, pageW - left, y);
y += 11;
doc.setTextColor(0);
};
ensureSpace(60);
doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
doc.text('Statement', left, y); y += 16;
doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(100);
doc.text(`Held for Dad, carried in from before ${start}`, left, y);
doc.text(money(statement.openingBalance), col.held, y);
y += 16;
doc.setTextColor(0);
printTableHeader();
doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
if (!statement.transactions.length) {
doc.setTextColor(140);
doc.text('No transactions in this period.', col.date, y);
y += 13;
doc.setTextColor(0);
} else {
statement.transactions.forEach((t) => {
const before = y;
ensureSpace(13);
if (y !== before) { doc.setFont('helvetica', 'normal'); doc.setFontSize(8); printTableHeader(); }
doc.text(t.date, col.date, y);
doc.text(t.description, col.desc, y, { maxWidth: col.airbnb - col.desc - 8 });
if (t.airbnbPayment != null) doc.text(money(t.airbnbPayment), col.airbnb, y);
if (t.yourShare != null) doc.text(money(t.yourShare), col.yours, y);
doc.text(money(t.dadsShare), col.dads, y);
doc.text(money(t.heldForDad), col.held, y);
y += 12;
});
}
y += 3;
doc.setDrawColor(200);
ensureSpace(50);
doc.line(left, y, pageW - left, y);
y += 12;
doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
doc.text('Total this period', col.desc, y);
doc.text(money(statement.totals.airbnbPayment), col.airbnb, y);
doc.text(money(statement.totals.yourShare), col.yours, y);
doc.text(money(statement.totals.dadsShare), col.dads, y);
y += 16;
doc.setFontSize(10);
doc.text(`Held for Dad, as at ${end}`, left, y);
doc.text(money(statement.closingBalance), col.held, y);
y += 24;

// Charts -- 6 months back from the period's own end, same "a few
// months of context either side" shape the live charts default to,
// scaled down to fit on the page, in the dashboard's own colours.
const months = monthRange(addMonths(end.slice(0, 7), -5), end.slice(0, 7));
const chartW = 500, chartH = 230;
const chartImgH = (pageW - left * 2) * (chartH / chartW);
ensureSpace(chartImgH + 30);
const canvas1 = document.createElement('canvas');
canvas1.width = chartW; canvas1.height = chartH;
drawIncomeBarChart(canvas1, key, months);
doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
doc.text('Income by month', left, y); y += 10;
doc.addImage(canvas1.toDataURL('image/png'), 'PNG', left, y, (pageW - left * 2), chartImgH);
y += chartImgH + 20;

ensureSpace(chartImgH + 30 - 10);
const canvas2 = document.createElement('canvas');
canvas2.width = chartW; canvas2.height = chartH;
drawRateLineChart(canvas2, key, months);
doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
doc.text('Average night rate', left, y); y += 10;
doc.addImage(canvas2.toDataURL('image/png'), 'PNG', left, y, (pageW - left * 2), (pageW - left * 2) * (chartH / chartW));

return doc.output('blob');
}

// Triggers the Blob's own download via a synthetic <a download> -- the
// same pattern travel.js's itinerary export and state.js's backup
// export already use, nothing new invented here.
function downloadBlob(blob, filename) {
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url; a.download = filename;
document.body.appendChild(a);
a.click();
a.remove();
setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function reportFilename(key, start) {
const name = (ownerNameFor(key) || 'owner').toLowerCase().replace(/[^a-z0-9]+/g, '-');
return `letting-report-${name}-${start.slice(0, 7)}.pdf`;
}

// mailto: can't attach a file -- no browser supports that -- so this
// opens a pre-filled draft alongside the PDF's own download, same
// click. The one remaining step (attaching the file that just
// downloaded) is real and manual; the UI that calls this says so.
function openEmailDraft(key, start, end) {
const subject = encodeURIComponent(`Letting report — ${ownerNameFor(key)} — ${start} to ${end}`);
const body = encodeURIComponent(`Hi ${ownerNameFor(key)},\n\nAttached is your letting report for ${start} to ${end}.\n\n(Don't forget to attach the PDF that just downloaded.)`);
window.open(`mailto:?subject=${subject}&body=${body}`, '_blank');
}

export { buildReportPdf, downloadBlob, reportFilename, openEmailDraft, defaultPeriod, periodSummary, statementFor, isoDate };
