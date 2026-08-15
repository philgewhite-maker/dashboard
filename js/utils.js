import { photoUrl } from './db.js';

function todayStr() { return new Date().toISOString().slice(0, 10); }

function daysAgoStr(n) {
const d = new Date();
d.setDate(d.getDate() - n);
return d.toISOString().slice(0, 10);
}

function last7Dates() {
const arr = [];
for (let i = 6; i >= 0; i--) arr.push(daysAgoStr(i));
return arr;
}

function uid() { return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4); }

function daysSince(dateStr) {
const d = new Date(dateStr);
const now = new Date(todayStr());
return Math.round((now - d) / 86400000);
}

function daysUntil(dateStr) {
const evt = new Date(String(dateStr).slice(0, 10));
const now = new Date(todayStr());
return Math.round((evt - now) / 86400000);
}

// Escapes for both text content AND attribute values, which is what nearly
// every caller here needs — this codebase builds HTML strings and drops
// values into `attr="..."` constantly.
//
// The obvious implementation (textContent in, innerHTML out) does NOT escape
// quotes, because quotes need no escaping in text. In an attribute they very
// much do: one `"` in a tag name or note ends the attribute early and
// corrupts the rest of the tag. That bit for real — a JSON payload in a
// data- attribute silently truncated at its first quote.
function escapeHtml(str) {
return String(str == null ? '' : str)
.replace(/&/g, '&amp;')
.replace(/</g, '&lt;')
.replace(/>/g, '&gt;')
.replace(/"/g, '&quot;')
.replace(/'/g, '&#39;');
}

function initials(name) {
return (name || '?').trim().charAt(0).toUpperCase();
}

// Renders an avatar/photo <div> with a data-photo-id placeholder; call
// hydratePhotos() after inserting the returned HTML into the DOM to fill in
// the actual blob URL asynchronously (IndexedDB reads are async, but HTML
// string building is synchronous, so photo src is always a two-step render).
function avatarHtml(photoId, name, sizeClass) {
const cls = `avatar ${sizeClass || ''}`;
if (photoId) {
return `<div class="${cls}" data-photo-id="${escapeHtml(photoId)}">${escapeHtml(initials(name))}</div>`;
}
return `<div class="${cls}">${escapeHtml(initials(name))}</div>`;
}

// Finds every element carrying data-photo-id inside `root` and swaps in an
// <img> once the blob is loaded. Safe to call repeatedly; a no-op for ids
// that fail to resolve (leaves the initials fallback in place).
// Resolver for photos whose bytes aren't on this device. Registered by
// app.js rather than imported, because the implementation lives in files.js,
// which reaches state.js — and state.js imports this module, so importing it
// back would be a cycle.
let photoFallback = null;
function setPhotoFallback(fn) { photoFallback = fn; }

// Fills in every [data-photo-id] placeholder. Photos are stored per-device,
// so an id that synced from another device has no local blob; the fallback
// fetches those from your own host. Anything still unresolved is marked
// rather than left blank — an empty square looks identical to "no photo was
// ever added", which is the wrong thing to conclude.
async function hydratePhotos(root) {
const nodes = [...root.querySelectorAll('[data-photo-id]')].filter((el) => !el.querySelector('img'));
await Promise.all(nodes.map(async (el) => {
const id = el.dataset.photoId;
let url = await photoUrl(id);
if (!url && photoFallback) {
el.classList.add('photo-loading');
try { url = await photoFallback(id); } catch (e) { /* leave it marked missing */ }
el.classList.remove('photo-loading');
}
if (url) {
const img = document.createElement('img');
img.src = url;
img.alt = '';
// A plain <img> is natively draggable; nudging one a pixel mid-click is
// enough on Windows Chrome to kick off an OS-level drag of the blob: URL,
// which can pop File Explorer instead of (or alongside) a click handler.
// draggable=false alone turned out not to be reliable enough on its own
// (confirmed still happening live on the Connections photo grid despite
// this plus the matching -webkit-user-drag:none CSS) -- explicitly
// cancelling dragstart is a stronger, event-level block rather than a
// passive attribute Chromium can apparently still race past.
img.draggable = false;
img.addEventListener('dragstart', (e) => e.preventDefault());
el.textContent = '';
el.appendChild(img);
} else {
el.classList.add('photo-missing');
el.title = 'This photo is only on the device it was added on — see Settings → Photo sync.';
}
}));
}

function scrollAndFlash(selector) {
const el = document.querySelector(selector);
if (!el) return;
el.scrollIntoView({ behavior: 'smooth', block: 'center' });
el.classList.add('flash-new');
setTimeout(() => el.classList.remove('flash-new'), 1800);
}

// Binds an add-panel's button directly (no <form> submit) — some mobile
// browsers swallow the first tap after a keyboard closes, so pointerdown
// (fires the instant a finger touches the screen) is paired with click as
// a fallback rather than relying on either alone.
function bindForm(containerId, handler) {
const container = document.getElementById(containerId);
if (!container) return;
const btn = container.querySelector('button');
let handledByPointer = false;
if (btn) {
btn.addEventListener('pointerdown', (e) => {
e.preventDefault();
handledByPointer = true;
const original = btn.textContent;
btn.textContent = '✓ Added';
handler();
setTimeout(() => { btn.textContent = original; }, 500);
});
btn.addEventListener('click', () => {
if (handledByPointer) { handledByPointer = false; return; }
handler();
});
}
container.querySelectorAll('input[type=text], input[type=date]').forEach((input) => {
input.addEventListener('keydown', (e) => {
if (e.key === 'Enter') {
e.preventDefault();
handler();
}
});
});
}

// HEIC/HEIF — the default photo format on iPhone — has no built-in browser
// decoder, so `new Image()` fails on it. On desktop that's a clean
// `onerror`; on Android it was seen to just hang forever instead — nothing
// attached, nothing reported, because there was nothing to catch.
//
// This check used to trust `file.type` and the filename extension, but
// those come from whatever handed the file to the browser, and on Android
// that's frequently wrong: a file picked via a chat app or Samsung's own
// file picker can arrive as `application/octet-stream` or with no
// extension at all even though the bytes are still HEIC. Reading the
// file's own header is the only way that's actually reliable.
function looksLikeHeic(file) {
const type = (file.type || '').toLowerCase();
const name = (file.name || '').toLowerCase();
return type.includes('heic') || type.includes('heif') || /\.hei[cf]$/.test(name);
}

// HEIC/HEIF/AVIF all use the ISO-BMFF container: a size word, then the
// ASCII bytes "ftyp", then a 4-byte brand. Reading just the first 32 bytes
// is enough to catch the major brand and the first couple of compatible
// brands, which covers real-world photos without parsing the full box
// structure.
const HEIC_BRANDS = ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1'];
async function sniffsAsHeic(file) {
try {
const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
if (String.fromCharCode(...head.slice(4, 8)) !== 'ftyp') return false;
const tail = String.fromCharCode(...head.slice(8, 32));
return HEIC_BRANDS.some((b) => tail.includes(b));
} catch (e) {
return false;
}
}

// heic-to (https://github.com/hoppergee/heic-to) wraps libheif compiled to
// WASM. Loaded from CDN rather than bundled, since this project has no
// build step — everything else here is a plain ES module import too. The
// `/csp` build is a single self-contained file with no `eval()`, so it
// doesn't need a Content-Security-Policy exception. It's ~3MB; the browser's
// own HTTP cache keeps that to a one-time cost per device, not per photo.
// Cached as a promise (not just the resolved module) so two photos picked
// at once share one fetch instead of racing two.
const HEIC_TO_URL = 'https://cdn.jsdelivr.net/npm/heic-to@1.5.2/dist/csp/heic-to.js';
let heicToModule = null;
function loadHeicTo() {
if (!heicToModule) heicToModule = import(/* webpackIgnore: true */ HEIC_TO_URL);
return heicToModule;
}

// Converts a HEIC/HEIF file to a real JPEG File in the browser — nothing
// leaves the device. Every image-consuming flow (photo capture, the AI
// screenshot parsers) should run its input through this first, since a HEIC
// file is equally unreadable to a `<canvas>` decode and to Claude's vision
// API. Returns the file unchanged if it isn't HEIC.
async function ensureBrowserReadableImage(file) {
if (!(looksLikeHeic(file) || await sniffsAsHeic(file))) return file;
let heicTo;
try {
({ heicTo } = await loadHeicTo());
} catch (err) {
heicToModule = null; // let the next attempt retry the fetch rather than replay this failure forever
throw new Error(`Couldn't load the HEIC converter (needs an internet connection the first time) — ${err.message || err}`);
}
let jpegBlob;
try {
jpegBlob = await heicTo({ blob: file, type: 'image/jpeg', quality: 0.9 });
} catch (err) {
throw new Error(`"${file.name || 'That photo'}" looks like HEIC/HEIF but couldn't be converted (${err.message || err}). On iPhone: Settings → Camera → Formats → Most Compatible, then re-share it. On Android, opening it once in Gallery and re-saving/re-sharing usually converts it too.`);
}
const jpegName = (file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg';
return new File([jpegBlob], jpegName, { type: 'image/jpeg', lastModified: file.lastModified });
}

async function resizeImageToBlob(file, maxDim, quality) {
file = await ensureBrowserReadableImage(file);
return new Promise((resolve, reject) => {
// A decode that never calls back — seen on Android for formats the
// browser can't handle — would otherwise hang the whole capture
// silently. Timing it out turns that into a normal, visible failure.
// Only wired onto the actual resolve/reject calls below, not any
// intermediate step, so it stays armed until the promise truly settles.
const timer = setTimeout(() => reject(new Error(`"${file.name || 'That photo'}" didn't load — it may be a format this browser can't read. Try converting it to JPEG first.`)), 10000);
const settle = (fn) => (...args) => { clearTimeout(timer); fn(...args); };
const resolveOnce = settle(resolve);
const rejectOnce = settle(reject);

const reader = new FileReader();
reader.onload = () => {
const img = new Image();
img.onload = () => {
let w = img.naturalWidth, h = img.naturalHeight;
const scale = Math.min(1, maxDim / Math.max(w, h));
w = Math.round(w * scale); h = Math.round(h * scale);
const canvas = document.createElement('canvas');
canvas.width = w; canvas.height = h;
canvas.getContext('2d').drawImage(img, 0, 0, w, h);
canvas.toBlob((blob) => blob ? resolveOnce(blob) : rejectOnce(new Error('toBlob failed')), 'image/jpeg', quality || 0.85);
};
img.onerror = () => rejectOnce(new Error('decode failed'));
img.src = reader.result;
};
reader.onerror = () => rejectOnce(new Error('read failed'));
reader.readAsDataURL(file);
});
}

// SHA-256 of the raw bytes, so the same picture is recognised however it
// reached the app — re-picked from an album, re-downloaded, or renamed.
// Hashing the bytes rather than name+size means a rename doesn't defeat the
// cache and two different photos of the same size don't collide.
async function hashFile(file) {
const buf = await file.arrayBuffer();
const digest = await crypto.subtle.digest('SHA-256', buf);
return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// When the photo was actually taken, which is what an age read off it is
// true as of. Three sources, best first:
//
//  1. EXIF DateTimeOriginal — right for camera photos, absent from most
//     screenshots (PNGs carry no EXIF at all).
//  2. The filename — phones name screenshots by date
//     ("Screenshot_20240312-101500", "IMG_20240312_101500", "2024-03-12 ...").
//  3. File.lastModified — the weakest, because downloading a photo rewrites
//     it to the download date, which would make an old screenshot look new.
//
// Returns {date, source} where source ranks how much to trust it — see
// CAPTURE_DATE_RANK. The rank matters because the same image can reach the
// app twice with different evidence (once with its original filename, once
// renamed), and the weaker showing must not overwrite the stronger one.
const CAPTURE_DATE_RANK = { exif: 3, filename: 2, modified: 1, '': 0 };

async function captureDateOf(file) {
const fromExif = await exifDateTimeOriginal(file).catch(() => '');
if (fromExif) return { date: fromExif, source: 'exif' };
const fromName = dateFromFilename(file.name || '');
if (fromName) return { date: fromName, source: 'filename' };
if (file.lastModified) {
const d = new Date(file.lastModified);
if (!isNaN(d)) return { date: d.toISOString().slice(0, 10), source: 'modified' };
}
return { date: '', source: '' };
}

function betterCaptureDate(a, b) {
return CAPTURE_DATE_RANK[(b || {}).source || ''] > CAPTURE_DATE_RANK[(a || {}).source || ''] ? b : a;
}

function dateFromFilename(name) {
// 2024-03-12 / 2024_03_12 / 20240312, each with a plausible year.
const m = name.match(/(20\d{2})[-_]?(0[1-9]|1[0-2])[-_]?(0[1-9]|[12]\d|3[01])/);
if (!m) return '';
return `${m[1]}-${m[2]}-${m[3]}`;
}

// Minimal EXIF reader: walks the JPEG segment list to APP1, then the TIFF
// IFD looking for tag 0x9003 (DateTimeOriginal). Only reads the first 128KB,
// since EXIF lives at the very start and reading a whole 5MB photo to find a
// date would be wasteful.
async function exifDateTimeOriginal(file) {
if (!/jpe?g/i.test(file.type || '') && !/\.jpe?g$/i.test(file.name || '')) return '';
const head = await file.slice(0, 131072).arrayBuffer();
const view = new DataView(head);
if (view.byteLength < 4 || view.getUint16(0) !== 0xFFD8) return ''; // not a JPEG
let offset = 2;
while (offset + 4 < view.byteLength) {
if (view.getUint8(offset) !== 0xFF) break;
const marker = view.getUint8(offset + 1);
const size = view.getUint16(offset + 2);
if (marker === 0xE1) { // APP1
const start = offset + 4;
if (view.getUint32(start) !== 0x45786966) return ''; // not "Exif"
return readTiffDate(view, start + 6);
}
offset += 2 + size;
}
return '';
}

function readTiffDate(view, tiffStart) {
if (tiffStart + 8 > view.byteLength) return '';
const little = view.getUint16(tiffStart) === 0x4949;
const ifdOffset = view.getUint32(tiffStart + 4, little);
// Walk IFD0, then follow its ExifIFD pointer (tag 0x8769) where
// DateTimeOriginal actually lives.
for (const dirStart of [tiffStart + ifdOffset, null]) {
if (dirStart === null) break;
const found = scanIfd(view, tiffStart, dirStart, little);
if (found) return found;
}
return '';
}

function scanIfd(view, tiffStart, dirStart, little, depth = 0) {
if (depth > 2 || dirStart + 2 > view.byteLength) return '';
const count = view.getUint16(dirStart, little);
for (let i = 0; i < count; i++) {
const entry = dirStart + 2 + i * 12;
if (entry + 12 > view.byteLength) return '';
const tag = view.getUint16(entry, little);
if (tag === 0x9003 || tag === 0x9004) { // DateTimeOriginal / DateTimeDigitized
const valueOffset = tiffStart + view.getUint32(entry + 8, little);
if (valueOffset + 19 > view.byteLength) continue;
let text = '';
for (let j = 0; j < 19; j++) text += String.fromCharCode(view.getUint8(valueOffset + j));
// EXIF writes "2024:03:12 10:15:00"
const m = text.match(/^(\d{4}):(\d{2}):(\d{2})/);
if (m) return `${m[1]}-${m[2]}-${m[3]}`;
}
if (tag === 0x8769) { // ExifIFD pointer
const sub = tiffStart + view.getUint32(entry + 8, little);
const found = scanIfd(view, tiffStart, sub, little, depth + 1);
if (found) return found;
}
}
return '';
}

function fileToBase64(file) {
return new Promise((resolve, reject) => {
const reader = new FileReader();
reader.onload = () => resolve(reader.result.split(',')[1]);
reader.onerror = () => reject(new Error('Could not read file'));
reader.readAsDataURL(file);
});
}

function loadImage(dataUrlOrFile) {
return new Promise((resolve, reject) => {
const img = new Image();
img.onload = () => resolve(img);
img.onerror = () => reject(new Error('Could not decode image'));
if (typeof dataUrlOrFile === 'string') {
img.src = dataUrlOrFile;
} else {
img.src = URL.createObjectURL(dataUrlOrFile);
}
});
}

// Crops a tight square thumbnail from a fractional bounding box (0..1,
// top-left origin) as returned by the vision-based screenshot import.
function cropThumbnailToBlob(img, bbox) {
return new Promise((resolve) => {
if (!bbox) { resolve(null); return; }
const { x, y, w, h } = bbox;
if ([x, y, w, h].some((v) => typeof v !== 'number' || v < 0 || v > 1) || w <= 0 || h <= 0) { resolve(null); return; }
const SIZE = 160;
const canvas = document.createElement('canvas');
canvas.width = SIZE; canvas.height = SIZE;
const ctx = canvas.getContext('2d');
let sx = x * img.naturalWidth;
let sy = y * img.naturalHeight;
let sw = w * img.naturalWidth;
let sh = h * img.naturalHeight;
if (sw <= 0 || sh <= 0) { resolve(null); return; }
const side = Math.min(sw, sh);
sx = sx + (sw - side) / 2;
sy = sy + (sh - side) / 2;
ctx.drawImage(img, sx, sy, side, side, 0, 0, SIZE, SIZE);
canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.85);
});
}

export {
todayStr, daysAgoStr, last7Dates, uid, daysSince, daysUntil,
escapeHtml, initials, avatarHtml, hydratePhotos, scrollAndFlash, bindForm,
resizeImageToBlob, fileToBase64, loadImage, cropThumbnailToBlob,
hashFile, captureDateOf, betterCaptureDate, dateFromFilename,
ensureBrowserReadableImage, setPhotoFallback,
};
