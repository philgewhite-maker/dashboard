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
import { data, queueSave, blankMediaRecCandidate } from '../state.js';
import { escapeHtml } from '../utils.js';
import { searchTitle, watchProviders, subscriptionFor, collapseProviders, shortProviderName } from '../catalogue.js';

const RECHECK_DAYS = 28;
const MAX_PER_SOURCE = 25; // generous cap on one page's own extraction, not a UI limit

function daysSince(iso) {
if (!iso) return Infinity;
return (Date.now() - new Date(iso).getTime()) / 86400000;
}

function isDue(force) {
return force || daysSince(data.prefs.mediaRecsLastRun) >= RECHECK_DAYS;
}

function isAlreadyKnown(title, kind) {
const t = title.trim().toLowerCase();
return data.mediaItems.some((m) => m.kind === kind && m.title.trim().toLowerCase() === t)
|| data.mediaRecCandidates.some((c) => c.kind === kind && c.title.trim().toLowerCase() === t);
}

let statusEl = null;
function setStatus(text) {
if (!statusEl) statusEl = document.getElementById('media-recs-check-status');
if (statusEl) statusEl.textContent = text || '';
}

async function fetchOneSource(source) {
const { fetchPageHtml } = await import('../files.js');
const { extractMediaRecommendations } = await import('../ai.js');
const html = await fetchPageHtml(source.url);
const items = await extractMediaRecommendations(html, `From "${source.label || source.url}", a ${source.kind} source.`);
return items.slice(0, MAX_PER_SOURCE).map((it) => ({ ...it, sourceLabel: source.label || source.url, sourceUrl: source.url }));
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
if (prefs.minRating && rating && rating < prefs.minRating) return null;

let onSubscription = [];
if (matched && matched.externalIds && matched.externalIds.tmdb) {
try {
const where = await watchProviders(matched.externalIds);
if (where) {
onSubscription = collapseProviders(where.flatrate)
.map((name) => ({ name, sub: subscriptionFor(name, data.subscriptions || []) }))
.filter((p) => p.sub)
.map((p) => p.name);
}
} catch (err) {
console.error(`Streaming availability lookup failed for "${raw.title}":`, err);
}
}

const cand = blankMediaRecCandidate({
title: raw.title,
kind,
year: raw.year || (matched && matched.year) || '',
creator: raw.creator || (matched && matched.creator) || '',
reason: raw.reason,
genres,
rating,
onSubscription,
externalIds: (matched && matched.externalIds) || {},
imageUrl: (matched && matched.imageUrl) || '',
link: (matched && matched.link) || '',
sourceLabel: raw.sourceLabel,
sourceUrl: raw.sourceUrl,
});
cand.score = scoreCandidate(cand, prefs);
return cand;
}

async function runMediaRecsCheck({ force = false } = {}) {
if (!isDue(force)) { setStatus(`Already checked within the last ${RECHECK_DAYS} days.`); return; }
const sources = data.mediaRecSources || [];
if (!sources.length) { setStatus('Add a source page below first.'); return; }
const prefs = data.prefs.mediaPreferences || {};
setStatus(`Reading ${sources.length} source${sources.length === 1 ? '' : 's'}…`);
const rawBatches = [];
for (const source of sources) {
try {
rawBatches.push(await fetchOneSource(source));
} catch (err) {
console.error(`Recommendations source failed (${source.label || source.url}):`, err);
setStatus(`"${source.label || source.url}" failed: ${err.message || err} — continuing with the rest.`);
}
}
const raw = rawBatches.flat();
// Dedupe across sources (the same film mentioned on two pages) before
// spending a TMDb lookup on each copy.
const seen = new Set();
const deduped = raw.filter((it) => {
const key = `${it.kind}::${it.title.trim().toLowerCase()}`;
if (seen.has(key)) return false;
seen.add(key);
return !isAlreadyKnown(it.title, it.kind);
});

setStatus(`Checking ${deduped.length} candidate${deduped.length === 1 ? '' : 's'} against your catalogue…`);
const resolved = [];
for (const it of deduped) {
const cand = await resolveCandidate(it, prefs);
if (cand) resolved.push(cand);
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
setStatus(`Found ${resolved.length} new recommendation${resolved.length === 1 ? '' : 's'} from ${sources.length} source${sources.length === 1 ? '' : 's'}.`);
renderMediaRecs();
}

function pendingSorted() {
return (data.mediaRecCandidates || []).filter((c) => c.status === 'pending').sort((a, b) => b.score - a.score);
}

function candRowHtml(c) {
const art = c.imageUrl ? `<img class="media-art" src="${escapeHtml(c.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '';
const byline = [c.creator, c.year].filter(Boolean).join(' · ');
const genreChips = (c.genres || []).map((g) => `<span class="task-context">${escapeHtml(g)}</span>`).join('');
const subChips = (c.onSubscription || []).map((name) => `<span class="task-context" style="background:var(--sage-bg);color:var(--sage);font-weight:600;" title="You already pay for ${escapeHtml(name)}">&#10003; ${escapeHtml(shortProviderName(name))}</span>`).join('');
const ratingBadge = c.rating ? `<span class="settings-note" style="margin:0;">&#9733; ${c.rating.toFixed(1)}</span>` : '';
const aiBadge = c.aiPick ? `<span class="task-context" style="background:var(--lilac-bg,#efe7ff);color:var(--lilac,#7c4dff);font-weight:600;" title="Flagged by the optional AI top-up pass">&#10024; AI pick</span>` : '';
const canWatchlist = (c.kind === 'film' || c.kind === 'tv') && c.externalIds && c.externalIds.tmdb;
return `<div class="mail-row" data-rec-row="${c.id}" style="align-items:flex-start;">
${art}
<span class="task-context">${escapeHtml(c.kind)}</span>
<span class="mail-subject">${c.link ? `<a href="${escapeHtml(c.link)}" target="_blank" rel="noopener">${escapeHtml(c.title)}</a>` : escapeHtml(c.title)}</span>
${byline ? `<span class="settings-note" style="margin:0;">${escapeHtml(byline)}</span>` : ''}
${ratingBadge}
${genreChips}
${subChips}
${aiBadge}
${c.reason ? `<span class="settings-note" style="margin:0;">${escapeHtml(c.reason)}</span>` : ''}
<span class="settings-note" style="margin:0;">via ${c.sourceUrl ? `<a href="${escapeHtml(c.sourceUrl)}" target="_blank" rel="noopener">${escapeHtml(c.sourceLabel || c.sourceUrl)}</a>` : escapeHtml(c.sourceLabel)}</span>
<span class="media-row-actions">
<button class="mini-task-btn" type="button" data-rec-add="${c.id}">+ Add as want</button>
${canWatchlist ? `<button class="mini-task-btn" type="button" data-rec-watchlist="${c.id}" title="Add straight to your Plex Watchlist">&#128065; Watchlist</button>` : ''}
<span class="del-x" data-rec-dismiss="${c.id}" title="Not interested">&times;</span>
</span>
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

// The "Check now" button itself lives in Settings (settings.js wires it,
// alongside the source-pages table and preferences it sits next to) --
// this only renders the review list on the Media tab, wherever the last
// check (scheduled or manual) left it.
function initMediaRecs() {
renderMediaRecs();
}

export { initMediaRecs, renderMediaRecs, runMediaRecsCheck, addRecCandidate, watchlistRecCandidate };
