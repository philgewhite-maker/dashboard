// Imports a Tinder web profile: paste the JSON a console snippet copies
// from a profile page (run in the browser, not fetched by this app — a
// dating site's own page can't be read cross-origin any more than Google
// Photos can) and review what it found before merging into a connection.
//
// Tinder's profile photos load from a public CDN with no login required —
// unlike Google Photos, an anonymous request gets the bytes at all. But the
// CORS header a direct fetch() needs to actually READ those bytes turned
// out to be inconsistent: the exact same URL shape returned it on one
// fetch and not on another, confirmed live ("Failed to fetch" with no
// further detail is the browser's deliberately vague way of reporting
// that). So photo fetches go through image-proxy.php when it's configured
// — a server-to-server request has no concept of CORS at all — falling
// back to a direct fetch() if it isn't, which still works for whichever
// photos happen to get the header.
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
import { storePhoto, fetchProxiedImage } from '../files.js';
import { photoGet } from '../db.js';
import { MissingKeyError, compareFaces } from '../ai.js';
import { findPhoneNumbers, findHandles, formatHandle } from '../contactscan.js';
import { STAGE_RANK, CONN_STAGES } from './connections.js';

// True only if the extracted chat has a message from BOTH sides, not just
// the user reaching out with no reply — a one-sided "You: hey" isn't
// really "chatting", it's still just a match.
function hasMutualMessages(chatText) {
let youSaid = false;
let theySaid = false;
chatText.split('\n').forEach((line) => {
const m = line.match(/^\[\d{1,2}:\d{2}\]\s*([^:]+):/);
if (!m) return;
if (m[1].trim() === 'You') youSaid = true; else theySaid = true;
});
return youSaid && theySaid;
}

// Real conversation means the stage is further along than a bare match,
// and a number given means further still — a default for the editable
// Stage field in review, not applied silently: rank-compared against
// whichever connection is chosen so it only ever suggests a step forward
// (someone already at "Planning to meet" isn't suggested back down to
// "Chatting in app" just because this import also found chat history),
// but the user sees and can override it before it's ever saved.
function suggestedStage(conn) {
const current = (conn && conn.stage) || 'Matched';
const chatField = pending.fields.find((f) => f.apply && f.label === 'Chat history' && f.value.trim());
const gaveNumber = pending.foundPhones.some((p) => p.apply);
let target = null;
if (gaveNumber) {
const allText = pending.fields.map((f) => f.value).join('\n');
target = /\btelegram\b/i.test(allText) ? 'Moved to Telegram' : 'Moved to WhatsApp';
} else if (chatField && hasMutualMessages(chatField.value)) {
target = 'Chatting in app';
}
return target && (STAGE_RANK[target] || 0) > (STAGE_RANK[current] || 0) ? target : current;
}

// Prefers the proxy (works regardless of Tinder's CORS inconsistency) but
// falls back to a direct fetch if sync isn't configured — still succeeds
// for whichever photos happen to get the CORS header, rather than failing
// every photo just because the more reliable path isn't set up.
async function fetchTinderPhoto(url) {
try {
return await fetchProxiedImage(url);
} catch (proxyErr) {
try {
const r = await fetch(url);
if (!r.ok) throw new Error(`HTTP ${r.status}`);
return await r.blob();
} catch (directErr) {
// A direct fetch's CORS failure is always a content-free "Failed to
// fetch" — the browser deliberately exposes nothing more. The proxy's
// error, when it has one, actually reached Tinder's server and can
// say why (not configured, bad host, or — confirmed live against a
// real broken photo — Tinder itself responding with something that
// isn't an image at all). Surface that instead of the useless one.
throw proxyErr;
}
}
}

// Same two-pass approach as the other import paths (screenshot scan, album
// linking): exact name match first, then a deliberately loose pass. Kept
// local rather than imported from connections.js to avoid a circular
// dependency — connections.js is the one importing this module's init
// function, not the other way round.
//
// Returns every connection that scores at all, not just the single best —
// a real near-miss (e.g. a different "Natalia" already tracked) needs to
// be visible as its OWN candidate to pick between, not hidden behind
// whichever one scored a point higher.
function matchCandidates(name, limit) {
const key = nameKey(name);
if (!key) return [];
const namesOf = (c) => [c.name, c.profileName, ...(c.aliases || [])].filter(Boolean);
const results = [];
data.connections.forEach((c) => {
let best = null;
namesOf(c).forEach((n) => {
const nk = nameKey(n);
let score = null;
let why = '';
if (nk === key) { score = 200; why = 'exact'; }
else if (nk.startsWith(key) || key.startsWith(nk)) { score = 100 - Math.abs(nk.length - key.length); why = 'shortened name'; }
else if (key.length >= 4) {
const d = editDistance(key, nk, 2);
if (d <= 2) { score = 60 - d * 10; why = `${d} letter${d === 1 ? '' : 's'} different`; }
}
if (score !== null && (!best || score > best.score)) best = { why, score };
});
if (best) results.push({ conn: c, why: best.why, score: best.score });
});
results.sort((a, b) => b.score - a.score);
return typeof limit === 'number' ? results.slice(0, limit) : results;
}

function matchPerson(name) {
return matchCandidates(name, 1)[0] || null;
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

// A handful of field labels map straight onto an existing single-value
// connection field. Everything else Tinder shows (communication style,
// zodiac, prompt answers like "My biography would be called: ...") has no
// dedicated field in this app, so it's kept as a readable line appended to
// notes instead of being dropped — same fallback the screenshot importer
// uses for a bio it can't otherwise place.
const FIELD_MAP = {
'Family plans': 'kids', Education: 'education', Height: 'height', Work: 'job', 'Job title': 'job', Job: 'job', Distance: 'distance', City: 'location',
'Matched on': 'matchedOn', 'Chat history': 'chatLog',
};

// Fields that become chips in an existing multi-value tag list instead —
// added to, never overwritten, so re-importing the same person twice just
// re-confirms the same tags rather than duplicating or blocking anything.
// `split: true` fields are genuinely comma-delimited lists from Tinder
// (Languages, Interests); `split: false` ones are a single phrase that may
// just happen to CONTAIN a comma ("Long-term, but short-term OK" is one
// answer, not two) and would be mangled by splitting it.
const ARRAY_FIELD_MAP = {
Languages: { target: 'languages', split: true },
Interests: { target: 'interests', split: true },
Orientation: { target: 'relationshipTags', split: false },
'Relationship type': { target: 'relationshipTags', split: false },
'Looking for': { target: 'relationshipTags', split: false },
};

let pending = null; // { name, age, fields, photos, chosenId, match, matchConfirmed, aiVerdict }
let queue = []; // raw {name,age,fields,photos} profiles still waiting, from a bulk-import paste

// The dropdown puts whoever the name-matcher flagged at the top, in their
// own group, ahead of the full alphabetical list — 300+ connections is too
// many to scan for a likely candidate, but hiding the rest entirely would
// make picking someone the algorithm didn't guess (a real, common case)
// awkward.
function optionsFor(chosenId, candidates) {
const candidateIds = new Set(candidates.map((m) => m.conn.id));
const rest = data.connections.slice().filter((c) => !candidateIds.has(c.id)).sort((a, b) => a.name.localeCompare(b.name));
const candidateOptions = candidates
.map((m) => `<option value="${escapeHtml(m.conn.id)}"${m.conn.id === chosenId ? ' selected' : ''}>${escapeHtml(m.conn.name)}${m.why === 'exact' ? '' : ` (${escapeHtml(m.why)})`}</option>`)
.join('');
const restOptions = rest.map((c) => `<option value="${escapeHtml(c.id)}"${c.id === chosenId ? ' selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
return `<option value=""${chosenId ? '' : ' selected'}>— pick who this is —</option>`
+ (candidateOptions ? `<optgroup label="Possible matches">${candidateOptions}</optgroup>` : '')
+ `<optgroup label="All connections">${restOptions}</optgroup>`;
}

// One candidate row inside the More Info panel: their FULL existing photo
// set next to ALL incoming photos, not just one of each — a real match
// missed on the first pair (confirmed live: the actual matching photo was
// the incoming set's 2nd image, not 1st, invisible in a single pic-vs-pic
// compare) is easy to catch once every photo is actually on screen at a
// readable size. AI compare stays as a quick supplementary opinion, not
// the primary tool — it's only ever compared cover-vs-first-photo, and a
// human scanning both full grids catches what that single pairing can't.
function candidateRowHtml(m) {
const conn = m.conn;
const existingIds = conn.photoIds && conn.photoIds.length ? conn.photoIds : (conn.photoId ? [conn.photoId] : []);
const existingPhotos = existingIds.length
? `<div class="tinder-photo-grid">${existingIds.map((id) => `<span class="thumb-lg"><span class="thumb-img" data-photo-id="${escapeHtml(id)}"></span></span>`).join('')}</div>`
: '<div class="settings-note" style="margin:4px 0;">No photo on file for them.</div>';
const verdict = pending.aiVerdicts[conn.id];
const aiBlock = verdict === 'loading' ? '<div class="album-ai-compare loading">Comparing…</div>'
: verdict ? `<div class="album-ai-compare ${verdict.same === true ? 'yes' : verdict.same === false ? 'no' : 'unsure'}">${escapeHtml(verdict.same === true ? 'AI: looks like the same person' : verdict.same === false ? 'AI: these look like different people' : 'AI: unsure')}${verdict.reason ? ` — ${escapeHtml(verdict.reason)}` : ''}</div>`
: (conn.photoId && pending.photos[0] ? `<button class="sync-btn sm" type="button" data-tinder-ai-compare="${escapeHtml(conn.id)}">AI compare faces</button>` : '');
const isChosen = pending.chosenId === conn.id;
return `<div class="tinder-candidate-row${isChosen ? ' chosen' : ''}">
<div class="album-caption"><strong>${escapeHtml(conn.name)}</strong>${conn.age ? `, ${escapeHtml(conn.age)}` : ''} <span class="tinder-field-note">(${escapeHtml(m.why)})</span></div>
${existingPhotos}
${aiBlock}
<button class="sync-btn sm" type="button" data-tinder-choose="${escapeHtml(conn.id)}" style="margin-top:6px;">${isChosen ? 'Chosen' : `Choose ${escapeHtml(conn.name)}`}</button>
</div>`;
}

// The whole point of More Info: everyone worth considering, side by side,
// at a size you can actually read — not the main card's job, which needs
// to stay a quick Save/Skip decision for the common case (an exact match,
// or clearly nobody existing).
function moreInfoHtml() {
if (!pending.showMoreInfo) return '';
const incomingGrid = pending.photos.length
? `<div class="tinder-photo-grid">${pending.photos.map((ph) => `<span class="thumb-lg"><img src="${escapeHtml(ph.url)}" alt=""></span>`).join('')}</div>`
: '<div class="settings-note" style="margin:4px 0;">No photos in this import.</div>';
return `<div class="tinder-more-info-overlay" id="tinder-more-info">
<div class="tinder-more-info-box">
<h3>${escapeHtml(pending.name || '(no name found)')} — incoming photos</h3>
${incomingGrid}
<h3>Who is this?</h3>
${pending.candidates.length ? pending.candidates.map(candidateRowHtml).join('') : '<div class="settings-note" style="margin:4px 0;">No name-based candidates found.</div>'}
<button class="sync-btn sm" type="button" id="tinder-more-info-newconn">+ New connection</button>
<div class="sync-row" style="margin-top:10px;">
<button class="sync-btn" type="button" id="tinder-more-info-close">Close</button>
</div>
</div>
</div>`;
}

// Keyed by connection id (pending.aiVerdicts) rather than one shared slot
// — More Info can show several candidates at once, and a verdict about
// one shouldn't linger on or block checking another.
async function runAiCompareFor(connId) {
pending.aiVerdicts[connId] = 'loading';
render();
try {
const conn = data.connections.find((c) => c.id === connId);
const incoming = pending.photos[0];
const [existing, incomingBlob] = await Promise.all([
photoGet(conn.photoId),
fetchTinderPhoto(incoming.url),
]);
if (!existing) throw new Error("This connection's existing photo isn't on this device — run Photo sync in Settings first.");
pending.aiVerdicts[connId] = await compareFaces(existing, incomingBlob);
} catch (err) {
console.error('Face comparison failed:', err);
pending.aiVerdicts[connId] = { same: null, reason: err instanceof MissingKeyError ? 'Add an Anthropic API key in Settings first.' : (err.message || String(err)) };
}
render();
}

// What will actually happen to each field if this gets saved right now,
// computed against whichever connection is currently chosen — a real
// preview rather than a blind checkbox list, so "this will overwrite
// something" or "this is already set and will be skipped" is visible
// before Save, not discovered after.
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// City rarely arrives in a structured field — it's usually said in chat —
// and free-text guessing at what's a place name is too unreliable to
// trust. But every OTHER connection's own City is a real, known-good
// value, so matching against that list is exact rather than a guess: any
// text this profile carries gets scanned for a case-insensitive exact hit
// against a city that's already on file for someone else, highlighted so
// it's easy to spot, and clicking it fills the City field rather than
// applying anything automatically.
function knownCityMap() {
const map = new Map(); // lowercase -> original casing (first one seen)
data.connections.forEach((c) => {
const loc = String(c.location || '').trim();
if (loc && !map.has(loc.toLowerCase())) map.set(loc.toLowerCase(), loc);
});
return map;
}

function highlightCities(text) {
const cityMap = knownCityMap();
if (!cityMap.size) return escapeHtml(text);
// Longest names first, so a multi-word city ("New York") wins whole
// rather than a shorter, unrelated city name that happens to be a
// substring of it matching first.
const names = [...cityMap.values()].sort((a, b) => b.length - a.length);
const re = new RegExp(`\\b(${names.map(escapeRegex).join('|')})\\b`, 'gi');
let out = '';
let last = 0;
let m;
while ((m = re.exec(text))) {
out += escapeHtml(text.slice(last, m.index));
const original = cityMap.get(m[0].toLowerCase()) || m[0];
out += `<span class="tinder-city-hit" data-tinder-city="${escapeHtml(original)}" title="Click to set as City">${escapeHtml(m[0])}</span>`;
last = m.index + m[0].length;
}
out += escapeHtml(text.slice(last));
return out;
}

function fieldPreviewHtml(f, i) {
const conn = data.connections.find((c) => c.id === pending.chosenId);
const target = FIELD_MAP[f.label];
const arrayMap = ARRAY_FIELD_MAP[f.label];
let note = 'will be added to notes';
let blocked = false;
if (conn && target) {
const current = String(conn[target] || '').trim();
if (current) { note = `already set to "${current}" — will be skipped`; blocked = true; }
else note = `will set ${f.label}`;
} else if (conn && arrayMap) {
const existingTags = new Set((conn[arrayMap.target] || []).map((t) => t.toLowerCase()));
const parts = arrayMap.split ? f.value.split(',').map((s) => s.trim()).filter(Boolean) : [f.value.trim()];
const fresh = parts.filter((p) => !existingTags.has(p.toLowerCase()));
note = fresh.length === 0 ? `already in ${arrayMap.target} — will be skipped`
: fresh.length === parts.length ? `will add to ${arrayMap.target}`
: `will add ${fresh.length} new to ${arrayMap.target}, rest already there`;
if (fresh.length === 0) blocked = true;
}
return `<label class="tinder-field-row${blocked ? ' tinder-field-blocked' : ''}">
<input type="checkbox" data-tinder-field="${i}"${f.apply && !blocked ? ' checked' : ''}${blocked ? ' disabled' : ''}>
<strong>${escapeHtml(f.label)}:</strong> ${highlightCities(f.value)} <span class="tinder-field-note">(${escapeHtml(note)})</span>
</label>`;
}

// Same checkbox-with-a-preview shape as fieldPreviewHtml, for whatever the
// text scan turned up. Nothing here is ever applied without this being
// visibly checked first — a wrong phone/handle guess is a much smaller
// mistake than one silently written to a connection.
function contactPreviewHtml() {
const conn = data.connections.find((c) => c.id === pending.chosenId);
// Fill-if-empty means only the FIRST applied phone actually lands — save()
// stops setting conn.phone as soon as it's non-empty, so if more than one
// candidate turned up, every one after the first would silently do
// nothing despite its checkbox saying otherwise. Mirror that here so the
// preview never claims more than one phone "will set" at once.
let phoneClaimed = conn ? !!String(conn.phone || '').trim() : false;
const phoneRows = pending.foundPhones.map((p, i) => {
let note = 'will set phone';
let blocked = false;
if (phoneClaimed) {
note = conn && String(conn.phone || '').trim()
? `phone already set to "${conn.phone}" — will be skipped`
: 'another found phone will be used instead — will be skipped';
blocked = true;
} else if (p.apply) {
phoneClaimed = true; // the next candidate, if any, loses the slot to this one
}
return `<label class="tinder-field-row${blocked ? ' tinder-field-blocked' : ''}">
<input type="checkbox" data-tinder-phone="${i}"${p.apply && !blocked ? ' checked' : ''}${blocked ? ' disabled' : ''}>
<strong>Phone found:</strong> ${escapeHtml(p.value)} <span class="tinder-field-note">(${escapeHtml(note)})</span>
</label>`;
}).join('');
const handleRows = pending.foundHandles.map((h, i) => {
const label = formatHandle(h);
let note = 'will add to Social handles';
let blocked = false;
if (conn) {
const existing = (conn.socialHandles || []).map((s) => s.toLowerCase());
if (existing.includes(label.toLowerCase())) { note = 'already in Social handles — will be skipped'; blocked = true; }
}
return `<label class="tinder-field-row${blocked ? ' tinder-field-blocked' : ''}">
<input type="checkbox" data-tinder-handle="${i}"${h.apply && !blocked ? ' checked' : ''}${blocked ? ' disabled' : ''}>
<strong>Handle found:</strong> ${escapeHtml(label)} <span class="tinder-field-note">(${escapeHtml(note)})</span>
</label>`;
}).join('');
if (!phoneRows && !handleRows) return '';
return `<div class="tinder-fields">${phoneRows}${handleRows}</div>`;
}

function agePreviewHtml() {
const conn = data.connections.find((c) => c.id === pending.chosenId);
if (!pending.age) return '';
const current = conn ? String(conn.age || '').trim() : '';
const note = current ? `already set to ${current} — will be kept` : `will set age to ${pending.age}`;
return `<div class="tinder-field-row"><strong>Age:</strong> ${escapeHtml(pending.age)} <span class="tinder-field-note">(${escapeHtml(note)})</span></div>`;
}

function ratingStarsHtml(current) {
return [1, 2, 3, 4, 5].map((n) => `<svg class="star tinder-rating-star${n <= current ? ' filled' : ''}" data-tinder-star="${n}" viewBox="0 0 20 20" fill="currentColor"><path d="M10 1l2.6 5.9 6.4.6-4.8 4.3 1.4 6.2L10 14.9 4.4 18l1.4-6.2L1 7.5l6.4-.6z"/></svg>`).join('');
}

function render() {
const el = document.getElementById('tinder-review');
if (!el) return;
if (!pending) { el.innerHTML = ''; return; }
const p = pending;
const chosenConn = data.connections.find((c) => c.id === p.chosenId);
// Exact match, already confirmed via More Info, or a connection created
// fresh from this review all skip the confirmation gate — everyone else
// (any non-exact pick, including one made straight from the dropdown)
// needs an explicit look-and-choose in More Info first. Changing the
// dropdown always re-arms this, same as before.
const canSave = !!p.chosenId && (p.match?.why === 'exact' || p.matchConfirmed || !p.match || chosenConn?.createdJustNow);
const saveLabel = chosenConn ? `Save to ${chosenConn.name}` : 'Save to…';
const saveBlockedNote = !p.chosenId ? 'pick who this is first'
: !canSave ? "open More info and confirm it's them first"
: '';

el.innerHTML = `<div class="album-card">
${queue.length ? `<div class="settings-note" style="margin:0 0 8px;">${queue.length} more queued in this batch — saving auto-advances to the next.</div>` : ''}
<div class="album-caption"><strong>${escapeHtml(p.name || '(no name found)')}</strong>${p.age ? `, ${escapeHtml(p.age)}` : ''}</div>

<select id="tinder-pick">${optionsFor(p.chosenId, p.candidates)}</select>

<div class="sync-row" style="margin:6px 0 8px;">
<button class="add-btn" type="button" id="tinder-save"${canSave ? '' : ' disabled'}>${escapeHtml(saveLabel)}</button>
<button class="sync-btn" type="button" id="tinder-skip">Skip</button>
<button class="sync-btn" type="button" id="tinder-newconn">+ New</button>
<button class="sync-btn" type="button" id="tinder-more-info-open">More info</button>
</div>
${saveBlockedNote ? `<div class="tinder-field-note" style="margin:-4px 0 8px;">${escapeHtml(saveBlockedNote)}</div>` : ''}
<span class="sync-status" id="tinder-save-status">${escapeHtml(p.saveMessage || '')}</span>

<div class="tinder-fields" style="margin:8px 0;">
<label class="tinder-field-row">Stage <select id="tinder-stage">${CONN_STAGES.map((s) => `<option value="${escapeHtml(s)}"${s === p.stageOverride ? ' selected' : ''}>${escapeHtml(s)}</option>`).join('')}</select></label>
<label class="tinder-field-row">City <input type="text" id="tinder-city" autocomplete="off" value="${escapeHtml(p.cityOverride)}" placeholder="Often only comes up in chat"></label>
<label class="tinder-field-row">Rating <span id="tinder-rating">${ratingStarsHtml(p.ratingOverride)}</span></label>
</div>

${agePreviewHtml()}
${p.fields.length ? `<div class="tinder-fields">${p.fields.map((f, i) => fieldPreviewHtml(f, i)).join('')}</div>` : ''}
${contactPreviewHtml()}
${p.photos.length ? `<div class="settings-note" style="margin:8px 0 4px;">${p.photos.filter((ph) => ph.apply).length} of ${p.photos.length} photos will be added — click to include/exclude:</div>
<div class="photo-gallery">${p.photos.map((ph, i) => `<span class="gallery-thumb tinder-photo-thumb${ph.apply ? ' tinder-photo-included' : ''}" data-tinder-photo="${i}"><img src="${escapeHtml(ph.url)}" alt="">${ph.apply ? '<span class="tinder-photo-badge">&check;</span>' : ''}</span>`).join('')}</div>` : ''}
</div>
${moreInfoHtml()}`;
// Every render rebuilds this whole card, including fresh, un-hydrated
// [data-photo-id] placeholders — never called here before, so a photo
// only ever showed up if something ELSE had hydrated that exact id
// first, and vanished again on the very next render (any checkbox
// toggle, dropdown change, etc. all re-render).
hydratePhotos(el);

const pick = document.getElementById('tinder-pick');
if (pick) pick.addEventListener('change', () => { pending.chosenId = pick.value; pending.matchConfirmed = false; refreshOverrides(); render(); });
const skipBtn = document.getElementById('tinder-skip');
if (skipBtn) skipBtn.addEventListener('click', () => {
const skippedName = pending.name || '(unnamed)';
advanceQueue(`Skipped ${skippedName}.`);
});
const newBtn = document.getElementById('tinder-newconn');
if (newBtn) newBtn.addEventListener('click', () => {
const conn = createConnectionFor(pending.name || 'Unnamed');
conn.createdJustNow = true; // not a persisted field — just marks this session's save as safe without a match confirmation
pending.chosenId = conn.id;
pending.matchConfirmed = true;
refreshOverrides();
render();
});
const moreInfoOpenBtn = document.getElementById('tinder-more-info-open');
if (moreInfoOpenBtn) moreInfoOpenBtn.addEventListener('click', () => { pending.showMoreInfo = true; render(); });
const moreInfoCloseBtn = document.getElementById('tinder-more-info-close');
if (moreInfoCloseBtn) moreInfoCloseBtn.addEventListener('click', () => { pending.showMoreInfo = false; render(); });
const moreInfoNewBtn = document.getElementById('tinder-more-info-newconn');
if (moreInfoNewBtn) moreInfoNewBtn.addEventListener('click', () => {
const conn = createConnectionFor(pending.name || 'Unnamed');
conn.createdJustNow = true;
pending.chosenId = conn.id;
pending.matchConfirmed = true;
pending.showMoreInfo = false;
refreshOverrides();
render();
});
el.querySelectorAll('[data-tinder-choose]').forEach((btn) => {
btn.addEventListener('click', () => {
pending.chosenId = btn.dataset.tinderChoose;
pending.matchConfirmed = true;
pending.showMoreInfo = false;
refreshOverrides();
render();
});
});
el.querySelectorAll('[data-tinder-ai-compare]').forEach((btn) => {
btn.addEventListener('click', () => runAiCompareFor(btn.dataset.tinderAiCompare));
});
const stageSel = document.getElementById('tinder-stage');
if (stageSel) stageSel.addEventListener('change', () => { pending.stageOverride = stageSel.value; });
const cityInput = document.getElementById('tinder-city');
if (cityInput) cityInput.addEventListener('input', () => { pending.cityOverride = cityInput.value; });
el.querySelectorAll('[data-tinder-star]').forEach((star) => {
star.addEventListener('click', () => {
const n = parseInt(star.dataset.tinderStar, 10);
pending.ratingOverride = pending.ratingOverride === n ? 0 : n; // click the same star again to clear
render();
});
});
el.querySelectorAll('[data-tinder-field]').forEach((cb) => {
cb.addEventListener('change', () => { pending.fields[parseInt(cb.dataset.tinderField, 10)].apply = cb.checked; });
});
el.querySelectorAll('[data-tinder-city]').forEach((hit) => {
hit.addEventListener('click', (e) => {
// This span sits inside the field's own <label> (the checkbox that
// toggles whether the WHOLE field gets applied) — a plain click here
// would also toggle that checkbox via the browser's native
// label-forwards-to-input behaviour, confirmed live: clicking a city
// hit silently unchecked the field it was found in.
e.preventDefault();
e.stopPropagation();
pending.cityOverride = hit.dataset.tinderCity;
render();
});
});
el.querySelectorAll('[data-tinder-phone]').forEach((cb) => {
cb.addEventListener('change', () => { pending.foundPhones[parseInt(cb.dataset.tinderPhone, 10)].apply = cb.checked; });
});
el.querySelectorAll('[data-tinder-handle]').forEach((cb) => {
cb.addEventListener('change', () => { pending.foundHandles[parseInt(cb.dataset.tinderHandle, 10)].apply = cb.checked; });
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
const arrayMap = ARRAY_FIELD_MAP[f.label];
if (arrayMap) {
if (!Array.isArray(conn[arrayMap.target])) conn[arrayMap.target] = [];
const parts = arrayMap.split ? f.value.split(',').map((s) => s.trim()).filter(Boolean) : [f.value.trim()];
const existingLower = conn[arrayMap.target].map((t) => t.toLowerCase());
parts.forEach((p) => { if (p && !existingLower.includes(p.toLowerCase())) conn[arrayMap.target].push(p); });
return;
}
const line = `${f.label}: ${f.value}`;
if (!String(conn.notes || '').includes(line)) conn.notes = conn.notes ? `${conn.notes}\n${line}` : line;
});

pending.foundPhones.filter((p) => p.apply).forEach((p) => {
if (!String(conn.phone || '').trim()) conn.phone = p.value;
});
if (!Array.isArray(conn.socialHandles)) conn.socialHandles = [];
pending.foundHandles.filter((h) => h.apply).forEach((h) => {
const label = formatHandle(h);
const existingLower = conn.socialHandles.map((s) => s.toLowerCase());
if (!existingLower.includes(label.toLowerCase())) conn.socialHandles.push(label);
});

const toFetch = pending.photos.filter((ph) => ph.apply);
let failed = 0;
let firstError = '';
for (let i = 0; i < toFetch.length; i++) {
const ph = toFetch[i];
if (status) status.textContent = `Saving… photo ${i + 1} of ${toFetch.length}`;
try {
const blob = await fetchTinderPhoto(ph.url);
const id = await storePhoto(blob);
if (!conn.photoIds.includes(id)) conn.photoIds.push(id);
if (!conn.photoId) conn.photoId = id;
ph.apply = false; // saved — leave it out of a retry so it can't be re-added as a duplicate
} catch (err) {
console.error('Could not fetch Tinder photo:', ph.url, err);
if (!firstError) firstError = err.message || String(err);
failed++;
}
}

// Stage, City and overall rating are edited directly in the review card
// (a suggested stage pre-fills the dropdown, but nothing here is silent —
// whatever's showing when Save is clicked is what's applied), same as
// editing them on the Connections tab itself: a direct set, not a
// fill-if-empty merge.
if (pending.stageOverride) conn.stage = pending.stageOverride;
if (pending.cityOverride.trim()) conn.location = pending.cityOverride.trim();
if (pending.ratingOverride) conn.priority = pending.ratingOverride;
if (pending.matchId && !conn.tinderMatchId) conn.tinderMatchId = pending.matchId;

queueSave();
Promise.all([import('./connections.js'), import('./overview.js')])
.then(([c, o]) => { c.renderConnections(); o.renderOverview(); hydratePhotos(document.getElementById('conn-list') || document.body); });

// A photo silently not saving with no visible reason (beyond a
// console.error nobody was watching for) was exactly what happened
// before this — so on any failure, the review stays open with the
// actual error shown, rather than resetting and taking the message with
// it. Fields are already saved either way; clicking Save again only
// retries the photos still marked to include, not a duplicate of
// whatever already succeeded.
// The message is threaded through pending.saveMessage rather than
// written to the status span directly — render() rebuilds this card's
// whole innerHTML, including a brand new (empty) status span, so a
// direct write here would already be gone by the time anyone saw it.
if (failed) {
pending.saveMessage = `Saved fields to ${conn.name}. ${failed} of ${toFetch.length} photo${toFetch.length === 1 ? '' : 's'} failed: ${firstError} — click Save again to retry.`;
render();
} else {
advanceQueue(`Saved to ${conn.name}.`);
}
}

// The bulk snippet's output ({profiles: [...]}) and the single-profile
// snippet's output (one {name,age,fields,photos} object) land in the same
// textarea — told apart here so one "Read profile(s)" button handles both.
function parseBatch(text) {
const trimmed = String(text || '').trim();
if (!trimmed) return [];
const raw = JSON.parse(trimmed);
return Array.isArray(raw.profiles) ? raw.profiles : [raw];
}

// Scans every extracted field's text for a phone number or a social handle
// — not just chat, since both turn up just as often in a bio or a prompt
// answer. Chat is the one field with more than one author, so it's the one
// field that needs filtering first: a "[HH:MM] You: ..." line is never the
// match's own contact info, and skipping those lines catches every format
// the user might type their own number/handle in, rather than matching
// against a fixed list of known-own values.
function scanFields(fields) {
const phones = [];
const seenPhones = new Set();
const handles = [];
const seenHandles = new Set();
fields.forEach((f) => {
const text = f.label === 'Chat history'
? f.value.split('\n').filter((line) => !/^\[\d{1,2}:\d{2}\]\s*You:/.test(line)).join('\n')
: f.value;
findPhoneNumbers(text).forEach((p) => {
const digits = p.replace(/\D/g, '');
if (seenPhones.has(digits)) return;
seenPhones.add(digits);
phones.push(p);
});
findHandles(text).forEach((h) => {
const key = h.handle.toLowerCase();
if (seenHandles.has(key)) return;
seenHandles.add(key);
handles.push(h);
});
});
return { phones, handles };
}

// Turns one raw {name,age,fields,photos} object into the shape `pending`
// needs and runs the same match-and-preselect logic a single paste always
// has — only an EXACT name match is trusted enough to pre-select; anything
// looser (the "Leila"/"Lenka" mistake was 2 letters different) is shown as
// a suggestion requiring an explicit look-and-confirm instead.
function loadFromRaw(raw) {
const fields = Array.isArray(raw.fields) ? raw.fields
.map((f) => ({ label: String(f.label || '').trim(), value: String(f.value || '').trim() }))
.filter((f) => f.label && f.value) : [];
const photos = Array.isArray(raw.photos) ? [...new Set(raw.photos.map((u) => String(u || '').trim()).filter(Boolean))] : [];
const { phones, handles } = scanFields(fields);
const parsed = {
name: String(raw.name || '').trim(),
age: String(raw.age || '').trim(),
fields: fields.map((f) => ({ ...f, apply: true })),
photos: photos.map((url) => ({ url, apply: true })),
foundPhones: phones.map((value) => ({ value, apply: true })),
foundHandles: handles.map((h) => ({ ...h, apply: true })),
chosenId: '',
match: null,
matchConfirmed: false,
candidates: [],
showMoreInfo: false,
aiVerdicts: {},
// City often only ever comes up in the first few chat messages, not any
// structured Tinder field, so this is a starting point to confirm or
// correct rather than something trusted outright — pre-filled from a
// "City" field if the profile had one, blank otherwise.
cityOverride: fields.find((f) => f.label === 'City')?.value || '',
stageOverride: 'Matched',
ratingOverride: 0,
// The permanent id back to this exact Tinder match, from the page's own
// URL — lets a later import check whether this connection is still in
// Tinder's current match list at all, not just "matched at some point".
matchId: String(raw.matchId || '').trim(),
};
const candidates = matchCandidates(parsed.name, 6);
parsed.candidates = candidates;
const match = candidates[0] || null;
parsed.match = match;
if (match && match.why === 'exact') { parsed.chosenId = match.conn.id; parsed.matchConfirmed = true; }
pending = parsed;
refreshOverrides();
}

// Re-suggests Stage and Rating for whichever connection is now chosen —
// called on load and every time chosenId changes. City isn't touched
// here: it comes from the extracted text, not from who's picked, and
// re-deriving it on every pick would blow away anything the user just
// typed.
function refreshOverrides() {
const conn = data.connections.find((c) => c.id === pending.chosenId);
pending.stageOverride = suggestedStage(conn);
pending.ratingOverride = conn ? (conn.priority || 0) : 0;
}

// Moves on to whatever's next in a batch (after a save or an explicit
// skip), or clears the review entirely once nothing's left — the one exit
// point both save() and the Skip button funnel through.
function advanceQueue(message) {
if (queue.length) {
loadFromRaw(queue.shift());
render();
const freshStatus = document.getElementById('tinder-status');
if (freshStatus) freshStatus.textContent = `${message} Showing the next one — ${queue.length} more after it.`;
} else {
pending = null;
render();
const freshStatus = document.getElementById('tinder-status');
if (freshStatus) freshStatus.textContent = message;
}
}

function initTinderImport() {
const box = document.getElementById('tinder-input');
if (!box) return;
const status = document.getElementById('tinder-status');

document.getElementById('tinder-import-btn').addEventListener('click', () => {
let raws;
try {
raws = parseBatch(box.value);
} catch (err) {
status.textContent = `Couldn't read that: ${err.message}. Paste the JSON the snippet copied.`;
return;
}
if (!raws.length) { status.textContent = 'Paste the copied JSON first.'; return; }
queue = raws.slice(1);
loadFromRaw(raws[0]);
const p = pending;
const matchNote = p.match
? (p.match.why === 'exact' ? `Matched ${p.match.conn.name} exactly — check the fields below, then save.` : `Possible match found (${p.match.why}) — confirm it's really them before saving.`)
: 'No matching connection — pick one or add new.';
status.textContent = raws.length > 1 ? `Loaded 1 of ${raws.length} in this batch. ${matchNote}` : matchNote;
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

const bulkCopyBtn = document.getElementById('tinder-bulk-copy-snippet');
if (bulkCopyBtn) {
bulkCopyBtn.addEventListener('click', async () => {
try {
await navigator.clipboard.writeText(document.getElementById('tinder-bulk-snippet').textContent);
bulkCopyBtn.textContent = 'Copied';
setTimeout(() => { bulkCopyBtn.textContent = 'Copy bulk-import snippet'; }, 2000);
} catch (e) {
status.textContent = 'Copy failed — select the snippet and copy it manually.';
}
});
}
render();
}

export { initTinderImport };
