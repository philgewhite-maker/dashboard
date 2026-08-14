// Imports a Tinder web profile: paste the JSON a console snippet copies
// from a profile page (run in the browser, not fetched by this app — a
// dating site's own page can't be read cross-origin any more than Google
// Photos can) and review what it found before merging into a connection.
//
// Unlike the Google Photos album covers, Tinder's profile photos load from
// a public CDN with no login required (verified: a photo URL pulled from a
// real captured page loads anonymously, including CORS headers that permit
// fetch() from another origin), so there's no byte-capture trick needed
// here — a plain fetch() is enough.
//
// A loose name match previously auto-selected the target connection with no
// visual check at all — "Leila" (edit-distance 2 from "Lenka") got matched
// and saved into Lenka's record before anyone looked at a photo. Every
// non-exact match now requires an explicit "yes, same person" confirmation
// next to a side-by-side photo (and an AI opinion, same as the album
// importer), and the chosen connection's photo stays visible for the whole
// review regardless of how it got picked, so a wrong dropdown pick is just
// as visible as a wrong auto-match was invisible before.
import { data, queueSave } from '../state.js';
import { escapeHtml, uid, todayStr, hydratePhotos } from '../utils.js';
import { nameKey, editDistance } from '../googlecontacts.js';
import { storePhoto } from '../files.js';
import { photoGet } from '../db.js';
import { MissingKeyError, compareFaces } from '../ai.js';

// Same two-pass approach as the other import paths (screenshot scan, album
// linking): exact name match first, then a deliberately loose pass. Kept
// local rather than imported from connections.js to avoid a circular
// dependency — connections.js is the one importing this module's init
// function, not the other way round.
function matchPerson(name) {
const key = nameKey(name);
if (!key) return null;
const namesOf = (c) => [c.name, c.profileName, ...(c.aliases || [])].filter(Boolean);
const exact = data.connections.find((c) => namesOf(c).some((n) => nameKey(n) === key));
if (exact) return { conn: exact, why: 'exact', score: 200 };
let best = null;
data.connections.forEach((c) => {
namesOf(c).forEach((n) => {
const nk = nameKey(n);
let score = null;
let why = '';
if (nk.startsWith(key) || key.startsWith(nk)) { score = 100 - Math.abs(nk.length - key.length); why = 'shortened name'; }
else if (key.length >= 4) {
const d = editDistance(key, nk, 2);
if (d <= 2) { score = 60 - d * 10; why = `${d} letter${d === 1 ? '' : 's'} different`; }
}
if (score !== null && (!best || score > best.score)) best = { conn: c, why, score };
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

let pending = null; // { name, age, fields, photos, chosenId, match, matchConfirmed, aiVerdict }

function optionsFor(chosenId) {
return `<option value=""${chosenId ? '' : ' selected'}>— pick who this is —</option>`
+ data.connections.slice().sort((a, b) => a.name.localeCompare(b.name))
.map((c) => `<option value="${escapeHtml(c.id)}"${c.id === chosenId ? ' selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
}

// The one thing that was missing when this went wrong: a face to look at.
// Shown for ANY chosen connection, not just a loose-match suggestion — a
// manually picked wrong person from the dropdown deserves the same check.
function compareHtml() {
const conn = data.connections.find((c) => c.id === pending.chosenId);
if (!conn) return '';
const incoming = pending.photos[0];
const aiEligible = conn.photoId && incoming;
return `<div class="album-compare-row" style="margin:8px 0;">
<span class="album-compare">
${conn.photoId ? `<span class="thumb-img" data-photo-id="${escapeHtml(conn.photoId)}"></span>` : '<span class="album-nocover" style="width:32px;height:32px;border-radius:50%;">no photo</span>'}
<span class="compare-arrow">&harr;</span>
${incoming ? `<span class="thumb-img"><img src="${escapeHtml(incoming.url)}" alt=""></span>` : '<span class="album-nocover" style="width:32px;height:32px;border-radius:50%;">no photo</span>'}
</span>
${aiEligible ? aiCompareHtml() : ''}
</div>`;
}

function aiCompareHtml() {
if (pending.aiVerdict === 'loading') return '<div class="album-ai-compare loading">Comparing…</div>';
if (pending.aiVerdict) {
const v = pending.aiVerdict;
const cls = v.same === true ? 'yes' : v.same === false ? 'no' : 'unsure';
const label = v.same === true ? 'AI: looks like the same person' : v.same === false ? 'AI: these look like different people' : 'AI: unsure';
return `<div class="album-ai-compare ${cls}">${escapeHtml(label)}${v.reason ? ` — ${escapeHtml(v.reason)}` : ''}</div>`;
}
return '<button class="sync-btn sm" type="button" id="tinder-ai-compare">AI compare faces</button>';
}

async function runAiCompare() {
pending.aiVerdict = 'loading';
render();
try {
const conn = data.connections.find((c) => c.id === pending.chosenId);
const incoming = pending.photos[0];
const [existing, incomingBlob] = await Promise.all([
photoGet(conn.photoId),
fetch(incoming.url).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.blob(); }),
]);
if (!existing) throw new Error("This connection's existing photo isn't on this device — run Photo sync in Settings first.");
pending.aiVerdict = await compareFaces(existing, incomingBlob);
} catch (err) {
console.error('Face comparison failed:', err);
pending.aiVerdict = { same: null, reason: err instanceof MissingKeyError ? 'Add an Anthropic API key in Settings first.' : (err.message || String(err)) };
}
render();
}

// What will actually happen to each field if this gets saved right now,
// computed against whichever connection is currently chosen — a real
// preview rather than a blind checkbox list, so "this will overwrite
// something" or "this is already set and will be skipped" is visible
// before Save, not discovered after.
function fieldPreviewHtml(f, i) {
const conn = data.connections.find((c) => c.id === pending.chosenId);
const target = FIELD_MAP[f.label];
let note = 'will be added to notes';
let blocked = false;
if (conn && target) {
const current = String(conn[target] || '').trim();
if (current) { note = `already set to "${current}" — will be skipped`; blocked = true; }
else note = `will set ${f.label}`;
}
return `<label class="tinder-field-row${blocked ? ' tinder-field-blocked' : ''}">
<input type="checkbox" data-tinder-field="${i}"${f.apply && !blocked ? ' checked' : ''}${blocked ? ' disabled' : ''}>
<strong>${escapeHtml(f.label)}:</strong> ${escapeHtml(f.value)} <span class="tinder-field-note">(${escapeHtml(note)})</span>
</label>`;
}

function agePreviewHtml() {
const conn = data.connections.find((c) => c.id === pending.chosenId);
if (!pending.age) return '';
const current = conn ? String(conn.age || '').trim() : '';
const note = current ? `already set to ${current} — will be kept` : `will set age to ${pending.age}`;
return `<div class="tinder-field-row"><strong>Age:</strong> ${escapeHtml(pending.age)} <span class="tinder-field-note">(${escapeHtml(note)})</span></div>`;
}

function render() {
const el = document.getElementById('tinder-review');
if (!el) return;
if (!pending) { el.innerHTML = ''; return; }
const p = pending;
const showSuggestion = !p.chosenId && p.match && p.match.why !== 'exact';
const canSave = !!p.chosenId && (p.match?.why === 'exact' || p.matchConfirmed || !p.match || data.connections.find((c) => c.id === p.chosenId)?.createdJustNow);

el.innerHTML = `<div class="album-card">
<div class="album-caption"><strong>${escapeHtml(p.name || '(no name found)')}</strong>${p.age ? `, ${escapeHtml(p.age)}` : ''}</div>

${showSuggestion ? `<div class="settings-note" style="margin:4px 0;">Possible match: <strong>${escapeHtml(p.match.conn.name)}</strong> (${escapeHtml(p.match.why)}) — not the same as an exact name match, so look before confirming:</div>
<div class="album-compare-row" style="margin:4px 0 8px;">
<span class="album-compare">
${p.match.conn.photoId ? `<span class="thumb-img" data-photo-id="${escapeHtml(p.match.conn.photoId)}"></span>` : '<span class="album-nocover" style="width:32px;height:32px;border-radius:50%;">no photo</span>'}
<span class="compare-arrow">&harr;</span>
${p.photos[0] ? `<span class="thumb-img"><img src="${escapeHtml(p.photos[0].url)}" alt=""></span>` : '<span class="album-nocover" style="width:32px;height:32px;border-radius:50%;">no photo</span>'}
</span>
</div>
<div class="sync-row" style="margin:0 0 10px;">
<button class="sync-btn sm" type="button" id="tinder-confirm-match">Yes — same person</button>
<button class="sync-btn sm" type="button" id="tinder-reject-match">No — different person</button>
</div>` : ''}

<select id="tinder-pick">${optionsFor(p.chosenId)}</select>
${!p.chosenId ? '<button class="sync-btn sm" type="button" id="tinder-newconn">+ New connection</button>' : ''}
${p.chosenId ? compareHtml() : ''}

${agePreviewHtml()}
${p.fields.length ? `<div class="tinder-fields">${p.fields.map((f, i) => fieldPreviewHtml(f, i)).join('')}</div>` : ''}
${p.photos.length ? `<div class="settings-note" style="margin:8px 0 4px;">${p.photos.filter((ph) => ph.apply).length} of ${p.photos.length} photos will be added — click to include/exclude:</div>
<div class="photo-gallery">${p.photos.map((ph, i) => `<span class="gallery-thumb tinder-photo-thumb${ph.apply ? ' tinder-photo-included' : ''}" data-tinder-photo="${i}"><img src="${escapeHtml(ph.url)}" alt="">${ph.apply ? '<span class="tinder-photo-badge">&check;</span>' : ''}</span>`).join('')}</div>` : ''}

<div class="sync-row" style="margin-top:8px;">
<button class="add-btn" type="button" id="tinder-save"${canSave ? '' : ' disabled'}>Save to connection</button>
<span class="sync-status" id="tinder-save-status"></span>
</div>
</div>`;

const pick = document.getElementById('tinder-pick');
if (pick) pick.addEventListener('change', () => { pending.chosenId = pick.value; pending.matchConfirmed = false; pending.aiVerdict = null; render(); });
const newBtn = document.getElementById('tinder-newconn');
if (newBtn) newBtn.addEventListener('click', () => {
const conn = createConnectionFor(pending.name || 'Unnamed');
conn.createdJustNow = true; // not a persisted field — just marks this session's save as safe without a match confirmation
pending.chosenId = conn.id;
pending.matchConfirmed = true;
render();
});
const confirmBtn = document.getElementById('tinder-confirm-match');
if (confirmBtn) confirmBtn.addEventListener('click', () => { pending.chosenId = pending.match.conn.id; pending.matchConfirmed = true; render(); });
const rejectBtn = document.getElementById('tinder-reject-match');
if (rejectBtn) rejectBtn.addEventListener('click', () => { pending.match = null; render(); });
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
const aiBtn = document.getElementById('tinder-ai-compare');
if (aiBtn) aiBtn.addEventListener('click', runAiCompare);
const saveBtn = document.getElementById('tinder-save');
if (saveBtn) saveBtn.addEventListener('click', save);
}

async function save() {
if (!pending || !pending.chosenId) return;
const conn = data.connections.find((c) => c.id === pending.chosenId);
if (!conn) return;
const status = document.getElementById('tinder-save-status');
if (status) status.textContent = 'Saving…';

// Fill-if-empty, same rule as every other field — age previously
// overwrote unconditionally, which is what erased Lenka's real age when
// Leila's data landed on her record by mistake.
if (pending.age && !String(conn.age || '').trim()) { conn.age = pending.age; conn.ageAsOf = todayStr(); }

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
if (status) status.textContent = `Saved to ${conn.name}.${failed ? ` ${failed} of ${toFetch.length} photos failed — check the console for why.` : ''}`;
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
match: null,
matchConfirmed: false,
aiVerdict: null,
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
parsed.match = match;
// Only an EXACT name match is trusted enough to pre-select — anything
// looser (the "Leila"/"Lenka" mistake was 2 letters different) is shown
// as a suggestion requiring an explicit look-and-confirm instead.
if (match && match.why === 'exact') { parsed.chosenId = match.conn.id; parsed.matchConfirmed = true; }
pending = parsed;
status.textContent = match
? (match.why === 'exact' ? `Matched ${match.conn.name} exactly — check the fields below, then save.` : `Possible match found (${match.why}) — confirm it's really them before saving.`)
: 'No matching connection — pick one or add new.';
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
