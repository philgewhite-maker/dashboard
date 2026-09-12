// A "read this later" queue -- the destination for the 'reading' capture
// outcome (see captureOutcomes.js). Deliberately lighter than a Task:
// title + link + an unread flag, no bucket/due/context. The unread flag
// IS the review queue, same as an unrouted Capture Inbox item already is.
import { data, queueSave, blankReadingItem } from '../state.js';
import { escapeHtml, scrollAndFlash, hydratePhotoBackgrounds } from '../utils.js';

// Called by captureOutcomes.js's 'reading' outcome -- the one place a
// new item is ever created, so every entry point (an image marker, a
// #R link suffix, and anything added to CAPTURE_OUTCOMES later) goes
// through the same shape.
function addToReadingList({ title, url, notes, photoIds, source }) {
const item = blankReadingItem({
title: (title || url || 'Untitled').trim(), url: (url || '').trim(), notes: (notes || '').trim(),
photoIds: Array.isArray(photoIds) ? photoIds : [],
source: source || null,
});
data.readingList.unshift(item); // newest first -- same "most recent capture floats to the top" reasoning Capture Inbox uses
queueSave();
renderReadingList();
return item;
}

function rowHtml(item) {
// URL-based (the common case: a link marked #R) shows a title link;
// photo-based (a screenshot marked R -- there's no URL at all, the
// photo IS the content) shows a small thumbnail instead.
const photoId = (item.photoIds || [])[0];
return `<div class="mail-row${item.read ? ' done' : ''}" data-reading-row="${item.id}">
${photoId ? `<span class="thumb-img" data-photo-bg="${escapeHtml(photoId)}" style="width:32px;height:32px;border-radius:6px;flex:0 0 auto;"></span>` : ''}
<span class="mail-subject">${item.url ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a>` : escapeHtml(item.title)}</span>
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
