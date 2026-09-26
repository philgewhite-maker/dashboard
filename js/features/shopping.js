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
import { data, queueSave, SHOPPING_CONTEXTS, unheldInventory, whoFits } from '../state.js';
import { escapeHtml, affiliateLink, daysUntil, daysSince, uid, todayStr, MISSING_KEY_LINK_HTML, looksLikeUrl } from '../utils.js';
import { captureTask, revealTask } from './tasks.js';
import { connectionChipHtml, bindConnectionChips, connectionPickerHtml, bindConnPickers, setConnPickerValue, sensitiveFieldsShown } from './connections.js';
import { runStockCheck, stockCheckHtml, adapterFor, seedWatchSpec } from './stockwatch.js';
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
</a>${isAmazonUrl(r.url) ? `<button class="sync-btn sm shop-paste-btn" type="button" data-shop-paste="${escapeHtml(t.id)}:${idx}" title="Paste the price copied by the Amazon bookmarklet">Paste price</button>` : ''}
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
dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
dialog.querySelector('[data-owned-cancel]').addEventListener('click', close);
dialog.querySelector('[data-owned-save]').addEventListener('click', () => {
const val = (n) => dialog.querySelector(`[data-owned-new="${n}"]`).value.trim();
data.inventory.push({
id: uid(), brand: val('brand'), style: val('style'), piece: val('piece'),
size: val('size'), colour: val('colour'),
// Held by her only if the "Given to her" box is ticked. Bought but
// not yet handed over is the honest default -- and it's the state
// that leaves the item findable by size if the moment never comes.
holderId: dialog.querySelector('[data-owned-given]').checked ? conn.id : '',
acquiredAt: todayStr(), fromTaskId: t.id, notes: '',
});
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
<div class="mail-view-actions">
<button class="sync-btn sm" type="button" data-watch-cancel>Cancel</button>
<button class="sync-btn sm" type="button" data-watch-check>Save &amp; check now</button>
<button class="add-btn" type="button" data-watch-save>Save</button>
</div>
<div class="sync-status" data-watch-status></div>
</div>`;
}

function openWatchEditor(t) {
const dialog = document.createElement('div');
dialog.className = 'mail-view-backdrop';
dialog.innerHTML = watchEditorHtml(t);
document.body.appendChild(dialog);
const close = () => dialog.remove();
dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
const save = () => {
const lines = dialog.querySelector('[data-watch-urls]').value.split('\n').map((s) => s.trim()).filter(Boolean);
const val = (n) => dialog.querySelector(`[data-watch-spec="${n}"]`).value.trim();
const list = (n) => val(n).split(',').map((s) => s.trim()).filter(Boolean);
t.wantSpec = { brand: val('brand'), style: val('style'), pieces: list('pieces'), colours: list('colours'), urls: lines };
queueSave();
};
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
function inventoryHtml() {
const items = unheldInventory();
if (!items.length) return '<div class="empty">Nothing unassigned — everything recorded is with someone.</div>';
return items.map((o) => {
const label = [o.brand, o.style, o.piece, o.size, o.colour].filter(Boolean).join(' · ') || '(unlabelled item)';
const fits = whoFits(o);
const fitsHtml = fits.length
? fits.slice(0, 4).map(({ conn, how }) => `<span class="inv-fit" title="${escapeHtml(how)}">${connectionChipHtml(conn)}<button type="button" class="todo-add-btn" data-inv-assign="${escapeHtml(o.id)}:${escapeHtml(conn.id)}" title="Record that ${escapeHtml(conn.name || 'she')} now has this">Give</button></span>`).join('')
: `<span class="settings-note" style="margin:0;">${o.size ? 'Nobody on file takes this size.' : 'No size recorded — add one and this can find a match.'}</span>`;
return `<div class="shop-row">
<span class="shop-title">${escapeHtml(label)}</span>
<span class="inv-fits">${fitsHtml}</span>
<span class="del-x" style="opacity:1;" data-inv-remove="${escapeHtml(o.id)}" title="Delete this item">&times;</span>
</div>`;
}).join('');
}

function renderInventory() {
const el = document.getElementById('inventory-list');
if (!el) return;
// Behind the same device-local gate as the sizes it matches against --
// showing "who fits this 36C bra" on an unlocked phone is exactly what
// that gate is for. See SENSITIVE_BLOCKS in state.js.
if (!sensitiveFieldsShown()) {
el.innerHTML = '<div class="settings-note" style="margin:0;">Hidden on this device. Turn on sensitive fields in Settings to show it.</div>';
return;
}
el.innerHTML = inventoryHtml();
bindConnectionChips(el);
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
