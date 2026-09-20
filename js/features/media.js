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

const KIND_LABEL = Object.fromEntries(MEDIA_KINDS.map((k) => [k.kind, k.label]));
const STATUS_LABEL = Object.fromEntries(MEDIA_STATUSES.map((s) => [s.status, s.label]));
// Watched and dropped are both "finished with", so the default view is
// everything still outstanding rather than a status-by-status filter.
const OPEN_STATUSES = ['wanted', 'available'];

let kindFilter = 'all';
let showFinished = false;

// Host -> kind, for a shared link. Only covers what the seeded
// shareUrlRules (state.js) actually route here; anything else lands as
// 'other' and is one tap to correct.
function kindFromUrl(url) {
let host = '';
try { host = new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return 'other'; }
if (/(^|\.)(spotify\.com|bandcamp\.com|discogs\.com)$/.test(host) || host === 'music.apple.com') return 'album';
if (/(^|\.)(imdb\.com|letterboxd\.com|themoviedb\.org|trakt\.tv|rottentomatoes\.com)$/.test(host)) return 'film';
return 'other';
}

function addMediaItem({ kind, title, creator = '', year = '', link = '', notes = '', photoIds = [], source = null, requestedBy = '', status = 'wanted' }) {
const item = blankMediaItem({
kind: KIND_LABEL[kind] ? kind : (link ? kindFromUrl(link) : 'other'),
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
return item;
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
return `<div class="mail-row${OPEN_STATUSES.includes(item.status) ? '' : ' done'}" data-media-row="${item.id}">
${photoId ? `<span class="thumb-img" data-photo-bg="${escapeHtml(photoId)}" style="width:32px;height:32px;border-radius:6px;flex:0 0 auto;"></span>` : ''}
<span class="task-context">${escapeHtml(KIND_LABEL[item.kind] || item.kind)}</span>
<span class="mail-subject">${item.link ? `<a href="${escapeHtml(affiliateLink(item.link))}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a>` : escapeHtml(item.title)}</span>
${byline ? `<span class="settings-note" style="margin:0;">${escapeHtml(byline)}</span>` : ''}
${item.requestedBy ? `<span class="settings-note" style="margin:0;">asked by ${escapeHtml(item.requestedBy)}</span>` : ''}
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

const submit = () => {
const title = input.value.trim();
if (!title) return;
// Same free fallback every other quick-add uses: a pasted URL is kept
// as the link even when it was never resolved into a real title.
addMediaItem({ kind: kindSelect.value, title, link: looksLikeUrl(title) ? title : '' });
input.value = '';
resolveBtn.hidden = true;
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
