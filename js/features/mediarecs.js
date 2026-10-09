// Monthly "what's worth watching" discovery: fetches the source pages
// you've configured (data.mediaRecSources, managed in Settings), asks
// Claude to pull real titles out of each, resolves each one against
// TMDb for a genre/rating it can actually be ranked on, and scores them
// deterministically against your own taste (data.prefs.mediaPreferences
// -- see state.js's blankMediaRecCandidate for the stored shape). An
// optional AI pass (mediaPreferences.aiTopUp) can flag a few candidates
// worth a second look for reasons the formula can't see; it never adds a
// title outside what the deterministic pass already found -- js/ai.js's
// rankMediaCandidates works by INDEX into that list, so a flaky or empty
// reply just means no AI picks this run, never a hallucinated title.
//
// Reuses machinery that already exists end to end rather than building a
// parallel path (dashboard/CLAUDE.md): js/files.js's fetchPageHtml (the
// same SSRF-guarded proxy the TVDB scraping and recipe import already go
// through), catalogue.js's searchTitle/watchProviders/subscriptionFor,
// and media.js's addMediaItem -- "+ Add as want" on a candidate is a
// completely ordinary add, so Plex-check/whereToWatch pick it up exactly
// as they do for anything else added any other way.
import { data, queueSave, blankMediaRecCandidate, MEDIA_KINDS } from '../state.js';
import { escapeHtml, stripHtmlForExtraction } from '../utils.js';
import { searchTitle, watchProviders, subscriptionFor, collapseProviders, shortProviderName } from '../catalogue.js';

const KIND_LABEL = Object.fromEntries(MEDIA_KINDS.map((k) => [k.kind, k.label]));

// Per-SOURCE now, not one global gate -- a weekly "best new this week"
// page and a monthly "best of the year" page on the same list can't share
// one recheck interval without either nagging the monthly one or starving
// the weekly one. See state.js's blankMediaRecSource for where each
// source's own cadence/lastCheckedAt live.
const CADENCE_DAYS = { weekly: 7, monthly: 28 };
const MAX_PER_SOURCE = 40; // generous cap on one page's own extraction, not a UI limit

function daysSince(iso) {
if (!iso) return Infinity;
return (Date.now() - new Date(iso).getTime()) / 86400000;
}

function isSourceDue(source, force) {
return force || daysSince(source.lastCheckedAt) >= (CADENCE_DAYS[source.cadence] || CADENCE_DAYS.monthly);
}

// Title only, NOT title+kind -- confirmed live as the real cause of a
// growing pile of duplicates: the same real title ("Cold Storage") got
// extracted once as kind 'other' (a vague mention, before extraction
// quality improved) and once as kind 'film' (the real thing, full
// details) from two different source reads, and since the two kinds
// differed the kind+title key never considered them the same candidate.
// A title collision across genuinely different works of different kinds
// is rare enough in practice that this is the right tradeoff for a
// personal recommendations queue.
function isAlreadyKnown(title) {
const t = title.trim().toLowerCase();
return data.mediaItems.some((m) => m.title.trim().toLowerCase() === t)
|| data.mediaRecCandidates.some((c) => c.title.trim().toLowerCase() === t);
}

// Updates every status element in the DOM, not just one -- the Settings
// panel and the Media tab's own "Check recommendations" button each have
// their own (Settings' is still open while a run started there finishes;
// the Media-tab one is what's actually visible if you started it from
// there instead), and whichever one you're looking at should show the
// same progress.
function setStatus(text) {
document.querySelectorAll('[data-media-recs-status]').forEach((el) => { el.textContent = text || ''; });
}

// Feeds the user's own source-pages into Settings' existing Site health
// table (sitehealth.js) -- the same "does this fetch still work" canary
// mechanism every other scheduled scrape already reports into, since a
// source that's JS-rendered and genuinely never returns anything (found
// live: JustWatch, IMDb) is exactly the kind of persistent, silent
// breakage that table exists to surface. Dynamically imported since
// sitehealth.js has no reason to know about mediarecs.js otherwise, and
// failing to report is never worth breaking the actual check over.
async function reportSourceHealth(source, ok, detail) {
try {
const { reportCheck } = await import('./sitehealth.js');
reportCheck(`media-rec-source-${source.id}`, ok, detail);
} catch (err) {
console.error('Site health report failed (non-fatal):', err);
}
}

// Routes through the NAS agent's page.render (a real headless browser)
// when a source is marked as needing one, same pattern stockwatch.js's
// own wantsRender already uses for Agent Provocateur/cashback pages --
// tried first, since we already know what a plain fetch returns for a
// JS-rendered page. Falls straight through to the ordinary proxy on ANY
// failure (agent unreachable, browser container not running, the page
// timing out in it) -- but unlike a bare try/catch that swallows WHY,
// this returns a note the caller can surface. Confirmed live as a real
// diagnosis gap: a silent fallback here looked EXACTLY like needsBrowser
// doing nothing at all, when the actual cause (agent.py's own
// verb_page_render: "page.render needs the browser container: set
// BROWSER_URL... then docker compose up -d") was sitting in the
// console the whole time, never reaching the status line a real user
// actually reads.
async function fetchSourceHtml(url, source) {
if (source.needsBrowser) {
try {
const { run } = await import('../homeagent.js');
const res = await run('page.render', { urls: [url] }, { timeoutMs: 75000 });
const page = (res && res.pages || []).find((p) => p.url === url);
if (page && page.html) return { html: page.html, note: '' };
const reason = (page && page.error) || 'page.render returned no content for this page';
const { fetchPageHtml } = await import('../files.js');
return { html: await fetchPageHtml(url), note: `needs-a-real-browser fetch failed (${reason}) -- used a plain fetch instead` };
} catch (err) {
console.error(`page.render failed for "${url}", falling back to a plain fetch:`, err);
const { fetchPageHtml } = await import('../files.js');
return { html: await fetchPageHtml(url), note: `needs-a-real-browser fetch failed (${err.message || err}) -- used a plain fetch instead` };
}
}
const { fetchPageHtml } = await import('../files.js');
return { html: await fetchPageHtml(url), note: '' };
}

// A "jump-off" source's own URL is an evergreen index page (this.guardian.
// com/.../the-seven-best-shows-to-stream-this-week), not the actual dated
// article -- so the real page has to be found first. Falls back to
// reading the landing page itself if that fails (better than nothing, and
// it's what used to happen before this existed), with the failure visible
// in the status line rather than silently swallowed.
async function resolveSourceUrl(source) {
if (!source.jumpOff) return { url: source.url, note: '' };
const { findLatestArticleUrl } = await import('../ai.js');
const { html: landingHtml, note: fetchNote } = await fetchSourceHtml(source.url, source);
const notes = [fetchNote].filter(Boolean);
// stripHtmlForExtraction keeps every <a href> intact -- the one thing
// this particular lookup actually needs from markup -- while dropping
// everything else that doesn't help it find the link.
const href = await findLatestArticleUrl(stripHtmlForExtraction(landingHtml), `Landing page for "${source.label || source.url}".`);
if (!href) {
notes.push(`couldn't find this ${source.cadence === 'weekly' ? "week's" : "month's"} article link, read the landing page itself instead`);
return { url: source.url, note: notes.join('; ') };
}
try {
return { url: new URL(href, source.url).href, note: notes.join('; ') };
} catch (err) {
notes.push(`found a link but couldn't resolve it (${href}), read the landing page itself instead`);
return { url: source.url, note: notes.join('; ') };
}
}

// Which MEDIA_KINDS value an IMDb titleType maps to -- the Apify Actor's
// searchTitles mode returns "Movie"/"TV Series"/"TV Mini Series"/etc,
// not this app's own film/tv vocabulary.
function imdbKindFor(titleType) {
const t = String(titleType || '').toLowerCase();
if (t.includes('movie')) return 'film';
if (t.includes('tv') || t.includes('series') || t.includes('mini')) return 'tv';
return 'other';
}

// IMDb's own data via a third-party Apify Actor (logiover/imdb-scraper,
// IMDb's web GraphQL, no browser) instead of page.render -- confirmed
// live that page.render against imdb.com returns AWS WAF's CAPTCHA-grade
// "Human Verification" challenge every time, byte-for-byte identical
// (same 9516 bytes, same gokuProps blob) across different IMDb URLs and
// minutes apart, which rules out a wait-time or stealth-setting fix: no
// amount of patience gets past a real CAPTCHA challenge. Talking to
// IMDb's data API directly sidesteps the WAF guarding the HTML frontend
// entirely, rather than trying to get past it.
//
// Not an equivalent to a specific editorial page -- IMDb's own "staff
// picks"/"most anticipated" curation has no API behind it -- this is a
// popularity-sorted search instead, the closest available
// approximation, which is why this skips resolveSourceUrl/
// fetchSourceHtml/extractMediaRecommendations entirely: there's no URL
// to resolve and no raw text to extract from.
//
// The rating floor is applied HERE, in the search filter itself, not
// just left to resolveCandidate's own floor-drop later -- no point
// paying Apify for results that would only get discarded afterward.
async function fetchImdbApiSource(source, prefs) {
const { run } = await import('../homeagent.js');
const args = { titleTypes: ['movie', 'tvSeries'], sortBy: 'POPULARITY', maxResults: MAX_PER_SOURCE };
if (prefs.minRating) args.minRating = prefs.minRating;
const res = await run('imdb.search', args, { timeoutMs: 60000 });
const items = ((res && res.items) || []).filter((it) => it && it.title).map((it) => ({
title: String(it.title),
kind: imdbKindFor(it.titleType),
year: it.year ? String(it.year) : '',
creator: '',
reason: it.aggregateRating ? `${Number(it.aggregateRating).toFixed(1)}/10 on IMDb, popular right now` : 'Popular on IMDb right now',
}));
const note = items.length ? '' : `IMDb search API returned nothing${prefs.minRating ? ` above your ${prefs.minRating}/10 floor` : ''}`;
return { items, note };
}

async function fetchOneSource(source, prefs) {
if (source.fetchMode === 'imdbApi') {
const { items, note } = await fetchImdbApiSource(source, prefs);
return { items: items.slice(0, MAX_PER_SOURCE).map((it) => ({ ...it, sourceLabel: source.label || source.url, sourceUrl: source.url })), note, htmlLength: 0 };
}
const { extractMediaRecommendations } = await import('../ai.js');
const { url: targetUrl, note: resolveNote } = await resolveSourceUrl(source);
const { html, note: fetchNote } = await fetchSourceHtml(targetUrl, source);
const items = await extractMediaRecommendations(stripHtmlForExtraction(html), `From "${source.label || source.url}", a ${source.kind} source.`);
// Attribution points at the real dated article once resolved, not the
// evergreen landing page -- "via" should take you to the actual piece
// these titles came from.
// When a page renders fine (no fetchNote) but extraction still finds
// nothing, the raw byte count is the only way to tell "the browser got
// a bot-block/consent page" (a few KB) apart from "it got real content
// but the extraction prompt missed it" (normal page size) -- confirmed
// live need: IMDb's needsBrowser sources returned 0 items with no note
// at all, which looked identical to a genuinely clean "nothing new".
const note = [resolveNote, fetchNote].filter(Boolean).join('; ');
return { items: items.slice(0, MAX_PER_SOURCE).map((it) => ({ ...it, sourceLabel: source.label || source.url, sourceUrl: targetUrl })), note, htmlLength: (html || '').length };
}

// Can-watch-tonight beats genre match beats rating beats "it's new" -- in
// that order, because "can I watch this tonight on something I already
// pay for" is worth more than taste-matching on something you'd have to
// go find first.
function scoreCandidate(cand, prefs) {
let score = 0;
if (cand.onSubscription.length) score += 4;
const prefGenres = (prefs.genres || []).map((g) => g.toLowerCase());
const matchedGenres = (cand.genres || []).filter((g) => prefGenres.includes(g.toLowerCase()));
score += Math.min(matchedGenres.length * 1.5, 3);
if (cand.rating) score += (cand.rating / 10) * 2;
const yr = parseInt(cand.year, 10);
if (yr && yr >= new Date().getFullYear() - 1) score += 0.5;
return Math.round(score * 10) / 10;
}

// What the raw extracted title said beyond TMDb's own canonical name,
// when it looks like a season/series qualifier ("Season 2", "Series 6",
// a bare trailing "13") -- the part resolveCandidate's own title
// canonicalisation below would otherwise silently drop. Deliberately
// narrow: only fires on a pattern that actually looks like a season
// reference, not on "(South Asian adaptation)" or "(prison drama)"
// -- those are the separate invented-pseudo-title problem, not a real
// difference worth calling out.
function seasonNote(rawTitle, canonicalTitle) {
const prefix = canonicalTitle.trim();
if (!rawTitle.toLowerCase().startsWith(prefix.toLowerCase())) return '';
const suffix = rawTitle.slice(prefix.length).trim().replace(/^[:\-–]\s*/, '');
if (/^(season|series)\s+\w+$/i.test(suffix)) return suffix;
if (/^\d+$/.test(suffix)) return `Season ${suffix}`;
return '';
}

async function resolveCandidate(raw, prefs) {
const kind = raw.kind;
let matched = null;
try {
const candidates = await searchTitle(kind, raw.title);
matched = candidates.find((c) => c.title.trim().toLowerCase() === raw.title.trim().toLowerCase()) || candidates[0] || null;
} catch (err) {
console.error(`Catalogue lookup failed for "${raw.title}":`, err);
}
const genres = (matched && matched.genres) || [];
const rating = (matched && matched.rating) || 0;
// A floor meant for film/TV ratings must never silently exclude a book
// or album TMDb has no opinion on -- only enforced when a rating is
// actually known.
if (prefs.minRating && rating && rating < prefs.minRating) return { cand: null, reason: 'rating' };

let providers = [];
let onSubscription = [];
if (matched && matched.externalIds && matched.externalIds.tmdb) {
try {
const where = await watchProviders(matched.externalIds);
if (where) {
providers = collapseProviders(where.flatrate);
onSubscription = providers.filter((name) => subscriptionFor(name, data.subscriptions || []));
}
} catch (err) {
console.error(`Streaming availability lookup failed for "${raw.title}":`, err);
}
}

// Once TMDb has genuinely matched it, use ITS title -- not the raw
// extracted one -- as the stored candidate's title. Confirmed live as
// the actual cause of "MobLand" and "MobLand Season 2" (or "American
// Horror Story" and "American Horror Story: 13") sitting side by side
// as if they were different shows: the same show, extracted slightly
// differently across two source passes, with no season-suffix pattern
// general enough to safely strip (a show can genuinely be titled with a
// trailing number, e.g. "Stranger Things 4", so regex-stripping "Season
// N" fixes some real cases and risks mangling others). TMDb's own title
// is the one canonical name for the SERIES regardless of which season
// prompted the mention -- which is also the right level for Plex/Sonarr
// to operate at, a want for a season rather than the show being exactly
// the confusion this avoids -- so once both extractions resolve to the
// same TMDb entry, they already share one title and the existing
// dedupeCandidates() cleanup (runs on every render) collapses them on
// its own, nothing further to add there.
const canonicalTitle = (matched && matched.title) || raw.title;
const cand = blankMediaRecCandidate({
title: canonicalTitle,
kind,
year: raw.year || (matched && matched.year) || '',
creator: raw.creator || (matched && matched.creator) || '',
reason: raw.reason,
seasonNote: matched ? seasonNote(raw.title, canonicalTitle) : '',
genres,
rating,
providers,
onSubscription,
externalIds: (matched && matched.externalIds) || {},
imageUrl: (matched && matched.imageUrl) || '',
link: (matched && matched.link) || '',
sourceLabel: raw.sourceLabel,
sourceUrl: raw.sourceUrl,
});
cand.score = scoreCandidate(cand, prefs);
return { cand, reason: '' };
}

async function runMediaRecsCheck({ force = false } = {}) {
const all = data.mediaRecSources || [];
if (!all.length) { setStatus('Add a source page below first.'); return; }
const sources = all.filter((s) => isSourceDue(s, force));
if (!sources.length) { setStatus('Nothing due yet -- each source is checked on its own weekly/monthly schedule (Settings).'); return; }
const prefs = data.prefs.mediaPreferences || {};
// Tracked so the final status line can actually answer "is there a cap,
// or is this genuinely all that qualified" instead of leaving a small
// result count unexplained -- confirmed live need: a JS-rendered page
// (JustWatch, IMDb) returns little or nothing to a plain HTML fetch, and
// without this that looked identical to "nothing met your filters".
// All of it (notes, failures) is collected and only ever shown in the
// FINAL status line, never as an intermediate setStatus() call mid-loop
// -- confirmed live as a real problem: a per-source note or failure
// shown while the loop was still running got overwritten by the very
// next source's own status line a moment later, so a genuinely useful
// warning ("couldn't find this week's article", "cut off at the token
// limit") was gone before it could be read, noticed only by chance.
const rawBatches = [];
const emptySources = [];
const sourceNotes = [];
const sourceFailures = [];
for (let i = 0; i < sources.length; i++) {
const source = sources[i];
setStatus(`Reading source ${i + 1} of ${sources.length} (${source.label || source.url})…`);
try {
const { items, note, htmlLength } = await fetchOneSource(source, prefs);
rawBatches.push(items);
const sizeHint = htmlLength < 10000
? `only got ${htmlLength} bytes back -- likely a bot-block or consent page even through the real browser`
: `got ${htmlLength} bytes back but found nothing to extract from them`;
if (!items.length) {
emptySources.push(source.label || source.url);
reportSourceHealth(source, false, note || sizeHint);
} else {
reportSourceHealth(source, true, `${items.length} title${items.length === 1 ? '' : 's'} found.`);
}
source.lastCheckedAt = new Date().toISOString();
if (note) sourceNotes.push(`"${source.label || source.url}" — ${note}`);
else if (!items.length) sourceNotes.push(`"${source.label || source.url}" — ${sizeHint}`);
} catch (err) {
console.error(`Recommendations source failed (${source.label || source.url}):`, err);
reportSourceHealth(source, false, err.message || String(err));
sourceFailures.push(`"${source.label || source.url}" — ${err.message || err}`);
// Not marked checked -- a transient failure (site hiccup, proxy
// timeout) should retry next time the scheduled task fires rather
// than waiting out a full week/month.
}
}
const raw = rawBatches.flat();
// Dedupe across sources (the same film mentioned on two pages) before
// spending a TMDb lookup on each copy.
const seen = new Set();
const deduped = raw.filter((it) => {
const key = it.title.trim().toLowerCase();
if (seen.has(key)) return false;
seen.add(key);
return !isAlreadyKnown(it.title);
});

setStatus(`Checking ${deduped.length} candidate${deduped.length === 1 ? '' : 's'} against your catalogue…`);
const resolved = [];
let droppedByRating = 0;
for (const it of deduped) {
const { cand } = await resolveCandidate(it, prefs);
if (cand) resolved.push(cand); else droppedByRating++;
}
resolved.sort((a, b) => b.score - a.score);

if (prefs.aiTopUp && resolved.length) {
try {
const { rankMediaCandidates } = await import('../ai.js');
const picks = await rankMediaCandidates(resolved, prefs);
picks.forEach((p) => {
const c = resolved[p.index];
c.aiPick = true;
c.reason = p.note ? `${c.reason ? `${c.reason} — ` : ''}${p.note}` : c.reason;
});
} catch (err) {
console.error('AI top-up pass failed (deterministic ranking stands):', err);
}
}

data.mediaRecCandidates.push(...resolved);
data.prefs.mediaRecsLastRun = new Date().toISOString();
queueSave();
// Spelled out end to end -- raw found, where nothing came back, how many
// were already known, how many the rating floor dropped -- rather than a
// single number that reads the same whether nothing qualified or every
// source quietly failed.
const parts = [`Found ${raw.length} title${raw.length === 1 ? '' : 's'} across ${sources.length} source${sources.length === 1 ? '' : 's'}`];
if (emptySources.length) parts.push(`${emptySources.length} returned nothing readable (${emptySources.slice(0, 3).join(', ')}${emptySources.length > 3 ? ', …' : ''}) -- likely a page that needs JavaScript to show its content, which this fetcher can't run`);
parts.push(`${deduped.length} new after removing duplicates/already-known`);
if (droppedByRating) parts.push(`${droppedByRating} below your ${prefs.minRating}/10 floor`);
parts.push(`${resolved.length} ready to review`);
if (sourceFailures.length) parts.push(`FAILED: ${sourceFailures.join('; ')}`);
if (sourceNotes.length) parts.push(sourceNotes.join('; '));
setStatus(`${parts.join(' — ')}.`);
renderMediaRecs();
}

// Cleans up duplicates already sitting in data.mediaRecCandidates from
// before isAlreadyKnown stopped comparing by kind+title -- confirmed
// live, 97 pending candidates included the same real title more than
// once (one extraction guessed kind 'other' off a vague mention, a
// later one correctly found it as 'film' with full details). Keeps the
// one with a resolved catalogue id, or failing that the higher score,
// and dismisses the rest -- not deleted, so isAlreadyKnown still blocks
// them from reappearing. Idempotent and cheap, so it runs on every
// render rather than needing a one-off "clean up now" button: once a
// title has no duplicates left, it finds nothing to do.
function dedupeCandidates() {
const keepers = new Map(); // normalised title -> the candidate currently kept
let changed = false;
// seasonNote weighted above the raw score (but below having a
// catalogue id at all) -- two duplicates of the same now-canonically-
// titled show can otherwise tie on everything else, and which one
// survives decides whether "why is this being recommended again" (a
// new season) stays visible or quietly vanishes with the dismissed copy.
const weight = (c) => (c.externalIds && c.externalIds.tmdb ? 100 : 0) + (c.seasonNote ? 10 : 0) + (c.score || 0);
for (const c of data.mediaRecCandidates) {
if (c.status !== 'pending') continue;
const key = c.title.trim().toLowerCase();
const existing = keepers.get(key);
if (!existing) { keepers.set(key, c); continue; }
changed = true;
if (weight(c) > weight(existing)) {
existing.status = 'dismissed';
keepers.set(key, c);
} else {
c.status = 'dismissed';
}
}
if (changed) queueSave();
return changed;
}

// How many pending items outside your preferred genres are allowed to
// show at once -- a cap, not an exclusion. Confirmed live complaint:
// genre was only ever a scoring nudge (+1.5/match, capped at +3), so a
// high-rated documentary on a subscribed service easily outscored a
// lower-rated genre match and the queue read as "flooded" with
// documentaries/drama despite neither being ticked. The fix drops
// nothing -- a capped-out item just stays pending and resurfaces on a
// later render once something ahead of it gets actioned, same
// self-healing shape as dedupeCandidates() below.
const NON_PREFERRED_GENRE_CAP = 3;

function pendingSorted() {
dedupeCandidates();
const pending = (data.mediaRecCandidates || []).filter((c) => c.status === 'pending').sort((a, b) => b.score - a.score);
const prefGenres = ((data.prefs.mediaPreferences || {}).genres || []).map((g) => g.toLowerCase());
if (!prefGenres.length) return pending;
let nonPreferredShown = 0;
return pending.filter((c) => {
// No genre data at all (unmatched title, or a kind TMDb has no
// opinion on) -- nothing to judge it against, so it always counts
// as a match, same caution the rating floor already takes.
const matches = !c.genres.length || c.genres.some((g) => prefGenres.includes(g.toLowerCase()));
if (matches) return true;
if (nonPreferredShown < NON_PREFERRED_GENRE_CAP) { nonPreferredShown++; return true; }
return false;
});
}

// Every provider TMDb lists, not just the one(s) you pay for -- "on
// Netflix" is still useful to know even when it isn't a subscription you
// have, same reasoning media.js's own whereToWatchHtml already follows
// for the main Watch & listen list. Capped the same way that one is
// (two unpaid providers shown, the rest folded into a "+N"), since a
// title streaming on eight services would otherwise push everything
// else on the row out of view.
//
// Both which-provider-is-"yours" AND the provider list itself are
// recomputed HERE, live, every render -- not read from c.onSubscription/
// c.providers as stored. Confirmed live as a real gap, the same one
// whereToWatchHtml never has (it already computes this fresh from
// data.subscriptions on every render): a candidate's subscription match
// was baked in once at the moment it was found, so renaming a
// subscription afterward (or TMDb returning "Netflix" and "Netflix
// Standard" as if they were two different services, before
// canonicalProvider's own fix) stayed wrong on an already-stored
// candidate until it was found again from scratch. Re-collapsing
// providers here as well as matching subscriptions live means both
// problems correct themselves on the very next render, no re-run needed.
function providerChipsHtml(c) {
const providers = collapseProviders(c.providers || []);
if (!providers.length) return '';
const yours = providers.filter((name) => subscriptionFor(name, data.subscriptions || []));
const others = providers.filter((name) => !subscriptionFor(name, data.subscriptions || []));
const MAX_OTHERS = 2;
const extra = others.slice(MAX_OTHERS);
const chips = [
...yours.map((name) => `<span class="task-context" style="background:var(--sage-bg);color:var(--sage);font-weight:600;" title="You already pay for ${escapeHtml(name)}">&#10003; ${escapeHtml(shortProviderName(name))}</span>`),
...others.slice(0, MAX_OTHERS).map((name) => `<span class="task-context" title="Streaming here, not one of your subscriptions">${escapeHtml(shortProviderName(name))}</span>`),
];
if (extra.length) chips.push(`<span class="task-context" title="Also on ${escapeHtml(extra.join(', '))}">+${extra.length}</span>`);
return chips.join('');
}

// Grouped into its own flex column rather than one flat row of siblings
// -- confirmed live as a real readability problem: with everything
// (thumb, title, rating, genres, providers, reason, source, buttons) in
// one flex-wrap pool, which line each piece landed on shifted row to
// row depending on exactly how long the title/reason/genre list for
// THAT candidate happened to be, so the same kind of information sat in
// a different place on every card. Each inner div is its own wrap
// group now, so the header/stats/reason/actions lines are always in
// the same relative position regardless of content length.
function candRowHtml(c) {
const art = c.imageUrl ? `<img class="media-art" src="${escapeHtml(c.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '';
const titleHtml = c.link ? `<a href="${escapeHtml(c.link)}" target="_blank" rel="noopener">${escapeHtml(c.title)}</a>` : escapeHtml(c.title);
const ratingBadge = c.rating ? `<span class="settings-note" style="margin:0;">&#9733; ${c.rating.toFixed(1)}</span>` : '';
const genreChips = (c.genres || []).map((g) => `<span class="task-context">${escapeHtml(g)}</span>`).join('');
const aiBadge = c.aiPick ? `<span class="task-context" style="background:var(--lilac-bg,#efe7ff);color:var(--lilac,#7c4dff);font-weight:600;" title="Flagged by the optional AI top-up pass">&#10024; AI pick</span>` : '';
// A proper chip, not just text folded into the reason -- confirmed live
// that mattered: once the title canonicalises to TMDb's own name (so
// "MobLand" and "MobLand Season 2" collapse into one candidate instead
// of two), the "why is an existing show being recommended again" signal
// needs to stay visible at a glance, not buried at the start of a
// sentence you have to read to notice.
const seasonBadge = c.seasonNote ? `<span class="task-context" style="background:var(--amber-bg,#fef3c7);color:var(--amber,#b45309);font-weight:600;" title="The source mentioned this as a new season, not the show from scratch">&#127909; New: ${escapeHtml(c.seasonNote)}</span>` : '';
const canWatchlist = (c.kind === 'film' || c.kind === 'tv') && c.externalIds && c.externalIds.tmdb;
// Title (Year) ★Rating together on the header line, same order the
// main Watch & listen list reads left to right, with actions pushed to
// the right of that SAME line (#media-recs-list now shares the main
// list's own margin-left:auto rule, style.css) -- confirmed live as a
// real inconsistency: year/rating used to sit far right of their own
// row while the main list keeps them right next to the title, and
// actions lived on the "via" line here instead of lining up with the
// main list's own right-aligned row of buttons.
return `<div class="mail-row" data-rec-row="${c.id}" style="align-items:flex-start;flex-wrap:wrap;">
${art}
<div style="display:flex;flex-direction:column;gap:5px;flex:1;min-width:220px;">
<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
<span class="task-context">${escapeHtml(KIND_LABEL[c.kind] || c.kind)}</span>
<span class="mail-subject">${titleHtml}${c.year ? ` (${escapeHtml(c.year)})` : ''}</span>
${ratingBadge}
${seasonBadge}
${c.creator ? `<span class="settings-note" style="margin:0;">${escapeHtml(c.creator)}</span>` : ''}
<span class="media-row-actions">
<button class="mini-task-btn" type="button" data-rec-add="${c.id}">+ Add as want</button>
${canWatchlist ? `<button class="mini-task-btn" type="button" data-rec-watchlist="${c.id}" title="Add straight to your Plex Watchlist">&#128065; Watchlist</button>` : ''}
<span class="del-x" data-rec-dismiss="${c.id}" title="Not interested">&times;</span>
</span>
</div>
<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
${genreChips}${providerChipsHtml(c)}${aiBadge}
</div>
${c.reason ? `<div class="settings-note" style="margin:0;">${escapeHtml(c.reason)}</div>` : ''}
<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
<span class="settings-note" style="margin:0;">via ${c.sourceUrl ? `<a href="${escapeHtml(c.sourceUrl)}" target="_blank" rel="noopener">${escapeHtml(c.sourceLabel || c.sourceUrl)}</a>` : escapeHtml(c.sourceLabel)}</span>
</div>
</div>
</div>`;
}

function renderMediaRecs() {
const host = document.getElementById('media-recs-list');
if (!host) return;
const pending = pendingSorted();
const count = document.getElementById('media-recs-count');
if (count) count.textContent = pending.length ? String(pending.length) : '';
host.innerHTML = pending.length
? pending.map(candRowHtml).join('')
: '<div class="empty">Nothing to review — try "Check now" in Settings, or wait for the monthly check.</div>';
host.querySelectorAll('img.media-art').forEach((img) => { img.addEventListener('error', () => { img.style.display = 'none'; }); });

host.querySelectorAll('[data-rec-add]').forEach((btn) => {
btn.addEventListener('click', () => { addRecCandidate(btn.dataset.recAdd); });
});
host.querySelectorAll('[data-rec-watchlist]').forEach((btn) => {
btn.addEventListener('click', () => { watchlistRecCandidate(btn.dataset.recWatchlist, btn); });
});
host.querySelectorAll('[data-rec-dismiss]').forEach((x) => {
x.addEventListener('click', () => {
const c = data.mediaRecCandidates.find((cc) => cc.id === x.dataset.recDismiss);
if (!c) return;
c.status = 'dismissed';
queueSave();
renderMediaRecs();
});
});
}

async function addRecCandidate(id) {
const c = data.mediaRecCandidates.find((cc) => cc.id === id);
if (!c) return;
const { addMediaItem } = await import('./media.js');
addMediaItem({
kind: c.kind, title: c.title, creator: c.creator, year: c.year, notes: c.reason,
link: c.link, imageUrl: c.imageUrl, externalIds: c.externalIds, status: 'wanted',
source: { kind: 'recommendation', label: c.sourceLabel, url: c.sourceUrl },
});
c.status = 'added';
queueSave();
renderMediaRecs();
}

async function watchlistRecCandidate(id, btn) {
const c = data.mediaRecCandidates.find((cc) => cc.id === id);
if (!c) return;
if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
try {
const agent = await import('../homeagent.js');
const result = await agent.run('plex.watchlistAdd', { title: c.title, kind: c.kind, year: c.year });
if (result.added) {
if (btn) btn.textContent = '✓ On Watchlist';
} else {
if (btn) { btn.disabled = false; btn.textContent = '👁 Watchlist'; }
alert(result.reason || "Couldn't add to the Watchlist.");
}
} catch (err) {
console.error(`Watchlist add failed for "${c.title}":`, err);
if (btn) { btn.disabled = false; btn.textContent = '👁 Watchlist'; }
alert(err.message || String(err));
}
}

// Settings (settings.js) wires its own "Check now", alongside the
// source-pages table and preferences it sits next to. This is the SAME
// action offered a second place -- the Media tab's own sync-row, next
// to Check Plex/Link TVDB ids -- so running it doesn't need a trip to
// Settings first; both call the identical runMediaRecsCheck({force:true}).
function initMediaRecs() {
renderMediaRecs();
const btn = document.getElementById('media-recs-checknow-btn');
if (btn) {
btn.addEventListener('click', async () => {
btn.disabled = true;
try { await runMediaRecsCheck({ force: true }); } finally { btn.disabled = false; }
});
}
}

export { initMediaRecs, renderMediaRecs, runMediaRecsCheck, addRecCandidate, watchlistRecCandidate };
