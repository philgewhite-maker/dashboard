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
import { fetchMailSearches, getMessageDetail } from '../googlemail.js';

const SENDER = 'clientservices@agentprovocateur.com';
const CADENCE_DAYS = 28;

// Real example confirmed live (Gmail connector, order #5000289577):
// "Order number:</b></td><td> #5000289577</td>" and "Order placed:
// </b></td><td>04/10/2026</td>" -- both label/value pairs collapse to
// "Order number:\s*#5000289577" / "Order placed:\s*04/10/2026" once
// stripped to text, same `\s*`-bridges-tag-boundary idiom every other
// extractor in this app already relies on. DD/MM/YYYY, confirmed from
// the same real email (04/10/2026 = 4 October 2026, not 10 April).
function parseApOrderEmail(bodyText) {
const text = String(bodyText || '');
const orderNumberMatch = text.match(/Order number:\s*#(\d+)/i);
const dateMatch = text.match(/Order placed:\s*(\d{2})\/(\d{2})\/(\d{4})/i);
if (!orderNumberMatch || !dateMatch) return null;
const orderNumber = orderNumberMatch[1];
const orderDate = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;

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
lines.push({ id: uid(), name: nameMatch[1].trim(), colour: m[1].trim(), size: m[2].trim(), price: Number(m[3].replace(/,/g, '')) });
}
if (!lines.length) return null;
return { orderNumber, orderDate, lines };
}

function isDue(force) {
if (force) return true;
if (!data.apOrdersLastCheckedAt) return true;
return daysSince(data.apOrdersLastCheckedAt) >= CADENCE_DAYS;
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
let added = 0, unmatched = 0, alreadySeen = 0;
for (const msg of messages) {
// The "has been shipped" follow-up email matches this same search
// (same sender, overlapping subject) but has no item table at all
// -- parseApOrderEmail correctly returns null for it (no "Colour:"
// occurrences), so it's just counted unmatched, never recorded.
if (data.apOrders.some((o) => o.sourceMessageId === msg.id)) { alreadySeen++; continue; }
let detail;
try { detail = await getMessageDetail(msg.id); } catch (err) { continue; } // transient fetch failure -- try again next scan
const parsed = parseApOrderEmail(detail.bodyText);
if (!parsed) { unmatched++; continue; }
if (data.apOrders.some((o) => o.orderNumber === parsed.orderNumber)) { alreadySeen++; continue; }
data.apOrders.push(blankApOrder({ ...parsed, sourceMessageId: msg.id }));
added++;
}
data.apOrdersLastCheckedAt = new Date().toISOString();
queueSave();
renderApOrders();
return { added, unmatched, alreadySeen };
}

function orderForNumber(orderNumber) {
const n = String(orderNumber || '').trim();
if (!n) return null;
return data.apOrders.find((o) => o.orderNumber === n) || null;
}

// Shared between the "Add to inventory" dialog and each inventory
// row's own picker (shopping.js) -- one place builds the option list,
// so both pickers always offer the same real order lines.
function apOrderLineOptionsHtml(order, selectedId = '') {
const opts = ['<option value="">Link to an order line&hellip;</option>'];
order.lines.forEach((l) => {
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

function readingRowHtml(labelHtml, valueHtml, noteHtml) {
return `<div class="loyalty-reading">
<div class="loyalty-reading-id">
<span class="loyalty-reading-label">${labelHtml}</span>
<div class="loyalty-reading-meta"><span class="loyalty-reading-value">${valueHtml}</span></div>
</div>
<div class="loyalty-reading-notes">${noteHtml}</div>
</div>`;
}

function orderCardHtml(order) {
const kept = keptLinesFor(order);
const returning = returningLinesFor(order);
const deadline = order.orderDate ? dateStrAdd(order.orderDate, 28) : '';
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
<div class="settings-note" style="margin:8px 0 2px;font-weight:600;">Kept &mdash; check this against the real items first</div>
${keptHtml}
<div class="settings-note" style="margin:8px 0 2px;font-weight:600;">Returning</div>
${returningHtml}
<div class="sync-row" style="margin-top:8px;">
<button type="button" class="sync-btn sm inline" data-ap-order-copy="${escapeHtml(order.id)}">Copy return list</button>
<button type="button" class="sync-btn sm inline" data-ap-order-remove="${escapeHtml(order.id)}">Remove</button>
</div>
<div class="settings-note" data-ap-order-copy-status="${escapeHtml(order.id)}" style="margin-top:4px;"></div>
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
const deadline = order.orderDate ? dateStrAdd(order.orderDate, 28) : '';
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
].join('\n');
try {
await navigator.clipboard.writeText(out);
if (status) status.textContent = 'Copied.';
} catch (err) {
if (status) status.textContent = "Couldn't copy — your browser blocked clipboard access.";
}
}

function renderApOrders() {
const el = document.getElementById('ap-orders-list');
if (!el) return;
const orders = [...data.apOrders].sort((a, b) => (b.orderDate || '').localeCompare(a.orderDate || ''));
el.innerHTML = orders.length ? orders.map(orderCardHtml).join('') : '<div class="empty">No AP orders captured yet &mdash; Check now below, or paste one in.</div>';
el.querySelectorAll('[data-ap-order-copy]').forEach((btn) => {
btn.addEventListener('click', () => copyReturnList(btn.dataset.apOrderCopy));
});
el.querySelectorAll('[data-ap-order-remove]').forEach((btn) => {
btn.addEventListener('click', () => {
if (!confirm('Remove this captured order? Any inventory item linked to one of its lines will be unlinked, not deleted.')) return;
const id = btn.dataset.apOrderRemove;
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
if (!status) return;
status.textContent = result.error ? result.error
: `Checked — ${result.added} new order${result.added === 1 ? '' : 's'} captured${result.unmatched ? `, ${result.unmatched} email${result.unmatched === 1 ? '' : 's'} not recognised` : ''}.`;
} catch (err) {
if (status) status.textContent = err.message || String(err);
}
});
const pasteBtn = document.getElementById('ap-orders-paste-btn');
const pasteArea = document.getElementById('ap-orders-paste-text');
pasteBtn?.addEventListener('click', () => {
const parsed = parseApOrderEmail(pasteArea.value);
if (!parsed) { if (status) status.textContent = "Couldn't recognise that as an AP order email."; return; }
if (data.apOrders.some((o) => o.orderNumber === parsed.orderNumber)) { if (status) status.textContent = `Order #${parsed.orderNumber} is already captured.`; return; }
data.apOrders.push(blankApOrder({ ...parsed, sourceMessageId: 'manual' }));
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
runApOrderCapture, renderApOrders, initApOrders,
orderForNumber, apOrderLineOptionsHtml,
apOrderChipHtml, bindApOrderChips, revealApOrder,
};
