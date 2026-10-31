// Agent Provocateur order capture -- a solid map for returns-by-
// elimination. Roughly monthly, a large AP order arrives and almost
// all of it gets returned, with only a handful of pieces kept. The
// existing inventory.orderNumber field already encodes "an item only
// ever gets added there if it's being kept" -- what was missing was
// the REAL order itself as its own record, so a kept item can be
// matched to an exact order line (by id) rather than by re-comparing
// name/colour/size text, which AP's own data is known to mismatch on
// between the order email, the returns portal and what actually
// arrived.
//
// The order-confirmation email is a rigid, repeating template (not
// freeform prose), so this is a deterministic regex parser, not an AI
// call -- verified directly against the REAL fetched HTML of order
// #5000289577 (not a pasted/pretty-printed copy) before writing the
// regex below. Two load-bearing facts that shaped it, confirmed from
// that real body:
//   - "Colour:" and its value sit on two separate physical lines in
//     the source (a literal newline baked into the sender's own
//     template, same class of trap as the Quidco "tracked" bug), but
//     "Size:"/"Bra size:" and ITS value are on the same line. Every
//     gap here is `\s+`-tolerant, never a fixed newline count.
//   - Between one product row's price and the next row's name there is
//     nothing but whitespace (tags only, no other text), and that
//     whitespace run can be 100+ characters long (deep table nesting,
//     pretty-printed with heavy indentation) -- the lookback/lookahead
//     windows below are sized generously for that, confirmed against
//     the real document rather than guessed.
import { data, queueSave, blankApOrder } from '../state.js';
import { escapeHtml, uid, daysSince, daysUntil, dateStrAdd, scrollAndFlash } from '../utils.js';
import { fetchMailSearches, getMessageDetail, gmailLink } from '../googlemail.js';
import { captureTask, toggleTaskDone } from './tasks.js';

const SENDER = 'clientservices@agentprovocateur.com';
const CADENCE_DAYS = 28;
const RETURN_WINDOW_DAYS = 28;
const ORDER_NUMBER_RE = /Order number:\s*#(\d+)/i;
const SHIPPED_SUBJECT_RE = /has been shipped/i;

// The real deadline basis -- AP's own 28-day return window runs from
// DISPATCH, not from placing the order (confirmed against the real
// "has been shipped" email: it carries no dispatch-date field at all
// in its body, only a repeated "Order placed" and a tracking number --
// so that email's own header Date is the dispatch-date proxy, same
// dateFromHeader() fallback loyaltybalances.js already relies on when
// a body has nothing better). Falls back to the order date when the
// shipped email hasn't been found yet.
function returnDeadlineFor(order) {
const base = order.shippedAt || order.orderDate;
return base ? dateStrAdd(base, RETURN_WINDOW_DAYS) : '';
}
function dateFromHeader(dateHeader) {
const d = new Date(dateHeader);
return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

// Real example confirmed live (Gmail connector, order #5000289577):
// "Order number:</b></td><td> #5000289577</td>" and "Order placed:
// </b></td><td>04/10/2026</td>" -- both label/value pairs collapse to
// "Order number:\s*#5000289577" / "Order placed:\s*04/10/2026" once
// stripped to text, same `\s*`-bridges-tag-boundary idiom every other
// extractor in this app already relies on. DD/MM/YYYY, confirmed from
// the same real email (04/10/2026 = 4 October 2026, not 10 April).
// Each line's own product image -- pulled from the HTML part (the text
// part has no src attributes at all, images carry no text). Confirmed
// live: the returns portal's own "Product code" column (e.g.
// "108752-10", "APM0525671691-36B") is exactly `<SKU>-<size>`, where
// <SKU> is the leading token of the image filename itself
// (".../108752_flatshot_front_copy.png", ".../APM0525001691_flatshot_
// front.png") -- and critically, AP gives a DIFFERENT base SKU per
// colourway of the same style (the Pink Kay Plunge Bra was
// APM0525671691, the Black one APM0525001691), so this is a genuine
// per-colour identifier, not just a size suffix on one shared code.
// Capturing it here is what lets a kept-item link (and any script
// built from it) match the real portal by its own exact code instead
// of re-comparing colour text, which AP's own data doesn't guarantee
// renders identically in the order email and the returns portal.
function productImagesFromHtml(html) {
const text = String(html || '');
const urls = [...text.matchAll(/<img[^>]+src="(https:\/\/[^"]*\/catalog\/product\/[^"]+)"/gi)].map((m) => m[1]);
return urls.map((url) => {
const file = url.split('/').pop() || '';
const skuMatch = file.match(/^([A-Za-z0-9]+)_/);
return { imageUrl: url, code: skuMatch ? skuMatch[1] : '' };
});
}

// The product rows of an AP order or refund email -- the same rigid template in both.
function extractLines(text) {
const lines = [];
for (const cm of text.matchAll(/Colour:/gi)) {
const cStart = cm.index;
// The product name sits on the line immediately before "Colour:",
// but the real gap between them can run 200+ characters of pure
// whitespace (confirmed against the real document) -- 800 chars
// back is generous headroom, not a guess.
const before = text.slice(Math.max(0, cStart - 800), cStart);
const nameMatch = before.match(/([A-Za-z][^\n]*?)\s*\n+\s*$/);
if (!nameMatch) continue; // no name immediately before this "Colour:" -- skip rather than guess
// Colour's own value, then "(Bra )?Size:" and ITS value (same line),
// then a bare qty integer, then the price -- same generous headroom
// forward as the name lookback, for the same confirmed reason.
const after = text.slice(cStart, cStart + 2000);
const m = after.match(/Colour:\s*\n*\s*([^\n]+?)\s*\n+\s*(?:Bra\s+)?[Ss]ize:\s*([^\n]+?)\s*\n+\s*\d+\s*\n+\s*£([\d.,]+)/);
if (!m) continue; // a row that doesn't fit the template -- counted as unmatched, never guessed
lines.push({ id: uid(), name: nameMatch[1].trim(), colour: m[1].trim(), size: m[2].trim(), price: Number(m[3].replace(/,/g, '')), code: '', imageUrl: '' });
}
return lines;
}

// The totals block at the foot of an order email.
function parseOrderTotals(text) {
const num = (re) => { const m = text.match(re); return m ? Number(m[1].replace(/,/g, '')) : null; };
return {
subtotal: num(/Subtotal\s*\|?\s*£\s*([\d,]+(?:\.\d+)?)/i),
discount: num(/Discount\s*\|?\s*-\s*£\s*([\d,]+(?:\.\d+)?)/i),
delivery: num(/Delivery\s*\|?\s*£\s*([\d,]+(?:\.\d+)?)/i),
total: num(/\bTOTAL\s*\|?\s*£\s*([\d,]+(?:\.\d+)?)/),
};
}

// "We have processed your refund request": the returned lines, then a refund block
// ("Discount amount -£955.50 / Delivery refunded £0.00 / Giftcard refunded / Value
// refunded £2,889.50"). Real example: order #5000289044, 28 Oct 2026.
function parseApRefundEmail(bodyText) {
const text = String(bodyText || '');
const orderNumberMatch = text.match(/Order number:\s*\|?\s*#(\d+)/i);
if (!orderNumberMatch || !/Value refunded/i.test(text)) return null;
const num = (re) => { const m = text.match(re); return m ? Number(m[1].replace(/,/g, '')) : null; };
const lines = extractLines(text).map(({ name, colour, size, price }) => ({ name, colour, size, price }));
if (!lines.length) return null;
return {
orderNumber: orderNumberMatch[1], lines,
discount: num(/Discount amount\s*\|?\s*-?\s*£\s*([\d,]+(?:\.\d+)?)/i) || 0,
deliveryRefunded: num(/Delivery refunded\s*\|?\s*£\s*([\d,]+(?:\.\d+)?)/i) || 0,
giftcardRefunded: num(/Giftcard refunded\s*\|?\s*£\s*([\d,]+(?:\.\d+)?)/i) || 0,
valueRefunded: num(/Value refunded\s*\|?\s*£\s*([\d,]+(?:\.\d+)?)/i),
};
}

function parseApOrderEmail(bodyText, bodyHtml) {
const text = String(bodyText || '');
const orderNumberMatch = text.match(/Order number:\s*#(\d+)/i);
const dateMatch = text.match(/Order placed:\s*(\d{2})\/(\d{2})\/(\d{4})/i);
if (!orderNumberMatch || !dateMatch) return null;
const orderNumber = orderNumberMatch[1];
const orderDate = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;

const lines = extractLines(text);
if (!lines.length) return null;
// Images are only ever zipped in by POSITION, and only when the count
// matches the parsed line count exactly -- a mismatch means something
// about the HTML structure didn't match this run's assumptions, and
// guessing a wrong pairing (the wrong photo/code on a line) is worse
// than just leaving code/imageUrl blank, which the rest of this file
// already treats as "not available" everywhere it's used.
const images = productImagesFromHtml(bodyHtml);
if (images.length === lines.length) {
lines.forEach((line, i) => { line.code = images[i].code; line.imageUrl = images[i].imageUrl; });
}
return { orderNumber, orderDate, lines, ...parseOrderTotals(text) };
}

function isDue(force) {
if (force) return true;
if (!data.apOrdersLastCheckedAt) return true;
return daysSince(data.apOrdersLastCheckedAt) >= CADENCE_DAYS;
}

// A real task due on the return deadline -- confirmed as a genuine
// need, not a nicety: AP returns are time-boxed and otherwise have no
// presence anywhere the user actually looks (Tasks/Planner). `source`
// links back to the real order-confirmation (or shipped) email via
// the established {kind:'mail', label, url} convention every other
// mail-derived task already uses -- gmailLink() needs no real
// headers/threadId today (it only uses the message id), confirmed
// from its own source.
function createReturnTask(order) {
const deadline = returnDeadlineFor(order);
if (!deadline) return '';
const task = captureTask({
title: `Return non-kept items from AP order #${order.orderNumber}`,
due: deadline,
bucket: 'next',
source: { kind: 'mail', label: `AP order #${order.orderNumber}`, url: gmailLink(null, null, order.sourceMessageId) },
});
return task.id;
}

// One real order: search, fetch any new messages, parse, store.
// Dedup is by sourceMessageId directly against data.apOrders (no
// separate seenMessageIds set needed, unlike loyaltybalances.js's
// multi-program engine -- there's only ever one "program" here).
// Never throws -- a single bad message is skipped, not fatal to the
// rest of the scan.
async function runApOrderCapture({ force } = {}) {
if (!isDue(force)) return { skipped: true };
const query = `from:(${SENDER}) subject:"Your Agent Provocateur order"`;
let messages = [];
try {
const [section] = await fetchMailSearches([{ kind: 'query', value: query, maxDays: 400, maxEvents: 40 }]);
messages = section?.messages || [];
} catch (err) {
return { error: err.message };
}
let added = 0, unmatched = 0, alreadySeen = 0, deadlinesSharpened = 0;
for (const msg of messages) {
if (data.apOrders.some((o) => o.sourceMessageId === msg.id)) { alreadySeen++; continue; }
let detail;
try { detail = await getMessageDetail(msg.id); } catch (err) { continue; } // transient fetch failure -- try again next scan
const bodyText = detail.bodyText || '';

const parsed = parseApOrderEmail(bodyText, detail.bodyHtml);
if (parsed) {
if (data.apOrders.some((o) => o.orderNumber === parsed.orderNumber)) { alreadySeen++; continue; }
const order = blankApOrder({ ...parsed, sourceMessageId: msg.id });
data.apOrders.push(order);
order.taskId = createReturnTask(order);
added++;
continue;
}

// The "has been shipped" follow-up email matches this same search
// (same sender, overlapping subject) but has no item table at all,
// so parseApOrderEmail correctly returns null for it. It carries no
// dispatch-DATE field in its own body either (confirmed against the
// real email -- only a repeated "Order placed" and a tracking
// number), so this email's own header Date is the real signal here,
// matched back to an already-captured order purely by order number.
const numberMatch = ORDER_NUMBER_RE.exec(bodyText);
const isShipped = SHIPPED_SUBJECT_RE.test(String(detail.subject || '')) && numberMatch;
if (!isShipped) { unmatched++; continue; }
const order = data.apOrders.find((o) => o.orderNumber === numberMatch[1]);
if (!order || order.shippedAt) { unmatched++; continue; } // no matching order yet, or already sharpened once
const shippedAt = dateFromHeader(detail.date);
if (!shippedAt) { unmatched++; continue; }
order.shippedAt = shippedAt;
const task = order.taskId ? data.tasks.find((t) => t.id === order.taskId) : null;
if (task) task.due = returnDeadlineFor(order);
else order.taskId = createReturnTask(order);
deadlinesSharpened++;
}
data.apOrdersLastCheckedAt = new Date().toISOString();
queueSave();
renderApOrders();
return { added, unmatched, alreadySeen, deadlinesSharpened };
}

// Suggests from captured orders -- same "known-set field gets a
// datalist, never bare free text" convention as vouchers.js's own
// provider datalist. The order number still types freely (an order
// not captured yet, or never will be), this just saves retyping one
// that's already on file.
function apOrderNumberDatalistHtml(id) {
const options = data.apOrders
.map((o) => `<option value="${escapeHtml(o.orderNumber)}">placed ${escapeHtml(o.orderDate)}, ${o.lines.length} item${o.lines.length === 1 ? '' : 's'}</option>`)
.join('');
return `<datalist id="${escapeHtml(id)}">${options}</datalist>`;
}

function orderForNumber(orderNumber) {
const n = String(orderNumber || '').trim();
if (!n) return null;
return data.apOrders.find((o) => o.orderNumber === n) || null;
}

// Shared between the "Add to inventory" dialog and each inventory
// row's own picker (shopping.js) -- one place builds the option list,
// so both pickers always offer the same real order lines.
//
// Always alphabetical (an order's own 78 lines arrive in whatever
// order the email template printed them, not a useful browsing order).
// `hint` -- the inventory row's own typed style ("Range", e.g. "Kay")
// and size -- narrows the list when it's given: lines whose name
// contains the typed style are shown first, and among those, lines
// matching the typed size take priority too. A hint that matches
// nothing is simply ignored (never narrows to an empty, useless
// dropdown) -- this is a convenience ordering, never a hard filter,
// since AP's own name/colour/size text is known to not always match
// what's typed on the inventory side, and hiding the right line
// because of that mismatch would be worse than a longer list.
function apOrderLineOptionsHtml(order, selectedId = '', hint = {}) {
const sorted = [...order.lines].sort((a, b) =>
a.name.localeCompare(b.name) || a.colour.localeCompare(b.colour) || a.size.localeCompare(b.size)
);
const style = (hint.style || '').trim().toLowerCase();
const size = (hint.size || '').trim().toLowerCase();
let ranked = sorted;
if (style) {
const styleMatches = sorted.filter((l) => l.name.toLowerCase().includes(style));
if (styleMatches.length) {
const styleMatchIds = new Set(styleMatches.map((l) => l.id));
const rest = sorted.filter((l) => !styleMatchIds.has(l.id));
let within = styleMatches;
if (size) {
const sizeMatches = styleMatches.filter((l) => l.size.toLowerCase() === size);
if (sizeMatches.length) {
const sizeMatchIds = new Set(sizeMatches.map((l) => l.id));
within = [...sizeMatches, ...styleMatches.filter((l) => !sizeMatchIds.has(l.id))];
}
}
ranked = [...within, ...rest];
}
}
const opts = ['<option value="">Link to an order line&hellip;</option>'];
ranked.forEach((l) => {
opts.push(`<option value="${escapeHtml(l.id)}"${l.id === selectedId ? ' selected' : ''}>${escapeHtml(l.name)} &mdash; ${escapeHtml(l.colour)}${l.size ? ` &mdash; ${escapeHtml(l.size)}` : ''} &mdash; £${l.price.toFixed(2)}</option>`);
});
return opts.join('');
}

// Every kept line paired with the real inventory item that claims it,
// not just the line itself -- the point is being able to look at the
// ACTUAL kept row (brand/style/colour/size as typed, its own photo if
// it has one) next to the order's own line and visually confirm
// they're really the same physical item, given AP's own data is known
// to mismatch between the email, the portal and reality.
function keptLinesFor(order) {
return data.inventory
.filter((i) => i.apOrderLineId && order.lines.some((l) => l.id === i.apOrderLineId))
.map((item) => ({ item, line: order.lines.find((l) => l.id === item.apOrderLineId) }));
}
function returningLinesFor(order) {
const keptLineIds = new Set(keptLinesFor(order).map((k) => k.line.id));
return order.lines.filter((l) => !keptLineIds.has(l.id));
}

// What AP should refund for an order: the item prices on the order email for every
// line that is going back. The email carries no delivery charge or discount-code
// line, so this is the items-only figure -- a code applied at checkout means the
// real refund can be lower, which the tooltip says.
function expectedRefundFor(order) {
return returningLinesFor(order).reduce((sum, l) => sum + (Number(l.price) || 0), 0);
}
const REFUND_NOTE = 'Sum of the item prices on the order email for the lines being returned. Delivery and any discount code are not in that email, so check it against what you actually paid.';

// The order's own discount, as a share of its subtotal. AP shares a discount code out
// over the lines, not always evenly, so this is an estimate of what a line is worth
// after the discount -- close, not exact.
function orderDiscountRate(order) {
return order.subtotal > 0 && order.discount > 0 ? order.discount / order.subtotal : 0;
}
function expectedNetRefundFor(order) {
return expectedRefundFor(order) * (1 - orderDiscountRate(order));
}
const money2 = (n) => `£${Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const lineKey = (l) => [l.name, l.colour, l.size].map((x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim()).join('|');
const sumOf = (arr, f) => arr.reduce((t, x) => t + (Number(f(x)) || 0), 0);

// Compare what AP says it refunded with what was expected, line by line and in money.
// state: none | awaiting | match | partial | differs.
function refundCheck(order) {
const refunds = order.refunds || [];
const returning = returningLinesFor(order);
const expectedItems = expectedRefundFor(order);
const expectedNet = expectedNetRefundFor(order);
if (!refunds.length) return { state: returning.length ? 'awaiting' : 'none', expectedItems, expectedNet, issues: [], missing: [], extra: [] };

const refundedLines = refunds.flatMap((r) => r.lines || []);
const value = sumOf(refunds, (r) => r.valueRefunded);
const discount = sumOf(refunds, (r) => r.discount);
const delivery = sumOf(refunds, (r) => r.deliveryRefunded);
const gift = sumOf(refunds, (r) => r.giftcardRefunded);
const itemsRefunded = sumOf(refundedLines, (l) => l.price);

// Lines, matched one for one by name + colour + size.
const pool = new Map();
refundedLines.forEach((l) => { const k = lineKey(l); if (!pool.has(k)) pool.set(k, []); pool.get(k).push(l); });
const missing = [];
for (const l of returning) {
const hit = pool.get(lineKey(l));
if (hit && hit.length) hit.shift(); else missing.push(l);
}
const extra = [...pool.values()].flat();

const issues = [];
const names = (arr) => arr.slice(0, 4).map((l) => `${l.name} (${l.colour}${l.size ? `, ${l.size}` : ''})`).join('; ') + (arr.length > 4 ? ` and ${arr.length - 4} more` : '');
if (missing.length) issues.push(`${missing.length} item${missing.length === 1 ? '' : 's'} you are returning ${missing.length === 1 ? 'is' : 'are'} not in the refund yet (${money2(sumOf(missing, (l) => l.price))}): ${names(missing)}.`);
if (extra.length) issues.push(`the refund includes ${extra.length} item${extra.length === 1 ? '' : 's'} you have as kept or not on the order (${money2(sumOf(extra, (l) => l.price))}): ${names(extra)}.`);
// The email's own sum: items less discount should be the value refunded.
if (Math.abs((itemsRefunded - discount) - value) > 0.01) issues.push(`the email's own figures do not add up: ${money2(itemsRefunded)} of items less ${money2(discount)} discount is ${money2(itemsRefunded - discount)}, but it says ${money2(value)} was refunded.`);
// Against the order's own discount rate, when every line matched.
let diff = null;
if (!missing.length && !extra.length && orderDiscountRate(order) > 0) {
diff = value - expectedNet;
if (Math.abs(diff) > Math.max(5, expectedNet * 0.01)) issues.push(`the amount refunded (${money2(value)}) is ${money2(Math.abs(diff))} ${diff < 0 ? 'less' : 'more'} than the order's own discount rate predicts (about ${money2(expectedNet)}).`);
}
const state = issues.length ? (issues.length === 1 && missing.length && !extra.length ? 'partial' : 'differs') : 'match';
return { state, refunds, value, discount, delivery, gift, itemsRefunded, expectedItems, expectedNet, diff, missing, extra, issues, date: refunds[refunds.length - 1].date };
}

// 5 working days from a date -- AP's own "3-5 working days" to refund the card.
function addWorkingDays(dateStr, n) {
let d = dateStr;
let left = n;
while (left > 0) {
d = dateStrAdd(d, 1);
const dow = new Date(`${d}T12:00:00`).getDay();
if (dow !== 0 && dow !== 6) left--;
}
return d;
}

// One order = one return task (already created at capture) with subtasks: check the refund
// landed, and -- only when it does not match -- an alert subtask due today.
function syncRefundTasks(order, chk, refundMessageId) {
const today = new Date().toISOString().slice(0, 10);
const parentId = order.taskId && data.tasks.some((t) => t.id === order.taskId) ? order.taskId : null;
const source = { kind: 'mail', label: `AP refund, order #${order.orderNumber}`, url: gmailLink(null, null, refundMessageId) };
if (!order.refundTaskId || !data.tasks.some((t) => t.id === order.refundTaskId)) {
order.refundTaskId = captureTask({
title: `Check the ${money2(chk.value)} AP refund for order #${order.orderNumber} has landed on your card`,
notes: 'AP says refunds reach the original payment method within 3-5 working days of the email.',
due: addWorkingDays(chk.date || today, 5), bucket: 'next', parentId, source,
}).id;
}
const issueTask = order.refundIssueTaskId ? data.tasks.find((t) => t.id === order.refundIssueTaskId) : null;
if (chk.issues.length) {
const title = `AP refund for order #${order.orderNumber} does not match what was expected`;
const notes = chk.issues.map((i) => `- ${i}`).join('\n');
if (issueTask) {
issueTask.title = title; issueTask.notes = notes;
if (issueTask.bucket === 'done') { issueTask.bucket = 'next'; issueTask.completedAt = ''; }
} else {
order.refundIssueTaskId = captureTask({ title, notes, due: today, bucket: 'next', parentId, source }).id;
}
} else if (issueTask && issueTask.bucket !== 'done') {
toggleTaskDone(issueTask.id, true); // a later refund email put it right
}
// The return itself is done once everything expected has been refunded.
if (chk.state === 'match' && parentId) {
const ret = data.tasks.find((t) => t.id === parentId);
if (ret && ret.bucket !== 'done') toggleTaskDone(parentId, true);
}
}

// Search Gmail for AP's refund emails, attach each to its order, compare, raise tasks.
// Own one-day cadence; a bad message is skipped, never fatal.
async function runApRefundCheck({ force } = {}) {
if (!force && data.apRefundsLastCheckedAt && daysSince(data.apRefundsLastCheckedAt) < 1) return { skipped: true };
const query = `from:(${SENDER}) subject:"refund request"`;
let messages = [];
try {
const [section] = await fetchMailSearches([{ kind: 'query', value: query, maxDays: 120, maxEvents: 40 }]);
messages = section?.messages || [];
} catch (err) {
return { error: err.message };
}
const out = { added: 0, matched: 0, differing: [], noOrder: 0, alreadySeen: 0 };
for (const msg of messages) {
if (data.apOrders.some((o) => (o.refunds || []).some((r) => r.messageId === msg.id))) { out.alreadySeen++; continue; }
let detail;
try { detail = await getMessageDetail(msg.id); } catch (err) { continue; }
const parsed = parseApRefundEmail(detail.bodyText);
if (!parsed) continue;
const order = data.apOrders.find((o) => o.orderNumber === parsed.orderNumber);
if (!order) { out.noOrder++; continue; }
await attachRefund(order, parsed, msg.id, dateFromHeader(detail.date), out);
}
data.apRefundsLastCheckedAt = new Date().toISOString();
queueSave();
renderApOrders();
return out;
}

async function attachRefund(order, parsed, messageId, date, out) {
// An order captured before totals were read: take them from its own email, once.
if (order.subtotal == null && order.sourceMessageId && order.sourceMessageId !== 'manual') {
try {
const src = await getMessageDetail(order.sourceMessageId);
Object.assign(order, parseOrderTotals(String(src.bodyText || '')));
} catch (err) { /* the check still runs, just without the discount rate */ }
}
if (!Array.isArray(order.refunds)) order.refunds = [];
order.refunds.push({ messageId, date, lines: parsed.lines, discount: parsed.discount, deliveryRefunded: parsed.deliveryRefunded, giftcardRefunded: parsed.giftcardRefunded, valueRefunded: parsed.valueRefunded });
const chk = refundCheck(order);
syncRefundTasks(order, chk, messageId);
if (out) { out.added++; if (chk.state === 'match') out.matched++; else out.differing.push(order); }
}

// Return still to make: not ticked off as done, and the window hasn't closed.
function returnStillOpen(order) {
const task = order.taskId ? data.tasks.find((t) => t.id === order.taskId) : null;
if (task && task.bucket === 'done') return false;
const deadline = returnDeadlineFor(order);
return !(deadline && daysUntil(deadline) < 0);
}

function readingRowHtml(labelHtml, valueHtml, noteHtml) {
return `<div class="loyalty-reading">
<div class="loyalty-reading-id">
<span class="loyalty-reading-label">${labelHtml}</span>
<div class="loyalty-reading-meta"><span class="loyalty-reading-value">${valueHtml}</span></div>
</div>
<div class="loyalty-reading-notes">${noteHtml}</div>
</div>`;
}

// What was expected, and -- once AP's refund email has arrived -- whether it matches.
function refundBlockHtml(order) {
const chk = refundCheck(order);
if (chk.state === 'none') return '';
const rate = orderDiscountRate(order);
const expectedLine = rate > 0
? `${money2(chk.expectedNet)} (${money2(chk.expectedItems)} of items less the order's ${(rate * 100).toFixed(1)}% discount)`
: `${money2(chk.expectedItems)} of items (the order's discount, if any, is not known yet)`;
if (chk.state === 'awaiting') {
return `<div class="settings-note" style="margin:0 0 8px;" title="${escapeHtml(REFUND_NOTE)}">Expected refund: <strong>≈${escapeHtml(expectedLine)}</strong>. Delivery is not normally refunded. No refund email from AP yet.</div>`;
}
const badge = chk.state === 'match' ? '<span class="expiry-badge done">Refund matches</span>'
: chk.state === 'partial' ? '<span class="expiry-badge soon">Refund incomplete</span>'
: '<span class="expiry-badge expired">Refund differs</span>';
const when = chk.date ? ` on ${escapeHtml(chk.date)}` : '';
const issues = chk.issues.length ? `<ul style="margin:4px 0 0 18px;padding:0;">${chk.issues.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>` : '';
const diffNote = chk.diff != null && !chk.issues.length ? ` The amount is ${money2(Math.abs(chk.diff))} ${chk.diff < 0 ? 'under' : 'over'} the pro-rata estimate, within the usual give-and-take on how a discount is shared out.` : '';
return `<div class="settings-note" style="margin:0 0 8px;">${badge} Refunded <strong>${money2(chk.value)}</strong>${when}: ${money2(chk.itemsRefunded)} of items less ${money2(chk.discount)} discount${chk.delivery ? `, plus ${money2(chk.delivery)} delivery` : ''}. Expected ≈${escapeHtml(expectedLine)}.${diffNote}${issues}</div>`;
}

function orderCardHtml(order) {
const kept = keptLinesFor(order);
const returning = returningLinesFor(order);
const deadline = returnDeadlineFor(order);
let badgeHtml = '';
if (deadline) {
const dn = daysUntil(deadline);
if (dn < 0) badgeHtml = '<span class="expiry-badge expired">Return deadline passed</span>';
else if (dn <= 7) badgeHtml = `<span class="expiry-badge soon">${dn === 0 ? 'Return due today' : `Return due in ${dn}d`}</span>`;
else badgeHtml = `<span class="expiry-badge">Return by ${escapeHtml(deadline)}</span>`;
}
const keptHtml = kept.length
? kept.map(({ item, line }) => readingRowHtml(
escapeHtml(line.name),
`${escapeHtml(line.colour)}${line.size ? ` &mdash; ${escapeHtml(line.size)}` : ''}`,
`Matched to: ${escapeHtml([item.brand, item.style, item.colour, item.size].filter(Boolean).join(' ') || '(untitled inventory item)')}`,
)).join('')
: '<div class="empty">Nothing kept yet &mdash; link a kept inventory item to an order line from the Inventory list above.</div>';
const returningHtml = returning.length
? returning.map((l) => readingRowHtml(escapeHtml(l.name), `${escapeHtml(l.colour)}${l.size ? ` &mdash; ${escapeHtml(l.size)}` : ''}`, `£${l.price.toFixed(2)}`)).join('')
: '<div class="empty">Nothing returning.</div>';
return `<div class="account-card" data-ap-order-card="${escapeHtml(order.id)}">
<div class="account-summary" style="cursor:default;">
<strong>Order #${escapeHtml(order.orderNumber)}</strong>
<span class="settings-note" style="margin:0;">placed ${escapeHtml(order.orderDate)}</span>
${badgeHtml}
</div>
<div class="settings-note" style="margin:4px 0 8px;font-weight:600;">${order.lines.length} item${order.lines.length === 1 ? '' : 's'} ordered, ${kept.length} kept, ${returning.length} returning</div>
${refundBlockHtml(order)}
<details>
<summary>Show items &amp; return actions</summary>
<div class="settings-note" style="margin:8px 0 2px;font-weight:600;">Kept &mdash; check this against the real items first</div>
${keptHtml}
<div class="settings-note" style="margin:8px 0 2px;font-weight:600;">Returning &mdash; £${expectedRefundFor(order).toFixed(2)} of items</div>
${returningHtml}
<div class="sync-row" style="margin-top:8px;">
<button type="button" class="sync-btn sm inline" data-ap-order-copy="${escapeHtml(order.id)}">Copy return list</button>
<button type="button" class="sync-btn sm inline" data-ap-order-copy-script="${escapeHtml(order.id)}" title="Copies a DevTools Console script that fills in the real returns portal for you -- ticks every returning line, sets reason/option, stops before the final submit.">Copy return script</button>
<button type="button" class="sync-btn sm inline" data-ap-order-remove="${escapeHtml(order.id)}">Remove</button>
</div>
<div class="settings-note" data-ap-order-copy-status="${escapeHtml(order.id)}" style="margin-top:4px;"></div>
</details>
</div>`;
}

// Leads with the same reconciliation sentence and short Kept list as
// the on-screen card, before the long Returning checklist -- the
// actual answer to "export non-returns": a self-checking reconciliation,
// not a bare return list, given AP's own name/colour/ID mismatches.
async function copyReturnList(orderId) {
const order = data.apOrders.find((o) => o.id === orderId);
const status = document.querySelector(`[data-ap-order-copy-status="${orderId}"]`);
if (!order) return;
const kept = keptLinesFor(order);
const returning = returningLinesFor(order);
const deadline = returnDeadlineFor(order);
const lineText = (l) => `- ${l.name} — ${l.colour}${l.size ? ` — ${l.size}` : ''} — £${l.price.toFixed(2)}`;
const out = [
`Agent Provocateur order #${order.orderNumber} (placed ${order.orderDate}${deadline ? `, return by ${deadline}` : ''})`,
`${order.lines.length} items ordered, ${kept.length} kept, ${returning.length} returning`,
'',
'KEPT -- check this against the real items first:',
...(kept.length ? kept.map(({ line }) => lineText(line)) : ['(none linked yet)']),
'',
'RETURNING:',
...returning.map(lineText),
'',
`EXPECTED REFUND: £${expectedRefundFor(order).toFixed(2)} (item prices from the order email; delivery and any discount code are not included)`,
].join('\n');
try {
await navigator.clipboard.writeText(out);
if (status) status.textContent = 'Copied.';
} catch (err) {
if (status) status.textContent = "Couldn't copy — your browser blocked clipboard access.";
}
}

// Builds the DevTools console script that fills in the real AP
// returns portal (agentprovocateur.returns.international) -- ticks
// every line except the kept ones, sets Return reason/Return Option
// on each, and stops short of the final submit button (always a
// manual, reviewed step). Baked in as a plain string via a template
// literal, same "generate a standalone snippet with this device's own
// config baked in" pattern as js/retailers/agentprovocateur.js's
// bookmarkletSource() and js/features/marriottscan.js's
// buildScanSnippet() -- this is NOT run against the real portal from
// here (confirmed live: the Claude Code permission classifier blocks
// driving a real commercial transaction page directly), only ever
// copied out for the user to paste into their own Console.
//
// Matches each kept line by the portal's own Product code
// (`${code}-${size}`, e.g. "APM0525671691-36B") when a code was
// captured for it -- exact and AP-assigned, not a re-comparison of
// colour text the order email and the portal aren't guaranteed to
// render identically. Falls back to name+colour+size text for any
// kept line captured before this field existed (code blank).
function buildReturnScript(order) {
const kept = keptLinesFor(order).map(({ line }) => ({ code: line.code || '', size: line.size, name: line.name, colour: line.colour }));
const keepJson = JSON.stringify(kept);
return `// AP returns portal script -- order #${order.orderNumber}, generated by the dashboard.
// Paste into DevTools Console (F12) on the "Choose your products" page.
// Starts in DRY_RUN mode (logs a table, clicks nothing). Check the table,
// then edit DRY_RUN to false below and run again to actually fill the form.
// Never touches the final submit button -- review and submit by hand.
(async function () {
const DRY_RUN = true;
const KEEP = ${keepJson};
const REASON = ${JSON.stringify('Doesn\'t suit me')};
const OPTION = ${JSON.stringify('Refund')};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [...document.querySelectorAll('table tr')].filter(
(r) => r.children.length === 9 && r.querySelector('input[type=checkbox]')
);
if (!rows.length) { console.error('No product rows found -- are you on the "Choose your products" page?'); return; }

const results = [];
for (const row of rows) {
const name = row.children[2].textContent.trim();
const code = (row.children[3].textContent.trim().split('-')[0] || '');
const colour = row.children[4].textContent.trim();
const size = row.children[5].textContent.trim();
const isKept = KEEP.some((k) => (k.code && k.code === code && k.size === size) || (!k.code && k.name === name && k.colour === colour && k.size === size));
const cb = row.children[0].querySelector('input[type=checkbox]');
const reasonTd = row.children[7];
const optionTd = row.children[8];

if (isKept) { results.push({ name, colour, size, action: 'KEPT -- left unticked' }); continue; }
if (DRY_RUN) { results.push({ name, colour, size, action: \`would tick + \${REASON} + \${OPTION}\` }); continue; }

if (!cb.checked) cb.click();
await wait(80);
const reasonBtn = [...reasonTd.querySelectorAll('.select-dropbox-menu button')].find((b) => b.textContent.trim() === REASON);
const optionBtn = [...optionTd.querySelectorAll('.select-dropbox-menu button')].find((b) => b.textContent.trim() === OPTION);
if (!reasonBtn || !optionBtn) { results.push({ name, colour, size, action: 'ERROR -- reason/option button not found, left as-is' }); continue; }
reasonBtn.click();
await wait(40);
optionBtn.click();
await wait(40);
const reasonNow = reasonTd.querySelector('button.dropdown-toggle').textContent.trim();
const optionNow = optionTd.querySelector('button.dropdown-toggle').textContent.trim();
results.push({ name, colour, size, action: \`ticked -- reason="\${reasonNow}" option="\${optionNow}"\` });
}

console.table(results);
console.log(DRY_RUN
? 'DRY RUN -- nothing was clicked. Set DRY_RUN = false and re-run to actually fill the form.'
: \`Done -- \${results.filter((r) => r.action.startsWith('ticked')).length} ticked, \${results.filter((r) => r.action === 'KEPT -- left unticked').length} left unticked, \${results.filter((r) => r.action.startsWith('ERROR')).length} errors. Scroll up and check the table, then submit by hand.\`);
})();`;
}

async function copyReturnScript(orderId) {
const order = data.apOrders.find((o) => o.id === orderId);
const status = document.querySelector(`[data-ap-order-copy-status="${orderId}"]`);
if (!order) return;
try {
await navigator.clipboard.writeText(buildReturnScript(order));
if (status) status.textContent = 'Script copied -- paste into DevTools Console (F12) on the returns portal\'s item-list page.';
} catch (err) {
if (status) status.textContent = "Couldn't copy — your browser blocked clipboard access.";
}
}

function renderApOrders() {
const el = document.getElementById('ap-orders-list');
if (!el) return;
const orders = [...data.apOrders].sort((a, b) => (b.orderDate || '').localeCompare(a.orderDate || ''));
const open = orders.filter((o) => returningLinesFor(o).length && returnStillOpen(o) && !(o.refunds || []).length);
const openTotal = open.reduce((sum, o) => sum + expectedNetRefundFor(o), 0);
const differing = orders.filter((o) => ['differs', 'partial'].includes(refundCheck(o).state));
const totalHtml = open.length
? `<div class="settings-note" style="margin:0 0 10px;font-weight:600;" title="${escapeHtml(REFUND_NOTE)}">Expected refunds still to come: ≈${money2(openTotal)} across ${open.length} order${open.length === 1 ? '' : 's'} with a return to make</div>`
: '';
const alertHtml = differing.length
? `<div class="settings-note" style="margin:0 0 10px;font-weight:600;color:var(--red);">A refund does not match what was expected: ${differing.map((o) => apOrderChipHtml(o)).join(' ')}</div>`
: '';
el.innerHTML = orders.length ? alertHtml + totalHtml + orders.map(orderCardHtml).join('') : '<div class="empty">No AP orders captured yet &mdash; Check now below, or paste one in.</div>';
el.querySelectorAll('[data-ap-order-copy]').forEach((btn) => {
btn.addEventListener('click', () => copyReturnList(btn.dataset.apOrderCopy));
});
el.querySelectorAll('[data-ap-order-copy-script]').forEach((btn) => {
btn.addEventListener('click', () => copyReturnScript(btn.dataset.apOrderCopyScript));
});
el.querySelectorAll('[data-ap-order-remove]').forEach((btn) => {
btn.addEventListener('click', () => {
if (!confirm('Remove this captured order? Any inventory item linked to one of its lines will be unlinked, not deleted.')) return;
const id = btn.dataset.apOrderRemove;
const gone = data.apOrders.find((o) => o.id === id);
const goneLines = new Set((gone ? gone.lines : []).map((l) => l.id));
data.inventory.forEach((i) => { if (goneLines.has(i.apOrderLineId)) i.apOrderLineId = ''; });
data.apOrders = data.apOrders.filter((o) => o.id !== id);
queueSave();
renderApOrders();
});
});
bindApOrderChips();
}

function initApOrders() {
renderApOrders();
const checkBtn = document.getElementById('ap-orders-check-btn');
const status = document.getElementById('ap-orders-status');
checkBtn?.addEventListener('click', async () => {
if (status) status.textContent = 'Checking…';
try {
const result = await runApOrderCapture({ force: true });
const refunds = await runApRefundCheck({ force: true });
if (!status) return;
const refundText = refunds.error ? ` Refund check failed: ${escapeHtml(refunds.error)}.`
: ` ${refunds.added} new refund email${refunds.added === 1 ? '' : 's'}${refunds.added ? `, ${refunds.matched} match${refunds.matched === 1 ? 'es' : ''}` : ''}${refunds.differing.length ? `, ${refunds.differing.length} differ: ${refunds.differing.map((o) => apOrderChipHtml(o)).join(' ')}` : ''}${refunds.noOrder ? `; ${refunds.noOrder} for an order not captured` : ''}.`;
status.innerHTML = (result.error ? escapeHtml(result.error)
: `Checked — ${result.added} new order${result.added === 1 ? '' : 's'} captured${result.deadlinesSharpened ? `, ${result.deadlinesSharpened} return deadline${result.deadlinesSharpened === 1 ? '' : 's'} sharpened from a shipping date` : ''}${result.unmatched ? `, ${result.unmatched} email${result.unmatched === 1 ? '' : 's'} not recognised` : ''}.`) + refundText;
} catch (err) {
if (status) status.textContent = err.message || String(err);
}
});
const pasteBtn = document.getElementById('ap-orders-paste-btn');
const pasteArea = document.getElementById('ap-orders-paste-text');
pasteBtn?.addEventListener('click', async () => {
const refundParsed = parseApRefundEmail(pasteArea.value);
if (refundParsed) {
const target = data.apOrders.find((o) => o.orderNumber === refundParsed.orderNumber);
if (!target) { if (status) status.textContent = `That is a refund for order #${refundParsed.orderNumber}, which isn't captured yet — capture the order first.`; return; }
const out = { added: 0, matched: 0, differing: [] };
await attachRefund(target, refundParsed, 'manual', new Date().toISOString().slice(0, 10), out);
queueSave();
pasteArea.value = '';
renderApOrders();
if (status) status.innerHTML = `Refund added to ${apOrderChipHtml(target)} — ${out.matched ? 'it matches what was expected.' : 'it differs from what was expected; see the order.'}`;
return;
}
const parsed = parseApOrderEmail(pasteArea.value);
if (!parsed) { if (status) status.textContent = "Couldn't recognise that as an AP order email."; return; }
if (data.apOrders.some((o) => o.orderNumber === parsed.orderNumber)) { if (status) status.textContent = `Order #${parsed.orderNumber} is already captured.`; return; }
const pasted = blankApOrder({ ...parsed, sourceMessageId: 'manual' });
pasted.taskId = createReturnTask(pasted);
data.apOrders.push(pasted);
queueSave();
pasteArea.value = '';
if (status) status.textContent = `Captured order #${parsed.orderNumber} — ${parsed.lines.length} items.`;
renderApOrders();
});
}

// The canonical AP-order reference (dashboard/CLAUDE.md's own
// record-reference standard) -- mirrors tripChipHtml/bindTripChips
// (travel.js) exactly, for use on any inventory row linked to an
// order, and anywhere else an order is named in generated text.
function apOrderChipHtml(order, extraHtml = '') {
return `<span class="ap-order-chip" data-open-ap-order="${escapeHtml(order.id)}">&#128230; #${escapeHtml(order.orderNumber)}</span>${extraHtml}`;
}
function revealApOrder(id) {
renderApOrders();
const details = document.querySelector(`[data-ap-order-card="${id}"] details`);
if (details) details.open = true;
setTimeout(() => scrollAndFlash(`[data-ap-order-card="${id}"]`), 60);
}
let apOrderChipsBound = false;
function bindApOrderChips() {
if (apOrderChipsBound) return;
apOrderChipsBound = true;
document.addEventListener('click', (e) => {
const chip = e.target.closest('[data-open-ap-order]');
if (!chip) return;
import('../tabs.js').then(({ switchTab }) => {
switchTab('shopping');
revealApOrder(chip.dataset.openApOrder);
});
});
}

export {
runApOrderCapture, runApRefundCheck, renderApOrders, initApOrders,
orderForNumber, apOrderLineOptionsHtml, apOrderNumberDatalistHtml,
apOrderChipHtml, bindApOrderChips, revealApOrder,
};
