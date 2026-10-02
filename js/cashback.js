// "Did I go via cashback?" — the question worth asking at the moment of
// buying, not afterwards, because afterwards there is nothing to be done.
//
// This does NOT try to know the rate. Both sites show one publicly (Agent
// Provocateur reads 1.6% on Quidco and 5% on TopCashback as this was
// written) but a scraped number goes stale silently, and a stale rate
// shown next to a purchase is worse than no rate: it decides which link
// you click. So the job here is only to get you to the right page, where
// the live rate is on screen and the click-through is one tap.
//
// Nothing here can set a tracking cookie either, and it deliberately
// doesn't pretend to. That cookie is set by the provider's own redirect
// on their own domain when you genuinely pass through it -- which is
// exactly what these links are for.

// Both use a merchant slug in a predictable path, checked live against a
// real retailer: quidco.com/agent-provocateur/ redirects to its
// /merchant/ page, topcashback.co.uk/agent-provocateur/ serves directly.
// Neither needed a login to reach.
const PROVIDERS = [
{
id: 'quidco',
label: 'Quidco',
// Its rate cannot be read by anything here, so nothing tries. Measured
// rather than assumed: a full browser header set -- User-Agent,
// Accept, Accept-Language, all four Sec-Fetch-*, Sec-CH-UA,
// Upgrade-Insecure-Requests -- from a home connection still gets
// "Just a moment..." and HTTP 403. That is a Cloudflare JS challenge,
// not a header check, so the web host and the home agent fail it
// identically and no amount of request shaping helps.
//
// The LINK is the part that matters anyway: clicking through is what
// tracks the purchase, and their page shows the live rate when you get
// there. Only the number alongside it is missing, and a request per
// check that could never succeed is worse than an absent figure.
fetchable: false,
merchant: (slug) => `https://www.quidco.com/${slug}/`,
// Quidco's search bounces to a login when signed out. That's fine as
// a fallback -- it's your own browser, where you are signed in.
search: (name) => `https://www.quidco.com/search/?q=${encodeURIComponent(name)}`,
},
{
id: 'topcashback',
label: 'TopCashback',
merchant: (slug) => `https://www.topcashback.co.uk/${slug}/`,
// Checked live: /search/?q= 404s, but /search/merchants/?s= is the
// real one -- found because a wrong slug REDIRECTS there. That
// redirect is why guessing is safe here: /johnlewis/ lands on
// /john-lewis/, /tesco/ lands on a search for tesco. A bad guess
// costs nothing.
search: (name) => `https://www.topcashback.co.uk/search/merchants/?s=${encodeURIComponent(name)}`,
},
];

// A retailer name to the slug both sites happen to share. Kept simple on
// purpose: a guessed slug that 404s costs one click and the search link
// is right beside it, whereas a lookup table would be a list to maintain
// for every shop you ever buy from.
function merchantSlug(name) {
return String(name || '')
.toLowerCase()
.replace(/&/g, 'and')
.replace(/['’.]/g, '')
.replace(/[^a-z0-9]+/g, '-')
.replace(/^-+|-+$/g, '');
}

// The retailer, worked out from whatever a record actually has. A brand
// recorded on the want wins, since it's what you typed; otherwise the
// hostname, with the common noise stripped.
function retailerFrom({ brand, retailer, url } = {}) {
const named = String(brand || retailer || '').trim();
if (named) return named;
try {
const host = new URL(String(url || '')).hostname.replace(/^www\./, '');
const core = host.split('.')[0];
return core.replace(/([a-z])([A-Z])/g, '$1 $2');
} catch (err) {
return '';
}
}

// [{id, label, merchantUrl, searchUrl}] for a retailer, or [] when there
// isn't enough to go on.
function cashbackLinks(source) {
const name = retailerFrom(source);
if (!name) return [];
const slug = merchantSlug(name);
if (!slug) return [];
return PROVIDERS.map((p) => ({
fetchable: p.fetchable !== false,
id: p.id,
label: p.label,
name,
merchantUrl: p.merchant(slug),
searchUrl: p.search(name),
}));
}

// ---- Last known rate ------------------------------------------------------
//
// Both sites publish the rate logged out, in a different place each:
//
//   Quidco puts it in the page TITLE -- "Agent Provocateur 1.6% Cashback
//   | Quidco".
//
//   TopCashback puts it in the META DESCRIPTION -- "Save money at Agent
//   Provocateur & get up to 5% cashback...". It's also in a
//   .merch-cat__rate element, but the meta tag is the better target: it
//   survives a markup reshuffle and needs no DOM to read.
//
// The scoping matters more than it looks. A TopCashback merchant page is
// covered in OTHER merchants' rates -- nav-bar tenancies advertising "Up
// to 12% Cashback" for a games shop and so on -- and a naive scrape of
// the first "%" on the page returns one of those. That's worse than no
// number, because it's plausible and wrong. Hence a named source per
// provider rather than a general search.
function parseRate(html, providerId) {
const text = String(html || '');
if (providerId === 'topcashback') {
// The rate card first -- it's the merchant's own headline figure and
// states it exactly ("Online Purchase 5%"), where the meta hedges it
// as "up to 5%". Class-scoped so a nav tenancy can't be mistaken for
// it.
const card = /class=["'][^"']*merch-cat__rate[^"']*["'][^>]*>\s*(?:up to\s*)?([\d.]+)\s*%/i.exec(text);
if (card) return { percent: parseFloat(card[1]), upTo: false, text: `${card[1]}%` };
const meta = (text.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i) || [])[1];
const m = meta && /(up to\s*)?([\d.]+)\s*%\s*cashback/i.exec(meta);
return m ? { percent: parseFloat(m[2]), upTo: !!m[1], text: m[0].replace(/\s+/g, ' ').trim() } : null;
}
if (providerId !== 'quidco') return null;
const title = (text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
const m = title && /(up to\s*)?([\d.]+)\s*%\s*cashback/i.exec(title);
return m ? { percent: parseFloat(m[2]), upTo: !!m[1], text: m[0].replace(/\s+/g, ' ').trim() } : null;
}

// Weekly. Rates move on promo cycles rather than hourly, and each check
// is a real page fetch through a route a retailer may rate-limit, so
// daily would be several times the traffic for an answer that rarely
// differs. The age is always on screen and a refresh is one tap, which
// covers the case that actually matters: you're about to spend money and
// want today's number rather than last Tuesday's.
const RATE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
// Past this it isn't shown as a rate at all, only as "last seen" -- a
// month-old number has no business influencing which link you click.
const RATE_STALE_MS = 30 * 24 * 3600 * 1000;

function rateKey(providerId, slug) { return `${providerId}|${slug}`; }

function rateFor(store, providerId, slug) {
const found = (store || {})[rateKey(providerId, slug)];
if (!found || !found.at) return null;
const age = Date.now() - new Date(found.at).getTime();
return { ...found, ageMs: age, stale: age > RATE_STALE_MS, due: age > RATE_MAX_AGE_MS };
}

function ageLabel(ms) {
const days = Math.floor(ms / 86400000);
if (days < 1) return 'today';
if (days === 1) return 'yesterday';
if (days < 14) return `${days}d ago`;
return `${Math.round(days / 7)}w ago`;
}

export { cashbackLinks, merchantSlug, retailerFrom, parseRate, rateFor, rateKey, ageLabel, RATE_MAX_AGE_MS, PROVIDERS };
