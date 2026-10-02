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
import { cashbackLinks, merchantSlug, parseRate, rateFor, rateKey, ageLabel } from '../cashback.js';
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
// The rest of the set. An Agent Provocateur bra page lists the matching
// knickers, thong and suspender with their own size selects, and the
// parser has been reading them into `alsoOnPage` all along -- this is
// where they stop being discarded. Her knicker size is a different size
// in a different group from her bra size, so each sibling is matched on
// its own name rather than the page's.
const alsoAvailable = [];
(page.alsoOnPage || []).forEach((sib) => {
const wanted = wantedSizesFor(conn, { piece: sib.name, retailer: page.retailer });
if (!wanted.length) return;
const got = [];
wanted.forEach(({ size, which }) => {
const row = (sib.sizes || []).find((s) => String(s.size).toLowerCase() === String(size).toLowerCase());
if (row && row.inStock) got.push({ size, which, lastOne: row.lastOne });
});
// Only what's actually available: a sold-out sibling is noise on a line
// whose job is "can this be bought as a set right now".
if (got.length) alsoAvailable.push({ name: sib.name, available: got, now: sib.now, was: sib.was, net: sib.net });
});

return {
alsoAvailable,
// Carried through, not dropped. Without it the stock line had no
// retailer name and cashbackHtml fell back to the hostname --
// "agentprovocateur", which slugs differently from the
// "agent-provocateur" the rate was stored under. The rate was fetched,
// stored and shown correctly on the shopping row, and was blank here,
// on the same screen, for the same shop.
retailer: page.retailer,
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

// Fetching a page, by whichever route can actually reach it.
//
// The proxy is tried first: it's on all the time and needs nothing at
// home running. When a retailer refuses it -- Agent Provocateur answers
// every request from the web host with a 403, product pages included --
// the home agent is asked instead, because it sits on a residential
// connection and the site has no objection to that. The difference is
// the address, not the request.
//
// One command carries every remaining URL rather than one each: the agent
// paces its own fetches and a single round trip beats a dozen polls.
// A host that refused the web host is remembered, because that refusal
// is about the SERVER'S ADDRESS and so applies to every page on that
// site, every time. Agent Provocateur refuses it outright: without this,
// every check spends a doomed request plus the 4-second spacing on each
// URL before the agent is asked at all.
//
// Re-probed after a fortnight rather than trusted forever: a block is
// someone else's policy and can be lifted, and finding that out costs
// one request a fortnight.
const REFUSAL_MEMORY_MS = 14 * 24 * 3600 * 1000;

function hostOf(url) {
try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

function knownRefuser(url) {
const seen = (data.proxyRefusals || {})[hostOf(url)];
return !!seen && Date.now() - new Date(seen.at).getTime() < REFUSAL_MEMORY_MS;
}

function rememberRefusal(url) {
if (!data.proxyRefusals || typeof data.proxyRefusals !== 'object') data.proxyRefusals = {};
const host = hostOf(url);
if (!host) return;
data.proxyRefusals[host] = { at: new Date().toISOString() };
queueSave();
}

function forgetRefusal(url) {
const host = hostOf(url);
if (host && data.proxyRefusals && data.proxyRefusals[host]) {
delete data.proxyRefusals[host];
queueSave();
}
}

async function fetchPages(urls, { onProgress } = {}) {
const pages = new Map();
const errors = [];
const gap = spacingFor(RETAILERS);
// Straight to the agent for hosts already known to refuse, so the only
// requests made to the server are ones that might work.
const refused = urls.filter(knownRefuser);
const skippedCount = refused.length;
const worthTrying = urls.filter((u) => !knownRefuser(u));
for (let i = 0; i < worthTrying.length; i++) {
const url = worthTrying[i];
if (onProgress) onProgress(`Checking ${i + 1} of ${worthTrying.length}…`);
try {
pages.set(url, await fetchPageHtml(url));
// It worked, so whatever was remembered about this host is wrong now.
forgetRefusal(url);
} catch (err) {
if (err instanceof FilesNotConfiguredError) throw err;
// A 403 is the retailer refusing this route, not a broken page --
// worth retrying somewhere else rather than reporting as an error.
if (/\b403\b/.test(err.message || '')) { refused.push(url); rememberRefusal(url); }
else errors.push({ url, error: err.message || String(err) });
}
if (i < worthTrying.length - 1) await new Promise((r) => setTimeout(r, gap));
}
if (refused.length) {
// Said accurately: this fired "N refused the server" even for URLs the
// server was never asked about, which reads as N fresh failures every
// time and made the refusal memory look broken when it was working.
if (onProgress) {
const fresh = refused.length - skippedCount;
onProgress(skippedCount && !fresh
? `${skippedCount} known to refuse the server — straight to the home agent…`
: fresh && skippedCount
? `${fresh} refused the server, ${skippedCount} known to — asking the home agent…`
: `${fresh} refused the server — asking the home agent…`);
}
try {
const { run } = await import('../homeagent.js');
const res = await run('page.fetch', { urls: refused }, { timeoutMs: 20000 + refused.length * 8000 });
(res?.pages || []).forEach((p) => {
if (p.html) pages.set(p.url, p.html);
else errors.push({ url: p.url, error: `${p.error || 'no page returned'} (via home agent)` });
});
} catch (err) {
// Said plainly: this is the one case where the answer isn't "try
// again", it's "nothing here can reach that site".
refused.forEach((url) => errors.push({
url,
error: `The retailer refused your web host (403), and the home agent couldn't be reached either — ${err.message || err}`,
}));
}
}
return { pages, errors };
}

async function runStockCheck({ onProgress } = {}) {
const wants = activeWants();
if (!wants.length) return { checked: 0, wants: 0, skipped: 'nothing active to check' };
const all = urlsToCheck(wants);
// Anything with no parser is rejected before a single byte is fetched.
const errors = all.filter((u) => !adapterFor(u)).map((url) => ({ url, error: 'No parser for that retailer yet.' }));
const urls = all.filter((u) => adapterFor(u));
let fetched;
try {
fetched = await fetchPages(urls, { onProgress });
} catch (err) {
// A configuration problem is worth stopping for -- every remaining
// fetch would fail the same way, and pacing through them would take a
// minute to reach the same answer.
if (err instanceof FilesNotConfiguredError) return { error: err.message, checked: 0, wants: wants.length };
throw err;
}
errors.push(...fetched.errors);
const pages = new Map();
fetched.pages.forEach((html, url) => {
try { pages.set(url, adapterFor(url).parseProductPage(html, url)); }
catch (err) { errors.push({ url, error: `Couldn't read that page: ${err.message || err}` }); }
});

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
// Rates last, so a stock answer never waits on them.
//
// Fed from the URLs the wants POINT AT, not from the pages that came
// back. Those are different things and the difference mattered: a
// retailer that refuses the proxy returns no pages, so keying off the
// fetched ones meant its rate never refreshed at all — and Agent
// Provocateur, the one retailer this was built for, refuses the proxy.
// A cashback rate is a fact about the shop, and worth having even on a
// day its product pages couldn't be read.
let rates = null;
try {
// The BRAND recorded on the want, not just the URL. A hostname has
// lost the word boundaries -- "agentprovocateur.com" slugs to
// "agentprovocateur", where the provider's page is "agent-provocateur"
// -- so the typed brand is the better source and the host only a
// fallback for wants that never got one.
rates = await refreshCashbackRates(
wants.map((t) => ({ brand: seedWatchSpec(t).brand, url: (seedWatchSpec(t).urls || [])[0] })),
{ onProgress },
);
} catch (err) {
// A rate is a nicety, so this never fails the stock check -- but
// swallowing the reason entirely meant two blank rates looked
// identical to two rates that are genuinely zero, with nothing
// anywhere saying which. Reported, then carried on from.
console.error('Cashback rates failed:', err);
rates = { error: err.message || String(err) };
if (onProgress) onProgress(`Stock checked. Cashback rates couldn't be read: ${err.message || err}`);
}
return { checked: urls.length, wants: wants.length, errors: errors.length, rates };
}

// ---- Reading a page pasted from your own browser --------------------------
//
// When a retailer refuses the proxy (Agent Provocateur 403s every request
// from the web host, product pages included), the page still loads fine in
// your browser. The adapter's bookmarklet parses it there and copies the
// result; this reads it back and files it exactly as a fetched check would,
// so everything downstream -- the row, the nudges, her card -- can't tell
// the difference and needs no special case.
async function pasteStockFor(task) {
const spec = seedWatchSpec(task);
const adapter = RETAILERS.find((r) => r.PASTE_STOCK_PREFIX);
if (!adapter) return { error: 'No paste format for that retailer.' };
let text;
try { text = await navigator.clipboard.readText(); } catch (err) {
return { error: "Couldn't read the clipboard — your browser may be blocking it for this page." };
}
if (!text || !text.startsWith(adapter.PASTE_STOCK_PREFIX)) {
return { error: 'Nothing copied from a product page yet — run the snippet on the page first.' };
}
let parsed;
try { parsed = JSON.parse(text.slice(adapter.PASTE_STOCK_PREFIX.length)); } catch (err) {
return { error: 'That copied text was unreadable — run the snippet again.' };
}
// One product or a whole listing's worth. The bulk snippet copies an
// array; the single-product one copies an object. Both land here, so
// there's one paste button rather than two that look alike.
const pages = Array.isArray(parsed) ? parsed : [parsed];
const conn = data.connections.find((c) => c.id === task.forConnectionId);
const matching = pages.filter((p) => pageMatchesWant(p, spec));
if (!matching.length) {
// Said rather than silently ignored: pasting the wrong page, or one
// the want's colour/piece filters exclude, is an easy mistake and a
// check that quietly did nothing would look like a bug.
return pages.length === 1
? { error: `That page is ${pages[0].piece}${pages[0].colour ? ` in ${pages[0].colour}` : ''}, which this want doesn't cover.` }
: { error: `None of those ${pages.length} products match this want's pieces and colours.` };
}
const results = matching.map((p) => resultFor(p, conn, spec));
const pastedUrls = new Set(results.map((r) => r.url));
const prev = (task.stockCheck?.results || []).filter((r) => !pastedUrls.has(r.url));
task.stockCheck = { checkedAt: new Date().toISOString(), results: [...prev, ...results], errors: [] };
// Remember the pages, so a later proxy check (or another paste) knows
// they're part of this want without being told twice. A bulk paste is
// therefore also how you'd add every colourway at once -- which is the
// job "Find other colours" does when the proxy isn't being refused.
const urls = [...new Set([...spec.urls, ...pastedUrls])];
task.wantSpec = { ...spec, urls };
queueSave();
// The paste route is the one that works when a retailer refuses the
// proxy, so it's the one most likely to be in use — and it wasn't
// refreshing rates at all. Rates come from the provider's site, not the
// retailer's, so this generally succeeds even when the product pages
// had to come via the clipboard. Never allowed to fail the paste.
// The pasted pages carry the retailer's proper name, which is what
// slugs correctly; the URL alone would give "agentprovocateur".
refreshCashbackRates(matching.map((p) => ({ brand: p.retailer, url: p.url }))).catch(() => {});
return { results, skipped: pages.length - matching.length };
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

// Put beside the product link, not somewhere in settings, because this
// is only useful in the second before you click through to buy. Shown
// even when a want is checked by the agent overnight -- the point is
// that the purchase itself goes the right way round.
function cashbackHtml(source) {
const links = cashbackLinks(source);
if (!links.length) return '';
return `<span class="cashback-links">${links.map((l) => {
const seen = rateFor(data.cashbackRates, l.id, merchantSlug(l.name));
// A rate older than a month is shown as history, not as a rate: the
// number is still interesting, but it has no business deciding which
// provider you click today.
const rate = seen && !seen.stale ? `${seen.upTo ? 'up to ' : ''}${seen.percent}%` : '';
const age = seen ? ageLabel(seen.ageMs) : '';
const title = seen
? `${l.label}: ${seen.upTo ? 'up to ' : ''}${seen.percent}% when last checked, ${age}${seen.due ? ' — due a refresh' : ''}. Opens their ${l.name} page, where the live rate is shown; click through from there so the purchase is tracked.`
: `Open ${l.label}'s ${l.name} page and click through from there, so the purchase is tracked. ${l.fetchable ? 'No rate checked yet.' : 'Their rate cannot be read from here — Cloudflare blocks every automated request — so it is only shown on their own page.'}`;
return `<a href="${escapeHtml(l.merchantUrl)}" target="_blank" rel="noopener noreferrer" class="cashback-link${seen && seen.due ? ' cashback-due' : ''}" title="${escapeHtml(title)}">${escapeHtml(l.label)}${rate ? ` <b>${escapeHtml(rate)}</b>` : ''}${age && rate ? `<span class="cashback-age">${escapeHtml(age)}</span>` : ''}</a>`;
}).join('')}</span>`;
}

// Refreshed alongside a stock check rather than on its own schedule: the
// check is already fetching and pacing against these same routes, and a
// rate is only wanted next to a product you're looking at anyway.
//
// Only retailers you actually have something for, and only those whose
// rate is older than a week. Both providers for each, since which one
// wins changes with their promotions -- that's the whole point of
// showing the number.
async function refreshCashbackRates(retailers, { onProgress } = {}) {
const wanted = [];
retailers.forEach((source) => {
cashbackLinks(source).forEach((l) => {
// A provider whose page cannot be fetched at all is not asked for one --
// see fetchable in js/cashback.js. Its link still shows; only the number
// beside it is missing.
if (!l.fetchable) return;
const slug = merchantSlug(l.name);
const seen = rateFor(data.cashbackRates, l.id, slug);
if (seen && !seen.due) return;
const key = rateKey(l.id, slug);
if (!wanted.some((w) => w.key === key)) wanted.push({ key, url: l.merchantUrl, provider: l.id, name: l.name });
});
});
if (!wanted.length) return { checked: 0 };
if (onProgress) onProgress(`Checking ${wanted.length} cashback rate${wanted.length === 1 ? '' : 's'}…`);
const { pages } = await fetchPages(wanted.map((w) => w.url));
let found = 0;
wanted.forEach((w) => {
const html = pages.get(w.url);
if (!html) { console.warn(`Cashback: ${w.name} page never came back`, w.url); return; }
const rate = parseRate(html, w.provider);
// A page that came back but didn't yield a rate is left alone rather
// than cached as "nothing": the markup may simply have moved, and
// overwriting a good older number with a blank helps nobody. It is
// still worth saying, because "the page loaded and I couldn't read it"
// and "the page never loaded" need different fixes.
if (!rate) { console.warn(`Cashback: ${w.name} page loaded but no rate found in it`, w.url); return; }
data.cashbackRates[w.key] = { ...rate, at: new Date().toISOString(), url: w.url };
found += 1;
});
if (found) queueSave();
return { checked: wanted.length, found };
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
${r.available.length ? cashbackHtml({ retailer: r.retailer, url: r.url }) : ''}
${setHtml(r)}
</div>`;
}

// The rest of the set, in her sizes, under the piece that was wanted.
// Shown only when the main piece is available: "the thong is in" is not
// useful on its own when the bra it matches is sold out, and this line is
// answering "can I buy this as a set".
function setHtml(r) {
if (!r.available.length || !(r.alsoAvailable || []).length) return '';
return `<div class="stock-set">${r.alsoAvailable.map((s) => {
const sizes = s.available.map((a) => `${escapeHtml(a.size)}${a.which === 'backup' ? ' (backup)' : ''}${a.lastOne ? ' — last one' : ''}`).join(', ');
const price = s.net != null && s.net !== s.now ? money(s.net) : money(s.now);
return `<span class="stock-set-item">+ ${escapeHtml(s.name)} <span class="stock-sizes">${sizes}</span> ${escapeHtml(price)}</span>`;
}).join('')}</div>`;
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

export { runStockCheck, stockCheckHtml, cashbackHtml, refreshCashbackRates, buyableNow, activeWants, seedWatchSpec, pasteStockFor, wantedSizesFor, pageMatchesWant, resultFor, adapterFor };
