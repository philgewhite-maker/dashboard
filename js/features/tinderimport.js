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
import { data, queueSave, currentAge, computeFlags, distanceMiles, FLAG_FIELD_DEFS } from '../state.js';
import { escapeHtml, uid, todayStr, hydratePhotoBackgrounds } from '../utils.js';
import { nameKey, editDistance } from '../googlecontacts.js';
import { storePhoto, fetchProxiedImage } from '../files.js';
import { photoGet } from '../db.js';
import { MissingKeyError, compareFaces, translateText, identifyCountry } from '../ai.js';
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

// Identifies a Tinder photo by its stable folder id + uuid, not the full
// URL — the same photo's URL changes between scrapes (size prefix, signed
// token), but this pair doesn't. Same logic as the console snippet's own
// photoKey(), used there to dedupe within one scrape; used here to dedupe
// across import passes, since storePhoto() always mints a fresh id even
// for byte-identical content, so an id-based check can never catch a
// re-imported photo.
const PHOTO_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
function photoKey(url) {
const folder = url.match(/gotinder\.com\/([a-zA-Z0-9]+)\//);
const uuid = url.match(PHOTO_UUID_RE);
return folder && uuid ? `${folder[1]}/${uuid[0]}` : url;
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
//
// incomingAge nudges ordering WITHIN a name tier only (a few points either
// way) — never enough to jump a "shortened name" candidate ahead of a
// genuine exact match, just enough to break a tie between two people
// who'd otherwise score identically on name alone (two "Anna"s is exactly
// the case this can't tell apart from name text; age usually can).
function matchCandidates(name, limit, incomingAge) {
const key = nameKey(name);
if (!key) return [];
const namesOf = (c) => [c.name, c.profileName, ...(c.aliases || [])].filter(Boolean);
const wantAge = Number.isFinite(incomingAge) ? incomingAge : null;
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
if (best) {
if (wantAge !== null) {
const theirAge = currentAge(c);
if (theirAge) best.score -= Math.min(Math.abs(theirAge.value - wantAge) * 3, 15);
}
results.push({ conn: c, why: best.why, score: best.score });
}
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
photoId: null, photoIds: [], tinderPhotoKeys: [], photoAlbums: [], age: '', dob: '', ageAsOf: '', location: '', address: '',
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
'Matched on': 'matchedOn', 'Chat history': 'chatLog', 'Last message date': 'lastContact',
};
// Unlike the rest of FIELD_MAP, this one's SUPPOSED to change every import
// — that's the entire point of extracting it — so it's exempt from the
// usual already-set-defaults-to-unchecked rule (see refreshOverrides()).
const ALWAYS_APPLY_LABELS = new Set(['Last message date']);

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
Nationality: { target: 'nationality', split: false },
// Neither of these has a dedicated field of its own — both route into the
// generic tags chip list so they're at least taggable/flaggable, rather
// than sitting unfindable in a wall of notes text (where they were before).
'How often do you smoke?': { target: 'tags', split: false },
Gender: { target: 'tags', split: false },
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
? `<div class="tinder-photo-grid">${existingIds.map((id) => `<span class="thumb-lg"><span class="thumb-img" data-photo-bg="${escapeHtml(id)}"></span></span>`).join('')}</div>`
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
? `<div class="tinder-photo-grid">${pending.photos.map((ph) => `<span class="thumb-lg" style="background-image:url('${escapeHtml(ph.url)}')"></span>`).join('')}</div>`
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

function withTimeout(promise, ms) {
return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))]);
}

// Keyed by field index (pending.translations). Tries Chrome's on-device,
// fully local LanguageDetector first (free, no network, no API key) — if
// it confidently says the text is already English, that's the end of it,
// no Anthropic call spent confirming what's already obvious. Anything
// else (detector unavailable, uncertain, or genuinely non-English) falls
// through to Claude, which detects AND translates in the one call. The
// timeout guard exists because Chrome's on-device APIs are new enough
// that "unavailable" isn't always a clean, fast rejection.
const LOCAL_DETECT_TIMEOUT_MS = 6000;
async function runTranslateFor(i) {
pending.translations[i] = 'loading';
render();
const text = pending.fields[i].value;
try {
if (typeof self !== 'undefined' && 'LanguageDetector' in self) {
try {
const detector = await withTimeout(self.LanguageDetector.create(), LOCAL_DETECT_TIMEOUT_MS);
const results = await withTimeout(detector.detect(text), LOCAL_DETECT_TIMEOUT_MS);
if (results && results[0] && results[0].detectedLanguage === 'en' && results[0].confidence > 0.6) {
pending.translations[i] = { language: 'English', translation: text, alreadyEnglish: true };
render();
return;
}
} catch (localErr) {
console.warn('On-device language detection unavailable, falling back to Anthropic:', localErr);
}
}
pending.translations[i] = await translateText(text);
} catch (err) {
console.error('Translation failed:', err);
pending.translations[i] = { error: err instanceof MissingKeyError ? 'Add an Anthropic API key in Settings first.' : (err.message || String(err)) };
}
render();
}

async function runCountryFor(i) {
pending.countries[i] = 'loading';
render();
try {
pending.countries[i] = await identifyCountry(pending.fields[i].value);
} catch (err) {
console.error('Country lookup failed:', err);
pending.countries[i] = { error: err instanceof MissingKeyError ? 'Add an Anthropic API key in Settings first.' : (err.message || String(err)) };
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

// Cyrillic place names don't have the luxury of a known-good list (unlike
// English city hits above) — nobody's own City field is ever stored in
// Cyrillic. So this is a mechanical fallback: a straightforward per-letter
// transliteration, upgraded to the real English exonym for the common
// cities where the two differ (Москва -> "Moskva" is readable but wrong;
// it should read "Moscow"). Not exhaustive; anything missing still gets a
// legible transliteration rather than nothing.
const CYRILLIC_EXONYMS = {
'москва': 'Moscow', 'санкт-петербург': 'Saint Petersburg', 'киев': 'Kyiv', 'київ': 'Kyiv',
'минск': 'Minsk', 'одесса': 'Odesa', 'одеса': 'Odesa', 'харьков': 'Kharkiv', 'харків': 'Kharkiv',
'львов': 'Lviv', 'львів': 'Lviv', 'новосибирск': 'Novosibirsk', 'екатеринбург': 'Yekaterinburg',
'казань': 'Kazan', 'нижний новгород': 'Nizhny Novgorod', 'ростов-на-дону': 'Rostov-on-Don',
'краснодар': 'Krasnodar', 'сочи': 'Sochi', 'владивосток': 'Vladivostok', 'челябинск': 'Chelyabinsk',
'омск': 'Omsk', 'самара': 'Samara', 'уфа': 'Ufa', 'пермь': 'Perm', 'волгоград': 'Volgograd',
'воронеж': 'Voronezh', 'алматы': 'Almaty', 'ташкент': 'Tashkent', 'баку': 'Baku', 'тбилиси': 'Tbilisi',
'ереван': 'Yerevan', 'кишинёв': 'Chisinau', 'бишкек': 'Bishkek', 'астана': 'Astana',
};
const CYRILLIC_TRANSLIT = {
а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y',
к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
і: 'i', ї: 'yi', є: 'ye', ґ: 'g',
};
function transliterateCyrillic(text) {
const out = [...text].map((ch) => {
const t = CYRILLIC_TRANSLIT[ch.toLowerCase()];
if (t === undefined) return ch;
return ch === ch.toLowerCase() ? t : t.charAt(0).toUpperCase() + t.slice(1);
}).join('');
return out.charAt(0).toUpperCase() + out.slice(1);
}

// The City field's raw extracted value pre-fills the editable #tinder-city
// input, which is what actually gets saved (see pending.cityOverride below)
// — if the extracted value is Cyrillic, that input started pre-filled with
// the RAW Cyrillic text, so overwriting an existing (also-Cyrillic) City
// with "the same" value never actually offered a usable English one.
// Transliterating this ONE spot fixes it at the source rather than at
// every place the value gets read.
function transliterateCityValue(v) {
const trimmed = String(v || '').trim();
if (!trimmed || !/[Ѐ-ӿ]/.test(trimmed)) return trimmed;
return CYRILLIC_EXONYMS[trimmed.toLowerCase()] || transliterateCyrillic(trimmed);
}

// Cyrillic-script languages this app already knows how to spot in a
// structured Languages field (see LANGUAGES in the console snippet). If
// the profile listed exactly one of these, that's almost certainly what
// the Cyrillic text is in; otherwise there's no way to tell Russian from
// Ukrainian from Bulgarian short of asking the AI, so it's just labelled
// by script rather than guessed.
const CYRILLIC_LANGUAGES = new Set(['Russian', 'Ukrainian', 'Bulgarian', 'Serbian', 'Belarusian', 'Macedonian']);
function cyrillicLanguageGuess() {
const langField = pending && pending.fields && pending.fields.find((f) => f.label === 'Languages');
if (!langField) return 'Slavic';
const hits = langField.value.split(',').map((s) => s.trim()).filter((p) => CYRILLIC_LANGUAGES.has(p));
return hits.length === 1 ? hits[0] : 'Slavic';
}

// A generic "+ add <language>" action wherever a field's raw text
// contains Cyrillic, so a specific language (from the profile's own
// Languages field, if it names exactly one Cyrillic-script one) or the
// "Slavic" fallback becomes an actual saved tag, not just a tooltip
// nobody acts on. Reuses the exact same data-tinder-translate-add
// handler the Translate button's "+ add" already wires up.
function cyrillicAddButtonHtml(text) {
if (!/[Ѐ-ӿ]/.test(text)) return '';
const lang = cyrillicLanguageGuess();
const alreadyHasLang = pending.fields.some((f) => f.label === 'Languages' && f.value.split(',').map((s) => s.trim()).includes(lang));
if (alreadyHasLang) return '';
return ` <button type="button" class="sync-btn tinder-inline-btn" data-tinder-translate-add="${escapeHtml(lang)}">+ add ${escapeHtml(lang)}</button>`;
}

const CYRILLIC_RUN_RE = '[\\u0400-\\u04FF]+(?:[ \\-][\\u0400-\\u04FF]+)*';

// Every distinct value any red/amber/green value-list rule cares about,
// so something like "Sober" or "Want kids" gets highlighted wherever it
// shows up in free text (About me, prompt answers, chat) -- not just
// when it happens to arrive as a cleanly separate field. Threshold rules
// (Distance, Height...) have no discrete text values, so they're not
// part of this. First rule wins on a same-value collision across colours.
function flagValueMap() {
const map = new Map(); // lowercase value -> {label: original casing, color}
(data.flagRules || []).forEach((rule) => {
['green', 'amber', 'red'].forEach((color) => {
(rule[color] || []).forEach((v) => {
const key = String(v).toLowerCase().trim();
if (key && !map.has(key)) map.set(key, { label: v, color });
});
});
});
return map;
}

function highlightCities(text) {
const cityMap = knownCityMap();
const flagMap = flagValueMap();
// Longest names first, so a multi-word city ("New York") wins whole
// rather than a shorter, unrelated city name that happens to be a
// substring of it matching first.
const names = [...cityMap.values()].sort((a, b) => b.length - a.length);
const flagValues = [...flagMap.values()].map((v) => v.label).sort((a, b) => b.length - a.length);
const cityPattern = names.length ? `\\b(?:${names.map(escapeRegex).join('|')})\\b` : null;
// A negated lookbehind on EACH value individually, not wrapped around the
// whole alternation — otherwise "Non-smoker" still matches "smoker" as a
// substring (the hyphen is a word boundary on its own), flagging the
// exact opposite of what was actually said. Confirmed live. Only catches
// the "non-"/"non " prefix specifically, not general negation ("not a
// smoker", "don't smoke") -- a real limitation, not a claim of full
// negation-parsing.
const flagPattern = flagValues.length ? `(?:${flagValues.map((v) => `(?<!non-)(?<!non )\\b${escapeRegex(v)}\\b`).join('|')})` : null;
const parts = [cityPattern, flagPattern, CYRILLIC_RUN_RE].filter(Boolean);
const re = new RegExp(parts.join('|'), 'gi');
let out = '';
let last = 0;
let m;
while ((m = re.exec(text))) {
out += escapeHtml(text.slice(last, m.index));
const hit = m[0];
if (cityMap.has(hit.toLowerCase())) {
const original = cityMap.get(hit.toLowerCase());
out += `<span class="tinder-city-hit" data-tinder-city="${escapeHtml(original)}" title="Click to set as City">${escapeHtml(hit)}</span>`;
} else if (flagMap.has(hit.toLowerCase())) {
const { color } = flagMap.get(hit.toLowerCase());
out += `<span class="tinder-flag-hit tinder-flag-hit-${color}" title="Flagged ${color}">${escapeHtml(hit)}</span>`;
} else {
const exonym = CYRILLIC_EXONYMS[hit.trim().toLowerCase()];
// A real place name is a word or two; a long run is a sentence caught
// up in the same Cyrillic-script match, not a city — offering to set
// City to a transliterated SENTENCE would be actively wrong, and full
// prose is what the Translate button is for, not this.
const wordCount = hit.trim().split(/[\s-]+/).filter(Boolean).length;
if (exonym || wordCount <= 3) {
const guess = exonym || transliterateCyrillic(hit);
const lang = cyrillicLanguageGuess();
out += `<span class="tinder-cyrillic-hit" data-tinder-city="${escapeHtml(guess)}" title="${escapeHtml(`${lang}: "${guess}" — click to set as City`)}">${escapeHtml(hit)}</span>`;
} else {
out += escapeHtml(hit);
}
}
last = m.index + hit.length;
}
out += escapeHtml(text.slice(last));
return out;
}

// One line per message, sender colour-coded — "You" in blue, the match
// in pink — so a long back-and-forth reads as a conversation instead of
// one run-on paragraph. Same [HH:MM] Sender: message shape the parser
// and hasMutualMessages() already assume; a line that doesn't match (
// shouldn't normally happen) still renders, just without the split.
function chatHistoryHtml(text) {
return text.split('\n').map((line) => {
const m = line.match(/^\[(\d{1,2}:\d{2})\]\s*([^:]+):\s*(.*)$/);
if (!m) return `<div class="tinder-chat-line">${highlightCities(line)}</div>`;
const [, time, sender, message] = m;
const senderName = sender.trim();
const senderClass = senderName === 'You' ? 'tinder-chat-you' : 'tinder-chat-them';
return `<div class="tinder-chat-line"><span class="tinder-chat-time">[${escapeHtml(time)}]</span> <span class="${senderClass}">${escapeHtml(senderName)}</span>: ${highlightCities(message)}</div>`;
}).join('');
}

// Structured, short-value fields where "translate this" is meaningless —
// a language name, a bearing, a single word already matched against a
// closed enum. Everything else (job titles, school names, prompt answers,
// chat, the notes catch-all) is free text that could genuinely be in
// another language.
const SKIP_TRANSLATE_LABELS = new Set(['Height', 'Distance', 'Pronouns', 'Gender', 'Orientation', 'Languages']);

function translateButtonHtml(f, i) {
if (SKIP_TRANSLATE_LABELS.has(f.label)) return '';
return `<button type="button" class="sync-btn tinder-inline-btn" data-tinder-translate="${i}">Translate</button>`;
}

function translationResultHtml(i) {
const t = pending.translations[i];
if (!t) return '';
if (t === 'loading') return `<div class="tinder-translate-result">Checking language…</div>`;
if (t.error) return `<div class="tinder-translate-result tinder-translate-error">Translate failed: ${escapeHtml(t.error)}</div>`;
if (t.alreadyEnglish) return `<div class="tinder-translate-result"><span class="tinder-engine-badge tinder-engine-free">Free, on-device</span> Already English — no Anthropic call made.</div>`;
if (!t.language || !t.translation) return `<div class="tinder-translate-result tinder-translate-error">Couldn't tell what language this is.</div>`;
const alreadyHasLang = pending.fields.some((f) => f.label === 'Languages' && f.value.split(',').map((s) => s.trim()).includes(t.language));
// The translation is shown, but nothing saves IT anywhere -- only the
// language tag has an "+ add" action. "+ save both" appends it onto the
// field's own value, so the original AND the English version both end
// up saved together rather than the translation only ever existing as a
// throwaway preview.
const alreadySaved = pending.fields[i].value.includes(t.translation);
// Getting here at all means the free on-device check either said this
// ISN'T English, or wasn't available to ask in the first place — either
// way, every translation actually shown came from a paid Anthropic call,
// never the free path (which can only ever short-circuit to the branch
// above). A muted inline "(via Anthropic)" note turned out too easy to
// miss (confirmed live) -- a coloured badge is the same information made
// impossible to scroll past without noticing.
return `<div class="tinder-translate-result"><span class="tinder-engine-badge tinder-engine-paid">via Anthropic</span> <strong>${escapeHtml(t.language)}:</strong> ${escapeHtml(t.translation)}`
+ (alreadyHasLang ? '' : ` <button type="button" class="sync-btn tinder-inline-btn" data-tinder-translate-add="${escapeHtml(t.language)}">+ add ${escapeHtml(t.language)}</button>`)
+ (alreadySaved ? '' : ` <button type="button" class="sync-btn tinder-inline-btn" data-tinder-translate-save="${i}">+ save both</button>`)
+ `</div>`;
}

// City and School are the two labels this app ever puts a bare place name
// in — a job title or prompt answer isn't a place, so a country lookup
// there wouldn't mean anything.
const COUNTRY_LOOKUP_LABELS = new Set(['City', 'School']);

function countryButtonHtml(f, i) {
if (!COUNTRY_LOOKUP_LABELS.has(f.label)) return '';
return `<button type="button" class="sync-btn tinder-inline-btn" data-tinder-country="${i}">Country</button>`;
}

function countryResultHtml(f, i) {
const c = pending.countries[i];
if (!c) return '';
if (c === 'loading') return `<div class="tinder-translate-result">Identifying country…</div>`;
if (c.error) return `<div class="tinder-translate-result tinder-translate-error">Country lookup failed: ${escapeHtml(c.error)}</div>`;
if (!c.country) return `<div class="tinder-translate-result tinder-translate-error">Couldn't identify a country.</div>`;
const conn = data.connections.find((x) => x.id === pending.chosenId);
// City's real value lives in the separate #tinder-city input
// (pending.cityOverride), not this field's own f.value -- that's what
// actually gets saved to conn.location, so appending there is what
// makes the country stick for City specifically.
const currentValue = f.label === 'City' ? pending.cityOverride : f.value;
const alreadyAppended = currentValue.toLowerCase().includes(c.country.toLowerCase());
const alreadyNational = !!(conn && (conn.nationality || []).some((n) => n.toLowerCase() === c.country.toLowerCase()));
return `<div class="tinder-translate-result">→ <strong>${escapeHtml(c.country)}</strong>`
+ (alreadyAppended ? '' : ` <button type="button" class="sync-btn tinder-inline-btn" data-tinder-country-append="${i}">+ append</button>`)
+ (alreadyNational ? '' : ` <button type="button" class="sync-btn tinder-inline-btn" data-tinder-country-nationality="${i}">+ add nationality</button>`)
+ `</div>`;
}

// A match within a short distance of you is probably in the same city --
// not certain (tourists, edge-of-city addresses), so this is offered as
// an amber, addable suggestion next to Distance rather than silently
// filling City. Deliberately independent of any Distance flag rule's own
// greenMax -- "is this close enough to be worth pursuing" and "is this
// probably my own city" are different questions that happen to share a
// similar number in the common case, not the same setting.
const PROPOSED_CITY_MAX_MILES = 10;
function proposedCityHtml() {
const myCity = String(data.myCity || '').trim();
if (!myCity) return '';
const distField = pending.fields.find((f) => f.label === 'Distance');
if (!distField) return '';
const miles = distanceMiles(distField.value);
if (miles === null || miles > PROPOSED_CITY_MAX_MILES) return '';
if (pending.cityOverride.trim().toLowerCase() === myCity.toLowerCase()) return '';
return `<div class="tinder-field-note" style="margin:2px 0 8px;">`
+ `<span class="tinder-flag-hit tinder-flag-hit-amber">${escapeHtml(myCity)}</span> — within ${miles}mi of you, probably the same city (tourist or a longer commute could still be wrong) `
+ `<button type="button" class="sync-btn tinder-inline-btn" data-tinder-propose-city="1">+ set as City</button>`
+ `</div>`;
}

function fieldPreviewHtml(f, i) {
const conn = data.connections.find((c) => c.id === pending.chosenId);
const target = FIELD_MAP[f.label];
const arrayMap = ARRAY_FIELD_MAP[f.label];
let note = 'will be added to notes';
let disabled = false; // truly nothing to do (array field, nothing new to add) — stays unchecked and locked
let dim = false; // already has a value, so unchecked-by-default, but still a real, checkable override
if (conn && target) {
const current = String(conn[target] || '').trim();
if (current) { note = `already set to "${current}" — check to overwrite`; dim = !f.apply; }
else note = `will set ${f.label}`;
} else if (conn && arrayMap) {
const existingTags = new Set((conn[arrayMap.target] || []).map((t) => t.toLowerCase()));
const parts = arrayMap.split ? f.value.split(',').map((s) => s.trim()).filter(Boolean) : [f.value.trim()];
const fresh = parts.filter((p) => !existingTags.has(p.toLowerCase()));
note = fresh.length === 0 ? `already in ${arrayMap.target} — will be skipped`
: fresh.length === parts.length ? `will add to ${arrayMap.target}`
: `will add ${fresh.length} new to ${arrayMap.target}, rest already there`;
if (fresh.length === 0) { disabled = true; dim = true; }
}
const isChat = f.label === 'Chat history';
const flagColor = isChat ? null : fieldFlagColor(f);
const valueHtml = isChat ? '' : (flagColor
? `<span class="tinder-flag-hit tinder-flag-hit-${flagColor}" title="Flagged ${flagColor}">${highlightCities(f.value)}</span>`
: highlightCities(f.value));
return `<div class="tinder-field-row${dim ? ' tinder-field-blocked' : ''}">
<label class="tinder-field-label">
<input type="checkbox" data-tinder-field="${i}"${f.apply && !disabled ? ' checked' : ''}${disabled ? ' disabled' : ''}>
<span><strong>${escapeHtml(f.label)}:</strong>${isChat ? '' : ` ${valueHtml}`} <span class="tinder-field-note">(${escapeHtml(note)})</span></span>
</label>
${translateButtonHtml(f, i)}
${countryButtonHtml(f, i)}
${cyrillicAddButtonHtml(f.value)}
</div>
${f.label === 'Distance' ? proposedCityHtml() : ''}
${isChat ? `<div class="tinder-chat-block">${chatHistoryHtml(f.value)}</div>` : ''}
${translationResultHtml(i)}
${countryResultHtml(f, i)}`;
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

// Builds a connection-shaped object out of the INCOMING draft data (not
// the matched connection's already-saved data, which gets its own flags
// on the Connections list already) -- so a red/amber/green rule can fire
// on what THIS profile says before you've even decided whether to save
// it, using the exact same rules and computeFlags() as everywhere else.
function draftConnForFlags() {
const draft = {};
pending.fields.forEach((f) => {
const target = FIELD_MAP[f.label];
if (target) { draft[target] = f.value; return; }
const arrayMap = ARRAY_FIELD_MAP[f.label];
if (arrayMap) {
if (!Array.isArray(draft[arrayMap.target])) draft[arrayMap.target] = [];
const parts = arrayMap.split ? f.value.split(',').map((s) => s.trim()).filter(Boolean) : [f.value.trim()];
draft[arrayMap.target].push(...parts);
}
});
if (pending.cityOverride.trim()) draft.location = pending.cityOverride.trim();
if (pending.age) { draft.age = pending.age; draft.ageAsOf = todayStr(); }
return draft;
}

function flagBreakdownHtml() {
const flags = computeFlags(draftConnForFlags(), data.flagRules);
if (!flags.hits.length) return '';
return `<div class="flag-breakdown" style="margin:4px 0 8px;">${flags.hits.map((h) => `<span class="dot ${h.color}"></span>${escapeHtml(h.label)}`).join(' &nbsp; ')}</div>`;
}

// Value-list rules (Education, Sober, Smoker...) get their inline
// highlight via highlightCities()'s literal-phrase matching, but a
// threshold rule (Height, Distance, Age) has no discrete text value to
// match against a phrase — it's a number computed from the field, so
// "178cm" can't be found by scanning for "178cm" the way "Sober" can be
// found by scanning for "Sober". Confirmed live: Height never
// highlighted at all under the old scheme. This checks the SAME
// computeFlags() result the summary breakdown already uses, keyed by
// which connection field this Tinder field label routes to, so a
// threshold field's whole value gets wrapped instead of substring-matched.
function fieldFlagColor(f) {
const target = FIELD_MAP[f.label];
if (!target) return null;
const def = FLAG_FIELD_DEFS.find((d) => d.field === target);
if (!def || def.kind !== 'number') return null;
const flags = computeFlags(draftConnForFlags(), data.flagRules);
const hit = flags.hits.find((h) => h.field === target);
return hit ? hit.color : null;
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
${flagBreakdownHtml()}

<select id="tinder-pick">${optionsFor(p.chosenId, p.candidates)}</select>

${p.risky ? `<div class="tinder-field-note tinder-translate-error" style="margin:6px 0 0;">More than one connection shares this name (and a similar age) — double-check the photo before saving, this pick might be wrong.</div>` : ''}
<div class="sync-row" style="margin:6px 0 8px;align-items:center;">
${chosenConn && chosenConn.photoId ? `<span class="tinder-confirm-pic" data-photo-bg="${escapeHtml(chosenConn.photoId)}" title="${escapeHtml(chosenConn.name)}"></span>` : ''}
<button class="add-btn tinder-save-btn${p.risky ? ' tinder-risky' : ''}" type="button" id="tinder-save"${canSave ? '' : ' disabled'} title="${escapeHtml(saveLabel)}">${escapeHtml(saveLabel)}</button>
<button class="sync-btn" type="button" id="tinder-save-open"${canSave ? '' : ' disabled'} title="${escapeHtml(saveLabel)} & open profile">& open profile</button>
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
<div class="photo-gallery">${p.photos.map((ph, i) => `<span class="gallery-thumb tinder-photo-thumb${ph.apply ? ' tinder-photo-included' : ''}" data-tinder-photo="${i}" style="background-image:url('${escapeHtml(ph.url)}')">${ph.apply ? '<span class="tinder-photo-badge">&check;</span>' : ''}</span>`).join('')}</div>` : ''}
</div>
${moreInfoHtml()}`;
// Every render rebuilds this whole card, including fresh, un-hydrated
// [data-photo-bg] placeholders — never called here before, so a photo
// only ever showed up if something ELSE had hydrated that exact id
// first, and vanished again on the very next render (any checkbox
// toggle, dropdown change, etc. all re-render).
hydratePhotoBackgrounds(el);

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
el.querySelectorAll('[data-tinder-translate]').forEach((btn) => {
btn.addEventListener('click', () => runTranslateFor(parseInt(btn.dataset.tinderTranslate, 10)));
});
el.querySelectorAll('[data-tinder-translate-add]').forEach((btn) => {
btn.addEventListener('click', () => {
pending.fields.push({ label: 'Languages', value: btn.dataset.tinderTranslateAdd, apply: true });
render();
});
});
el.querySelectorAll('[data-tinder-translate-save]').forEach((btn) => {
btn.addEventListener('click', () => {
const i = parseInt(btn.dataset.tinderTranslateSave, 10);
const f = pending.fields[i];
const t = pending.translations[i];
if (!f || !t || !t.translation) return;
f.value = `${f.value}\n\n(${t.language} translation) ${t.translation}`;
render();
});
});
el.querySelectorAll('[data-tinder-country]').forEach((btn) => {
btn.addEventListener('click', () => runCountryFor(parseInt(btn.dataset.tinderCountry, 10)));
});
el.querySelectorAll('[data-tinder-country-append]').forEach((btn) => {
btn.addEventListener('click', () => {
const i = parseInt(btn.dataset.tinderCountryAppend, 10);
const f = pending.fields[i];
const country = pending.countries[i].country;
if (f.label === 'City') pending.cityOverride = `${pending.cityOverride}, ${country}`;
else f.value = `${f.value}, ${country}`;
render();
});
});
el.querySelectorAll('[data-tinder-country-nationality]').forEach((btn) => {
btn.addEventListener('click', () => {
const i = parseInt(btn.dataset.tinderCountryNationality, 10);
pending.fields.push({ label: 'Nationality', value: pending.countries[i].country, apply: true });
render();
});
});
const proposeCityBtn = el.querySelector('[data-tinder-propose-city]');
if (proposeCityBtn) proposeCityBtn.addEventListener('click', () => {
pending.cityOverride = String(data.myCity || '').trim();
render();
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
const confirmRisky = () => !pending.risky || confirm('More than one connection shares this name and a similar age — this pick might be the wrong person. Save anyway?');
const saveBtn = document.getElementById('tinder-save');
if (saveBtn) saveBtn.addEventListener('click', () => { if (confirmRisky()) save(false); });
const saveOpenBtn = document.getElementById('tinder-save-open');
if (saveOpenBtn) saveOpenBtn.addEventListener('click', () => { if (confirmRisky()) save(true); });
}

// openAfter opens the connection's own card, expanded, in a new tab once
// the save actually lands -- a separate real page load (this is a single-
// page app with no per-connection URL otherwise), so it goes through the
// same #<tab>:<id> hash format initTabs() already parses.
async function save(openAfter) {
if (!pending || !pending.chosenId) return;
const conn = data.connections.find((c) => c.id === pending.chosenId);
if (!conn) return;
const connId = conn.id;
const status = document.getElementById('tinder-save-status');
if (status) status.textContent = 'Saving…';

// Fill-if-empty, same rule as every other field — age previously
// overwrote unconditionally, which is what erased Lenka's real age when
// Leila's data landed on her record by mistake.
if (pending.age && !String(conn.age || '').trim()) { conn.age = pending.age; conn.ageAsOf = todayStr(); }

pending.fields.filter((f) => f.apply).forEach((f) => {
const target = FIELD_MAP[f.label];
if (target) {
// f.apply is now the single source of truth for whether this writes:
// refreshOverrides() already defaults an already-set field to unchecked,
// so a field that reaches here checked is a deliberate overwrite, not an
// accidental one -- the old fill-if-empty guard here silently blocked
// that override from ever taking effect even once the box was checked.
conn[target] = f.value;
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

if (!Array.isArray(conn.tinderPhotoKeys)) conn.tinderPhotoKeys = [];
const toFetch = pending.photos.filter((ph) => ph.apply);
let failed = 0;
let firstError = '';
let alreadyHad = 0;
for (let i = 0; i < toFetch.length; i++) {
const ph = toFetch[i];
const key = photoKey(ph.url);
// storePhoto() always mints a fresh id, even for content already saved
// on a previous pass, so the id-based check just below this can never
// catch a re-import — this key-based check is what actually prevents
// the duplicate.
if (conn.tinderPhotoKeys.includes(key)) { alreadyHad++; ph.apply = false; continue; }
if (status) status.textContent = `Saving… photo ${i + 1} of ${toFetch.length}`;
try {
const blob = await fetchTinderPhoto(ph.url);
const id = await storePhoto(blob);
if (!conn.photoIds.includes(id)) conn.photoIds.push(id);
conn.tinderPhotoKeys.push(key);
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
.then(([c, o]) => { c.renderConnections(); o.renderOverview(); hydratePhotoBackgrounds(document.getElementById('conn-list') || document.body); });
if (openAfter) window.open(`${location.origin}${location.pathname}#dating:${connId}`, '_blank');

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
const dupeNote = alreadyHad ? ` (${alreadyHad} already had.)` : '';
if (failed) {
pending.saveMessage = `Saved fields to ${conn.name}. ${failed} of ${toFetch.length} photo${toFetch.length === 1 ? '' : 's'} failed: ${firstError} — click Save again to retry.${dupeNote}`;
render();
} else {
advanceQueue(`Saved to ${conn.name}.${dupeNote}`);
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

// Shared by the paste box and the file-upload path (a previously-saved
// tinder-batch-*.json, either the bulk snippet's own automatic download-
// safety-net file, or any older batch worth re-running through TODAY's
// import logic — every fix that lives on this side, not the console-
// snippet side, applies retroactively just by re-feeding the same raw
// {label,value} data through it again).
function loadBatch(raws, status) {
if (!raws.length) { if (status) status.textContent = 'Nothing to import in that.'; return; }
queue = raws.slice(1);
loadFromRaw(raws[0]);
const p = pending;
const matchNote = p.match
? (p.match.why === 'exact' ? `Matched ${p.match.conn.name} exactly — check the fields below, then save.` : `Possible match found (${p.match.why}) — confirm it's really them before saving.`)
: 'No matching connection — pick one or add new.';
if (status) status.textContent = raws.length > 1 ? `Loaded 1 of ${raws.length} in this batch. ${matchNote}` : matchNote;
render();
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
translations: {},
countries: {},
// City often only ever comes up in the first few chat messages, not any
// structured Tinder field, so this is a starting point to confirm or
// correct rather than something trusted outright — pre-filled from a
// "City" field if the profile had one, blank otherwise.
cityOverride: transliterateCityValue(fields.find((f) => f.label === 'City')?.value || ''),
stageOverride: 'Matched',
ratingOverride: 0,
// The permanent id back to this exact Tinder match, from the page's own
// URL — lets a later import check whether this connection is still in
// Tinder's current match list at all, not just "matched at some point".
matchId: String(raw.matchId || '').trim(),
};
const incomingAge = parseInt(parsed.age, 10);
const candidates = matchCandidates(parsed.name, 6, Number.isFinite(incomingAge) ? incomingAge : undefined);
parsed.candidates = candidates;
let match = candidates[0] || null;
// A connection already carrying this exact Tinder match id from a
// previous import is a certain identity match, not a guess — whatever
// name-based scoring says, this overrides it and skips confirmation
// entirely, same as an exact name match always has.
const knownConn = parsed.matchId ? data.connections.find((c) => c.tinderMatchId === parsed.matchId) : null;
if (knownConn) {
match = { conn: knownConn, why: 'known match id', score: 999 };
if (!candidates.some((cand) => cand.conn.id === knownConn.id)) candidates.unshift(match);
}
parsed.match = match;
// Two (or more) candidates tied at the same top score means the name
// alone can't actually tell them apart — even an "exact" match here is a
// guess between look-alikes, not a certainty, so it's flagged rather
// than silently auto-picking whichever happened to sort first.
parsed.risky = !knownConn && candidates.length > 1 && candidates[0].score === candidates[1].score;
if (match && (match.why === 'exact' || match.why === 'known match id')) { parsed.chosenId = match.conn.id; parsed.matchConfirmed = true; }
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
// If nothing in THIS import's own text mentioned a city, the field falls
// back to showing what's already saved on the matched connection --
// otherwise it reads blank even when a city genuinely is on file, which
// looks like the data was lost rather than just not re-extracted this
// time. Only when cityOverride is still empty: never overwrites a value
// that came from the fresh scrape, or that the user has since typed.
if (conn && !pending.cityOverride.trim() && conn.location) pending.cityOverride = conn.location;
// A single-value field (Distance, Job, City...) that's already set on the
// matched connection defaults to unchecked, not disabled -- overwriting
// stale data (a match moved city, a bad early scrape) is a real need, but
// it should be a deliberate click, not pre-selected. Only runs when the
// matched connection changes, so it can't stomp a toggle the user already
// made against the SAME connection on a later, unrelated re-render.
if (conn && Array.isArray(pending.fields)) {
pending.fields.forEach((f) => {
const target = FIELD_MAP[f.label];
if (target && String(conn[target] || '').trim() && !ALWAYS_APPLY_LABELS.has(f.label)) f.apply = false;
});
}
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
loadBatch(raws, status);
});

const fileInput = document.getElementById('tinder-file-input');
if (fileInput) {
fileInput.addEventListener('change', async () => {
const file = fileInput.files[0];
fileInput.value = ''; // lets the same file be re-picked later without needing a different one first
if (!file) return;
let raws;
try {
raws = parseBatch(await file.text());
} catch (err) {
status.textContent = `Couldn't read "${file.name}": ${err.message}.`;
return;
}
loadBatch(raws, status);
});
}

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
