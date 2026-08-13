// Bulk triage for a pile of dating-app screenshots.
//
// The expensive way to work through an album is to fully parse every image.
// This does a cheap pass first — a small model reading only name, age, what
// kind of screenshot it is, and whether there's enough detail to be worth
// more — then lets you pick which ones earn a full parse.
//
// Every result is cached against a hash of the image bytes, so re-scanning
// the same album costs nothing. That matters because reviewing an album is
// something you do repeatedly as it grows.
import { data, queueSave, blankTask } from '../state.js';
import { uid, escapeHtml, resizeImageToBlob } from '../utils.js';
import { photoPut } from '../db.js';
import { MissingKeyError, quickScanScreenshot, extractProfileFromScreenshot } from '../ai.js';

// Scan results for the current batch. Not persisted: they're a working set
// for one review session, and the underlying cache means recreating them is
// free anyway.
let scanned = [];

function statusEl() { return document.getElementById('scan-status'); }

function summaryLine() {
if (scanned.length === 0) return '';
const cached = scanned.filter((s) => s.fromCache).length;
const rich = scanned.filter((s) => s.richness === 'rich').length;
const named = scanned.filter((s) => s.name).length;
return `${scanned.length} scanned · ${named} with a name · ${rich} look detailed · ${cached} already cached (free)`;
}

function rowHtml(s, i) {
const already = data.connections.find((c) => c.name.toLowerCase() === String(s.name || '').toLowerCase());
return `<div class="scan-row${s.chosen ? ' chosen' : ''}" data-scan-row="${i}">
<span class="scan-thumb" data-scan-thumb="${i}"></span>
<span class="scan-main">
<span class="scan-name">${escapeHtml(s.name || '(no name found)')}${s.age ? `, ${escapeHtml(s.age)}` : ''}</span>
<span class="scan-meta">
${escapeHtml(s.kind)}${s.richness === 'rich' ? ' · detailed' : ''}${s.captureDate ? ` · taken ${escapeHtml(s.captureDate)}` : ''}${s.fromCache ? ' · cached' : ''}
${already ? ` · <strong>matches ${escapeHtml(already.name)}</strong>` : (s.name ? ' · new person' : '')}
</span>
${s.rich ? `<span class="scan-rich">${escapeHtml([s.rich.job, s.rich.height, s.rich.education, s.rich.bio].filter(Boolean).join(' · ').slice(0, 160))}</span>` : ''}
</span>
<span class="scan-actions">
<button class="sync-btn" type="button" data-scan-parse="${i}"${s.rich ? ' disabled' : ''}>${s.rich ? 'Parsed' : 'Full parse'}</button>
<button class="add-btn" type="button" data-scan-save="${i}"${s.name ? '' : ' disabled'}>${already ? 'Merge in' : 'Add'}</button>
</span>
</div>`;
}

function render() {
const el = document.getElementById('scan-results');
if (!el) return;
document.getElementById('scan-summary').textContent = summaryLine();
if (scanned.length === 0) {
el.innerHTML = '<div class="empty">Pick a batch of screenshots to scan. The cheap pass reads just a name and age, and flags which ones are worth a full parse.</div>';
return;
}
// Named and detailed first — those are the ones you can act on.
const order = scanned.map((s, i) => ({ s, i }))
.sort((a, b) => (b.s.richness === 'rich') - (a.s.richness === 'rich') || (!!b.s.name - !!a.s.name));
el.innerHTML = order.map(({ s, i }) => rowHtml(s, i)).join('');

order.forEach(({ s, i }) => {
const thumb = el.querySelector(`[data-scan-thumb="${i}"]`);
if (thumb && s.previewUrl) {
const img = document.createElement('img');
img.src = s.previewUrl;
thumb.appendChild(img);
}
});
el.querySelectorAll('[data-scan-parse]').forEach((btn) => {
btn.addEventListener('click', () => richParse(parseInt(btn.dataset.scanParse, 10)));
});
el.querySelectorAll('[data-scan-save]').forEach((btn) => {
btn.addEventListener('click', () => saveToConnections(parseInt(btn.dataset.scanSave, 10)));
});
}

async function richParse(index) {
const s = scanned[index];
if (!s) return;
statusEl().textContent = `Full parse of ${s.name || 'screenshot'}…`;
try {
const rich = await extractProfileFromScreenshot(s.file, s.app);
s.rich = rich;
if (!s.name && rich.name) s.name = rich.name;
if (!s.age && rich.age) s.age = rich.age;
statusEl().textContent = rich.fromCache ? 'Loaded from cache — no charge.' : 'Parsed.';
render();
} catch (err) {
statusEl().textContent = err instanceof MissingKeyError
? 'Add an Anthropic API key in Settings first.'
: `Parse failed: ${err.message || err}`;
console.error('Rich parse failed:', err);
}
}

// Creates a connection, or merges into the one already matching that name.
// The screenshot's capture date becomes ageAsOf, so an age read off an old
// screenshot ages forward rather than pretending to be current.
async function saveToConnections(index) {
const s = scanned[index];
if (!s || !s.name) return;
const rich = s.rich || {};
const existing = data.connections.find((c) => c.name.toLowerCase() === s.name.toLowerCase());

const photoIds = [];
const blobs = (rich.photoBlobs && rich.photoBlobs.length) ? rich.photoBlobs : [await resizeImageToBlob(s.file, 1200, 0.85)];
for (const blob of blobs.filter(Boolean).slice(0, 6)) {
const id = uid();
await photoPut(id, blob);
photoIds.push(id);
}

const fill = (target) => {
const set = (field, value) => { if (value && !String(target[field] || '').trim()) target[field] = value; };
set('age', s.age || rich.age);
if (target.age && !target.ageAsOf) target.ageAsOf = s.captureDate || '';
set('height', rich.height);
set('education', rich.education);
set('job', rich.job);
set('kids', rich.kids);
set('location', rich.location);
if (rich.bio && !String(target.notes || '').includes(rich.bio)) {
target.notes = target.notes ? `${target.notes}\n${rich.bio}` : rich.bio;
}
(rich.languages || []).forEach((l) => { if (!target.languages.includes(l)) target.languages.push(l); });
(rich.nationality || []).forEach((n) => { if (!target.nationality.includes(n)) target.nationality.push(n); });
photoIds.forEach((id) => { if (!target.photoIds.includes(id)) target.photoIds.push(id); });
if (!target.photoId) target.photoId = target.photoIds[0] || null;
};

if (existing) {
fill(existing);
statusEl().textContent = `Merged into ${existing.name}.`;
} else {
const conn = {
id: uid(), name: s.name, profileName: s.name, app: s.app || 'Other', priority: 3,
stage: 'Matched', lastContact: new Date().toISOString().slice(0, 10),
photoId: photoIds[0] || null, photoIds,
age: s.age || rich.age || '', ageAsOf: s.captureDate || '', dob: '',
location: rich.location || '', address: '', kids: rich.kids || '', job: rich.job || '',
height: rich.height || '', education: rich.education || '',
phone: '', email: '', contactStatus: '', contactResourceName: '', contactEtag: '',
contactConflicts: [], likes: '', notes: rich.bio || '',
languages: rich.languages || [], nationality: rich.nationality || [],
todos: [], tags: [], aliases: [], dateLocations: [], dateEvents: [], sexTags: [],
ratings: {}, driveLink: '', photosAlbumUrl: '', photosPersonUrl: '',
};
data.connections.push(conn);
statusEl().textContent = `Added ${conn.name}.`;
}
s.saved = true;
queueSave();
Promise.all([import('./connections.js'), import('./overview.js')])
.then(([c, o]) => { c.renderConnections(); o.renderOverview(); });
render();
}

function initPhotoScan() {
const input = document.getElementById('scan-input');
if (!input) return;

input.addEventListener('change', async (e) => {
const files = Array.from(e.target.files);
e.target.value = '';
if (files.length === 0) return;
const app = document.getElementById('import-app-input').value;
scanned = [];
render();

let done = 0;
let billed = 0;
for (const file of files) {
statusEl().textContent = `Scanning ${++done} of ${files.length}…`;
try {
const result = await quickScanScreenshot(file, app);
if (!result.fromCache) billed++;
scanned.push({
...result, file, app,
previewUrl: URL.createObjectURL(file),
});
} catch (err) {
console.error('Quick scan failed for', file.name, err);
if (err instanceof MissingKeyError) {
statusEl().textContent = 'Add an Anthropic API key in Settings first.';
return;
}
}
render();
}
statusEl().textContent = `Scanned ${scanned.length}. ${billed} cost anything; ${scanned.length - billed} came from cache.`;
});

const clearBtn = document.getElementById('scan-clear-btn');
if (clearBtn) {
clearBtn.addEventListener('click', () => {
scanned.forEach((s) => { if (s.previewUrl) URL.revokeObjectURL(s.previewUrl); });
scanned = [];
statusEl().textContent = '';
render();
});
}
render();
}

export { initPhotoScan };
