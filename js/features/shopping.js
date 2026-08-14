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
import { data, queueSave, SHOPPING_CONTEXTS } from '../state.js';
import { escapeHtml, daysUntil } from '../utils.js';
import { captureTask, revealTask } from './tasks.js';
import { MissingKeyError, searchShoppingItem } from '../ai.js';

let showDone = false;
// Search results are a working set for the current screen, not app data —
// re-searching costs nothing structurally, so nothing here is persisted.
const searchState = new Map(); // taskId -> { status: 'loading'|'done'|'error', results, message }

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

function searchResultsHtml(t) {
const s = searchState.get(t.id);
if (!s) return '';
if (s.status === 'loading') return '<div class="shop-search-results loading">Searching…</div>';
if (s.status === 'error') return `<div class="shop-search-results error">${escapeHtml(s.message)}</div>`;
if (s.results.length === 0) return '<div class="shop-search-results empty">No results found.</div>';
return `<div class="shop-search-results">${s.results.map((r) => `
<a class="shop-search-hit" href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer">
<span class="shop-hit-retailer">${escapeHtml(r.retailer || 'Link')}</span>
<span class="shop-hit-name">${escapeHtml(r.name || t.title)}</span>
${r.price ? `<span class="shop-hit-price">${escapeHtml(r.price)}</span>` : ''}
</a>`).join('')}</div>`;
}

function rowHtml(t, ctx) {
return `<div class="shop-row${t.bucket === 'done' ? ' done' : ''}">
<input type="checkbox" class="task-check" data-shop-done="${t.id}" ${t.bucket === 'done' ? 'checked' : ''}>
<span class="shop-title" data-shop-open="${t.id}">${escapeHtml(t.title || '(untitled)')}</span>
${dueBadge(t)}${otherContextsNote(t, ctx)}
${t.bucket === 'done' ? '' : `<button class="sync-btn sm shop-search-btn" type="button" data-shop-search="${t.id}">Search prices</button>`}
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
}

async function runSearch(taskId) {
const t = data.tasks.find((x) => x.id === taskId);
if (!t) return;
searchState.set(taskId, { status: 'loading' });
render();
try {
const results = await searchShoppingItem(t.title);
searchState.set(taskId, { status: 'done', results });
} catch (err) {
const message = err instanceof MissingKeyError ? 'Add an Anthropic API key in Settings first.' : (err.message || String(err));
searchState.set(taskId, { status: 'error', message });
}
render();
}

function initShopping() {
const select = document.getElementById('shop-context-input');
const input = document.getElementById('shop-capture-input');
const doneToggle = document.getElementById('shop-show-done-toggle');
if (!select || !input) return;

select.innerHTML = SHOPPING_CONTEXTS.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');

const submit = () => {
const title = input.value.trim();
if (!title) return;
// Straight to "next", skipping Inbox triage — the context picked here
// already answers the one question triage exists to ask.
captureTask({ title, contexts: [select.value], bucket: 'next' });
input.value = '';
render();
};
document.getElementById('shop-capture-btn').addEventListener('click', submit);
input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });

if (doneToggle) {
doneToggle.addEventListener('change', (e) => { showDone = e.target.checked; render(); });
}
render();
}

export { initShopping, render as refreshShopping };
