// A batch of files captured together -- mainly via Android's share sheet
// (see sharetarget.js, which routes any share carrying files here instead
// of onto a Task), or the in-app "+ Capture files" picker for desktop/iOS
// parity -- waiting to be triaged into wherever it actually belongs: a
// Dating connection's photos, a Task's attachments, or (once one exists)
// a Health import. Not image-only: whatever the share sheet hands over
// (CSV, PDF, plain text...) lands here too, just without a thumbnail.
//
// A batch disappears from data.captureInbox once every item in it has
// been routed or discarded -- see captureItemKind() below for the one
// seam a future deterministic router (e.g. a recognised Health CSV shape)
// would hook into, ahead of the generic per-item triage buttons.
import { data, queueSave, blankCaptureBatch } from '../state.js';
import { photoDelete } from '../db.js';
import { todayStr, escapeHtml, hydratePhotoBackgrounds, resizeImageToBlob } from '../utils.js';
import { storePhoto, uploadAttachment, deleteAttachment, fetchAttachment, openAttachment, formatBytes } from '../files.js';

function captureItemKind(file) {
return (file.type || '').startsWith('image/') ? 'photo' : 'attachment';
}

// The one place a batch of raw files becomes an inbox entry. Saves after
// each item lands (not once at the end) so an interrupted multi-file
// capture keeps whatever already succeeded -- same reasoning tasks.js's
// own attach-a-file handler saves per file rather than once per batch.
async function addCaptureBatch({ label, notes = '', source = null, files }) {
const batch = blankCaptureBatch({ label, notes, source });
const failed = [];
for (const file of files) {
try {
if (captureItemKind(file) === 'photo') {
const blob = await resizeImageToBlob(file, 1200, 0.85);
const id = await storePhoto(blob);
batch.items.push({ id, name: file.name || 'photo', type: file.type || blob.type, size: blob.size, kind: 'photo' });
} else {
const meta = await uploadAttachment(file);
batch.items.push({ ...meta, kind: 'attachment' });
}
if (!data.captureInbox.includes(batch)) data.captureInbox.push(batch);
queueSave();
} catch (err) {
console.error('Could not capture a shared file:', err);
failed.push(`${file.name || 'file'}: ${err.message || err}`);
}
}
renderCaptureInbox();
return { batch, failed };
}

function removeBatchIfEmpty(batch) {
if (!batch.items.length) data.captureInbox = data.captureInbox.filter((b) => b.id !== batch.id);
}

// Best-effort delete of both copies -- server (if any) then the local
// IndexedDB cache -- exactly the precedent already in tasks.js's own
// task-delete and attach-remove handlers: a stray orphaned file is the
// accepted lesser problem, not something worth blocking triage on.
async function deleteItemBytes(item) {
try { await deleteAttachment(item.id); } catch (err) { /* not on the server, or already gone */ }
try { await photoDelete(item.id); } catch (err) { /* local cache miss */ }
}

function batchCardHtml(b) {
const photoItems = b.items.filter((it) => it.kind === 'photo');
const fileItems = b.items.filter((it) => it.kind !== 'photo');
const sourceLabel = b.source?.kind === 'share' ? (b.source.label || 'Shared from another app') : 'Picked in-app';
return `<div class="alloc-card" data-inbox-batch="${b.id}">
<div class="alloc-title">${escapeHtml(b.label || 'Captured batch')}</div>
${b.notes ? `<div class="alloc-notes">${escapeHtml(b.notes)}</div>` : ''}
<div class="task-source">from ${escapeHtml(sourceLabel)} · ${photoItems.length} photo${photoItems.length === 1 ? '' : 's'}${fileItems.length ? `, ${fileItems.length} file${fileItems.length === 1 ? '' : 's'}` : ''}</div>
${photoItems.length ? `<div class="task-photos">${photoItems.map((it) => `<div class="gallery-thumb"><span class="thumb-img" data-photo-bg="${escapeHtml(it.id)}"></span></div>`).join('')}</div>` : ''}
${fileItems.map((it) => `<div class="attach-row">
<button class="attach-name" type="button" data-inbox-item-open="${b.id}" data-inbox-item-id="${escapeHtml(it.id)}" title="Download ${escapeHtml(it.name || 'file')}">${escapeHtml(it.name || 'file')}</button>
<span class="attach-size">${escapeHtml(formatBytes(it.size))}</span>
</div>`).join('')}
<div class="alloc-controls">
<button class="todo-add-btn" type="button" data-inbox-attach-task="${b.id}">Attach to a Task</button>
${photoItems.length ? `<select data-inbox-dating-select="${b.id}"><option value="">Send photos to&hellip;</option></select>
<button class="todo-add-btn" type="button" data-inbox-send-dating="${b.id}">Send</button>` : ''}
<button class="del-x" type="button" data-inbox-discard="${b.id}">Discard</button>
</div>
<span class="sync-status" data-inbox-status="${b.id}"></span>
</div>`;
}

function renderCaptureInbox() {
const el = document.getElementById('capture-inbox-list');
if (!el) return;
const countEl = document.getElementById('capture-inbox-count');
if (countEl) countEl.textContent = data.captureInbox.length ? `${data.captureInbox.length} to triage` : '';
el.innerHTML = data.captureInbox.length
? data.captureInbox.map(batchCardHtml).join('')
: '<div class="empty">Nothing captured. Share files from your phone, or use "+ Capture files" below.</div>';
hydratePhotoBackgrounds(el);
// The connection picker's option list needs the live Dating module, kept
// as a dynamic import so this module never has to load connections.js
// (and everything it pulls in) up front for a panel most sessions won't
// touch.
if (data.captureInbox.some((b) => b.items.some((it) => it.kind === 'photo'))) {
import('./connections.js').then(({ connectionOptionsHtml }) => {
el.querySelectorAll('[data-inbox-dating-select]').forEach((sel) => {
const previous = sel.value;
sel.innerHTML = '<option value="">Send photos to&hellip;</option>' + connectionOptionsHtml();
if ([...sel.options].some((o) => o.value === previous)) sel.value = previous;
});
});
}
bindCaptureInbox(el);
}

function bindCaptureInbox(root) {
root.querySelectorAll('[data-inbox-item-open]').forEach((btn) => {
btn.addEventListener('click', async () => {
const batch = data.captureInbox.find((b) => b.id === btn.dataset.inboxItemOpen);
const item = batch?.items.find((it) => it.id === btn.dataset.inboxItemId);
if (!item) return;
openAttachment(item).catch((err) => console.error("Couldn't open that file:", err));
});
});

root.querySelectorAll('[data-inbox-attach-task]').forEach((btn) => {
btn.addEventListener('click', async () => {
const batch = data.captureInbox.find((b) => b.id === btn.dataset.inboxAttachTask);
if (!batch) return;
const { captureTask, renderTasks } = await import('./tasks.js');
const task = captureTask({ title: batch.label, notes: batch.notes, source: batch.source });
task.attachments.push(...batch.items.map(({ id, name, type, size }) => ({ id, name, type, size })));
data.captureInbox = data.captureInbox.filter((b) => b.id !== batch.id);
renderTasks();
renderCaptureInbox();
queueSave();
});
});

root.querySelectorAll('[data-inbox-send-dating]').forEach((btn) => {
btn.addEventListener('click', async () => {
const batch = data.captureInbox.find((b) => b.id === btn.dataset.inboxSendDating);
if (!batch) return;
const status = root.querySelector(`[data-inbox-status="${batch.id}"]`);
const sel = root.querySelector(`[data-inbox-dating-select="${batch.id}"]`);
const connId = sel?.value;
if (!connId) { if (status) status.textContent = 'Pick a connection first.'; return; }
const photoItems = batch.items.filter((it) => it.kind === 'photo');
if (status) status.textContent = `Reading ${photoItems.length} photo${photoItems.length === 1 ? '' : 's'}…`;
try {
const files = await Promise.all(photoItems.map(async (it) => {
const blob = await fetchAttachment(it.id);
return new File([blob], it.name || 'photo', { type: it.type || blob.type });
}));
const { applyDirectProfileUpload } = await import('./connections.js');
await applyDirectProfileUpload(files, connId, { onStatus: (msg) => { if (status) status.textContent = msg; } });
// Only the photo items were sent -- a CSV or other file left in the
// same batch stays behind for separate triage.
for (const it of photoItems) await deleteItemBytes(it);
batch.items = batch.items.filter((it) => it.kind !== 'photo');
removeBatchIfEmpty(batch);
renderCaptureInbox();
queueSave();
} catch (err) {
console.error('Send to Dating failed:', err);
if (status) status.textContent = `Couldn't send that: ${err.message || err}`;
}
});
});

root.querySelectorAll('[data-inbox-discard]').forEach((btn) => {
btn.addEventListener('click', async () => {
const batch = data.captureInbox.find((b) => b.id === btn.dataset.inboxDiscard);
if (!batch) return;
if (!confirm(`Discard "${batch.label || 'this batch'}"? This deletes ${batch.items.length} file${batch.items.length === 1 ? '' : 's'} for good.`)) return;
for (const it of batch.items) await deleteItemBytes(it);
data.captureInbox = data.captureInbox.filter((b) => b.id !== batch.id);
renderCaptureInbox();
queueSave();
});
});
}

function initCaptureInbox() {
const input = document.getElementById('capture-inbox-file-input');
if (input) {
input.addEventListener('change', async (e) => {
const files = Array.from(e.target.files);
e.target.value = '';
if (!files.length) return;
await addCaptureBatch({
label: files.length === 1 ? files[0].name : `${files.length} files captured ${todayStr()}`,
source: { kind: 'manual', label: 'Picked in-app' },
files,
});
});
}
}

function revealCaptureBatch(id) {
renderCaptureInbox();
setTimeout(() => {
const el = document.querySelector(`[data-inbox-batch="${id}"]`);
if (el) {
el.scrollIntoView({ behavior: 'smooth', block: 'center' });
el.classList.add('flash-new');
setTimeout(() => el.classList.remove('flash-new'), 1800);
}
}, 60);
}

export { renderCaptureInbox, initCaptureInbox, addCaptureBatch, revealCaptureBatch };
