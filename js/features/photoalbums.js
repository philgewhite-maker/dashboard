// Links Google Photos albums to connections, using a "Name_Label" title
// convention.
//
// This replaces an earlier attempt that matched *face groups* from the
// people page. That was a dead end: a face-group URL is a /search/ link
// whose token doesn't survive, so the links stopped resolving. An album is a
// real, permanent, shareable object, so its URL is safe to store.
//
// Titles carry the identity:
//   "Kat_"        -> person "Kat",  label ""        (their default album)
//   "Kat_x"       -> person "Kat",  label "x"       (kept private, see below)
//   "Kat_Lisbon"  -> person "Kat",  label "Lisbon"
//
// The trailing underscore is what makes the prefix unambiguous — without it
// "Kat" would also prefix-match "Katerina".
//
// Matching by name happens ONCE, at import; what gets stored is the album
// URL. So renaming an album later doesn't break an already-linked person.
import { data, queueSave, TAG_FIELDS } from '../state.js';
import { escapeHtml } from '../utils.js';
import { nameKey, editDistance } from '../googlecontacts.js';

// Album titles are the only thing carrying identity, so a title that doesn't
// fit the convention can't be matched — it's reported rather than guessed at.
function parseAlbumTitle(title) {
const raw = String(title || '').trim();
const at = raw.indexOf('_');
if (at <= 0) return null;
return { person: raw.slice(0, at).trim(), label: raw.slice(at + 1).trim(), title: raw };
}

// What to show under a thumbnail: the person's name for a plain "Name_", the
// qualifier for anything else — since these are grouped under the person
// already, repeating the name would just be noise.
function captionFor(album) {
return album.label || album.person;
}

// Albums whose label marks them sensitive follow the same device-local
// visibility switch as the sensitive tag fields, so a shared screen doesn't
// surface them. Deliberately a small, explicit list rather than a guess.
const SENSITIVE_LABELS = new Set(['x', 'xx', 'nsfw', 'private']);
function isSensitive(album) {
return SENSITIVE_LABELS.has(String(album.label || '').toLowerCase());
}

function parseInput(text) {
const trimmed = String(text || '').trim();
if (!trimmed) return { albums: [], people: [] };
const parsed = JSON.parse(trimmed);
const rows = Array.isArray(parsed) ? parsed : (parsed.albums || []);
const albums = rows.map((r) => ({
title: String(r.title || r.label || '').trim(),
url: String(r.url || r.href || '').trim(),
cover: String(r.cover || '').trim(),
count: Number(r.count) || 0,
})).filter((a) => a.title && a.url);
const people = (Array.isArray(parsed) ? [] : (parsed.people || []))
.map((p) => String(p.name || p).trim()).filter(Boolean);
return { albums, people };
}

// Same two-pass approach as the contacts matcher: exact on any known name
// first, then a deliberately loose pass whose results are always presented
// as guesses to confirm, never applied silently.
function matchPerson(person) {
const key = nameKey(person);
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
if (nk.startsWith(key) || key.startsWith(nk)) {
score = 100 - Math.abs(nk.length - key.length);
why = 'shortened name';
} else if (key.length >= 4) {
const d = editDistance(key, nk, 2);
if (d <= 2) { score = 60 - d * 10; why = `${d} letter${d === 1 ? '' : 's'} different`; }
}
if (score !== null && (!best || score > best.score)) best = { conn: c, why, score };
});
});
return best;
}

let rows = [];        // one per album: {title, url, cover, person, label, chosenId, match}
let unparsed = [];    // album titles with no underscore
let peopleSeen = [];  // face-group names from the people page, for the gap check

function optionsFor(chosenId) {
return `<option value=""${chosenId ? '' : ' selected'}>— skip —</option>`
+ data.connections.slice().sort((a, b) => a.name.localeCompare(b.name))
.map((c) => `<option value="${escapeHtml(c.id)}"${c.id === chosenId ? ' selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
}

function thumbHtml(row, i) {
// The cover is rendered straight from its Google URL rather than copied.
// Those URLs load fine in an <img> without credentials, and re-hosting
// them isn't possible from the browser anyway — reading the bytes
// cross-origin is blocked, even though displaying them isn't.
const img = row.cover
? `<img src="${escapeHtml(row.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
: '<span class="album-nocover">no cover</span>';
return `<div class="album-card${row.applied ? ' chosen' : ''}${isSensitive(row) ? ' album-sensitive' : ''}">
<a class="album-thumb" href="${escapeHtml(row.url)}" target="_blank" rel="noopener" title="${escapeHtml(row.title)}">${img}</a>
<div class="album-caption">${escapeHtml(captionFor(row))}</div>
<div class="album-meta">${escapeHtml(row.match ? row.match.why : 'no match')}${row.count ? ` · ${row.count}` : ''}</div>
<select data-album-pick="${i}">${optionsFor(row.chosenId)}</select>
</div>`;
}

// The three gaps worth acting on. The third is the one that's hard to notice
// by eye: someone has a face group in Photos but no album, so they'd never
// show up in an album-based import at all.
function gapsHtml() {
const linked = new Set(rows.filter((r) => r.chosenId).map((r) => r.chosenId));
const albumPeople = new Set(rows.map((r) => nameKey(r.person)));

const noAlbum = data.connections.filter((c) => !(c.photoAlbums || []).length && !linked.has(c.id));
const noPerson = rows.filter((r) => !r.chosenId);
const faceNoAlbum = peopleSeen.filter((n) => !albumPeople.has(nameKey(n)));

const section = (title, items, hint) => items.length
? `<div class="album-gap"><strong>${escapeHtml(title)} (${items.length})</strong>
<div class="album-gap-hint">${escapeHtml(hint)}</div>
<div class="album-gap-items">${items.map((t) => `<span class="album-gap-item">${escapeHtml(t)}</span>`).join('')}</div></div>`
: '';

return section('Connections with no album', noAlbum.map((c) => c.name),
'Nothing in Photos titled "Name_" for these — worth creating one.')
+ section('Albums with no connection', noPerson.map((r) => r.title),
'Either the name differs from the dashboard, or they are not tracked yet.')
+ section('Faces in Photos with no album', faceNoAlbum,
'Google has grouped these people, but there is no matching album yet.')
+ (unparsed.length ? section('Albums not following Name_Label', unparsed,
'Rename with an underscore after the name to include them.') : '');
}

function render() {
const el = document.getElementById('albums-results');
if (!el) return;
const count = document.getElementById('albums-count');

if (rows.length === 0 && peopleSeen.length === 0) {
if (count) count.textContent = '';
el.innerHTML = '';
return;
}
const ready = rows.filter((r) => r.chosenId && !r.applied).length;
if (count) count.textContent = `${rows.length} albums · ${ready} ready to link`;

// Grouped under the connection they'll attach to, so several albums for
// one person read as a set rather than scattered tiles.
const byConn = new Map();
const unmatched = [];
rows.forEach((row, i) => {
if (!row.chosenId) { unmatched.push(i); return; }
if (!byConn.has(row.chosenId)) byConn.set(row.chosenId, []);
byConn.get(row.chosenId).push(i);
});

const groups = [...byConn].map(([id, idxs]) => {
const conn = data.connections.find((c) => c.id === id);
return `<div class="album-group">
<h4>${escapeHtml(conn ? conn.name : 'Unknown')}</h4>
<div class="album-grid">${idxs.map((i) => thumbHtml(rows[i], i)).join('')}</div>
</div>`;
}).join('');

const loose = unmatched.length ? `<div class="album-group">
<h4>Not matched</h4>
<div class="album-grid">${unmatched.map((i) => thumbHtml(rows[i], i)).join('')}</div>
</div>` : '';

el.innerHTML = groups + loose
+ `<div class="sync-row" style="margin-top:10px;">
<button class="add-btn" type="button" id="albums-apply"${ready ? '' : ' disabled'}>Save ${ready} link${ready === 1 ? '' : 's'}</button>
</div>`
+ gapsHtml();

el.querySelectorAll('[data-album-pick]').forEach((sel) => {
sel.addEventListener('change', () => {
const row = rows[parseInt(sel.dataset.albumPick, 10)];
row.chosenId = sel.value;
row.applied = false;
render();
});
});
const apply = document.getElementById('albums-apply');
if (apply) apply.addEventListener('click', save);
}

function save() {
let n = 0;
rows.forEach((row) => {
if (!row.chosenId || row.applied) return;
const conn = data.connections.find((c) => c.id === row.chosenId);
if (!conn) return;
if (!Array.isArray(conn.photoAlbums)) conn.photoAlbums = [];
// Keyed on the URL, so re-importing after a title change updates the
// label in place instead of adding a duplicate album.
const existing = conn.photoAlbums.find((a) => a.url === row.url);
if (existing) Object.assign(existing, { label: row.label, cover: row.cover, title: row.title });
else conn.photoAlbums.push({ label: row.label, url: row.url, cover: row.cover, title: row.title });

// A trip album doubles as a date-location; "Kat_Lisbon" is exactly the
// sort of thing that field exists for. Sensitive labels are never
// promoted into a tag.
if (row.label && !isSensitive(row) && TAG_FIELDS.some((f) => f.field === 'dateLocations')) {
if (!Array.isArray(conn.dateLocations)) conn.dateLocations = [];
if (!conn.dateLocations.some((v) => nameKey(v) === nameKey(row.label))) conn.dateLocations.push(row.label);
}
row.applied = true;
n++;
});
if (!n) return;
queueSave();
document.getElementById('albums-status').textContent = `Linked ${n} album${n === 1 ? '' : 's'}.`;
Promise.all([import('./connections.js'), import('./overview.js')])
.then(([c, o]) => { c.renderConnections(); o.renderOverview(); });
render();
}

function initPhotoAlbums() {
const box = document.getElementById('albums-input');
if (!box) return;
const status = document.getElementById('albums-status');

document.getElementById('albums-match-btn').addEventListener('click', () => {
let parsed;
try {
parsed = parseInput(box.value);
} catch (err) {
status.textContent = `Couldn't read that: ${err.message}. Paste the JSON the snippet copied.`;
return;
}
peopleSeen = parsed.people;
unparsed = [];
rows = [];
parsed.albums.forEach((a) => {
const bits = parseAlbumTitle(a.title);
if (!bits) { unparsed.push(a.title); return; }
const match = matchPerson(bits.person);
rows.push({ ...a, ...bits, match, chosenId: match ? match.conn.id : '', applied: false });
});
const matched = rows.filter((r) => r.chosenId).length;
status.textContent = rows.length === 0 && unparsed.length === 0
? 'No albums found in that paste.'
: `${rows.length} album${rows.length === 1 ? '' : 's'} · ${matched} matched${unparsed.length ? ` · ${unparsed.length} not following Name_Label` : ''}${peopleSeen.length ? ` · ${peopleSeen.length} faces seen` : ''}. Check each, then save.`;
render();
});

document.getElementById('albums-clear-btn').addEventListener('click', () => {
box.value = '';
rows = []; unparsed = []; peopleSeen = [];
status.textContent = '';
render();
});

const copyBtn = document.getElementById('albums-copy-snippet');
if (copyBtn) {
copyBtn.addEventListener('click', async () => {
try {
await navigator.clipboard.writeText(document.getElementById('albums-snippet').textContent);
copyBtn.textContent = 'Copied';
setTimeout(() => { copyBtn.textContent = 'Copy snippet'; }, 2000);
} catch (e) {
status.textContent = 'Copy failed — select the snippet and copy it manually.';
}
});
}
render();
}

export { initPhotoAlbums, parseAlbumTitle, captionFor, matchPerson, parseInput, isSensitive };
