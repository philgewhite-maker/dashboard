// A "read this later" queue -- the destination for the 'reading' capture
// outcome (see captureOutcomes.js). Deliberately lighter than a Task:
// title + link + an unread flag, no bucket/due/context. The unread flag
// IS the review queue, same as an unrouted Capture Inbox item already is.
import { data, queueSave, blankReadingItem } from '../state.js';
import { escapeHtml, affiliateLink, scrollAndFlash, hydratePhotoBackgrounds } from '../utils.js';
import { identifyUrl, artworkUrl } from '../catalogue.js';

// Called by captureOutcomes.js's 'reading' outcome -- the one place a
// new item is ever created, so every entry point (an image marker, a
// #R link suffix, and anything added to CAPTURE_OUTCOMES later) goes
// through the same shape.
function addToReadingList({ title, url, notes, photoIds, source }) {
const link = (url || '').trim();
const { ids } = identifyUrl(link);
const item = blankReadingItem({
title: (title || url || 'Untitled').trim(), url: link, notes: (notes || '').trim(),
photoIds: Array.isArray(photoIds) ? photoIds : [],
// A book link carries a real id (an Amazon ISBN, a Goodreads id);
// keeping it is what makes the cover lookup below possible at all.
externalIds: ids,
source: source || null,
});
data.readingList.unshift(item); // newest first -- same "most recent capture floats to the top" reasoning Capture Inbox uses
queueSave();
renderReadingList();
// After the item exists, never blocking it -- same reasoning as the
// media list's own artwork fetch.
if (link) fillCover(item);
return item;
}

async function fillCover(item) {
try {
const cover = await artworkUrl(item.url, item.externalIds);
if (!cover) return;
const live = data.readingList.find((r) => r.id === item.id);
if (!live) return;
live.imageUrl = cover;
queueSave();
renderReadingList();
} catch (err) {
console.error('Cover lookup failed, item stays without one:', err);
}
}

function rowHtml(item) {
// URL-based (the common case: a link marked #R) shows a title link;
// photo-based (a screenshot marked R -- there's no URL at all, the
// photo IS the content) shows a small thumbnail instead.
const photoId = (item.photoIds || [])[0];
const art = item.imageUrl
? `<img class="media-art" src="${escapeHtml(item.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
: (photoId ? `<span class="thumb-img" data-photo-bg="${escapeHtml(photoId)}" style="width:32px;height:32px;border-radius:6px;flex:0 0 auto;"></span>` : '');
return `<div class="mail-row${item.read ? ' done' : ''}" data-reading-row="${item.id}">
${art}
<span class="mail-subject">${item.url ? `<a href="${escapeHtml(affiliateLink(item.url))}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a>` : escapeHtml(item.title)}</span>
${item.notes ? `<span class="settings-note" style="margin:0;">${escapeHtml(item.notes)}</span>` : ''}
<button class="mini-task-btn${item.read ? ' done' : ''}" type="button" data-reading-toggle="${item.id}" title="${item.read ? 'Mark unread' : 'Mark read'}">${item.read ? '✓ read' : 'Mark read'}</button>
<span class="del-x" data-reading-remove="${item.id}" title="Remove">&times;</span>
</div>`;
}

function renderReadingList() {
const list = document.getElementById('reading-list');
if (!list) return; // tab not in this build's DOM
const unread = data.readingList.filter((r) => !r.read).length;
const count = document.getElementById('reading-list-count');
if (count) count.textContent = data.readingList.length ? `${unread} unread of ${data.readingList.length}` : '';
if (!data.readingList.length) {
list.innerHTML = '<div class="empty">Nothing queued — a #R link, or a photo marked R, lands here.</div>';
return;
}
list.innerHTML = data.readingList.map(rowHtml).join('');
hydratePhotoBackgrounds(list);
// A cover that 404s or gets hotlink-blocked should just vanish, not
// leave a torn-image icon -- same handler the media list uses.
list.querySelectorAll('img.media-art').forEach((img) => {
img.addEventListener('error', () => { img.style.display = 'none'; });
});
list.querySelectorAll('[data-reading-toggle]').forEach((btn) => {
btn.addEventListener('click', () => {
const item = data.readingList.find((r) => r.id === btn.dataset.readingToggle);
if (!item) return;
item.read = !item.read;
queueSave();
renderReadingList();
});
});
list.querySelectorAll('[data-reading-remove]').forEach((x) => {
x.addEventListener('click', () => {
data.readingList = data.readingList.filter((r) => r.id !== x.dataset.readingRemove);
queueSave();
renderReadingList();
});
});
}

// Cross-tab jump target, same shape as revealTask/revealCaptureBatch --
// not wired to anything yet (no chip currently links here), kept for
// parity so a future reference surface has somewhere to land.
function revealReadingItem(id) {
renderReadingList();
setTimeout(() => scrollAndFlash(`[data-reading-row="${id}"]`), 60);
}

function initReadingList() {
renderReadingList();
}

export { initReadingList, renderReadingList, addToReadingList, revealReadingItem };
