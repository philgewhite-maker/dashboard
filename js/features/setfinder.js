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
// before a single product page is fetched.
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
import { data, sizeGroupFor } from '../state.js';
import { escapeHtml } from '../utils.js';
import { captureTask } from './tasks.js';
import { connectionPickerHtml, bindConnPickers } from './connections.js';
import { fetchPages, wantedSizesFor, resultFor, money } from './stockwatch.js';
import * as agentProvocateur from '../retailers/agentprovocateur.js';

// Bounds on how many product pages one search fetches -- each one is
// paced CHECK_SPACING_MS apart (agentprovocateur.js), so an unbounded
// candidate list is an unbounded wait, not just an unbounded result.
const MAX_IN_BUDGET = 12;
const MAX_BIG_DISCOUNT = 5;

async function findSets(connId, budgetGBP, { onProgress } = {}) {
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
const byPrice = agentProvocateur.listingItems(listPages.get(priceUrl) || '');
const byDiscount = agentProvocateur.listingItems(listPages.get(discountUrl) || '');
if (!byPrice.length && !byDiscount.length) {
return { error: `Couldn't read the listing (${listErrors[0]?.error || 'no results came back'}).` };
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
return { error: `Nothing listed at or near that budget${cheapest ? ` — the cheapest in her size is ${money(cheapest.now)}` : ''}.` };
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
conn, within, discounted,
errors: [...listErrors, ...prodErrors],
checked: candidates.length,
};
}

// ---- Dialog -----------------------------------------------------------

function sizesLabel(available) {
return available.map((a) => `${a.size}${a.which === 'backup' ? ' (backup)' : ''}${a.lastOne ? ' — last one' : ''}`).join(', ');
}

function rowHtml(r) {
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
<button class="sync-btn sm" type="button" data-setfinder-add="${escapeHtml(r.bra.url)}">Add as want</button>
</div>
</div>`;
}

function resultsHtml(res) {
if (res.error) return `<div class="settings-note" style="margin:0;">${escapeHtml(res.error)}</div>`;
const within = res.within.length
? res.within.map(rowHtml).join('')
: '<div class="settings-note" style="margin:0;">Nothing in budget with a matching knickers piece found.</div>';
const discounted = res.discounted.length
? `<div style="margin-top:10px;"><strong>Biggest discounts over budget</strong>${res.discounted.map(rowHtml).join('')}</div>` : '';
return `<div><strong>Within budget</strong>${within}</div>${discounted}`;
}

function setFinderDialogHtml() {
return `<div class="mail-view-card" style="max-width:520px;">
<div class="mail-view-subject">Find a set</div>
<div class="settings-note" style="margin:2px 0 8px;">Searches Agent Provocateur bras in her recorded size, cheapest first, and checks each one's matching knickers before showing it — a set requires both.</div>
<div class="account-field-row">
<div>Her${connectionPickerHtml('setfinder-conn', 'Choose a connection…')}</div>
<label>Bra budget £<input type="number" min="1" step="1" class="settings-input" data-setfinder-budget value="150"></label>
</div>
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
const close = () => dialog.remove();
dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
dialog.querySelector('[data-setfinder-close]').addEventListener('click', close);
bindConnPickers();
if (connId) {
const hidden = dialog.querySelector('#setfinder-conn');
if (hidden) {
const conn = data.connections.find((c) => c.id === connId);
hidden.value = connId;
const trigger = dialog.querySelector('[data-conn-picker-trigger]');
if (trigger && conn) trigger.textContent = conn.name || 'Her';
}
}

let lastResult = null;
const resultsEl = dialog.querySelector('[data-setfinder-results]');
const statusEl = dialog.querySelector('[data-setfinder-status]');
const searchBtn = dialog.querySelector('[data-setfinder-search]');

const bindAddButtons = () => {
resultsEl.querySelectorAll('[data-setfinder-add]').forEach((btn) => {
btn.addEventListener('click', () => {
const url = btn.dataset.setfinderAdd;
const row = [...(lastResult?.within || []), ...(lastResult?.discounted || [])].find((r) => r.bra.url === url);
if (!row || !lastResult) return;
captureTask({
title: `${row.range} ${row.braPiece}${row.colour ? ` — ${row.colour}` : ''}`.trim(),
link: url,
wantSpec: {
brand: agentProvocateur.RETAILER, style: row.range,
pieces: [row.braPiece], colours: row.colour ? [row.colour] : [],
urls: [url],
},
forConnectionId: lastResult.conn.id,
bucket: 'next', wantState: 'active',
});
btn.textContent = 'Added';
btn.disabled = true;
});
});
};

searchBtn.addEventListener('click', async () => {
const connId2 = dialog.querySelector('#setfinder-conn')?.value;
const budget = dialog.querySelector('[data-setfinder-budget]')?.value;
if (!connId2) { statusEl.textContent = 'Choose who this is for first.'; return; }
searchBtn.disabled = true;
statusEl.textContent = 'Searching…';
resultsEl.innerHTML = '';
try {
const res = await findSets(connId2, budget, { onProgress: (m) => { statusEl.textContent = m; } });
lastResult = res;
resultsEl.innerHTML = resultsHtml(res);
bindAddButtons();
statusEl.textContent = res.error ? '' : `Checked ${res.checked} bra${res.checked === 1 ? '' : 's'}.`;
} catch (err) {
resultsEl.innerHTML = `<div class="settings-note" style="margin:0;">${escapeHtml(err.message || String(err))}</div>`;
} finally {
searchBtn.disabled = false;
}
});
}

export { findSets, openSetFinderDialog };
