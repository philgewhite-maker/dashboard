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

// Thrown (not just a generic Error) so a caller can distinguish "no key
// set" from any other TMDb failure and render a real link into Settings
// instead of just echoing the message as text -- mirrors ai.js's own
// MissingKeyError for the Anthropic key, same reasoning.
class MissingTmdbKeyError extends Error {
constructor() { super('No TMDb API key set. Add one in Settings.'); this.name = 'MissingTmdbKeyError'; }
}

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
// Does this URL actually resolve to a picture? Cheap to ask in a browser
// -- load it and see -- and it removes the guesswork entirely: a cover
// is only ever stored once it has been seen to work.
//
// The size floor matters: Amazon answers an unknown product id with a
// 1-pixel placeholder rather than a 404, which "did it load" alone would
// happily accept.
function probeImage(url, { minWidth = 50, timeoutMs = 6000 } = {}) {
return new Promise((resolve) => {
const img = new Image();
let settled = false;
const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
img.onload = () => done(img.naturalWidth >= minWidth);
img.onerror = () => done(false);
img.referrerPolicy = 'no-referrer';
img.src = url;
setTimeout(() => done(false), timeoutMs);
});
}

// In preference order, so the first that works wins rather than the first
// that exists in theory.
async function firstLoadableImage(urls, options) {
for (const url of urls) {
if (url && await probeImage(url, options)) return url;
}
return '';
}

// Covers for anything with an Amazon id, which is most books. Confirmed
// live on "The Impossible Fortune", where Open Library has the book but
// no cover: Amazon's own image host answers by ASIN, and Google Books'
// content endpoint answers by ISBN without touching the API that
// rate-limits (its keyless quota is exhausted and returns 429).
function coverCandidates(externalIds, openLibraryCoverId) {
const asin = externalIds.asin || '';
const isbn = /^\d{9}[\dX]$/i.test(asin) ? asin : '';
return [
openLibraryCoverId ? `https://covers.openlibrary.org/b/id/${openLibraryCoverId}-M.jpg` : '',
asin ? `https://m.media-amazon.com/images/P/${asin}.01.L.jpg` : '',
isbn ? `https://books.google.com/books/content?vid=ISBN${isbn}&printsec=frontcover&img=1&zoom=2` : '',
].filter(Boolean);
}

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
// Open Library first when it has one, then Amazon's image host,
// then Google Books -- each tried for real, so a catalogue
// holding the book but no cover (the case that broke this) falls
// through instead of storing a URL that 404s.
imageUrl: await firstLoadableImage(coverCandidates(externalIds, doc.cover_i)),
};
}
}
} catch (err) {
// Fall through: the page itself still has a title and a picture.
}
}
if (book && book.imageUrl) return book;
// Not a book, but still something Amazon sells (a Blu-ray, a boxset):
// the same image host answers for any product id. Held rather than
// returned, so the page can still supply a title below.
const amazonArt = !book && externalIds.asin ? await firstLoadableImage(coverCandidates(externalIds, '')) : '';
if (!link) return book || (amazonArt ? { title: '', creator: '', year: '', imageUrl: amazonArt } : null);

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
if (amazonArt) return { title: '', creator: '', year: '', imageUrl: amazonArt };
throw err;
}
// og:title first, then the plain <title>. TheTVDB publishes NEITHER an
// og:title nor an og:image -- which is why a TVDB link arrived tagged
// but nameless and blank -- yet its <title> is a clean "Formula 1 -
// TheTVDB.com" that cleanPageTitle already knows how to trim. Worth
// having generally: a site with no Open Graph tags at all is common
// enough, and its <title> is almost always better than nothing.
const pageTitle = cleanPageTitle(ogValue(html, 'og:title') || (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
const pageImage = ogImageFrom(html, link) || tvdbArtwork(html);
return {
title: (book && book.title) || pageTitle,
creator: (book && book.creator) || '',
year: (book && book.year) || '',
// A cover already proven to load beats one merely advertised by the
// page, which may be a logo or a placeholder.
imageUrl: (book && book.imageUrl) || amazonArt || pageImage,
};
}

// What a TheTVDB series page says about the series itself, beyond its
// name and picture: whether it's still running, and whether its episodes
// come in SESSIONS.
//
// The second one is the interesting question. Some series put several
// episodes out per event -- Formula 1 gives five a race weekend (three
// practices, qualifying, the race), and MotoGP, WRC, UFC, snooker and
// the rest are built the same way. Wanting such a series almost never
// means wanting every episode, and Sonarr can't express "only the race":
// it monitors by season or by "future episodes", never by title. So the
// filter has to be decided here, and this is what notices the series
// needs one.
//
// Detected from the DATA rather than a list of sports: a sessioned
// series names its episodes "Venue (Session)", and the same handful of
// session words repeat across hundreds of episodes. A drama with one
// bracketed title somewhere doesn't qualify, because one is not a
// pattern.
const SESSION_TITLE_RE = /^\s*(.+?)\s*\(([^)]{2,24})\)\s*$/;
const MIN_SESSIONED_EPISODES = 12;

function tvdbSeriesInfo(html) {
const text = String(html || '');
// "Status" then "Continuing" or "Ended", as the page's own label/value
// pair -- read by looking just past the label rather than for the word
// anywhere, which would also match a synopsis.
const statusMatch = /Status[\s\S]{0,120}?>\s*(Continuing|Ended|Upcoming)\s*</i.exec(text);
return { status: statusMatch ? statusMatch[1] : '', ongoing: /continuing|upcoming/i.test(statusMatch ? statusMatch[1] : '') };
}

// The series' seasons, newest first, read off the season links its own
// page carries.
//
// This exists because the "all seasons" listing is unusable for exactly
// the series that most needs a filter: Formula 1's runs to 2,667
// episodes and 3MB, and TheTVDB takes twelve seconds to START sending
// it -- past the page proxy's ten-second timeout, so the lookup died
// with nothing received at all. One season is 173KB and arrives in
// 1.3s, and one season is plenty to read the session vocabulary from,
// since a race year repeats it twenty-odd times. It's the BETTER sample
// too: current naming rather than an average over a decade of renames.
//
// Numeric sort because F1's seasons are years while a drama's are
// 1, 2, 3 -- either way the largest is the most recent.
function tvdbSeasonNumbers(html) {
const found = new Set();
for (const m of String(html || '').matchAll(/\/seasons\/official\/(\d{1,4})\b/gi)) found.add(m[1]);
return [...found].sort((a, b) => Number(b) - Number(a));
}

// The TVDB id for a series TMDb already knows about.
//
// Sonarr keys everything by TVDB id, but almost nothing in this app
// arrives with one: TV shows come from TMDb search or a shared IMDb
// link, and only a thetvdb.com URL carries a TVDB reference at all. TMDb
// publishes the cross-ids for the same series, so one call turns a show
// that's been sitting in the list for months into one Sonarr can find.
//
// Scraping TheTVDB's own search instead was tried and abandoned: its
// /search page returns a 16KB shell and renders results client-side, so
// there is nothing in the HTML to read (confirmed live -- two /series/
// links on the page, both "/series/create").
//
// Returns {id, via} or null. `via` is reported in the UI because the
// IMDb route takes an extra hop and a wrong answer there is worth being
// able to see the provenance of.
async function tvdbIdViaTmdb(externalIds = {}) {
let tmdbTvId = '';
let via = '';
const stored = String(externalIds.tmdb || '');
const [type, id] = stored.split('/');
// A film has no TVDB series id, and asking for one would silently
// return the wrong kind of answer, so only /tv/ counts.
if (type === 'tv' && id) { tmdbTvId = id; via = 'TMDb'; }
if (!tmdbTvId && !externalIds.imdb) return null;

// Checked only once there is something to look up, and LOUDLY: a silent
// null here reads as "this show just can't be resolved", and the real
// answer -- a missing key, one Settings field away -- would never
// surface. (Search elsewhere in this file stays quiet about a missing
// key because it has a visible empty result; this doesn't.)
const { getLocalSettings } = await import('./state.js');
const key = (await getLocalSettings()).tmdbApiKey;
if (!key) throw new MissingTmdbKeyError();
const q = `api_key=${encodeURIComponent(key)}`;

if (!tmdbTvId && externalIds.imdb) {
// IMDb ids cover films and series alike, so /find is asked which it
// is rather than assumed; tv_results being empty means this is a film
// and there is nothing here to resolve.
const res = await fetch(`https://api.themoviedb.org/3/find/${encodeURIComponent(externalIds.imdb)}?${q}&external_source=imdb_id`);
if (!res.ok) throw new Error(res.status === 401 ? 'TMDb rejected that API key.' : `TMDb lookup failed (HTTP ${res.status}).`);
const body = await res.json();
const hit = (body.tv_results || [])[0];
if (!hit) return null;
tmdbTvId = String(hit.id);
via = 'IMDb → TMDb';
}
if (!tmdbTvId) return null;

const res = await fetch(`https://api.themoviedb.org/3/tv/${encodeURIComponent(tmdbTvId)}/external_ids?${q}`);
if (!res.ok) throw new Error(res.status === 401 ? 'TMDb rejected that API key.' : `TMDb cross-ids failed (HTTP ${res.status}).`);
const body = await res.json();
const tvdb = body.tvdb_id;
// TMDb returns null for a series TheTVDB doesn't carry, which is a real
// answer rather than an error -- some TMDb-only shows genuinely have no
// TVDB entry, and Sonarr can't take them.
return tvdb ? { id: String(tvdb), via } : null;
}

// The session vocabulary a series actually uses, counted. Given the HTML
// of a season listing, returns [{session, count}] most-used first, plus
// whether that's enough of a pattern to call it sessioned.
function tvdbSessions(html) {
const titles = [...String(html || '').matchAll(/\/episodes\/\d+"[^>]*>\s*([^<]{2,80}?)\s*</gi)].map((m) => m[1]);
const counts = new Map();
titles.forEach((t) => {
const m = SESSION_TITLE_RE.exec(t);
if (!m) return;
const session = m[2].trim();
counts.set(session.toLowerCase(), { session, count: (counts.get(session.toLowerCase())?.count || 0) + 1 });
});
const sessions = [...counts.values()].sort((a, b) => b.count - a.count);
const matched = sessions.reduce((n, s) => n + s.count, 0);
return {
sessions,
episodeCount: titles.length,
// A real pattern, not one stray bracket: most titles follow it AND
// there are enough of them to be a recurring event rather than a
// miniseries with parenthetical names.
sessioned: matched >= MIN_SESSIONED_EPISODES && matched > titles.length / 2,
};
}

// The default filter for a sessioned series: the main event only.
// Expressed as what to KEEP rather than what to drop, because the drop
// list is open-ended (practice, qualifying, shootout, warm-up, media day)
// while the thing you want is almost always "the race".
//
// Built from the sessions the series really uses, so a series that calls
// it something else still gets a sensible starting point -- and it's
// shown for editing rather than applied silently.
function defaultSessionFilter(sessions) {
const keep = (sessions || [])
.map((s) => s.session)
.filter((s) => /^(sprint\s+)?race$|^sprint$|^final$|^main event$/i.test(s.trim()));
return keep.length ? keep : (sessions || []).slice(0, 1).map((s) => s.session);
}

// TheTVDB's poster, for the same reason the <title> fallback exists: the
// site publishes no og:image, so a series page offered no picture at all.
// Its artwork sits on a predictable host, and the POSTER path is the one
// worth having -- the same page also carries actor photos and banners
// from that host, and the first image on the page is usually an actor.
function tvdbArtwork(html) {
const m = /https?:\/\/artworks\.thetvdb\.com\/banners\/[^"'\s]*\/posters\/[^"'\s]+/i.exec(String(html || ''));
return m ? m[0] : '';
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

// TMDb lists every resold variant of the same service: "Amazon Prime
// Video", "Amazon Prime Video with Ads", "Apple TV Amazon Channel". Shown
// raw, one film sprouts four near-identical chips, and an add-on channel
// you don't have gets ticked because its name contains a service you do.
//
// Collapsing happens in TWO places on purpose, and this is the shared
// function so they can't drift. Writing-time collapse alone wasn't
// enough: it was added four commits after the field shipped, so every
// item checked in between still has "Amazon Prime Video" AND "Amazon
// Prime Video with Ads" stored on it, and nothing recomputes a record
// that already has an answer. Collapsing on the way out as well means a
// row can't show the pair whenever it was written.
//
// '' means "drop this one": a "... Channel" is a separate paid add-on,
// not the subscription it's named after.
// Confirmed live, twice: TMDb's UK watch/providers answer for one title
// carried both "Netflix" and "Netflix Standard"; for another, "Paramount+",
// "Paramount Plus Premium" AND a third bundle variant, as three separate
// entries. One service, several names for the same tier/bundle
// distinctions JustWatch tracks but this app has no use for on a chip.
// Order matters here: strip a trailing "with <anything>" bundle/add-on
// qualifier first (with Ads, with Showtime, with Live TV, ...), THEN a
// trailing tier word ("Netflix Standard with Ads" only reaches "Standard"
// once "with Ads" is already gone), and normalise a trailing "+" to the
// spelled-out "Plus" PROVIDER_ALIASES' own keys already use ("apple tv
// plus", "disney plus") LAST, so a "+" exposed only after the with-strip
// (e.g. "Paramount+ with Showtime" -> "Paramount+") still normalises.
function canonicalProvider(raw) {
const name = String(typeof raw === 'string' ? raw : (raw && raw.provider_name) || '').trim();
if (!name || /\bchannel\b/i.test(name)) return '';
return name
.replace(/\s+with\s+.+$/i, '')
.replace(/\s+(standard|premium|basic|mobile|essential)$/i, '')
.replace(/\+$/, ' Plus')
.trim();
}

function collapseProviders(list) {
const seen = new Set();
const out = [];
for (const entry of list || []) {
const name = canonicalProvider(entry);
if (!name || seen.has(name.toLowerCase())) continue;
seen.add(name.toLowerCase());
out.push(name);
}
return out;
}

// Display only -- the formal name is what subscriptionFor matches on, and
// shortening before that would break the alias list. A row carrying four
// of these is mostly the word "Video".
const PROVIDER_SHORT = {
'amazon prime video': 'Prime Video',
'apple tv plus': 'Apple TV+',
'disney plus': 'Disney+',
'paramount plus': 'Paramount+',
'bbc iplayer': 'iPlayer',
'sky go': 'Sky',
'now tv': 'NOW',
};

function shortProviderName(name) {
const key = String(name || '').trim().toLowerCase();
return PROVIDER_SHORT[key] || String(name || '').replace(/\s+Plus$/i, '+').trim();
}

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

return {
checkedAt: new Date().toISOString(),
region,
flatrate: here ? collapseProviders(here.flatrate) : [],
rent: here ? collapseProviders(here.rent) : [],
buy: here ? collapseProviders(here.buy) : [],
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
// TMDb/JustWatch returns the plain AVOD storefront "Apple TV" and the
// subscription "Apple TV Plus" as two distinct provider names -- a
// title whose flatrate entry came back as the bare one needs its own
// alias entry, not just a substring match against "apple tv plus"
// (which a no-space "AppleTv"-style subscription name doesn't hit
// either direction). Confirmed live: a real candidate's flatrate
// provider was exactly "Apple TV", no "Plus".
'apple tv': ['appletv'],
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
// canonicalProvider already normalises a trailing "+" to " plus" on
// the TMDb side (so p/aliases are already spelled out) -- the
// subscription's own typed name needs the same normalisation, or a
// sub typed as "Paramount+" (a completely natural way to type it)
// never matches the canonical "paramount plus" at all. Confirmed
// live as a real gap once canonicalProvider started normalising its
// own side and this one didn't follow.
const n = String(s.name || '').toLowerCase().trim().replace(/\+$/, ' plus');
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

// TMDb's genre id -> name, movie and TV lists merged into one map (the
// handful of ids they don't share, e.g. TV's 10759 "Action & Adventure"
// vs film's own 28/12, coexist fine as separate entries). Fixed and
// published by TMDb, not worth a second network call just to resolve a
// label mediarecs.js already gets for free alongside every search result.
const TMDB_GENRES = {
28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History',
27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance',
878: 'Science Fiction', 10770: 'TV Movie', 53: 'Thriller', 10752: 'War',
37: 'Western', 10759: 'Action & Adventure', 10762: 'Kids', 10763: 'News',
10764: 'Reality', 10765: 'Sci-Fi & Fantasy', 10766: 'Soap', 10767: 'Talk',
10768: 'War & Politics',
};
function genreNames(ids) {
return (ids || []).map((id) => TMDB_GENRES[id]).filter(Boolean);
}

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
// Not used by the ordinary add-a-title flow -- only by mediarecs.js's
// ranking, which is why these two are the one addition to an otherwise
// unchanged, long-stable search result shape.
genres: genreNames(r.genre_ids),
rating: r.vote_average || 0,
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

export { identifyUrl, catalogueLabel, artworkUrl, linkMetadata, ogImageFrom, searchTitle, watchProviders, subscriptionFor, collapseProviders, shortProviderName, tvdbSeriesInfo, tvdbSessions, tvdbSeasonNumbers, tvdbIdViaTmdb, defaultSessionFilter, CATALOGUE_LABELS, MissingTmdbKeyError, TMDB_GENRES, genreNames };
