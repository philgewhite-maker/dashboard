// Imports a Tinder web profile: paste the JSON a console snippet copies
// from a profile page (run in the browser, not fetched by this app — a
// dating site's own page can't be read cross-origin any more than Google
// Photos can) and review what it found before merging into a connection.
//
// Unlike the Google Photos album covers, Tinder's profile photos load from
// a public CDN with no login required (verified: a photo URL pulled from a
// real captured page loads anonymously with curl), so there's no
// byte-capture trick needed here — a plain fetch() is enough.
import { data, queueSave } from '../state.js';
import { escapeHtml, uid, todayStr, hydratePhotos } from '../utils.js';
import { nameKey, editDistance } from '../googlecontacts.js';
import { storePhoto } from '../files.js';

// Same two-pass approach as the other import paths (screenshot scan, album
// linking): exact name match first, then a deliberately loose pass whose
// result is only ever offered as a pre-selected guess to confirm, never
// applied silently. Kept local rather than imported from connections.js to
// avoid a circular dependency — connections.js is the one importing this
// module's init function, not the other way round.
function matchPerson(name) {
const key = nameKey(name);
if (!key) return null;
const namesOf = (c) => [c.name, c.profileName, ...(c.aliases || [])].filter(Boolean);
const exact = data.connections.find((c) => namesOf(c).some((n) => nameKey(n) === key));
if (exact) return exact;
let best = null;
let bestScore = -1;
data.connections.forEach((c) => {
namesOf(c).forEach((n) => {
const nk = nameKey(n);
let score = -1;
if (nk.startsWith(key) || key.startsWith(nk)) score = 100 - Math.abs(nk.length - key.length);
else if (key.length >= 4) { const d = editDistance(key, nk, 2); if (d <= 2) score = 60 - d * 10; }
if (score > bestScore) { bestScore = score; best = c; }
});
});
return best;
}

function createConnectionFor(name) {
const conn = {
id: uid(), name, profileName: '', app: 'Tinder', priority: 3, stage: 'Matched', lastContact: todayStr(), createdAt: new Date().toISOString(),
photoId: null, photoIds: [], photoAlbums: [], age: '', dob: '', ageAsOf: '', location: '', address: '',
kids: '', job: '', height: '', education: '', phone: '', email: '',
contactStatus: '', contactResourceName: '', contactEtag: '', contactConflicts: [],
likes: '', notes: '', languages: [], nationality: [],
todos: [], tags: [], aliases: [], dateLocations: [], dateEvents: [], sexTags: [],
ratings: {}, driveLink: '', photosAlbumUrl: '', photosPersonUrl: '',
};
data.connections.push(conn);
return conn;
}

// A handful of field labels map straight onto an existing connection field.
// Everything else Tinder shows (communication style, zodiac, "Looking
// for", prompt answers like "My biography would be called: ...") has no
// dedicated field in this app, so it's kept as a readable line appended to
// notes instead of being dropped — same fallback the screenshot importer
// uses for a bio it can't otherwise place.
const FIELD_MAP = { 'Family plans': 'kids', Education: 'education', Height: 'height', Work: 'job', 'Job title': 'job', Job: 'job' };

let pending = null; // { name, age, fields: [{label, value, apply}], photos: [{url, apply}], chosenId }

function optionsFor(chosenId) {
return `<option value=""${chosenId ? '' : ' selected'}>— pick who this is —</option>`
+ data.connections.slice().sort((a, b) => a.name.localeCompare(b.name))
.map((c) => `<option value="${escapeHtml(c.id)}"${c.id === chosenId ? ' selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
}

function render() {
const el = document.getElementById('tinder-review');
if (!el) return;
if (!pending) { el.innerHTML = ''; return; }
const p = pending;
el.innerHTML = `<div class="album-card">
<div class="album-caption"><strong>${escapeHtml(p.name || '(no name found)')}</strong>${p.age ? `, ${escapeHtml(p.age)}` : ''}</div>
<select id="tinder-pick">${optionsFor(p.chosenId)}</select>
${!p.chosenId ? '<button class="sync-btn sm" type="button" id="tinder-newconn">+ New connection</button>' : ''}
${p.fields.length ? `<div class="tinder-fields">${p.fields.map((f, i) => `<label class="tinder-field-row">
<input type="checkbox" data-tinder-field="${i}"${f.apply ? ' checked' : ''}> <strong>${escapeHtml(f.label)}:</strong> ${escapeHtml(f.value)}
</label>`).join('')}</div>` : ''}
${p.photos.length ? `<div class="photo-gallery" style="margin-top:8px;">${p.photos.map((ph, i) => `<span class="gallery-thumb" data-tinder-photo="${i}" style="${ph.apply ? '' : 'opacity:.35;'}"><img src="${escapeHtml(ph.url)}" alt=""></span>`).join('')}</div>` : ''}
<div class="sync-row" style="margin-top:8px;">
<button class="add-btn" type="button" id="tinder-save"${p.chosenId ? '' : ' disabled'}>Save to connection</button>
<span class="sync-status" id="tinder-save-status"></span>
</div>
</div>`;

const pick = document.getElementById('tinder-pick');
if (pick) pick.addEventListener('change', () => { pending.chosenId = pick.value; render(); });
const newBtn = document.getElementById('tinder-newconn');
if (newBtn) newBtn.addEventListener('click', () => { pending.chosenId = createConnectionFor(pending.name || 'Unnamed').id; render(); });
el.querySelectorAll('[data-tinder-field]').forEach((cb) => {
cb.addEventListener('change', () => { pending.fields[parseInt(cb.dataset.tinderField, 10)].apply = cb.checked; });
});
el.querySelectorAll('[data-tinder-photo]').forEach((span) => {
span.addEventListener('click', () => {
const ph = pending.photos[parseInt(span.dataset.tinderPhoto, 10)];
ph.apply = !ph.apply;
render();
});
});
const saveBtn = document.getElementById('tinder-save');
if (saveBtn) saveBtn.addEventListener('click', save);
}

async function save() {
if (!pending || !pending.chosenId) return;
const conn = data.connections.find((c) => c.id === pending.chosenId);
if (!conn) return;
const status = document.getElementById('tinder-save-status');
if (status) status.textContent = 'Saving…';

if (pending.age && pending.age !== conn.age) { conn.age = pending.age; conn.ageAsOf = todayStr(); }

pending.fields.filter((f) => f.apply).forEach((f) => {
const target = FIELD_MAP[f.label];
if (target) {
if (!String(conn[target] || '').trim()) conn[target] = f.value;
return;
}
const line = `${f.label}: ${f.value}`;
if (!String(conn.notes || '').includes(line)) conn.notes = conn.notes ? `${conn.notes}\n${line}` : line;
});

const toFetch = pending.photos.filter((ph) => ph.apply);
let failed = 0;
for (const ph of toFetch) {
try {
const blob = await fetch(ph.url).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.blob(); });
const id = await storePhoto(blob);
if (!conn.photoIds.includes(id)) conn.photoIds.push(id);
if (!conn.photoId) conn.photoId = id;
} catch (err) {
console.error('Could not fetch Tinder photo:', err);
failed++;
}
}

queueSave();
if (status) status.textContent = `Saved to ${conn.name}.${failed ? ` ${failed} photo${failed === 1 ? '' : 's'} failed.` : ''}`;
pending = null;
render();
Promise.all([import('./connections.js'), import('./overview.js')])
.then(([c, o]) => { c.renderConnections(); o.renderOverview(); hydratePhotos(document.getElementById('conn-list') || document.body); });
}

function parseInput(text) {
const trimmed = String(text || '').trim();
if (!trimmed) return null;
const raw = JSON.parse(trimmed);
const fields = Array.isArray(raw.fields) ? raw.fields
.map((f) => ({ label: String(f.label || '').trim(), value: String(f.value || '').trim() }))
.filter((f) => f.label && f.value) : [];
const photos = Array.isArray(raw.photos) ? [...new Set(raw.photos.map((u) => String(u || '').trim()).filter(Boolean))] : [];
return {
name: String(raw.name || '').trim(),
age: String(raw.age || '').trim(),
fields: fields.map((f) => ({ ...f, apply: true })),
photos: photos.map((url) => ({ url, apply: true })),
chosenId: '',
};
}

function initTinderImport() {
const box = document.getElementById('tinder-input');
if (!box) return;
const status = document.getElementById('tinder-status');

document.getElementById('tinder-import-btn').addEventListener('click', () => {
let parsed;
try {
parsed = parseInput(box.value);
} catch (err) {
status.textContent = `Couldn't read that: ${err.message}. Paste the JSON the snippet copied.`;
return;
}
if (!parsed) { status.textContent = 'Paste the copied JSON first.'; return; }
const match = matchPerson(parsed.name);
parsed.chosenId = match ? match.id : '';
pending = parsed;
status.textContent = match ? `Matched ${match.name} — check the fields below, then save.` : 'No matching connection — pick one or add new.';
render();
});

const copyBtn = document.getElementById('tinder-copy-snippet');
if (copyBtn) {
copyBtn.addEventListener('click', async () => {
try {
await navigator.clipboard.writeText(document.getElementById('tinder-snippet').textContent);
copyBtn.textContent = 'Copied';
setTimeout(() => { copyBtn.textContent = 'Copy snippet'; }, 2000);
} catch (e) {
status.textContent = 'Copy failed — select the snippet and copy it manually.';
}
});
}
render();
}

export { initTinderImport };
