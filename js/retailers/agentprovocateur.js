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
// Gap between fetches when checking several products. Chosen from the
// measured failure above, not guessed: bursts got 403s, ~4s apart did not.
const CHECK_SPACING_MS = 4000;

// The SKU lives in the URL's own first path segment ("apm0017410000-..."),
// which is present on every product URL regardless of slug shape. Read
// from there rather than JSON-LD, which a server fetch doesn't get.
function skuFromUrl(url) {
const m = /\/?(apm\d{10})\b/i.exec(String(url || ''));
return m ? m[1].toUpperCase() : '';
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
// The size select sits outside the heading block on the main product
// (the heading holds name/price/offer only), so it's found separately.
if (!block.sizes.length) {
const mainSelect = doc.querySelector('select');
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
function parseSiblings(doc, mainSku) {
const out = [];
doc.querySelectorAll('select').forEach((select) => {
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
// The main product's own block comes back through this sweep too;
// it's already parsed properly by parseMain, so it's dropped here.
if (!block.sizes.length) return;
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
retailer: 'Agent Provocateur',
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
alsoOnPage: parseSiblings(doc, main.sku),
};
}

// Every Jayce-style colourway, discovered from a category listing page.
// This is the only way to find a style's other colours: the swatches on a
// product page carry an RGB fill and nothing else -- no name, no href, no
// data attribute -- and clicking one is an Angular handler, so there is
// nothing a server-side fetch can follow. Listing pages, by contrast, are
// server-rendered and carry real URLs.
//
// Best-effort by design: a listing renders a few hundred of a claimed
// several hundred products, so this finds colourways rather than
// guaranteeing all of them. Grouped by the SKU's colour code, which is
// present whether or not the slug names a colour.
function findColourways(listingHtml, styleWord) {
const word = String(styleWord || '').toLowerCase();
const urls = [...new Set((String(listingHtml || '').match(/\/apm\d{10}-[a-z0-9-]+/gi) || []))]
.filter((u) => !word || u.toLowerCase().includes(word));
const byColour = new Map();
urls.forEach((u) => {
const m = /^\/apm(\d{4})(\d{6})-(.+?)-(\d+)$/i.exec(u);
if (!m) return;
const [, style, colourCode, rest] = m;
const slugColour = (/-in-([a-z-]+)$/.exec(rest) || [])[1] || '';
const entry = byColour.get(colourCode) || { colourCode, slugColour: '', pieces: {} };
if (slugColour) entry.slugColour = slugColour;
entry.pieces[style] = u;
byColour.set(colourCode, entry);
});
return [...byColour.values()];
}

export { matchesRetailer, parseProductPage, parseSizeOption, parseBlock, skuParts, skuFromUrl, findColourways, HOST, CHECK_SPACING_MS };
