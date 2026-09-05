// Bank accounts and credit cards kept open for their incentive -- a
// switch bonus, cashback, or a 0% balance-transfer deal. Replaces the
// old flat "Deal Expiries" panel (name/type/date/notes only, no account
// identity, no linkage between accounts) with a richer record per
// account, plus a visual "money flow" diagram of how funding/CASS links
// actually connect them -- the connectivity itself was the ask, not
// just capturing more fields.
import { data, queueSave, blankFinanceAccount } from '../state.js';
import { uid, escapeHtml, bindForm, daysUntil, scrollAndFlash } from '../utils.js';
import { matchBankLogo } from '../bankLogos.js';

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

function isClosed(a) {
return !!(a.closeDate && a.closeDate <= new Date().toISOString().slice(0, 10));
}

function accountLabel(a) {
return [a.bank, a.name].filter(Boolean).join(' — ') || 'Unnamed account';
}
function accountInitials(a) {
return (a.bank || a.name || '?').trim().slice(0, 2).toUpperCase();
}
// Prefers a pasted logo image (e.g. the provider's own Play Store
// listing icon, hotlinked -- never downloaded/stored locally, see
// blankFinanceAccount's own comment) over the coloured-initials
// fallback. `img[error]` doesn't bubble, so the fallback-reveal has to
// be bound per-image after insertion -- see bindLogoFallbacks() below,
// called after every render.
function accountBadgeHtml(a, sizeClass) {
const cls = `account-badge ${escapeHtml(a.colour)} ${sizeClass || ''}`;
const initials = escapeHtml(accountInitials(a));
if (a.logoUrl) {
return `<span class="${cls} account-badge-logo"><img src="${escapeHtml(a.logoUrl)}" alt="" data-badge-img="1"><span class="account-badge-fallback" data-badge-fallback hidden>${initials}</span></span>`;
}
return `<span class="${cls}">${initials}</span>`;
}
function bindLogoFallbacks(root) {
root?.querySelectorAll('img[data-badge-img]').forEach((img) => {
img.addEventListener('error', () => {
// closest() has to run BEFORE remove() -- once detached, the img has
// no parent left to walk up from and the lookup silently finds
// nothing, leaving the fallback stuck hidden behind a blank badge.
const badge = img.closest('.account-badge');
img.remove();
badge?.querySelector('[data-badge-fallback]')?.removeAttribute('hidden');
}, { once: true });
});
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

// A card's own equivalent of a CASS switch, but there can be several --
// each rendered as "£X from <account>" rather than a bare amount, since
// which OTHER account it came from is exactly the fact a bare list of
// amounts would lose.
function balanceTransfersHtml(a) {
return (a.balanceTransfers || []).map((bt) => {
const from = data.financeAccounts.find((x) => x.id === bt.fromAccountId);
const label = `${bt.amount ? escapeHtml(bt.amount) : 'Amount not set'} from ${escapeHtml(from ? accountLabel(from) : 'a deleted account')}`;
return `<span class="tag-chip">${label}<span class="tag-x" data-bt-remove="${escapeHtml(a.id)}:${escapeHtml(bt.id)}">&times;</span></span>`;
}).join('');
}

function accountCardHtml(a) {
const closedTag = isClosed(a) ? '<span class="tag-chip" style="opacity:.7;">Closed</span>' : '';
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
<label>CASS switch from<select data-field="cassFromAccountId" data-account-id="${a.id}">${otherAccountOptionsHtml(a.id, a.cassFromAccountId)}</select></label>
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
<label style="display:block;margin-bottom:4px;">Balance transfers <span class="settings-note" style="display:inline;margin:0;">(a card's own equivalent of a CASS switch — there can be several, over time)</span></label>
<div class="tag-editor">${balanceTransfersHtml(a)}</div>
<div class="sync-row" style="margin-top:6px;">
<select data-bt-from="${a.id}">${otherAccountOptionsHtml(a.id, '')}</select>
<input type="text" autocomplete="off" class="tag-add-input" placeholder="Amount, e.g. £2,000" data-bt-amount="${a.id}" style="max-width:140px;">
<button class="sync-btn sm" type="button" data-bt-add="${a.id}">Add</button>
</div>
</div>
<div class="account-field-full">
<label style="display:block;margin-bottom:4px;">Direct Debits <span class="settings-note" style="display:inline;margin:0;">(often a condition of the deal)</span></label>
<div class="tag-editor">${directDebitsHtml(a)}</div>
<div class="sync-row" style="margin-top:6px;">
<input type="text" autocomplete="off" class="tag-add-input" placeholder="Add a Direct Debit…" data-dd-input="${a.id}" style="max-width:200px;">
<button class="sync-btn sm" type="button" data-dd-add="${a.id}">Add</button>
</div>
</div>
<div class="account-field-row">
<label class="account-field-full">Logo URL <span class="settings-note" style="display:inline;margin:0;">(optional -- e.g. the bank's own Play Store listing icon)</span><input type="text" autocomplete="off" data-field="logoUrl" data-account-id="${a.id}" value="${escapeHtml(a.logoUrl)}" placeholder="https://play-lh.googleusercontent.com/…"></label>
</div>
<div class="account-field-full">
<label style="display:block;margin-bottom:4px;">Colour <span class="settings-note" style="display:inline;margin:0;">(the card's accent stripe, and the fallback badge if no logo)</span></label>
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

// Which relationship the diagram currently shows -- Ongoing (funding),
// CASS, or Balance transfers, never more than one at once (see
// FLOW_MODES below). Module-level, not persisted -- resets to Ongoing
// on reload, the most-relevant-day-to-day default.
let flowMode = 'funding';
const FLOW_MODES = [
{ key: 'funding', label: 'Ongoing' },
{ key: 'cass', label: 'CASS' },
{ key: 'balance-transfer', label: 'Balance transfers' },
];
const FLOW_MODE_EMPTY = {
funding: 'Once you add a monthly funding transfer between accounts, they\'ll show here.',
cass: 'Once you record a CASS switch between accounts, they\'ll show here.',
'balance-transfer': 'Once you record a balance transfer between cards, they\'ll show here.',
};

// Only accounts that are a source or target of at least one edge of the
// CURRENT mode appear as nodes -- otherwise every unrelated account
// would clutter what's meant to be a focused "how does money actually
// move" view, not a second copy of the full roster.
//
// Closed-account visibility deliberately differs by mode: Ongoing
// (funding) hides closed accounts entirely -- a closed account has no
// ongoing payments to show, and its own edge (if any lingering data
// still has one) would be misleading. CASS and Balance transfers are
// both one-off HISTORICAL moves, not recurring ones, so closed accounts
// stay visible there -- the account you switched FROM, or transferred a
// balance out of, is very often exactly the one that's since been
// closed; hiding it would erase the point of showing that history at
// all.
function flowEdges(mode) {
const closedOk = mode !== 'funding';
const byId = new Map(data.financeAccounts.map((a) => [a.id, a]));
const accountOk = (id) => { const a = byId.get(id); return !!a && (closedOk || !isClosed(a)); };
const edges = [];
if (mode === 'funding') {
data.financeAccounts.forEach((a) => {
if (a.fundingFromAccountId && accountOk(a.fundingFromAccountId) && accountOk(a.id)) {
edges.push({ from: a.fundingFromAccountId, to: a.id, kind: 'funding', label: a.fundingAmount ? `${a.fundingAmount}/mo` : 'funds' });
}
});
} else if (mode === 'cass') {
// Directional now (cassFromAccountId, not the old undirected-sounding
// cassLinkedAccountId) -- one edge per account that has it set, no
// pair-dedup needed since the field only ever points one way.
data.financeAccounts.forEach((a) => {
if (a.cassFromAccountId && accountOk(a.cassFromAccountId) && accountOk(a.id)) {
edges.push({ from: a.cassFromAccountId, to: a.id, kind: 'cass', label: 'CASS' });
}
});
} else if (mode === 'balance-transfer') {
data.financeAccounts.forEach((a) => {
(a.balanceTransfers || []).forEach((bt) => {
if (bt.fromAccountId && accountOk(bt.fromAccountId) && accountOk(a.id)) {
edges.push({ from: bt.fromAccountId, to: a.id, kind: 'balance-transfer', label: bt.amount ? `${bt.amount} BT` : 'BT' });
}
});
});
}
return edges;
}

// Layered left-to-right layout: an account with no incoming edge of the
// current mode (within the linked set) sits in column 0; anyone it
// funds/CASS'd/transferred a balance to sits one column to the right,
// and so on -- so money visibly flows left-to-right instead of a single
// row where 3+ lines into one account would have nowhere sane to go.
// `edges` is always a single kind (flowEdges(mode) only ever returns
// one), so no per-kind filtering is needed here -- every edge passed in
// counts. Cycles (two accounts funding each other) are defended against
// with a per-path visited set, which just stops the recursion rather
// than resolving them "correctly" -- not a shape the UI should
// encourage, just not allowed to hang on it.
function flowColumns(nodeIds, edges) {
const incoming = new Map();
edges.forEach((e) => {
if (!incoming.has(e.to)) incoming.set(e.to, []);
incoming.get(e.to).push(e.from);
});
const depthCache = new Map();
function depthOf(id, path) {
if (depthCache.has(id)) return depthCache.get(id);
if (path.has(id)) return 0;
const sources = incoming.get(id) || [];
if (!sources.length) { depthCache.set(id, 0); return 0; }
path.add(id);
const d = 1 + Math.max(...sources.map((s) => depthOf(s, path)));
path.delete(id);
depthCache.set(id, d);
return d;
}
const byDepth = new Map();
nodeIds.forEach((id) => {
const d = depthOf(id, new Set());
if (!byDepth.has(d)) byDepth.set(d, []);
byDepth.get(d).push(id);
});
return [...byDepth.keys()].sort((x, y) => x - y).map((d) => byDepth.get(d));
}

// Nodes are laid out by ordinary flexbox (columns of a flex row, each a
// flex column) -- normal document flow does the positioning, no pixel
// math for placement. This just measures where cards actually landed
// and draws SVG connectors between them. The part that actually solves
// "some accounts have 3+ funding lines": each node's OWN edges are
// distributed evenly along its relevant border (outgoing along the
// right edge, incoming along the left) instead of every line converging
// on one shared centre point -- a hub funding 4 accounts gets 4 spaced
// exit points, a target funded by 3 gets 3 spaced entry points, each
// computed independently per node. Applied uniformly to every edge kind
// now (not just funding) -- a card can just as easily receive several
// balance transfers, and treating every kind the same way here is both
// simpler and still correct. Only the line STYLE (solid/dashed/dotted,
// FLOW_DASH_BY_KIND below) and label vary by kind -- purely cosmetic,
// since a given view only ever shows one kind at a time (FLOW_MODES).
const FLOW_DASH_BY_KIND = { funding: '', cass: 'stroke-dasharray="5 3"', 'balance-transfer': 'stroke-dasharray="1.5 3"' };
function drawFlowLines(mode) {
const container = document.getElementById('account-flow-diagram');
if (!container) return;
const svg = container.querySelector('.flow-lines');
if (!svg) return;
const edges = flowEdges(mode);
const rect = container.getBoundingClientRect();
svg.setAttribute('width', String(rect.width));
svg.setAttribute('height', String(rect.height));
svg.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);

const rectOf = (id) => {
const el = container.querySelector(`[data-flow-node="${id}"]`);
if (!el) return null;
const r = el.getBoundingClientRect();
return { top: r.top - rect.top, left: r.left - rect.left, width: r.width, height: r.height };
};

const outEdges = new Map(), inEdges = new Map();
edges.forEach((e) => {
if (!outEdges.has(e.from)) outEdges.set(e.from, []);
outEdges.get(e.from).push(e);
if (!inEdges.has(e.to)) inEdges.set(e.to, []);
inEdges.get(e.to).push(e);
});
const anchorPoint = (id, edge, side) => {
const r = rectOf(id);
if (!r) return null;
const list = (side === 'out' ? outEdges : inEdges).get(id) || [];
const idx = list.indexOf(edge);
const y = r.top + ((idx + 1) / (list.length + 1)) * r.height;
return { x: side === 'out' ? r.left + r.width : r.left, y };
};

const defs = `<defs><marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--ink)"></path></marker></defs>`;
const parts = edges.map((e) => {
const p1 = anchorPoint(e.from, e, 'out');
const p2 = anchorPoint(e.to, e, 'in');
if (!p1 || !p2) return '';
const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
// A backing rect roughly sized to the label text so it doesn't render
// unreadably crossed by the line underneath it -- estimated from
// character count rather than measured, which is fine at this label
// length ("£1,000/mo", "CASS").
const labelW = Math.max(28, e.label.length * 6 + 8);
// A gentle S-curve -- the horizontal control-point offset is what
// makes several lines fanning out of/into the same card edge read as
// distinct paths instead of a straight-line tangle. (Its true midpoint
// is exactly (mx, my): standard cubic-bezier symmetry when both
// control points share their endpoint's y and sit at the same x, so
// the label needs no separate curve-point math.)
const path = `M${p1.x},${p1.y} C${mx},${p1.y} ${mx},${p2.y} ${p2.x},${p2.y}`;
return `<path d="${path}" fill="none" stroke="var(--ink)" stroke-width="1.5" ${FLOW_DASH_BY_KIND[e.kind] || ''} marker-end="url(#flow-arrow)"></path>
<rect x="${mx - labelW / 2}" y="${my - 8}" width="${labelW}" height="16" rx="4" fill="var(--paper)"></rect>
<text x="${mx}" y="${my + 4}" text-anchor="middle" font-size="10" font-family="'IBM Plex Mono', monospace" fill="var(--ink)">${escapeHtml(e.label)}</text>`;
}).join('');
svg.innerHTML = defs + parts;
}

let resizeTimer = null;
function scheduleFlowRedraw() {
clearTimeout(resizeTimer);
resizeTimer = setTimeout(() => drawFlowLines(flowMode), 120);
}
let resizeBound = false;

// Masked like a real card face ("•••• 1234") -- a light, cosmetic touch,
// not a security measure (the full number is still one click away in
// the account's own detail form).
function maskedAccountNumber(a) {
const num = String(a.accountNumber || '').replace(/\s+/g, '');
return num ? `•••• ${num.slice(-4)}` : '';
}

// Each node rendered as a debit/credit-card-shaped face -- logo (or the
// colour+initials fallback) top-left, account type top-right like an
// issuer wordmark, masked number, bank+account name -- instead of a
// bare badge+label chip, so the diagram carries enough of an account's
// own identity to be read at a glance, not just its position in the
// graph.
function flowCardHtml(a) {
const masked = maskedAccountNumber(a);
return `<div class="flow-card ${escapeHtml(a.colour)}" data-flow-node="${escapeHtml(a.id)}">
<div class="flow-card-top">${accountBadgeHtml(a, 'lg')}<span class="flow-card-type">${escapeHtml(a.accountType)}</span></div>
${masked ? `<div class="flow-card-number">${escapeHtml(masked)}</div>` : ''}
<div class="flow-card-name">${escapeHtml(accountLabel(a))}</div>
</div>`;
}

// .overview-chip/.overview-chip.active is the same "pick one of a few"
// pill pattern the Tasks filter and Overview's own dimension chips
// already use -- reused as-is rather than inventing a second toggle
// style.
function flowModeToggleHtml() {
return `<div class="flow-mode-toggle">${FLOW_MODES.map((m) => `<button type="button" class="overview-chip${m.key === flowMode ? ' active' : ''}" data-flow-mode="${m.key}">${escapeHtml(m.label)}</button>`).join('')}</div>`;
}

function flowDiagramHtml() {
const toggle = flowModeToggleHtml();
const edges = flowEdges(flowMode);
if (!edges.length) {
return `${toggle}<div class="settings-note" style="margin:8px 0 12px;">${FLOW_MODE_EMPTY[flowMode]}</div>`;
}
const nodeIds = new Set();
edges.forEach((e) => { nodeIds.add(e.from); nodeIds.add(e.to); });
const columns = flowColumns(nodeIds, edges);
const cardById = new Map(data.financeAccounts.map((a) => [a.id, a]));
return `${toggle}<div class="flow-diagram" id="account-flow-diagram">
<svg class="flow-lines"></svg>
<div class="flow-columns">${columns.map((col) => `<div class="flow-column">${col.map((id) => flowCardHtml(cardById.get(id))).join('')}</div>`).join('')}</div>
</div>`;
}

// ---- Render + bind ---------------------------------------------------------

function renderFinanceAccounts() {
const list = document.getElementById('accounts-list');
const flowMount = document.getElementById('accounts-flow-mount');
const countEl = document.getElementById('accounts-count');
if (!list) return;
if (countEl) countEl.textContent = data.financeAccounts.length + (data.financeAccounts.length === 1 ? ' account' : ' accounts');
if (flowMount) {
flowMount.innerHTML = flowDiagramHtml();
bindLogoFallbacks(flowMount);
// A flow card is a reference to the real account row below, same as
// every other record reference in this app links back to its record
// (CLAUDE.md's record-reference standards) -- easy to miss here since
// the diagram reads as its own self-contained view, but it's still
// just another place this account is shown, not a settled destination
// in its own right.
flowMount.querySelectorAll('.flow-card').forEach((card) => {
card.addEventListener('click', () => expandAccountRow(card.dataset.flowNode));
});
flowMount.querySelectorAll('[data-flow-mode]').forEach((btn) => {
btn.addEventListener('click', () => {
flowMode = btn.dataset.flowMode;
renderFinanceAccounts();
});
});
}
list.innerHTML = data.financeAccounts.length
? data.financeAccounts.map(accountCardHtml).join('')
: '<div class="empty">No accounts tracked yet. Add one below.</div>';
bindLogoFallbacks(list);

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
// A dedicated `blur` handler on just the bank field, separate from the
// generic `change`-based save above -- `change` only fires when a
// field's value actually differs from what it was on focus, so simply
// re-confirming an already-correct bank name (nothing to "change") would
// never reach the change handler at all. `blur` fires every time the
// field is left regardless, which is exactly "retype the name (or just
// tab through it again) and it still tries to fill in a blank logo."
list.querySelectorAll('[data-field="bank"][data-account-id]').forEach((el) => {
el.addEventListener('blur', () => {
const a = data.financeAccounts.find((x) => x.id === el.dataset.accountId);
if (!a || a.logoUrl) return;
const match = matchBankLogo(el.value.trim() || a.bank);
if (!match) return;
a.logoUrl = match;
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
list.querySelectorAll('[data-bt-add]').forEach((btn) => {
btn.addEventListener('click', () => {
const id = btn.dataset.btAdd;
const fromSelect = list.querySelector(`[data-bt-from="${id}"]`);
const amountInput = list.querySelector(`[data-bt-amount="${id}"]`);
const fromAccountId = fromSelect.value;
if (!fromAccountId) return;
const a = data.financeAccounts.find((x) => x.id === id);
if (!a) return;
if (!Array.isArray(a.balanceTransfers)) a.balanceTransfers = [];
a.balanceTransfers.push({ id: uid(), fromAccountId, amount: amountInput.value.trim() });
fromSelect.value = '';
amountInput.value = '';
queueSave();
renderFinanceAccounts();
});
});
list.querySelectorAll('[data-bt-remove]').forEach((x) => {
x.addEventListener('click', () => {
const [id, btId] = x.dataset.btRemove.split(':');
const a = data.financeAccounts.find((acc) => acc.id === id);
if (!a) return;
a.balanceTransfers = (a.balanceTransfers || []).filter((bt) => bt.id !== btId);
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
if (a.cassFromAccountId === id) a.cassFromAccountId = '';
if (a.fundingFromAccountId === id) a.fundingFromAccountId = '';
a.balanceTransfers = (a.balanceTransfers || []).filter((bt) => bt.fromAccountId !== id);
});
expandedAccounts.delete(id);
queueSave();
renderFinanceAccounts();
});
});

drawFlowLines(flowMode);
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
data.financeAccounts.push(blankFinanceAccount({ bank, name, logoUrl: matchBankLogo(bank) || '' }));
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
