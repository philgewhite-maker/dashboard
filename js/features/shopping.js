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
import { data, queueSave, SHOPPING_CONTEXTS } from '../state.js';
import { escapeHtml, affiliateLink, daysUntil, daysSince, MISSING_KEY_LINK_HTML } from '../utils.js';
import { captureTask, revealTask } from './tasks.js';
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
<a class="shop-search-hit" href="${escapeHtml(affiliateLink(r.url))}" target="_blank" rel="noopener noreferrer">
<span class="shop-hit-retailer">${escapeHtml(r.retailer || 'Link')}</span>
<span class="shop-hit-name">${escapeHtml(r.name || t.title)}</span>
${r.price ? `<span class="shop-hit-price">${escapeHtml(r.price)}</span>` : ''}
${r.offer ? `<span class="shop-hit-offer">${escapeHtml(r.offer)}</span>` : ''}
${r.subscribeSave ? `<span class="shop-hit-offer">${escapeHtml(r.subscribeSave)}</span>` : ''}
</a>${isAmazonUrl(r.url) ? `<button class="sync-btn sm" type="button" data-shop-paste="${escapeHtml(t.id)}:${idx}" title="Paste the price copied by the Amazon bookmarklet">Paste price</button>` : ''}`).join('')}
<div class="shop-also">${escapeHtml(checkedAgoLabel(checkedAt))}</div>
</div>`;
}

function rowHtml(t, ctx) {
return `<div class="shop-row${t.bucket === 'done' ? ' done' : ''}">
<input type="checkbox" class="task-check" data-shop-done="${t.id}" ${t.bucket === 'done' ? 'checked' : ''}>
<span class="shop-title" data-shop-open="${t.id}">${escapeHtml(t.title || '(untitled)')}</span>
${dueBadge(t)}${otherContextsNote(t, ctx)}
${t.bucket === 'done' ? '' : `<button class="sync-btn sm shop-search-btn" type="button" data-shop-search="${t.id}">${t.priceCheck ? 'Refresh' : 'Search prices'}</button>`}
${searchResultsHtml(t)}
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
});
});
el.querySelectorAll('[data-shop-open]').forEach((span) => {
span.addEventListener('click', async () => {
const { switchTab } = await import('../tabs.js');
switchTab('tasks');
revealTask(span.dataset.shopOpen);
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

function initShopping() {
const select = document.getElementById('shop-context-input');
const input = document.getElementById('shop-capture-input');
const doneToggle = document.getElementById('shop-show-done-toggle');
const status = document.getElementById('shop-capture-status');
if (!select || !input) return;

select.innerHTML = SHOPPING_CONTEXTS.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');

const submit = () => {
const title = input.value.trim();
if (!title) return;
// Straight to "next", skipping Inbox triage — the context picked here
// already answers the one question triage exists to ask.
const task = captureTask({ title, contexts: [select.value], bucket: 'next' });
input.value = '';
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

if (doneToggle) {
doneToggle.addEventListener('change', (e) => { showDone = e.target.checked; render(); });
}
render();
}

export { initShopping, render as refreshShopping, runAutoPriceCheck };
