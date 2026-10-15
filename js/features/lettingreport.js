// A periodic PDF report per Airbnb listing-owner (Lewis/Zara) --
// what came in, what's been paid, what's still owed in total and from
// the period, the rate-history rules that applied, and the two
// listing charts filtered to just THEIR listings. Asked for directly:
// "what income came in, payments already made, and what they still
// owe in total and from the period... include the charts, filtered
// for them."
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
ownerKeyFor, ownerNameFor, entriesFor, nightRateFor, balanceFor, money, money0, monthRange, monthLabel, addMonths, today, shareRuleAt,
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

// A payment's sign says which way the money moved (see the manual
// add-row's own placeholder text: "negative for a payment to you") --
// split into the two directions here rather than netted into one
// figure, since "paid to owner" and "paid to me" are different things
// a reader needs to see separately, not infer from a single number's
// sign.
function paymentSplit(entries) {
const payments = entries.filter((e) => e.kind === 'payment');
const paidToOwner = -payments.filter((e) => e.amount < 0).reduce((n, e) => n + (Number(e.amount) || 0), 0);
const paidToMe = payments.filter((e) => e.amount > 0).reduce((n, e) => n + (Number(e.amount) || 0), 0);
return { paidToOwner, paidToMe };
}

function periodSummary(key, start, end) {
const entries = entriesFor(key).filter((e) => e.date && e.date >= start && e.date <= end);
const stays = entries.filter((e) => STAY_KINDS.has(e.kind));
const grossIncome = stays.reduce((n, e) => n + (Number(e.gross) || 0), 0);
const shareEarned = stays.reduce((n, e) => n + (Number(e.amount) || 0), 0);
const { paidToOwner, paidToMe } = paymentSplit(entries);
const adjustments = entries.filter((e) => e.kind === 'adjustment').reduce((n, e) => n + (Number(e.amount) || 0), 0);
// The period's own net effect on the balance -- every entry dated in
// the period, whatever kind -- answers "owed FROM the period" directly,
// distinct from the all-time running total (balanceFor, below).
const netFromPeriod = entries.reduce((n, e) => n + (Number(e.amount) || 0), 0);
return { entries, stays, grossIncome, shareEarned, paidToOwner, paidToMe, adjustments, netFromPeriod, stayCount: stays.length };
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
if (e.kind === 'payment') return Number(e.amount) < 0 ? 'Paid' : 'Owed more';
if (e.kind === 'adjustment') return 'Adjustment';
return e.kind || '';
}

// The bank-statement view: a balance carried in from before the period
// (every dated entry earlier than `start`), then one line per
// transaction actually inside [start, end] with a running balance after
// each -- including payment entries in BOTH directions, not just the
// "paid to owner" one periodSummary's own aggregate singles out.
function statementFor(key, start, end) {
const all = entriesFor(key).filter((e) => e.date).slice().sort((a, b) => a.date.localeCompare(b.date));
const openingBalance = all.filter((e) => e.date < start).reduce((n, e) => n + (Number(e.amount) || 0), 0);
let running = openingBalance;
const transactions = all.filter((e) => e.date >= start && e.date <= end).map((e) => {
running += Number(e.amount) || 0;
return { date: e.date, description: kindLabel(e), kind: e.kind, amount: Number(e.amount) || 0, balance: running };
});
return { openingBalance, closingBalance: running, transactions };
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

// A simple, self-contained bar chart -- income by month, this owner's
// share only. Deliberately NOT a reuse of letting.js's own interactive
// drawLettingChart: that one carries live, mutable, page-global
// selection state (lettingChartSelectedGroups) this report must never
// touch or be affected by, and has hover/legend machinery a static PDF
// page has no use for. Pure function: canvas in, this owner's own
// monthly totals out.
function drawIncomeBarChart(canvas, key, months) {
const width = canvas.width, height = canvas.height;
const ctx = canvas.getContext('2d');
ctx.clearRect(0, 0, width, height);
const entries = entriesFor(key).filter((e) => STAY_KINDS.has(e.kind) && e.date);
const byMonth = new Map();
months.forEach((ym) => byMonth.set(ym, 0));
entries.forEach((e) => {
const ym = e.date.slice(0, 7);
if (byMonth.has(ym)) byMonth.set(ym, byMonth.get(ym) + (Number(e.amount) || 0));
});
const values = months.map((ym) => byMonth.get(ym) || 0);
const max = Math.max(...values, 1);
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
ctx.fillStyle = '#2a6f6f';
values.forEach((v, i) => {
const h = (v / max) * plotH;
ctx.fillRect(padLeft + i * bw + bw * 0.15, padTop + plotH - h, bw * 0.7, h);
});
ctx.fillStyle = '#555';
ctx.textAlign = 'center';
ctx.textBaseline = 'top';
months.forEach((ym, i) => ctx.fillText(monthLabel(ym), padLeft + (i + 0.5) * bw, padTop + plotH + 6));
}

// Same pattern, average night rate across this owner's own listings
// (nights-weighted, same "divide the sum of net by the sum of nights"
// arithmetic the live chart's own nightRateFor/accrual math already
// establishes) -- a line, not a bar, since a rate isn't something to
// stack.
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
// entire HTML page.
async function buildReportPdf(key, { start, end } = defaultPeriod()) {
const { jsPDF } = await loadJsPdf();
const doc = new jsPDF({ unit: 'pt', format: 'a4' });
const pageW = doc.internal.pageSize.getWidth();
const pageH = doc.internal.pageSize.getHeight();
const bottom = pageH - 40;
let y = 48;
const left = 48;

// Starts a fresh page and resets y whenever the next chunk (height
// `needed`) wouldn't fit above `bottom` -- the transaction table is
// unbounded in length (a whole period's worth of stays/payments), so
// this is the one thing in the file that can't assume everything fits
// on page one the way the fixed-size summary/chart sections do.
const ensureSpace = (needed) => {
if (y + needed > bottom) { doc.addPage(); y = 48; }
};

doc.setFont('helvetica', 'bold'); doc.setFontSize(18);
doc.text(`${ownerNameFor(key)} — letting report`, left, y); y += 20;
doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(100);
doc.text(`Period: ${start} to ${end}   ·   Generated ${today()}`, left, y); y += 24;
doc.setTextColor(0);

const summary = periodSummary(key, start, end);
const statement = statementFor(key, start, end);
const owedNow = balanceFor(key);
doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
doc.text('Summary', left, y); y += 16;
doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
const lines = [
[`Gross income (${summary.stayCount} stay${summary.stayCount === 1 ? '' : 's'})`, money(summary.grossIncome)],
['Your share earned this period', money(summary.shareEarned)],
['Paid to ' + ownerNameFor(key) + ' this period', money(summary.paidToOwner)],
...(summary.paidToMe ? [['Paid to you this period', money(summary.paidToMe)]] : []),
...(summary.adjustments ? [['Adjustments this period', money(summary.adjustments)]] : []),
['Owed from this period', money(summary.netFromPeriod)],
['Owed in total (today)', money(owedNow)],
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
doc.text(`${r.listing}: ${r.pct}%${capText} — ${r.fromDate} to ${r.toDate}`, left, y);
y += 13;
});
y += 10;
}

// Statement -- opening balance, every transaction between the two
// dates (stays, payments in both directions, adjustments, cancellations),
// closing balance. Bank-statement shape: date / description / amount /
// running balance.
const col = { date: left, desc: left + 60, amount: left + 330, balance: left + 400 };
const printTableHeader = () => {
doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(100);
doc.text('Date', col.date, y);
doc.text('Description', col.desc, y);
doc.text('Amount', col.amount, y);
doc.text('Balance', col.balance, y);
y += 4;
doc.setDrawColor(200);
doc.line(left, y, pageW - left, y);
y += 12;
doc.setTextColor(0);
};
ensureSpace(60);
doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
doc.text('Statement', left, y); y += 16;
doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(100);
doc.text(`Opening balance (owed by ${ownerNameFor(key)} before ${start})`, left, y);
doc.text(money(statement.openingBalance), col.balance, y);
y += 16;
doc.setTextColor(0);
printTableHeader();
doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
if (!statement.transactions.length) {
doc.setTextColor(140);
doc.text('No transactions in this period.', col.date, y);
y += 13;
doc.setTextColor(0);
} else {
statement.transactions.forEach((t) => {
const before = y;
ensureSpace(13);
if (y !== before) { doc.setFont('helvetica', 'normal'); doc.setFontSize(9); printTableHeader(); }
doc.text(t.date, col.date, y);
doc.text(t.description, col.desc, y, { maxWidth: col.amount - col.desc - 10 });
doc.text(money(t.amount), col.amount, y);
doc.text(money(t.balance), col.balance, y);
y += 13;
});
}
y += 4;
doc.setDrawColor(200);
ensureSpace(38);
doc.line(left, y, pageW - left, y);
y += 14;
doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
doc.text(`Closing balance (owed by ${ownerNameFor(key)} at ${end})`, left, y);
doc.text(money(statement.closingBalance), col.balance, y);
y += 24;

// Charts -- 6 months back from the period's own end, same "a few
// months of context either side" shape the live charts default to,
// scaled down to fit two side by side on the page.
const months = monthRange(addMonths(end.slice(0, 7), -5), end.slice(0, 7));
const chartW = 500, chartH = 220;
const chartImgH = (pageW - left * 2) * (chartH / chartW);
ensureSpace(chartImgH + 30);
const canvas1 = document.createElement('canvas');
canvas1.width = chartW; canvas1.height = chartH;
drawIncomeBarChart(canvas1, key, months);
doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
doc.text('Income by month (your share)', left, y); y += 10;
doc.addImage(canvas1.toDataURL('image/png'), 'PNG', left, y, (pageW - left * 2), chartImgH);
y += chartImgH + 20;

ensureSpace(chartImgH + 30);
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
const body = encodeURIComponent(`Hi ${ownerNameFor(key)},\n\nAttached is the letting report for ${start} to ${end}.\n\n(Don't forget to attach the PDF that just downloaded.)`);
window.open(`mailto:?subject=${subject}&body=${body}`, '_blank');
}

export { buildReportPdf, downloadBlob, reportFilename, openEmailDraft, defaultPeriod, periodSummary, statementFor, isoDate };
