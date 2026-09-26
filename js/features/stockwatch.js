// Turning wants into "you can buy this now".
//
// Not a page-watcher. A want already names a person, a brand, a style and
// the pieces you'd accept; her sizes live on her profile. So the check is
// a resolver: for every ACTIVE want, fetch the product pages it points
// at, read stock and price off each, and match what's available against
// the sizes she actually takes. The answer is a list of buyable
// combinations with what they'd cost, not a diff of what changed.
//
// Sizes are read at check time rather than stored on the want, which is
// the reason correcting a size on her profile fixes every want for her at
// once (see blankTask's wantSpec comment in state.js).
//
// Suspended wants are skipped entirely -- no fetch, no alert. That's what
// suspending is for: keeping the record without chasing it.
import { data, queueSave, whoFits, sizeGroupFor } from '../state.js';
import { escapeHtml } from '../utils.js';
import { fetchPageHtml, FilesNotConfiguredError } from '../files.js';
import * as agentProvocateur from '../retailers/agentprovocateur.js';

// One adapter per retailer, tried in order. Adding a second retailer is
// adding a module that exports matchesRetailer/parseProductPage and
// listing it here -- nothing else in this file is AP-specific.
const RETAILERS = [agentProvocateur];

function adapterFor(url) {
return RETAILERS.find((r) => r.matchesRetailer(url)) || null;
}

// Slowest adapter's spacing wins, applied between every fetch regardless
// of which site it's for. Agent Provocateur returns 403s for burst
// traffic (measured: 5 rapid fetches, 2 refused; the same URLs fine ~4s
// apart), and a stock check is a background job with nothing waiting on
// it, so there is no reason to go faster than the strictest site allows.
function spacingFor(adapters) {
return Math.max(0, ...adapters.map((a) => a.CHECK_SPACING_MS || 0));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every size this person takes for the kind of garment `page` is, at this
// retailer. Grouped, not name-matched: a page for an "Ouvert Brief" has
// to find a size recorded once as "Knickers" (see SIZE_GROUPS).
function wantedSizesFor(conn, page) {
if (!conn) return [];
const group = sizeGroupFor(page.piece);
const brand = String(page.retailer || '').trim().toLowerCase();
const out = [];
(conn.sizes || []).forEach((s) => {
const sameRetailer = String(s.retailer || '').trim().toLowerCase() === brand;
if (!sameRetailer) return;
const sameGroup = group && sizeGroupFor(s.category) === group;
if (!sameGroup) return;
if (s.usual) out.push({ size: s.usual, which: 'usual' });
if (s.backup) out.push({ size: s.backup, which: 'backup' });
});
return out;
}

// Does this page satisfy any part of the want? Colour and piece filters
// are only applied when the want actually states them -- an empty list
// means "any", not "none", which is the difference between a useful
// default and a want that can never match.
function pageMatchesWant(page, spec) {
const colours = (spec.colours || []).map((c) => c.trim().toLowerCase()).filter(Boolean);
if (colours.length && !colours.includes(String(page.colour || '').trim().toLowerCase())) return false;
const pieces = (spec.pieces || []).map((p) => p.trim().toLowerCase()).filter(Boolean);
if (pieces.length) {
const pageGroup = sizeGroupFor(page.piece);
const wanted = pieces.some((p) => {
if (String(page.piece || '').toLowerCase().includes(p)) return true;
const g = sizeGroupFor(p);
return !!g && g === pageGroup;
});
if (!wanted) return false;
}
return true;
}

// One product page, turned into whatever it means for one want.
function resultFor(page, conn, spec) {
const sizes = wantedSizesFor(conn, page);
const available = [];
const gone = [];
sizes.forEach(({ size, which }) => {
const row = page.sizes.find((s) => s.size.toLowerCase() === size.toLowerCase());
if (!row) return; // this retailer doesn't offer that size at all
if (row.inStock) available.push({ size, which, lastOne: row.lastOne });
else gone.push({ size, which });
});
return {
url: page.url, piece: page.piece, colour: page.colour, sku: page.sku,
was: page.was, now: page.now, code: page.code, discountPct: page.discountPct, net: page.net,
available, gone,
// No size rows for this retailer+group at all -- a different problem
// from "her size is sold out", and one only you can fix, so it's said
// rather than shown as an empty result.
noSizesOnFile: sizes.length === 0,
};
}

// ---- Running a check ------------------------------------------------------

// A want captured by pasting a product URL already HAS that URL, in
// t.link -- asking for it again in the watch editor was making you type
// what you'd already given. Derived on read rather than written at
// capture, so it also picks up a link added later, and so an explicitly
// emptied list stays empty: `urls` existing at all, even as [], means
// you've edited it and your answer wins.
//
// Shared with the editor deliberately. When this lived only in the UI, a
// want seeded this way was never actually CHECKED -- activeWants below
// looks for the same urls and found none until the editor had been
// opened and saved once.
function seedWatchSpec(t) {
const spec = t.wantSpec || {};
if (Array.isArray(spec.urls)) return spec;
const link = String(t.link || '').trim();
if (!link) return { ...spec, urls: [] };
const adapter = adapterFor(link);
const fromUrl = adapter && adapter.specFromUrl ? adapter.specFromUrl(link) : {};
// Anything already typed into the want outranks what the URL implies.
return {
brand: spec.brand || fromUrl.brand || '',
style: spec.style || fromUrl.style || '',
pieces: (spec.pieces && spec.pieces.length) ? spec.pieces : (fromUrl.pieces || []),
colours: spec.colours || [],
urls: [link],
};
}

function activeWants() {
return data.tasks.filter((t) => t.forConnectionId
&& t.wantState !== 'suspended'
&& t.bucket !== 'done'
&& seedWatchSpec(t).urls.length);
}

// Every distinct URL across the wants being checked, so two wants
// pointing at the same page cost one fetch rather than two -- the
// aggregation that makes this worth doing as one job instead of per-want.
function urlsToCheck(wants) {
const seen = new Set();
wants.forEach((t) => (seedWatchSpec(t).urls || []).forEach((u) => {
const url = String(u || '').trim();
if (url) seen.add(url);
}));
return [...seen];
}

async function runStockCheck({ onProgress } = {}) {
const wants = activeWants();
if (!wants.length) return { checked: 0, wants: 0, skipped: 'nothing active to check' };
const urls = urlsToCheck(wants);
const gap = spacingFor(RETAILERS);
const pages = new Map();
const errors = [];
for (let i = 0; i < urls.length; i++) {
const url = urls[i];
const adapter = adapterFor(url);
if (!adapter) { errors.push({ url, error: 'No parser for that retailer yet.' }); continue; }
if (onProgress) onProgress(`Checking ${i + 1} of ${urls.length}…`);
try {
const html = await fetchPageHtml(url);
pages.set(url, adapter.parseProductPage(html, url));
} catch (err) {
// A configuration problem is worth stopping for -- every remaining
// fetch would fail the same way, and pacing through them would take
// a minute to reach the same answer.
if (err instanceof FilesNotConfiguredError) return { error: err.message, checked: 0, wants: wants.length };
errors.push({ url, error: err.message || String(err) });
}
if (i < urls.length - 1) await sleep(gap);
}

const now = new Date().toISOString();
wants.forEach((t) => {
const conn = data.connections.find((c) => c.id === t.forConnectionId);
const spec = seedWatchSpec(t);
const results = (spec.urls || [])
.map((u) => pages.get(String(u || '').trim()))
.filter(Boolean)
.filter((page) => pageMatchesWant(page, spec))
.map((page) => resultFor(page, conn, spec));
// Same shape and lifecycle as priceCheck on a shopping item: null until
// checked, then a dated snapshot that survives a reload.
t.stockCheck = { checkedAt: now, results, errors: errors.filter((e) => (spec.urls || []).includes(e.url)) };
});
queueSave();
return { checked: urls.length, wants: wants.length, errors: errors.length };
}

// ---- What it produces -----------------------------------------------------

function money(n) {
if (n == null) return '';
return `£${Number.isInteger(n) ? n : n.toFixed(2)}`;
}

// Everything buyable right now, across every want, grouped by retailer.
// Grouped because that's how you'd actually act on it: one order, and a
// discount code applies per product within it.
function buyableNow() {
const byRetailer = new Map();
data.tasks.forEach((t) => {
if (!t.stockCheck || t.wantState === 'suspended') return;
const conn = data.connections.find((c) => c.id === t.forConnectionId);
t.stockCheck.results.forEach((r) => {
if (!r.available.length) return;
const key = 'Agent Provocateur';
const list = byRetailer.get(key) || [];
list.push({ task: t, conn, result: r });
byRetailer.set(key, list);
});
});
return byRetailer;
}

function resultLineHtml(r) {
const price = r.net != null && r.net !== r.now
? `<strong>${escapeHtml(money(r.net))}</strong> <span class="settings-note" style="display:inline;margin:0;">was ${escapeHtml(money(r.was))}, ${escapeHtml(money(r.now))} before ${escapeHtml(r.code)}</span>`
: `<strong>${escapeHtml(money(r.now))}</strong>${r.was ? ` <span class="settings-note" style="display:inline;margin:0;">was ${escapeHtml(money(r.was))}</span>` : ''}`;
const sizes = r.available.map((a) => `${escapeHtml(a.size)}${a.which === 'backup' ? ' (backup)' : ''}${a.lastOne ? ' — last one' : ''}`).join(', ');
const goneNote = !r.available.length && r.gone.length
? `<span class="settings-note" style="display:inline;margin:0;">${escapeHtml(r.gone.map((g) => g.size).join(', '))} sold out</span>` : '';
const noSizes = r.noSizesOnFile
? '<span class="settings-note" style="display:inline;margin:0;">no size on file for this — add one on her card</span>' : '';
return `<div class="stock-line${r.available.length ? ' stock-line-in' : ''}">
<a href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.piece)}${r.colour ? ` · ${escapeHtml(r.colour)}` : ''}</a>
${r.available.length ? `<span class="stock-sizes">${sizes}</span> ${price}` : `${goneNote}${noSizes}`}
</div>`;
}

// Shown on the shopping row itself, the same way priceCheck's results
// already are -- a want and what you can currently buy for it belong
// together, not on a separate screen.
function stockCheckHtml(t) {
if (!t.stockCheck) return '';
const { results, errors, checkedAt } = t.stockCheck;
if (!results.length && !(errors || []).length) return '';
const when = new Date(checkedAt);
const ago = Math.round((Date.now() - when.getTime()) / 3600000);
return `<div class="shop-search-results">
${results.map(resultLineHtml).join('')}
${(errors || []).map((e) => `<div class="stock-line"><span class="settings-note" style="margin:0;">Couldn't check ${escapeHtml(e.url)} — ${escapeHtml(e.error)}</span></div>`).join('')}
<div class="shop-also">checked ${ago < 1 ? 'just now' : `${ago}h ago`}</div>
</div>`;
}

export { runStockCheck, stockCheckHtml, buyableNow, activeWants, seedWatchSpec, wantedSizesFor, pageMatchesWant, resultFor, adapterFor };
