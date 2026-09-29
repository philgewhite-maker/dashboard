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
id: p.id,
label: p.label,
name,
merchantUrl: p.merchant(slug),
searchUrl: p.search(name),
}));
}

export { cashbackLinks, merchantSlug, retailerFrom, PROVIDERS };
