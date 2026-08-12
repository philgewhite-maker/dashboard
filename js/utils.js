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
async function hydratePhotos(root) {
const nodes = root.querySelectorAll('[data-photo-id]');
for (const el of nodes) {
const id = el.dataset.photoId;
const url = await photoUrl(id);
if (url && !el.querySelector('img')) {
const img = document.createElement('img');
img.src = url;
img.alt = '';
el.textContent = '';
el.appendChild(img);
}
}
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

function resizeImageToBlob(file, maxDim, quality) {
return new Promise((resolve, reject) => {
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
canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('toBlob failed')), 'image/jpeg', quality || 0.85);
};
img.onerror = () => reject(new Error('decode failed'));
img.src = reader.result;
};
reader.onerror = () => reject(new Error('read failed'));
reader.readAsDataURL(file);
});
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
};
