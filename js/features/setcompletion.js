// Weekly (then slower) search for the exact missing piece of each
// incomplete owned lingerie set -- see state.js's incompleteCoreSets()
// and shopping.js's inventorySetsHtml() for where "incomplete" is
// decided and shown. Same shape as schoolcalendar.js: a per-item
// staleness gate inside run() rather than scheduled.js's own hours-scale
// outer gate, so firing at ordinary app-open cadence costs nothing when
// nothing's due. The eBay fallback (retailers/ebay.js) only runs once a
// set's own Agent Provocateur attempts have already backed off to
// monthly+ (see EBAY_FALLBACK_AFTER_ATTEMPTS) -- rare by construction,
// though cheap regardless since, like the AP search above, it's a real
// fetch against eBay's own structured search filters, not an AI call.
import { data, queueSave, incompleteCoreSets, blankSetCompletionFind } from '../state.js';
import { daysSince } from '../utils.js';
import * as agentProvocateur from '../retailers/agentprovocateur.js';
import * as ebay from '../retailers/ebay.js';
import { fetchPages, pageMatchesWant, money } from './stockwatch.js';

// AP has already backed off to monthly+ by the time this triggers (see
// intervalForAttempt below), so the eBay fallback is itself no more
// frequent than that from here on -- cheap by construction, not a cost
// that needs its own separate gate.
const EBAY_FALLBACK_AFTER_ATTEMPTS = 4;
// Bounds one run's worth of paced AP fetches regardless of how many
// sets are incomplete -- a run that checked every incomplete set at
// once could mean dozens of requests at CHECK_SPACING_MS (4s) apart.
const MAX_SETS_PER_RUN = 3;
// Product-page confirmations per set, same bounding reasoning
// setfinder.js's MAX_IN_BUDGET/MAX_BIG_DISCOUNT already use.
const MAX_COLOUR_CANDIDATES_PER_SET = 3;

function searchesStore() {
if (!data.prefs.setCompletionSearches || typeof data.prefs.setCompletionSearches !== 'object') data.prefs.setCompletionSearches = {};
return data.prefs.setCompletionSearches;
}

// Attempt-count-based backoff, capped but never fully stopped -- an AP
// range can un-discontinue or restock, so this tapers rather than
// giving up outright: weekly for the first month, then monthly, then
// quarterly, then twice yearly forever.
function intervalForAttempt(n) {
if (n <= 4) return 7;
if (n <= 8) return 30;
if (n <= 12) return 90;
return 180;
}

// Drops any backoff-state or find entry whose set key is no longer
// incomplete -- a set completes the moment its missing piece is bought
// and added to inventory, which is the only "stop searching" signal
// this feature needs; this just keeps the state object from growing
// unboundedly with entries for sets long since finished.
function pruneStaleEntries() {
const liveKeys = new Set(incompleteCoreSets().map((s) => s.key));
const store = searchesStore();
let changed = false;
Object.keys(store).forEach((k) => { if (!liveKeys.has(k)) { delete store[k]; changed = true; } });
const finds = data.setCompletionFinds || [];
const kept = finds.filter((f) => liveKeys.has(f.setKey));
if (kept.length !== finds.length) { data.setCompletionFinds = kept; changed = true; }
if (changed) queueSave();
}

function isDueForSet(set) {
const st = searchesStore()[set.key];
if (!st || !st.lastCheckedAt) return true;
return daysSince(st.lastCheckedAt) >= intervalForAttempt(st.attempts || 0);
}

function setsToCheck({ force = false } = {}) {
const store = searchesStore();
return incompleteCoreSets()
.filter((s) => force || isDueForSet(s))
.sort((a, b) => (store[a.key]?.lastCheckedAt || '').localeCompare(store[b.key]?.lastCheckedAt || ''))
.slice(0, MAX_SETS_PER_RUN);
}

// The listing fetch is deduped by prodType across a whole run, not
// fetched once per set -- at most 2 distinct listings (Bras, Knickers)
// regardless of how many sets are being checked this run. `cache` is a
// plain Map the caller holds for the lifetime of one run.
async function listingForGroup(group, cache) {
const prodType = group === 'Bra' ? 'Bras' : 'Knickers';
if (cache.has(prodType)) return cache.get(prodType);
const url = agentProvocateur.listingUrl({ prodType, sort: 'price' });
const { pages } = await fetchPages([url]);
const html = pages.get(url) || '';
cache.set(prodType, html);
return html;
}

// Exact range match against the already type-scoped listing --
// jsonLdRangeItems' own exact-match rule tells "Lorna" from "Lorna
// Lace" the same way it does everywhere else this is used.
function candidatesForSet(set, missingGroup, listingHtml) {
return agentProvocateur.jsonLdRangeItems(listingHtml, set.style)
.filter((item) => item.inStock !== false)
.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))
.slice(0, MAX_COLOUR_CANDIDATES_PER_SET);
}

// Cup letters aren't orderable by plain string comparison (D < DD
// alphabetically is right, but F < FF < G needs a real sequence) --
// compared by index into this fixed list instead.
const CUP_ORDER = ['AA', 'A', 'B', 'C', 'D', 'DD', 'E', 'F', 'FF', 'G', 'GG', 'H', 'HH', 'J', 'JJ', 'K'];

function parseBraSize(sizeStr) {
const m = /^(\d{2,3})([A-Za-z]{1,3})$/.exec(String(sizeStr || '').trim());
if (!m) return null;
return { band: Number(m[1]), cup: m[2].toUpperCase() };
}

// An unbounded size match is actively misleading -- a 32A or an F cup
// is both unlikely to be useful and disproportionately likely to be
// the one leftover size still in stock. `bounds` is
// data.prefs.setCompletionSizeBounds, read once per run by the caller.
function sizeInBounds(group, sizeStr, bounds) {
if (group === 'Bra') {
const parsed = parseBraSize(sizeStr);
if (!parsed) return false;
const cupIdx = CUP_ORDER.indexOf(parsed.cup);
const minIdx = CUP_ORDER.indexOf(bounds.braCupMin);
const maxIdx = CUP_ORDER.indexOf(bounds.braCupMax);
if (cupIdx === -1 || minIdx === -1 || maxIdx === -1) return false;
return parsed.band >= bounds.braBandMin && parsed.band <= bounds.braBandMax && cupIdx >= minIdx && cupIdx <= maxIdx;
}
const raw = String(sizeStr || '').trim().toUpperCase();
// A size can be tagged with AP's own number OR a generic S/M/L --
// confirmed live against real eBay listings pairing both on the SAME
// item ("SIZE 2 SMALL UK 8", "SIZE AP3 MEDIUM"). Approximate (a letter
// spans more than one AP number), fine for a search a person still
// reviews by hand before buying anything.
const LETTER_SIZE = { S: 2, M: 3, L: 5 };
const n = raw in LETTER_SIZE ? LETTER_SIZE[raw] : Number(raw);
if (!Number.isFinite(n)) return false;
return n >= bounds.knickersMin && n <= bounds.knickersMax;
}

// The authoritative per-candidate check -- colour isn't in the JSON-LD
// catalogue a candidate came from, so it's only ever decided here, off
// the real product page. Returns the parsed page (a genuine match) or
// null.
function confirmCandidate(url, html, set, missingGroup, bounds) {
const page = agentProvocateur.parseProductPage(html, url);
if (!pageMatchesWant(page, { colours: [set.colour], pieces: [missingGroup] })) return null;
const hasInBoundsStock = (page.sizes || []).some((s) => s.inStock && sizeInBounds(missingGroup, s.size, bounds));
if (!hasInBoundsStock) return null;
return page;
}

// Only reached once AP has already struck out enough times to be worth
// the cost (see EBAY_FALLBACK_AFTER_ATTEMPTS). A real fetch against
// eBay's own search filters (retailers/ebay.js), not an AI web search --
// confirmed live those filters genuinely narrow by band/cup/colour
// (bras) and size/colour (knickers), so there's no need to ask a model
// to go looking. Still re-checked client-side (colour AND size) rather
// than trusted blind -- eBay's own Colour filter leaks occasionally,
// confirmed live, same discipline this file already applies to Agent
// Provocateur's own results above.
async function tryEbayFallback(set, missingGroup, bounds) {
const keywords = `${set.brand} ${set.style}`.trim();
const url = missingGroup === 'Bra'
? ebay.braListingUrl({ keywords, colour: set.colour, bounds })
: ebay.knickersListingUrl({ keywords, colour: set.colour, bounds });
try {
const { pages } = await fetchPages([url]);
const html = pages.get(url);
if (!html) return null;
const best = ebay.listingItems(html)
.filter((item) => ebay.titleMatchesColour(item.title, set.colour))
.filter((item) => sizeInBounds(missingGroup, item.size, bounds))
.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))[0];
if (!best) return null;
return { name: best.title, price: best.price != null ? money(best.price) : '', condition: best.condition, url: best.url };
} catch (err) {
console.error(`eBay fallback search failed for ${set.key}:`, err);
return null;
}
}

// Supersedes, never stacks: a later search for the same set key
// replaces whatever was found before rather than piling up repeat
// finds for something not yet bought.
function upsertFind(set, missingGroup, fields) {
data.setCompletionFinds = (data.setCompletionFinds || []).filter((f) => f.setKey !== set.key);
data.setCompletionFinds.push(blankSetCompletionFind({
setKey: set.key, brand: set.brand, style: set.style, colour: set.colour, missingGroup, ...fields,
}));
}

async function runSetCompletionSearch({ force = false } = {}) {
pruneStaleEntries();
const sets = setsToCheck({ force });
const { reportCheck } = await import('./sitehealth.js');
if (!sets.length) {
reportCheck('set-completion-search', true, 'Nothing due.');
return 'Nothing was due to check yet.';
}
const bounds = data.prefs.setCompletionSizeBounds;
const listingCache = new Map();
let foundCount = 0;
let checkedCount = 0;
let errorCount = 0;
for (const set of sets) {
const missingGroup = set.missing[0];
if (!missingGroup) continue;
checkedCount++;
try {
const listingHtml = await listingForGroup(missingGroup, listingCache);
const candidates = candidatesForSet(set, missingGroup, listingHtml);
let matchPage = null;
if (candidates.length) {
const { pages: prodPages } = await fetchPages(candidates.map((c) => c.url));
for (const c of candidates) {
const html = prodPages.get(c.url);
if (!html) continue;
matchPage = confirmCandidate(c.url, html, set, missingGroup, bounds);
if (matchPage) break;
}
}
const st = searchesStore()[set.key] || { attempts: 0 };
const attempts = (st.attempts || 0) + 1;
if (matchPage) {
upsertFind(set, missingGroup, {
source: 'agentprovocateur',
name: `${matchPage.piece || set.style} — ${matchPage.colour || set.colour}`,
price: money(matchPage.net != null ? matchPage.net : matchPage.now),
url: matchPage.url || '',
});
foundCount++;
} else if (attempts >= EBAY_FALLBACK_AFTER_ATTEMPTS) {
const ebayResult = await tryEbayFallback(set, missingGroup, bounds);
if (ebayResult) {
upsertFind(set, missingGroup, { source: 'ebay', ...ebayResult });
foundCount++;
}
}
searchesStore()[set.key] = { attempts, lastCheckedAt: new Date().toISOString() };
} catch (err) {
console.error(`Set-completion search failed for ${set.key}:`, err);
errorCount++;
}
}
queueSave();
const summary = `Checked ${checkedCount} set(s), ${foundCount} found.${errorCount ? ` (${errorCount} error(s))` : ''}`;
reportCheck('set-completion-search', true, summary);
const { renderInventory } = await import('./shopping.js');
renderInventory();
return summary;
}

// "Check now" bypasses isDueForSet entirely (setsToCheck's own `force`
// param), same two-gates-not-one shape forceSchoolCalendarCheck
// established -- a manual click should always check something, not
// silently no-op because nothing's technically due yet.
async function forceSetCompletionSearch() {
return runSetCompletionSearch({ force: true });
}

// Manual overrides for the two buttons on each incomplete set's own
// card (shopping.js) -- reported directly as wanted, rather than
// waiting for EBAY_FALLBACK_AFTER_ATTEMPTS or a weekly backoff to let
// either search actually run. Deliberately don't touch searchesStore()'s
// attempts/lastCheckedAt -- that bookkeeping belongs to the automatic
// weekly cycle above; a one-off manual check shouldn't reset or advance
// it.
async function forceEbaySearchForSet(setKey) {
const set = incompleteCoreSets().find((s) => s.key === setKey);
if (!set) return 'That set is no longer incomplete.';
const missingGroup = set.missing[0];
if (!missingGroup) return 'Nothing missing on that set.';
const bounds = data.prefs.setCompletionSizeBounds;
const result = await tryEbayFallback(set, missingGroup, bounds);
if (result) { upsertFind(set, missingGroup, { source: 'ebay', ...result }); queueSave(); }
const { renderInventory } = await import('./shopping.js');
renderInventory();
return result ? `Found on eBay: ${result.name}.` : 'Nothing found on eBay matching the colour and size.';
}

// Same shape, a different search -- ai.js's
// searchDepartmentStoresForMissingSetPiece, UK department stores and
// other retailers, new stock rather than resale (see that function's
// own comment for why it's a separate search from eBay above, not a
// second attempt at the same one).
async function forceRetailerSearchForSet(setKey) {
const set = incompleteCoreSets().find((s) => s.key === setKey);
if (!set) return 'That set is no longer incomplete.';
const missingGroup = set.missing[0];
if (!missingGroup) return 'Nothing missing on that set.';
const bounds = data.prefs.setCompletionSizeBounds;
const query = `${set.brand} ${set.style} ${missingGroup}`.trim();
const boundsText = missingGroup === 'Bra'
? `band ${bounds.braBandMin}-${bounds.braBandMax}, cup ${bounds.braCupMin}-${bounds.braCupMax}`
: `size ${bounds.knickersMin}-${bounds.knickersMax}`;
let result = null;
try {
const { searchDepartmentStoresForMissingSetPiece } = await import('../ai.js');
result = await searchDepartmentStoresForMissingSetPiece(query, set.colour, boundsText);
} catch (err) {
console.error(`Retailer search failed for ${set.key}:`, err);
const { renderInventory } = await import('./shopping.js');
renderInventory();
return 'Search failed -- see console.';
}
if (result) { upsertFind(set, missingGroup, { source: 'retailer', ...result }); queueSave(); }
const { renderInventory } = await import('./shopping.js');
renderInventory();
return result ? `Found at ${result.retailer || 'a retailer'}: ${result.name}.` : 'Nothing found at other retailers matching the colour and size.';
}

export {
runSetCompletionSearch, forceSetCompletionSearch, forceEbaySearchForSet, forceRetailerSearchForSet,
parseBraSize, sizeInBounds, confirmCandidate, intervalForAttempt,
};
