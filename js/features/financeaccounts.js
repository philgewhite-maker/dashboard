// Bank accounts and credit cards kept open for their incentive -- a
// switch bonus, cashback, or a 0% balance-transfer deal. Replaces the
// old flat "Deal Expiries" panel (name/type/date/notes only, no account
// identity, no linkage between accounts) with a richer record per
// account, plus a visual "money flow" diagram of how funding/CASS links
// actually connect them -- the connectivity itself was the ask, not
// just capturing more fields.
import { data, queueSave, blankFinanceAccount } from '../state.js';
import { escapeHtml, bindForm, daysUntil, scrollAndFlash } from '../utils.js';

const ACCOUNT_TYPES = ['Current account', 'Savings', 'Credit card', 'Mortgage', 'Loan', 'Other'];
// Same idea as airbnb.js's own AIRBNB_COLOURS -- a small, locally-declared
// fixed palette, since there's no free colour-picker anywhere else to
// reuse and accounts aren't the same colour space as Airbnb listings.
const ACCOUNT_COLOURS = ['blue', 'pink', 'sage', 'amber', 'slate', 'rose', 'teal', 'plum', 'red'];

// Mirrors connections.js's expandedConnections -- renderFinanceAccounts()
// rebuilds the whole list's innerHTML every time (e.g. after editing one
// field), so which <details> card is open has to be tracked outside the
// DOM, not read back from it.
const expandedAccounts = new Set();

function accountLabel(a) {
return [a.bank, a.name].filter(Boolean).join(' — ') || 'Unnamed account';
}
function accountInitials(a) {
return (a.bank || a.name || '?').trim().slice(0, 2).toUpperCase();
}
function accountBadgeHtml(a, sizeClass) {
return `<span class="account-badge ${escapeHtml(a.colour)} ${sizeClass || ''}">${escapeHtml(accountInitials(a))}</span>`;
}

// Same expiry-badge classes vouchers.js/subscriptions.js/the old
// dealexpiries.js all already use -- no new CSS needed for this part.
function dealBadgeHtml(a) {
if (!a.dealEndDate) return '';
const dn = daysUntil(a.dealEndDate);
if (dn < 0) return `<span class="expiry-badge expired">Deal expired</span>`;
if (dn <= 60) return `<span class="expiry-badge soon">${dn === 0 ? 'Deal ends today' : `Deal: ${dn}d left`}</span>`;
return `<span class="expiry-badge">Deal: ${dn}d left</span>`;
}

function otherAccountOptionsHtml(excludeId, selectedId) {
return `<option value="">None</option>` + data.financeAccounts
.filter((a) => a.id !== excludeId)
.map((a) => `<option value="${escapeHtml(a.id)}" ${a.id === selectedId ? 'selected' : ''}>${escapeHtml(accountLabel(a))}</option>`)
.join('');
}

function directDebitsHtml(a) {
return (a.directDebits || []).map((dd) => `<span class="tag-chip">${escapeHtml(dd)}<span class="tag-x" data-dd-remove="${escapeHtml(a.id)}:${escapeHtml(dd)}">&times;</span></span>`).join('');
}

function accountCardHtml(a) {
const closedTag = a.closeDate && a.closeDate <= new Date().toISOString().slice(0, 10) ? '<span class="tag-chip" style="opacity:.7;">Closed</span>' : '';
return `<details class="account-card" data-account-row="${escapeHtml(a.id)}" ${expandedAccounts.has(a.id) ? 'open' : ''}>
<summary class="account-summary">
${accountBadgeHtml(a, 'sm')}
<span class="account-summary-name">${escapeHtml(accountLabel(a))}</span>
<span class="tag-chip">${escapeHtml(a.accountType)}</span>
${closedTag}
${dealBadgeHtml(a)}
</summary>
<div class="account-detail">
<div class="account-field-row">
<label>Bank<input type="text" autocomplete="off" data-field="bank" data-account-id="${a.id}" value="${escapeHtml(a.bank)}" placeholder="e.g. Halifax"></label>
<label>Account name<input type="text" autocomplete="off" data-field="name" data-account-id="${a.id}" value="${escapeHtml(a.name)}" placeholder="e.g. Reward Current Account"></label>
<label>Type<select data-field="accountType" data-account-id="${a.id}">${ACCOUNT_TYPES.map((t) => `<option value="${t}" ${t === a.accountType ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
</div>
<div class="account-field-row">
<label>Sort code<input type="text" autocomplete="off" data-field="sortCode" data-account-id="${a.id}" value="${escapeHtml(a.sortCode)}" placeholder="00-00-00"></label>
<label>Account number<input type="text" autocomplete="off" data-field="accountNumber" data-account-id="${a.id}" value="${escapeHtml(a.accountNumber)}" placeholder="12345678"></label>
</div>
<div class="account-field-row">
<label>Opened<input type="date" data-field="openDate" data-account-id="${a.id}" value="${escapeHtml(a.openDate)}"></label>
<label>Closed<input type="date" data-field="closeDate" data-account-id="${a.id}" value="${escapeHtml(a.closeDate)}"></label>
<label>CASS-linked account<select data-field="cassLinkedAccountId" data-account-id="${a.id}">${otherAccountOptionsHtml(a.id, a.cassLinkedAccountId)}</select></label>
</div>
<div class="account-field-row">
<label>Deal / incentive<input type="text" autocomplete="off" data-field="deal" data-account-id="${a.id}" value="${escapeHtml(a.deal)}" placeholder="e.g. £200 switch bonus, 0% BT 30mo"></label>
<label>Deal ends<input type="date" data-field="dealEndDate" data-account-id="${a.id}" value="${escapeHtml(a.dealEndDate)}"></label>
</div>
<label class="account-field-full">Purpose<input type="text" autocomplete="off" data-field="purpose" data-account-id="${a.id}" value="${escapeHtml(a.purpose)}" placeholder="e.g. Switch bonus farming, Emergency fund"></label>
<div class="account-field-row">
<label>Monthly funding in<input type="text" autocomplete="off" data-field="fundingAmount" data-account-id="${a.id}" value="${escapeHtml(a.fundingAmount)}" placeholder="e.g. £1,000/mo"></label>
<label>Funded from<select data-field="fundingFromAccountId" data-account-id="${a.id}">${otherAccountOptionsHtml(a.id, a.fundingFromAccountId)}</select></label>
</div>
<div class="account-field-full">
<label style="display:block;margin-bottom:4px;">Direct Debits <span class="settings-note" style="display:inline;margin:0;">(often a condition of the deal)</span></label>
<div class="tag-editor">${directDebitsHtml(a)}</div>
<div class="sync-row" style="margin-top:6px;">
<input type="text" autocomplete="off" class="tag-add-input" placeholder="Add a Direct Debit…" data-dd-input="${a.id}" style="max-width:200px;">
<button class="sync-btn sm" type="button" data-dd-add="${a.id}">Add</button>
</div>
</div>
<div class="account-field-full">
<label style="display:block;margin-bottom:4px;">Colour</label>
<div class="account-colour-picker">${ACCOUNT_COLOURS.map((c) => `<span class="account-colour-swatch ${c} ${c === a.colour ? 'account-colour-selected' : ''}" data-colour-pick="${a.id}:${c}" title="${c}"></span>`).join('')}</div>
</div>
<label class="account-field-full">Notes<textarea data-field="notes" data-account-id="${a.id}" rows="2" placeholder="Anything else worth remembering">${escapeHtml(a.notes)}</textarea></label>
<div class="sync-row" style="margin-top:8px;">
<span class="del-x" style="opacity:1;" data-del-account="${a.id}">&times; Delete account</span>
</div>
</div>
</details>`;
}

// ---- Money-flow diagram ---------------------------------------------------

// Only accounts that are a source or target of at least one link appear
// as nodes -- otherwise every unlinked account would clutter what's
// meant to be a focused "how does money actually move" view, not a
// second copy of the full roster.
function flowEdges() {
const edges = [];
data.financeAccounts.forEach((a) => {
if (a.fundingFromAccountId && data.financeAccounts.some((x) => x.id === a.fundingFromAccountId)) {
edges.push({ from: a.fundingFromAccountId, to: a.id, kind: 'funding', label: a.fundingAmount ? `${a.fundingAmount}/mo` : 'funds' });
}
});
// CASS links are naturally stored on both sides once two accounts point
// at each other, so de-dupe by an order-independent pair key -- one
// line per pair, not two overlapping ones.
const seenCass = new Set();
data.financeAccounts.forEach((a) => {
if (!a.cassLinkedAccountId || !data.financeAccounts.some((x) => x.id === a.cassLinkedAccountId)) return;
const key = [a.id, a.cassLinkedAccountId].sort().join('|');
if (seenCass.has(key)) return;
seenCass.add(key);
edges.push({ from: a.id, to: a.cassLinkedAccountId, kind: 'cass', label: 'CASS' });
});
return edges;
}

// Nodes are laid out by ordinary flexbox wrap in the DOM -- no custom
// graph-layout algorithm. This just measures where they actually
// landed and draws straight SVG lines between the real centre points,
// deliberately simple for a first version: no edge-crossing avoidance,
// no smart node ordering beyond insertion order.
function drawFlowLines() {
const container = document.getElementById('account-flow-diagram');
if (!container) return;
const svg = container.querySelector('.flow-lines');
if (!svg) return;
const edges = flowEdges();
const rect = container.getBoundingClientRect();
svg.setAttribute('width', String(rect.width));
svg.setAttribute('height', String(rect.height));
svg.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
const centreOf = (id) => {
const el = container.querySelector(`[data-flow-node="${id}"]`);
if (!el) return null;
const r = el.getBoundingClientRect();
return { x: r.left + r.width / 2 - rect.left, y: r.top + r.height / 2 - rect.top };
};
const defs = `<defs><marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--ink)"></path></marker></defs>`;
const lines = edges.map((e) => {
const p1 = centreOf(e.from), p2 = centreOf(e.to);
if (!p1 || !p2) return '';
const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
// A backing rect roughly sized to the label text so it doesn't render
// unreadably crossed by the line underneath it -- estimated from
// character count rather than measured, which is fine at this label
// length ("£1,000/mo", "CASS").
const labelW = Math.max(28, e.label.length * 6 + 8);
return `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="var(--ink)" stroke-width="1.5" ${e.kind === 'cass' ? 'stroke-dasharray="4 3"' : ''} marker-end="url(#flow-arrow)"></line>
<rect x="${mx - labelW / 2}" y="${my - 8}" width="${labelW}" height="16" rx="4" fill="var(--paper)"></rect>
<text x="${mx}" y="${my + 4}" text-anchor="middle" font-size="10" font-family="'IBM Plex Mono', monospace" fill="var(--ink)">${escapeHtml(e.label)}</text>`;
}).join('');
svg.innerHTML = defs + lines;
}

let resizeTimer = null;
function scheduleFlowRedraw() {
clearTimeout(resizeTimer);
resizeTimer = setTimeout(drawFlowLines, 120);
}
let resizeBound = false;

function flowDiagramHtml() {
const edges = flowEdges();
if (!edges.length) {
return '<div class="settings-note" style="margin:0 0 12px;">Once you link accounts via CASS or a funding transfer, they\'ll show here.</div>';
}
const nodeIds = new Set();
edges.forEach((e) => { nodeIds.add(e.from); nodeIds.add(e.to); });
const nodes = data.financeAccounts.filter((a) => nodeIds.has(a.id));
return `<div class="flow-diagram" id="account-flow-diagram">
<svg class="flow-lines"></svg>
<div class="flow-nodes">${nodes.map((a) => `<div class="flow-node" data-flow-node="${escapeHtml(a.id)}">${accountBadgeHtml(a, 'sm')}<span>${escapeHtml(accountLabel(a))}</span></div>`).join('')}</div>
</div>`;
}

// ---- Render + bind ---------------------------------------------------------

function renderFinanceAccounts() {
const list = document.getElementById('accounts-list');
const flowMount = document.getElementById('accounts-flow-mount');
const countEl = document.getElementById('accounts-count');
if (!list) return;
if (countEl) countEl.textContent = data.financeAccounts.length + (data.financeAccounts.length === 1 ? ' account' : ' accounts');
if (flowMount) flowMount.innerHTML = flowDiagramHtml();
list.innerHTML = data.financeAccounts.length
? data.financeAccounts.map(accountCardHtml).join('')
: '<div class="empty">No accounts tracked yet. Add one below.</div>';

list.querySelectorAll('details.account-card').forEach((el) => {
el.addEventListener('toggle', () => {
const id = el.dataset.accountRow;
if (el.open) expandedAccounts.add(id); else expandedAccounts.delete(id);
});
});
list.querySelectorAll('[data-field][data-account-id]').forEach((el) => {
el.addEventListener('change', () => {
const a = data.financeAccounts.find((x) => x.id === el.dataset.accountId);
if (!a) return;
a[el.dataset.field] = el.value.trim();
queueSave();
renderFinanceAccounts();
});
});
list.querySelectorAll('[data-dd-add]').forEach((btn) => {
btn.addEventListener('click', () => {
const id = btn.dataset.ddAdd;
const input = list.querySelector(`[data-dd-input="${id}"]`);
const value = input.value.trim();
if (!value) return;
const a = data.financeAccounts.find((x) => x.id === id);
if (!a) return;
if (!Array.isArray(a.directDebits)) a.directDebits = [];
if (!a.directDebits.includes(value)) a.directDebits.push(value);
input.value = '';
queueSave();
renderFinanceAccounts();
});
});
list.querySelectorAll('[data-dd-remove]').forEach((x) => {
x.addEventListener('click', () => {
const [id, value] = x.dataset.ddRemove.split(':');
const a = data.financeAccounts.find((acc) => acc.id === id);
if (!a) return;
a.directDebits = (a.directDebits || []).filter((dd) => dd !== value);
queueSave();
renderFinanceAccounts();
});
});
list.querySelectorAll('[data-colour-pick]').forEach((sw) => {
sw.addEventListener('click', () => {
const [id, colour] = sw.dataset.colourPick.split(':');
const a = data.financeAccounts.find((x) => x.id === id);
if (!a) return;
a.colour = colour;
queueSave();
renderFinanceAccounts();
});
});
list.querySelectorAll('[data-del-account]').forEach((x) => {
x.addEventListener('click', () => {
const id = x.dataset.delAccount;
data.financeAccounts = data.financeAccounts.filter((a) => a.id !== id);
// Same orphan-drop reasoning as the state.js migration guard --
// another account's link to this one is now dangling.
data.financeAccounts.forEach((a) => {
if (a.cassLinkedAccountId === id) a.cassLinkedAccountId = '';
if (a.fundingFromAccountId === id) a.fundingFromAccountId = '';
});
expandedAccounts.delete(id);
queueSave();
renderFinanceAccounts();
});
});

drawFlowLines();
if (!resizeBound) {
resizeBound = true;
window.addEventListener('resize', scheduleFlowRedraw);
}
}

function initFinanceAccountForm() {
bindForm('account-form', () => {
const bankInput = document.getElementById('account-bank-input');
const nameInput = document.getElementById('account-name-input');
const bank = bankInput.value.trim();
const name = nameInput.value.trim();
if (!bank && !name) return;
data.financeAccounts.push(blankFinanceAccount({ bank, name }));
bankInput.value = '';
nameInput.value = '';
renderFinanceAccounts();
queueSave();
});
}

// Nudge-driven reveal -- same shape as connections.js's expandConnection:
// mark it open, re-render, then scroll+flash the real row once it exists.
function expandAccountRow(id) {
expandedAccounts.add(id);
renderFinanceAccounts();
setTimeout(() => scrollAndFlash(`[data-account-row="${id}"]`), 50);
}

export { renderFinanceAccounts, initFinanceAccountForm, expandAccountRow, accountLabel };
