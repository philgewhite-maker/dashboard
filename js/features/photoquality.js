// Photo quality review: finds connections whose cover photo is missing or
// is really just the small placeholder cropped out of a Bumble/WhatsApp
// matches-list or chat header, and proposes a better one from data
// already on file -- a higher-res photo already stored for that same
// connection, or (failing that) the cover of any linked Google Photos
// album for that name. Human-reviewed (see, confirm, apply), never a
// silent auto-fix -- same "Scan, then review a cached result list"
// shape tagcleanup.js's own locationFillInProposals() already uses,
// since decoding every connection's photo isn't free enough to run on
// every render.
import { data, queueSave } from '../state.js';
import { escapeHtml, hydratePhotoBackgrounds, loadImage, contentCropBounds, cropToContentBlob } from '../utils.js';
import { photoGet } from '../db.js';
import { storePhoto } from '../files.js';

// Same 160x160 exact-pixel signature flagLowResThumbnails() (connections.js)
// already uses to flag a single gallery thumbnail as an AI-cropped
// placeholder, not a real upload -- reused here as the "is this cover
// actually bad" check for a bulk pass across every connection.
async function isPlaceholderPhoto(photoId) {
if (!photoId) return true; // no cover at all counts as bad
const blob = await photoGet(photoId);
if (!blob) return true; // a stored id pointing at nothing on file
try {
const img = await loadImage(blob);
return img.naturalWidth === 160 && img.naturalHeight === 160;
} catch (e) {
return false; // can't decode -- don't guess it's bad
}
}

// First of THIS connection's own OTHER stored photos that isn't itself
// the placeholder -- already on file, nothing to fetch.
async function betterOwnPhoto(conn) {
for (const id of conn.photoIds || []) {
if (id === conn.photoId) continue; // that's the one already flagged bad
if (!(await isPlaceholderPhoto(id))) return id;
}
return null;
}

// First linked album's own cover -- already resolved and stored at link
// time (see photoalbums.js's resolveCover()), never fetched here.
function firstAlbumCoverPhotoId(conn) {
return (conn.photoAlbums || []).find((a) => a.coverPhotoId)?.coverPhotoId || null;
}

let qualityResults = null; // null = not scanned yet; [] = scanned, nothing found

async function scanPhotoQuality() {
const out = [];
for (const conn of data.connections) {
if (!(await isPlaceholderPhoto(conn.photoId))) continue;
const ownBetter = await betterOwnPhoto(conn);
const albumCoverId = ownBetter ? null : firstAlbumCoverPhotoId(conn);
out.push({
connId: conn.id,
name: conn.name,
currentPhotoId: conn.photoId,
proposedPhotoId: ownBetter || albumCoverId,
source: ownBetter ? 'own-photo' : albumCoverId ? 'album-cover' : null,
});
}
return out;
}

// Two distinct paths, not one generic copy step -- the two sources differ
// in whether the blob is already this connection's own. Mirrors
// connections.js's own replacePhotoInPlace() (its template for "swap a
// cover in, update photoId if that slot was the cover"), adapted to take
// an already-stored blob id instead of a freshly-picked File.
async function applyProposedCover(connId) {
const row = qualityResults?.find((r) => r.connId === connId);
const conn = data.connections.find((c) => c.id === connId);
if (!row || !row.proposedPhotoId || !conn) return;
if (row.source === 'own-photo') {
// Already this connection's own, already-cropped photo -- just point
// the cover at it, no re-fetch/re-store.
conn.photoId = row.proposedPhotoId;
} else {
// An album cover -- a resolved photo, but new to THIS connection's own
// gallery, so it's copied in as its own stored entry rather than
// sharing/mutating the album's own stored blob.
const blob = await photoGet(row.proposedPhotoId);
if (!blob) return;
const newId = await storePhoto(blob);
if (!Array.isArray(conn.photoIds)) conn.photoIds = [];
conn.photoIds.unshift(newId);
conn.photoId = newId;
}
queueSave();
import('./connections.js').then((m) => m.renderConnections());
qualityResults = qualityResults.filter((r) => r.connId !== connId);
renderPhotoQuality();
}

// Reuses the same "before → after" circular-thumbnail comparison
// photoalbums.js's own duplicate-photo Compare screen already uses
// (.album-compare/.compare-arrow), rather than a new pair of classes for
// what's visually the identical idea.
function photoQualityRowHtml(row) {
const currentThumb = row.currentPhotoId
? `<span class="thumb-img" data-photo-bg="${escapeHtml(row.currentPhotoId)}" title="Current cover"></span>`
: '<span class="thumb-img thumb-img-empty" title="No cover on file"></span>';
const proposedThumb = row.proposedPhotoId
? `<span class="thumb-img" data-photo-bg="${escapeHtml(row.proposedPhotoId)}" title="Proposed replacement"></span>`
: null;
const sourceLabel = row.source === 'own-photo' ? 'already-saved photo' : row.source === 'album-cover' ? 'linked album cover' : '';
return `<div class="quality-row">
<span class="quality-name">${escapeHtml(row.name)}</span>
<span class="album-compare">
${currentThumb}
<span class="compare-arrow">&rarr;</span>
${proposedThumb || '<em class="settings-note" style="margin:0;">no replacement found</em>'}
</span>
${sourceLabel ? `<span class="settings-note" style="margin:0;">${escapeHtml(sourceLabel)}</span>` : ''}
${row.proposedPhotoId ? `<button class="sync-btn" type="button" data-apply-quality="${escapeHtml(row.connId)}">Use this</button>` : ''}
</div>`;
}

function renderPhotoQuality() {
const el = document.getElementById('photo-quality-results');
if (!el) return;
if (qualityResults === null) {
el.innerHTML = '<div class="settings-note" style="margin:0;">Click "Scan" to check every connection\'s cover photo against a higher-res photo already saved for them, or their linked Photos album\'s cover.</div>';
return;
}
if (!qualityResults.length) {
el.innerHTML = '<div class="settings-note" style="margin:0;">Nothing flagged — every cover photo on file looks like a real upload, not a placeholder crop.</div>';
return;
}
el.innerHTML = `<div class="settings-note" style="margin:0 0 6px;">${qualityResults.length} flagged</div>${qualityResults.map(photoQualityRowHtml).join('')}`;
hydratePhotoBackgrounds(el);
el.querySelectorAll('[data-apply-quality]').forEach((btn) => {
btn.addEventListener('click', () => applyProposedCover(btn.dataset.applyQuality));
});
}

function initPhotoQuality() {
const btn = document.getElementById('photo-quality-scan-btn');
if (!btn) return; // panel not in this build's DOM
btn.addEventListener('click', async () => {
btn.disabled = true;
btn.textContent = 'Scanning…';
qualityResults = await scanPhotoQuality();
renderPhotoQuality();
btn.disabled = false;
btn.textContent = 'Scan';
});
renderPhotoQuality();
}

export { initPhotoQuality, scanPhotoQuality, applyProposedCover, isPlaceholderPhoto };
