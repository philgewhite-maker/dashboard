// What a link actually IS, kept rather than flattened.
//
// A shared imdb.com/title/tt0468569 is not merely "a film link": it's a
// specific work with a specific id, and that id is the thing worth
// keeping. Throwing it away and storing only a title means every later
// question -- is this on Plex, which release is it, what's the poster --
// has to re-identify the work from a string, badly ("Heat" is four
// films). So every intake path runs the URL through here first, and the
// ids land on the record's `externalIds`.
//
// All of this is deterministic string work: no AI, no network, nothing
// to configure. Artwork below is the one part that needs the network,
// and it degrades to "no picture" rather than failing a capture.

// Each entry: a matcher against a normalised hostname, and what to pull
// out of the URL. `kind` is what this catalogue proves the item is --
// TMDb's /tv/ path is proof, IMDb's /title/ is not (it covers both), so
// IMDb deliberately declares no kind and leaves the default alone.
const CATALOGUES = [
// IMDb's /title/ covers films and series alike, so the kind isn't
// proven -- `fallbackKind` is the commoner guess, one tap to correct,
// and is deliberately absent on the book/video catalogues below, where
// guessing "film" would be plainly wrong.
{ key: 'imdb', host: /(^|\.)imdb\.com$/, path: /\/title\/(tt\d+)/i, fallbackKind: 'film' },
{ key: 'tmdb', host: /(^|\.)themoviedb\.org$/, path: /\/(movie|tv)\/(\d+)/i, kindByGroup: { movie: 'film', tv: 'tv' } },
{ key: 'tvdb', host: /(^|\.)thetvdb\.com$/, path: /\/(series|movies)\/([\w-]+)/i, kindByGroup: { series: 'tv', movies: 'film' } },
{ key: 'trakt', host: /(^|\.)trakt\.tv$/, path: /\/(movies|shows)\/([\w-]+)/i, kindByGroup: { movies: 'film', shows: 'tv' } },
{ key: 'letterboxd', host: /(^|\.)letterboxd\.com$/, path: /\/film\/([\w-]+)/i, kind: 'film' },
{ key: 'rottentomatoes', host: /(^|\.)rottentomatoes\.com$/, path: /\/(m|tv)\/([\w-]+)/i, kindByGroup: { m: 'film', tv: 'tv' } },
{ key: 'spotify', host: /(^|\.)spotify\.com$/, path: /\/(album|track|artist|show|episode)\/([A-Za-z0-9]{22})/i, kindByGroup: { album: 'album', track: 'track', artist: 'artist', show: 'podcast', episode: 'podcast' } },
{ key: 'appleMusic', host: /(^|\.)music\.apple\.com$/, path: /\/(album|song)\/[^/]+\/(\d+)/i, kindByGroup: { album: 'album', song: 'track' } },
{ key: 'discogs', host: /(^|\.)discogs\.com$/, path: /\/(release|master)\/(\d+)/i, kind: 'album' },
{ key: 'bandcamp', host: /(^|\.)bandcamp\.com$/, path: /\/(album|track)\/([\w-]+)/i, kindByGroup: { album: 'album', track: 'track' } },
{ key: 'goodreads', host: /(^|\.)goodreads\.com$/, path: /\/book\/show\/(\d+)/i },
{ key: 'youtube', host: /(^|\.)(youtube\.com|youtu\.be)$/, path: /(?:\/watch\?v=|youtu\.be\/|\/shorts\/)([\w-]{11})/i },
// Same ASIN shape ai.js's own shopping search already reads -- a book's
// ASIN is usually its ISBN-10, which is what makes a free cover lookup
// possible below.
{ key: 'asin', host: /(^|\.)amazon\.[\w.]+$/, path: /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i },
];

// {ids, kind} -- `kind` is null when the URL doesn't prove one.
function identifyUrl(url) {
let u;
try { u = new URL(url); } catch (e) { return { ids: {}, kind: null }; }
const host = u.hostname.replace(/^www\./, '').toLowerCase();
const full = `${u.pathname}${u.search}`;
for (const cat of CATALOGUES) {
if (!cat.host.test(host)) continue;
const m = full.match(cat.path);
if (!m) continue;
// A two-group pattern is "type + id" (tmdb /movie/123); a one-group
// pattern is just the id (imdb /title/tt123).
const hasType = m.length > 2;
const type = hasType ? m[1].toLowerCase() : '';
const id = hasType ? m[2] : m[1];
const kind = cat.kind || (cat.kindByGroup ? cat.kindByGroup[type] : null) || cat.fallbackKind || null;
// Bandcamp's artist lives in the subdomain, and is the only part
// that makes its slug unique.
const value = cat.key === 'bandcamp' ? `${host.split('.')[0]}/${type}/${id}` : (hasType ? `${type}/${id}` : id);
return { ids: { [cat.key]: value }, kind };
}
return { ids: {}, kind: null };
}

// A human label for where something came from, for a row that would
// otherwise just show a bare link.
const CATALOGUE_LABELS = {
imdb: 'IMDb', tmdb: 'TMDb', tvdb: 'TVDB', trakt: 'Trakt', letterboxd: 'Letterboxd',
rottentomatoes: 'Rotten Tomatoes', spotify: 'Spotify', appleMusic: 'Apple Music',
discogs: 'Discogs', bandcamp: 'Bandcamp', goodreads: 'Goodreads', youtube: 'YouTube', asin: 'Amazon',
};

function catalogueLabel(externalIds) {
const key = Object.keys(externalIds || {})[0];
return key ? (CATALOGUE_LABELS[key] || key) : '';
}

// ---- Artwork ---------------------------------------------------------

// Two routes, cheapest first. Both best-effort: artwork is decoration,
// so every failure returns '' and the caller just shows no picture.
//
// 1. A book's ASIN is normally its ISBN-10, and Open Library serves
//    covers by ISBN with no key and no request from us at all -- it's
//    just a URL. `default=false` makes a miss a real 404 rather than a
//    blank placeholder image.
// 2. Everything else: the page's own og:image, read out of the HTML that
//    recipe-fetch.php already fetches for the Menu tab (SSRF-guarded
//    server-side; see that file). One route covers IMDb, TVDB,
//    Letterboxd, Trakt, Spotify, Goodreads, Bandcamp and anything added
//    later, with no per-site integration.
//
// Spotify's open oEmbed endpoint was tried as a third route and removed:
// it sends no Access-Control-Allow-Origin, so a browser can't read it at
// all (confirmed live), and its pages carry og:image regardless.
async function artworkUrl(link, externalIds = {}) {
const isbn = externalIds.asin && /^\d{9}[\dX]$/i.test(externalIds.asin) ? externalIds.asin : '';
if (isbn) return `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg?default=false`;

if (!link) return '';
try {
const { fetchPageHtml } = await import('./files.js');
const html = await fetchPageHtml(link);
return ogImageFrom(html, link);
} catch (err) {
console.error("Couldn't read artwork for", link, err);
return '';
}
}

// Attribute order isn't fixed in the wild, so both arrangements are
// tried before giving up; twitter:image is the common fallback on sites
// that predate og:.
function ogImageFrom(html, pageUrl) {
const patterns = [
/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]*content=["']([^"']+)["']/i,
/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image(?::secure_url)?["']/i,
/<meta[^>]+name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i,
];
for (const re of patterns) {
const m = String(html || '').match(re);
if (m && m[1]) {
try { return new URL(m[1], pageUrl).href; } catch (e) { return m[1]; }
}
}
return '';
}

export { identifyUrl, catalogueLabel, artworkUrl, ogImageFrom, CATALOGUE_LABELS };
