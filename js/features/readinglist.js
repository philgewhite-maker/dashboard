// A "read this later" queue -- the destination for the 'reading' capture
// outcome (see captureOutcomes.js). Deliberately lighter than a Task:
// title + link + an unread flag, no bucket/due/context. The unread flag
// IS the review queue, same as an unrouted Capture Inbox item already is.
import { data, queueSave, blankReadingItem } from '../state.js';
import { escapeHtml, affiliateLink, scrollAndFlash, hydratePhotoBackgrounds, looksLikeUrl, prettyUrl } from '../utils.js';
import { identifyUrl, linkMetadata } from '../catalogue.js';

// The row currently open for editing, and what has been typed into it so
// far (a cover or title lookup landing mid-edit redraws the list).
let editingId = '';
let editDraft = null;
// A link whose title is still the URL gets one lookup per session, so a
// page that can't be read isn't re-fetched on every render.
const enrichAttempted = new Set();

// The canonical way a reading-list item appears anywhere OTHER than its
// own list (dashboard/CLAUDE.md's record-reference standard): click leads
// to the real row, scrolled and flashed. Same shape as mediaChipHtml.
function readingChipHtml(item, extraHtml = '') {
return `<span class="task-chip" data-open-reading="${escapeHtml(item.id)}">&#128214; ${escapeHtml(looksLikeUrl(item.title) ? prettyUrl(item.title, 50) : item.title)}</span>${extraHtml}`;
}

let readingChipsBound = false;
function bindReadingChips() {
if (readingChipsBound) return;
readingChipsBound = true;
document.addEventListener('click', async (e) => {
const chip = e.target.closest('[data-open-reading]');
if (!chip) return;
const { switchTab } = await import('../tabs.js');
switchTab('media');
revealReadingItem(chip.dataset.openReading);
});
}

// Called by captureOutcomes.js's 'reading' outcome -- the one place a
// new item is ever created, so every entry point (an image marker, a
// #R link, the add box on the panel, and anything added to
// CAPTURE_OUTCOMES later) goes through the same shape.
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
if (link) fillMetadata(item);
return item;
}

// Cover and real title for a link, from the same lookup the media list
// uses. A title is only ever replaced while it is still the raw URL:
// anything typed or edited stays.
async function fillMetadata(item) {
try {
const meta = await linkMetadata(item.url, item.externalIds || {});
const live = data.readingList.find((r) => r.id === item.id);
if (!live || !meta) return;
if (meta.imageUrl && !live.imageUrl) live.imageUrl = meta.imageUrl;
if (meta.title && looksLikeUrl(live.title)) live.title = meta.title;
queueSave();
renderReadingList();
} catch (err) {
console.error('Cover/title lookup failed, item stays as it was:', err);
}
}

function enrichPending() {
data.readingList
.filter((r) => r.url && (looksLikeUrl(r.title) || !r.imageUrl) && !enrichAttempted.has(r.id))
.slice(0, 3)
.forEach((r) => { enrichAttempted.add(r.id); fillMetadata(r); });
}

function editRowHtml(src) {
const item = editDraft && editDraft.id === src.id ? { ...src, ...editDraft } : src;
return `<div class="mail-row" data-reading-row="${item.id}" data-reading-editing="${item.id}" style="align-items:flex-start;flex-wrap:wrap;">
<input type="text" autocomplete="off" class="voucher-edit" data-reading-edit-field="title" value="${escapeHtml(item.title)}" placeholder="Title" style="flex:2 1 220px;min-width:0;">
<input type="text" autocomplete="off" class="voucher-edit" data-reading-edit-field="url" value="${escapeHtml(item.url || '')}" placeholder="Link (optional)" style="flex:2 1 200px;min-width:0;">
<input type="text" autocomplete="off" class="voucher-edit" data-reading-edit-field="notes" value="${escapeHtml(item.notes || '')}" placeholder="Notes" style="flex:2 1 200px;min-width:0;">
<button class="mini-task-btn" type="button" data-reading-edit-save="${item.id}">Save</button>
<button class="mini-task-btn" type="button" data-reading-edit-cancel="${item.id}">Cancel</button>
</div>`;
}

function rowHtml(item) {
if (editingId === item.id) return editRowHtml(item);
// URL-based (the common case: a link marked #R) shows a title link;
// photo-based (a screenshot marked R -- there's no URL at all, the
// photo IS the content) shows a small thumbnail instead.
const photoId = (item.photoIds || [])[0];
const art = item.imageUrl
? `<img class="media-art" src="${escapeHtml(item.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
: (photoId ? `<span class="thumb-img" data-photo-bg="${escapeHtml(photoId)}" style="width:32px;height:32px;border-radius:6px;flex:0 0 auto;"></span>` : '');
const shownTitle = looksLikeUrl(item.title) ? prettyUrl(item.title, 70) : item.title;
return `<div class="mail-row${item.read ? ' done' : ''}" data-reading-row="${item.id}">
${art}
<span class="mail-subject">${item.url ? `<a href="${escapeHtml(affiliateLink(item.url))}" target="_blank" rel="noopener">${escapeHtml(shownTitle)}</a>` : escapeHtml(shownTitle)}</span>
${item.notes ? `<span class="settings-note" style="margin:0;">${escapeHtml(item.notes)}</span>` : ''}
<button class="mini-task-btn${item.read ? ' done' : ''}" type="button" data-reading-toggle="${item.id}" title="${item.read ? 'Mark unread' : 'Mark read'}">${item.read ? '✓ read' : 'Mark read'}</button>
<button class="mini-task-btn" type="button" data-reading-edit="${item.id}" title="Edit the title, link or notes">Edit</button>
<span class="del-x" data-reading-remove="${item.id}" title="Remove">&times;</span>
</div>`;
}

function renderReadingList() {
const list = document.getElementById('reading-list');
if (!list) return; // tab not in this build's DOM
if (editingId) {
const row = list.querySelector(`[data-reading-editing="${editingId}"]`);
if (row) {
const val = (f) => row.querySelector(`[data-reading-edit-field="${f}"]`)?.value || '';
editDraft = { id: editingId, title: val('title'), url: val('url'), notes: val('notes') };
}
}
const unread = data.readingList.filter((r) => !r.read).length;
const count = document.getElementById('reading-list-count');
if (count) count.textContent = data.readingList.length ? `${unread} unread of ${data.readingList.length}` : '';
if (!data.readingList.length) {
list.innerHTML = '<div class="empty">Nothing queued — add a link above, or share one with #R on the end, or mark a photo R.</div>';
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
const item = data.readingList.find((r) => r.id === x.dataset.readingRemove);
if (!item || !confirm(`Remove "${looksLikeUrl(item.title) ? prettyUrl(item.title, 50) : item.title}" from your reading list?`)) return;
data.readingList = data.readingList.filter((r) => r.id !== x.dataset.readingRemove);
queueSave();
renderReadingList();
});
});
list.querySelectorAll('[data-reading-edit]').forEach((btn) => {
btn.addEventListener('click', () => { editingId = btn.dataset.readingEdit; editDraft = null; renderReadingList(); });
});
list.querySelectorAll('[data-reading-editing]').forEach((row) => {
const id = row.dataset.readingEditing;
const cancel = () => { editingId = ''; editDraft = null; renderReadingList(); };
const save = () => {
const item = data.readingList.find((r) => r.id === id);
if (item) {
const val = (f) => (row.querySelector(`[data-reading-edit-field="${f}"]`)?.value || '').trim();
const url = val('url');
item.title = val('title') || item.title;
item.notes = val('notes');
// A changed link needs its own cover/title looked up afresh.
if (url !== (item.url || '')) {
item.url = url;
item.externalIds = url ? identifyUrl(url).ids : {};
item.imageUrl = '';
enrichAttempted.delete(item.id);
}
queueSave();
}
editingId = '';
editDraft = null;
renderReadingList();
};
row.querySelector('[data-reading-edit-save]').addEventListener('click', save);
row.querySelector('[data-reading-edit-cancel]').addEventListener('click', cancel);
row.querySelectorAll('input[data-reading-edit-field]').forEach((inp) => {
inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); });
});
});
enrichPending();
}

// Cross-tab jump target, same shape as revealTask/revealCaptureBatch --
// reached from readingChipHtml's chip.
function revealReadingItem(id) {
renderReadingList();
setTimeout(() => scrollAndFlash(`[data-reading-row="${id}"]`), 60);
}

// The add box on the panel: a link (or just a title) typed or pasted in.
function initReadingAdd() {
const input = document.getElementById('reading-add-input');
const btn = document.getElementById('reading-add-btn');
const status = document.getElementById('reading-add-status');
if (!input || !btn) return;
const say = (html) => { if (status) status.innerHTML = html || ''; };
const submit = () => {
const text = input.value.trim();
if (!text) return;
const isUrl = looksLikeUrl(text);
const existing = isUrl ? data.readingList.find((r) => r.url && r.url === text) : null;
if (existing) {
say(`Already on your list: ${readingChipHtml(existing)}.`);
return;
}
const item = addToReadingList(isUrl ? { title: text, url: text } : { title: text });
input.value = '';
say(`Added ${readingChipHtml(item)}.`);
};
btn.addEventListener('click', submit);
input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

function initReadingList() {
bindReadingChips();
initReadingAdd();
renderReadingList();
}

export { initReadingList, renderReadingList, addToReadingList, revealReadingItem, readingChipHtml, bindReadingChips };
