// A batch of files captured together -- mainly via Android's share sheet
// (see sharetarget.js, which routes any share carrying files here instead
// of onto a Task), or the in-app "+ Capture files" picker for desktop/iOS
// parity -- waiting to be triaged into wherever it actually belongs: a
// Dating connection's photos, a Task's attachments, or a Health import. Not
// image-only: whatever the share sheet hands over (CSV, PDF, plain text...)
// lands here too, just without a thumbnail.
//
// A batch disappears from data.captureInbox once every item in it has been
// routed or discarded. Three recognised shapes skip triage entirely: a
// Renpho scale CSV (content-sniffed, see captureItemKind() below -- the
// seam a future deterministic CSV shape would hook into), a Samsung Health
// screenshot (filename-matched, see looksLikeSamsungHealthScreenshot() --
// an image can't be content-sniffed this cheaply, so a real AI vision call
// decides, with a safe fallback to normal triage if it doesn't recognise
// the chart), and a Bumble matches-list/full-profile screenshot shared
// ALONE (filename-matched, then classified deterministically by aspect
// ratio and cheaply by AI kind -- see autoRouteBumbleScreenshot() --
// landing in the persisted pendingImports review queue in connections.js
// rather than staying a Capture Inbox item). A Bumble screenshot shared
// alongside other photos deliberately does NOT auto-route -- see the
// comment above the Phase 2 loop in addCaptureBatch() for why -- so the
// whole group stays put for the user to tick a subset per person and use
// the manual "Extract dating screenshot" button, which can group a
// screenshot with whichever photos are ticked alongside it.
//
// PUSH/PULL CONSISTENCY: this file is the PUSH side (files arriving via
// share) of every import capability that also has a PULL side (a
// deliberate file-picker upload, mostly in connections.js's Dating admin
// panel, plus health.js/wellness.js/renpho.js for their own imports).
// The two sides have diverged more than once because a capability landed
// on only one of them -- see extractDatingScreenshot's own comment in
// connections.js for a real example (a two-part profile share silently
// lost its second half's fields because push had no equivalent to a
// combine capability pull had just gained). When adding or changing an
// import capability here, check whether the matching pull-side entry
// point needs the same change, and vice versa -- and prefer routing both
// through the SAME underlying extraction function (e.g. extractProfile
// FromScreenshot, extractDatingScreenshot) rather than parallel logic
// that can quietly grow apart.
import { data, queueSave, blankCaptureBatch } from '../state.js';
import { photoDelete } from '../db.js';
import { todayStr, escapeHtml, hydratePhotoBackgrounds, resizeImageToBlob, scrollAndFlash } from '../utils.js';
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

// Samsung Health's own screenshot filenames follow this shape (confirmed
// live: "Screenshot_20260823_183715_Samsung Health.jpg") -- unlike the
// Renpho CSV's content sniff, there's no cheap way to peek at an image's
// pixels before a real AI vision call, so this is a filename check rather
// than a content one. A false negative just means normal manual triage
// (nothing lost); a false positive costs one vision call that returns
// "unrecognized" and falls back to normal triage the same way -- see the
// try/catch around extractAndMergeWellnessFile below.
function looksLikeSamsungHealthScreenshot(filename) {
return /samsung[ _]?health/i.test(String(filename || ''));
}

// Android names a Bumble screenshot with the app name baked in, same
// convention as Samsung Health's own filenames (see above) -- but unlike a
// health chart, "came from Bumble" doesn't tell you WHAT kind of Bumble
// screen it is. The filename hint just earns the file one attempt at
// autoRouteBumbleScreenshot below; finding nothing routable is a normal
// outcome (a chat screenshot, a saved photo) and just leaves it for manual
// triage exactly like a false negative would, not an error.
function looksLikeBumbleScreenshot(filename) {
return /bumble/i.test(String(filename || ''));
}

// Bumble's screenshots come in three shapes, only distinguishable with a
// little work: a matches/chat list (several people, thin data), a full
// profile (one person, rich data), or a plain saved photo (squarish, not a
// composite screenshot at all). Two already-proven primitives tell them
// apart without any new AI work:
// - classifyProfileUpload() (utils.js) -- deterministic, aspect-ratio only,
//   no AI call: separates a squarish photo from a long composite screenshot.
// - quickScanScreenshot() (ai.js) -- a cheap, cached Haiku call already
//   built for album triage, returning kind:"profile"|"matches"|"chat"|
//   "other" -- exactly the list-vs-profile signal needed for whatever
//   survives the aspect-ratio check.
// A squarish photo, a chat screenshot, or anything unrecognised all return
// routed:false and are left for normal manual triage, same as any other
// false negative in this file.
async function autoRouteBumbleScreenshot(file, appHint) {
const { classifyProfileUpload } = await import('../utils.js');
const { isScreenshot } = await classifyProfileUpload(file);
if (!isScreenshot) return { routed: false, kind: 'photo' };
const { quickScanScreenshot } = await import('../ai.js');
const scan = await quickScanScreenshot(file, appHint);
if (scan.kind === 'matches') {
const { importMatchesListFile } = await import('./connections.js');
const { candidates } = await importMatchesListFile(file, appHint);
return { routed: candidates.length > 0, kind: 'matches', count: candidates.length };
}
if (scan.kind === 'profile') {
const { importProfileScreenshotFile } = await import('./connections.js');
const { candidate } = await importProfileScreenshotFile(file, appHint);
return { routed: !!candidate, kind: 'profile', count: candidate ? 1 : 0 };
}
return { routed: false, kind: scan.kind };
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

// The one place a batch of raw files becomes an inbox entry. Two phases,
// deliberately not interleaved per file:
//
// Phase 1 stores every file -- fast, local, no network/AI -- and only
// after that does Phase 2 attempt the slow AI auto-detection passes
// (wellness, Bumble) on whichever items matched a filename hint. Confirmed
// live as a real bug when these WERE interleaved (extraction attempted
// right after each file's own storage, before moving to the next file):
// sharing 6 files together where the first was a Bumble profile screenshot
// lost the other 5 entirely. Android backgrounds the PWA tab the moment
// the share sheet closes -- sharing feels "done" at that point, not when
// this function actually finishes -- and if the loop was still awaiting a
// several-second AI call on file 1 when that happened, files 2-6 never
// even reached their own (fast, local) storage step. Splitting into two
// phases means every file is durably captured before ANY slow call starts,
// so the worst case an interruption can now cause is an unfinished
// extraction on an already-safely-stored photo -- exactly the existing,
// already-safe fallback (manual triage later) -- never a file that was
// never stored at all.
async function addCaptureBatch({ label, notes = '', source = null, files }) {
const batch = blankCaptureBatch({ label, notes, source });
const failed = [];
const healthImports = [];
const matchesImports = [];
let renphoImported = false;
let wellnessImported = false;
const autoRouteCandidates = []; // [{file, item}] -- photo items worth a slow AI pass, filled in Phase 1

// Phase 1: capture and durably store every file.
for (const file of files) {
try {
const kind = await captureItemKind(file);
if (kind === 'renpho-csv') {
const text = await file.text();
const rows = parseRenphoCsv(text);
const days = mergeRenphoDaily(rows);
healthImports.push(`${file.name || 'Renpho export'}: ${days} day${days === 1 ? '' : 's'} of scale readings imported.`);
renphoImported = true;
queueSave();
continue;
}
let item;
if (kind === 'photo') {
const blob = await resizeImageToBlob(file, 1200, 0.85);
const id = await storePhoto(blob);
item = { id, name: file.name || 'photo', type: file.type || blob.type, size: blob.size, kind: 'photo' };
} else {
item = { ...(await uploadAttachment(file)), kind: 'attachment' };
}
batch.items.push(item);
if (!data.captureInbox.includes(batch)) data.captureInbox.push(batch);
queueSave();
if (kind === 'photo' && (looksLikeSamsungHealthScreenshot(file.name) || looksLikeBumbleScreenshot(file.name))) {
autoRouteCandidates.push({ file, item });
}
} catch (err) {
console.error('Could not capture a shared file:', err);
failed.push(`${file.name || 'file'}: ${err.message || err}`);
}
}

// Phase 2: now that everything above is safely stored, spend the slow AI
// calls -- a filename match is a hint, not a certainty (see
// looksLikeSamsungHealthScreenshot's own comment), so finding nothing is a
// normal outcome that just leaves that one item for manual triage.
//
// The Bumble auto-route only fires when its screenshot is the ONLY photo
// in the whole share -- confirmed by the user as the wrong default
// otherwise: sharing a profile screenshot together with that person's own
// photos is exactly the "tick who belongs together" combined case Capture
// Inbox's manual "Extract dating screenshot" button now handles (see
// importProfileWithPhotosFile in connections.js), and if the auto-route
// eagerly consumed the screenshot alone the moment the share landed, it
// would already be gone from the batch before the user ever got a chance
// to tick it together with the right photos -- silently breaking the very
// grouping the manual flow exists to support. A share with more than one
// photo just leaves everything in Capture Inbox untouched, so the user can
// tick whichever subset is person 1, extract that, then tick whichever
// subset is person 2, and so on -- full manual control over multi-person
// shares, at the cost of one extra tap for the common single-screenshot
// share (which still auto-routes exactly as before).
const totalPhotoCount = batch.items.filter((it) => it.kind === 'photo').length;
for (const { file, item } of autoRouteCandidates) {
if (looksLikeSamsungHealthScreenshot(file.name)) {
try {
const { extractAndMergeWellnessFile } = await import('./wellness.js');
const { ok, message } = await extractAndMergeWellnessFile(file);
if (ok) {
healthImports.push(message);
wellnessImported = true;
await deleteItemBytes(item);
batch.items = batch.items.filter((it) => it.id !== item.id);
removeBatchIfEmpty(batch);
queueSave();
}
} catch (err) {
console.error('Auto wellness extraction failed, photo stays in Capture Inbox for manual triage:', err);
}
}
if (looksLikeBumbleScreenshot(file.name) && totalPhotoCount === 1) {
try {
const result = await autoRouteBumbleScreenshot(file, 'Bumble');
if (result.routed) {
matchesImports.push(`${file.name || 'that image'}: found ${result.count} ${result.count === 1 ? 'person' : 'people'} (${result.kind}) — review in Dating admin.`);
await deleteItemBytes(item);
batch.items = batch.items.filter((it) => it.id !== item.id);
removeBatchIfEmpty(batch);
queueSave();
}
} catch (err) {
console.error('Auto Bumble-screenshot routing failed, photo stays in Capture Inbox for manual triage:', err);
}
}
}

renderCaptureInbox();
if (renphoImported) {
const { renderRenphoDaily } = await import('./renpho.js');
renderRenphoDaily();
}
if (wellnessImported) {
const { renderWellnessDaily } = await import('./wellness.js');
renderWellnessDaily();
}
return { batch, failed, healthImports, matchesImports };
}

function removeBatchIfEmpty(batch) {
if (!batch.items.length) data.captureInbox = data.captureInbox.filter((b) => b.id !== batch.id);
}

// Call AFTER renderCaptureInbox() -- the per-card status span is freshly
// rebuilt at that point (see the extraction handlers below), so this finds
// the recreated one and writes there, right next to the buttons the user is
// actually looking at, rather than the page-level line up at the top of the
// panel which is easy to miss when the card is scrolled below it. Only
// falls back to the page-level line when the batch itself is gone (every
// item in it succeeded) and there's no card left to point the message at.
function writeInboxStatus(root, batchId, message) {
const cardStatus = root.querySelector(`[data-inbox-status="${batchId}"]`);
if (cardStatus) { cardStatus.textContent = message; return; }
const pageStatus = document.getElementById('capture-inbox-status');
if (pageStatus) pageStatus.textContent = message;
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
<span data-inbox-dating-select-mount="${b.id}"></span>
<input type="text" autocomplete="off" data-inbox-new-name="${b.id}" placeholder="New connection's name" hidden>
<button class="todo-add-btn" type="button" data-inbox-send-dating="${b.id}">Send</button>
<button class="todo-add-btn" type="button" data-inbox-extract-wellness="${b.id}" title="For an HRV, Sleeping HR, AGEs index, or Antioxidant index screenshot from Samsung Health">Extract wellness data</button>
<button class="todo-add-btn" type="button" data-inbox-extract-trip-toggle="${b.id}" title="For a boarding pass, hotel, car hire, or transfer confirmation">Extract into a trip leg</button>
<button class="todo-add-btn" type="button" data-inbox-extract-matches="${b.id}" title="For a Bumble/Tinder/Hinge matches list or full profile screenshot — auto-detects which and pulls it out for review">Extract dating screenshot</button>
${photoItems.length > 1 ? `<label class="settings-note" style="display:flex;align-items:center;gap:4px;">
<input type="checkbox" data-inbox-force-combine="${b.id}">
These screenshots are one profile, in pieces
</label>` : ''}` : ''}
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
// The connection picker's row list needs the live Dating module, kept as a
// dynamic import so this module never has to load connections.js (and
// everything it pulls in) up front for a panel most sessions won't touch.
if (data.captureInbox.some((b) => b.items.some((it) => it.kind === 'photo'))) {
import('./connections.js').then(({ connectionPickerHtml, connectionPickerNewRowHtml, bindConnPickers }) => {
bindConnPickers();
el.querySelectorAll('[data-inbox-dating-select-mount]').forEach((mount) => {
const bId = mount.dataset.inboxDatingSelectMount;
mount.innerHTML = connectionPickerHtml(`inbox-dating-select-${bId}`, 'Send selected to&hellip;', connectionPickerNewRowHtml());
});
hydratePhotoBackgrounds(el);
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

// Reveals the name field only once "+ Add new connection" is actually
// picked -- keeps the common case (an existing connection already in the
// list) exactly as uncluttered as it was before this option existed.
// Bound to the stable mount span, not the hidden input inside it -- the
// picker's markup lands asynchronously (see renderCaptureInbox's dynamic
// import above), so the input doesn't exist yet at bind time here. 'change'
// bubbles up from it once it does, same as it would from a plain <select>.
root.querySelectorAll('[data-inbox-dating-select-mount]').forEach((mount) => {
const bId = mount.dataset.inboxDatingSelectMount;
mount.addEventListener('change', () => {
const hidden = document.getElementById(`inbox-dating-select-${bId}`);
const nameInput = root.querySelector(`[data-inbox-new-name="${bId}"]`);
if (nameInput && hidden) nameInput.hidden = hidden.value !== '__new__';
});
});

root.querySelectorAll('[data-inbox-send-dating]').forEach((btn) => {
btn.addEventListener('click', async () => {
const batch = data.captureInbox.find((b) => b.id === btn.dataset.inboxSendDating);
if (!batch) return;
const status = root.querySelector(`[data-inbox-status="${batch.id}"]`);
const sel = document.getElementById(`inbox-dating-select-${batch.id}`);
let connId = sel?.value;
if (!connId) { if (status) status.textContent = 'Pick a connection first.'; return; }
if (connId === '__new__') {
const nameInput = root.querySelector(`[data-inbox-new-name="${batch.id}"]`);
const name = (nameInput?.value || '').trim();
if (!name) { if (status) status.textContent = "Type the new connection's name first."; return; }
const { createBlankConnection } = await import('./connections.js');
connId = createBlankConnection(name).id;
}
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
const batchId = batch.id;
batch.items = batch.items.filter((it) => !doneIds.has(it.id));
removeBatchIfEmpty(batch);
renderCaptureInbox();
if (done.length) {
const { renderWellnessDaily } = await import('./wellness.js');
renderWellnessDaily();
}
queueSave();
// Must run AFTER renderCaptureInbox() -- it rebuilds the whole list from
// fresh markup, wiping any status text written before it ran. And it
// writes to the per-card status span (found fresh, post-rebuild) rather
// than only the page-level one -- the page-level line sits at the TOP of
// the panel, well above a card that's scrolled into view, and confirmed
// live as effectively invisible there when the card itself still exists.
writeInboxStatus(root, batchId, messages.join(' '));
});
});

// The pendingImports queue this feeds is persisted (data.pendingImports,
// connections.js) and can hold as many entries as pile up, so -- unlike the
// old ephemeral single-slot version -- there's no reason to only process
// one selected photo per click any more.
//
// Confirmed by the user twice over as a real inconsistency, not two
// separate bugs:
// 1. The "pull" combined-upload path (applyDirectProfileUpload, Send-to-
//    connection) already merges a screenshot ticked alongside loose photos
//    into one action for an EXISTING connection -- fixed here the same way
//    for a NEW one: classify the ticked group by aspect ratio only (cheap,
//    no AI -- just deciding which ticked item, if any, IS the screenshot
//    for grouping purposes), and if it cleanly decomposes into exactly one
//    screenshot plus some loose photos, extract the screenshot AND attach
//    the photos to that same new candidate.
// 2. A quick Haiku pre-scan used to gate WHICH extraction to even attempt
//    (matches vs profile vs "didn't look like either") -- removed. A real
//    Bumble "Chats" screen (several people, each row showing a message
//    preview) succeeded via Dating admin's own "Import matches list"
//    button directly, but was rejected here because the cheap 4-way
//    pre-scan saw "chat" (singular) as a different bucket than "matches"
//    (a list) for that exact shape. extractDatingScreenshot
//    (connections.js) composes the SAME two functions those Dating-admin
//    buttons call directly -- matches first, any candidates found is
//    success exactly like that button's own success condition, profile
//    second -- no separate classifier layer in between that can reject a
//    screenshot the real extraction would have handled fine.
root.querySelectorAll('[data-inbox-extract-matches]').forEach((btn) => {
btn.addEventListener('click', async () => {
const batch = data.captureInbox.find((b) => b.id === btn.dataset.inboxExtractMatches);
if (!batch) return;
const status = root.querySelector(`[data-inbox-status="${batch.id}"]`);
const selectedIds = selectionFor(batch.id);
const chosen = batch.items.filter((it) => it.kind === 'photo' && selectedIds.has(it.id));
if (!chosen.length) { if (status) status.textContent = 'Tick at least one photo first.'; return; }

const { classifyProfileUpload } = await import('../utils.js');
const { extractDatingScreenshot, appHintFromFilename } = await import('./connections.js');
const withFiles = await Promise.all(chosen.map(async (it) => {
const blob = await fetchAttachment(it.id);
const file = new File([blob], it.name || 'photo', { type: it.type || blob.type });
const { isScreenshot } = await classifyProfileUpload(file);
return { it, file, isScreenshot };
}));
const screenshots = withFiles.filter((c) => c.isScreenshot);
const plainPhotos = withFiles.filter((c) => !c.isScreenshot);
// Push's own equivalent of Dating admin's "Selected files are one
// profile, in pieces" checkbox -- see extractDatingScreenshot's own
// comment (connections.js) for why push needed this too: no recourse when
// the auto-heuristic guesses wrong, and Dating admin isn't realistically
// reachable from inside another app's share sheet on a phone.
const forceCombine = !!root.querySelector(`[data-inbox-force-combine="${batch.id}"]`)?.checked;

const done = [];
const messages = [];

// PUSH/PULL CONSISTENCY: this is the push (share sheet) side's only
// caller of extractDatingScreenshot -- see that function's own comment
// in connections.js for the full principle. Several screenshot-shaped
// items ticked together now get ONE combined attempt (matching Dating
// admin's own "Selected files are one profile, in pieces" checkbox on
// the pull side), not "first wins, the rest silently become photos" --
// that gap is exactly what dropped a second screenshot's height/
// drinking/smoking/age from a real two-part profile share.
//
// Whatever extractDatingScreenshot didn't actually consume (its own
// heuristic decided the pieces don't look related, or only one of
// several matched as a list) is deliberately left OUT of `done` here so
// the per-file loop below still runs for it, same as if it had never
// been grouped -- consumedFiles is matched by File reference, not
// position, since the matches-list attempt can succeed on any file in
// the array, not necessarily the first.
if (screenshots.length > 1) {
if (status) status.textContent = `Reading ${screenshots.length} screenshots…`;
try {
const screenshotFiles = screenshots.map((s) => s.file);
const result = await extractDatingScreenshot(screenshotFiles, appHintFromFilename(screenshotFiles), plainPhotos.map((p) => p.file), status, forceCombine);
const consumedFiles = new Set(result.consumedFiles || []);
const consumedItems = screenshots.filter((s) => consumedFiles.has(s.file)).map((s) => s.it);
if (result.kind === 'matches') {
messages.push(`Found ${result.candidates.length} ${result.candidates.length === 1 ? 'person' : 'people'} (a list) — review in Dating admin.`);
done.push(...consumedItems);
} else if (result.kind === 'profile' && consumedItems.length > 1) {
messages.push(`Combined ${consumedItems.length} screenshots into one profile${plainPhotos.length ? ` with ${plainPhotos.length} extra photo${plainPhotos.length === 1 ? '' : 's'}` : ''} — review in Dating admin.`);
done.push(...consumedItems, ...plainPhotos.map((p) => p.it));
} else if (result.kind === 'profile') {
messages.push(`${consumedItems[0]?.name || 'that image'}: found a profile${plainPhotos.length ? ` with ${plainPhotos.length} extra photo${plainPhotos.length === 1 ? '' : 's'}` : ''} — didn't look related enough to the other screenshot(s) to combine, handling those separately — review in Dating admin.`);
done.push(...consumedItems, ...plainPhotos.map((p) => p.it));
} else {
messages.push(result.error?.name === 'MissingKeyError' ? 'Add an Anthropic API key in Settings to extract a dating screenshot.' : "Those screenshots didn't look like a matches list or profile.");
}
} catch (err) {
console.error('Dating screenshot extraction failed:', err);
messages.push(err?.name === 'MissingKeyError' ? 'Add an Anthropic API key in Settings to extract a dating screenshot.' : `Reading those screenshots failed: ${err.message || err}`);
}
} else if (screenshots.length === 1 && plainPhotos.length > 0) {
const { it, file } = screenshots[0];
if (status) status.textContent = `Reading ${it.name || 'photo'}…`;
try {
const result = await extractDatingScreenshot(file, appHintFromFilename(file), plainPhotos.map((p) => p.file), status);
if (result.kind === 'matches') {
// A matches list has several people -- no single obvious owner for
// the other ticked photos, so only the list itself gets extracted;
// the loose photos are left for a separate, unambiguous action.
messages.push(`${it.name || 'that image'}: found ${result.candidates.length} ${result.candidates.length === 1 ? 'person' : 'people'} (a list, not one profile, so the other ticked photos weren't attached to anyone) — review in Dating admin.`);
done.push(it);
} else if (result.kind === 'profile') {
messages.push(`${it.name || 'that image'}: found a profile with ${plainPhotos.length} extra photo${plainPhotos.length === 1 ? '' : 's'} — review in Dating admin.`);
done.push(it, ...plainPhotos.map((p) => p.it));
} else {
// result.error is set when the profile-stage extraction itself failed
// (e.g. no API key) rather than genuinely finding neither shape --
// importProfileScreenshotFile/importProfileWithPhotosFile catch that
// internally so it never reaches this try/catch's own catch block, so
// it has to be read back off the result instead of assumed absent.
messages.push(result.error?.name === 'MissingKeyError' ? 'Add an Anthropic API key in Settings to extract a dating screenshot.' : `${it.name || 'that image'}: didn't look like a matches list or profile.`);
}
} catch (err) {
console.error('Dating screenshot extraction failed:', err);
messages.push(err?.name === 'MissingKeyError' ? 'Add an Anthropic API key in Settings to extract a dating screenshot.' : `${it.name || 'that image'}: ${err.message || err}`);
}
}

// Always runs, not just in an else branch: covers the plain 0-or-1-
// screenshot cases untouched by either branch above, AND any leftover
// screenshots the >1 combine branch didn't end up consuming.
const alreadyDoneIds = new Set(done.map((d) => d.id));
for (const { it, file, isScreenshot } of withFiles) {
if (alreadyDoneIds.has(it.id)) continue;
if (!isScreenshot) { messages.push(`${it.name || 'that image'}: not a screenshot, skipped.`); continue; }
if (status) status.textContent = `Reading ${it.name || 'photo'}…`;
try {
const result = await extractDatingScreenshot(file, appHintFromFilename(file), [], status);
if (result.kind) {
const count = result.candidates ? result.candidates.length : 1;
messages.push(`${it.name || 'that image'}: found ${count} ${count === 1 ? 'person' : 'people'} (${result.kind}) — review in Dating admin.`);
done.push(it);
} else {
messages.push(result.error?.name === 'MissingKeyError' ? 'Add an Anthropic API key in Settings to extract a dating screenshot.' : `${it.name || 'that image'}: didn't look like a matches list or profile.`);
}
} catch (err) {
console.error('Dating screenshot extraction failed:', err);
messages.push(err?.name === 'MissingKeyError' ? 'Add an Anthropic API key in Settings to extract a dating screenshot.' : `${it.name || 'that image'}: ${err.message || err}`);
}
}

for (const it of done) { await deleteItemBytes(it); selectedIds.delete(it.id); }
const doneIds = new Set(done.map((it) => it.id));
batch.items = batch.items.filter((it) => !doneIds.has(it.id));
removeBatchIfEmpty(batch);
queueSave();
const message = messages.join(' ');
const batchId = batch.id;
renderCaptureInbox();
writeInboxStatus(root, batchId, message);
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
const batchId = batch.id;
batch.items = batch.items.filter((it) => !doneIds.has(it.id));
removeBatchIfEmpty(batch);
renderCaptureInbox();
queueSave();
// Same ordering fix as the wellness handler above -- must run AFTER
// renderCaptureInbox(), and target the per-card status where it still
// exists rather than only the easy-to-miss page-level line.
writeInboxStatus(root, batchId, messages.join(' '));
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
setTimeout(() => scrollAndFlash(`[data-inbox-batch="${id}"]`), 60);
}

export { renderCaptureInbox, initCaptureInbox, addCaptureBatch, revealCaptureBatch };
