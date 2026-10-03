// Films, TV, albums: things to watch or listen to. The Media tab's own
// list, sitting beside the reading list, which is the same "a want, then
// a tick" idea for text.
//
// Deliberately a record type of its own rather than another task
// context (the route Shopping took): a want has a lifecycle a task
// doesn't -- wanted, then available once it's actually in the library,
// then watched -- and it carries `plexCheck`/`acquisition` slots for the
// home agent to fill in later. None of that fits a GTD bucket.
//
// Adding an item goes through addMediaItem() from every direction (the
// quick-add row here, a shared link, a marked screenshot, a Telegram
// request, a voice instruction), so shape normalisation lives in exactly
// one place.
import { data, queueSave, blankMediaItem, MEDIA_KINDS, MEDIA_STATUSES } from '../state.js';
import { escapeHtml, affiliateLink, scrollAndFlash, hydratePhotoBackgrounds, looksLikeUrl, bindBackdropClose } from '../utils.js';
import { identifyUrl, catalogueLabel, CATALOGUE_LABELS, watchProviders, subscriptionFor, collapseProviders, shortProviderName } from '../catalogue.js';

const KIND_LABEL = Object.fromEntries(MEDIA_KINDS.map((k) => [k.kind, k.label]));
const STATUS_LABEL = Object.fromEntries(MEDIA_STATUSES.map((s) => [s.status, s.label]));
// Watched and dropped are both "finished with", so the default view is
// everything still outstanding rather than a status-by-status filter.
const OPEN_STATUSES = ['wanted', 'available'];

let kindFilter = 'all';
let showFinished = false;

// A link's kind, when the catalogue it came from proves one -- TMDb's
// /tv/ path does, IMDb's /title/ doesn't (it covers both), so that falls
// back to 'film' as the commoner case, one tap to correct. See
// catalogue.js for why the id itself is kept rather than just the kind.
function kindFromUrl(url) {
return identifyUrl(url).kind || 'other';
}

function addMediaItem({ kind, title, creator = '', year = '', link = '', notes = '', photoIds = [], source = null, requestedBy = '', status = 'wanted', externalIds = {}, imageUrl = '' }) {
const fromUrl = link ? identifyUrl(link) : { ids: {}, kind: null };
const item = blankMediaItem({
kind: KIND_LABEL[kind] ? kind : (link ? kindFromUrl(link) : 'other'),
// Ids passed in (read off a screenshot, say) win over ones parsed
// from the link, but both are kept -- they're different catalogues,
// not competing answers.
externalIds: { ...fromUrl.ids, ...externalIds },
imageUrl: imageUrl || '',
title: (title || link || 'Untitled').trim(),
creator: (creator || '').trim(),
year: String(year || '').trim(),
status,
link: (link || '').trim(),
notes: (notes || '').trim(),
photoIds: Array.isArray(photoIds) ? photoIds : [],
source,
requestedBy: (requestedBy || '').trim(),
});
data.mediaItems.unshift(item); // newest first, same as the reading list
queueSave();
renderMedia();
// Artwork is decoration, so it's fetched after the item exists rather
// than delaying it: a poster that never arrives costs nothing, a
// capture that waited on one would.
if (!item.imageUrl && item.link) fillArtwork(item);
// "Can I just watch this tonight?" is the first question about anything
// on this list, and answering it costs one free API call -- so it's
// asked on the way in rather than waiting to be requested.
if (item.externalIds.tmdb) fillWhereToWatch(item);
return item;
}

async function fillWhereToWatch(item) {
try {
const where = await watchProviders(item.externalIds);
if (!where) return;
const live = data.mediaItems.find((m) => m.id === item.id);
if (!live) return;
live.whereToWatch = where;
queueSave();
renderMedia();
} catch (err) {
console.error('Streaming availability lookup failed:', err);
}
}

// A pasted link arrives titled with the URL itself, which is useless in
// a list of things to watch -- and pressing Add rather than Resolve
// title used to leave it that way. So a link is enriched on arrival:
// a book by its ISBN (title, author, year and cover in one free call),
// anything else from the page's own og: tags, which is the same fetch
// the artwork already needed.
async function fillArtwork(item) {
try {
const { linkMetadata } = await import('../catalogue.js');
const meta = await linkMetadata(item.link, item.externalIds);
const live = data.mediaItems.find((m) => m.id === item.id);
if (!live || !meta) return; // removed while the lookup was in flight
if (meta.imageUrl && !live.imageUrl) live.imageUrl = meta.imageUrl;
// Only ever replaces a title that's still the raw URL: anything the
// user typed, or picked from the candidate list, stays.
if (meta.title && looksLikeUrl(live.title)) live.title = meta.title;
if (meta.creator && !live.creator) live.creator = meta.creator;
if (meta.year && !live.year) live.year = meta.year;
queueSave();
renderMedia();
if (!meta.title && !meta.imageUrl) {
setCaptureStatus(`Nothing found for that link — ${catalogueLabel(item.externalIds) || 'the page'} gave no title or cover.`);
}
} catch (err) {
// Said out loud rather than only logged: a link that silently stays a
// link, with no reason given, is exactly what made this hard to
// diagnose the first time.
console.error('Link lookup failed, item stays as pasted:', err);
setCaptureStatus(`Couldn't look that link up: ${err.message || err}`);
}
}

// The canonical way this record type appears anywhere OTHER than its own
// list -- a nudge, a Telegram row, a status message (dashboard/CLAUDE.md's
// record-reference standard). Mirrors tripChipHtml/bindTripChips exactly.
function mediaChipHtml(item, extraHtml = '') {
return `<span class="task-chip" data-open-media="${escapeHtml(item.id)}">&#127916; ${escapeHtml(item.title)}</span>${extraHtml}`;
}

let mediaChipsBound = false;
function bindMediaChips() {
if (mediaChipsBound) return;
mediaChipsBound = true;
document.addEventListener('click', async (e) => {
const chip = e.target.closest('[data-open-media]');
if (chip) {
const { switchTab } = await import('../tabs.js');
switchTab('media');
revealMediaItem(chip.dataset.openMedia);
return;
}
// The "you already pay for this" tick, leading back to the real
// subscription row on Finances.
const sub = e.target.closest('[data-open-subscription]');
if (sub) {
const [{ switchTab }, subs] = await Promise.all([import('../tabs.js'), import('./subscriptions.js')]);
switchTab('finances');
subs.revealSubscription(sub.dataset.openSubscription);
}
});
}

function revealMediaItem(id) {
const item = data.mediaItems.find((m) => m.id === id);
// A finished item is hidden by default, which would otherwise make
// this silently scroll to nothing -- same guard revealTask uses for a
// done task.
if (item && !OPEN_STATUSES.includes(item.status)) showFinished = true;
if (item && kindFilter !== 'all' && item.kind !== kindFilter) kindFilter = 'all';
renderMedia();
setTimeout(() => scrollAndFlash(`[data-media-row="${id}"]`), 60);
}

// Until a link's real title arrives (or if it never does), show something
// readable rather than 300 characters of Amazon tracking parameters.
function displayTitle(item) {
if (!looksLikeUrl(item.title)) return item.title;
try {
const u = new URL(item.title);
const firstSegment = u.pathname.split('/').filter(Boolean)[0] || '';
const pretty = `${u.hostname.replace(/^www\./, '')}${firstSegment ? `/${firstSegment}` : ''}`;
return pretty.length > 70 ? `${pretty.slice(0, 70)}…` : pretty;
} catch (e) {
return item.title.slice(0, 70);
}
}

// Which catalogues are worth OFFERING on an item that doesn't have them
// yet. Only the ones that do work: TMDb drives where-to-watch and the
// poster, TVDB is how Sonarr finds a series. IMDb earns its place by
// being the id most often to hand when neither of those resolves.
const OFFERED_IDS = { film: ['tmdb', 'imdb'], tv: ['tmdb', 'tvdb', 'imdb'] };

// Every id this item carries, as one cluster of chips.
//
// The id itself stays in the tooltip rather than on the row: "TVDB
// 387219" is six characters of signal and nine of noise, and the number
// matters at the moment you're checking or fixing it, not while you're
// scanning a list. Clicking any chip opens the editor on that field.
//
// A missing-but-useful catalogue still gets a chip, outlined rather than
// filled -- otherwise an item with no TVDB id has nowhere to click, and
// "why is there no Monitor button" has no visible answer.
function idChipsHtml(item) {
const ids = item.externalIds || {};
const have = Object.keys(ids).filter((k) => ids[k]);
if (item.tvdbId && !have.includes('tvdb')) have.push('tvdb');
// Only ONE kind of gap is worth a chip of its own: a series with no
// TVDB id, because that's the visible answer to "where did the Monitor
// button go". A chip per missing catalogue made the row LONGER than the
// duplicated one this was meant to shorten.
const offered = [];
if (item.kind === 'tv' && !have.includes('tvdb')) offered.push('tvdb');
const chip = (key, known) => {
const label = CATALOGUE_LABELS[key] || key;
const value = key === 'tvdb' ? (item.tvdbId || ids.tvdb || '') : (ids[key] || '');
return `<span class="task-context media-id-chip${known ? '' : ' unset'}" data-media-id="${item.id}" data-media-id-key="${escapeHtml(key)}"
title="${known ? `${escapeHtml(label)} ${escapeHtml(String(value))} — click to change` : `No ${escapeHtml(label)} id — click to add one`}">${escapeHtml(label)}${known ? '' : ' +'}</span>`;
};
// Nothing identified at all still needs a door in, or the dialog is
// unreachable on exactly the items that most need it.
if (!have.length && !offered.length) {
return `<span class="task-context media-id-chip unset" data-media-id="${item.id}" data-media-id-key="" title="Not identified on any catalogue — click to add an id">id +</span>`;
}
return [...have.map((k) => chip(k, true)), ...offered.map((k) => chip(k, false))].join('');
}

// A book-kind want's path onto the Family tab's shelf -- addBookFromMediaItem
// (books.js) carries title/creator/imageUrl/link across, same shape
// shopping.js's offerToRecordOwned already uses for AP wants. Once it's
// flowed across, the record-reference rule applies going the OTHER way
// too: this row names a real Books record now, so it links to it rather
// than just offering the button a second time. data-open-book works here
// with no import at all -- books.js's bindBookChips() is bound globally
// on document once the app starts, same as every other chip handler.
function bookLinkHtml(item) {
if (item.kind !== 'book') return '';
const book = (data.books || []).find((b) => b.fromMediaId === item.id);
if (book) return `<span class="task-chip" data-open-book="${escapeHtml(book.id)}">&#128214; On your shelf</span>`;
return `<button class="mini-task-btn" type="button" data-media-add-book="${item.id}" title="Add this to your physical Books inventory on the Family tab">&#128214; Add to Books</button>`;
}

function rowHtml(item) {
const photoId = (item.photoIds || [])[0];
const byline = [item.creator, item.year].filter(Boolean).join(' · ');
// Poster first when there is one -- a shelf of covers is the point of
// this list. A captured screenshot is the fallback picture, and a
// broken remote image hides itself rather than leaving a torn icon.
const art = item.imageUrl
? `<img class="media-art" src="${escapeHtml(item.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
: (photoId ? `<span class="thumb-img media-art" data-photo-bg="${escapeHtml(photoId)}"></span>` : '');
return `<div class="mail-row${OPEN_STATUSES.includes(item.status) ? '' : ' done'}" data-media-row="${item.id}">
${art}
<span class="task-context">${escapeHtml(KIND_LABEL[item.kind] || item.kind)}</span>
<span class="mail-subject">${item.link ? `<a href="${escapeHtml(affiliateLink(item.link))}" target="_blank" rel="noopener">${escapeHtml(displayTitle(item))}</a>` : escapeHtml(displayTitle(item))}</span>
${byline ? `<span class="settings-note" style="margin:0;">${escapeHtml(byline)}</span>` : ''}
${item.requestedBy ? `<span class="settings-note" style="margin:0;">asked by ${escapeHtml(item.requestedBy)}</span>` : ''}
${idChipsHtml(item)}
${whereToWatchHtml(item)}
${item.acquisition && item.acquisition.state === 'requested' ? `<span class="task-context" title="Requested from ${escapeHtml(item.acquisition.client || 'the downloader')}">&#8681; downloading</span>` : ''}
${item.plexCheck ? (item.plexCheck.found
? `<span class="task-context" style="background:var(--sage-bg);color:var(--sage);font-weight:600;" title="In your Plex library${item.plexCheck.matchedTitle ? ` as &quot;${escapeHtml(item.plexCheck.matchedTitle)}&quot;${item.plexCheck.matchedYear ? ` (${escapeHtml(item.plexCheck.matchedYear)})` : ''}` : ''}">&#10003; On Plex</span>`
: `<span class="settings-note" style="margin:0;" title="Checked on ${escapeHtml(String(item.plexCheck.checkedAt).slice(0, 10))}">not on Plex</span>`) : ''}
${item.notes ? `<span class="settings-note" style="margin:0;">${escapeHtml(item.notes)}</span>` : ''}
${bookLinkHtml(item)}
<span class="media-row-actions">
${monitorHtml(item)}
<button class="mini-task-btn" type="button" data-media-satisfy="${item.id}" title="How to get hold of it">Get&hellip;</button>
<select class="mini" data-media-status="${item.id}">
${MEDIA_STATUSES.map((s) => `<option value="${s.status}"${s.status === item.status ? ' selected' : ''}>${escapeHtml(s.label)}</option>`).join('')}
</select>
<span class="del-x" data-media-remove="${item.id}" title="Remove">&times;</span>
</span>
</div>`;
}

function renderMedia() {
const list = document.getElementById('media-list');
if (!list) return; // tab not in this build's DOM
const open = data.mediaItems.filter((m) => OPEN_STATUSES.includes(m.status));
const count = document.getElementById('media-count');
if (count) count.textContent = data.mediaItems.length ? `${open.length} to go of ${data.mediaItems.length}` : '';

renderKindFilter();
let items = data.mediaItems.filter((m) => showFinished || OPEN_STATUSES.includes(m.status));
if (kindFilter !== 'all') items = items.filter((m) => m.kind === kindFilter);
list.innerHTML = items.length
? items.map(rowHtml).join('')
: `<div class="empty">${data.mediaItems.length ? 'Nothing here with those filters.' : 'Nothing queued — add something above, share a link, or mark a screenshot M.'}</div>`;
hydratePhotoBackgrounds(list);
hideBrokenArt(list);
enrichPending();

list.querySelectorAll("[data-media-monitor]").forEach((btn) => {
btn.addEventListener("click", () => {
const item = data.mediaItems.find((m) => m.id === btn.dataset.mediaMonitor);
if (item) openMonitorDialog(item);
});
});
list.querySelectorAll('[data-media-id]').forEach((chip) => {
chip.addEventListener('click', () => {
const item = data.mediaItems.find((m) => m.id === chip.dataset.mediaId);
if (item) openIdsDialog(item, chip.dataset.mediaIdKey);
});
});
list.querySelectorAll('[data-media-satisfy]').forEach((btn) => {
btn.addEventListener('click', () => {
const item = data.mediaItems.find((m) => m.id === btn.dataset.mediaSatisfy);
if (item) showRoutes(item);
});
});
list.querySelectorAll('[data-media-status]').forEach((sel) => {
sel.addEventListener('change', () => {
const item = data.mediaItems.find((m) => m.id === sel.dataset.mediaStatus);
if (!item) return;
item.status = sel.value;
queueSave();
renderMedia();
});
});
list.querySelectorAll('[data-media-add-book]').forEach((btn) => {
btn.addEventListener('click', async () => {
const item = data.mediaItems.find((m) => m.id === btn.dataset.mediaAddBook);
if (!item) return;
const { addBookFromMediaItem } = await import('./books.js');
addBookFromMediaItem(item);
renderMedia();
});
});
list.querySelectorAll('[data-media-remove]').forEach((x) => {
x.addEventListener('click', () => {
const item = data.mediaItems.find((m) => m.id === x.dataset.mediaRemove);
if (!item || !confirm(`Remove "${item.title}"?`)) return;
data.mediaItems = data.mediaItems.filter((m) => m.id !== x.dataset.mediaRemove);
queueSave();
renderMedia();
});
});
}

// Remote art can 404 or be hotlink-blocked long after it was stored, and
// a torn-image icon looks broken in a way "no picture" doesn't. Bound
// rather than an inline onerror so no inline script is needed.
// Anything still showing a URL for a title, or missing its artwork, gets
// one attempt at enrichment -- so rows added before this existed (or
// while the server was unreachable) fix themselves on a later visit.
// Attempts are remembered for the session so a page that can't be
// enriched isn't re-fetched on every render, and only a few go at once.
const enrichAttempted = new Set();
// Separate from enrichAttempted because the two ask different questions
// of different items -- artwork for anything with a link, a TVDB id for
// a series with a catalogue id -- and sharing one set would let whichever
// ran first silence the other.
const tvdbAttempted = new Set();
function enrichPending() {
data.mediaItems
.filter((m) => m.link && (looksLikeUrl(m.title) || !m.imageUrl) && !enrichAttempted.has(m.id))
.slice(0, 3)
.forEach((m) => {
enrichAttempted.add(m.id);
fillArtwork(m);
});
// A new series gets its TVDB id on the way in, so the Monitor button
// is ready the moment you think to press it rather than resolving
// while you wait. Quiet on failure: this is a background nicety, and
// the panel's own button reports properly when it matters. One id
// per render keeps a long list from firing a burst at TMDb.
const needsId = data.mediaItems.find((m) => m.kind === 'tv'
&& OPEN_STATUSES.includes(m.status)
&& !/^\d+$/.test(String(m.tvdbId || ''))
&& ((m.externalIds || {}).tmdb || (m.externalIds || {}).imdb || (m.externalIds || {}).tvdb)
&& !tvdbAttempted.has(m.id));
if (needsId) {
tvdbAttempted.add(needsId.id);
resolveTvdbId(needsId).then((res) => { if (res.id) renderMedia(); }).catch(() => {});
}
}

function hideBrokenArt(root) {
root.querySelectorAll('img.media-art').forEach((img) => {
img.addEventListener('error', () => { img.style.display = 'none'; });
});
}

// The point of this line is the difference between "streaming on
// something you already pay for" and "streaming on something you'd have
// to pay for", so a service you already subscribe to is called out and
// listed first. Rent/buy is mentioned only when nothing includes it,
// since "you could rent it" is noise next to "it's on Netflix".
function whereToWatchHtml(item) {
const w = item.whereToWatch;
if (!w) return '';
const subs = data.subscriptions || [];
// Collapsed again on the way out, not just on the way in: a record
// written before that logic existed still has both "Amazon Prime Video"
// and "Amazon Prime Video with Ads" on it, and nothing re-checks an item
// that already has an answer. See collapseProviders.
const onSubscription = collapseProviders(w.flatrate).map((name) => ({ name, sub: subscriptionFor(name, subs) }));
const yours = onSubscription.filter((p) => p.sub);
const others = onSubscription.filter((p) => !p.sub);
if (!onSubscription.length && !w.rent.length && !w.buy.length) {
return `<span class="settings-note" style="margin:0;">Not streaming in ${escapeHtml(w.region)}</span>`;
}
// The ones you pay for come first and the rest are capped, because the
// row's job is "can I just watch this" -- a list of six places that
// would each want a card pushes the title and the buttons off the line.
const MAX_OTHERS = 2;
const extra = others.slice(MAX_OTHERS);
const chips = [
// Clickable, because this names a real subscription record: per
// CLAUDE.md, a record shown outside its own list leads back to it.
...yours.map((p) => `<span class="task-context" style="background:var(--sage-bg);color:var(--sage);font-weight:600;cursor:pointer;" data-open-subscription="${escapeHtml(p.sub.id)}" title="You already pay for ${escapeHtml(p.sub.name)} — open it">&#10003; ${escapeHtml(shortProviderName(p.name))}</span>`),
...others.slice(0, MAX_OTHERS).map((p) => `<span class="task-context" title="Streaming here, but not one of your subscriptions">${escapeHtml(shortProviderName(p.name))}</span>`),
];
if (extra.length) {
chips.push(`<span class="task-context" title="Also streaming on ${escapeHtml(extra.map((p) => p.name).join(', '))} — none of them yours">+${extra.length}</span>`);
}
if (!onSubscription.length) {
const paid = collapseProviders([...w.rent, ...w.buy]).slice(0, 3).map(shortProviderName);
chips.push(`<span class="settings-note" style="margin:0;">rent/buy: ${escapeHtml(paid.join(', '))}</span>`);
}
return chips.join('');
}

// "Do I already have this?" -- the one question the dashboard genuinely
// cannot answer by itself, since Plex is behind the router. Goes through
// the home agent (js/homeagent.js), one command per item, and anything
// found flips to Available so it stops looking like something to get.
async function checkAgainstPlex() {
const status = document.getElementById('media-plex-status');
const say = (text) => { if (status) status.textContent = text; };
const targets = data.mediaItems.filter((m) => m.status === 'wanted' && (m.kind === 'film' || m.kind === 'tv'));
if (!targets.length) { say('Nothing wanted to check.'); return; }
const agent = await import('../homeagent.js');
try {
const beat = await agent.agentHeartbeat();
if (!beat) { say("No agent has checked in — is it running on the NAS?"); return; }
} catch (err) {
say(err.message || String(err));
return;
}
let found = 0;
const toConfirm = [];
for (let i = 0; i < targets.length; i++) {
const item = targets[i];
say(`Checking ${i + 1} of ${targets.length} — ${item.title}…`);
try {
const result = await agent.run('plex.search', { title: item.title, kind: item.kind });
const live = data.mediaItems.find((m) => m.id === item.id);
if (!live) continue;
const candidates = result.candidates || [];
const sure = unambiguousMatch(item, candidates);
if (sure) {
markOnPlex(live, sure);
found++;
} else if (candidates.length) {
toConfirm.push({ itemId: live.id, candidates });
} else {
live.plexCheck = { checkedAt: new Date().toISOString(), found: false, ratingKey: '' };
}
} catch (err) {
console.error(`Plex check failed for "${item.title}":`, err);
say(`Stopped at "${item.title}": ${err.message || err}`);
queueSave();
renderMedia();
return;
}
}
queueSave();
renderMedia();
const askAbout = toConfirm.length ? `, ${toConfirm.length} to confirm` : '';
say(`Checked ${targets.length} — ${found} already on Plex${askAbout}.`);
if (toConfirm.length) showPlexConfirmations(toConfirm);
}

// Accepted without asking only when there's exactly one exactly-titled
// candidate and no year that actively disagrees. Everything else is a
// question rather than a verdict: a year apart is ordinary for an
// international release, and a near-title is exactly the case a person
// should look at rather than a rule guess at.
function unambiguousMatch(item, candidates) {
const exact = (candidates || []).filter((c) => c.exactTitle);
if (exact.length !== 1) return null;
const only = exact[0];
if (item.year && only.year && only.year !== item.year) return null;
return only;
}

function markOnPlex(item, candidate) {
item.plexCheck = {
checkedAt: new Date().toISOString(),
found: true,
ratingKey: candidate.ratingKey || '',
matchedTitle: candidate.title || '',
matchedYear: candidate.year || '',
};
item.status = 'available';
}

// The "is this the same thing?" step, kept as a review rather than a
// guess -- the same shape the dating imports use for candidates AI isn't
// certain about. Held in memory only: re-running the check rebuilds it,
// so there's nothing to persist or leave half-answered.
function showPlexConfirmations(pending) {
const host = document.getElementById('media-candidates');
if (!host) return;
host.innerHTML = pending.map((entry) => {
const item = data.mediaItems.find((m) => m.id === entry.itemId);
if (!item) return '';
return `<div class="alloc-card" data-plex-confirm="${escapeHtml(entry.itemId)}">
<div class="alloc-title">Is your "${escapeHtml(item.title)}"${item.year ? ` (${escapeHtml(item.year)})` : ''} one of these?</div>
${entry.candidates.map((c, i) => `<div class="mail-row" data-plex-pick="${i}" style="cursor:pointer;">
<span class="mail-subject">${escapeHtml(c.title)}${c.year ? ` (${escapeHtml(c.year)})` : ''}</span>
${c.exactTitle && c.year && item.year && c.year !== item.year ? '<span class="settings-note" style="margin:0;">same title, different year</span>' : ''}
<span class="settings-note" style="margin:0;">${escapeHtml(c.librarySectionTitle || c.type || '')}</span>
</div>`).join('')}
<div class="alloc-controls">
<button class="todo-add-btn" type="button" data-plex-none>None of these — not on Plex</button>
</div>
</div>`;
}).join('');
host.querySelectorAll('[data-plex-confirm]').forEach((card) => {
const entry = pending.find((p) => p.itemId === card.dataset.plexConfirm);
const finish = () => { card.remove(); queueSave(); renderMedia(); };
card.querySelectorAll('[data-plex-pick]').forEach((row) => {
row.addEventListener('click', () => {
const item = data.mediaItems.find((m) => m.id === entry.itemId);
if (item) markOnPlex(item, entry.candidates[Number(row.dataset.plexPick)]);
finish();
});
});
card.querySelector('[data-plex-none]').addEventListener('click', () => {
const item = data.mediaItems.find((m) => m.id === entry.itemId);
if (item) item.plexCheck = { checkedAt: new Date().toISOString(), found: false, ratingKey: '' };
finish();
});
});
}

// ---- Satisfying a want ------------------------------------------------
//
// Routes come from prefs (state.js's mediaRoutes) and say only WHAT should
// happen: stream it, buy it, search somewhere, request a download. What
// counts as a good download -- codec, size, release group -- belongs in
// Radarr/Sonarr's own quality profiles, so a route carries at most the
// name of the profile to ask for.

function fillTemplate(template, item) {
const q = [item.title, item.creator].filter(Boolean).join(' ');
return String(template || '')
.replace(/\{title\}/g, encodeURIComponent(item.title || ''))
.replace(/\{creator\}/g, encodeURIComponent(item.creator || ''))
.replace(/\{year\}/g, encodeURIComponent(item.year || ''))
.replace(/\{isbn\}/g, encodeURIComponent(item.externalIds?.asin || ''))
.replace(/\{q\}/g, encodeURIComponent(q));
}

// A stream route only makes sense when it's actually streaming somewhere
// you already pay for -- otherwise "watch it on a service you subscribe
// to" is an instruction you can't follow.
function subscribedProvider(item) {
const flat = collapseProviders(item.whereToWatch ? item.whereToWatch.flatrate : []);
for (const name of flat) {
const sub = subscriptionFor(name, data.subscriptions || []);
if (sub) return { name, sub };
}
return null;
}

// ---- Monitoring an ongoing series -----------------------------------------
//
// A series that's still running is a standing want rather than a one-off:
// every new episode is another thing to fetch, forever. Sonarr is built
// for exactly that and keys series by TVDB id, which is the id this app
// already stores -- so "monitor it" is a short hop rather than a feature.
//
// Offered, never automatic. Turning on monitoring quietly is how a NAS
// fills up, and everything else here proposes first (Tinder imports,
// switch offers, want-to-has).
function monitorHtml(item) {
if (item.kind !== 'tv') return '';
if (item.monitor && item.monitor.enabledAt) {
const f = item.monitor.filter || [];
const last = item.monitor.lastRun;
return `<span class="task-context" style="background:var(--sage-bg);color:var(--sage);font-weight:600;"
title="Monitored in Sonarr${f.length ? `, ${f.join(' / ')} only` : ', every episode'}${last ? ` — last reconciled ${escapeHtml(String(last).slice(0, 10))}` : ''}">&#9679; Monitored${f.length ? ` (${escapeHtml(f.join('/'))})` : ''}</span>
<button class="mini-task-btn" type="button" data-media-monitor="${item.id}" title="Change what's monitored, or turn it off">Edit</button>`;
}
// Only series: Sonarr takes TV, and a film is a one-off fetch rather
// than a standing arrangement.
if (item.kind !== 'tv') return '';
if (item.monitor && item.monitor.declinedAt) return '';
const ids = item.externalIds || {};
// Offered when SOME exact route to a TVDB id exists -- the id itself is
// resolved when the dialog opens, because resolving every row's id on
// every render would be a TMDb call per paint.
// Setting the id lives on the TVDB chip with the other identifiers, not
// here: this is an action, that's what the thing IS.
const resolvable = item.tvdbId || ids.tvdb || ids.tmdb || ids.imdb;
return resolvable ? `<button class="mini-task-btn" type="button" data-media-monitor="${item.id}" title="Have Sonarr watch for new episodes of this">Monitor&hellip;</button>` : '';
}

// The TVDB slug, when the item was identified on TheTVDB itself. Only
// that gives the site's own pages, which is where a series' status and
// its episode titles come from.
function tvdbSlug(item) {
const stored = String((item.externalIds || {}).tvdb || '');
return /^\d+$/.test(stored) ? '' : stored.replace(/^series\//, '');
}

// The numeric TVDB id Sonarr needs, found by whichever route the item
// gives us, cheapest first. Resolved once and remembered on the record,
// because every route costs either a proxy fetch or a TMDb call and the
// answer never changes.
//
// Deliberately NOT a title search. A title is a guess ("The Office" is
// nine series), and a wrong id has Sonarr fetching someone else's show
// into your library -- that one is the manual button's job, where you
// can see what you're agreeing to. Everything here is an exact id
// following another exact id.
//
// `html` is passed in when the caller already has the series page, which
// the monitor dialog does -- fetching it twice is a second trip through
// the proxy for a page already in hand.
async function resolveTvdbId(item, html) {
const known = String(item.tvdbId || '');
if (/^\d+$/.test(known)) return { id: known, via: 'saved' };

const stored = String((item.externalIds || {}).tvdb || '');
if (/^\d+$/.test(stored)) return save(item, stored, 'TVDB link');

const slug = tvdbSlug(item);
if (slug) {
if (!html) {
const { fetchPageHtml } = await import('../files.js');
html = await fetchPageHtml(item.link || `https://thetvdb.com/series/${slug}`);
}
const m = /artworks\.thetvdb\.com\/banners\/series\/(\d+)\//i.exec(html || '')
|| /tvdb[_-]?id["'\s:=]+(\d{4,})/i.exec(html || '');
if (m) return save(item, m[1], 'TVDB page');
}

// The route that covers the existing list: almost everything here came
// from TMDb search or a shared IMDb link, neither of which carries a
// TVDB reference at all.
const { tvdbIdViaTmdb } = await import('../catalogue.js');
const hit = await tvdbIdViaTmdb(item.externalIds || {});
if (hit) return save(item, hit.id, hit.via);
// A reason, not just a blank. "Still unknown" with nothing after it
// sends you looking for a bug when the answer is "this show has no
// TVDB entry" or "you never gave it a link".
const ids = item.externalIds || {};
return { id: '', via: '',
why: slug ? "TheTVDB's page carried no id"
: (ids.tmdb || ids.imdb) ? "TMDb doesn't cross-reference it to TheTVDB"
: 'nothing to look it up by' };
}

function save(item, id, via) {
item.tvdbId = String(id);
queueSave();
return { id: String(id), via };
}

// Fills in the ids for everything still wanted, so the Monitor button
// appears on shows added before any of this existed. Only the exact
// routes run, so nothing is guessed; whatever's left over keeps its
// "Link TVDB" button and a reason.
async function backfillTvdbIds() {
const status = document.getElementById('media-tvdb-status');
const say = (t) => { if (status) status.textContent = t; };
const todo = data.mediaItems.filter((m) => m.kind === 'tv'
&& OPEN_STATUSES.includes(m.status)
&& !/^\d+$/.test(String(m.tvdbId || '')));
if (!todo.length) { say('Every series already has a TVDB id.'); return; }
let found = 0;
const missed = [];
for (const item of todo) {
say(`Looking up ${found + missed.length + 1} of ${todo.length}…`);
try {
const res = await resolveTvdbId(item);
if (res.id) found += 1;
else missed.push({ item, why: res.why });
} catch (err) {
missed.push({ item, why: err.message || String(err) });
}
}
renderMedia();
if (!missed.length) { say(`${found} of ${todo.length} resolved.`); return; }
// Each unresolved series is named as a chip rather than as text, so you
// can click straight to the row whose TVDB button needs pressing --
// a list of bare titles makes you go find them yourself.
if (status) {
status.innerHTML = `${found} of ${todo.length} resolved. Still unknown: ${missed
.map((m) => `${mediaChipHtml(m.item)} <span class="settings-note" style="display:inline;margin:0;">${escapeHtml(String(m.why).replace(/\.$/, ''))}</span>`)
.join(' ')}`;
// bindMediaChips() is already delegated at the document, so these chips
// work without rebinding.
}
}

// What each catalogue is FOR, and where to go looking when you haven't
// got the id -- the dialog says both, because "paste a TVDB id" is not
// a useful instruction on its own.
const ID_HELP = {
tmdb: { what: 'Drives where-to-watch and the poster.', hint: 'themoviedb.org address, or tv/1396', search: (t) => `https://www.themoviedb.org/search?query=${encodeURIComponent(t)}` },
tvdb: { what: 'How Sonarr finds a series.', hint: 'thetvdb.com address, or 387219', search: (t) => `https://thetvdb.com/search?query=${encodeURIComponent(t)}` },
imdb: { what: 'Resolves to a TMDb id when nothing else does.', hint: 'imdb.com address, or tt0903747', search: (t) => `https://www.imdb.com/find/?q=${encodeURIComponent(t)}` },
};

// One dialog for every identifier on an item, opened from whichever chip
// was clicked. One rather than one-per-provider because they're the same
// question asked three ways, and because pasting a TMDb URL into the
// TVDB box should be recognised rather than rejected -- identifyUrl
// already knows which catalogue a URL belongs to, so a paste lands in
// the right field whichever one you opened.
function openIdsDialog(item, focusKey = '') {
const ids = item.externalIds || {};
const keys = [...new Set([
...Object.keys(ids).filter((k) => ids[k] && ID_HELP[k]),
...(item.tvdbId ? ['tvdb'] : []),
...(OFFERED_IDS[item.kind] || []),
...(focusKey ? [focusKey] : []),
])];
// A catalogue with no editor entry (Spotify, Goodreads...) is shown as
// read-only rather than hidden: it still explains where the item came
// from, and quietly dropping it from a dialog called "Identifiers"
// would be a lie.
const readOnly = Object.keys(ids).filter((k) => ids[k] && !keys.includes(k));

const valueFor = (k) => (k === 'tvdb' ? (item.tvdbId || ids.tvdb || '') : (ids[k] || ''));
const dialog = document.createElement('div');
dialog.className = 'mail-view-backdrop';
dialog.innerHTML = `<div class="mail-view-card" style="max-width:480px;">
<div class="mail-view-subject">Identifiers for ${escapeHtml(displayTitle(item))}</div>
<div class="settings-note" style="margin:2px 0 10px;">Paste an address or the bare id. An address from any of these catalogues lands in its own box, whichever one you type it into.</div>
${keys.map((k) => `<label style="display:block;margin-bottom:8px;">
<span style="font-size:12px;font-weight:600;">${escapeHtml(CATALOGUE_LABELS[k] || k)}</span>
<span class="settings-note" style="display:inline;margin:0 0 0 4px;">${escapeHtml(ID_HELP[k]?.what || '')}</span>
<input type="text" data-id-field="${escapeHtml(k)}" value="${escapeHtml(String(valueFor(k)))}" placeholder="${escapeHtml(ID_HELP[k]?.hint || '')}" style="width:100%;">
${ID_HELP[k] ? `<a class="settings-note" style="display:inline-block;margin:2px 0 0;" href="${escapeHtml(ID_HELP[k].search(item.title || ''))}" target="_blank" rel="noopener">Search ${escapeHtml(CATALOGUE_LABELS[k] || k)}</a>` : ''}
</label>`).join('')}
${readOnly.length ? `<div class="settings-note" style="margin:0 0 8px;">Also identified on ${escapeHtml(readOnly.map((k) => `${CATALOGUE_LABELS[k] || k} ${ids[k]}`).join(', '))}.</div>` : ''}
<div class="mail-view-actions">
<button class="sync-btn sm" type="button" data-ids-cancel>Cancel</button>
<button class="add-btn" type="button" data-ids-save>Save</button>
</div>
<div class="sync-status" data-ids-status></div></div>`;
document.body.appendChild(dialog);
const close = () => dialog.remove();
bindBackdropClose(dialog, close);
dialog.querySelector('[data-ids-cancel]').addEventListener('click', close);
const focus = dialog.querySelector(`[data-id-field="${focusKey}"]`) || dialog.querySelector('[data-id-field]');
focus?.focus();

dialog.querySelector('[data-ids-save]').addEventListener('click', async () => {
const note = dialog.querySelector('[data-ids-status]');
const next = { ...ids };
let tvdbRaw = null;
let resolveTvdb = false;
// A value that moved to a different box needs saying, and a dialog that
// vanishes on save says nothing -- so that one case lingers long enough
// to be read.
let rehomed = false;

for (const field of dialog.querySelectorAll('[data-id-field]')) {
const key = field.dataset.idField;
const raw = (field.value || '').trim();
if (raw === String(valueFor(key))) continue;
if (!raw) { // cleared
if (key === 'tvdb') { tvdbRaw = ''; } else { delete next[key]; }
continue;
}
// A pasted URL is identified by the catalogue it actually belongs to,
// not by the box it was typed into.
const found = identifyUrl(raw).ids;
const foundKey = Object.keys(found)[0];
if (foundKey) {
if (foundKey === 'tvdb') tvdbRaw = raw; else next[foundKey] = found[foundKey];
if (foundKey !== key) { note.textContent = `That's a ${CATALOGUE_LABELS[foundKey] || foundKey} address — saved as ${CATALOGUE_LABELS[foundKey] || foundKey}, not ${CATALOGUE_LABELS[key] || key}.`; rehomed = true; }
continue;
}
if (key === 'tvdb') { tvdbRaw = raw; continue; }
// Not a URL and not a known shape: stored as typed. TMDb ids are
// "tv/1396" rather than a bare number, so a bare number gets the
// item's own kind rather than being guessed at.
next[key] = key === 'tmdb' && /^\d+$/.test(raw) ? `${item.kind === 'tv' ? 'tv' : 'movie'}/${raw}` : raw;
}

if (tvdbRaw !== null) {
// Same three URL shapes the TVDB-only dialog took, kept because the
// slug form carries no number and thetvdb.com/series/<digits> is a
// 404 page rather than a slug.
const num = /^(\d+)$/.exec(tvdbRaw)
|| /\/dereferrer\/series\/(\d+)/i.exec(tvdbRaw)
|| /[?&]id=(\d+)/.exec(tvdbRaw)
|| /thetvdb\.com\/series\/(\d+)\/?$/i.exec(tvdbRaw);
const slug = /thetvdb\.com\/series\/([a-z0-9-]*[a-z][a-z0-9-]*)/i.exec(tvdbRaw);
if (num) {
item.tvdbId = num[1];
} else if (slug) {
next.tvdb = `series/${slug[1]}`;
if (!item.link) item.link = `https://thetvdb.com/series/${slug[1]}`;
item.tvdbId = '';
resolveTvdb = true;
} else if (tvdbRaw === '') {
item.tvdbId = '';
delete next.tvdb;
} else {
note.textContent = "That isn't a TVDB address or id.";
return;
}
}

item.externalIds = next;
queueSave();
renderMedia();
if (!resolveTvdb) { setTimeout(close, rehomed ? 2200 : 0); return; }
// The slug form carries no number, so it's read off the page here --
// otherwise the chip comes back looking exactly as it did and gives no
// sign the paste landed.
note.textContent = 'Reading the number off that page…';
try {
const res = await resolveTvdbId(item);
renderMedia();
if (!res.id) { note.textContent = `Saved the link, but ${res.why}.`; return; }
} catch (err) {
note.textContent = `Saved the link, but couldn't read the id: ${err.message || err}`;
return;
}
close();
});
}

async function openMonitorDialog(item) {
const dialog = document.createElement('div');
dialog.className = 'mail-view-backdrop';
dialog.innerHTML = `<div class="mail-view-card" style="max-width:480px;">
<div class="mail-view-subject">Monitor ${escapeHtml(displayTitle(item))}?</div>
<div class="settings-note" style="margin:2px 0 8px;">Reading the series from TheTVDB&hellip;</div></div>`;
document.body.appendChild(dialog);
const close = () => dialog.remove();
bindBackdropClose(dialog, close);

let info = { ongoing: true, status: '' };
let sessions = { sessions: [], sessioned: false, episodeCount: 0 };
let seasonLabel = '';
let tvdbId = '';
let idVia = '';
let slugRead = false;
let idWhy = '';
try {
const { fetchPageHtml } = await import('../files.js');
const { tvdbSeriesInfo, tvdbSessions, tvdbSeasonNumbers, defaultSessionFilter } = await import('../catalogue.js');
// TheTVDB's own pages are only reachable by slug, which only an item
// identified on TheTVDB has. Everything else resolves to a bare number
// via TMDb -- enough for Sonarr, which is all monitoring needs. What
// goes missing is the status line and the session filter, and a series
// with one episode per event has nothing to filter anyway.
const slug = tvdbSlug(item);
// Whether TheTVDB's own pages were actually read, which is what the
// status line and the filter depend on -- distinct from "no filter
// needed", and the dialog says which.
slugRead = !!slug;
let seriesHtml = '';
if (slug) {
seriesHtml = await fetchPageHtml(item.link || `https://thetvdb.com/series/${slug}`);
info = tvdbSeriesInfo(seriesHtml);
}
// Non-fatal on purpose. Failing to find the id is the case most in
// need of the "set it by hand" button below, and letting the throw
// reach the outer catch replaces the whole dialog with an error and a
// Close -- taking that button away exactly when it's wanted.
try {
const resolved = await resolveTvdbId(item, seriesHtml);
tvdbId = resolved.id;
idVia = resolved.via;
idWhy = resolved.why || '';
} catch (err) {
idWhy = err.message || String(err);
}
if (!dialog.isConnected) return;
if (slug) {
// Episode titles are the whole basis for the filter, and they live on
// a season listing rather than the series page. The LATEST season, not
// all of them: see tvdbSeasonNumbers for why "all seasons" can't be
// fetched at all for a series this long. The latest can be thin --
// asked in January, a new season might hold two episodes -- so fall
// back a season when it hasn't enough titles to read a pattern from.
const seasons = tvdbSeasonNumbers(seriesHtml);
for (const n of seasons.slice(0, 2)) {
sessions = tvdbSessions(await fetchPageHtml(`https://thetvdb.com/series/${slug}/seasons/official/${n}`));
if (!dialog.isConnected) return;
seasonLabel = `season ${n}`;
if (sessions.sessioned) break;
}
// No season links at all means an unfamiliar page layout, and guessing
// "not sessioned" there would quietly monitor every practice session.
// The whole listing is the honest fallback; it only fails for the
// enormous series, and those always list their seasons.
if (!seasons.length) {
sessions = tvdbSessions(await fetchPageHtml(`https://thetvdb.com/series/${slug}/allseasons/official`));
seasonLabel = 'all seasons';
}
}
if (!dialog.isConnected) return;
const suggested = sessions.sessioned ? defaultSessionFilter(sessions.sessions) : [];
const current = item.monitor && item.monitor.filter ? item.monitor.filter : suggested;
// Only what was actually established. "Status unknown" is worth saying
// when TheTVDB's page was read and didn't say, and misleading when it
// was never read at all.
const facts = [
info.status || (slugRead ? 'Status unknown' : ''),
sessions.episodeCount ? `${sessions.episodeCount} episodes in ${escapeHtml(seasonLabel)}` : '',
tvdbId ? `TVDB ${escapeHtml(tvdbId)}${idVia && idVia !== 'saved' ? ` via ${escapeHtml(idVia)}` : ''}` : '',
].filter(Boolean);
dialog.innerHTML = `<div class="mail-view-card" style="max-width:480px;">
<div class="mail-view-subject">Monitor ${escapeHtml(displayTitle(item))}?</div>
<div class="settings-note" style="margin:2px 0 8px;">
${facts.length ? `${facts.join(' &middot; ')}.` : ''}
Sonarr will watch for new episodes and fetch them.
</div>
${sessions.sessioned ? `<div class="settings-note" style="margin:0 0 4px;">This series puts out several episodes per event, so monitoring all of them would chase every practice session. Tick the ones worth keeping:</div>
<div class="tag-editor" style="margin-bottom:8px;">${sessions.sessions.slice(0, 12).map((s) => `<label class="tag-chip" style="cursor:pointer;">
<input type="checkbox" data-monitor-session="${escapeHtml(s.session)}"${current.some((c) => c.toLowerCase() === s.session.toLowerCase()) ? ' checked' : ''}> ${escapeHtml(s.session)} <span class="settings-note" style="display:inline;margin:0;">${s.count}</span>
</label>`).join('')}</div>` : `<div class="settings-note" style="margin:0 0 8px;">Every episode will be monitored${slugRead ? ' — this series puts out one per event' : ", which is right unless it's a sport with practice sessions to skip. Those are filtered from its TheTVDB page, which needs a thetvdb.com link on this item"}.</div>`}
${tvdbId ? '' : `<div class="settings-note" style="color:var(--amber);margin:0 0 8px;">No TVDB id found, which is what Sonarr looks a series up by${idWhy ? ` — ${escapeHtml(idWhy.replace(/\.$/, ''))}` : ''}. Monitoring can be saved now, but nothing reaches Sonarr until the id is set.
<button class="mini-task-btn" type="button" data-monitor-setid style="margin-left:4px;">Set it by hand&hellip;</button></div>`}
<div class="mail-view-actions">
<button class="sync-btn sm" type="button" data-monitor-cancel>Not now</button>
${item.monitor && item.monitor.enabledAt ? '<button class="sync-btn sm" type="button" data-monitor-off>Stop monitoring</button>' : ''}
<button class="add-btn" type="button" data-monitor-save>Monitor</button>
</div>
<div class="sync-status" data-monitor-status></div></div>`;
} catch (err) {
if (!dialog.isConnected) return;
dialog.innerHTML = `<div class="mail-view-card" style="max-width:480px;">
<div class="mail-view-subject">Couldn't read that series</div>
<div class="settings-note">${escapeHtml(err.message || String(err))}</div>
<div class="mail-view-actions"><button class="sync-btn sm" type="button" data-monitor-close>Close</button></div></div>`;
}
// Dismissing a dialog that FAILED to load isn't a decision, so it gets
// its own button: the one below remembers a "no thanks" to stop the row
// asking again, and a lookup that timed out would otherwise silence the
// offer forever on the strength of a slow page.
dialog.querySelector('[data-monitor-close]')?.addEventListener('click', close);
dialog.querySelector('[data-monitor-setid]')?.addEventListener('click', () => { close(); openIdsDialog(item, "tvdb"); });
dialog.querySelector('[data-monitor-cancel]')?.addEventListener('click', () => {
// Remembered, so the prompt stops asking about a series you've
// already said no to -- without it, every render offers again.
if (!item.monitor || !item.monitor.enabledAt) {
item.monitor = { ...(item.monitor || {}), declinedAt: new Date().toISOString() };
queueSave();
renderMedia();
}
close();
});
dialog.querySelector('[data-monitor-off]')?.addEventListener('click', () => {
item.monitor = null;
queueSave();
renderMedia();
close();
});
dialog.querySelector('[data-monitor-save]')?.addEventListener('click', async () => {
const filter = [...dialog.querySelectorAll('[data-monitor-session]:checked')].map((c) => c.dataset.monitorSession);
item.monitor = {
service: 'sonarr', tvdbId, filter,
enabledAt: new Date().toISOString(), lastRun: '', declinedAt: '',
};
queueSave();
renderMedia();
const status = dialog.querySelector('[data-monitor-status]');
status.textContent = 'Telling Sonarr…';
const res = await applyMonitor(item);
status.textContent = res.message;
setTimeout(close, res.ok ? 1200 : 5000);
});
}

// Hands the decision to Sonarr, via the home agent. Kept separate from
// the dialog so the scheduled reconcile can call exactly the same thing
// -- which is the whole point of a standing want: new episodes appear
// without anyone opening a dialog.
async function applyMonitor(item) {
const m = item.monitor;
// The record's resolved id wins over the one the monitor snapshotted at
// save time: setting the id by hand afterwards is exactly how a series
// that couldn't be resolved gets fixed, and reading the stale snapshot
// would leave it permanently unreachable.
const tvdbId = String(item.tvdbId || (m && m.tvdbId) || '');
if (!m || !tvdbId) return { ok: false, message: 'No TVDB id — nothing to tell Sonarr.' };
try {
const { run } = await import('../homeagent.js');
// Added first if it isn't there; arr.add is a no-op when it is.
await run('arr.add', { kind: 'tv', title: item.title, tvdbId }, { timeoutMs: 45000 });
const res = await run('arr.monitor', {
tvdbId,
// The filter becomes a pattern matching "(Race)" and friends --
// the session sits in brackets at the end of a TVDB episode title.
include: m.filter && m.filter.length
? `\\((${m.filter.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\)\\s*$`
: '.',
}, { timeoutMs: 90000 });
item.monitor = { ...m, lastRun: new Date().toISOString() };
queueSave();
renderMedia();
return { ok: true, message: `Sonarr is watching ${res.monitored} episode${res.monitored === 1 ? '' : 's'}${res.searching ? `, searching ${res.searching}` : ''}.` };
} catch (err) {
return { ok: false, message: `Couldn't reach Sonarr: ${err.message || err}` };
}
}

// Every monitored series, re-reconciled. Called from the scheduler: a
// race weekend added to TheTVDB this week has to be turned on in Sonarr,
// and nothing else notices that it appeared.
async function reconcileMonitors() {
const items = data.mediaItems.filter((m) => m.monitor && m.monitor.enabledAt && (m.tvdbId || m.monitor.tvdbId));
let done = 0;
for (const item of items) {
const res = await applyMonitor(item);
if (res.ok) done += 1;
}
return { series: items.length, reconciled: done };
}

function routesFor(item) {
const all = (data.prefs.mediaRoutes || {})[item.kind] || [];
return all.filter((r) => (r.type === 'stream' ? !!subscribedProvider(item) : true));
}

async function runRoute(item, route) {
if (route.type === 'stream') {
const where = subscribedProvider(item);
const url = (item.whereToWatch && item.whereToWatch.link) || item.link;
if (url) window.open(url, '_blank', 'noopener');
item.status = 'available';
queueSave();
renderMedia();
return `Opened ${where ? shortProviderName(where.name) : 'where to watch'}.`;
}
if (route.type === 'search') {
const url = fillTemplate(route.urlTemplate, item);
if (!url) return 'That route has no search URL set — add one in Settings.';
window.open(url, '_blank', 'noopener');
return `Searched ${route.label}.`;
}
if (route.type === 'buy') {
// Reuses the shopping list rather than inventing a second one: a
// thing to buy is a task with a shopping context, which already gets
// price checks and lives where the rest of the shopping does.
const { captureTask } = await import('./tasks.js');
const title = [item.title, item.creator].filter(Boolean).join(' — ');
const task = captureTask({
title,
link: item.link || '',
contexts: [route.context || 'Aspirational purchases'],
bucket: 'next',
source: { kind: 'media', label: item.title, url: item.link || '' },
});
const { taskChipHtml, bindTaskChips } = await import('./tasks.js');
bindTaskChips();
return `Added ${taskChipHtml(task)} to your shopping list.`;
}
if (route.type === 'download') {
// Goes to Radarr or Sonarr via the home agent. The profile NAME
// travels, never the quality rules themselves -- those live in the
// *arr, which is the only place they should be written.
const agent = await import('../homeagent.js');
const tmdb = (item.externalIds.tmdb || '').split('/');
const result = await agent.run('arr.add', {
kind: item.kind,
title: item.title,
profile: route.profile || '',
tmdbId: tmdb[0] === 'movie' || tmdb[0] === 'tv' ? Number(tmdb[1]) : undefined,
}, { timeoutMs: 180000 });
if (result.added) {
item.acquisition = { state: 'requested', client: result.service, id: result.id || '', checkedAt: new Date().toISOString() };
item.status = 'available';
queueSave();
renderMedia();
return `${result.service === 'sonarr' ? 'Sonarr' : 'Radarr'} is looking for "${escapeHtml(result.title || item.title)}".`;
}
if (result.already) {
item.acquisition = { state: 'have', client: 'library', id: '', checkedAt: new Date().toISOString() };
queueSave();
renderMedia();
return 'Already in the library.';
}
return result.reason || "That couldn't be added.";
}
return 'Unknown route.';
}

function showRoutes(item) {
const host = document.getElementById('media-candidates');
if (!host) return;
const routes = routesFor(item);
if (!routes.length) {
setCaptureStatus(`No routes set for ${KIND_LABEL[item.kind] || item.kind} — add some in Settings.`);
return;
}
host.innerHTML = `<div class="alloc-card">
<div class="alloc-title">How do you want "${escapeHtml(item.title)}"?</div>
${routes.map((r) => `<div class="mail-row" data-route-run="${escapeHtml(r.id)}" style="cursor:pointer;">
<span class="mail-subject">${escapeHtml(r.label)}</span>
${r.type === 'download' && r.profile ? `<span class="settings-note" style="margin:0;">profile: ${escapeHtml(r.profile)}</span>` : ''}
</div>`).join('')}
<div class="alloc-controls">
<span class="sync-status" data-route-status></span>
<button class="del-x" type="button" data-route-cancel>Close</button>
</div>
</div>`;
const status = host.querySelector('[data-route-status]');
host.querySelectorAll('[data-route-run]').forEach((row) => {
row.addEventListener('click', async () => {
const route = routes.find((r) => r.id === row.dataset.routeRun);
if (!route) return;
try {
const message = await runRoute(item, route);
if (status) status.innerHTML = message;
} catch (err) {
console.error('Route failed:', err);
if (status) status.textContent = `That didn't work: ${err.message || err}`;
}
});
});
host.querySelector('[data-route-cancel]').addEventListener('click', () => { host.innerHTML = ''; });
}

function setCaptureStatus(text) {
const el = document.getElementById('media-capture-status');
if (el) el.textContent = text || '';
}

// The disambiguation step. Deliberately a list of real covers rather than
// a dropdown of strings: telling two films called Gladiator apart is
// exactly what the poster and the year are for.
function showCandidates(typed, kind, candidates) {
const host = document.getElementById('media-candidates');
if (!host) return;
setCaptureStatus(`Which "${typed}"?`);
host.innerHTML = `<div class="alloc-card">
${candidates.map((c, i) => `<div class="mail-row" data-media-pick="${i}" style="cursor:pointer;">
${c.imageUrl ? `<img class="media-art" src="${escapeHtml(c.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
<span class="task-context">${escapeHtml(KIND_LABEL[c.kind] || c.kind)}</span>
<span class="mail-subject">${escapeHtml(c.title)}${c.year ? ` (${escapeHtml(c.year)})` : ''}</span>
${c.creator ? `<span class="settings-note" style="margin:0;">${escapeHtml(c.creator)}</span>` : ''}
</div>`).join('')}
<div class="alloc-controls">
<button class="todo-add-btn" type="button" data-media-pick-none>None of these — add "${escapeHtml(typed)}" as typed</button>
<button class="del-x" type="button" data-media-pick-cancel>Cancel</button>
</div>
</div>`;
host.querySelectorAll('img.media-art').forEach((img) => {
img.addEventListener('error', () => { img.style.display = 'none'; });
});
const close = () => { host.innerHTML = ''; setCaptureStatus(''); };
host.querySelectorAll('[data-media-pick]').forEach((row) => {
row.addEventListener('click', () => {
const c = candidates[Number(row.dataset.mediaPick)];
addMediaItem({ kind: c.kind, title: c.title, creator: c.creator, year: c.year, link: c.link, externalIds: c.externalIds, imageUrl: c.imageUrl });
const input = document.getElementById('media-capture-input');
if (input) input.value = '';
close();
});
});
host.querySelector('[data-media-pick-none]').addEventListener('click', () => {
addMediaItem({ kind, title: typed });
const input = document.getElementById('media-capture-input');
if (input) input.value = '';
close();
});
host.querySelector('[data-media-pick-cancel]').addEventListener('click', close);
}

function renderKindFilter() {
const el = document.getElementById('media-filter');
if (!el) return;
const counts = {};
data.mediaItems.forEach((m) => {
if (!showFinished && !OPEN_STATUSES.includes(m.status)) return;
counts[m.kind] = (counts[m.kind] || 0) + 1;
});
const chip = (value, label, count) => `<button class="overview-chip${kindFilter === value ? ' active' : ''}" data-media-kind="${escapeHtml(value)}">${escapeHtml(label)}${count === undefined ? '' : ` (${count})`}</button>`;
el.innerHTML = chip('all', 'All')
+ MEDIA_KINDS.filter((k) => counts[k.kind]).map((k) => chip(k.kind, k.label, counts[k.kind])).join('')
+ `<button class="overview-chip${showFinished ? ' active' : ''}" data-media-finished="1">Show ${escapeHtml(STATUS_LABEL.done.toLowerCase())}/dropped</button>`;
el.querySelectorAll('[data-media-kind]').forEach((b) => {
b.addEventListener('click', () => { kindFilter = b.dataset.mediaKind; renderMedia(); });
});
el.querySelectorAll('[data-media-finished]').forEach((b) => {
b.addEventListener('click', () => { showFinished = !showFinished; renderMedia(); });
});
}

function initMedia() {
bindMediaChips();
const plexBtn = document.getElementById('media-plex-check-btn');
if (plexBtn) {
plexBtn.addEventListener('click', async () => {
plexBtn.disabled = true;
try { await checkAgainstPlex(); } finally { plexBtn.disabled = false; }
});
}
const tvdbBtn = document.getElementById('media-tvdb-btn');
if (tvdbBtn) {
tvdbBtn.addEventListener('click', async () => {
tvdbBtn.disabled = true;
try { await backfillTvdbIds(); } finally { tvdbBtn.disabled = false; }
});
}
const input = document.getElementById('media-capture-input');
const kindSelect = document.getElementById('media-capture-kind');
const addBtn = document.getElementById('media-capture-btn');
const resolveBtn = document.getElementById('media-resolve-btn');
if (!input || !addBtn) return;
kindSelect.innerHTML = MEDIA_KINDS.map((k) => `<option value="${k.kind}">${escapeHtml(k.label)}</option>`).join('');

// A typed title is ambiguous in a way a link isn't -- "Gladiator" is two
// films, a series, a soundtrack and a novel -- so it goes to the
// catalogue first and you pick which one you meant. Picking is what
// supplies the poster, the year and the id; without it the row is a bare
// string nothing can match against Plex later. A URL skips all this
// (it already identifies one work), and so does a failed or empty
// search: the item is still created exactly as typed.
const submit = async () => {
const title = input.value.trim();
if (!title) return;
if (looksLikeUrl(title)) {
addMediaItem({ kind: kindSelect.value, title, link: title });
input.value = '';
resolveBtn.hidden = true;
return;
}
const kind = kindSelect.value;
setCaptureStatus('Looking up…');
let candidates = [];
// Tracked as a flag rather than by reading the status text back: the
// "Looking up…" already sitting there is itself truthy, which silently
// swallowed the explanation of why nothing was found.
let lookupFailed = false;
try {
const { searchTitle } = await import('../catalogue.js');
candidates = await searchTitle(kind, title);
} catch (err) {
console.error('Title lookup failed, adding it as typed:', err);
lookupFailed = true;
setCaptureStatus(err.message || String(err));
}
if (!candidates.length) {
addMediaItem({ kind, title });
input.value = '';
if (!lookupFailed) {
const needsKey = kind === 'film' || kind === 'tv' || kind === 'other';
setCaptureStatus(needsKey
? 'Added as typed. A TMDb key in Settings finds the poster, year and id.'
: 'Added as typed — nothing matched that title.');
}
return;
}
showCandidates(title, kind, candidates);
};
addBtn.addEventListener('click', submit);
input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

// Identical to the Resolve-title control on Tasks/Shopping: free URL
// detection on every keystroke, an AI call only on a deliberate tap.
input.addEventListener('input', () => { resolveBtn.hidden = !looksLikeUrl(input.value); });
resolveBtn.addEventListener('click', async () => {
const url = input.value.trim();
if (!looksLikeUrl(url)) return;
resolveBtn.disabled = true;
resolveBtn.textContent = 'Looking…';
try {
const { resolveUrlTitle } = await import('../ai.js');
const title = await resolveUrlTitle(url);
if (title) {
input.value = title;
kindSelect.value = kindFromUrl(url);
addMediaItem({ kind: kindSelect.value, title, link: url });
input.value = '';
}
} catch (err) {
console.error("Couldn't resolve that link:", err);
input.value = url;
} finally {
resolveBtn.disabled = false;
resolveBtn.textContent = '✨ Resolve title';
resolveBtn.hidden = !looksLikeUrl(input.value);
}
});
renderMedia();
}

export { initMedia, renderMedia, addMediaItem, mediaChipHtml, bindMediaChips, revealMediaItem, kindFromUrl, unambiguousMatch, showPlexConfirmations, reconcileMonitors };
