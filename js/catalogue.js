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
openlibrary: 'Open Library', musicbrainz: 'MusicBrainz',
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

// Everything a link can tell us without being asked twice: the title, who
// it's by, when, and a picture. Books go to Open Library by ISBN, which
// answers all four in one keyless call; everything else reads the page's
// own og: tags out of the HTML the artwork fetch needed anyway.
async function linkMetadata(link, externalIds = {}) {
const isbn = externalIds.asin && /^\d{9}[\dX]$/i.test(externalIds.asin) ? externalIds.asin : '';
let book = null;
if (isbn) {
try {
const res = await fetch(`https://openlibrary.org/search.json?limit=1&fields=title,author_name,first_publish_year,cover_i&q=isbn:${encodeURIComponent(isbn)}`);
if (res.ok) {
const doc = ((await res.json()).docs || [])[0];
if (doc) {
book = {
title: doc.title || '',
creator: (doc.author_name || [])[0] || '',
year: doc.first_publish_year ? String(doc.first_publish_year) : '',
// ONLY a cover_i url, never one guessed from the ISBN.
// Confirmed live on "The Impossible Fortune": Open Library
// holds the book but no cover, and the by-ISBN URL 404s -- so
// guessing it returned a broken image AND stopped the page's
// own cover ever being tried. No cover here means keep looking.
imageUrl: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : '',
};
}
}
} catch (err) {
// Fall through: the page itself still has a title and a picture.
}
}
if (book && book.imageUrl) return book;
if (!link) return book;

// Either this isn't a book, or the catalogue had no cover for it. The
// page's own og: tags fill whichever half is still missing -- and if
// that fetch fails (no live sync, or a site that blocks automated
// requests, Amazon being the known one), whatever the catalogue gave is
// still better than nothing.
let html = '';
try {
const { fetchPageHtml } = await import('./files.js');
html = await fetchPageHtml(link);
} catch (err) {
if (book) return book;
throw err;
}
const pageTitle = cleanPageTitle(ogValue(html, 'og:title') || '');
const pageImage = ogImageFrom(html, link);
return {
title: (book && book.title) || pageTitle,
creator: (book && book.creator) || '',
year: (book && book.year) || '',
imageUrl: pageImage,
};
}

// Page titles carry the site's own furniture ("... : Amazon.co.uk: Books",
// "Watch X | Netflix"), which is noise in a list of titles.
function cleanPageTitle(title) {
return String(title || '')
.split(/\s[|:]\s|\s[-–—]\s/)[0]
.replace(/\s+/g, ' ')
.trim()
.slice(0, 120);
}

function ogValue(html, property) {
const patterns = [
new RegExp(`<meta[^>]+property=["']${property}["'][^>]*content=["']([^"']+)["']`, 'i'),
new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*property=["']${property}["']`, 'i'),
];
for (const re of patterns) {
const m = String(html || '').match(re);
if (m && m[1]) return m[1];
}
return '';
}

// ---- Where can I already watch it? ------------------------------------

// TMDb's watch/providers is the documented, per-country answer to "what's
// this streaming on", split into subscription (flatrate), rent and buy.
// Plex Discover shows the same kind of thing, but only through an
// undocumented endpoint needing a plex.tv account token, so this is the
// one built on. Data is JustWatch's, and TMDb's terms ask that they're
// credited wherever it's shown -- hence the attribution in the UI.
//
// Needs only the TMDb id already stored on the item, and runs in the
// browser: nothing here depends on the home agent.
async function watchProviders(externalIds = {}, region = 'GB') {
const tmdb = externalIds.tmdb || '';
const [type, id] = tmdb.split('/');
if (!id || (type !== 'movie' && type !== 'tv')) return null;
const { getLocalSettings } = await import('./state.js');
const key = (await getLocalSettings()).tmdbApiKey;
if (!key) return null;
const res = await fetch(`https://api.themoviedb.org/3/${type}/${id}/watch/providers?api_key=${encodeURIComponent(key)}`);
if (!res.ok) throw new Error(`TMDb providers lookup failed (HTTP ${res.status}).`);
const body = await res.json();
const here = (body.results || {})[region];
// TMDb lists every resold variant of the same service: "Amazon Prime
// Video", "Amazon Prime Video with Ads", "Apple TV Amazon Channel".
// Shown raw, one film sprouts four near-identical chips, and an
// add-on channel you don't have gets ticked because its name contains
// a service you do. So variants collapse to the base service, and
// "... Channel" resales are dropped: those are separate paid add-ons,
// not the subscription they're named after.
const names = (list) => {
const seen = new Set();
const out = [];
for (const p of list || []) {
const raw = p.provider_name || '';
if (!raw || /\bchannel\b/i.test(raw)) continue;
const base = raw.replace(/\s+with\s+ads$/i, '').trim();
const key = base.toLowerCase();
if (seen.has(key)) continue;
seen.add(key);
out.push(base);
}
return out;
};
return {
checkedAt: new Date().toISOString(),
region,
flatrate: here ? names(here.flatrate) : [],
rent: here ? names(here.rent) : [],
buy: here ? names(here.buy) : [],
link: here ? (here.link || '') : '',
};
}

// Does a provider match something already being paid for? Compared by
// name, loosely in both directions, because a subscription is typed by
// hand ("Netflix", "Amazon Prime") while TMDb returns the service's
// formal name ("Amazon Prime Video"). The alias list covers the few
// where neither string contains the other.
const PROVIDER_ALIASES = {
'amazon prime video': ['prime', 'amazon'],
'disney plus': ['disney+', 'disney'],
'apple tv plus': ['apple tv+', 'appletv', 'apple'],
'now tv': ['now', 'sky'],
'bbc iplayer': ['bbc', 'tv licence'],
'all 4': ['channel 4'],
'itvx': ['itv'],
};

function subscriptionFor(providerName, subscriptions) {
const p = String(providerName || '').toLowerCase().trim();
if (!p) return null;
const aliases = [p, ...(PROVIDER_ALIASES[p] || [])];
return (subscriptions || []).find((s) => {
const n = String(s.name || '').toLowerCase().trim();
if (!n) return false;
return aliases.some((a) => n.includes(a) || a.includes(n));
}) || null;
}

// ---- Searching by title ----------------------------------------------

// A typed title is ambiguous in a way a link never is: "Gladiator" is two
// films, a series, a soundtrack and a novel. So a search returns
// CANDIDATES for the user to choose between, and choosing one is what
// supplies the id, the year and the artwork in a single step -- rather
// than storing a bare string nothing can later match against Plex.
//
// Each source is picked for being usable from a browser: free, CORS-open,
// and (except TMDb) needing no key at all.
const TMDB_IMAGE = 'https://image.tmdb.org/t/p/w185';

async function searchTitle(kind, query) {
const q = String(query || '').trim();
if (!q) return [];
if (kind === 'book') return searchOpenLibrary(q);
if (kind === 'album' || kind === 'track' || kind === 'artist') return searchMusicBrainz(q);
if (kind === 'film' || kind === 'tv' || kind === 'other') return searchTmdb(q, kind);
return []; // podcast has no free catalogue worth the code yet
}

// TMDb needs a free key, kept in local settings like the others. `multi`
// rather than `movie`, so "Gladiator" can come back as both the film and
// the series and the ambiguity is visible rather than guessed at.
async function searchTmdb(q, kind) {
const { getLocalSettings } = await import('./state.js');
const key = (await getLocalSettings()).tmdbApiKey;
if (!key) return [];
const path = kind === 'film' ? 'movie' : kind === 'tv' ? 'tv' : 'multi';
const res = await fetch(`https://api.themoviedb.org/3/search/${path}?api_key=${encodeURIComponent(key)}&query=${encodeURIComponent(q)}`);
if (!res.ok) throw new Error(res.status === 401 ? 'TMDb rejected that API key.' : `TMDb search failed (HTTP ${res.status}).`);
const body = await res.json();
return (body.results || [])
.filter((r) => (r.media_type || path) !== 'person')
.slice(0, 8)
.map((r) => {
const type = r.media_type && r.media_type !== 'multi' ? r.media_type : path;
const isTv = type === 'tv';
const date = (isTv ? r.first_air_date : r.release_date) || '';
return {
kind: isTv ? 'tv' : 'film',
title: (isTv ? r.name : r.title) || '',
creator: '',
year: date.slice(0, 4),
notes: (r.overview || '').slice(0, 140),
imageUrl: r.poster_path ? `${TMDB_IMAGE}${r.poster_path}` : '',
externalIds: { tmdb: `${isTv ? 'tv' : 'movie'}/${r.id}` },
link: `https://www.themoviedb.org/${isTv ? 'tv' : 'movie'}/${r.id}`,
};
})
.filter((c) => c.title);
}

async function searchOpenLibrary(q) {
const res = await fetch(`https://openlibrary.org/search.json?limit=8&fields=key,title,author_name,first_publish_year,cover_i,isbn&q=${encodeURIComponent(q)}`);
if (!res.ok) throw new Error(`Open Library search failed (HTTP ${res.status}).`);
const body = await res.json();
return (body.docs || []).slice(0, 8).map((d) => {
const isbn = (d.isbn || []).find((i) => /^\d{9}[\dX]$/i.test(i)) || '';
return {
kind: 'book',
title: d.title || '',
creator: (d.author_name || [])[0] || '',
year: d.first_publish_year ? String(d.first_publish_year) : '',
notes: '',
imageUrl: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg` : '',
externalIds: { openlibrary: String(d.key || '').replace('/works/', ''), ...(isbn ? { asin: isbn } : {}) },
link: d.key ? `https://openlibrary.org${d.key}` : '',
};
}).filter((c) => c.title);
}

// Release GROUPS, not releases: "the album Untrue", not one of its
// fourteen pressings. Cover Art Archive serves artwork for the same id,
// so no second lookup is needed to know the URL.
async function searchMusicBrainz(q) {
const res = await fetch(`https://musicbrainz.org/ws/2/release-group?fmt=json&limit=8&query=${encodeURIComponent(q)}`);
if (!res.ok) throw new Error(`MusicBrainz search failed (HTTP ${res.status}).`);
const body = await res.json();
return (body['release-groups'] || []).slice(0, 8).map((g) => ({
kind: 'album',
title: g.title || '',
creator: (g['artist-credit'] || [])[0]?.name || '',
year: String(g['first-release-date'] || '').slice(0, 4),
notes: g['primary-type'] || '',
imageUrl: `https://coverartarchive.org/release-group/${g.id}/front-250`,
externalIds: { musicbrainz: `release-group/${g.id}` },
link: `https://musicbrainz.org/release-group/${g.id}`,
})).filter((c) => c.title);
}

export { identifyUrl, catalogueLabel, artworkUrl, linkMetadata, ogImageFrom, searchTitle, watchProviders, subscriptionFor, CATALOGUE_LABELS };
