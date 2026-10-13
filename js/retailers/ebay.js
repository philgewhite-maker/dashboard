// Agent Provocateur items resold (or still stocked new by a third party)
// on eBay UK, found by eBay's OWN real search filters -- not an AI web
// search, unlike the department-store one setfinder.js/
// searchAgentProvocateurElsewhere (ai.js) uses for a much less
// structured question. Confirmed live, not assumed: a plain fetch of a
// real eBay search URL (via the NAS agent, same pipeline
// agentprovocateur.js already uses) returns real, server-rendered
// listing cards -- title, price, size and condition all present as
// plain text, no JS execution needed to read them.
//
// Unlike Agent Provocateur's own colour_filter (see that file's own
// history -- five guessed keys before the real one was found), eBay's
// structured aspect filters here are the real thing, confirmed by
// fetching real filtered URLs and checking every result actually
// matched: Band Size/Cup Size/Colour (bras) and Size/Colour (knickers)
// all genuinely narrow results server-side. Not perfect, though -- one
// Colour=Black knickers fetch still returned a single Pink result among
// ~60 -- so a client-side colour re-check (titleMatchesColour below)
// stays mandatory here too, same "trust but verify" discipline
// bucketsForColour already applies to Agent Provocateur's own results.
const HOST = 'ebay.co.uk';
// Confirmed live against real category-scoped search URLs -- Lingerie's
// own "Bras & Bra Sets" and "Knickers" subcategories.
const BRA_CATEGORY = '63853';
const KNICKERS_CATEGORY = '63854';

const CUP_ORDER = ['AA', 'A', 'B', 'C', 'D', 'DD', 'E', 'F', 'FF', 'G', 'GG', 'H', 'HH', 'J', 'JJ', 'K'];

function priceNumber(text) {
const m = /([\d]+(?:\.\d{1,2})?)/.exec(String(text || '').replace(/,/g, ''));
return m ? parseFloat(m[1]) : null;
}

function cupsInRange(min, max) {
const lo = CUP_ORDER.indexOf(min), hi = CUP_ORDER.indexOf(max);
if (lo === -1 || hi === -1 || lo > hi) return [];
return CUP_ORDER.slice(lo, hi + 1);
}
// Bra bands run even numbers only.
function bandsInRange(min, max) {
const lo = Number(min), hi = Number(max);
if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) return [];
const out = [];
for (let b = lo; b <= hi; b += 2) out.push(String(b));
return out;
}
// Confirmed live: a seller's own "Small"/"Medium" is routinely paired
// with AP's own number in the SAME title ("SIZE 2 SMALL UK 8", "SIZE
// AP3 MEDIUM") -- some listings carry only the letter, never the
// number, so both are requested to avoid silently missing those.
// Approximate (a letter spans more than one AP number), fine for a
// search that's still reviewed by hand before anything is bought.
function knickerSizeLetters(min, max) {
const letters = new Set();
for (let n = Number(min); n <= Number(max); n++) {
if (n <= 2) letters.add('S');
else if (n <= 4) letters.add('M');
else letters.add('L');
}
return [...letters];
}

// eBay's aspect refinement keys that contain a space ("Band Size", "Cup
// Size") need that space DOUBLE-encoded (%2520, not %20) to actually
// filter -- confirmed live, not assumed: a single-encoded `Band%20Size=`
// fetch came back with every band/cup mixed together, completely
// unfiltered, the exact same "guessed key, silently ignored" failure
// this app was already burned by once with Agent Provocateur's own
// colour filter. `encodeURIComponent` single-encodes the space to
// `%20`; re-escaping that `%` to `%25` is what produces the real,
// working `%2520`.
function doubleEncodedParam(key, values) {
if (!values.length) return '';
const encodedKey = encodeURIComponent(key).replace(/%/g, '%25');
return `${encodedKey}=${values.map(encodeURIComponent).join('%7C')}`;
}

// eBay's own Colour aspect filter wants a single SIMPLE value ("Black",
// "Pink"...), not a compound one -- a set's own colour field can be
// "Black/Gold" (two colours in the one piece), and passing that whole
// string straight through as the filter VALUE doesn't match any of
// eBay's enumerated colour values, so the request comes back
// unfiltered -- the same "guessed/unmatched structured value" failure
// class as the Band Size/Cup Size double-encoding above, confirmed the
// same way: by checking what the filter actually does, not assuming a
// compound string "obviously" works. Only splits on real compound
// separators (/, comma, &, "and") -- a genuine space-separated colour
// name ("Rose Gold") is left whole. titleMatchesColour below still
// re-checks every word of the FULL compound value against the title,
// so a two-coloured piece isn't short-changed by the client-side
// check -- only the structured filter itself has no way to ask for
// "either of these two", so it gets just the first.
function simpleColour(colour) {
return String(colour || '').split(/\s*[/,&+]\s*|\s+and\s+/i)[0].trim();
}

function braListingUrl({ keywords, colour, bounds }) {
const bands = bandsInRange(bounds.braBandMin, bounds.braBandMax);
const cups = cupsInRange(bounds.braCupMin, bounds.braCupMax);
const sizes = [];
bands.forEach((b) => cups.forEach((c) => sizes.push(`${b}${c}`)));
const params = new URLSearchParams({ _nkw: keywords, _sacat: BRA_CATEGORY, _dcat: BRA_CATEGORY });
if (sizes.length) params.set('Size', sizes.join('|'));
if (colour) params.set('Colour', simpleColour(colour));
const extra = [doubleEncodedParam('Band Size', bands), doubleEncodedParam('Cup Size', cups)].filter(Boolean).join('&');
return `https://www.${HOST}/sch/${BRA_CATEGORY}/i.html?${params.toString()}${extra ? `&${extra}` : ''}`;
}

function knickersListingUrl({ keywords, colour, bounds }) {
const lo = Number(bounds.knickersMin), hi = Number(bounds.knickersMax);
const numbers = [];
if (Number.isFinite(lo) && Number.isFinite(hi) && lo <= hi) {
for (let n = lo; n <= hi; n++) numbers.push(String(n));
}
const sizes = [...numbers, ...knickerSizeLetters(bounds.knickersMin, bounds.knickersMax)];
const params = new URLSearchParams({ _nkw: keywords, _sacat: KNICKERS_CATEGORY, _dcat: KNICKERS_CATEGORY });
if (sizes.length) params.set('Size', sizes.join('|'));
if (colour) params.set('Colour', simpleColour(colour));
return `https://www.${HOST}/sch/i.html?${params.toString()}`;
}

// A listing card's real shape, confirmed from live markup, not assumed:
//   <li class="s-card ...">...<a href=".../itm/<id>?...">
//     <div class="s-card__title"><span class="... primary default">TITLE</span></div>
//     <div class="s-card__subtitle"><span class="... secondary default">Size 34B</span></div>
//     <div class="s-card__subtitle"><span class="... secondary default">Pre-owned</span></div>
//     ...<span class="... s-card__price">£21.49</span>
// A placeholder "Shop on eBay" card (no real listing) is filtered out.
// Condition/size are matched by CONTENT, not position -- confirmed live
// that a card's subtitle order isn't perfectly consistent, but a
// condition always reads as one of a fixed few phrases and a size
// always starts with the word "Size".
const CONDITIONS = ['brand new', 'new (other)', 'new with tags', 'new without tags', 'pre-owned', 'used', 'for parts or not working'];
function parseListingCard(card) {
const href = card.querySelector('a[href*="/itm/"]')?.getAttribute('href') || '';
if (!href) return null;
const title = (card.querySelector('.s-card__title .su-styled-text')?.textContent || '').trim();
if (!title || title.toLowerCase() === 'shop on ebay') return null;
const subtitles = [...card.querySelectorAll('.s-card__subtitle .su-styled-text')].map((el) => (el.textContent || '').trim());
const condition = subtitles.find((s) => CONDITIONS.includes(s.toLowerCase())) || '';
const sizeText = subtitles.find((s) => /^size\s/i.test(s));
const size = sizeText ? sizeText.replace(/^size\s+/i, '').trim() : '';
const price = priceNumber(card.querySelector('.s-card__price')?.textContent || '');
return { title, size, condition, price, url: href.split('?')[0] };
}

function listingItems(html) {
const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
const seen = new Set();
const items = [];
doc.querySelectorAll('li.s-card').forEach((card) => {
const item = parseListingCard(card);
if (!item || seen.has(item.url)) return;
seen.add(item.url);
items.push(item);
});
return items;
}

// eBay's own Colour filter leaks occasionally (see this file's own
// header) -- re-checked the same way Agent Provocateur's own
// colour_filter already needs re-checking (bucketsForColour,
// agentprovocateur.js), just simpler: whole-word, case-insensitive,
// since an eBay title states colour in plain English rather than
// needing a bucket map. Words under 3 letters are skipped (an "of"/"in"
// in a compound colour name isn't a real signal).
function titleMatchesColour(title, colour) {
const words = String(colour || '').split(/[^a-z]+/i).filter((w) => w.length >= 3);
if (!words.length) return true;
const lower = String(title || '').toLowerCase();
return words.some((w) => new RegExp(`\\b${w.toLowerCase()}\\b`).test(lower));
}

export { braListingUrl, knickersListingUrl, listingItems, titleMatchesColour, priceNumber, simpleColour, BRA_CATEGORY, KNICKERS_CATEGORY };
