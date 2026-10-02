// Reading an Agent Provocateur product page. No AI, and deliberately so.
//
// Everything wanted is already structured in the page, which was checked
// against the real site rather than assumed:
//
//   * The page is SERVER-rendered (Angular Universal), so a plain fetch
//     gets the same HTML a browser sees. No headless browser needed.
//   * Every size is an <option> whose own text carries the stock state:
//     "34C", "32A - Sold Out", "1 - Only one left".
//   * Prices are <price> elements -- a custom tag, pleasantly stable --
//     with the old price marked by a `line-through` class.
//   * A server fetch returns a LIGHTER page than a browser gets. Checked
//     both ways on the same URL: a browser sees 5 size selects (the whole
//     "wear with" set) and 2 JSON-LD blocks; a plain fetch sees 1 select
//     and no JSON-LD. The main product's sizes, prices and offer are all
//     there, which is everything this needs -- but the set siblings and
//     the JSON-LD `sku` are NOT, so nothing here may depend on them.
//     Hence one fetch per product, and the SKU read from the URL.
//
//     That's no loss: the discount code has to be read from each
//     product's own page anyway (see below), so a per-product fetch was
//     always required for pricing.
//
//   * AP RATE-LIMITS bursts. Five rapid sequential fetches returned 403
//     for two of them; the same URLs returned 200 when paced a few
//     seconds apart. Anything checking several products must space them
//     out rather than firing in parallel -- see CHECK_SPACING_MS.
//
// Two things learned the hard way and encoded here:
//
//   * The DISCOUNT CODE is per product, NOT per basket and not per
//     style+colour. On the navy Jayce set the bra, brief and thong each
//     carry EXTRA30 and the suspender carries nothing. So the code is
//     only ever read from the page of the exact product being priced --
//     never inherited from a sibling on the same page, never taken from
//     the site-wide banner.
//   * The URL slug is unreliable. Some carry the colour
//     ("...-jayce-thong-in-cobalt-14723"), some don't
//     ("...-jayce-thong-19692", which is Navy). The colour is read from
//     the page's own "Colour: X" line instead, which works for both.
const HOST = 'agentprovocateur.com';
// The retailer's proper name, exported so every path that needs to name
// this shop gets the SAME string. It used to live only inside the parsed
// result, so anything running BEFORE a page was fetched -- the cashback
// refresh -- fell back to the hostname and got "agentprovocateur", which
// slugs differently from "agent-provocateur". The rate was then stored
// under one key and read under another: fetched fine, displayed never,
// and no error anywhere to say so.
const RETAILER = 'Agent Provocateur';
// A plain request -- proxy or home agent, with or without a browser's
// TLS fingerprint -- plateaus at 73,705 bytes and one size select,
// against 194,677 bytes and five in a real browser. Measured across
// every request shape tried (see home-agent/agent.py's page.fetch
// history), not assumed: the "Wear with" set is added by JavaScript
// after the page loads, which nothing but running the page supplies.
// Read by stockwatch.js to prefer page.render for this retailer's
// product pages when the home agent's browser container is up, and to
// fall back to the plain fetch exactly as before when it isn't --
// named here because it's a fact ABOUT this retailer, the same reason
// RETAILER and HOST live in this file rather than in the generic
// fetch pipeline.
const NEEDS_BROWSER_FOR_FULL_PAGE = true;
// Gap between fetches when checking several products. Chosen from the
// measured failure above, not guessed: bursts got 403s, ~4s apart did not.
const CHECK_SPACING_MS = 4000;

// The SKU lives in the URL's own first path segment, but there is more
// than one shape: "apm0017410000-..." (APM + 10 digits) alongside
// "ap11129651430-..." (AP + 11), found on a real Lorna URL. Both match;
// only the APM form splits into style and colour codes, and skuParts
// returns null for the other rather than inventing a split.
function skuFromUrl(url) {
const m = /\/(apm?\d{10,11})-/i.exec(String(url || ''));
return m ? m[1].toUpperCase() : '';
}

// What a URL alone says, before anything is fetched -- used to pre-fill a
// watch from the link pasted at capture, so the same URL isn't typed
// twice. Best-effort and freely correctable: a starting point, not an
// answer.
function specFromUrl(url) {
const base = String(url || '').split(/[#?]/)[0];
const m = /\/apm?\d{10,11}-([a-z0-9-]+?)-\d+$/i.exec(base);
const spec = { brand: 'Agent Provocateur', style: '', pieces: [] };
if (!m) return spec;
// "lorna-plunge-underwired-bra-in-dark-pink-cobalt" -> style "Lorna",
// piece "Plunge Underwired Bra". The colour half is deliberately NOT
// taken from the slug: it renders "Dark Pink/Cobalt" as
// "dark-pink-cobalt", indistinguishable from a two-word colour, and the
// page states it properly anyway.
const words = m[1].split('-in-')[0].split('-').filter(Boolean);
const titled = (a) => a.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
if (words.length) spec.style = titled(words.slice(0, 1));
if (words.length > 1) spec.pieces = [titled(words.slice(1))];
return spec;
}

function matchesRetailer(url) {
return new RegExp(`(^|\\.)${HOST.replace('.', '\\.')}`, 'i').test(String(url || ''));
}

// "APM0017410000" -> {style:'0017', colour:'410000'}. The SKU is the one
// rigid identifier: style is the garment, colour is the colourway, and
// together they're what makes two URLs the same product in a different
// colour. Slug words and the trailing numeric id are not derivable from
// each other, which is why colour substitution in a URL doesn't work.
function skuParts(sku) {
const m = /^APM(\d{4})(\d{6})$/i.exec(String(sku || '').trim());
return m ? { style: m[1], colour: m[2] } : null;
}

function priceNumber(text) {
const m = /([\d]+(?:\.\d{1,2})?)/.exec(String(text || '').replace(/,/g, ''));
return m ? parseFloat(m[1]) : null;
}

// An <option>'s text is the whole truth about one size: the label, and
// whether it can be bought. "Only one left" is IN STOCK -- it's a
// scarcity note, and treating it as unavailable would hide exactly the
// item most worth being told about.
function parseSizeOption(text) {
const raw = String(text || '').trim();
if (!raw || /^select size$/i.test(raw)) return null;
const soldOut = /-\s*sold\s*out\s*$/i.test(raw);
const lastOne = /-\s*only\s+one\s+left\s*$/i.test(raw);
const label = raw.replace(/\s*-\s*(sold\s*out|only\s+one\s+left)\s*$/i, '').trim();
if (!label) return null;
return { size: label, inStock: !soldOut, lastOne };
}

// One product block: a heading, its own price pair, its own offer line,
// and its own size select. Used for both the main product and each
// "Wear with" sibling, which have the same shape.
function parseBlock(root, doc) {
const select = root.querySelector('select');
const prices = [...root.querySelectorAll('price')];
const wasEl = prices.find((p) => /line-through/.test(p.className || ''));
const nowEl = prices.find((p) => !/line-through/.test(p.className || ''));
// Scoped to this block, never to the document: the whole point of the
// per-product finding above.
const offerEl = [...root.querySelectorAll('p, span, div')]
.filter((e) => e.children.length === 0)
.find((e) => /%\s*off with code/i.test(e.textContent || ''));
const offer = offerEl && /(\d+)%\s*off with code:?\s*([A-Z0-9]+)/i.exec(offerEl.textContent);
const now = priceNumber(nowEl?.textContent);
const pct = offer ? Number(offer[1]) : 0;
return {
sizes: select ? [...select.options].map((o) => parseSizeOption(o.text)).filter(Boolean) : [],
was: priceNumber(wasEl?.textContent),
now,
code: offer ? offer[2].toUpperCase() : '',
discountPct: pct,
// What you'd actually pay. Rounded to the penny because a percentage
// off a price like £25 lands on 17.5 and would otherwise render as
// "17.5".
net: now == null ? null : Math.round(now * (1 - pct / 100) * 100) / 100,
};
}

// The main product's own heading block -- brand line, h1, prices, offer.
function parseMain(doc) {
const h1 = doc.querySelector('h1');
const head = h1 ? h1.closest('div') : null;
const ld = [...doc.querySelectorAll('script[type="application/ld+json"]')]
.map((s) => { try { return JSON.parse(s.textContent); } catch (e) { return null; } })
.find((j) => j && j['@type'] === 'Product');
const colourLine = [...doc.querySelectorAll('span, p, div')]
.filter((e) => e.children.length === 0)
.map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim())
.find((t) => /^colour:/i.test(t));
const block = head ? parseBlock(head, doc) : { sizes: [], was: null, now: null, code: '', discountPct: 0, net: null };
// The size select sits outside the heading block (the heading holds
// name/price/offer only), so it's found separately -- and it must be
// found CAREFULLY.
//
// A proxy-fetched page has one select, so taking the first worked. A
// browser-fetched page carries the whole set: five selects, and on the
// bra's own page the first in document order is a KNICKERS one. Taking
// the first there reported sizes 1-6 as the bra's, which doesn't fail
// loudly -- it quietly answers about the wrong garment, and a want for
// a 34C would simply never match.
//
// The main product's select is the one whose price-bearing block also
// names the h1. Verified on the bra and thong pages of the same set:
// exactly one select matches, and it's the right one each time.
if (!block.sizes.length) {
const name = h1 ? h1.textContent.trim() : '';
const selects = [...doc.querySelectorAll('select')];
const owned = name ? selects.find((sel) => {
let n = sel, box = null;
for (let d = 0; d < 8 && n; d++) {
n = n.parentElement;
if (n && /£\s?\d/.test(n.textContent || '')) { box = n; break; }
}
return box && (box.textContent || '').replace(/\s+/g, ' ').includes(name);
}) : null;
// Falls back to the first only when nothing names the product, which
// is the single-select page the proxy returns.
const mainSelect = owned || selects[0];
// Kept so parseSiblings can skip THIS element rather than guessing from
// a name. On the page the proxy returns there is no JSON-LD and no h1,
// so the name is empty and every name-based test silently matched
// nothing -- which is how the main product came back as its own set
// piece twice over.
block.mainSelect = mainSelect;
if (mainSelect) block.sizes = [...mainSelect.options].map((o) => parseSizeOption(o.text)).filter(Boolean);
}
return {
...block,
sku: (ld && ld.sku) || '',
name: (ld && ld.name) || (h1 ? h1.textContent.trim() : ''),
piece: h1 ? h1.textContent.trim() : '',
colour: colourLine ? colourLine.replace(/^colour:\s*/i, '').trim() : '',
url: (ld && ld.url) || '',
};
}

// Every OTHER product shown on the page -- the rest of the set, when the
// page happens to carry it. A BROWSER fetch does; a server fetch does
// not (see the header), so this is a bonus rather than something to rely
// on, and callers must treat an empty list as normal.
//
// Their discount codes are deliberately not read here: a sibling block
// carries no reliable offer line of its own, and inheriting the main
// product's code is the exact mistake this module exists to avoid. A
// sibling worth pricing gets fetched by its own URL.
// `mainName` rather than the SKU it used to take: the sweep below finds
// blocks by walking every <select> on the page, and a block carries a
// NAME, not a SKU, so a SKU could never have excluded anything. It never
// did -- the parameter was unused and the main product listed itself as
// one of its own set pieces ("+ Lorna Plunge Underwired Bra" under the
// Lorna Plunge Underwired Bra).
function parseSiblings(doc, mainName, mainSelect) {
// Not an exact match: the page titles the main product with its colour
// ("Andiee Plunge Underwired Bra in Black/Baby Pink") while its own set
// block names it without ("Andiee Plunge Underwired Bra"). Comparing
// the two literally let the bra list itself a second time. The colour
// suffix is dropped and a prefix counts as the same garment, since AP
// never names two pieces in one set where one starts with the other.
const setKey = (s) => String(s || '').trim().toLowerCase().split(/\s+in\s+/)[0].replace(/\s+/g, ' ').trim();
const mainKey = setKey(mainName);
const out = [];
doc.querySelectorAll('select').forEach((select) => {
// The surest test, and the only one that works on the page the proxy
// returns: that page has no h1 and no JSON-LD, so the main product's
// NAME is empty there and every name-based check matched nothing.
if (mainSelect && select === mainSelect) return;
let node = select, box = null;
for (let d = 0; d < 8 && node; d++) {
node = node.parentElement;
if (node && /£\s?\d/.test(node.textContent || '')) { box = node; break; }
}
if (!box) return;
const text = (box.textContent || '').replace(/\s+/g, ' ').trim();
const name = text.split('£')[0].trim();
if (!name) return;
const block = parseBlock(box, doc);
// The main product's own block comes back through this sweep too, and
// is dropped by NAME here -- it is already parsed properly by parseMain.
if (!block.sizes.length) return;
if (mainKey) {
const k = setKey(name);
if (k === mainKey || k.startsWith(mainKey) || mainKey.startsWith(k)) return;
}
out.push({ name, ...block, code: '', discountPct: 0, net: block.now, pricedFrom: 'set page' });
});
return out;
}

// The whole page, parsed. `html` is whatever the fetch returned; parsing
// is done with DOMParser rather than regex because the text form is
// genuinely ambiguous -- "£50" followed by "30% off" concatenates to
// "£5030", which no regex reads correctly.
function parseProductPage(html, url) {
const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
const main = parseMain(doc);
// URL first: it's the source that survives a server fetch. JSON-LD is
// only a fallback for the browser case, where it happens to be present.
const sku = skuFromUrl(url) || main.sku;
return {
url: url || main.url,
retailer: RETAILER,
sku,
skuParts: skuParts(sku),
colour: main.colour,
name: main.name,
piece: main.piece,
was: main.was,
now: main.now,
code: main.code,
discountPct: main.discountPct,
net: main.net,
sizes: main.sizes,
alsoOnPage: parseSiblings(doc, main.name, main.mainSelect),
};
}

// Every item in a range, discovered from a category listing page: every
// piece, in every colour the listing happens to show, whether or not THIS
// want's piece comes in that colour. This is the only way to find a
// style's other colours at all -- the swatches on a product page carry an
// RGB fill and nothing else, no name, no href, no data attribute, and
// clicking one is an Angular handler a server-side fetch can't follow.
//
// A listing card, by contrast, is a real element with real text --
// confirmed from the live markup, not assumed:
//   <product>...<span class="...fw-bold...">Lorna Lace</span>...
//     <a href="/apm0281001000-lorna-plunge-underwired-bra-in-black-14748">
//       <span cy-basketprod>Plunge Underwired Bra</span></a>...</product>
// -- a bold RANGE-name span, a PIECE-name span, and the real href,
// independent of each other and of the URL. That independence matters: the
// URL for that exact card is "lorna-plunge-...", no "lace" in it at all,
// even though the range span and the image alt both say "Lorna Lace" --
// AP's own slug generator silently drops words the display name keeps. A
// style word matched against the URL, which is what this used to do,
// therefore can't tell "Lorna" from "Lorna Lace" OR "Lorna Party" (both
// real, different ranges -- AP's own search box expands "Lorna" to all of
// Lorna/Lorna Dotty/Lorna Heart/Lorna Lace/Lorna Party/Lorna Rainbow) --
// confirmed live: the results mixed in a genuine "Lorna Lace" product
// under a plain "Lorna" search. Matching the range SPAN against the typed
// style instead, exact and case-insensitive, is the fix: it's the one
// field here that's never abbreviated.
//
// Also fixes a second, unrelated miss: the old regex only matched
// "/apm"-prefixed URLs. Newer SKUs are plain "/ap" (no m) -- confirmed
// live, "/ap11129651430-lorna-...-dark-pink-cobalt-..." -- so that colour
// was silently never found. Reading real <a href> elements has no such
// prefix assumption.
//
// What this does NOT fix: coverage. A listing still only renders what's
// loaded before the fetch completes -- confirmed live, scrolling the same
// page from ~6 cards to 100 pulled in colourways and even whole OTHER
// ranges that weren't there on first paint, which is lazy-loading, not a
// filter. (A `#filters.range=` hash in the URL was tried and confirmed to
// do nothing on a fresh navigation -- the app only applies it in response
// to clicking the filter in-app, not from the URL -- so that's not a
// shortcut to a complete, pre-filtered list either.) This remains
// best-effort, same as before: more pages checked would find more.
// One <product> card, read into its real fields -- shared by every
// listing-page reader below so the card markup is only understood once.
// Was `a[href^="/ap"]`, which missed any product whose URL doesn't start
// with the usual SKU prefix -- confirmed live: Paige's own card links to
// "/paige-full-cup-underwired-bra-in-pink-9161", no "ap" in sight. A
// <product> card has exactly one real link (the image and the piece name
// both point at it; the wishlist toggle is a custom element, not an
// <a>), so the plain first href is the right one regardless of shape.
function parseListingCard(card) {
const href = card.querySelector('a[href]')?.getAttribute('href') || '';
const range = (card.querySelector('.fw-bold')?.textContent || '').trim();
const piece = (card.querySelector('[cy-basketprod]')?.textContent || '').trim();
if (!href || !piece) return null;
// Resolved to absolute here, once, rather than left for every caller to
// remember: a card's href is written relative ("/apm...-black-14748"),
// and a relative URL saved as-is onto a want (as this used to) has no
// base to resolve against later -- confirmed live, it was happening.
// `new URL` against a plain string has no document to inherit a base
// from, so the origin has to be given explicitly.
const url = new URL(href, `https://www.${HOST}`).href;
// The colour isn't its own field anywhere on the card -- only the image
// alt text spells it out, as "{range} {piece} {colour} | Agent
// Provocateur". Stripping the range and piece text (already read above,
// so this can't drift from them) off the front leaves the colour,
// however many words it is ("Black", "Dark Pink/Cobalt").
const alt = (card.querySelector('img[alt]')?.getAttribute('alt') || '').replace(/\s*\|\s*Agent Provocateur\s*$/i, '').trim();
let colour = alt;
if (range && colour.toLowerCase().startsWith(range.toLowerCase())) colour = colour.slice(range.length).trim();
if (piece && colour.toLowerCase().startsWith(piece.toLowerCase())) colour = colour.slice(piece.length).trim();
// Two <price> tags on a reduced card (struck-through was, then now);
// one on a full-price card. The LAST one is always the real one to pay.
const prices = [...card.querySelectorAll('price')].map((p) => priceNumber(p.textContent)).filter((n) => n != null);
const now = prices.length ? prices[prices.length - 1] : null;
const was = prices.length > 1 ? prices[0] : now;
const discountPct = (was != null && now != null && was > now) ? Math.round((1 - now / was) * 100) : 0;
return { url, range, piece, colour, was, now, discountPct };
}

function findRangeItems(listingHtml, rangeName) {
const want = String(rangeName || '').trim().toLowerCase();
const doc = new DOMParser().parseFromString(String(listingHtml || ''), 'text/html');
const seen = new Set();
const items = [];
doc.querySelectorAll('product').forEach((card) => {
const item = parseListingCard(card);
if (!item || seen.has(item.url)) return;
if (want && item.range.toLowerCase() !== want) return;
seen.add(item.url);
items.push(item);
});
return items;
}

// Every colour value AP's own filter panel offers, read straight off its
// markup -- name and swatch hex, 18 of them, Black through Yellow. No
// URL key confirmed for filtering on it server-side: five plausible
// hash keys (filter_colour, colour_desc, filters.colour, filter_color,
// a plain colour=) were each tried live and every one came back as the
// unfiltered default list -- unlike prod_type_desc and filter_size,
// which were confirmed the same way and genuinely work. So colour is
// filtered CLIENT-SIDE instead, bucketed from the colour text this file
// already reads off each card (see parseListingCard) -- no dependency
// on guessing a key right, and no second live round-trip needed either.
// Leopard, Multicolour and Neutral are swatch IMAGES on the real site,
// not a flat hex, so they're bucketed by name below rather than colour
// math.
const COLOURS = [
{ name: 'Black', hex: '#000000' }, { name: 'Blue', hex: '#6ca4e8' },
{ name: 'Burgundy', hex: '#761c3c' }, { name: 'Brown', hex: '#633838' },
{ name: 'Bronze', hex: '#bd8248' }, { name: 'Champagne', hex: '#fad6a5' },
{ name: 'Green', hex: '#96d5a2' }, { name: 'Leopard', hex: null },
{ name: 'Multicolour', hex: null }, { name: 'Navy', hex: '#354376' },
{ name: 'Neutral', hex: null }, { name: 'Orange', hex: '#ff7f50' },
{ name: 'Pink', hex: '#ed84b1' }, { name: 'Purple', hex: '#630460' },
{ name: 'Red', hex: '#ca3131' }, { name: 'Silver', hex: '#c0c0c0' },
{ name: 'White', hex: '#ffffff' }, { name: 'Yellow', hex: '#ffd856' },
];

// AP's own 18 collapsed to the 4 broad buckets a quick filter actually
// wants -- "roughly which end of the wardrobe is this" rather than the
// exact shade. Hand-assigned rather than computed from the hex (HSL
// lightness alone would call Burgundy "dark" and group it with Black,
// which isn't what anyone searching for "neutral" vs "bright" means).
const COLOUR_BUCKETS = {
Black: 'Black',
White: 'Neutral', Silver: 'Neutral', Champagne: 'Neutral', Bronze: 'Neutral', Brown: 'Neutral', Neutral: 'Neutral',
Blue: 'Bright', Burgundy: 'Bright', Green: 'Bright', Navy: 'Bright', Orange: 'Bright', Pink: 'Bright', Purple: 'Bright', Red: 'Bright', Yellow: 'Bright',
Leopard: 'Other', Multicolour: 'Other',
};

// A product's own colour text is free-form and often two-tone ("Dark
// Pink/Cobalt", "Navy/Black" -- confirmed live, see parseListingCard),
// never one of the 18 canonical names outright. So this matches by
// SUBSTRING against each canonical name and returns every bucket that
// hits, rather than picking one -- a two-tone piece can genuinely read
// as both, and that's more useful than an arbitrary first-match pick.
function bucketsForColour(colourText) {
const text = String(colourText || '').toLowerCase();
const hit = new Set();
Object.keys(COLOUR_BUCKETS).forEach((name) => {
if (text.includes(name.toLowerCase())) hit.add(COLOUR_BUCKETS[name]);
});
return [...hit];
}

// Every card on a size+type filtered, sorted listing page -- /lingerie's
// own `filters.prod_type_desc`, `filters.filter_size` and `sort` hash
// params, confirmed live to genuinely filter and sort (NOT the page's
// own "NN items" counter, which stays at the section's unfiltered total
// regardless and is not the signal to trust -- confirmed by comparing
// the actual GRID content between a filtered and unfiltered fetch, which
// differed completely, while the counter read identically both times).
// Used for "what's in her size, cheapest/biggest-discount first" rather
// than one named range -- every range is wanted here, so there's no
// range filter, unlike findRangeItems above.
//
// /lingerie rather than /sale/sale-bras: confirmed it already includes
// sale stock, so one fetch covers both instead of needing a second
// request purely for the sale section.
// `colours` takes literal AP colour names ("Black", "Bronze", ...), not
// bucket labels -- a caller filtering by bucket resolves that to names
// first (see bucketsForColour's own COLOUR_BUCKETS map, read in reverse).
// filters.colour_filter was the one key out of six tried that genuinely
// filters, confirmed live by pasting a real URL into a real phone
// browser and watching the result narrow -- see the colour comment
// above for the five that didn't. Still not re-verified from an
// automated session (every automated attempt at this site's filters has
// failed to reproduce even ones later confirmed genuine), so sitehealth.js
// carries the standing check that proves it on every real run instead.
function listingUrl({ prodType, sizes = [], colours = [], sort = 'price' }) {
const parts = [`filters.prod_type_desc=${encodeURIComponent(prodType)}`];
if (sizes.length) parts.push(`filters.filter_size=${sizes.map(encodeURIComponent).join(',')}`);
if (colours.length) parts.push(`filters.colour_filter=${colours.map(encodeURIComponent).join(',')}`);
parts.push(`sort=${encodeURIComponent(sort)}`);
return `https://www.${HOST}/lingerie#${parts.join('&')}`;
}

function listingItems(listingHtml) {
const doc = new DOMParser().parseFromString(String(listingHtml || ''), 'text/html');
const seen = new Set();
const items = [];
doc.querySelectorAll('product').forEach((card) => {
const item = parseListingCard(card);
if (!item || seen.has(item.url)) return;
seen.add(item.url);
items.push(item);
});
return items;
}

// ---- Reading the page from YOUR browser instead ---------------------------
//
// The proxy route assumes the retailer will answer a request from your web
// host. Agent Provocateur doesn't: every fetch from that address comes back
// 403, product pages included, while the same URLs answer fine from a
// normal browser. That isn't a header or a pacing problem to solve -- it's
// the site refusing a datacentre IP, and nothing in this app changes it.
//
// So the page gets read where it already loads: your own browser. This
// builds a snippet that parses the page you're looking at and copies the
// result, which "Paste stock" then reads back -- exactly the mechanism the
// Amazon price already uses (see pastePrice in shopping.js), and for the
// same underlying reason.
//
// The snippet is BUILT FROM the functions above rather than being a second
// copy of them: toString() serialises the real implementations into it, so
// the bookmarklet can't drift from the parser the scheduled check uses.
// A browser-loaded page also carries MORE than the proxy ever got -- the
// whole "wear with" set and the JSON-LD -- so this route is the better one
// even where the proxy works.
const PASTE_STOCK_PREFIX = 'DASHSTOCK:';

function bookmarkletSource() {
const parts = [priceNumber, parseSizeOption, parseBlock, parseMain, parseSiblings, skuFromUrl, skuParts, parseProductPage]
.map((fn) => fn.toString()).join('\n');
// The body is percent-encoded rather than flattened to one line. These
// functions carry `//` comments, and stripping newlines turned every one
// of them into a comment that swallowed the rest of the line -- the
// snippet parsed, ran, and returned nonsense. Encoding keeps the line
// breaks intact inside a URL that's still a single line to paste.
const body = `(function(){
${parts}
try{
var p=parseProductPage(document.documentElement.outerHTML,location.href);
var out=${JSON.stringify(PASTE_STOCK_PREFIX)}+JSON.stringify({url:p.url,retailer:p.retailer,sku:p.sku,colour:p.colour,name:p.name,piece:p.piece,was:p.was,now:p.now,code:p.code,discountPct:p.discountPct,net:p.net,sizes:p.sizes,alsoOnPage:p.alsoOnPage});
navigator.clipboard.writeText(out).then(function(){
alert('Copied '+p.piece+(p.colour?' in '+p.colour:'')+' — '+p.sizes.filter(function(s){return s.inStock;}).length+' sizes in stock. Now click "Paste stock" in the dashboard.');
},function(){
var t=document.createElement('textarea');t.value=out;document.body.appendChild(t);t.select();document.execCommand('copy');t.remove();
alert('Copied (fallback). Now click "Paste stock" in the dashboard.');
});
}catch(e){alert('Could not read this page: '+e.message);}
})();`;
return `javascript:${encodeURIComponent(body)}`;
}

// The same idea, but for a whole style at once -- run on a LISTING page
// (e.g. /sale#filters.range=Jayce) instead of one product.
//
// A listing card carries the product URL, the piece, both prices and that
// product's own discount code, but NOT sizes -- checked on a real filtered
// page. So the snippet reads the cards, then fetches each product page for
// its sizes. Those fetches are same-origin, made by your browser from your
// address, which is exactly why this works where the proxy gets a 403.
//
// Paced like every other run against this site, and reported as it goes,
// because a dozen products at four seconds apart is a minute of waiting
// and a silent page looks broken.
function bulkBookmarkletSource(styleWord) {
const parts = [priceNumber, parseSizeOption, parseBlock, parseMain, parseSiblings, skuFromUrl, skuParts, parseProductPage]
.map((fn) => fn.toString()).join('\n');
const body = `(function(){
${parts}
var STYLE=${JSON.stringify(String(styleWord || '').toLowerCase())};
var GAP=${CHECK_SPACING_MS};
var links=[].slice.call(document.querySelectorAll('a[href*="-"]')).map(function(a){return a.getAttribute('href');})
.filter(function(h){return h&&/^\\/apm?\\d{10,11}-/i.test(h)&&(!STYLE||h.toLowerCase().indexOf(STYLE)>-1);});
links=links.filter(function(h,i){return links.indexOf(h)===i;});
if(!links.length){alert('No products matching "'+STYLE+'" on this page. Filter the listing to that style first.');return;}
var note=document.createElement('div');
note.style.cssText='position:fixed;z-index:99999;left:12px;bottom:12px;background:#1c1b19;color:#fff;padding:10px 14px;border-radius:8px;font:14px sans-serif';
document.body.appendChild(note);
var out=[],i=0;
function step(){
if(i>=links.length){
note.remove();
var payload=${JSON.stringify(PASTE_STOCK_PREFIX)}+JSON.stringify(out);
navigator.clipboard.writeText(payload).then(function(){
alert('Copied '+out.length+' products. Now click "Paste stock" in the dashboard.');
},function(){
var t=document.createElement('textarea');t.value=payload;document.body.appendChild(t);t.select();document.execCommand('copy');t.remove();
alert('Copied '+out.length+' products (fallback). Now click "Paste stock".');
});
return;
}
var href=links[i];
note.textContent='Reading '+(i+1)+' of '+links.length+'…';
fetch(location.origin+href).then(function(r){return r.text();}).then(function(html){
var p=parseProductPage(html,location.origin+href);
out.push({url:p.url,retailer:p.retailer,sku:p.sku,colour:p.colour,name:p.name,piece:p.piece,was:p.was,now:p.now,code:p.code,discountPct:p.discountPct,net:p.net,sizes:p.sizes});
}).catch(function(){}).then(function(){i++;setTimeout(step,GAP);});
}
step();
})();`;
return `javascript:${encodeURIComponent(body)}`;
}

export { matchesRetailer, RETAILER, parseProductPage, parseSizeOption, parseBlock, skuParts, skuFromUrl, specFromUrl, findRangeItems, listingUrl, listingItems, COLOURS, bucketsForColour, bookmarkletSource, bulkBookmarkletSource, PASTE_STOCK_PREFIX, HOST, CHECK_SPACING_MS, NEEDS_BROWSER_FOR_FULL_PAGE };
