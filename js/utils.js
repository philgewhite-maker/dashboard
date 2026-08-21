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

// Lets a plain "Alena" search match a stored "Alëna" (and vice versa) by
// decomposing accented letters into base + combining mark (NFD) and
// dropping the marks -- apply to both sides of any free-text match.
function foldDiacritics(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

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

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Every OTHER connection's own City is a real, known-good value (unlike
// free text, which is too unreliable to guess a place name from) — so
// scanning incoming text for a case-insensitive exact hit against one is
// exact, not a guess. Shared by tinderimport.js's own highlightCities()
// (which layers Cyrillic transliteration on top, so stays local there)
// and highlightFlagValues() below. Takes `connections` as a parameter
// rather than importing state.js, which already imports this module.
function knownCityMap(connections) {
const map = new Map(); // lowercase -> original casing (first one seen)
(connections || []).forEach((c) => {
(c.location || []).forEach((raw) => {
const loc = String(raw || '').trim();
if (loc && !map.has(loc.toLowerCase())) map.set(loc.toLowerCase(), loc);
});
});
return map;
}

// Wraps any free-text occurrence of a flag-rule value (from ANY rule's
// green/amber/red list, any field), a known city name, or a country
// name/nationality adjective in a clickable span — the same mechanisms
// tinderimport.js's fuller highlightCities() uses on incoming profile text
// (minus the Cyrillic-transliteration pass, which needs pending's
// in-progress scan state), extracted so every OTHER place that shows chat
// or notes text — an already-saved connection's Notes and chat history,
// the WhatsApp/Telegram import review screens — gets the same click-to-add
// treatment from one place instead of each growing its own copy. `cityMap`
// is optional — omit it to skip city detection. Takes `rules` as a
// parameter (data.flagRules) rather than importing state.js, which already
// imports this module. Longest values first so a multi-word value ("Want
// kids") wins whole rather than a shorter one matching a substring of it
// first; the negative lookbehind on "non-"/"non " stops "Non-smoker" being
// flagged as "Smoker" (the hyphen is its own word boundary). City wins
// over country/nationality wins over flag-rule on a same-value collision,
// matching the priority order that already existed before country names
// were added here.
function highlightFlagValues(text, rules, cityMap) {
const str = String(text || '');
const map = new Map();
(rules || []).forEach((rule) => {
['green', 'amber', 'red'].forEach((color) => {
(rule[color] || []).forEach((v) => {
const key = String(v).toLowerCase().trim();
if (key && !map.has(key)) map.set(key, { label: v, color });
});
});
});
const cities = cityMap ? [...cityMap.values()] : [];
const cityLower = new Set(cities.map((c) => c.toLowerCase()));
const countryMap = new Map(Object.entries(COUNTRY_NAME_TO_NATIONALITY).map(([name, nat]) => [name.toLowerCase(), { name, nat }]));
[...new Set(Object.values(COUNTRY_NAME_TO_NATIONALITY))].forEach((adj) => {
const key = adj.toLowerCase();
if (!countryMap.has(key)) countryMap.set(key, { name: adj, nat: adj });
});
const countryNames = [...countryMap.values()].map((v) => v.name);
const values = [...cities, ...countryNames, ...[...map.values()].map((v) => v.label)].sort((a, b) => b.length - a.length);
if (!values.length) return escapeHtml(str);
const re = new RegExp(values.map((v) => `(?<!non-)(?<!non )\\b${escapeRegex(v)}\\b`).join('|'), 'gi');
let out = '';
let last = 0;
let m;
while ((m = re.exec(str))) {
out += escapeHtml(str.slice(last, m.index));
const hit = m[0];
const hitLower = hit.toLowerCase();
if (cityLower.has(hitLower)) {
out += `<span class="tinder-city-hit" data-tinder-city="${escapeHtml(hit)}" title="Click to set as City">${escapeHtml(hit)}</span>`;
} else if (countryMap.has(hitLower)) {
const { nat } = countryMap.get(hitLower);
out += `<span class="tinder-city-hit" data-tinder-add-label="Nationality" data-tinder-add-value="${escapeHtml(nat)}" title="Click to add ${escapeHtml(nat)} to Nationality">${escapeHtml(hit)}</span>`;
} else {
const { color } = map.get(hitLower);
out += `<span class="tinder-flag-hit tinder-flag-hit-${color}" title="Flagged ${color}">${escapeHtml(hit)}</span>`;
}
last = m.index + hit.length;
}
out += escapeHtml(str.slice(last));
return out;
}

// Moved here from tinderimport.js's own highlightCities() so WhatsApp and
// Telegram import (which have no per-profile `pending` state to hang a
// local copy off) can offer the same click-to-add-Nationality treatment on
// country names and their adjective forms, not just city names. Pure data,
// no dependency on any importer's state.
const COUNTRY_NAME_TO_NATIONALITY = {
Andorra: 'Andorran', 'United Arab Emirates': 'Emirati', Afghanistan: 'Afghan', 'Antigua and Barbuda': 'Antiguan',
Anguilla: 'Anguillan', Albania: 'Albanian', Armenia: 'Armenian', Angola: 'Angolan', Argentina: 'Argentine',
'American Samoa': 'American Samoan', Austria: 'Austrian', Australia: 'Australian', Aruba: 'Aruban', Azerbaijan: 'Azerbaijani',
'Bosnia and Herzegovina': 'Bosnian', Barbados: 'Barbadian', Bangladesh: 'Bangladeshi', Belgium: 'Belgian',
'Burkina Faso': 'Burkinabe', Bulgaria: 'Bulgarian', Bahrain: 'Bahraini', Burundi: 'Burundian', Benin: 'Beninese',
Bermuda: 'Bermudian', Brunei: 'Bruneian', Bolivia: 'Bolivian', Brazil: 'Brazilian', Bahamas: 'Bahamian',
Bhutan: 'Bhutanese', Botswana: 'Motswana', Belarus: 'Belarusian', Belize: 'Belizean',
Canada: 'Canadian', 'DR Congo': 'Congolese', 'Central African Republic': 'Central African', Congo: 'Congolese',
Switzerland: 'Swiss', 'Ivory Coast': 'Ivorian', "Cote d'Ivoire": 'Ivorian', Chile: 'Chilean', Cameroon: 'Cameroonian',
China: 'Chinese', Colombia: 'Colombian', 'Costa Rica': 'Costa Rican', Cuba: 'Cuban', 'Cape Verde': 'Cape Verdean',
Cyprus: 'Cypriot', 'Czech Republic': 'Czech', Czechia: 'Czech',
Germany: 'German', Djibouti: 'Djiboutian', Denmark: 'Danish', Dominica: 'Dominican', 'Dominican Republic': 'Dominican',
Algeria: 'Algerian',
Ecuador: 'Ecuadorian', Estonia: 'Estonian', Egypt: 'Egyptian', Eritrea: 'Eritrean', Spain: 'Spanish', Ethiopia: 'Ethiopian',
Finland: 'Finnish', Fiji: 'Fijian', Micronesia: 'Micronesian', France: 'French',
Gabon: 'Gabonese', 'United Kingdom': 'British', UK: 'British',
England: 'English', Scotland: 'Scottish', Wales: 'Welsh', 'Northern Ireland': 'Northern Irish',
Grenada: 'Grenadian', Georgia: 'Georgian',
Ghana: 'Ghanaian', Gambia: 'Gambian', Guinea: 'Guinean', 'Equatorial Guinea': 'Equatorial Guinean', Greece: 'Greek',
Guatemala: 'Guatemalan', 'Guinea-Bissau': 'Guinea-Bissauan', Guyana: 'Guyanese', Gibraltar: 'Gibraltarian',
Greenland: 'Greenlandic', Guam: 'Guamanian',
'Hong Kong': 'Hong Konger', Honduras: 'Honduran', Croatia: 'Croatian', Haiti: 'Haitian', Hungary: 'Hungarian',
Indonesia: 'Indonesian', Ireland: 'Irish', Israel: 'Israeli', India: 'Indian', Iraq: 'Iraqi', Iran: 'Iranian',
Iceland: 'Icelandic', Italy: 'Italian',
Jamaica: 'Jamaican', Jordan: 'Jordanian', Japan: 'Japanese',
Kenya: 'Kenyan', Kyrgyzstan: 'Kyrgyz', Cambodia: 'Cambodian', Kiribati: 'I-Kiribati', Comoros: 'Comorian',
'Saint Kitts and Nevis': 'Kittitian', 'North Korea': 'North Korean', 'South Korea': 'South Korean', Kuwait: 'Kuwaiti',
'Cayman Islands': 'Caymanian', Kazakhstan: 'Kazakhstani',
Laos: 'Lao', Lebanon: 'Lebanese', 'Saint Lucia': 'Saint Lucian', Liechtenstein: 'Liechtensteiner', 'Sri Lanka': 'Sri Lankan',
Liberia: 'Liberian', Lesotho: 'Basotho', Lithuania: 'Lithuanian', Luxembourg: 'Luxembourgish', Latvia: 'Latvian', Libya: 'Libyan',
Morocco: 'Moroccan', Monaco: 'Monegasque', Moldova: 'Moldovan', Montenegro: 'Montenegrin', Madagascar: 'Malagasy',
'Marshall Islands': 'Marshallese', 'North Macedonia': 'Macedonian', Mali: 'Malian', Myanmar: 'Burmese', Burma: 'Burmese',
Mongolia: 'Mongolian', Macau: 'Macanese', Macao: 'Macanese', Mauritania: 'Mauritanian', Malta: 'Maltese',
Mauritius: 'Mauritian', Maldives: 'Maldivian', Malawi: 'Malawian', Mexico: 'Mexican', Malaysia: 'Malaysian', Mozambique: 'Mozambican',
Namibia: 'Namibian', 'New Caledonia': 'New Caledonian', Niger: 'Nigerien', Nigeria: 'Nigerian', Nicaragua: 'Nicaraguan',
Netherlands: 'Dutch', Norway: 'Norwegian', Nepal: 'Nepali', Nauru: 'Nauruan', 'New Zealand': 'New Zealand',
Oman: 'Omani',
Panama: 'Panamanian', Peru: 'Peruvian', 'French Polynesia': 'French Polynesian', 'Papua New Guinea': 'Papua New Guinean',
Philippines: 'Filipino', Pakistan: 'Pakistani', Poland: 'Polish', 'Puerto Rico': 'Puerto Rican', Palestine: 'Palestinian',
Portugal: 'Portuguese', Palau: 'Palauan', Paraguay: 'Paraguayan',
Qatar: 'Qatari',
Romania: 'Romanian', Serbia: 'Serbian', Russia: 'Russian', Rwanda: 'Rwandan',
'Saudi Arabia': 'Saudi', 'Solomon Islands': 'Solomon Islander', Seychelles: 'Seychellois', Sudan: 'Sudanese',
Sweden: 'Swedish', Singapore: 'Singaporean', Slovenia: 'Slovenian', Slovakia: 'Slovak', 'Sierra Leone': 'Sierra Leonean',
'San Marino': 'Sammarinese', Senegal: 'Senegalese', Somalia: 'Somali', Suriname: 'Surinamese', 'South Sudan': 'South Sudanese',
'Sao Tome and Principe': 'Sao Tomean', 'El Salvador': 'Salvadoran', Syria: 'Syrian', Eswatini: 'Swazi', Swaziland: 'Swazi',
Chad: 'Chadian', Togo: 'Togolese', Thailand: 'Thai', Tajikistan: 'Tajik', 'Timor-Leste': 'Timorese', 'East Timor': 'Timorese',
Turkmenistan: 'Turkmen', Tunisia: 'Tunisian', Tonga: 'Tongan', Turkey: 'Turkish', 'Türkiye': 'Turkish',
'Trinidad and Tobago': 'Trinidadian', Tuvalu: 'Tuvaluan', Taiwan: 'Taiwanese', Tanzania: 'Tanzanian',
Ukraine: 'Ukrainian', Uganda: 'Ugandan', 'United States': 'American', USA: 'American', 'United States of America': 'American',
Uruguay: 'Uruguayan', Uzbekistan: 'Uzbekistani',
'Vatican City': 'Vatican', 'Saint Vincent and the Grenadines': 'Vincentian', Venezuela: 'Venezuelan', Vietnam: 'Vietnamese',
Vanuatu: 'Ni-Vanuatu',
Samoa: 'Samoan',
Yemen: 'Yemeni',
'South Africa': 'South African', Zambia: 'Zambian', Zimbabwe: 'Zimbabwean',
};

// A short {value, field} chip list for a bulk import review (many chats at
// once, where echoing the whole message text back with inline spans isn't
// practical) -- built directly on highlightFlagValues()'s own output
// rather than re-running the city/country detection separately, so there's
// exactly one place that logic lives. Flag-rule hits are left out here
// (they're a colour/warning, not a "which field" click-to-add), which is
// why this can't just be "count the spans" -- it reads each span's own
// data attributes to know whether it's a city or a country/nationality
// hit and what field that maps to.
function findMentions(text, connections, flagRules) {
const str = String(text || '');
if (!str.trim()) return [];
const highlighted = highlightFlagValues(str, flagRules, knownCityMap(connections));
if (!highlighted || highlighted === escapeHtml(str)) return [];
const wrapper = document.createElement('div');
wrapper.innerHTML = highlighted;
const seen = new Set();
const hits = [];
wrapper.querySelectorAll('[data-tinder-city], [data-tinder-add-value]').forEach((span) => {
const field = span.dataset.tinderCity !== undefined ? 'location' : (span.dataset.tinderAddLabel === 'Nationality' ? 'nationality' : null);
const value = span.dataset.tinderCity !== undefined ? span.dataset.tinderCity : span.dataset.tinderAddValue;
if (!field || !value) return;
const dedupeKey = `${field}:${value.toLowerCase()}`;
if (seen.has(dedupeKey)) return;
seen.add(dedupeKey);
hits.push({ value, field });
});
return hits;
}

// Parses "[HH:MM] Sender: message" lines (the shape the Tinder import
// writes into chatLog) into styled bubbles instead of a wall of plain
// text — shared with tinderimport.js's own chatHistoryHtml() there, which
// additionally runs highlightCities() (city names + Cyrillic
// transliteration, on top of the flag-value pass above) per line; that
// fuller version stays local to the importer since city/Cyrillic
// detection needs pending's in-progress scan state, not just
// data.flagRules. A line that doesn't match the pattern (older notes, a
// manually-typed line) still renders, just without the time/sender pill.
// "…T00:00:00" rather than parsing the bare "YYYY-MM-DD" directly --
// JS treats a date-only ISO string as UTC midnight, which a negative
// UTC-offset timezone would otherwise roll back to the previous day.
function formatChatDay(iso) {
return new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

// rules/cityMap are optional -- passed in by connections.js so a saved
// chat gets the same live click-to-add-City/Nationality treatment Notes
// already has (a city or country mentioned mid-conversation is exactly
// the kind of thing worth catching), omitted anywhere else this is called
// where that wouldn't make sense. `lines` is either a plain string (split
// on \n here, no per-line source) or a pre-tagged [{source, text}] array —
// connections.js passes the latter once a chat spans more than one
// platform, plus a sourceIcons map ({source: {icon, label}}) so each line
// can carry a tiny icon showing which app it came from, since a merged,
// interleaved chat with no per-line indication of platform is exactly
// what read as "weird" before this.
function chatTranscriptHtml(lines, rules, cityMap, sourceIcons) {
const arr = Array.isArray(lines) ? lines : String(lines || '').split('\n').filter(Boolean).map((text) => ({ text }));
let lastDate = '';
return arr.map(({ text: line, source }) => {
// The date prefix is optional -- older chatLog text saved before the
// console snippet started threading a date onto each message (or a
// message that came before the first day-divider Tinder showed) still
// parses fine, just without a day heading.
const m = line.match(/^\[(?:(\d{4}-\d{2}-\d{2}) )?(\d{1,2}:\d{2})\]\s*([^:]+):\s*(.*)$/);
if (!m) return `<div class="tinder-chat-line">${escapeHtml(line)}</div>`;
const [, date, time, sender, message] = m;
const senderName = sender.trim();
const senderClass = senderName === 'You' ? 'tinder-chat-you' : 'tinder-chat-them';
let dayHtml = '';
if (date && date !== lastDate) {
dayHtml = `<div class="tinder-chat-day">${escapeHtml(formatChatDay(date))}</div>`;
lastDate = date;
}
const body = rules || cityMap ? highlightFlagValues(message, rules, cityMap) : escapeHtml(message);
const info = sourceIcons && source ? sourceIcons[source] : null;
const srcIcon = info ? `<span class="tinder-chat-src" title="${escapeHtml(info.label)}">${info.icon}</span> ` : '';
return dayHtml + `<div class="tinder-chat-line">${srcIcon}<span class="tinder-chat-time">[${escapeHtml(time)}]</span> <span class="${senderClass}">${escapeHtml(senderName)}</span>: ${body}</div>`;
}).join('');
}

// Renders an avatar/photo <div> with a data-photo-bg placeholder; call
// hydratePhotoBackgrounds() after inserting the returned HTML into the DOM
// to fill in the actual blob URL asynchronously (IndexedDB reads are async,
// but HTML string building is synchronous, so photo src is always a
// two-step render).
function avatarHtml(photoId, name, sizeClass) {
const cls = `avatar ${sizeClass || ''}`;
if (photoId) {
return `<div class="${cls}" data-photo-bg="${escapeHtml(photoId)}">${escapeHtml(initials(name))}</div>`;
}
return `<div class="${cls}">${escapeHtml(initials(name))}</div>`;
}

// Resolver for photos whose bytes aren't on this device. Registered by
// app.js rather than imported, because the implementation lives in files.js,
// which reaches state.js — and state.js imports this module, so importing it
// back would be a cycle.
let photoFallback = null;
function setPhotoFallback(fn) { photoFallback = fn; }

// Fills in every [data-photo-bg] placeholder as a CSS background-image
// rather than a real <img> element — a plain <img> is natively draggable,
// and nudging one a pixel mid-click was enough on Windows Chrome to kick
// off an OS-level drag of the blob: URL, popping File Explorer instead of
// (or alongside) a click handler. draggable=false plus an explicit
// dragstart preventDefault() on the <img> both turned out not to be
// reliable enough on their own (confirmed still happening live, repeatedly,
// across every photo grid in the app). A CSS background-image has no
// drag-source behaviour at all — there's no <img> element for Chromium's
// drag detection to find, so there's nothing left to suppress. This is now
// the ONLY photo-thumbnail renderer in the app; do not add a new
// <img>-based one for a future photo grid.
//
// Photos are stored per-device, so an id that synced from another device
// has no local blob; the fallback fetches those from your own host.
// Anything still unresolved is marked rather than left blank — an empty
// square looks identical to "no photo was ever added", which is the wrong
// thing to conclude.
async function hydratePhotoBackgrounds(root) {
const nodes = [...root.querySelectorAll('[data-photo-bg]')].filter((el) => !el.classList.contains('photo-bg-done'));
await Promise.all(nodes.map(async (el) => {
const id = el.dataset.photoBg;
let url = await photoUrl(id);
if (!url && photoFallback) {
el.classList.add('photo-loading');
try { url = await photoFallback(id); } catch (e) { /* leave it marked missing */ }
el.classList.remove('photo-loading');
}
if (url) {
el.style.backgroundImage = `url("${url}")`;
el.classList.add('photo-bg-done');
// Clears any fallback initials text (avatarHtml renders a letter as a
// placeholder before the photo loads) so it doesn't sit on top of the
// image once painted in.
el.textContent = '';
} else {
el.classList.add('photo-missing');
el.title = 'This photo is only on the device it was added on — see Settings → Photo sync.';
}
}));
}

// Full-screen photo preview, painted as a CSS background rather than a real
// <img> — see hydratePhotoBackgrounds() above. This is the one every photo
// thumbnail click leads to, so it's the highest-traffic spot in the app for
// the native-drag-pops-File-Explorer bug; draggable=false plus an explicit
// dragstart preventDefault() on a real <img> here were both confirmed still
// not reliable enough on Windows Chrome. Shared by the Connections gallery
// and the Tinder import photo grid rather than duplicated per feature.
function openLightbox(url) {
const box = document.createElement('div');
box.className = 'lightbox';
box.innerHTML = '<div class="lightbox-img"></div>';
box.querySelector('.lightbox-img').style.backgroundImage = `url("${url}")`;
box.addEventListener('click', () => box.remove());
document.body.appendChild(box);
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

// A screenshot of a single photo, taken full-screen on a phone whose own
// aspect ratio doesn't match the photo's, comes with solid letterbox (top/
// bottom) or pillarbox (left/right) bars baked in -- not the actual photo
// content. Detecting and trimming those matters for two things: the photo
// itself shouldn't be stored with black/white bars in it, and the trimmed
// CONTENT aspect ratio is what should decide "is this a photo or a tall
// composite screenshot", not the raw file's aspect ratio (a modern tall
// phone screen's native ratio, e.g. ~1:2.17 on a Galaxy S25 Ultra, already
// sits past a naive "photos are wider than 1:2" cutoff before any bars are
// even trimmed).
//
// Downscaled to a small sample width for speed -- band detection doesn't
// need full resolution, just enough rows/columns to tell "flat" from "has
// content". A row/column counts as flat by its LOCAL variance -- the
// average pixel-to-pixel colour change along it -- rather than by distance
// from one "dominant" colour. That distinction matters: a full-screen
// photo-view screenshot's chrome is often a gradient scrim behind the
// status bar/caption, not a solid bar (confirmed live: a solid-colour
// check left a real photo screenshot completely untrimmed, since a
// gradient has no single dominant colour to measure against). A smooth
// gradient has low pixel-to-pixel variance same as a solid bar; real photo
// content (edges, texture, a face) has high variance even when its
// average colour is similar. Trimming is capped per edge so a genuinely
// flat photo (a solid-colour studio background, say) never gets crushed
// to nothing -- letterboxing is a border, not most of the image.
const BAND_SAMPLE_WIDTH = 100;
const BAND_FLATNESS_THRESHOLD = 12; // avg per-step summed-RGB delta allowed
const BAND_MAX_TRIM_FRACTION = 0.45;
// A status-bar clock or battery icon sitting inside an otherwise-solid
// letterbox bar is only a few sample-rows/columns tall -- confirmed live
// against real Android photo-viewer screenshots: the old scan stopped
// trimming the instant it touched the icon, leaving almost the entire black
// bar (and the photo misclassified as a screenshot, since the untrimmed
// content ratio landed under PHOTO_ASPECT_THRESHOLD). Requiring a run this
// long of consecutive non-flat samples before calling it "real content"
// lets the scan skip over an icon-sized blip and keep trimming into the
// flat margin beyond it.
const BAND_CONTENT_RUN = 6;

function contentCropBounds(img) {
const w = img.naturalWidth, h = img.naturalHeight;
if (!w || !h) return { x: 0, y: 0, w: 1, h: 1 };
const sw = Math.min(BAND_SAMPLE_WIDTH, w);
const sh = Math.max(1, Math.round(h * (sw / w)));
const canvas = document.createElement('canvas');
canvas.width = sw; canvas.height = sh;
const ctx = canvas.getContext('2d');
ctx.drawImage(img, 0, 0, sw, sh);
const { data } = ctx.getImageData(0, 0, sw, sh);
const px = (x, y) => (y * sw + x) * 4;

const rowFlat = (y) => {
if (sw < 2) return true;
let total = 0;
for (let x = 1; x < sw; x++) {
const i = px(x, y), p = px(x - 1, y);
total += Math.abs(data[i] - data[p]) + Math.abs(data[i + 1] - data[p + 1]) + Math.abs(data[i + 2] - data[p + 2]);
}
return total / (sw - 1) <= BAND_FLATNESS_THRESHOLD;
};
const colFlat = (x) => {
if (sh < 2) return true;
let total = 0;
for (let y = 1; y < sh; y++) {
const i = px(x, y), p = px(x, y - 1);
total += Math.abs(data[i] - data[p]) + Math.abs(data[i + 1] - data[p + 1]) + Math.abs(data[i + 2] - data[p + 2]);
}
return total / (sh - 1) <= BAND_FLATNESS_THRESHOLD;
};

// Scans inward from an edge, trimming flat samples. A non-flat sample only
// ends the trim if it starts a run of at least BAND_CONTENT_RUN consecutive
// non-flat samples (real content); a shorter run is a blip -- skipped over,
// scan continues past it. `index(i)` maps a 0-based scan step to the actual
// row/column, so the same logic serves all four edges.
function findEdge(maxTrim, isFlat, index) {
let i = 0;
while (i < maxTrim) {
if (isFlat(index(i))) { i++; continue; }
let run = 0;
while (i + run < maxTrim && !isFlat(index(i + run))) run++;
if (run >= BAND_CONTENT_RUN) return i;
i += run;
}
return maxTrim;
}

const maxTopBottom = Math.floor(sh * BAND_MAX_TRIM_FRACTION);
const maxLeftRight = Math.floor(sw * BAND_MAX_TRIM_FRACTION);
const top = findEdge(maxTopBottom, rowFlat, (i) => i);
const bottom = sh - 1 - findEdge(maxTopBottom, rowFlat, (i) => sh - 1 - i);
const left = findEdge(maxLeftRight, colFlat, (i) => i);
const right = sw - 1 - findEdge(maxLeftRight, colFlat, (i) => sw - 1 - i);

if (bottom <= top || right <= left) return { x: 0, y: 0, w: 1, h: 1 };
return { x: left / sw, y: top / sh, w: (right - left + 1) / sw, h: (bottom - top + 1) / sh };
}

// Crops an image down to fractional bounds (as returned by
// contentCropBounds), optionally also capping the longer side to maxDim —
// unlike cropThumbnailToBlob, this keeps the source's aspect ratio rather
// than squashing to a fixed thumbnail, since the result is meant to be
// stored as the real photo, not a preview. Crop and resize happen in the
// same canvas draw so a photo needing both isn't put through two separate
// JPEG re-encodes (crop-then-resize as two passes loses more to
// compression than doing both at once).
function cropToContentBlob(img, bounds, quality, maxDim) {
return new Promise((resolve) => {
const sx = bounds.x * img.naturalWidth;
const sy = bounds.y * img.naturalHeight;
const sw = bounds.w * img.naturalWidth;
const sh = bounds.h * img.naturalHeight;
if (sw <= 0 || sh <= 0) { resolve(null); return; }
const scale = maxDim ? Math.min(1, maxDim / Math.max(sw, sh)) : 1;
const dw = Math.max(1, Math.round(sw * scale));
const dh = Math.max(1, Math.round(sh * scale));
const canvas = document.createElement('canvas');
canvas.width = dw; canvas.height = dh;
canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality || 0.9);
});
}

// Below this width:height ratio (narrower than 1:2), a file is treated as
// a composite/scrolling screenshot rather than a single photo -- there's
// comfortable separation between a real photo's content aspect ratio (even
// an extreme full-body portrait rarely goes past ~1:1.8) and a genuine
// multi-section scrolled profile screenshot (typically 1:5 or narrower),
// once letterbox bars are trimmed out of the comparison.
const PHOTO_ASPECT_THRESHOLD = 0.5;

// Loads a file, trims letterbox/pillarbox bars, and classifies it as a
// single photo (direct save, no AI) or a composite screenshot (needs the
// banded AI parse) based on the CONTENT aspect ratio, not the raw file's.
async function classifyProfileUpload(file) {
const img = await loadImage(file);
const bounds = contentCropBounds(img);
const contentW = img.naturalWidth * bounds.w;
const contentH = img.naturalHeight * bounds.h;
const ratio = contentH > 0 ? contentW / contentH : 1;
return { img, bounds, isScreenshot: ratio < PHOTO_ASPECT_THRESHOLD };
}

export {
todayStr, daysAgoStr, last7Dates, uid, daysSince, daysUntil, foldDiacritics,
escapeHtml, initials, avatarHtml, hydratePhotoBackgrounds, openLightbox, chatTranscriptHtml, highlightFlagValues, knownCityMap, scrollAndFlash, bindForm,
findMentions, COUNTRY_NAME_TO_NATIONALITY,
resizeImageToBlob, fileToBase64, loadImage, cropThumbnailToBlob,
hashFile, captureDateOf, betterCaptureDate, dateFromFilename,
ensureBrowserReadableImage, setPhotoFallback,
contentCropBounds, cropToContentBlob, classifyProfileUpload,
};
