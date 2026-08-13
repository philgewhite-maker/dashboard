// Moves photos that only exist in this device's IndexedDB up to your own
// host, so they appear on every device like everything else.
//
// Photos predate the attachments mechanism: the *ids* have always been part
// of the synced document, but the bytes never were. The visible symptom is a
// connection imported on the desktop showing initials instead of a face on
// the phone — indistinguishable from "no photo was added", which is why this
// went unnoticed.
//
// The id itself records where a photo lives (see isServerPhotoId), so
// migrating is: upload the blob, then rewrite every reference from the old
// local id to the new server id. Re-runnable and interruptible — it re-scans
// each time, so a run that stops halfway just leaves less to do next time.
import { data, queueSave } from '../state.js';
import { photoGet, photoDelete } from '../db.js';
import { escapeHtml } from '../utils.js';
import { uploadAttachment, isServerPhotoId, formatBytes, FilesNotConfiguredError } from '../files.js';

// Every place a photo id can appear in the document. Kept in one list so a
// rewrite can't miss a reference and strand a photo.
function photoRefs() {
const refs = [];
(data.connections || []).forEach((c) => {
(c.photoIds || []).forEach((id, i) => refs.push({ id, set: (next) => { c.photoIds[i] = next; } }));
if (c.photoId) refs.push({ id: c.photoId, set: (next) => { c.photoId = next; } });
});
(data.tasks || []).forEach((t) => {
(t.photoIds || []).forEach((id, i) => refs.push({ id, set: (next) => { t.photoIds[i] = next; } }));
});
return refs;
}

// Classifies every referenced photo. `missing` means the id synced from
// another device but the bytes were never uploaded — this device cannot fix
// those; the device that holds them has to run the migration.
async function scanPhotos() {
const refs = photoRefs();
const byId = new Map();
refs.forEach((r) => { if (r.id) byId.set(r.id, (byId.get(r.id) || 0) + 1); });

const local = [];
const synced = [];
const missing = [];
let localBytes = 0;
for (const id of byId.keys()) {
if (isServerPhotoId(id)) { synced.push(id); continue; }
const blob = await photoGet(id).catch(() => null);
if (blob) { local.push({ id, size: blob.size }); localBytes += blob.size; }
else missing.push(id);
}
return { local, synced, missing, localBytes, totalRefs: refs.length };
}

let running = false;
let cancelRequested = false;
function requestCancel() { cancelRequested = true; }

// Uploads one photo and repoints every reference to it. Returns bytes moved.
async function migrateOne(entry) {
const blob = await photoGet(entry.id);
if (!blob) return 0;
// IndexedDB gives back a bare Blob; uploadAttachment wants a name and type
// for the metadata and the eventual download prompt.
const type = blob.type || 'image/jpeg';
const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
const file = new File([blob], `photo-${entry.id}.${ext}`, { type });
const meta = await uploadAttachment(file);
// Rewrite AFTER a successful upload, so a failure leaves the old id intact
// and the photo still visible on this device.
photoRefs().forEach((r) => { if (r.id === entry.id) r.set(meta.id); });
await photoDelete(entry.id).catch(() => {});
queueSave();
return blob.size;
}

async function migrateAll(onProgress) {
if (running) return;
running = true;
cancelRequested = false;
let moved = 0;
let bytes = 0;
let failed = 0;
try {
const { local } = await scanPhotos();
for (const entry of local) {
if (cancelRequested) break;
onProgress({ phase: 'working', moved, total: local.length, bytes, failed });
try {
bytes += await migrateOne(entry);
moved++;
} catch (err) {
console.error(`Couldn't upload photo ${entry.id}:`, err);
failed++;
// A configuration problem will fail identically for every remaining
// photo, so stop rather than grinding through hundreds of failures.
if (err instanceof FilesNotConfiguredError) {
onProgress({ phase: 'error', moved, total: local.length, bytes, failed, message: err.message });
return;
}
}
}
onProgress({ phase: cancelRequested ? 'stopped' : 'done', moved, total: local.length, bytes, failed });
} finally {
running = false;
}
}

function statusLine(s) {
const bits = [];
bits.push(`${s.synced.length} synced`);
bits.push(`${s.local.length} on this device only${s.local.length ? ` (${formatBytes(s.localBytes)})` : ''}`);
if (s.missing.length) bits.push(`${s.missing.length} missing here`);
return bits.join(' · ');
}

async function render() {
const el = document.getElementById('photosync-body');
if (!el) return;
const s = await scanPhotos();
el.innerHTML = `<div class="settings-note" style="margin:0 0 8px;">${escapeHtml(statusLine(s))}</div>
${s.local.length ? `<div class="sync-row">
<button class="sync-btn" id="photosync-run" type="button">Upload ${s.local.length} photo${s.local.length === 1 ? '' : 's'} to my server</button>
<button class="sync-btn" id="photosync-stop" type="button" style="display:none;">Stop</button>
<span class="sync-status" id="photosync-status"></span>
</div>` : '<div class="settings-note" style="margin:0;">Nothing to upload from this device.</div>'}
${s.missing.length ? `<div class="settings-note" style="margin:8px 0 0;">${s.missing.length} photo${s.missing.length === 1 ? '' : 's'} referenced here ${s.missing.length === 1 ? 'has' : 'have'} no copy on this device — run this on the device that originally added them, and they'll appear here afterwards.</div>` : ''}`;

const run = document.getElementById('photosync-run');
if (!run) return;
const stop = document.getElementById('photosync-stop');
const status = document.getElementById('photosync-status');
run.addEventListener('click', async () => {
run.disabled = true;
stop.style.display = '';
await migrateAll((p) => {
if (p.phase === 'working') status.textContent = `Uploading ${p.moved + 1} of ${p.total}… (${formatBytes(p.bytes)} so far)`;
else if (p.phase === 'error') status.textContent = p.message;
else status.textContent = `${p.phase === 'stopped' ? 'Stopped' : 'Done'} — moved ${p.moved} of ${p.total} (${formatBytes(p.bytes)})${p.failed ? `, ${p.failed} failed` : ''}.`;
});
stop.style.display = 'none';
// Re-render to pick up the new counts, then refresh anything showing photos.
const done = status.textContent;
await render();
const s2 = document.getElementById('photosync-status');
if (s2) s2.textContent = done;
const [conns, tasks] = await Promise.all([import('./connections.js'), import('./tasks.js')]);
conns.renderConnections();
tasks.renderTasks();
});
stop.addEventListener('click', () => { requestCancel(); stop.disabled = true; });
}

function initPhotoSync() {
const btn = document.getElementById('photosync-refresh');
if (!btn) return;
btn.addEventListener('click', render);
render();
}

export { initPhotoSync, scanPhotos, migrateAll, photoRefs };
