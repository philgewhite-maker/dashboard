// A batch of files captured together -- mainly via Android's share sheet
// (see sharetarget.js, which routes any share carrying files here instead
// of onto a Task), or the in-app "+ Capture files" picker for desktop/iOS
// parity -- waiting to be triaged into wherever it actually belongs: a
// Dating connection's photos, a Task's attachments, or a Health import. Not
// image-only: whatever the share sheet hands over (CSV, PDF, plain text...)
// lands here too, just without a thumbnail.
//
// A batch disappears from data.captureInbox once every item in it has been
// routed or discarded. A recognised Health CSV shape (Renpho scale export,
// so far) skips triage entirely -- see captureItemKind() below, which is the
// one seam a future deterministic shape (e.g. an HRV export, once a real
// one's been seen to check the format against) would hook into next.
import { data, queueSave, blankCaptureBatch } from '../state.js';
import { photoDelete } from '../db.js';
import { todayStr, escapeHtml, hydratePhotoBackgrounds, resizeImageToBlob } from '../utils.js';
import { storePhoto, uploadAttachment, deleteAttachment, fetchAttachment, openAttachment, formatBytes } from '../files.js';
import { looksLikeRenphoCsv, parseRenphoCsv, mergeRenphoDaily, looksLikeHrvCsv } from './renpho.js';
import { legTargetPickerHtml, bindLegTargetPicker, readLegTargetPicker, applyLegExtraction } from './travel.js';

// Sniffs by content, not by filename/MIME type -- confirmed necessary live:
// a real Renpho export shared from Android's share sheet didn't match a
// filename+MIME gate that worked fine for a file fetched directly in
// testing (Android is inconsistent about what MIME type a share carries,
// and won't always keep the original filename either). Only skipped for
// images, since that's the one case common enough to be worth the shortcut.
async function captureItemKind(file) {
if ((file.type || '').startsWith('image/')) return 'photo';
try {
const head = await file.slice(0, 300).text();
if (looksLikeRenphoCsv(head)) return 'renpho-csv';
if (looksLikeHrvCsv(head)) return 'hrv-csv'; // never true yet -- see renpho.js
} catch (err) { /* unreadable as text -- fall through to a plain attachment */ }
return 'attachment';
}

// A batch shared at once (a night's swiping, say) often holds more than
// one person's photos -- 5 of one, 4 of another, a full profile screenshot
// plus a few loose photos for a third. Sending is per-selection, not
// per-batch: check whichever photos belong together (a profile screenshot
// counts as a photo here too -- applyDirectProfileUpload classifies each
// file itself, so selecting a screenshot alongside its photos and sending
// them together still gets the screenshot AI-parsed and the photos
// direct-saved, same as if they'd been picked from one connection's own
// upload button). Keyed by batch id, cleared once that batch is gone or a
// send clears it back to empty -- never persisted, this is just in-page
// triage state.
const selectedItems = new Map(); // batchId -> Set<itemId>

// photoItems is only needed the FIRST time a batch's selection is touched --
// every later call (checkbox toggles, select-all, discard) just wants the
// already-initialized Set, so it's optional and ignored once one exists.
function selectionFor(batchId, photoItems) {
if (!selectedItems.has(batchId)) {
const initial = new Set();
// A single photo needs no "which ones belong together" judgement call --
// default it selected so Send/Extract work with zero taps.
if (photoItems && photoItems.length === 1) initial.add(photoItems[0].id);
selectedItems.set(batchId, initial);
}
return selectedItems.get(batchId);
}

// The one place a batch of raw files becomes an inbox entry. Saves after
// each item lands (not once at the end) so an interrupted multi-file
// capture keeps whatever already succeeded -- same reasoning tasks.js's
// own attach-a-file handler saves per file rather than once per batch. A
// recognised Health CSV is consumed straight into its own store and never
// becomes a batch item at all -- there's nothing to triage, the data's
// already where it belongs.
async function addCaptureBatch({ label, notes = '', source = null, files }) {
const batch = blankCaptureBatch({ label, notes, source });
const failed = [];
const healthImports = [];
for (const file of files) {
try {
const kind = await captureItemKind(file);
if (kind === 'renpho-csv') {
const text = await file.text();
const rows = parseRenphoCsv(text);
const days = mergeRenphoDaily(rows);
healthImports.push(`${file.name || 'Renpho export'}: ${days} day${days === 1 ? '' : 's'} of scale readings imported.`);
queueSave();
continue;
}
if (kind === 'photo') {
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
if (healthImports.length) {
const { renderRenphoDaily } = await import('./renpho.js');
renderRenphoDaily();
}
return { batch, failed, healthImports };
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
const selected = selectionFor(b.id, photoItems);
const selectedCount = photoItems.filter((it) => selected.has(it.id)).length;
return `<div class="alloc-card" data-inbox-batch="${b.id}">
<div class="alloc-title">${escapeHtml(b.label || 'Captured batch')}</div>
${b.notes ? `<div class="alloc-notes">${escapeHtml(b.notes)}</div>` : ''}
<div class="task-source">from ${escapeHtml(sourceLabel)} · ${photoItems.length} photo${photoItems.length === 1 ? '' : 's'}${fileItems.length ? `, ${fileItems.length} file${fileItems.length === 1 ? '' : 's'}` : ''}${photoItems.length > 1 ? ' — tick who belongs together, e.g. a profile screenshot plus that person\'s loose photos, then send that group' : ''}</div>
${photoItems.length ? `<div class="task-photos">${photoItems.map((it) => `<label class="gallery-thumb${selected.has(it.id) ? ' selected' : ''}" title="Tap to select">
<input type="checkbox" class="gallery-thumb-check" data-inbox-item-check="${b.id}" data-item-id="${escapeHtml(it.id)}" ${selected.has(it.id) ? 'checked' : ''}>
<span class="thumb-img" data-photo-bg="${escapeHtml(it.id)}"></span>
<span class="tag-x" data-inbox-item-remove="${b.id}" data-item-id="${escapeHtml(it.id)}" title="Delete this photo — don't send it anywhere">&times;</span>
</label>`).join('')}</div>` : ''}
${fileItems.map((it) => `<div class="attach-row">
<button class="attach-name" type="button" data-inbox-item-open="${b.id}" data-inbox-item-id="${escapeHtml(it.id)}" title="Download ${escapeHtml(it.name || 'file')}">${escapeHtml(it.name || 'file')}</button>
<span class="attach-size">${escapeHtml(formatBytes(it.size))}</span>
<span class="tag-x" data-inbox-item-remove="${b.id}" data-item-id="${escapeHtml(it.id)}" title="Delete this file — don't send it anywhere">&times;</span>
</div>`).join('')}
<div class="alloc-controls">
${photoItems.length ? `<span class="settings-note" data-inbox-selected-count="${b.id}">${selectedCount} of ${photoItems.length} selected</span>
${photoItems.length > 1 ? `<button class="todo-add-btn" type="button" data-inbox-select-all="${b.id}">${selectedCount === photoItems.length ? 'Select none' : 'Select all'}</button>` : ''}
<select data-inbox-dating-select="${b.id}"><option value="">Send selected to&hellip;</option></select>
<button class="todo-add-btn" type="button" data-inbox-send-dating="${b.id}">Send</button>
<button class="todo-add-btn" type="button" data-inbox-extract-wellness="${b.id}" title="For an HRV, AGEs index, or Antioxidant index screenshot from Samsung Health">Extract wellness data</button>
<button class="todo-add-btn" type="button" data-inbox-extract-trip-toggle="${b.id}" title="For a boarding pass, hotel, car hire, or transfer confirmation">Extract into a trip leg</button>` : ''}
<button class="todo-add-btn" type="button" data-inbox-attach-task="${b.id}">Attach ${photoItems.length ? 'everything left ' : ''}to a Task</button>
<button class="del-x" type="button" data-inbox-discard="${b.id}">Discard</button>
</div>
${photoItems.length ? `<div class="mail-trip-picker" data-inbox-trip-picker="${b.id}" hidden>
${legTargetPickerHtml(b.id)}
<button class="todo-add-btn" type="button" data-inbox-trip-extract="${b.id}">Extract selected</button>
</div>` : ''}
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
sel.innerHTML = '<option value="">Send selected to&hellip;</option>' + connectionOptionsHtml();
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
selectedItems.delete(batch.id);
renderTasks();
renderCaptureInbox();
queueSave();
});
});

// A checkbox toggle only updates the selection Set and the visible count
// -- not a full renderCaptureInbox(), which would re-hydrate every
// thumbnail in the batch for one click.
root.querySelectorAll('[data-inbox-item-check]').forEach((cb) => {
cb.addEventListener('change', () => {
const batchId = cb.dataset.inboxItemCheck;
const itemId = cb.dataset.itemId;
const sel = selectionFor(batchId);
if (cb.checked) sel.add(itemId); else sel.delete(itemId);
cb.closest('.gallery-thumb')?.classList.toggle('selected', cb.checked);
const batch = data.captureInbox.find((b) => b.id === batchId);
const photoCount = batch ? batch.items.filter((it) => it.kind === 'photo').length : 0;
const countEl = root.querySelector(`[data-inbox-selected-count="${batchId}"]`);
if (countEl) countEl.textContent = `${sel.size} of ${photoCount} selected`;
const allBtn = root.querySelector(`[data-inbox-select-all="${batchId}"]`);
if (allBtn) allBtn.textContent = sel.size === photoCount ? 'Select none' : 'Select all';
});
});

root.querySelectorAll('[data-inbox-select-all]').forEach((btn) => {
btn.addEventListener('click', () => {
const batch = data.captureInbox.find((b) => b.id === btn.dataset.inboxSelectAll);
if (!batch) return;
const photoIds = batch.items.filter((it) => it.kind === 'photo').map((it) => it.id);
const sel = selectionFor(batch.id);
if (sel.size === photoIds.length) sel.clear(); else photoIds.forEach((id) => sel.add(id));
renderCaptureInbox();
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
const selectedIds = selectionFor(batch.id);
const chosen = batch.items.filter((it) => it.kind === 'photo' && selectedIds.has(it.id));
if (!chosen.length) { if (status) status.textContent = 'Tick at least one photo first.'; return; }
if (status) status.textContent = `Reading ${chosen.length} photo${chosen.length === 1 ? '' : 's'}…`;
try {
const files = await Promise.all(chosen.map(async (it) => {
const blob = await fetchAttachment(it.id);
return new File([blob], it.name || 'photo', { type: it.type || blob.type });
}));
const { applyDirectProfileUpload } = await import('./connections.js');
await applyDirectProfileUpload(files, connId, { onStatus: (msg) => { if (status) status.textContent = msg; } });
// Only the ticked items were sent -- anything left unticked (someone
// else's photos, a CSV, etc.) stays behind for separate triage.
for (const it of chosen) { await deleteItemBytes(it); selectedIds.delete(it.id); }
const chosenIds = new Set(chosen.map((it) => it.id));
batch.items = batch.items.filter((it) => !chosenIds.has(it.id));
removeBatchIfEmpty(batch);
renderCaptureInbox();
queueSave();
} catch (err) {
console.error('Send to Dating failed:', err);
if (status) status.textContent = `Couldn't send that: ${err.message || err}`;
}
});
});

// A single item you don't want to send anywhere -- e.g. one stray photo
// in an otherwise-useful batch. Photos delete with one click (they're
// local-only until sent, same as a task's own photo removal); files
// confirm first since uploadAttachment already put them on the server,
// same as a task's own attachment removal.
root.querySelectorAll('[data-inbox-item-remove]').forEach((x) => {
x.addEventListener('click', async (e) => {
e.preventDefault();
const batch = data.captureInbox.find((b) => b.id === x.dataset.inboxItemRemove);
const item = batch?.items.find((it) => it.id === x.dataset.itemId);
if (!batch || !item) return;
if (item.kind !== 'photo' && !confirm(`Delete "${item.name || 'this file'}"? This deletes it from the server for every device.`)) return;
await deleteItemBytes(item);
batch.items = batch.items.filter((it) => it.id !== item.id);
selectionFor(batch.id).delete(item.id);
removeBatchIfEmpty(batch);
renderCaptureInbox();
queueSave();
});
});

// Unlike Send-to-Dating, this reads straight from the local photo blob --
// no server round-trip needed for a vision call. A vision read is a guess,
// not a certainty (unlike the Renpho CSV's deterministic parse), so this
// stays a manual per-selection action rather than something that fires the
// moment a matching image lands in the batch.
root.querySelectorAll('[data-inbox-extract-wellness]').forEach((btn) => {
btn.addEventListener('click', async () => {
const batch = data.captureInbox.find((b) => b.id === btn.dataset.inboxExtractWellness);
if (!batch) return;
const status = root.querySelector(`[data-inbox-status="${batch.id}"]`);
const selectedIds = selectionFor(batch.id);
const chosen = batch.items.filter((it) => it.kind === 'photo' && selectedIds.has(it.id));
if (!chosen.length) { if (status) status.textContent = 'Tick at least one photo first.'; return; }
const { extractAndMergeWellnessFile } = await import('./wellness.js');
const done = [];
const messages = [];
for (const it of chosen) {
if (status) status.textContent = `Reading ${it.name || 'photo'}…`;
try {
const blob = await fetchAttachment(it.id);
const file = new File([blob], it.name || 'photo', { type: it.type || blob.type });
const { ok, message } = await extractAndMergeWellnessFile(file);
messages.push(message);
if (ok) done.push(it);
} catch (err) {
console.error('Wellness extraction failed:', err);
messages.push(err?.name === 'MissingKeyError' ? 'Add an Anthropic API key in Settings to extract wellness data.' : `${it.name || 'that image'}: ${err.message || err}`);
}
}
for (const it of done) { await deleteItemBytes(it); selectedIds.delete(it.id); }
const doneIds = new Set(done.map((it) => it.id));
batch.items = batch.items.filter((it) => !doneIds.has(it.id));
removeBatchIfEmpty(batch);
if (status) status.textContent = messages.join(' ');
renderCaptureInbox();
if (done.length) {
const { renderWellnessDaily } = await import('./wellness.js');
renderWellnessDaily();
}
queueSave();
});
});

root.querySelectorAll('[data-inbox-extract-trip-toggle]').forEach((btn) => {
btn.addEventListener('click', () => {
const batchId = btn.dataset.inboxExtractTripToggle;
const picker = root.querySelector(`[data-inbox-trip-picker="${batchId}"]`);
if (!picker) return;
picker.hidden = !picker.hidden;
if (!picker.hidden) bindLegTargetPicker(picker, batchId);
});
});

// Each selected screenshot becomes its OWN leg on the picked trip (a boarding
// pass and a hotel confirmation ticked together are two different legs, not
// one) -- only the trip target and a starting kind guess are shared from the
// picker; each extraction can still reclassify its own leg's kind.
root.querySelectorAll('[data-inbox-trip-extract]').forEach((btn) => {
btn.addEventListener('click', async () => {
const batch = data.captureInbox.find((b) => b.id === btn.dataset.inboxTripExtract);
if (!batch) return;
const status = root.querySelector(`[data-inbox-status="${batch.id}"]`);
const picker = root.querySelector(`[data-inbox-trip-picker="${batch.id}"]`);
const selectedIds = selectionFor(batch.id);
const chosen = batch.items.filter((it) => it.kind === 'photo' && selectedIds.has(it.id));
if (!chosen.length) { if (status) status.textContent = 'Tick at least one photo first.'; return; }
if (!picker) return;
const picked = readLegTargetPicker(picker, batch.id);
const { extractTripScreenshot } = await import('../ai.js');
const done = [];
const messages = [];
let sharedTripId = picked.tripId;
for (const it of chosen) {
if (status) status.textContent = `Reading ${it.name || 'photo'}…`;
try {
const blob = await fetchAttachment(it.id);
const file = new File([blob], it.name || 'photo', { type: it.type || blob.type });
const extraction = await extractTripScreenshot(file);
if (!extraction.kind && Object.keys(extraction.fields).length === 0) {
messages.push(`${it.name || 'that image'}: didn't look like travel logistics.`);
continue;
}
const { trip, leg, filled } = await applyLegExtraction({ ...picked, tripId: sharedTripId, extraction, source: { kind: 'screenshot', label: it.name || '', url: '' } });
sharedTripId = trip.id; // once a "+ New trip" is created, later items in this batch join the same trip
messages.push(`${it.name || 'that image'}: added ${filled} field${filled === 1 ? '' : 's'} to "${trip.title}" — ${leg.kind}.`);
done.push(it);
} catch (err) {
console.error('Trip screenshot extraction failed:', err);
messages.push(err?.name === 'MissingKeyError' ? 'Add an Anthropic API key in Settings to extract trip details.' : `${it.name || 'that image'}: ${err.message || err}`);
}
}
for (const it of done) { await deleteItemBytes(it); selectedIds.delete(it.id); }
const doneIds = new Set(done.map((it) => it.id));
batch.items = batch.items.filter((it) => !doneIds.has(it.id));
removeBatchIfEmpty(batch);
if (status) status.textContent = messages.join(' ');
renderCaptureInbox();
queueSave();
});
});

root.querySelectorAll('[data-inbox-discard]').forEach((btn) => {
btn.addEventListener('click', async () => {
const batch = data.captureInbox.find((b) => b.id === btn.dataset.inboxDiscard);
if (!batch) return;
if (!confirm(`Discard "${batch.label || 'this batch'}"? This deletes ${batch.items.length} file${batch.items.length === 1 ? '' : 's'} for good.`)) return;
for (const it of batch.items) await deleteItemBytes(it);
data.captureInbox = data.captureInbox.filter((b) => b.id !== batch.id);
selectedItems.delete(batch.id);
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
const status = document.getElementById('capture-inbox-status');
const { healthImports } = await addCaptureBatch({
label: files.length === 1 ? files[0].name : `${files.length} files captured ${todayStr()}`,
source: { kind: 'manual', label: 'Picked in-app' },
files,
});
if (status) status.textContent = healthImports.join(' ');
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
