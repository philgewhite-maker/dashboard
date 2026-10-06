// Shopping lists as a filtered view over ordinary GTD tasks, not a separate
// system — a shopping item is a task like any other. That's deliberate: it's
// what lets "buy paint" sit under a DIY project (tagged DIY) while also
// showing up here (tagged Supermarket too), and what lets any item be broken
// out into its own subtasks, given a due date, or attached a receipt photo
// just by opening it in Tasks — nothing shopping-specific has to duplicate
// that editing UI, it's the same task detail screen.
//
// "Search prices" covers the comparison half of the original ask — an AI web
// search finds retailers, prices and product links for an item. Adding to a
// basket stays a manual click-through: that needs an authenticated session
// against each retailer's site, which doesn't fit a client-only static page.
//
// For a Supermarket-context item specifically, the price check now runs
// AUTOMATICALLY the moment the item's captured (see runAutoPriceCheck,
// called from every capture path — this file's own text box, and
// captureOutcomes.js's `supermarket` outcome for voice/image/URL capture) —
// the point being "share it, and next time you open the app there's already
// a link to buy it from the right place," not a manual step. The result is
// persisted on the task itself (t.priceCheck), dated, with a Refresh button
// to re-run it later — not the old in-memory, un-dated Map this used to be.
import { data, queueSave, SHOPPING_CONTEXTS, unheldInventory, whoFits, inventorySets, whoFitsSet, blankInventoryItem } from '../state.js';
import { escapeHtml, affiliateLink, daysUntil, daysSince, todayStr, MISSING_KEY_LINK_HTML, looksLikeUrl, bindBackdropClose, pickChipHtml, knownScalarValues, hydratePhotoBackgrounds } from '../utils.js';
import { captureTask, revealTask } from './tasks.js';
import { connectionChipHtml, bindConnectionChips, connectionPickerHtml, bindConnPickers, setConnPickerValue, sensitiveFieldsShown } from './connections.js';
import { runStockCheck, stockCheckHtml, adapterFor, seedWatchSpec, pasteStockFor, cashbackHtml, fetchPages, registerCashbackTracked, refreshCashbackRates, money } from './stockwatch.js';
import { MissingKeyError, searchShoppingItem } from '../ai.js';
import { initMicCapture } from './voicecapture.js';
import { banner } from './sharetarget.js';

let showDone = false;
// Only transient loading/error UI state now — a finished search writes to
// the task's own t.priceCheck (persisted, dated) instead of living here.
const searchState = new Map(); // taskId -> { status: 'loading'|'error', message }

function dueBadge(t) {
if (!t.due) return '';
const dn = daysUntil(t.due);
const cls = dn < 0 ? 'overdue' : dn <= 2 ? 'soon' : '';
const text = dn < 0 ? `${-dn}d overdue` : dn === 0 ? 'today' : `in ${dn}d`;
return ` <span class="task-badge ${cls}">${escapeHtml(text)}</span>`;
}

// A task filed under more than one context (the "buy paint" case) shows
// what else it's filed under, so it doesn't read as shopping-only when it's
// really part of a bigger project.
function otherContextsNote(t, ctx) {
const others = (t.contexts || []).filter((c) => c !== ctx);
return others.length ? ` <span class="shop-also">also: ${escapeHtml(others.join(', '))}</span>` : '';
}

function checkedAgoLabel(iso) {
const days = daysSince(String(iso || '').slice(0, 10));
return days === 0 ? 'checked today' : days === 1 ? 'checked yesterday' : `checked ${days}d ago`;
}

// Amazon blocks server-side fetchers outright (confirmed live: a
// non-browser fetch to amazon.co.uk gets HTTP 503, where a real browser
// gets the real page) -- so an Amazon result routinely has no price, no
// matter how the AI search prompt is worded. The price-scrape
// bookmarklet (see Settings) is the workaround: it runs *inside* a real
// Amazon tab, so it isn't subject to that block at all.
//
// Two earlier ways of handing the scraped price back to this specific
// task both failed in the wild, for two different reasons -- worth
// recording so a third attempt doesn't repeat either mistake:
// 1. A "#dashTask=<id>" URL fragment on the Amazon link: Amazon's own
//    page JS rewrites the address bar via the History API about a
//    second after load (observed landing on "...?th=1"), dropping the
//    fragment before anyone's had time to click the bookmarklet.
// 2. window.name, set on the popup the moment it's opened (in theory
//    immune to #1, since a same-document History API call shouldn't
//    touch it): confirmed live as unreliable too -- this app is an
//    installed PWA, and an installed PWA navigating to an out-of-scope
//    origin routinely hands off to a genuinely separate browser
//    window/process rather than a same-context popup, which severs
//    window.name right along with it.
// Both depended on some property of the *browsing context* surviving
// Amazon's own page and the platform's own navigation handling -- which
// this app doesn't control and can't rely on. Clipboard sidesteps that
// entirely: the bookmarklet copies the scraped price, "Paste price"
// below reads it back on THIS specific result row. No shared browsing
// context required at all, so nothing about how the Amazon tab/window
// got opened matters.
function isAmazonUrl(url) {
return /amazon\./i.test(url || '');
}

const PASTE_PRICE_PREFIX = 'DASHPRICE:';

async function pastePrice(taskId, idx) {
const t = data.tasks.find((x) => x.id === taskId);
const r = t && t.priceCheck && t.priceCheck.results[idx];
if (!r) return;
let text;
try { text = await navigator.clipboard.readText(); } catch (err) {
alert('Could not read the clipboard — your browser may be blocking clipboard access for this page. Copy the bookmarklet\'s result manually and try again.');
return;
}
if (!text || !text.startsWith(PASTE_PRICE_PREFIX)) {
alert('Clipboard doesn’t have a scraped price on it — run the bookmarklet on the Amazon page first, then come back and click Paste price.');
return;
}
let payload;
try { payload = JSON.parse(text.slice(PASTE_PRICE_PREFIX.length)); } catch (err) {
alert('Could not read the copied price — try running the bookmarklet again.');
return;
}
if (payload.price) r.price = payload.price;
if (payload.subscribeSave) r.subscribeSave = payload.subscribeSave;
if (payload.url) r.url = payload.url;
if (payload.name) r.name = payload.name;
t.priceCheck.checkedAt = new Date().toISOString();
queueSave();
render();
banner(`Amazon price updated for "${t.title.slice(0, 60)}": ${payload.price || r.price}`);
}

function searchResultsHtml(t) {
const s = searchState.get(t.id);
if (s && s.status === 'loading') return '<div class="shop-search-results loading">Searching…</div>';
if (s && s.status === 'error') return `<div class="shop-search-results error">${s.missingKey ? `Add an Anthropic API key in ${MISSING_KEY_LINK_HTML} first.` : escapeHtml(s.message)}</div>`;
if (!t.priceCheck) return '';
const { results, recommendation, checkedAt } = t.priceCheck;
if (!results.length) return '<div class="shop-search-results empty">No results found.</div>';
return `<div class="shop-search-results">
${recommendation ? `<div class="shop-recommendation">${escapeHtml(recommendation)}</div>` : ''}
${results.map((r, idx) => `
<div class="shop-hit-row">
<a class="shop-search-hit" href="${escapeHtml(affiliateLink(r.url))}" target="_blank" rel="noopener noreferrer">
<span class="shop-hit-retailer">${escapeHtml(r.retailer || 'Link')}</span>
<span class="shop-hit-name">${escapeHtml(r.name || t.title)}</span>
${r.price ? `<span class="shop-hit-price">${escapeHtml(r.price)}</span>` : ''}
${r.offer ? `<span class="shop-hit-offer">${escapeHtml(r.offer)}</span>` : ''}
${r.subscribeSave ? `<span class="shop-hit-offer">${escapeHtml(r.subscribeSave)}</span>` : ''}
</a>${cashbackHtml({ retailer: r.retailer, url: r.url })}${isAmazonUrl(r.url) ? `<button class="sync-btn sm shop-paste-btn" type="button" data-shop-paste="${escapeHtml(t.id)}:${idx}" title="Paste the price copied by the Amazon bookmarklet">Paste price</button>` : ''}
</div>`).join('')}
<div class="shop-also">${escapeHtml(checkedAgoLabel(checkedAt))}</div>
</div>`;
}

// Who this is for, and whether it's being actively chased. Both live on
// the shopping row rather than behind "open the full task", because
// "whose is this" is the thing you scan a gift list for, and suspending
// something is a one-tap decision you make while looking at the list.
//
// The person is shown with connectionChipHtml, the one canonical way this
// app refers to a connection anywhere outside Dating (CLAUDE.md), so it
// leads back to her card -- where her sizes are.
function wantRowHtml(t) {
if (!t.forConnectionId) return '';
const conn = data.connections.find((c) => c.id === t.forConnectionId);
if (!conn) return '';
const suspended = t.wantState === 'suspended';
return `<span class="shop-want-for">${connectionChipHtml(conn)}</span>
<button class="sync-btn sm shop-want-state${suspended ? ' shop-want-suspended' : ''}" type="button" data-shop-want-toggle="${t.id}"
title="${suspended ? 'Suspended — kept on the list, but not checked for stock and never alerted on. Click to resume.' : 'Active — checked for stock whenever this retailer is checked. Click to suspend.'}">${suspended ? 'Suspended' : 'Active'}</button>`;
}

// Recording something already owned that never went through a want at
// all -- the other way an item reaches data.inventory, alongside
// offerToRecordOwned's "mark a want done" path below. A pasted link is
// never required: Brand/Style/Piece/Colour/Size stay plain text either
// way, since not everything owned has a surviving product page to paste
// (a gift, something bought secondhand).
//
// Two tiers of auto-fill from a link, not one, because they cost
// different things. "Fill from link" reads the URL's own slug --
// instant, no network -- but confirmed repeatedly this session that a
// slug is unreliable for colour, and sometimes for the piece name too.
// "Fetch exact colour" instead fetches the real product page and reads
// what it actually states -- the same parseProductPage path the stock
// check already trusts -- at the cost of a real request through the
// home agent, which is why it's a second, separate button rather than
// always run.
// A pick-chip row per field (pickChipHtml's own shape, utils.js) built
// from what's already on file across the WHOLE inventory, not just a
// fixed-list field like Drinking/Smoking -- brand/style/piece/size/
// colour all repeat heavily in practice (the same few retailers, the
// same handful of sizes), so most of the time this add form should be
// clicking, not typing. Kept as its own small local version rather than
// reusing pickChipHtml() directly: that function bakes its own add-input
// in under a `data-pick-add` attribute, and this dialog's existing
// val()/setVal() (and the Fill-from-link/Fetch-exact-colour autofill
// that already targets them) are built around `data-inv-new` -- a pill
// click here just writes into that SAME input rather than introducing a
// second attribute convention and a second source of truth to keep read
// in step with the first.
function chipFieldHtml(label, field, values) {
const chips = values.map((v) => `<span class="pick-chip" data-inv-pick-field="${escapeHtml(field)}" data-inv-pick-value="${escapeHtml(v)}">${escapeHtml(v)}</span>`).join('');
return `<label style="font-size:12px;display:block;margin-bottom:6px;">${label}
${chips ? `<div class="tag-editor" style="margin:2px 0 4px;">${chips}</div>` : ''}
<input type="text" autocomplete="off" class="tag-add-input" data-inv-new="${field}" style="width:100%;display:block;"></label>`;
}

// Sweeps everything Agent Provocateur-related into one list -- a want's
// own stock check, a set-completion search's rows, and owned inventory --
// into one shape: what triggered it, who it's for, and the price
// including whatever discount code the retailer's own page quoted (`net`/
// `code` already come straight from agentprovocateur.js's parseBlock, via
// stockwatch.js's resultFor -- nothing new to compute, just to gather).
// stockwatch.js's RETAILERS is Agent-Provocateur-only today (see its own
// header), so a want with a stockCheck IS an AP want -- no extra brand
// filter needed there.
function agentProReportRows() {
const rows = [];
data.tasks.forEach((t) => {
if (!t.stockCheck || !t.stockCheck.results || !t.stockCheck.results.length) return;
t.stockCheck.results.forEach((r) => {
rows.push({
trigger: 'Want', triggerDetail: t.title,
connectionId: t.forConnectionId || '',
label: [r.piece, r.colour].filter(Boolean).join(' · ') || t.title,
now: r.now, was: r.was, net: r.net, code: r.code,
url: r.url, checkedAt: t.stockCheck.checkedAt,
});
});
});
data.connections.forEach((conn) => {
const s = conn.setSearch;
if (!s) return;
[...(s.within || []), ...(s.discounted || [])].forEach((row) => {
rows.push({
trigger: 'Set search', triggerDetail: `Budget £${s.budget}`,
connectionId: conn.id,
label: [row.braPiece, row.colour].filter(Boolean).join(' · ') || 'Set',
now: row.bra?.now, was: row.bra?.was, net: row.net, code: row.bra?.code,
url: row.bra?.url, checkedAt: s.finishedAt || s.startedAt,
});
});
});
data.inventory.forEach((item) => {
if ((item.brand || '').trim().toLowerCase() !== 'agent provocateur') return;
rows.push({
trigger: 'Owned', triggerDetail: 'In inventory',
connectionId: item.holderId || '',
label: [item.style, item.piece, item.colour].filter(Boolean).join(' · '),
now: null, was: null, net: null, code: '',
url: item.link, checkedAt: item.acquiredAt,
});
});
return rows;
}

function agentProReportRowHtml(row) {
const conn = row.connectionId ? data.connections.find((c) => c.id === row.connectionId) : null;
const priceHtml = row.net != null
? `<strong>${escapeHtml(money(row.net))}</strong>${row.code ? ` <span class="settings-note" style="display:inline;margin:0;">with ${escapeHtml(row.code)}${row.now != null && row.now !== row.net ? ` (was ${escapeHtml(money(row.now))})` : ''}</span>` : ''}`
: row.now != null ? `<strong>${escapeHtml(money(row.now))}</strong>` : '<span class="settings-note" style="margin:0;">Owned — no price</span>';
return `<div class="shop-row" style="align-items:center;">
<span style="flex:1;min-width:0;">${row.url ? `<a href="${escapeHtml(affiliateLink(row.url))}" target="_blank" rel="noopener">${escapeHtml(row.label || 'Item')}</a>` : escapeHtml(row.label || 'Item')}</span>
<span class="settings-note" style="margin:0;min-width:110px;">${escapeHtml(row.trigger)}${row.triggerDetail ? ` &middot; ${escapeHtml(row.triggerDetail)}` : ''}</span>
${conn ? connectionChipHtml(conn) : '<span class="settings-note" style="margin:0;">Unassigned</span>'}
<span style="min-width:120px;text-align:right;">${priceHtml}</span>
</div>`;
}

// Priced rows cheapest-net-first, owned/no-price rows last -- this is a
// shopping list, so "what should I buy" sorts above "what I already have".
function agentProReportHtml() {
const rows = agentProReportRows();
if (!rows.length) return '<div class="empty">Nothing to show yet — run a want check or a set search first.</div>';
const sorted = [...rows].sort((a, b) => {
const av = a.net ?? a.now, bv = b.net ?? b.now;
if (av == null && bv == null) return 0;
if (av == null) return 1;
if (bv == null) return -1;
return av - bv;
});
return sorted.map(agentProReportRowHtml).join('');
}

function openAgentProReportDialog() {
const dialog = document.createElement('div');
dialog.className = 'mail-view-backdrop';
dialog.innerHTML = `<div class="mail-view-card" style="max-width:560px;">
<div class="mail-view-subject">Agent Provocateur — full report</div>
<div class="settings-note" style="margin:2px 0 8px;">Every want, set-completion search and owned piece for this retailer, in one list — trigger, who for, and price including any discount code found on the page.</div>
<div>${agentProReportHtml()}</div>
<div class="mail-view-actions">
<button class="sync-btn sm" type="button" data-apreport-close>Close</button>
</div>
</div>`;
document.body.appendChild(dialog);
bindConnectionChips(dialog);
hydratePhotoBackgrounds(dialog);
const close = () => dialog.remove();
bindBackdropClose(dialog, close);
dialog.querySelector('[data-apreport-close]').addEventListener('click', close);
}

function openAddInventoryDialog() {
const dialog = document.createElement('div');
dialog.className = 'mail-view-backdrop';
dialog.innerHTML = `<div class="mail-view-card" style="max-width:420px;">
<div class="mail-view-subject">Add to inventory</div>
<div class="settings-note" style="margin:2px 0 8px;">Something you already own. Paste the product page if there is one &mdash; it can fill in the details, including its exact colour &mdash; or just type them by hand.</div>
<label style="font-size:12px;display:block;margin-bottom:6px;">Product link <span class="settings-note" style="display:inline;margin:0;">(optional)</span><input type="text" autocomplete="off" class="tag-add-input" data-inv-new-link style="width:100%;display:block;" placeholder="https://www.agentprovocateur.com/..."></label>
<div class="sync-row" style="margin:0 0 8px;flex-wrap:wrap;">
<button class="sync-btn sm" type="button" data-inv-fill-link>Fill from link</button>
<button class="sync-btn sm" type="button" data-inv-fetch-details>Fetch exact colour&hellip;</button>
<span class="sync-status" data-inv-fetch-status></span>
</div>
${chipFieldHtml('Brand', 'brand', knownScalarValues(data.inventory, 'brand'))}
${chipFieldHtml('Style', 'style', knownScalarValues(data.inventory, 'style'))}
${chipFieldHtml('Piece', 'piece', knownScalarValues(data.inventory, 'piece'))}
${chipFieldHtml('Size', 'size', knownScalarValues(data.inventory, 'size'))}
${chipFieldHtml('Colour', 'colour', knownScalarValues(data.inventory, 'colour'))}
<div style="margin:8px 0;">Already with${connectionPickerHtml('inv-new-holder', "Nobody yet — it's in your own drawer")}</div>
<label style="font-size:12px;display:block;margin:0 0 8px;">Notes<textarea rows="2" data-inv-new="notes" style="width:100%;"></textarea></label>
<div class="mail-view-actions">
<button class="sync-btn sm" type="button" data-inv-new-cancel>Cancel</button>
<button class="add-btn" type="button" data-inv-new-save>Add</button>
</div>
</div>`;
document.body.appendChild(dialog);
bindConnPickers();
const close = () => dialog.remove();
bindBackdropClose(dialog, close);
dialog.querySelector('[data-inv-new-cancel]').addEventListener('click', close);

const val = (n) => dialog.querySelector(`[data-inv-new="${n}"]`).value.trim();
const setVal = (n, v) => { if (v) dialog.querySelector(`[data-inv-new="${n}"]`).value = v; };
dialog.querySelectorAll('[data-inv-pick-value]').forEach((chip) => {
chip.addEventListener('click', () => {
const field = chip.dataset.invPickField;
dialog.querySelectorAll(`[data-inv-pick-field="${field}"]`).forEach((c) => c.classList.toggle('active', c === chip));
setVal(field, chip.dataset.invPickValue);
});
});
const linkInput = dialog.querySelector('[data-inv-new-link]');
const status = dialog.querySelector('[data-inv-fetch-status]');

dialog.querySelector('[data-inv-fill-link]').addEventListener('click', () => {
const link = linkInput.value.trim();
const adapter = adapterFor(link);
if (!adapter || !adapter.specFromUrl) { status.textContent = 'No parser for that link.'; return; }
const spec = adapter.specFromUrl(link);
setVal('brand', spec.brand);
setVal('style', spec.style);
setVal('piece', (spec.pieces || [])[0]);
status.textContent = 'Filled in from the link itself — colour still needs typing, or try "Fetch exact colour".';
});

dialog.querySelector('[data-inv-fetch-details]').addEventListener('click', async () => {
const link = linkInput.value.trim();
const adapter = adapterFor(link);
if (!adapter || !adapter.parseProductPage) { status.textContent = 'No parser for that link.'; return; }
status.textContent = 'Fetching…';
try {
const { pages, errors } = await fetchPages([link]);
const html = pages.get(link);
if (!html) { status.textContent = errors[0]?.error || "Couldn't read that page."; return; }
const page = adapter.parseProductPage(html, link);
setVal('brand', adapter.RETAILER || '');
// The page's own name carries the style as its first word(s) -- same
// reasoning agentprovocateur.js's rangeFromName already relies on for
// the JSON-LD catalogue, reused here rather than re-guessed.
if (page.name && adapter.rangeFromName) setVal('style', adapter.rangeFromName(page.name));
setVal('piece', page.piece);
setVal('colour', page.colour);
status.textContent = 'Filled in from the real page.';
} catch (err) {
status.textContent = err.message || String(err);
}
});

dialog.querySelector('[data-inv-new-save]').addEventListener('click', () => {
data.inventory.push(blankInventoryItem({
brand: val('brand'), style: val('style'), piece: val('piece'),
size: val('size'), colour: val('colour'), notes: val('notes'),
holderId: dialog.querySelector('#inv-new-holder')?.value || '',
acquiredAt: todayStr(), link: linkInput.value.trim(),
}));
queueSave();
renderInventory();
close();
});
}

// The want -> has step. Prefilled from the want spec, but every field is
// editable before it's saved, because what arrives isn't always what was
// asked for -- the backup size, the second-choice colour. `fromTaskId`
// records where it came from so the owned row can lead back.
function offerToRecordOwned(t) {
const conn = data.connections.find((c) => c.id === t.forConnectionId);
if (!conn) return;
const spec = t.wantSpec || {};
const dialog = document.createElement('div');
dialog.className = 'mail-view-backdrop';
const field = (name, label, value, width) => `<label style="font-size:12px;display:block;margin-bottom:6px;">${label}<input type="text" autocomplete="off" class="tag-add-input" data-owned-new="${name}" value="${escapeHtml(value || '')}" style="width:${width || '100%'};display:block;"></label>`;
dialog.innerHTML = `<div class="mail-view-card" style="max-width:420px;">
<div class="mail-view-subject">Record this item?</div>
<div class="settings-note" style="margin:2px 0 8px;">Goes into your inventory. Tick the box once it's actually with ${escapeHtml(conn.name || 'her')} &mdash; until then it stays yours, and stays searchable by size.</div>
${field('brand', 'Brand', spec.brand)}
${field('style', 'Style', spec.style)}
${field('piece', 'Piece', (spec.pieces || [])[0])}
${field('size', 'Size', '', '90px')}
${field('colour', 'Colour', (spec.colours || [])[0], '140px')}
<label style="font-size:12px;display:block;margin:8px 0;"><input type="checkbox" data-owned-given> Already given to ${escapeHtml(conn.name || 'her')}</label>
<div class="mail-view-actions">
<button class="sync-btn sm" type="button" data-owned-cancel>Not now</button>
<button class="add-btn" type="button" data-owned-save>Add</button>
</div>
</div>`;
document.body.appendChild(dialog);
const close = () => dialog.remove();
bindBackdropClose(dialog, close);
dialog.querySelector('[data-owned-cancel]').addEventListener('click', close);
dialog.querySelector('[data-owned-save]').addEventListener('click', () => {
const val = (n) => dialog.querySelector(`[data-owned-new="${n}"]`).value.trim();
data.inventory.push(blankInventoryItem({
brand: val('brand'), style: val('style'), piece: val('piece'),
size: val('size'), colour: val('colour'),
// Held by her only if the "Given to her" box is ticked. Bought but
// not yet handed over is the honest default -- and it's the state
// that leaves the item findable by size if the moment never comes.
holderId: dialog.querySelector('[data-owned-given]').checked ? conn.id : '',
acquiredAt: todayStr(), fromTaskId: t.id,
// The want's own product page, carried across -- this never happened
// before `link` existed on an inventory row at all, so a want with a
// real product page attached still lost that trail the moment it
// turned into an owned item.
link: t.link || '',
}));
queueSave();
close();
});
}

// The pages a want points at. A want with none isn't broken -- it's just
// not watchable yet, and saying so is more useful than a silent absence,
// since "why has this never been checked" is otherwise unanswerable.
function watchRowHtml(t) {
if (!t.forConnectionId) return '';
const urls = seedWatchSpec(t).urls || [];
const supported = urls.filter((u) => adapterFor(u)).length;
return `<button class="sync-btn sm shop-watch-btn" type="button" data-shop-watch-edit="${t.id}"
title="${urls.length ? `${urls.length} page${urls.length === 1 ? '' : 's'} watched, ${supported} of them on a retailer with a parser` : 'No pages yet — paste the product URLs this want covers'}">${urls.length ? `👁 ${urls.length}` : '👁 add pages'}</button>`;
}

// ---- "Find other colours" search, persisted (see blankTask's colourSearch) --

// Compared with, not just stored as-is: the want's own URLs often carry
// extras a listing card never will -- a #selection.size=... fragment,
// confirmed live as the actual cause of a bra appearing twice after "Add
// ticked". The fragment-carrying original and the fragment-free listing
// result for the exact same product compared as different strings, so
// the "already have this" check missed it and added a near-duplicate.
// Stripped on both sides before comparing, so that can't happen again.
function stripFragment(url) {
return String(url || '').split('#')[0];
}

// Matches a browser-confirmed colour name against a fast-pass one --
// exact after trimming/casing. The browser reads AP's own "Colour: X"
// label verbatim; a fast-pass colour is read off a <product> card's alt
// text, which is the same label AP uses for that colour everywhere.
function sameColour(a, b) {
return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

// Reconciles one piece's fast-pass rows against a real click-through of
// its colour swatches. Matched by URL FIRST, not colour text -- each
// swatch click navigates to the site's own canonical page for that
// exact colourway, the same URL the fast pass's own catalogue/card
// scrape already carries, so it's a far more reliable key than the
// colour TEXT the two sources format differently. Confirmed live: a
// card's alt text reads "white red", the real on-page label reads
// "White/Red" -- same colour, never going to compare equal as strings,
// where their shared URL already does. Name matching is kept only as a
// fallback for the rare case a URL doesn't line up (a redirect, a
// tracking param).
//
// The three outcomes the user asked for by name: a fast row the browser
// also reached ('agreed'), a fast colour the browser didn't
// ('fast-only' -- possibly pulled off the swatches since, still shown
// rather than dropped), and a browser colour matching no fast row at
// all ('browser-only' -- a real colourway the catalogue/card scrape
// never surfaced, added as a new row). A still-blank fast row with no
// URL match either can't be named outright, but when the COUNT of those
// blanks exactly equals the count of leftover browser colours, pairing
// them in the order each was found is a reasonable bet -- flagged
// 'assumed' rather than presented as a plain match, since it's a count
// coincidence, not a name or url match.
function mergePieceColours(pieceRows, browserColours) {
const remaining = browserColours.map((b) => ({ ...b }));
const blank = [];
pieceRows.forEach((row) => {
const byUrl = remaining.findIndex((b) => stripFragment(b.url).toLowerCase() === stripFragment(row.url).toLowerCase());
if (byUrl !== -1) {
row.colour = remaining[byUrl].colour || row.colour;
row.image = row.image || remaining[byUrl].image || '';
row.colourSource = 'agreed';
remaining.splice(byUrl, 1);
return;
}
if (!row.colour) { blank.push(row); return; }
const byName = remaining.findIndex((b) => sameColour(b.colour, row.colour));
if (byName === -1) { row.colourSource = 'fast-only'; return; }
row.colourSource = 'agreed';
row.image = row.image || remaining[byName].image || '';
remaining.splice(byName, 1);
});
if (blank.length && blank.length === remaining.length) {
blank.forEach((row, i) => {
row.colour = remaining[i].colour;
row.image = remaining[i].image || '';
row.colourSource = 'assumed';
});
remaining.length = 0;
} else {
blank.forEach((row) => { row.colourSource = 'unresolved'; });
}
const extra = remaining.map((b) => ({
url: b.url, range: pieceRows[0]?.range, piece: pieceRows[0]?.piece,
colour: b.colour, image: b.image || '', price: null, inStock: null, colourSource: 'browser-only',
}));
return [...pieceRows, ...extra];
}

async function findColourways(taskId, { onProgress } = {}) {
const t = data.tasks.find((x) => x.id === taskId);
if (!t) return { error: 'No such task.' };
const spec = seedWatchSpec(t);
const first = (spec.urls || [])[0] || '';
const adapter = adapterFor(first);
const style = (spec.style || '').trim();
if (!adapter || !adapter.findRangeItems) return { error: 'No colour search for that retailer yet.' };
if (!style) return { error: "Set the style first — that's what the search matches on." };
if (onProgress) onProgress('Searching listings…');
const origin = new URL(first).origin;
const found = new Map();
// Two listings, because neither is complete: a category page renders a
// few hundred of a claimed several hundred products, so between them
// they find more colourways than either alone. Fetched through
// fetchPages() -- pacing, the known-refuser shortcut and the home-agent
// escalation all come free from reusing it, same as the stock check.
const paths = ['/sale', '/lingerie'];
const { pages, errors } = await fetchPages(paths.map((p) => origin + p));
paths.forEach((p) => {
const html = pages.get(origin + p);
if (!html) return;
// The JSON-LD catalogue AP embeds on every listing page is tried
// first -- EVERY product on the page, not the lazy-loaded slice of
// <product> cards findRangeItems reads. Confirmed live: a real search
// for "Lorna" found 11 items this way against 5 the card scrape saw
// from the identical fetch, including a colourway (Baby Pink/Blue)
// the card scrape had never once surfaced. Falls back to the card
// scrape only when a page's catalogue is empty (not every page
// carries one) -- which still reads colour/piece more precisely when
// a catalogue IS present, since the catalogue has no colour field of
// its own (see slugColourGuess's own comment on why that's a guess).
const ldItems = adapter.jsonLdRangeItems ? adapter.jsonLdRangeItems(html, style) : [];
if (ldItems.length) {
// A <product> card's colour (read off its image alt text) is reliable;
// a slug guess isn't -- confirmed live, AP's own slugs sometimes drop
// the "-in-" marker that guess depends on entirely ("...-suspender-
// red-red-35107", no "-in-" anywhere), so there's no boundary left to
// find the colour words from at all for that product. Built once per
// page and consulted first; slugColourGuess is the fallback, not the
// other way round.
const cardColours = new Map();
if (adapter.listingItems) {
adapter.listingItems(html).forEach((c) => { if (c.colour) cardColours.set(c.url, c.colour); });
}
ldItems.forEach((item) => {
if (found.has(item.url)) return;
found.set(item.url, {
url: item.url, range: item.range,
piece: item.name.slice(item.range.length).trim(),
colour: cardColours.get(item.url) || (adapter.slugColourGuess ? adapter.slugColourGuess(item.url) : ''),
image: item.image || '', price: item.price, inStock: item.inStock,
});
});
} else {
adapter.findRangeItems(html, style).forEach((item) => {
if (!found.has(item.url)) found.set(item.url, item);
});
}
});
if (!found.size && errors.length === paths.length) {
return { error: `Couldn't read either listing page (${errors[0]?.error || 'unknown error'}).` };
}
// Real browser fallback, for any piece the fast pass left a blank
// colour on. One session per PIECE, not per blank row: clicking through
// one product's swatches reveals every colourway of that piece in a
// single pass (confirmed live via page.colourVariants), so a second row
// of the same piece needs no session of its own.
const byPiece = new Map();
[...found.values()].forEach((r) => {
if (!byPiece.has(r.piece)) byPiece.set(r.piece, []);
byPiece.get(r.piece).push(r);
});
const flagged = [...byPiece.entries()].filter(([, rs]) => rs.some((r) => !r.colour));
if (flagged.length) {
const { run, AgentNotConfiguredError } = await import('../homeagent.js');
for (let i = 0; i < flagged.length; i++) {
const [piece, pieceRows] = flagged[i];
if (onProgress) onProgress(`Checking real colours for "${piece}" (${i + 1} of ${flagged.length})…`);
try {
const res = await run('page.colourVariants', { url: pieceRows[0].url }, { timeoutMs: 90000 });
byPiece.set(piece, mergePieceColours(pieceRows, res.results || []));
} catch (err) {
// Not fatal -- this piece just keeps whatever the fast pass found,
// blanks and all. An unconfigured agent means every remaining
// piece will fail the exact same way, so stop asking rather than
// wait out N more timeouts for nothing.
if (err instanceof AgentNotConfiguredError) break;
}
}
}
const already = new Set((spec.urls || []).map(stripFragment));
const rows = [...byPiece.values()].flat().filter((r) => !already.has(stripFragment(r.url)));
const colours = [...new Set(rows.map((r) => r.colour).filter(Boolean))];
const pieces = [...new Set(rows.map((r) => r.piece).filter(Boolean))];
return { rows, colours, pieces };
}

// Dialogs currently open, keyed by task id, so a running search can push
// a live update into one if it's still open -- same pattern and same
// reasoning as setfinder.js's liveDialogs. Does nothing if the dialog
// isn't open; the result is already saved to t.colourSearch either way.
const liveColourDialogs = new Map();

function runColourSearch(taskId) {
const t = data.tasks.find((x) => x.id === taskId);
if (!t) return;
t.colourSearch = {
status: 'running', progress: '', error: null,
startedAt: new Date().toISOString(), finishedAt: null,
rows: [], colours: [], pieces: [], addedUrls: [],
};
queueSave();
const refresh = () => liveColourDialogs.get(taskId)?.();
refresh();
findColourways(taskId, {
onProgress: (m) => { t.colourSearch.progress = m; queueSave(); refresh(); },
}).then((res) => {
if (res.error) Object.assign(t.colourSearch, { status: 'error', error: res.error });
else Object.assign(t.colourSearch, { status: 'done', rows: res.rows, colours: res.colours, pieces: res.pieces });
t.colourSearch.finishedAt = new Date().toISOString();
queueSave();
refresh();
}).catch((err) => {
Object.assign(t.colourSearch, { status: 'error', error: err.message || String(err), finishedAt: new Date().toISOString() });
queueSave();
refresh();
});
}

function watchEditorHtml(t) {
const spec = seedWatchSpec(t);
const urls = spec.urls || [];
return `<div class="mail-view-card" style="max-width:520px;">
<div class="mail-view-subject">Pages to watch</div>
<div class="settings-note" style="margin:2px 0 8px;">One product page per line. Each is checked for the sizes recorded on her card, with its own price and discount code &mdash; codes differ between pieces of the same set, so they're never assumed.</div>
<textarea class="settings-input" data-watch-urls rows="5" placeholder="https://www.agentprovocateur.com/apm0017410000-jayce-thong-19692">${escapeHtml(urls.join('\n'))}</textarea>
<div class="account-field-row" style="margin-top:8px;">
<label>Brand<input type="text" autocomplete="off" data-watch-spec="brand" value="${escapeHtml(spec.brand || '')}"></label>
<label>Style<input type="text" autocomplete="off" data-watch-spec="style" value="${escapeHtml(spec.style || '')}"></label>
</div>
<div class="account-field-row">
<label>Pieces <span class="settings-note" style="display:inline;margin:0;">(comma separated, blank = any)</span><input type="text" autocomplete="off" data-watch-spec="pieces" value="${escapeHtml((spec.pieces || []).join(', '))}" placeholder="Bra, Thong"></label>
<label>Colours <span class="settings-note" style="display:inline;margin:0;">(blank = any)</span><input type="text" autocomplete="off" data-watch-spec="colours" value="${escapeHtml((spec.colours || []).join(', '))}" placeholder="Navy, Cobalt"></label>
</div>
<div class="sync-row" style="margin-top:8px;">
<button class="sync-btn sm" type="button" data-watch-colours>Find other colours</button>
<span class="settings-note" style="margin:0;">Searches the retailer's listings for every item and colour in this style's range.</span>
</div>
<div class="settings-block" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--line);">
<div class="settings-note" style="margin:0 0 6px;">If checking says <strong>403</strong>, the retailer is refusing your web host &mdash; it won't answer a server, only a browser. Read the page in yours instead: copy the snippet, open the product page, paste it in the address bar, then come back and paste the result.</div>
<div class="sync-row">
<button class="sync-btn sm" type="button" data-watch-copy-snippet title="Run it on one product page">Copy snippet</button>
<button class="sync-btn sm" type="button" data-watch-copy-bulk title="Run it on a listing filtered to this style — reads every product and colourway in one go">Copy bulk snippet</button>
<button class="sync-btn sm" type="button" data-watch-paste-stock>Paste stock</button>
<span class="sync-status" data-watch-paste-status></span>
</div>
</div>
<div data-watch-colour-results></div>
<div class="mail-view-actions">
<button class="sync-btn sm" type="button" data-watch-cancel>Cancel</button>
<button class="sync-btn sm" type="button" data-watch-check>Save &amp; check now</button>
<button class="add-btn" type="button" data-watch-save>Save</button>
</div>
<div class="sync-status" data-watch-status></div>
</div>`;
}

// One shared preview element, created once and reused across every
// "Find other colours" dialog -- a hover-to-view image for a result row,
// per the user's own ask, rather than a thumbnail inline on every row
// (160 characters of range text already runs tight in this list).
// Positioned by mousemove, not CSS :hover alone, so it tracks the
// cursor regardless of where in a long, scrolled list the row sits.
let colourPreviewEl = null;
function bindColourHoverPreview(box) {
const preview = colourPreviewEl || (colourPreviewEl = (() => {
const img = document.createElement('img');
img.className = 'colour-hover-preview';
document.body.appendChild(img);
return img;
})());
const move = (e) => {
preview.style.left = `${e.clientX + 16}px`;
preview.style.top = `${e.clientY + 16}px`;
};
box.querySelectorAll('[data-watch-row-link][data-img]').forEach((a) => {
a.addEventListener('mouseenter', (e) => {
preview.src = a.dataset.img;
preview.style.display = 'block';
move(e);
});
a.addEventListener('mousemove', move);
a.addEventListener('mouseleave', () => { preview.style.display = 'none'; });
});
}

function openWatchEditor(t) {
const dialog = document.createElement('div');
dialog.className = 'mail-view-backdrop';
dialog.innerHTML = watchEditorHtml(t);
document.body.appendChild(dialog);
const close = () => { liveColourDialogs.delete(t.id); if (colourPreviewEl) colourPreviewEl.style.display = 'none'; dialog.remove(); };
bindBackdropClose(dialog, close);
const save = () => {
const lines = dialog.querySelector('[data-watch-urls]').value.split('\n').map((s) => s.trim()).filter(Boolean);
const val = (n) => dialog.querySelector(`[data-watch-spec="${n}"]`).value.trim();
const list = (n) => val(n).split(',').map((s) => s.trim()).filter(Boolean);
t.wantSpec = { brand: val('brand'), style: val('style'), pieces: list('pieces'), colours: list('colours'), urls: lines };
queueSave();
};
// Every item in this want's range, exact match against the typed style
// -- not just other colours of the one piece already being watched, and
// not a substring match that would also pull in a genuinely different
// range sharing the same word (see findRangeItems in agentprovocateur.js
// for why, and how the page is actually read).
//
// The search itself runs detached from this dialog (runColourSearch,
// writing to t.colourSearch) rather than inline here -- reopening this
// editor, even after a reload, has to show whatever the last search
// found, not start blank. renderColourResults is both the initial paint
// and the live-update callback pushed into while this dialog stays open.
const box = dialog.querySelector('[data-watch-colour-results]');
const coloursBtn = dialog.querySelector('[data-watch-colours]');
const renderColourResults = () => {
const search = t.colourSearch;
if (coloursBtn) coloursBtn.disabled = search?.status === 'running';
if (!search) { box.innerHTML = ''; return; }
if (search.status === 'running') { box.innerHTML = `<div class="settings-note">${escapeHtml(search.progress || 'Searching…')}</div>`; return; }
if (search.status === 'error') { box.innerHTML = `<div class="settings-note">${escapeHtml(search.error)}</div>`; return; }
const added = new Set(search.addedUrls || []);
// Also excludes anything already in the want's own URL list by now
// (stripping the fragment on both sides -- see stripFragment's own
// comment) -- the want can have grown since this search ran, e.g. a
// previous "Add ticked" in the same session.
const existing = new Set((seedWatchSpec(t).urls || []).map(stripFragment));
const rows = search.rows.filter((r) => !added.has(r.url) && !existing.has(stripFragment(r.url)));
// Reported as two separate facts rather than one list, per how the
// range actually works: every piece doesn't come in every colour, so
// "4 colours, 6 items" found across the range is real information a
// flat list of (piece, colour) rows hides -- you can see at a glance
// whether a colour you want exists at all before checking whether
// THIS piece happens to come in it.
// A colour-less row reads as "Suspender", and the colour isn't always
// recoverable at all (see findColourways' own comment on why) -- two
// different suspenders both blank then look IDENTICAL, with no way to
// tell them apart or know ticking one over the other matters. Confirmed
// live: two real, different Lorna suspenders came back this way. Rows
// that collide on their visible label get a short suffix from their own
// URL's trailing id (unique per product, confirmed from real SKUs) so
// there's always something to tell them apart by, even unlabelled.
const labelOf = (r) => `${r.piece}${r.colour ? ` — ${r.colour}` : ''}`;
const labelCounts = new Map();
rows.forEach((r) => { const l = labelOf(r); labelCounts.set(l, (labelCounts.get(l) || 0) + 1); });
// What the browser click-through actually told us about this row, per
// the user's own "best of" ask: agreed (both sources named the same
// colour) gets no note, since that's the strongest case and the common
// one; the other three are flagged so a fast-pass colour the browser
// didn't confirm, a count-based guess, and a genuinely new colourway
// the catalogue never listed all read differently.
const SOURCE_NOTE = { 'fast-only': ' — not seen live', assumed: ' — assumed match', 'browser-only': ' — confirmed live, new' };
const rowLabel = (r) => {
const base = labelOf(r);
const withId = (labelCounts.get(base) || 0) < 2 ? base : (() => {
const idMatch = /-(\d+)$/.exec(stripFragment(r.url));
return idMatch ? `${base} (#${idMatch[1]})` : base;
})();
return withId + (SOURCE_NOTE[r.colourSource] || '');
};
box.innerHTML = rows.length
? `<div class="settings-note" style="margin:6px 0 2px;">${search.colours.length} colour${search.colours.length === 1 ? '' : 's'} (${escapeHtml(search.colours.join(', '))}), ${search.pieces.length} item${search.pieces.length === 1 ? '' : 's'} (${escapeHtml(search.pieces.join(', '))}) found. Tick what to watch.</div>`
+ rows.map((r, i) => `<label style="display:block;font-size:12px;">
<input type="checkbox" data-watch-found="${i}" value="${escapeHtml(r.url)}">
<a href="${escapeHtml(affiliateLink(r.url))}" target="_blank" rel="noopener noreferrer" data-watch-row-link${r.image ? ` data-img="${escapeHtml(r.image)}"` : ''}>${escapeHtml(rowLabel(r))}</a>
</label>`).join('')
+ '<button class="sync-btn sm" type="button" data-watch-add-found style="margin-top:6px;">Add ticked</button>'
: '<div class="settings-note">Nothing new found — the listings only render part of a category, so an item can be missing from both.</div>';
// Without this, clicking the link also toggles the checkbox it shares a
// <label> with -- the label's own implicit behaviour, not anything this
// code asks for.
box.querySelectorAll('[data-watch-row-link]').forEach((a) => {
a.addEventListener('click', (e) => e.stopPropagation());
});
bindColourHoverPreview(box);
const addBtn = box.querySelector('[data-watch-add-found]');
if (addBtn) addBtn.addEventListener('click', () => {
const picked = [...box.querySelectorAll('[data-watch-found]:checked')].map((c) => c.value);
if (!picked.length) return;
const area = dialog.querySelector('[data-watch-urls]');
const current = area.value.split('\n').map((s) => s.trim()).filter(Boolean);
const merged = [...current, ...picked];
area.value = merged.join('\n');
// Persisted immediately rather than left for the editor's separate
// Save button -- "Add ticked" is a real action worth keeping on its
// own if the window is lost right after, same reasoning the search
// itself is now persisted for.
t.wantSpec = { ...seedWatchSpec(t), urls: merged };
search.addedUrls = [...(search.addedUrls || []), ...picked];
queueSave();
renderColourResults();
});
};
liveColourDialogs.set(t.id, renderColourResults);
renderColourResults();
if (coloursBtn) coloursBtn.addEventListener('click', () => {
// The style typed into this editor might not be saved onto the want
// yet -- the search reads it via seedWatchSpec(t), so it has to be.
save();
runColourSearch(t.id);
});
const snippetBtn = dialog.querySelector('[data-watch-copy-snippet]');
if (snippetBtn) snippetBtn.addEventListener('click', async () => {
const first = (dialog.querySelector('[data-watch-urls]').value.split('\n')[0] || '').trim();
const adapter = adapterFor(first) || adapterFor('https://www.agentprovocateur.com/');
const status = dialog.querySelector('[data-watch-paste-status]');
if (!adapter || !adapter.bookmarkletSource) { status.textContent = 'No snippet for that retailer.'; return; }
try {
await navigator.clipboard.writeText(adapter.bookmarkletSource());
status.textContent = 'Copied — paste it into the address bar on the product page.';
} catch (err) {
status.textContent = "Couldn't copy — your browser blocked clipboard access.";
}
});
const bulkBtn = dialog.querySelector('[data-watch-copy-bulk]');
if (bulkBtn) bulkBtn.addEventListener('click', async () => {
const first = (dialog.querySelector('[data-watch-urls]').value.split('\n')[0] || '').trim();
const adapter = adapterFor(first) || adapterFor('https://www.agentprovocateur.com/');
const style = dialog.querySelector('[data-watch-spec="style"]').value.trim();
const status = dialog.querySelector('[data-watch-paste-status]');
if (!adapter || !adapter.bulkBookmarkletSource) { status.textContent = 'No bulk snippet for that retailer.'; return; }
// The style is baked in at copy time rather than asked for on the page:
// it's already recorded on the want, and a snippet that prompts is one
// more thing to get wrong while standing in a browser tab.
if (!style) { status.textContent = 'Set the style first — the bulk snippet filters on it.'; return; }
try {
await navigator.clipboard.writeText(adapter.bulkBookmarkletSource(style));
status.textContent = `Copied. Run it on a listing showing ${style} — it reads every product and colourway.`;
} catch (err) {
status.textContent = "Couldn't copy — your browser blocked clipboard access.";
}
});
const pasteBtn = dialog.querySelector('[data-watch-paste-stock]');
if (pasteBtn) pasteBtn.addEventListener('click', async () => {
const status = dialog.querySelector('[data-watch-paste-status]');
status.textContent = 'Reading…';
// Saved first, so a URL typed in this session isn't lost by the paste
// writing over wantSpec underneath it.
save();
const res = await pasteStockFor(t);
if (res.error) { status.textContent = res.error; return; }
const inStock = res.results.filter((r) => r.available.length);
status.textContent = res.results.length === 1
? (inStock.length ? `${res.results[0].piece}: ${res.results[0].available.map((a) => a.size).join(', ')} in stock.` : `${res.results[0].piece}: nothing in her size.`)
: `${res.results.length} products read, ${inStock.length} with something in her size${res.skipped ? `. ${res.skipped} skipped as outside this want.` : '.'}`;
render();
});
dialog.querySelector('[data-watch-cancel]').addEventListener('click', close);
dialog.querySelector('[data-watch-save]').addEventListener('click', () => { save(); render(); close(); });
dialog.querySelector('[data-watch-check]').addEventListener('click', async () => {
save();
const status = dialog.querySelector('[data-watch-status]');
status.textContent = 'Checking…';
const res = await runStockCheck({ onProgress: (m) => { status.textContent = m; } });
status.textContent = res.error ? res.error : `Checked ${res.checked} page${res.checked === 1 ? '' : 's'}.`;
render();
setTimeout(close, res.error ? 4000 : 900);
});
}

function rowHtml(t, ctx) {
return `<div class="shop-row${t.bucket === 'done' ? ' done' : ''}${t.wantState === 'suspended' ? ' shop-row-suspended' : ''}">
<input type="checkbox" class="task-check" data-shop-done="${t.id}" ${t.bucket === 'done' ? 'checked' : ''}>
<span class="shop-title" data-shop-open="${t.id}">${escapeHtml(t.title || '(untitled)')}</span>
${dueBadge(t)}${otherContextsNote(t, ctx)}${wantRowHtml(t)}${watchRowHtml(t)}
${t.bucket === 'done' ? '' : `<button class="sync-btn sm shop-search-btn" type="button" data-shop-search="${t.id}">${t.priceCheck ? 'Refresh' : 'Search prices'}</button>`}
${searchResultsHtml(t)}${stockCheckHtml(t)}
</div>`;
}

function listsHtml() {
return SHOPPING_CONTEXTS.map((ctx) => {
const items = data.tasks.filter((t) => (t.contexts || []).includes(ctx) && (showDone || t.bucket !== 'done'));
if (items.length === 0) return '';
const sorted = [...items].sort((a, b) => {
if (a.bucket === 'done' && b.bucket !== 'done') return 1;
if (a.bucket !== 'done' && b.bucket === 'done') return -1;
return (a.due ? daysUntil(a.due) : Infinity) - (b.due ? daysUntil(b.due) : Infinity);
});
return `<div class="shop-list">
<h3>${escapeHtml(ctx)} <span class="task-section-count">${items.filter((t) => t.bucket !== 'done').length}</span></h3>
${sorted.map((t) => rowHtml(t, ctx)).join('')}
</div>`;
}).filter(Boolean).join('') || '<div class="empty">Nothing on any shopping list yet — capture something above.</div>';
}

function render() {
// Kept in step with the list: completing a want can add an inventory
// item, and giving one away removes it from the unassigned view.
renderInventory();
const el = document.getElementById('shopping-lists');
if (!el) return;
el.innerHTML = listsHtml();

el.querySelectorAll('[data-shop-done]').forEach((cb) => {
cb.addEventListener('change', () => {
const t = data.tasks.find((x) => x.id === cb.dataset.shopDone);
if (!t) return;
if (cb.checked) { t.bucket = 'done'; t.completedAt = new Date().toISOString(); }
else { t.bucket = 'next'; t.completedAt = ''; }
render();
queueSave();
// Ticking off a want for someone is the moment it stops being a want
// and starts being a thing she has. Offered rather than done silently:
// "ordered" and "arrived" aren't the same event, and the size and
// colour that actually shipped may not be the ones first wanted.
if (cb.checked && t.forConnectionId) offerToRecordOwned(t);
});
});
el.querySelectorAll('[data-shop-watch-edit]').forEach((btn) => {
btn.addEventListener('click', () => {
const t = data.tasks.find((x) => x.id === btn.dataset.shopWatchEdit);
if (t) openWatchEditor(t);
});
});
el.querySelectorAll('[data-shop-want-toggle]').forEach((btn) => {
btn.addEventListener('click', () => {
const t = data.tasks.find((x) => x.id === btn.dataset.shopWantToggle);
if (!t) return;
t.wantState = t.wantState === 'suspended' ? 'active' : 'suspended';
render();
queueSave();
});
});
bindConnectionChips(el);
// avatarHtml() only ever renders a [data-photo-bg] placeholder --
// hydratePhotoBackgrounds() is the separate, async step that actually
// fills in the real photo (utils.js's own doc comment on avatarHtml
// says so directly). This file never called it at all, on either
// connectionChipHtml() call site -- confirmed live as a real gap, not
// just the one reported: every connection chip in this whole file,
// "who this want is for" here and every inventory fit-match below, has
// only ever shown initials, never a real photo.
hydratePhotoBackgrounds(el);
el.querySelectorAll('[data-shop-open]').forEach((span) => {
span.addEventListener('click', async () => {
const { switchTab } = await import('../tabs.js');
switchTab('tasks');
// Closing it brings you back here rather than leaving you on Tasks.
revealTask(span.dataset.shopOpen, { returnTo: 'shopping' });
});
});
el.querySelectorAll('[data-shop-search]').forEach((btn) => {
btn.addEventListener('click', () => runSearch(btn.dataset.shopSearch));
});
el.querySelectorAll('[data-shop-paste]').forEach((btn) => {
btn.addEventListener('click', () => {
const [taskId, idx] = btn.dataset.shopPaste.split(':');
pastePrice(taskId, Number(idx));
});
});
}

// Every retailer a price search actually returned a result for joins
// data.cashbackTracked (stockwatch.js's registerCashbackTracked) so the
// weekly cashback sweep (scheduled.js) picks it up from now on, AND gets
// its own rate checked right now with forceLive -- a search run THIS
// second, about something you might buy in the next few minutes, should
// never show a cashback number that's merely "not yet due" by the
// background sweep's week-long standard. Best-effort and fire-and-forget:
// a cashback rate is a nicety layered on top of the price search, never a
// reason to hold up or fail it.
function trackAndRefreshCashback(results) {
if (!results || !results.length) return;
const sources = results.map((r) => ({ brand: r.retailer, url: r.url }));
registerCashbackTracked(sources);
refreshCashbackRates(sources, { forceLive: true }).then((r) => { if (r && r.checked) render(); }).catch(() => {});
}

async function runSearch(taskId) {
const t = data.tasks.find((x) => x.id === taskId);
if (!t) return;
searchState.set(taskId, { status: 'loading' });
render();
try {
const { results, recommendation } = await searchShoppingItem(t.title, t.link);
t.priceCheck = { checkedAt: new Date().toISOString(), results, recommendation };
searchState.delete(taskId);
queueSave();
trackAndRefreshCashback(results);
} catch (err) {
searchState.set(taskId, err instanceof MissingKeyError
? { status: 'error', missingKey: true }
: { status: 'error', message: err.message || String(err) });
}
render();
}

// The one place an automatic (not manually-clicked) price check runs —
// called right after capture from BOTH this file's own text box below and
// captureOutcomes.js's `supermarket` outcome (voice/image/URL), so every
// entry point gets the identical "captured, and already priced" result.
// Best-effort: a failure here is logged, not surfaced — the task is already
// captured either way, this is enrichment on top, and Search prices/Refresh
// is still sitting right there for a manual retry.
async function runAutoPriceCheck(task) {
try {
const { results, recommendation } = await searchShoppingItem(task.title, task.link);
task.priceCheck = { checkedAt: new Date().toISOString(), results, recommendation };
queueSave();
render();
trackAndRefreshCashback(results);
const { renderNudges } = await import('./nudges.js');
renderNudges();
} catch (err) {
console.error('Auto price-check failed, item stays without one until Search prices is used manually:', err);
}
}

// ---- Inventory ------------------------------------------------------------
//
// Things you've bought that nobody holds yet. The reason this is a panel
// and not an archive: an unassigned item is a real garment in a real
// size, and the useful question about it runs backwards from a want --
// not "what does she want" but "who does this fit". whoFits() answers
// that from everyone's recorded sizes, ranked so a same-retailer,
// same-category, usual-size hit beats a bare number coincidence.
// Sets first, loose items after. A set is the thing you'd actually give
// someone, and the question it raises is different from a single
// garment's: a complete one asks WHO, an incomplete one asks WHAT ELSE
// to buy and in whose size.
function inventorySetsHtml() {
const sets = inventorySets().filter((s) => s.items.length > 1 || s.complete);
if (!sets.length) return '';
return `<div class="inv-sets">${sets.map((set) => {
const name = [set.brand, set.style, set.colour].filter(Boolean).join(' · ') || 'Unnamed set';
const pieces = set.items.map((i) => `${escapeHtml(i.piece || '?')} ${escapeHtml(i.size || '')}`).join(', ');
const fits = whoFitsSet(set);
const head = set.complete
? `<span class="tag-chip tag-chip-green">Complete set</span>`
: `<span class="tag-chip tag-chip-amber">Needs ${escapeHtml(set.missing.join(' + '))}</span>`;
const body = fits.length
? fits.slice(0, 4).map((f) => `<div class="inv-fit-row">
${connectionChipHtml(f.conn)}
<span class="settings-note" style="margin:0;" title="${escapeHtml(f.reasons.join(' • '))}">${escapeHtml(f.interest)}</span>
${f.needed.filter((n) => n.size).map((n) => `<span class="tag-chip">buy ${escapeHtml(n.group.toLowerCase())} in ${escapeHtml(n.size)}</span>`).join('')}
${f.needed.filter((n) => !n.size).map((n) => `<span class="settings-note" style="margin:0;">no ${escapeHtml(n.group.toLowerCase())} size on file for her</span>`).join('')}
<button type="button" class="todo-add-btn" data-inv-give-set="${escapeHtml(set.key)}:${escapeHtml(f.conn.id)}" title="Record that she now has all of it">Give set</button>
</div>`).join('')
: `<div class="settings-note" style="margin:0;">${set.items.length > 1 ? 'Nobody on file fits every piece.' : 'Nobody on file fits it.'}</div>`;
return `<div class="inv-set">
<div class="inv-set-head"><strong>${escapeHtml(name)}</strong> ${head}</div>
<div class="settings-note" style="margin:0 0 4px;">${pieces}</div>
${body}
</div>`;
}).join('')}</div>`;
}

// Brand/style/piece/size/colour editable inline, exactly like a held
// item already is on its owner's own card (connections.js's
// ownedListHtml/data-owned-field) -- the same record, so the same
// editing convention, not a second one invented for this list.
// Confirmed live as a real gap: nothing here was editable at all before
// this, only Give and delete.
// Colour/size deliberately ignored -- resale value tracks the style and
// piece, not the exact colourway or size someone happens to own (the
// user's own framing), so two items differing only by colour share one
// cached estimate under data.ebayResaleEstimates rather than paying for
// the same eBay search twice.
function resaleKey(o) { return `${(o.style || '').trim().toLowerCase()}|${(o.piece || '').trim().toLowerCase()}`; }

function resaleValueHtml(o) {
if (!o.style && !o.piece) return '';
const key = resaleKey(o);
const cached = data.ebayResaleEstimates[key];
if (!cached) return `<button type="button" class="todo-add-btn" data-inv-resale="${escapeHtml(o.id)}" title="Search eBay for this style/piece (any colour/size) and estimate resale value">&#128176; Resale value?</button>`;
if (cached.status === 'running') return `<span class="settings-note" style="margin:0;">Checking eBay…</span>`;
if (cached.status === 'error') return `<span class="settings-note" style="margin:0;">${escapeHtml(cached.error)}</span> <button type="button" class="todo-add-btn" data-inv-resale="${escapeHtml(o.id)}">Retry</button>`;
const names = (cached.listings || []).map((l) => `${l.name}${l.condition ? ` (${l.condition})` : ''} — ${l.price}`).join('\n');
return `<span class="settings-note" title="${escapeHtml(names)}" style="margin:0;">${escapeHtml(cached.estimate || 'No comparable eBay listings found.')}</span> <button type="button" class="todo-add-btn" data-inv-resale="${escapeHtml(o.id)}" title="Re-check">&#8635;</button>`;
}

function inventoryHtml() {
const items = unheldInventory();
if (!items.length) return '<div class="empty">Nothing unassigned — everything recorded is with someone.</div>';
const field = (o, name, placeholder, width) => `<input type="text" autocomplete="off" placeholder="${placeholder}" data-inv-field="${name}" data-inv-id="${escapeHtml(o.id)}" value="${escapeHtml(o[name] || '')}" style="max-width:${width};">`;
return items.map((o) => {
const fits = whoFits(o);
const fitsHtml = fits.length
? fits.slice(0, 4).map(({ conn, how }) => `<span class="inv-fit" title="${escapeHtml(how)}">${connectionChipHtml(conn)}<button type="button" class="todo-add-btn" data-inv-assign="${escapeHtml(o.id)}:${escapeHtml(conn.id)}" title="Record that ${escapeHtml(conn.name || 'she')} now has this">Give</button></span>`).join('')
: `<span class="settings-note" style="margin:0;">${o.size ? 'Nobody on file takes this size.' : 'No size recorded — add one and this can find a match.'}</span>`;
const linkHtml = o.link
? `<a class="inv-link" href="${escapeHtml(affiliateLink(o.link))}" target="_blank" rel="noopener noreferrer" title="Open the product page this was bought from">&#128279;</a>`
: '';
return `<div class="shop-row inv-row">
${field(o, 'brand', 'Brand', '110px')}
${field(o, 'style', 'Style', '100px')}
${field(o, 'piece', 'Piece', '110px')}
${field(o, 'size', 'Size', '60px')}
${field(o, 'colour', 'Colour', '90px')}
${linkHtml}
<span class="inv-fits">${fitsHtml}</span>
${resaleValueHtml(o)}
<span class="del-x" style="opacity:1;" data-inv-remove="${escapeHtml(o.id)}" title="Delete this item">&times;</span>
</div>`;
}).join('');
}

// Shared cache key means this only ever actually searches once per
// style/piece even if several inventory rows (different colours/sizes)
// show the same button -- clicking any one of them fills the estimate
// for all of them, via the shared data.ebayResaleEstimates entry.
function checkEbayResaleValue(itemId) {
const item = data.inventory.find((i) => i.id === itemId);
if (!item) return;
const key = resaleKey(item);
data.ebayResaleEstimates[key] = { status: 'running' };
queueSave();
renderInventory();
(async () => {
try {
const { searchEbayResaleEstimate } = await import('../ai.js');
const query = [item.brand, item.style, item.piece].filter(Boolean).join(' ');
const { listings, estimate } = await searchEbayResaleEstimate(query);
data.ebayResaleEstimates[key] = { status: 'done', listings, estimate, checkedAt: new Date().toISOString() };
} catch (err) {
data.ebayResaleEstimates[key] = { status: 'error', error: err.message || String(err), checkedAt: new Date().toISOString() };
}
queueSave();
renderInventory();
})();
}

function renderInventory() {
const el = document.getElementById('inventory-list');
if (!el) return;
// Behind the same device-local gate as the sizes it matches against --
// showing "who fits this 36C bra" on an unlocked phone is exactly what
// that gate is for. See SENSITIVE_BLOCKS in state.js.
if (!sensitiveFieldsShown()) {
el.innerHTML = '<div class="settings-note" style="margin:0;">Hidden on this device. Turn on sensitive fields in <span class="inline-goto-link" data-goto-tab="settings" data-goto-target="#sensitive-fields-toggle">Settings</span> to show it.</div>';
return;
}
el.innerHTML = `<div class="sync-row" style="margin-bottom:8px;flex-wrap:wrap;">
<button class="sync-btn sm inv-inline-btn" type="button" data-inv-add-item>+ Add item</button>
<button class="sync-btn sm inv-inline-btn" type="button" data-find-set-for-her>Find a set for her…</button>
<button class="sync-btn sm inv-inline-btn" type="button" data-inv-recheck-fits title="Who fits is worked out fresh every time this panel renders, but nothing re-renders it just because a connection changed elsewhere -- click after adding someone new or updating a size">&#8635; Recheck fits</button>
<button class="sync-btn sm inv-inline-btn" type="button" data-ap-report title="Every want, set-completion search and owned piece for this retailer, in one list">&#128203; Full AP report</button>
<span class="settings-note" style="margin:0;">Searches the retailer for a bra and matching knickers in her size, under a budget.</span>
</div>` + inventorySetsHtml() + inventoryHtml();
bindConnectionChips(el);
hydratePhotoBackgrounds(el);
const addItemBtn = el.querySelector('[data-inv-add-item]');
if (addItemBtn) addItemBtn.addEventListener('click', () => openAddInventoryDialog());
const apReportBtn = el.querySelector('[data-ap-report]');
if (apReportBtn) apReportBtn.addEventListener('click', () => openAgentProReportDialog());
const findSetBtn = el.querySelector('[data-find-set-for-her]');
if (findSetBtn) findSetBtn.addEventListener('click', async () => {
const { openSetFinderDialog } = await import('./setfinder.js');
openSetFinderDialog();
});
// whoFits()/whoFitsSet() are already computed fresh on every call --
// nothing here is cached or saved -- but nothing triggers THIS panel's
// own re-render just because a connection was added or a size changed
// somewhere else (connections.js calls renderConnections(), not this).
// An already-open Inventory panel can sit showing stale suggestions
// until something inside it happens to re-render -- confirmed live as
// a real gap, not hypothetical, so this is a direct, one-click fix
// rather than trying to wire a cross-module render trigger for it.
const recheckBtn = el.querySelector('[data-inv-recheck-fits]');
if (recheckBtn) recheckBtn.addEventListener('click', () => renderInventory());
// Giving a whole set is one action, not one per garment -- that's the
// unit you'd actually hand over.
el.querySelectorAll('[data-inv-give-set]').forEach((btn) => {
btn.addEventListener('click', () => {
const [key, connId] = btn.dataset.invGiveSet.split(':');
const set = inventorySets().find((s) => s.key === key);
if (!set) return;
set.items.forEach((item) => {
const row = data.inventory.find((o) => o.id === item.id);
if (row) row.holderId = connId;
});
queueSave();
renderInventory();
});
});
el.querySelectorAll('[data-inv-field]').forEach((input) => {
input.addEventListener('change', () => {
const row = data.inventory.find((o) => o.id === input.dataset.invId);
if (!row) return;
row[input.dataset.invField] = input.value.trim();
queueSave();
// Re-rendered, unlike ownedListHtml's otherwise-identical handler --
// this list's whole point is whoFits()'s per-row suggestions, and
// those are keyed on exactly these fields (size above all). Leaving
// them stale after an edit would undercut the one thing this panel
// is for.
renderInventory();
});
});
el.querySelectorAll('[data-inv-assign]').forEach((btn) => {
btn.addEventListener('click', () => {
const [itemId, connId] = btn.dataset.invAssign.split(':');
const row = data.inventory.find((o) => o.id === itemId);
if (!row) return;
row.holderId = connId;
queueSave();
renderInventory();
});
});
el.querySelectorAll('[data-inv-remove]').forEach((x) => {
x.addEventListener('click', () => {
data.inventory = data.inventory.filter((o) => o.id !== x.dataset.invRemove);
queueSave();
renderInventory();
});
});
el.querySelectorAll('[data-inv-resale]').forEach((btn) => {
btn.addEventListener('click', () => checkEbayResaleValue(btn.dataset.invResale));
});
}

function initShopping() {
renderInventory();
const select = document.getElementById('shop-context-input');
const input = document.getElementById('shop-capture-input');
const doneToggle = document.getElementById('shop-show-done-toggle');
const status = document.getElementById('shop-capture-status');
const resolveBtn = document.getElementById('shop-resolve-btn');
if (!select || !input) return;

select.innerHTML = SHOPPING_CONTEXTS.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');

// Reuses the app's one connection picker (connections.js) rather than a
// bespoke <select> of names -- it already handles search, avatars and a
// long list, and keeps this consistent with every other place you point
// at a person.
const forMount = document.getElementById('shop-for-mount');
if (forMount) {
forMount.innerHTML = connectionPickerHtml('shop-for-input', 'For me');
bindConnPickers(forMount);
}
// The picker stores its choice in a hidden input keyed by that id.
const forPicker = document.getElementById('shop-for-input');

// "Resolve title" replaces the pasted URL in the box with a readable
// name -- and the URL was then simply gone, because `link` below was
// derived from whatever text remained, which is no longer a URL. So
// resolving a title silently threw away the link it was resolved FROM:
// no link on the task, and nothing for the stock watcher to check.
//
// Remembered here instead. Cleared the moment the text stops being the
// resolved title, so typing something else over it doesn't attach a URL
// that has nothing to do with what you ended up capturing.
let resolved = null; // { url, title }

const submit = () => {
const title = input.value.trim();
if (!title) return;
// Straight to "next", skipping Inbox triage — the context picked here
// already answers the one question triage exists to ask. A pasted
// link never resolved via the button still isn't lost -- becomes
// `link` regardless (and runAutoPriceCheck below already reads a
// link's own Amazon ASIN directly, see ai.js's shoppingSearchPrompt),
// only the title stays as the raw URL if you never clicked Resolve.
// Blank is the normal case (your own shopping); picking someone turns
// this into a want for her, which is what the stock checker reads her
// sizes from.
const forConnectionId = forPicker ? forPicker.value : '';
const task = captureTask({
title, contexts: [select.value], bucket: 'next',
link: (resolved && title === resolved.title) ? resolved.url : (looksLikeUrl(title) ? title : ''),
forConnectionId, wantState: 'active',
});
resolved = null;
input.value = '';
if (forPicker) setConnPickerValue('shop-for-input', '');
if (resolveBtn) resolveBtn.hidden = true;
render();
// Only Supermarket has a Tesco/Amazon price comparison that makes
// sense — Pharmacy/Black Friday/Aspirational purchases are a
// different "note it and reconsider later" pattern (see
// captureOutcomes.js's own naming note on the `supermarket` outcome).
if (select.value === 'Supermarket') runAutoPriceCheck(task);
};
document.getElementById('shop-capture-btn').addEventListener('click', submit);
input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
initMicCapture(document.getElementById('shop-capture-mic-btn'), input, status, submit);
if (resolveBtn) {
input.addEventListener('input', () => {
resolveBtn.hidden = !looksLikeUrl(input.value);
// Typing over the resolved title abandons the URL it came from.
if (resolved && input.value.trim() !== resolved.title) resolved = null;
});
resolveBtn.addEventListener('click', async () => {
const url = input.value.trim();
if (!looksLikeUrl(url)) return;
resolveBtn.disabled = true;
resolveBtn.textContent = 'Resolving…';
try {
const { resolveUrlTitle } = await import('../ai.js');
const title = await resolveUrlTitle(url);
if (title) { input.value = title; resolved = { url, title }; }
} catch (err) {
console.error('Resolving URL title failed:', err);
} finally {
resolveBtn.disabled = false;
resolveBtn.textContent = '✨ Resolve title';
resolveBtn.hidden = true;
}
});
}

if (doneToggle) {
doneToggle.addEventListener('change', (e) => { showDone = e.target.checked; render(); });
}
render();
}

export { initShopping, render as refreshShopping, runAutoPriceCheck, renderInventory };
