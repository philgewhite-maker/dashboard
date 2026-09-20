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
import { escapeHtml, affiliateLink, scrollAndFlash, hydratePhotoBackgrounds, looksLikeUrl } from '../utils.js';
import { identifyUrl, catalogueLabel, artworkUrl, watchProviders, subscriptionFor } from '../catalogue.js';

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

async function fillArtwork(item) {
try {
const url = await artworkUrl(item.link, item.externalIds);
if (!url) return;
const live = data.mediaItems.find((m) => m.id === item.id);
if (!live) return; // removed while the lookup was in flight
live.imageUrl = url;
queueSave();
renderMedia();
} catch (err) {
console.error('Artwork lookup failed, item stays without a poster:', err);
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
if (!chip) return;
const { switchTab } = await import('../tabs.js');
switchTab('media');
revealMediaItem(chip.dataset.openMedia);
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

function rowHtml(item) {
const photoId = (item.photoIds || [])[0];
const byline = [item.creator, item.year].filter(Boolean).join(' · ');
const catalogue = catalogueLabel(item.externalIds);
// Poster first when there is one -- a shelf of covers is the point of
// this list. A captured screenshot is the fallback picture, and a
// broken remote image hides itself rather than leaving a torn icon.
const art = item.imageUrl
? `<img class="media-art" src="${escapeHtml(item.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
: (photoId ? `<span class="thumb-img media-art" data-photo-bg="${escapeHtml(photoId)}"></span>` : '');
return `<div class="mail-row${OPEN_STATUSES.includes(item.status) ? '' : ' done'}" data-media-row="${item.id}">
${art}
<span class="task-context">${escapeHtml(KIND_LABEL[item.kind] || item.kind)}</span>
${catalogue ? `<span class="task-context" title="Identified on ${escapeHtml(catalogue)} — kept so this can be matched against Plex later">${escapeHtml(catalogue)}</span>` : ''}
<span class="mail-subject">${item.link ? `<a href="${escapeHtml(affiliateLink(item.link))}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a>` : escapeHtml(item.title)}</span>
${byline ? `<span class="settings-note" style="margin:0;">${escapeHtml(byline)}</span>` : ''}
${item.requestedBy ? `<span class="settings-note" style="margin:0;">asked by ${escapeHtml(item.requestedBy)}</span>` : ''}
${whereToWatchHtml(item)}
${item.notes ? `<span class="settings-note" style="margin:0;">${escapeHtml(item.notes)}</span>` : ''}
<select class="mini" data-media-status="${item.id}">
${MEDIA_STATUSES.map((s) => `<option value="${s.status}"${s.status === item.status ? ' selected' : ''}>${escapeHtml(s.label)}</option>`).join('')}
</select>
<span class="del-x" data-media-remove="${item.id}" title="Remove">&times;</span>
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

list.querySelectorAll('[data-media-status]').forEach((sel) => {
sel.addEventListener('change', () => {
const item = data.mediaItems.find((m) => m.id === sel.dataset.mediaStatus);
if (!item) return;
item.status = sel.value;
queueSave();
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
const onSubscription = w.flatrate.map((name) => ({ name, sub: subscriptionFor(name, subs) }));
const yours = onSubscription.filter((p) => p.sub);
const others = onSubscription.filter((p) => !p.sub);
if (!onSubscription.length && !w.rent.length && !w.buy.length) {
return `<span class="settings-note" style="margin:0;">Not streaming in ${escapeHtml(w.region)}</span>`;
}
const chips = [
...yours.map((p) => `<span class="task-context" style="background:var(--sage-bg);color:var(--sage);font-weight:600;" title="You already subscribe to ${escapeHtml(p.sub.name)}">&#10003; ${escapeHtml(p.name)}</span>`),
...others.map((p) => `<span class="task-context" title="Streaming here, but not one of your subscriptions">${escapeHtml(p.name)}</span>`),
];
if (!onSubscription.length) {
const paid = [...new Set([...w.rent, ...w.buy])].slice(0, 3);
chips.push(`<span class="settings-note" style="margin:0;">rent/buy: ${escapeHtml(paid.join(', '))}</span>`);
}
return chips.join('');
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

export { initMedia, renderMedia, addMediaItem, mediaChipHtml, bindMediaChips, revealMediaItem, kindFromUrl };
