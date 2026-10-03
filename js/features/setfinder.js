// Finding a set for her from the catalogue, not the drawer -- the other
// half of "make a set". inventorySets() in shopping.js answers "what do
// I already own that's a set"; this answers "what could I buy her, in
// her size, under budget, right now".
//
// Two listing fetches, not a slow per-page search: Agent Provocateur's
// own /lingerie listing takes a size filter and a sort order in its own
// URL hash -- confirmed live, not assumed (see agentprovocateur.js's
// listingUrl/listingItems, and the trail of failed attempts before that
// confirmation: a #filters.range= hash did nothing on a fresh
// navigation, and the page's own "NN items" counter doesn't react to a
// filter that IS applied, so neither is the test to trust -- only the
// actual grid content is). So "her bra sizes, cheapest first" and "her
// bra sizes, biggest discount first" are each one page, already filtered
// and sorted by the retailer -- no per-candidate size-guessing needed
// before a single product page is fetched. Colour is filtered CLIENT-
// SIDE instead (bucketsForColour) -- no URL key for it was ever
// confirmed working, see agentprovocateur.js's COLOURS comment.
//
// The SET itself then comes for free from a candidate bra's own product
// page: the "wear with" block (parseSiblings, read by parseProductPage,
// matched against her sizes by resultFor) already lists the matching
// knickers and extras in stock in her size -- the exact machinery the
// ordinary stock check uses. Confirming one candidate bra also confirms
// its whole set, in the same fetch, rather than a separate knickers
// search per range.
//
// Budget is the BRA's price alone, not a basket total -- her own call:
// "budget can be just the bra actually... a set requires knickers to
// match" (required to exist and fit, never itself budget-gated), "other
// items are optional extras beyond budget if they are interesting
// enough" (never filtered out, just not counted toward the cutoff).
//
// PERSISTENCE: written onto conn.setSearch and queueSave()d at every
// stage rather than kept in the dialog's own local variables -- a search
// is several paced fetches through the home agent and can run minutes.
// Confirmed live the hard way: a search was still running when the
// dialog (or the page) went away, and there was nothing left to show for
// it afterward. Reopening the dialog -- even after a reload -- now reads
// whatever conn.setSearch last had, finished or not. Still bounded by
// the browser TAB staying open, same as every home-agent operation: the
// agent finishes its own work regardless, but nothing is left running in
// a closed tab to start the NEXT fetch once one stage's result is back.
import { data, queueSave, sizeGroupFor } from '../state.js';
import { escapeHtml, bindBackdropClose } from '../utils.js';
import { captureTask } from './tasks.js';
import { connectionPickerHtml, bindConnPickers } from './connections.js';
import { fetchPages, wantedSizesFor, resultFor, money } from './stockwatch.js';
import * as agentProvocateur from '../retailers/agentprovocateur.js';

// Bounds on how many product pages one search fetches -- each one is
// paced CHECK_SPACING_MS apart (agentprovocateur.js), so an unbounded
// candidate list is an unbounded wait, not just an unbounded result.
const MAX_IN_BUDGET = 12;
const MAX_BIG_DISCOUNT = 5;

// ---- The search itself --------------------------------------------------

async function findSets(connId, budgetGBP, buckets, { onProgress } = {}) {
const conn = data.connections.find((c) => c.id === connId);
if (!conn) return { error: 'No such connection.' };
const budget = Number(budgetGBP);
if (!(budget > 0)) return { error: 'Enter a budget above zero.' };

const braSizes = [...new Set(
wantedSizesFor(conn, { piece: 'Bra', retailer: agentProvocateur.RETAILER }).map((s) => s.size),
)];
if (!braSizes.length) return { error: `No bra size on file for her at ${agentProvocateur.RETAILER}.` };

if (onProgress) onProgress(`Searching ${agentProvocateur.RETAILER} bras in ${braSizes.join('/')}…`);
const priceUrl = agentProvocateur.listingUrl({ prodType: 'Bras', sizes: braSizes, sort: 'price' });
const discountUrl = agentProvocateur.listingUrl({ prodType: 'Bras', sizes: braSizes, sort: '-discount' });
const { pages: listPages, errors: listErrors } = await fetchPages([priceUrl, discountUrl]);
let byPrice = agentProvocateur.listingItems(listPages.get(priceUrl) || '');
let byDiscount = agentProvocateur.listingItems(listPages.get(discountUrl) || '');
if (!byPrice.length && !byDiscount.length) {
return { error: `Couldn't read the listing (${listErrors[0]?.error || 'no results came back'}).` };
}

if (buckets && buckets.length) {
const inBucket = (item) => agentProvocateur.bucketsForColour(item.colour).some((b) => buckets.includes(b));
byPrice = byPrice.filter(inBucket);
byDiscount = byDiscount.filter(inBucket);
}

// Already price-sorted ascending by the retailer, so the first one over
// budget means every one after it is too -- no need to scan the rest.
const inBudget = [];
for (const item of byPrice) {
if (item.now == null) continue;
if (item.now > budget) break;
inBudget.push(item);
if (inBudget.length >= MAX_IN_BUDGET) break;
}
const overBudgetDiscounts = byDiscount
.filter((item) => item.now != null && item.now > budget)
.slice(0, MAX_BIG_DISCOUNT);

const seenUrl = new Set();
const candidates = [...inBudget, ...overBudgetDiscounts].filter((item) => {
if (seenUrl.has(item.url)) return false;
seenUrl.add(item.url);
return true;
});
if (!candidates.length) {
const cheapest = byPrice.find((i) => i.now != null);
return { error: `Nothing listed at or near that budget${cheapest ? ` — the cheapest in her size${buckets?.length ? ' and colour' : ''} is ${money(cheapest.now)}` : ''}.` };
}

if (onProgress) onProgress(`Confirming ${candidates.length} bra${candidates.length === 1 ? '' : 's'} against her size, stock and any discount code…`);
const { pages: prodPages, errors: prodErrors } = await fetchPages(candidates.map((c) => c.url));

const rows = [];
candidates.forEach((cand) => {
const html = prodPages.get(cand.url);
if (!html) return;
const page = agentProvocateur.parseProductPage(html, cand.url);
const result = resultFor(page, conn, {});
// The listing said her size was there; stock moves between that fetch
// and this one, so the product page -- fetched seconds to minutes
// later -- is the one trusted, not the listing's say-so.
if (!result.available.length) return;
const knickers = result.alsoAvailable.filter((s) => sizeGroupFor(s.name) === 'Knickers');
// No matching knickers in her size, in stock, isn't a set -- her own
// rule. The bra alone doesn't get a row just because it's cheap.
if (!knickers.length) return;
const extras = result.alsoAvailable.filter((s) => sizeGroupFor(s.name) !== 'Knickers');
const net = result.net != null ? result.net : cand.now;
rows.push({
range: cand.range, colour: cand.colour, listingDiscountPct: cand.discountPct,
bra: result, braPiece: page.piece, net, knickers, extras,
overBudget: net > budget,
});
});

const within = rows.filter((r) => !r.overBudget).sort((a, b) => a.net - b.net);
const discounted = rows.filter((r) => r.overBudget).sort((a, b) => (b.bra.discountPct || 0) - (a.bra.discountPct || 0));
return {
within, discounted,
errors: [...listErrors, ...prodErrors],
checked: candidates.length,
};
}

// ---- Persisted runs -------------------------------------------------------

// Dialogs currently open, keyed by connId, so a running search can push a
// live update into one if it's still open -- and simply does nothing if
// it isn't; the result is already saved to conn.setSearch either way, so
// the next time the dialog opens for her it reads the finished state.
const liveDialogs = new Map();

function runSetSearch(connId, budgetGBP, buckets) {
const conn = data.connections.find((c) => c.id === connId);
if (!conn) return;
conn.setSearch = {
budget: Number(budgetGBP), buckets: buckets || [],
status: 'running', progress: '', error: null,
startedAt: new Date().toISOString(), finishedAt: null,
within: [], discounted: [], checked: 0, addedUrls: [],
};
queueSave();
const refresh = () => liveDialogs.get(connId)?.();
refresh();
findSets(connId, budgetGBP, buckets, {
onProgress: (m) => { conn.setSearch.progress = m; queueSave(); refresh(); },
}).then((res) => {
if (res.error) {
Object.assign(conn.setSearch, { status: 'error', error: res.error });
} else {
Object.assign(conn.setSearch, {
status: 'done', within: res.within, discounted: res.discounted, checked: res.checked,
});
}
conn.setSearch.finishedAt = new Date().toISOString();
queueSave();
refresh();
}).catch((err) => {
Object.assign(conn.setSearch, { status: 'error', error: err.message || String(err), finishedAt: new Date().toISOString() });
queueSave();
refresh();
});
}

// ---- Dialog -----------------------------------------------------------

const COLOUR_BUCKET_OPTIONS = ['Black', 'Neutral', 'Bright', 'Other'];

function sizesLabel(available) {
return available.map((a) => `${a.size}${a.which === 'backup' ? ' (backup)' : ''}${a.lastOne ? ' — last one' : ''}`).join(', ');
}

function rowHtml(r, added) {
const title = [r.range, r.colour].filter(Boolean).join(' — ');
const discountNote = r.listingDiscountPct ? ` <span class="tag-chip tag-chip-amber">${r.listingDiscountPct}% off</span>` : '';
const knickersHtml = r.knickers.map((k) => `<div class="settings-note" style="margin:0;">+ ${escapeHtml(k.name)} ${escapeHtml(sizesLabel(k.available))} — ${escapeHtml(money(k.net != null ? k.net : k.now))}</div>`).join('');
const extrasHtml = r.extras.length
? `<div class="settings-note" style="margin:0;">Also in her size: ${escapeHtml(r.extras.map((e) => e.name).join(', '))}</div>` : '';
return `<div class="setfinder-row" style="border-top:1px solid var(--line);padding:8px 0;">
<div><strong>${escapeHtml(title)}</strong>${discountNote}</div>
<div>${escapeHtml(r.braPiece)} — <strong>${escapeHtml(money(r.net))}</strong> <span class="settings-note" style="display:inline;margin:0;">${escapeHtml(sizesLabel(r.bra.available))}</span></div>
${knickersHtml}
${extrasHtml}
<div class="sync-row" style="margin-top:4px;">
<a class="sync-btn sm" href="${escapeHtml(r.bra.url)}" target="_blank" rel="noopener noreferrer">View</a>
<button class="sync-btn sm" type="button" data-setfinder-add="${escapeHtml(r.bra.url)}" ${added ? 'disabled' : ''}>${added ? 'Added' : 'Add as want'}</button>
<button class="sync-btn sm" type="button" data-setfinder-add-edit="${escapeHtml(r.bra.url)}" title="Create the want, then open it in Tasks to set a context, file it under a project, add a due date etc.">Add &amp; edit…</button>
</div>
</div>`;
}

function resultsHtml(search) {
if (search.status === 'error') return `<div class="settings-note" style="margin:0;">${escapeHtml(search.error)}</div>`;
const added = new Set(search.addedUrls || []);
const within = search.within.length
? search.within.map((r) => rowHtml(r, added.has(r.bra.url))).join('')
: (search.status === 'running' ? '' : '<div class="settings-note" style="margin:0;">Nothing in budget with a matching knickers piece found.</div>');
const discounted = search.discounted.length
? `<div style="margin-top:10px;"><strong>Biggest discounts over budget</strong>${search.discounted.map((r) => rowHtml(r, added.has(r.bra.url))).join('')}</div>` : '';
return `<div><strong>Within budget</strong>${within}</div>${discounted}`;
}

function statusLine(search) {
if (!search) return '';
if (search.status === 'running') return search.progress || 'Searching…';
if (search.status === 'error') return '';
return `Checked ${search.checked} bra${search.checked === 1 ? '' : 's'}.`;
}

function setFinderDialogHtml() {
const bucketsHtml = COLOUR_BUCKET_OPTIONS.map((b) => `<label style="display:inline-flex;align-items:center;gap:3px;font-size:12px;margin-right:8px;"><input type="checkbox" data-setfinder-bucket value="${b}"> ${b}</label>`).join('');
return `<div class="mail-view-card" style="max-width:520px;">
<div class="mail-view-subject">Find a set</div>
<div class="settings-note" style="margin:2px 0 8px;">Searches Agent Provocateur bras in her recorded size, cheapest first, and checks each one's matching knickers before showing it — a set requires both.</div>
<div class="account-field-row">
<div>Her${connectionPickerHtml('setfinder-conn', 'Choose a connection…')}</div>
<label>Bra budget £<input type="number" min="1" step="1" class="settings-input" data-setfinder-budget value="150"></label>
</div>
<div style="margin-top:6px;">Colour <span class="settings-note" style="display:inline;margin:0;">(blank = any)</span><br>${bucketsHtml}</div>
<div class="sync-row" style="margin-top:8px;">
<button class="add-btn" type="button" data-setfinder-search>Search</button>
<span class="sync-status" data-setfinder-status></span>
</div>
<div data-setfinder-results style="margin-top:10px;"></div>
<div class="mail-view-actions">
<button class="sync-btn sm" type="button" data-setfinder-close>Close</button>
</div>
</div>`;
}

function openSetFinderDialog(connId) {
const dialog = document.createElement('div');
dialog.className = 'mail-view-backdrop';
dialog.innerHTML = setFinderDialogHtml();
document.body.appendChild(dialog);
let boundConnId = connId || null;
let pickerPoll;
const close = () => {
if (boundConnId) liveDialogs.delete(boundConnId);
clearInterval(pickerPoll);
dialog.remove();
};
bindBackdropClose(dialog, close);
dialog.querySelector('[data-setfinder-close]').addEventListener('click', close);
bindConnPickers();

const resultsEl = dialog.querySelector('[data-setfinder-results]');
const statusEl = dialog.querySelector('[data-setfinder-status]');
const searchBtn = dialog.querySelector('[data-setfinder-search]');
const budgetInput = dialog.querySelector('[data-setfinder-budget]');
const bucketBoxes = [...dialog.querySelectorAll('[data-setfinder-bucket]')];

// Shared by both buttons: a plain "add" keeps the quick, stay-in-the-
// dialog path for ticking off several results in a row; "Add & edit…"
// is the same creation, immediately followed by the REAL task editor --
// context, "Part of" (the existing parentId/project picker), due date --
// rather than a second, smaller copy of that editor built into this
// dialog. Reused, not reinvented, same as resultFor/parseProductPage.
const addRow = (search, url) => {
const row = [...search.within, ...search.discounted].find((r) => r.bra.url === url);
if (!row) return null;
const task = captureTask({
title: `${row.range} ${row.braPiece}${row.colour ? ` — ${row.colour}` : ''}`.trim(),
link: url,
wantSpec: {
brand: agentProvocateur.RETAILER, style: row.range,
pieces: [row.braPiece], colours: row.colour ? [row.colour] : [],
urls: [url],
},
forConnectionId: boundConnId,
bucket: 'next', wantState: 'active',
});
search.addedUrls = [...(search.addedUrls || []), url];
queueSave();
return task;
};

const bindAddButtons = (search) => {
resultsEl.querySelectorAll('[data-setfinder-add]').forEach((btn) => {
btn.addEventListener('click', () => {
if (!addRow(search, btn.dataset.setfinderAdd)) return;
btn.textContent = 'Added';
btn.disabled = true;
const editBtn = btn.parentElement.querySelector('[data-setfinder-add-edit]');
if (editBtn) editBtn.disabled = true;
});
});
resultsEl.querySelectorAll('[data-setfinder-add-edit]').forEach((btn) => {
btn.addEventListener('click', async () => {
const task = addRow(search, btn.dataset.setfinderAddEdit);
if (!task) return;
const [{ switchTab }, { revealTask }] = await Promise.all([import('../tabs.js'), import('./tasks.js')]);
close();
switchTab('tasks');
revealTask(task.id);
});
});
};

// Renders whatever conn.setSearch currently holds -- called on open, and
// pushed into again by runSetSearch while this dialog stays open for the
// same connection, so progress updates live rather than needing a poll.
const renderFromState = () => {
const conn = boundConnId && data.connections.find((c) => c.id === boundConnId);
const search = conn && conn.setSearch;
searchBtn.disabled = search?.status === 'running';
statusEl.textContent = statusLine(search);
if (!search) { resultsEl.innerHTML = ''; return; }
resultsEl.innerHTML = resultsHtml(search);
bindAddButtons(search);
};

const bindToConn = (id) => {
if (boundConnId) liveDialogs.delete(boundConnId);
boundConnId = id;
if (!id) { resultsEl.innerHTML = ''; statusEl.textContent = ''; return; }
liveDialogs.set(id, renderFromState);
const conn = data.connections.find((c) => c.id === id);
budgetInput.value = conn?.setSearch?.budget || budgetInput.value || 150;
bucketBoxes.forEach((cb) => { cb.checked = (conn?.setSearch?.buckets || []).includes(cb.value); });
renderFromState();
};

if (connId) {
const hidden = dialog.querySelector('#setfinder-conn');
const conn = data.connections.find((c) => c.id === connId);
if (hidden) {
hidden.value = connId;
const trigger = dialog.querySelector('[data-conn-picker-trigger]');
if (trigger && conn) trigger.textContent = conn.name || 'Her';
}
bindToConn(connId);
}

// The connection picker swaps its own hidden input's value on pick, with
// no event of its own to hook -- polling the one input while the dialog
// is open is simpler than reaching into connections.js's picker
// internals for a callback that doesn't exist yet.
let lastPicked = connId || '';
pickerPoll = setInterval(() => {
if (!dialog.isConnected) { clearInterval(pickerPoll); return; }
const val = dialog.querySelector('#setfinder-conn')?.value || '';
if (val !== lastPicked) { lastPicked = val; bindToConn(val || null); }
}, 400);

searchBtn.addEventListener('click', () => {
if (!boundConnId) { statusEl.textContent = 'Choose who this is for first.'; return; }
const buckets = bucketBoxes.filter((cb) => cb.checked).map((cb) => cb.value);
runSetSearch(boundConnId, budgetInput.value, buckets);
});
}

export { findSets, runSetSearch, openSetFinderDialog };
