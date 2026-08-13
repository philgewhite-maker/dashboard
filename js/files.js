// Task attachments that actually travel between devices.
//
// The bytes go to files.php on your own host; only small metadata
// ({id, name, type, size}) goes into the synced document. That split is
// deliberate: the synced document is rewritten whole on every save, so
// putting file bytes in it would make every keystroke-triggered save push
// megabytes.
//
// Downloaded bytes are cached in IndexedDB under the attachment's id, so
// opening the same attachment twice only fetches once, and an already-seen
// attachment still opens offline.
import { getConfig } from './sync/selfhost.js';
import { photoPut, photoGet } from './db.js';

class FilesNotConfiguredError extends Error {
constructor() {
super("Attachments need live sync set up first — add your sync URL and secret in Settings.");
this.name = 'FilesNotConfiguredError';
}
}

// files.php sits next to sync.php, so the URL is derived rather than
// configured separately — one less thing to get wrong on each device.
async function filesEndpoint() {
const { url, secret, configured } = await getConfig();
if (!configured) throw new FilesNotConfiguredError();
const endpoint = url.replace(/sync\.php(?=$|\?)/, 'files.php');
if (endpoint === url) {
throw new Error(`Couldn't work out the attachments URL from "${url}" — it should end in sync.php.`);
}
return { endpoint, secret };
}

const UPLOAD_TIMEOUT_MS = 120000; // uploads are far slower than a JSON save
const DOWNLOAD_TIMEOUT_MS = 120000;

async function withTimeout(ms, run) {
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), ms);
try {
return await run(controller.signal);
} catch (err) {
if (err.name === 'AbortError') throw new Error(`The server didn't respond within ${ms / 1000}s.`);
throw err;
} finally {
clearTimeout(timer);
}
}

async function errorFrom(res, fallback) {
try {
const body = await res.json();
return body.error || fallback;
} catch (e) {
return fallback;
}
}

// Uploads and returns the metadata to store on the task. The file itself is
// sent as a raw body rather than multipart — there's nothing else in the
// request, and it avoids a form-parsing dependency on both ends.
async function uploadAttachment(file) {
const { endpoint, secret } = await filesEndpoint();
const res = await withTimeout(UPLOAD_TIMEOUT_MS, (signal) => fetch(`${endpoint}?action=upload`, {
method: 'POST',
headers: {
'X-Sync-Secret': secret,
// Header values must be Latin-1, so a filename with an accent or
// non-Latin script has to be encoded to survive the trip.
'X-File-Name': encodeURIComponent(file.name || 'attachment'),
'X-File-Type': file.type || 'application/octet-stream',
'Content-Type': 'application/octet-stream',
},
body: file,
signal,
}));
if (!res.ok) {
if (res.status === 401) throw new Error('The attachments server rejected the secret — check files.php uses the same one as sync.php.');
if (res.status === 413) throw new Error(await errorFrom(res, 'That file is too large to upload.'));
throw new Error(await errorFrom(res, `Upload failed (HTTP ${res.status}).`));
}
const meta = await res.json();
// Seed the cache with what we already hold, so the device that uploaded a
// file never re-downloads it.
try { await photoPut(meta.id, file); } catch (e) { /* cache is optional */ }
return meta;
}

// Returns a Blob for an attachment, from the local cache when possible.
async function fetchAttachment(id) {
const cached = await photoGet(id).catch(() => null);
if (cached) return cached;

const { endpoint, secret } = await filesEndpoint();
const res = await withTimeout(DOWNLOAD_TIMEOUT_MS, (signal) => fetch(`${endpoint}?id=${encodeURIComponent(id)}`, {
headers: { 'X-Sync-Secret': secret },
signal,
}));
if (!res.ok) {
if (res.status === 404) throw new Error('That attachment is no longer on the server.');
throw new Error(await errorFrom(res, `Couldn't fetch the attachment (HTTP ${res.status}).`));
}
const blob = await res.blob();
try { await photoPut(id, blob); } catch (e) { /* cache is optional */ }
return blob;
}

// Deleting is best-effort on the server: if it fails, the attachment is
// still removed from the task, because leaving a row the user just deleted
// visible on screen is worse than leaving an orphaned file on disk.
async function deleteAttachment(id) {
const { endpoint, secret } = await filesEndpoint();
const res = await withTimeout(UPLOAD_TIMEOUT_MS, (signal) => fetch(`${endpoint}?action=delete&id=${encodeURIComponent(id)}`, {
method: 'POST',
headers: { 'X-Sync-Secret': secret },
signal,
}));
if (!res.ok) throw new Error(await errorFrom(res, `Couldn't delete the attachment (HTTP ${res.status}).`));
}

// Kicks off a browser download using the real filename and type, which the
// endpoint deliberately doesn't serve directly (it forces a generic
// octet-stream download to make stored HTML/SVG unrunnable on that origin).
async function openAttachment(meta) {
const blob = await fetchAttachment(meta.id);
const typed = meta.type ? new Blob([blob], { type: meta.type }) : blob;
const url = URL.createObjectURL(typed);
const a = document.createElement('a');
a.href = url;
a.download = meta.name || 'attachment';
document.body.appendChild(a);
a.click();
a.remove();
// Revoking immediately can cancel the download in some browsers.
setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Server-issued ids are exactly 32 hex characters (files.php generates them
// with random_bytes(16)); ids minted locally by uid() are 11 characters of
// base36. So the id itself says where a photo lives, with no extra field to
// keep in sync — and a legacy local-only id never triggers a pointless
// network round-trip that could only 404.
function isServerPhotoId(id) {
return typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
}

// The fallback behind hydratePhotos: called only when a photo's bytes aren't
// in this device's IndexedDB. Fetches from your host, caches, and returns an
// object URL. Returns null for anything it can't resolve, which the caller
// renders as an explicit "missing" marker.
const photoUrlCache = new Map();
async function serverPhotoUrl(id) {
if (!isServerPhotoId(id)) return null;
if (photoUrlCache.has(id)) return photoUrlCache.get(id);
try {
const blob = await fetchAttachment(id);
const url = URL.createObjectURL(blob);
photoUrlCache.set(id, url);
return url;
} catch (err) {
console.error(`Couldn't load photo ${id} from the server:`, err);
return null;
}
}

function formatBytes(n) {
const size = Number(n) || 0;
if (size < 1024) return `${size} B`;
if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export {
FilesNotConfiguredError,
uploadAttachment, fetchAttachment, deleteAttachment, openAttachment, formatBytes,
isServerPhotoId, serverPhotoUrl,
};
