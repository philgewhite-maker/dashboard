// Links Google Photos albums to connections, using a "Name_Label" title
// convention.
//
// This replaces an earlier attempt that matched *face groups* from the
// people page. That was a dead end: a face-group URL is a /search/ link
// whose token doesn't survive, so the links stopped resolving. An album is a
// real, permanent, shareable object, so its URL is safe to store.
//
// Titles are positional, underscore-separated:
//
//   <Name>_<Location or sensitive>_<Date>_<Other>
//
//   "Kat_"                  -> Kat, nothing else            (default album)
//   "Kat_x"                 -> Kat, sensitive               (kept private)
//   "Kat_Lisbon"            -> Kat, location Lisbon
//   "Alena__2026_Birthday"  -> Alena, NO location, 2026, Birthday
//
// Position matters precisely so that only the *second* field can become a
// location tag. An earlier version tagged everything after the underscore,
// which turned "Birthday" into a place.
//
// The trailing underscore is what makes the prefix unambiguous — without it
// "Kat" would also prefix-match "Katerina".
//
// Matching by name happens ONCE, at import; what gets stored is the album
// URL. So renaming an album later doesn't break an already-linked person.
import { data, queueSave, TAG_FIELDS } from '../state.js';
import { escapeHtml, uid, todayStr, hydratePhotos } from '../utils.js';
import { nameKey, editDistance } from '../googlecontacts.js';
import { photoGet } from '../db.js';
import { fetchProxiedImage, storePhoto } from '../files.js';
import { MissingKeyError, compareFaces } from '../ai.js';

// Album titles are the only thing carrying identity, so a title that doesn't
// fit the convention can't be matched — it's reported rather than guessed at.
function parseAlbumTitle(title) {
const raw = String(title || '').trim();
const at = raw.indexOf('_');
if (at <= 0) return null;
const person = raw.slice(0, at).trim();
// Split on the REST only, so a name can't be mistaken for a later field.
// An empty slot ("Alena__2026") is meaningful — it says "no location" —
// so empties are kept rather than filtered out.
const parts = raw.slice(at + 1).split('_').map((s) => s.trim());
return {
person,
location: parts[0] || '',
date: parts[1] || '',
// Anything past the fourth field is folded into "other" rather than
// dropped, since a stray underscore shouldn't lose information.
other: parts.slice(2).filter(Boolean).join(' '),
title: raw,
};
}

// What to show under a thumbnail. These are already grouped under the
// person, so repeating the name would be noise — show what distinguishes
// this album instead, and fall back to the name for a plain "Name_".
function captionFor(album) {
const bits = [album.location, album.date, album.other].filter(Boolean);
return bits.length ? bits.join(' · ') : album.person;
}

// Albums whose label marks them sensitive follow the same device-local
// visibility switch as the sensitive tag fields, so a shared screen doesn't
// surface them. Deliberately a small, explicit list rather than a guess.
// Shares the location slot: a marker there means "private", not a place.
const SENSITIVE_LABELS = new Set(['x', 'xx', 'nsfw', 'private']);
function isSensitive(album) {
return SENSITIVE_LABELS.has(String(album.location || '').toLowerCase());
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

// For the common case in an album import: a real album with no matching
// name at all, not a near-miss worth fixing by hand. "Real life" fits
// better than a dating-app name here, since these come from Photos, not a
// swipe. Shape mirrors the other two connection-creation sites in
// connections.js (the manual add form, and screenshot import) — this file
// doesn't import from there to avoid a circular dependency, so it's kept in
// step by hand rather than factored out.
function createConnectionFor(name) {
const conn = {
id: uid(), name, profileName: '', app: 'Real life', priority: 3, stage: 'Matched', lastContact: todayStr(), createdAt: new Date().toISOString(),
photoId: null, photoIds: [], photoAlbums: [], age: '', dob: '', ageAsOf: '', location: '', address: '',
kids: '', job: '', height: '', education: '', phone: '', email: '',
contactStatus: '', contactResourceName: '', contactEtag: '', contactConflicts: [],
likes: '', notes: '', languages: [], nationality: [],
todos: [], tags: [], aliases: [], dateLocations: [], dateEvents: [], sexTags: [],
ratings: {}, driveLink: '', photosAlbumUrl: '', photosPersonUrl: '',
};
data.connections.push(conn);
queueSave();
return conn;
}

let rows = [];        // one per album: {title, url, cover, person, label, chosenId, match}
let unparsed = [];    // album titles with no underscore
let peopleSeen = [];  // face-group names from the people page, for the gap check

function optionsFor(chosenId) {
return `<option value=""${chosenId ? '' : ' selected'}>— skip —</option>`
+ data.connections.slice().sort((a, b) => a.name.localeCompare(b.name))
.map((c) => `<option value="${escapeHtml(c.id)}"${c.id === chosenId ? ' selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
}

// A name match is only ever a guess until you've actually looked at both
// faces — "Alena" and "Alena A" matched the same person by string comparison
// alone right up until a human noticed they're different people. Showing the
// connection's existing photo next to the incoming album cover turns that
// from "read two names carefully" into "glance at two faces", right where
// the decision is being made.
function existingPhotoHtml(connId) {
if (!connId) return '';
const conn = data.connections.find((c) => c.id === connId);
if (!conn || !conn.photoId) return '';
return `<span class="album-compare" title="${escapeHtml(conn.name)}'s existing photo — compare before confirming">
<span class="thumb-img sm" data-photo-id="${escapeHtml(conn.photoId)}"></span>
<span class="compare-arrow">&harr;</span>
</span>`;
}

// The "AI compare" button and its verdict. Only offered where it's actually
// useful: a non-exact match (an exact name match doesn't need it), with both
// a stored photo to compare against and a cover to compare it to. Never
// offered for exact matches, and never wired to change row.chosenId itself
// — it only ever informs the human decision already on screen, same rule as
// every other AI-assisted match in this app.
function aiCompareHtml(row, i) {
if (!row.chosenId || !row.cover) return '';
if (row.match && row.match.why === 'exact') return '';
const conn = data.connections.find((c) => c.id === row.chosenId);
if (!conn || !conn.photoId || !row.cover) return '';

if (row.aiVerdict === 'loading') {
return '<div class="album-ai-compare loading">Comparing…</div>';
}
if (row.aiVerdict) {
const v = row.aiVerdict;
const cls = v.same === true ? 'yes' : v.same === false ? 'no' : 'unsure';
const label = v.same === true ? 'AI: looks like the same person' : v.same === false ? 'AI: these look like different people' : 'AI: unsure';
return `<div class="album-ai-compare ${cls}">${escapeHtml(label)}${v.reason ? ` — ${escapeHtml(v.reason)}` : ''}</div>`;
}
return `<button class="sync-btn sm" type="button" data-album-ai-compare="${i}">AI compare faces</button>`;
}

async function runAiCompare(row, render) {
row.aiVerdict = 'loading';
render();
try {
const conn = data.connections.find((c) => c.id === row.chosenId);
const [existing, incoming] = await Promise.all([
photoGet(conn.photoId),
fetchProxiedImage(row.cover),
]);
if (!existing) throw new Error("This connection's existing photo isn't on this device — run Photo sync in Settings first.");
row.aiVerdict = await compareFaces(existing, incoming);
} catch (err) {
console.error('Face comparison failed:', err);
row.aiVerdict = { same: null, reason: err instanceof MissingKeyError ? 'Add an Anthropic API key in Settings first.' : (err.message || String(err)) };
}
render();
}

function thumbHtml(row, i) {
// The cover is rendered straight from its Google URL rather than copied —
// re-hosting it isn't possible from the browser anyway, since reading the
// bytes cross-origin is blocked even though displaying them isn't. These
// URLs are signed and DO expire (observed: still-valid the day of harvest,
// 403 a day-plus later), so onerror swaps in a message that says what's
// actually wrong instead of leaving a blank box that just looks broken —
// the fix is re-running the snippet already in this panel to get fresh ones.
const img = row.cover
? `<img src="${escapeHtml(row.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.outerHTML='<span class=&quot;album-nocover&quot;>cover link expired &mdash; re-run the snippet above</span>'">`
: '<span class="album-nocover">no cover</span>';
return `<div class="album-card${row.applied ? ' chosen' : ''}${isSensitive(row) ? ' album-sensitive' : ''}">
<span class="album-compare-row">
<a class="album-thumb" href="${escapeHtml(row.url)}" target="_blank" rel="noopener" title="${escapeHtml(row.title)}">${img}</a>
${existingPhotoHtml(row.chosenId)}
</span>
<div class="album-caption">${escapeHtml(captionFor(row))}</div>
<div class="album-meta">${escapeHtml(row.match ? row.match.why : 'no match')}${row.count ? ` · ${row.count}` : ''}</div>
${aiCompareHtml(row, i)}
<select data-album-pick="${i}">${optionsFor(row.chosenId)}</select>
${!row.chosenId ? `<button class="sync-btn sm" type="button" data-album-newconn="${i}">+ New connection</button>` : ''}
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
hydratePhotos(el);

el.querySelectorAll('[data-album-pick]').forEach((sel) => {
sel.addEventListener('change', () => {
const row = rows[parseInt(sel.dataset.albumPick, 10)];
row.chosenId = sel.value;
row.applied = false;
row.aiVerdict = null; // a verdict about the PREVIOUS pairing must not linger
render();
});
});
el.querySelectorAll('[data-album-newconn]').forEach((btn) => {
btn.addEventListener('click', () => {
const row = rows[parseInt(btn.dataset.albumNewconn, 10)];
if (!row) return;
row.chosenId = createConnectionFor(row.person).id;
row.applied = false;
row.aiVerdict = null;
render();
});
});
el.querySelectorAll('[data-album-ai-compare]').forEach((btn) => {
btn.addEventListener('click', () => {
const row = rows[parseInt(btn.dataset.albumAiCompare, 10)];
if (row) runAiCompare(row, render);
});
});
const apply = document.getElementById('albums-apply');
if (apply) apply.addEventListener('click', save);
}

// A cover embedded as a data: URI (see the snippet) is the actual photo
// bytes, not a reference — storing it straight in the synced document would
// bake tens of KB per album into a document that's rewritten whole on every
// autosave. Routing it through storePhoto() (the same path every other
// photo in this app takes) gets it onto the server as a proper attachment
// and leaves only a small id behind, exactly like a connection's own photo.
// Both keys are always returned (one cleared to '' rather than omitted) so
// a re-save always fully overwrites the pair via Object.assign — leaving
// one key untouched would let a stale value from an earlier save survive
// alongside a fresh one that no longer matches it.
async function resolveCover(row) {
if (!row.cover || !row.cover.startsWith('data:')) return { cover: row.cover || '', coverPhotoId: '' };
const blob = await fetch(row.cover).then((r) => r.blob());
return { cover: '', coverPhotoId: await storePhoto(blob) };
}

async function save() {
const status = document.getElementById('albums-status');
const toSave = rows.filter((row) => row.chosenId && !row.applied);
if (!toSave.length) return;
if (status) status.textContent = `Saving ${toSave.length} link${toSave.length === 1 ? '' : 's'}…`;
let n = 0;
for (const row of toSave) {
const conn = data.connections.find((c) => c.id === row.chosenId);
if (!conn) continue;
if (!Array.isArray(conn.photoAlbums)) conn.photoAlbums = [];
// Keyed on the URL, so re-importing after a title change updates the
// label in place instead of adding a duplicate album.
const fields = { location: row.location, date: row.date, other: row.other, title: row.title, ...(await resolveCover(row)) };
const existing = conn.photoAlbums.find((a) => a.url === row.url);
if (existing) Object.assign(existing, fields);
else conn.photoAlbums.push({ url: row.url, ...fields });

// ONLY the location slot becomes a tag. Date and other are stored and
// shown but never promoted — that's the whole reason the title is
// positional, so "Birthday" can't end up filed as a place. A sensitive
// marker sits in the same slot and is never promoted either.
if (row.location && !isSensitive(row) && TAG_FIELDS.some((f) => f.field === 'dateLocations')) {
if (!Array.isArray(conn.dateLocations)) conn.dateLocations = [];
if (!conn.dateLocations.some((v) => nameKey(v) === nameKey(row.location))) conn.dateLocations.push(row.location);
}
row.applied = true;
n++;
}
if (!n) return;
queueSave();
if (status) status.textContent = `Linked ${n} album${n === 1 ? '' : 's'}.`;
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
