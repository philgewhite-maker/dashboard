import { data, queueSave, reachOutThreshold, isDormantStage, isTravelPaused, getLocalSettings, setLocalSetting, TAG_FIELDS, CONTACT_STATUS_LABELS, currentAge, displayAge, photoCoverage, photoLinkLabels, averageRating, completeness, slugifyField, FLAG_FIELD_DEFS, DEFAULT_FLAG_RULES, computeFlags, valueColorForField, stripSharedSuffix, suggestedAction, suggestedQuestions, recordImportRun, importStatusLine, upsertIdentity, blankConnection, blankPendingImport } from '../state.js';
import { captureTask, revealTask } from './tasks.js';
import { photoDelete, photoUrl } from '../db.js';
import { storePhoto } from '../files.js';
import {
uid, todayStr, daysSince, escapeHtml, avatarHtml, hydratePhotoBackgrounds, openLightbox, chatTranscriptHtml, buildFlagMatcher, applyFlagMatcher, knownCityMap, scrollAndFlash, bindForm, foldDiacritics,
resizeImageToBlob, classifyProfileUpload, cropToContentBlob, contentCropBounds, loadImage,
} from '../utils.js';
import { MissingKeyError, extractMatchesFromScreenshot, extractProfileFromScreenshot } from '../ai.js';
import { isSensitive, noCoverNote } from './photoalbums.js';
import { nameKey, editDistance } from '../googlecontacts.js';

// 'Backlog review' is an active triage bucket (see the "Backlog review
// 180+" button below), not a resolved outcome -- it's excluded from
// isDormantStage() on purpose, so it still gets ordinary reach-out
// treatment (tune it via the per-stage Reach-out timing settings if it
// should nag less than that). 'FriendZone' IS a resolved outcome --
// grouped with Faded/Archived below.
const CONN_STAGES = ['Superswiped', 'Matched', 'Chatting in app', 'Moved to WhatsApp', 'Moved to Telegram', 'Planning to call', 'Planning to meet', 'Arranged to meet', 'Met in person', 'Dating', 'Backlog review', 'FriendZone', 'Faded', 'Archived'];
const STAGE_RANK = { Dating: 10, 'Met in person': 9, 'Arranged to meet': 8, 'Planning to meet': 7, 'Planning to call': 6, 'Moved to Telegram': 5, 'Moved to WhatsApp': 4, 'Chatting in app': 3, Matched: 2, Superswiped: 1, 'Backlog review': 0, FriendZone: 0, Faded: 0, Archived: 0 };
// Where a connection came from. Rendered into every source dropdown from
// here so the add form, the import picker, and the per-connection editor
// can't drift apart.
const CONN_APPS = ['Bumble', 'Tinder', 'Hinge', 'WhatsApp', 'Telegram', 'Instagram', 'Real life', 'Other'];
// Sources that are an actual app with a recognisable screenshot layout —
// worth naming in the vision prompt. "Real life"/"Other" describe how you
// met, not a UI, so they're deliberately left out of that hint.
const SCREENSHOT_APPS = new Set(['Bumble', 'Tinder', 'Hinge', 'WhatsApp', 'Telegram', 'Instagram']);

// One small icon per place evidence of this connection can come from —
// replaces the plain "TINDER" text label and the separate "In contacts"
// text badge with a single hoverable row (see sourceIconsHtml()). Keyed by
// c.app value where it's a real platform, plus the extra non-app sources
// (a chat field being populated, a linked Google Photos album, a matched
// Google Contact) that CONN_APPS has no slot for at all.
const SOURCE_ICONS = {
Bumble: { icon: '🐝', label: 'Bumble' },
Tinder: { icon: '🔥', label: 'Tinder' },
Hinge: { icon: '💜', label: 'Hinge' },
WhatsApp: { icon: '💬', label: 'WhatsApp', cls: 'src-whatsapp' },
Telegram: { icon: '✈️', label: 'Telegram', cls: 'src-telegram' },
Instagram: { icon: '📸', label: 'Instagram' },
'Real life': { icon: '🤝', label: 'Met in real life' },
Other: { icon: '❔', label: 'Other' },
googlePhotos: { icon: '🖼️', label: 'Google Photos' },
googleContacts: { icon: '📇', label: 'Google Contacts' },
};

// One icon per Stage value (see CONN_STAGES above) -- shown next to the
// source icons so the card's whole "where things stand" reads at a glance
// without needing to open the Stage dropdown.
const STAGE_ICONS = {
Superswiped: '🌟', Matched: '🔗', 'Chatting in app': '💭',
'Moved to WhatsApp': '💬', 'Moved to Telegram': '✈️',
'Planning to call': '📞', 'Planning to meet': '🗓️', 'Arranged to meet': '📌',
'Met in person': '🤝', Dating: '❤️', 'Backlog review': '📥', FriendZone: '🧑‍🤝‍🧑', Faded: '🌫️', Archived: '📦',
};

// One icon per milestone value (see MILESTONE_SUGGESTIONS below) -- a
// milestone typed as free text that isn't in this table still saves fine,
// it just doesn't get its own icon (falls back to a generic marker).
const MILESTONE_ICONS = {
'Exchanged details': '📱', Met: '🤝', Kissed: '💋',
'Slept together': '🍆', Holidayed: '🌴', Engaged: '💍', Married: '💒',
};
const MILESTONE_ICON_FALLBACK = '✳️';

function iconSpan(icon, label, extraCls) {
return `<span class="src-icon${extraCls ? ` ${extraCls}` : ''}" title="${escapeHtml(label)}">${icon}</span>`;
}

// Every place there's real evidence this connection exists somewhere --
// not just c.app (the original match platform), since a conversation
// routinely continues on a second app after matching (see the Stage
// values "Moved to WhatsApp"/"Moved to Telegram"), and Google Photos/
// Contacts are never "the app" but are still worth a glance-able icon.
function sourceIconsHtml(c) {
const parts = [];
const appInfo = SOURCE_ICONS[c.app];
if (appInfo) parts.push(iconSpan(appInfo.icon, appInfo.label, appInfo.cls));
if (c.chatLog && c.app !== 'Tinder') parts.push(iconSpan(SOURCE_ICONS.Tinder.icon, 'Tinder chat'));
if (c.chatLogWhatsApp && c.app !== 'WhatsApp') parts.push(iconSpan(SOURCE_ICONS.WhatsApp.icon, 'WhatsApp chat', SOURCE_ICONS.WhatsApp.cls));
if (c.chatLogTelegram && c.app !== 'Telegram') parts.push(iconSpan(SOURCE_ICONS.Telegram.icon, 'Telegram chat', SOURCE_ICONS.Telegram.cls));
if ((c.photoAlbums || []).length) {
const n = c.photoAlbums.length;
parts.push(iconSpan(SOURCE_ICONS.googlePhotos.icon, `Google Photos (${n} album${n === 1 ? '' : 's'})`));
}
if (c.contactStatus === 'linked') parts.push(iconSpan(SOURCE_ICONS.googleContacts.icon, 'In Google Contacts'));
return parts.join('');
}

function stageIconHtml(c) {
const icon = STAGE_ICONS[c.stage];
return icon ? iconSpan(icon, `Stage: ${c.stage}`) : '';
}

function milestoneIconsHtml(c) {
return (c.milestones || []).map((m) => iconSpan(MILESTONE_ICONS[m] || MILESTONE_ICON_FALLBACK, m)).join('');
}

// Keeps an unrecognised existing value (older data, or a source since removed
// from the list) as a selectable option instead of silently switching the
// connection to whatever happens to be first.
function appOptions(selected) {
const list = !selected || CONN_APPS.includes(selected) ? CONN_APPS : [selected, ...CONN_APPS];
return list.map((a) => `<option value="${escapeHtml(a)}"${a === selected ? ' selected' : ''}>${escapeHtml(a)}</option>`).join('');
}

function fillAppSelect(id) {
const el = document.getElementById(id);
if (el) el.innerHTML = appOptions(el.value);
}

// Dial codes for entering a phone in a form the Contacts match can use.
// Only ISO code and dial code are stored — the flag is derived, since a flag
// emoji is just the two letters as regional indicator symbols, so there's no
// table of images to keep in step with anything.
const DIAL_CODES = [
['GB', '+44', 'United Kingdom'], ['IE', '+353', 'Ireland'], ['US', '+1', 'United States'],
['CA', '+1', 'Canada'], ['FR', '+33', 'France'], ['DE', '+49', 'Germany'],
['ES', '+34', 'Spain'], ['PT', '+351', 'Portugal'], ['IT', '+39', 'Italy'],
['CH', '+41', 'Switzerland'], ['AT', '+43', 'Austria'], ['NL', '+31', 'Netherlands'],
['BE', '+32', 'Belgium'], ['LU', '+352', 'Luxembourg'], ['DK', '+45', 'Denmark'],
['SE', '+46', 'Sweden'], ['NO', '+47', 'Norway'], ['FI', '+358', 'Finland'],
['IS', '+354', 'Iceland'], ['PL', '+48', 'Poland'], ['CZ', '+420', 'Czechia'],
['SK', '+421', 'Slovakia'], ['HU', '+36', 'Hungary'], ['RO', '+40', 'Romania'],
['BG', '+359', 'Bulgaria'], ['GR', '+30', 'Greece'], ['HR', '+385', 'Croatia'],
['SI', '+386', 'Slovenia'], ['RS', '+381', 'Serbia'], ['UA', '+380', 'Ukraine'],
['LT', '+370', 'Lithuania'], ['LV', '+371', 'Latvia'], ['EE', '+372', 'Estonia'],
['TR', '+90', 'Türkiye'], ['RU', '+7', 'Russia'], ['IL', '+972', 'Israel'],
['AE', '+971', 'United Arab Emirates'], ['ZA', '+27', 'South Africa'],
['AU', '+61', 'Australia'], ['NZ', '+64', 'New Zealand'], ['SG', '+65', 'Singapore'],
['HK', '+852', 'Hong Kong'], ['JP', '+81', 'Japan'], ['KR', '+82', 'South Korea'],
['CN', '+86', 'China'], ['IN', '+91', 'India'], ['TH', '+66', 'Thailand'],
['BR', '+55', 'Brazil'], ['AR', '+54', 'Argentina'], ['MX', '+52', 'Mexico'],
];

// Regional indicator symbols: 'GB' -> 🇬🇧 on iOS and Android.
//
// Windows ships no flag glyphs, so Chrome and Edge there fall back to
// rendering the two regional indicators as plain letters — "GB". That's why
// the ISO code is NOT written out separately: on a phone you get "🇬🇧 +44",
// on the desktop you get "GB +44", and never the "GB GB +44" that printing
// both produced.
function flagEmoji(iso) {
return iso.toUpperCase().replace(/./g, (ch) => String.fromCodePoint(0x1F1E6 + ch.charCodeAt(0) - 65));
}

// Splits a written international number into its country code and the rest.
// Longest dial code wins, so +353 isn't mistaken for +35 and +44 not for +4.
// Several countries share a code (+1 is US and Canada), so the label names
// all of them rather than picking one and being wrong half the time.
function splitDialCode(phone) {
const raw = String(phone || '').trim();
if (!raw.startsWith('+')) return null;
const digits = raw.replace(/[^\d+]/g, '');
const hit = [...DIAL_CODES]
.sort((a, b) => b[1].length - a[1].length)
.find(([, dial]) => digits.startsWith(dial));
if (!hit) return null;
const [, dial] = hit;
const sharing = DIAL_CODES.filter(([, d]) => d === dial);
return {
iso: hit[0],
dial,
name: sharing.map(([, , n]) => n).join(' / '),
rest: raw.slice(raw.indexOf(dial) + dial.length).trim(),
};
}

// The country code as a distinct tag so it reads at a glance — telling a
// +44 candidate from a +41 one is often the whole decision. Falls back to
// the plain number when there's no recognisable code (national format).
function phoneWithFlagHtml(phone) {
const parsed = splitDialCode(phone);
if (!parsed) return escapeHtml(phone || '');
return `<span class="dial-tag" title="${escapeHtml(parsed.name)}">${flagEmoji(parsed.iso)} ${escapeHtml(parsed.dial)}</span> ${escapeHtml(parsed.rest)}`;
}

function dialCodeOptions(selectedDial) {
return '<option value="">Country code…</option>' + DIAL_CODES
.map(([iso, dial, name]) => `<option value="${dial}" ${dial === selectedDial ? 'selected' : ''}>${flagEmoji(iso)} ${dial} — ${escapeHtml(name)}</option>`)
.join('');
}

let connectionSearchTerm = '';
let searchDebounceTimer = null;
let connectionSortPrimary = 'default';
let connectionSortSecondary = 'none';
// Set by the "None" chips in Connections Overview: {field, label}. Kept
// separate from the text search because "has nothing in this field" isn't
// something a substring match can express.
let emptyFieldFilter = null;
const expandedConnections = new Set();

// Works for the array tag fields and the plain text ones (location,
// education), so one "None" chip implementation covers every dimension.
// Derived dimensions have no backing property, so they're named explicitly —
// without this they'd test an undefined field, read as empty for everyone,
// and the None chip would "filter" to the entire list.
function isFieldEmpty(c, field) {
if (field === 'photoLinks') return photoLinkLabels(c).length === 0;
if (field === 'age') return currentAge(c) === null;
const value = c[field];
if (Array.isArray(value)) return value.length === 0;
return !String(value || '').trim();
}

// An explicit set of ids, used by Overview's drill-down mode — several
// combined facets can't be written as a single search term.
let idFilter = null; // { ids: Set, label }

function filterByIds(ids, label) {
emptyFieldFilter = null;
connectionSearchTerm = '';
const search = document.getElementById('conn-search');
if (search) search.value = '';
idFilter = { ids: new Set(ids), label };
renderConnections();
}

function clearFilters() {
idFilter = null;
emptyFieldFilter = null;
connectionSearchTerm = '';
const search = document.getElementById('conn-search');
if (search) search.value = '';
renderConnections();
}

// Drives the search box from elsewhere (an Overview chip, the contacts
// panel) so those places don't each have to know how filtering works.
function filterBySearch(term) {
emptyFieldFilter = null;
idFilter = null;
connectionSearchTerm = term;
const search = document.getElementById('conn-search');
if (search) search.value = term;
renderConnections();
const panel = document.getElementById('connections-panel');
if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Called by the Overview "None (n)" chips.
function filterByEmptyField(field, label) {
emptyFieldFilter = { field, label };
connectionSearchTerm = '';
const search = document.getElementById('conn-search');
if (search) search.value = '';
renderConnections();
const panel = document.getElementById('connections-panel');
if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Whether this device shows the `sensitive` tag fields (see TAG_FIELDS).
// Device-local, not part of the synced document — the notes themselves sync
// like everything else, this only controls whether they're on screen here.
let showSensitiveFields = false;
async function initSensitiveFields() {
const settings = await getLocalSettings();
showSensitiveFields = !!settings.showSensitiveFields;
}
function setShowSensitiveFields(v) { showSensitiveFields = !!v; }
function visibleTagFields() {
return TAG_FIELDS.filter((f) => showSensitiveFields || !f.sensitive);
}

// Bucket labels the Tinder importer's console snippet writes into
// c.distance — kept in sync with DISTANCE_BUCKETS in that snippet (in
// index.html) by hand, since a console snippet can't import from here. Both
// units are baked into each label (source profiles can be miles or km) —
// ≤10mi/16km etc, mile boundary rounded to the nearest km. Sorting is
// descending (higher getValue first, see the `b - a` below), so the
// closest bucket needs the HIGHEST rank, not the lowest.
const DISTANCE_BUCKET_ORDER = ['≤2mi/3km', '≤5mi/8km', '≤10mi/16km', '≤20mi/32km', '≤30mi/48km', '≤50mi/80km', '≤100mi/161km', '≤1000mi/1609km', '≤2000mi/3219km'];
function distanceRank(distance) {
const i = DISTANCE_BUCKET_ORDER.indexOf(distance);
return i === -1 ? 0 : DISTANCE_BUCKET_ORDER.length - i;
}

// Fixed sort options that always exist, regardless of what rating
// categories Settings currently has configured.
const FIXED_SORT_FIELDS = {
// Standby/Travelling sinks the same way a dormant stage does — a 144-day
// gap that's deliberate (out of rotation) shouldn't outrank someone
// genuinely overdue just because the raw day count is bigger.
default: { label: 'Reach-out priority', getValue: (c) => (isDormantStage(c.stage) || isTravelPaused(c) ? -999 : daysSince(c.lastContact) - reachOutThreshold(c.priority, c.stage) + reachOutQualityBonus(c)) },
priority: { label: 'Overall rating', getValue: (c) => c.priority || 0 },
average: { label: 'Average detailed rating', getValue: (c) => (averageRating(c) || {}).value || 0 },
completeness: { label: 'Record completeness', getValue: (c) => completeness(c) },
added: { label: 'Date added', getValue: (c) => (c.createdAt ? Date.parse(c.createdAt) : -1) || -1 },
contact: { label: 'Time since contact', getValue: (c) => daysSince(c.lastContact) },
stage: { label: 'Stage (Met in person → Matched)', getValue: (c) => STAGE_RANK[c.stage] ?? 0 },
distance: { label: 'Distance (closest first)', getValue: (c) => distanceRank(c.distance) },
};

// One sort option per configured rating category (looks, IQ, whatever
// Settings currently lists) — rebuilt on every call rather than cached, so
// adding or removing a category in Settings is reflected the next time the
// list renders without a separate refresh step to remember.
function sortFields() {
const fields = { ...FIXED_SORT_FIELDS };
(data.ratingCategories || []).forEach(({ field, label }) => {
fields[`rating:${field}`] = { label, getValue: (c) => (c.ratings && c.ratings[field]) || 0 };
});
return fields;
}

// Says where the displayed age came from, so "~31" isn't mysterious: either
// it's exact from a date of birth, or it's the number you entered carried
// forward from the date you entered it.
function ageNoteHtml(c) {
const age = currentAge(c);
if (!age) return '';
if (age.exact) return ` <span class="age-note">= ${age.value} from DOB</span>`;
if (age.drifted) return ` <span class="age-note">≈ ${age.value} now, from ${escapeHtml(c.ageAsOf)}</span>`;
return '';
}

// Groups on the CURRENT age, so someone recorded at 29 two years ago falls
// in the 30s where they belong.
function ageDecade(conn) {
const age = currentAge(conn);
if (!age) return null;
return `${Math.floor(age.value / 10) * 10}s`;
}

function ratingStars(label, cat, connId, value) {
const stars = [1, 2, 3, 4, 5].map((n) => `<svg class="star rate-star ${n <= value ? 'filled' : ''}" data-rate-conn="${connId}" data-rate-cat="${cat}" data-rate-star="${n}" viewBox="0 0 20 20" fill="currentColor"><path d="M10 1l2.6 5.9 6.4.6-4.8 4.3 1.4 6.2L10 14.9 4.4 18l1.4-6.2L1 7.5l6.4-.6z"/></svg>`).join('');
return `<div class="rating-row"><span class="rating-label">${escapeHtml(label)}</span><div class="stars">${stars}</div></div>`;
}

function averageRatingHtml(c) {
const avg = averageRating(c);
if (!avg) return '';
return ` <span class="rating-average">avg ${avg.value.toFixed(1)} (${avg.count} rated)</span>`;
}

// Unlike every other tag field, milestones has no real data to seed
// suggestions from the first time it's used -- offer this starter
// vocabulary until actual saved values take over.
const MILESTONE_SUGGESTIONS = ['Exchanged details', 'Met', 'Kissed', 'Slept together', 'Holidayed', 'Engaged', 'Married'];

// Every distinct value already used for `field`, keyed lowercase so the
// first spelling entered becomes the canonical one.
function existingTagValues(field) {
const byKey = new Map();
data.connections.forEach((c) => {
(c[field] || []).forEach((v) => {
const key = String(v).trim().toLowerCase();
if (key && !byKey.has(key)) byKey.set(key, String(v).trim());
});
});
if (field === 'milestones') {
MILESTONE_SUGGESTIONS.forEach((v) => {
const key = v.toLowerCase();
if (!byKey.has(key)) byKey.set(key, v);
});
}
return [...byKey.values()].sort((a, b) => a.localeCompare(b));
}

// One <datalist> per field, shared by every card's add-input. Native
// autocomplete, so it works on mobile keyboards too, and seeing "sporty"
// offered is what stops "Sporty" and "sporty " becoming separate tags.
function tagDatalistsHtml() {
return TAG_FIELDS.map(({ field }) => {
const values = existingTagValues(field);
if (values.length === 0) return '';
return `<datalist id="taglist-${field}">${values.map((v) => `<option value="${escapeHtml(v)}"></option>`).join('')}</datalist>`;
}).join('');
}

function tagChips(items, connId, field) {
return (items || []).map((t, i) => {
const color = valueColorForField(data.flagRules, field, t);
return `<span class="tag-chip${color ? ' tag-chip-' + color : ''}">${escapeHtml(t)}<span class="tag-x" data-tag-remove="${connId}" data-tag-field="${field}" data-tag-idx="${i}">&times;</span></span>`;
}).join('')
+ `<input type="text" autocomplete="off" class="tag-add-input" placeholder="+ add" list="taglist-${field}" data-tag-add="${connId}" data-tag-field="${field}">`
+ `<button type="button" class="todo-add-btn" data-tag-add-btn="${connId}" data-tag-add-btn-field="${field}" style="padding:3px 8px;">+</button>`;
}

// Albums linked from Google Photos, as thumbnails. Covers are rendered
// straight from their Google URL — the bytes can't be copied cross-origin,
// but displaying them is fine. A plain "Name_" album is captioned with the
// person's name; anything else shows just its qualifier, since the name is
// already the card you're looking at.
function coverPinHtml(connId, photoId, currentCoverId) {
const isCover = photoId === currentCoverId;
return `<button type="button" class="cover-pin${isCover ? ' is-cover' : ''}" data-set-cover="${connId}" data-set-cover-id="${escapeHtml(photoId)}" title="${isCover ? 'Cover photo' : 'Set as cover photo'}">${isCover ? '★' : '☆'}</button>`;
}

function albumListHtml(c) {
const albums = c.photoAlbums || [];
if (!albums.length) return '<div class="album-empty">None linked — name an album "' + escapeHtml(c.name) + '_" in Google Photos, then import it on the Dating admin tab.</div>';
return `<div class="album-strip">${albums.map((a, i) => `<div class="album-card sm${isSensitive(a) ? ' album-sensitive' : ''}">
<a class="album-thumb" href="${escapeHtml(a.url)}" target="_blank" rel="noopener" title="${escapeHtml(a.title || a.url)}">
${a.coverPhotoId ? `<span class="thumb-img" data-photo-bg="${escapeHtml(a.coverPhotoId)}"></span>`
: a.cover ? `<img src="${escapeHtml(a.cover)}" alt="" draggable="false" loading="lazy" referrerpolicy="no-referrer" onerror="this.outerHTML='<span class=&quot;album-nocover&quot;>cover link expired &mdash; re-run the snippet</span>'">`
: `<span class="album-nocover">${escapeHtml(noCoverNote(a.count))}</span>`}
</a>
${a.coverPhotoId ? coverPinHtml(c.id, a.coverPhotoId, c.photoId) : ''}
<div class="album-caption">${escapeHtml([a.location, a.date, a.other].filter(Boolean).join(' · ') || c.name)}</div>
<span class="tag-x" data-album-remove="${c.id}" data-album-idx="${i}" title="Unlink">&times;</span>
</div>`).join('')}</div>`;
}

// A gallery thumbnail's own click already opens the lightbox (data-view-
// photo) -- "make this the cover" needed its own separate control rather
// than overloading that click, hence the small pin button rather than a
// click-the-photo-itself gesture. Same pin reused on album covers (only
// when a real stored coverPhotoId exists, see task #44 -- a live Google
// session URL isn't a storable photo id) so either source can become the
// connection's main photo.
function galleryHtml(c) {
// The replace control is always in the markup, not conditionally
// rendered -- whether a thumbnail IS low-res is only known once its
// actual pixel dimensions load (flagLowResThumbnails, async, after this
// HTML is already in the DOM), so visibility is purely CSS-gated on the
// .low-res class that async check adds.
const thumbs = (c.photoIds || []).map((id, i) => `<div class="gallery-thumb" data-gallery-thumb="${escapeHtml(id)}">
<span class="thumb-img" data-photo-bg="${escapeHtml(id)}" data-view-photo="${escapeHtml(id)}"></span>
${coverPinHtml(c.id, id, c.photoId)}
<label class="gallery-thumb-replace" for="replace-photo-${c.id}-${i}" title="Low resolution — click to replace with a full-size photo">&#8635;</label>
<input type="file" id="replace-photo-${c.id}-${i}" accept="image/*" style="display:none;" data-replace-photo="${c.id}" data-replace-idx="${i}">
<span class="tag-x" data-photo-remove="${c.id}" data-photo-idx="${i}">&times;</span>
</div>`).join('');
return `<div class="photo-gallery">${thumbs}<label class="gallery-add" for="photo-add-${c.id}">+</label><input type="file" id="photo-add-${c.id}" accept="image/*" multiple style="display:none;" data-photo-add="${c.id}"></div>`;
}

// cropThumbnailToBlob hard-codes every AI-cropped photo to exactly
// 160x160 -- specific enough that no genuine photo is likely to land on
// it by chance, so it doubles as a reliable "this is a placeholder, not
// a real upload" signature with no extra field needed on the connection
// itself. Only known once the actual bytes decode, hence async and run
// after the card's already in the DOM (same timing as
// hydratePhotoBackgrounds, which this runs alongside).
async function flagLowResThumbnails(root) {
const thumbs = [...root.querySelectorAll('[data-gallery-thumb]')];
await Promise.all(thumbs.map(async (el) => {
try {
const url = await photoUrl(el.dataset.galleryThumb);
if (!url) return;
const img = await loadImage(url);
if (img.naturalWidth === 160 && img.naturalHeight === 160) el.classList.add('low-res');
} catch (e) { /* leave unflagged rather than guess */ }
}));
}

// Swaps one specific gallery photo for a better one, in place -- same
// array index, same cover-photo role if it had one -- rather than making
// the low-res flag a dead end that still needs a manual delete-then-
// re-add. Letterbox-strips the replacement too (utils.js), since it's
// just as likely to be a full-screen photo-view screenshot as the
// original was.
async function replacePhotoInPlace(connId, idx, file) {
const conn = data.connections.find((c) => c.id === connId);
if (!conn || !file || !Number.isInteger(idx)) return;
const img = await loadImage(file);
const bounds = contentCropBounds(img);
const blob = await cropToContentBlob(img, bounds, 0.85, 900);
if (!blob) return;
const newId = await storePhoto(blob);
const oldId = conn.photoIds[idx];
conn.photoIds[idx] = newId;
if (conn.photoId === oldId) conn.photoId = newId;
if (oldId) { try { await photoDelete(oldId); } catch (e) { /* orphaned blob, not worth failing the replace over */ } }
renderConnections();
queueSave();
}

function todoListHtml(c) {
const items = (c.todos || []).map((t) => `<div class="todo-item ${t.done ? 'done' : ''}"><input type="checkbox" ${t.done ? 'checked' : ''} data-todo-toggle="${c.id}" data-todo-id="${t.id}"><span>${escapeHtml(t.text)}</span><span class="tag-x" data-todo-remove="${c.id}" data-todo-id="${t.id}">&times;</span></div>`).join('');
return `<div class="todo-list">${items}</div>
<div class="todo-add-row">
<input type="text" autocomplete="off" placeholder="e.g. Theatre trip" data-todo-input="${c.id}">
<button class="todo-add-btn" type="button" data-todo-add="${c.id}">Add</button>
</div>`;
}

// One row per platform this connection has actually been found on --
// replaces the old single "Profile name" scalar, which had no way to
// hold "Tinder called her Kat23, Bumble called her Katya" at once.
// Modeled on todoListHtml() just above, not tagChips() -- a flat string
// chip has no room for a second/third column.
function identityListHtml(c) {
const rows = (c.identities || []).map((r) => `
<div class="identity-row">
<select data-identity-field="platform" data-identity-id="${r.id}" data-conn="${c.id}">${appOptions(r.platform)}</select>
<input type="text" autocomplete="off" placeholder="Display name / handle" data-identity-field="handle" data-identity-id="${r.id}" data-conn="${c.id}" value="${escapeHtml(r.handle || '')}">
<input type="text" autocomplete="off" placeholder="Match ID / key" data-identity-field="matchId" data-identity-id="${r.id}" data-conn="${c.id}" value="${escapeHtml(r.matchId || '')}">
${r.platform === 'WhatsApp' && c.phone ? `<span class="settings-note">(phone: ${escapeHtml(c.phone)})</span>` : ''}
<span class="tag-x" data-identity-remove="${c.id}" data-identity-id="${r.id}">&times;</span>
</div>`).join('');
return `<div class="identity-list">${rows}</div>
<button class="todo-add-btn" type="button" data-identity-add="${c.id}">+ Add platform identity</button>`;
}

function renderOverviewRef() {
// lazily imported to avoid a circular import at module-eval time
import('./overview.js').then((m) => m.renderOverview());
}

// contacts.js imports from here, so this holds the picker renderer once
// contacts.js has loaded rather than importing it back and creating a cycle.
// Before then it renders nothing, which is correct — there are no pending
// matches until a sync has run anyway.
let contactPicker = { html: () => '', bind: () => {} };
function setContactPicker(html, bind) { contactPicker = { html, bind }; }
function contactPickerHtml(connId) { return contactPicker.html(connId); }

// Rebuilt from data.ratingCategories on every render rather than written
// once as static HTML, so adding or removing a category in Settings shows
// up here without a separate refresh step to remember. Selection is driven
// by the module-level connectionSortPrimary/Secondary vars, not the <select>
// DOM state, so replacing the options list can't lose what was chosen.
function renderSortOptions() {
const primary = document.getElementById('conn-sort-primary');
const secondary = document.getElementById('conn-sort-secondary');
if (!primary || !secondary) return;
const fields = sortFields();
const order = ['default', 'priority', 'average', 'completeness', 'added',
...(data.ratingCategories || []).map(({ field }) => `rating:${field}`), 'contact', 'stage', 'distance'];
primary.innerHTML = order.map((key) => `<option value="${key}"${key === connectionSortPrimary ? ' selected' : ''}>Sort: ${escapeHtml(fields[key].label)}</option>`).join('');
secondary.innerHTML = `<option value="none"${connectionSortSecondary === 'none' ? ' selected' : ''}>Then by: &mdash;</option>`
+ order.map((key) => `<option value="${key}"${key === connectionSortSecondary ? ' selected' : ''}>Then by: ${escapeHtml(fields[key].label)}</option>`).join('');
}

function needsAttentionIds() {
return data.connections.filter((c) => suggestedQuestions(c).length > 0).map((c) => c.id);
}

// A matches-list-only import (the "Bumble list" screenshot flow, though
// Tinder/Hinge's equivalent produces the same shape) captures a name and
// maybe an age -- nothing else. Approximated here by photo count rather
// than checking for the AI-crop's exact 160x160 signature (see
// flagLowResThumbnails): confirming that would mean decoding every
// connection's photo on every filter click, and "one photo, none of the
// core detail fields" is already a reliable enough signal that a real,
// fleshed-out profile essentially never matches by coincidence.
function isThinProfile(c) {
if (isDormantStage(c.stage)) return false; // already resolved, not a cleanup target
if ((c.photoIds || []).length > 1) return false;
return [c.age, c.height, c.job, c.education].every((v) => !String(v || '').trim());
}

function thinProfileIds() {
return data.connections.filter(isThinProfile).map((c) => c.id);
}

// Archived/Faded pile up over time and are rarely what anyone's browsing
// for -- hidden from the default list view so the common case doesn't
// render (and scroll past) every resolved match. Not a "filter mode" like
// idFilter/emptyFieldFilter above: it's a base-view preference, so search
// and the Overview stage chips both deliberately bypass it (see the `term`
// handling in renderConnections) -- hiding them by default shouldn't also
// make them unfindable by name or via "Archived (12)". Device-local, same
// pattern as showSensitiveFields.
let showArchivedFaded = false;
const HIDDEN_BY_DEFAULT_STAGES = new Set(['Archived', 'Faded']);
async function initHideArchivedFaded() {
const settings = await getLocalSettings();
showArchivedFaded = !!settings.showArchivedFaded;
}
function archivedFadedIds() {
return data.connections.filter((c) => HIDDEN_BY_DEFAULT_STAGES.has(c.stage)).map((c) => c.id);
}

function isReachOutSnoozed(c) {
return !!(c.attentionSnoozedUntil && c.attentionSnoozedUntil > todayStr());
}

// Margin past the connection's OWN threshold (priority-scaled), not just
// a plain yes/no -- used only to rank who gets the badge below, since
// "everyone past their threshold" stops being an actionable shortlist and
// just becomes wallpaper once there are more than a handful.
function reachOutOverdueAmount(c) {
if (isDormantStage(c.stage) || isTravelPaused(c) || isReachOutSnoozed(c)) return -Infinity;
return daysSince(c.lastContact) - reachOutThreshold(c.priority, c.stage);
}

// A modest days-equivalent nudge so a well-rated, green-flagged match can
// outrank someone who's simply gone quiet for longer but isn't as
// promising -- a RANKING signal only, layered on top of the overdue
// margin above, never a substitute for it (eligibility still comes purely
// from actual elapsed time vs. threshold, so quality can't manufacture
// urgency for someone not due yet). Weights are a first-pass starting
// point, same spirit as suggestedAction()'s -- worth adjusting, not a
// claim they're definitively right.
function reachOutQualityBonus(c) {
const flags = computeFlags(c, data.flagRules);
const green = flags.hits.filter((h) => h.color === 'green').length;
const red = flags.hits.filter((h) => h.color === 'red').length;
const rating = averageRating(c);
return (c.priority - 3) * 2 + green * 1.5 - red * 3 + (rating ? rating.value - 3 : 0);
}

// Recomputed once per renderConnections() call (see topReachOutIdSet
// below) rather than per-card, since "who's in the top 10" is a property
// of the whole list, not any one connection in isolation.
function computeTopReachOut(n = 10) {
return new Set(
data.connections
.map((c) => ({ id: c.id, amount: reachOutOverdueAmount(c), c }))
.filter((x) => x.amount >= 0)
.sort((a, b) => (b.amount + reachOutQualityBonus(b.c)) - (a.amount + reachOutQualityBonus(a.c)))
.slice(0, n)
.map((x) => x.id),
);
}

let topReachOutIdSet = new Set();

// Mirrors state.js's URGENT_STAGES -- only used here to show the right
// placeholder ("auto (2)" vs "auto") when a stage has no override yet.
const FIXED_DEFAULT_STAGES = new Set(['Planning to meet', 'Planning to call']);

// Per-stage override for reachOutThreshold(), so a stage full of old
// connections that never got manually moved to Faded (see
// isDormantStage()) can be quieted without touching every connection in
// it, and without the blunt "reach out to nobody" of snoozing them one by
// one.
function initReachOutSettings() {
const btn = document.getElementById('conn-reachout-settings-btn');
const panel = document.getElementById('conn-reachout-settings');
const rowsEl = document.getElementById('conn-reachout-settings-rows');
if (!btn || !panel || !rowsEl) return;

function renderRows() {
const stages = CONN_STAGES.filter((s) => !isDormantStage(s));
rowsEl.innerHTML = stages.map((s) => {
const val = data.reachOutStageDays[s];
const placeholder = FIXED_DEFAULT_STAGES.has(s) ? 'auto (2)' : 'auto';
return `<div class="reachout-stage-row">
<span class="reachout-stage-label">${escapeHtml(s)}</span>
<input type="number" min="0" class="mini" data-reachout-days="${escapeHtml(s)}" value="${typeof val === 'number' ? val : ''}" placeholder="${placeholder}">
<span class="reachout-stage-unit">days</span>
</div>`;
}).join('');
rowsEl.querySelectorAll('[data-reachout-days]').forEach((input) => {
input.addEventListener('change', () => {
const stage = input.dataset.reachoutDays;
const v = input.value.trim();
if (v === '') delete data.reachOutStageDays[stage];
else data.reachOutStageDays[stage] = Math.max(0, parseInt(v, 10) || 0);
queueSave();
renderConnections();
});
});
}

btn.addEventListener('click', () => {
const wasHidden = panel.hidden;
panel.hidden = !wasHidden;
if (wasHidden) renderRows();
});
}

// Matched on a fixed synthetic source (not per-connection — this is one
// standing "go review the list" task, not a task per person), the same
// stable-source pattern the Mail and Google Tasks capture buttons use.
// bucket !== 'done' means marking it Done makes the button offer a fresh
// capture next time the list isn't empty — that's the "recurring" part.
const ATTENTION_TASK_SOURCE = { kind: 'needs-attention', url: 'dating-needs-attention' };
function existingAttentionTask() {
return data.tasks.find((t) => t.source && t.source.kind === ATTENTION_TASK_SOURCE.kind && t.source.url === ATTENTION_TASK_SOURCE.url && t.bucket !== 'done');
}

function renderConnections() {
renderSortOptions();
topReachOutIdSet = computeTopReachOut();
// Built once per render, not once per card -- see connectionCardHtml's
// own comment on why that used to be an O(n) rebuild done n times over.
const cityMap = knownCityMap(data.connections);
// Same reasoning, one level deeper: highlightFlagValues' matcher (color
// map, city set, and a compiled regex over every flag-rule value + city +
// country name) doesn't change within a single render either, but every
// card's Notes preview used to call highlightFlagValues() itself, each
// call rebuilding it from scratch -- confirmed live as still a multi-
// second render with 300 search matches even after the chat-transcript
// fix below stopped rebuilding it per LINE. Built once here and threaded
// through connectionCardHtml() for both Notes and chat use.
const matcher = buildFlagMatcher(data.flagRules, cityMap);
const list = document.getElementById('connections-list');
document.getElementById('connections-count').textContent = data.connections.length + (data.connections.length === 1 ? ' connection' : ' connections');
const attnBtn = document.getElementById('conn-needs-attention-btn');
const attnIds = needsAttentionIds();
if (attnBtn) {
attnBtn.textContent = `Needs attention (${attnIds.length})`;
attnBtn.classList.toggle('active', idFilter && idFilter.label === 'Needs attention');
}
const thinBtn = document.getElementById('conn-thin-profiles-btn');
if (thinBtn) {
thinBtn.textContent = `Thin profiles (${thinProfileIds().length})`;
thinBtn.classList.toggle('active', idFilter && idFilter.label === 'Thin profiles');
}
const archivedBtn = document.getElementById('conn-show-archived-btn');
if (archivedBtn) {
const hiddenCount = archivedFadedIds().length;
archivedBtn.textContent = showArchivedFaded ? `Hide archived & faded (${hiddenCount})` : `Show archived & faded (${hiddenCount})`;
archivedBtn.classList.toggle('active', showArchivedFaded);
archivedBtn.hidden = hiddenCount === 0 && !showArchivedFaded;
}
const taskBtn = document.getElementById('conn-attention-task-btn');
if (taskBtn) {
const existing = existingAttentionTask();
if (existing) {
taskBtn.hidden = false;
taskBtn.textContent = '✓ task';
taskBtn.title = 'Already on your task list — go to it';
taskBtn.classList.add('done');
taskBtn.dataset.gotoTask = existing.id;
delete taskBtn.dataset.captureAttentionTask;
} else if (attnIds.length > 0) {
taskBtn.hidden = false;
taskBtn.textContent = '+ task';
taskBtn.title = 'Add a task to work through this list';
taskBtn.classList.remove('done');
taskBtn.dataset.captureAttentionTask = '1';
delete taskBtn.dataset.gotoTask;
} else {
taskBtn.hidden = true;
}
}
if (data.connections.length === 0) {
list.innerHTML = '<div class="empty">No matches logged yet. Add one below.</div>';
refreshPhotoTargets();
return;
}

// "Show me everyone missing a nationality" can't be expressed as a text
// search, so it's a separate filter mode rather than a magic search term.
if (emptyFieldFilter) {
const { field, label } = emptyFieldFilter;
const missing = data.connections.filter((c) => isFieldEmpty(c, field));
list.innerHTML = `<div class="filter-banner">Showing ${missing.length} with no ${escapeHtml(label)} <button class="filter-clear" type="button" id="clear-empty-filter">Clear</button></div>`
+ (missing.length === 0
? '<div class="empty">Everyone has at least one.</div>'
: missing.map((c) => connectionCardHtml(c, cityMap, matcher)).join(''))
+ tagDatalistsHtml();
document.getElementById('clear-empty-filter').addEventListener('click', () => {
emptyFieldFilter = null;
renderConnections();
});
hydratePhotoBackgrounds(list);
flagLowResThumbnails(list);
bindConnectionEvents(list);
refreshPhotoTargets();
return;
}

if (idFilter) {
const picked = data.connections.filter((c) => idFilter.ids.has(c.id));
list.innerHTML = `<div class="filter-banner">${picked.length} matching ${escapeHtml(idFilter.label)} <button class="filter-clear" type="button" id="clear-id-filter">Clear</button></div>`
+ (picked.length === 0 ? '<div class="empty">Nobody matches all of those.</div>' : picked.map((c) => connectionCardHtml(c, cityMap, matcher)).join(''))
+ tagDatalistsHtml();
document.getElementById('clear-id-filter').addEventListener('click', () => { idFilter = null; renderConnections(); });
hydratePhotoBackgrounds(list);
flagLowResThumbnails(list);
bindConnectionEvents(list);
refreshPhotoTargets();
return;
}

const term = foldDiacritics(connectionSearchTerm.trim().toLowerCase());
// Archived/Faded are hidden from the default browse, but a search term is
// an explicit lookup for someone specific -- it searches everyone
// regardless, same as the Overview stage chips (idFilter above) already
// bypass this via their own early return.
const base = (!term && !showArchivedFaded) ? data.connections.filter((c) => !HIDDEN_BY_DEFAULT_STAGES.has(c.stage)) : data.connections;
const filtered = term ? base.filter((c) => {
const haystack = foldDiacritics([
c.name, c.profileName, ...(c.identities || []).flatMap((r) => [r.handle, r.matchId]), ...(c.aliases || []), c.address, c.job, c.education, c.stage, ageDecade(c),
// So the Connections Overview "Contact match" chips actually filter —
// they search by their own label, which otherwise matches nothing.
CONTACT_STATUS_LABELS[c.contactStatus],
// Derived groupings are searched by their own label when a chip is
// clicked, so they have to be findable here or the chip filters to nothing.
photoCoverage(c), ...photoLinkLabels(c),
// Hidden sensitive fields stay out of the haystack too — otherwise
// searching could surface a row *because* of a field you've chosen
// not to display, with no visible reason why it matched.
...visibleTagFields().flatMap((f) => c[f.field] || []),
].filter(Boolean).join(' ').toLowerCase());
return haystack.includes(term);
}) : base;

if (filtered.length === 0) {
list.innerHTML = term
? '<div class="empty">No connections match that search.</div>'
: '<div class="empty">Everyone here is Archived or Faded — use "Show archived &amp; faded" above to see them.</div>';
return;
}

const fields = sortFields();
const primary = fields[connectionSortPrimary] || fields.default;
const secondary = fields[connectionSortSecondary];
const sorted = [...filtered].sort((a, b) => {
const diff = primary.getValue(b) - primary.getValue(a);
if (diff !== 0 || !secondary) return diff;
return secondary.getValue(b) - secondary.getValue(a);
});

list.innerHTML = sorted.map((c) => connectionCardHtml(c, cityMap, matcher)).join('') + tagDatalistsHtml();

hydratePhotoBackgrounds(list);
flagLowResThumbnails(list);
bindConnectionEvents(list);
refreshPhotoTargets();
}

// Explains the quiet where suggestedAction()/the "Reach out" badge would
// normally be — silence with no reason looks like a bug ("why has nobody
// suggested anything for 144 days?"), not a deliberate pause.
function travelBadgeHtml(c) {
if (c.travelStatus === 'standby') return '<span class="travel-badge standby" title="Out of reach-out rotation until you clear this or log matching travel">Standby</span>';
if (c.travelStatus === 'travelling' && c.travelUntil) {
const until = new Date(c.travelUntil).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
return isTravelPaused(c)
? `<span class="travel-badge travelling" title="Reach-out nudges resume automatically after this date">Travelling until ${escapeHtml(until)}</span>`
: `<span class="travel-badge travelling-expired" title="Travel pause ended — clear it or set a new date">Travel pause ended ${escapeHtml(until)}</span>`;
}
return '';
}

// Every chat source writes the identical "[date time] Sender: message"
// line format (see whatsappimport.js's formatMessageLine) into its own
// field (chatLog for Tinder, chatLogWhatsApp, chatLogTelegram -- kept
// separate so one source can never overwrite or hide another's history,
// see state.js's migration guard), so a single merged, date-sorted view
// reads as one real conversation regardless of which app carried it. A
// line with no date prefix (older chatLog saved before dates were
// threaded through) has no sort key and is treated as earliest rather
// than dropped.
// Which icon a chat line's own field maps to -- separate from the Stage/
// c.app source icons above, since a line's platform is fixed by which
// field it was imported into regardless of what the connection's current
// Stage or original match app say.
const CHAT_FIELD_SOURCE_ICONS = {
chatLog: SOURCE_ICONS.Tinder,
chatLogWhatsApp: SOURCE_ICONS.WhatsApp,
chatLogTelegram: SOURCE_ICONS.Telegram,
};

// Tagged with which field each line came from (not just concatenated),
// so a chat spanning more than one platform can still show which is which
// per line -- interleaving three platforms' worth of messages with no way
// to tell them apart was the actual complaint, not the merge itself.
//
// Cached per connection: a full split-tag-and-sort of every line across all
// three chat fields is real work for an active conversation (thousands of
// lines is normal for a months-long WhatsApp history), and every keystroke
// in search re-renders every visible card regardless of whether that
// connection's own chat changed. Keyed by connection id, invalidated by a
// cheap signature (each field's length) rather than re-diffing content --
// a same-length edit slipping through uncached is an acceptable edge case
// for a performance cache, not a correctness-critical one.
const mergedChatLinesCache = new Map(); // id -> { sig, lines }
function chatSignature(c) {
return `${(c.chatLog || '').length}|${(c.chatLogWhatsApp || '').length}|${(c.chatLogTelegram || '').length}`;
}
function mergedChatLines(c) {
const sig = chatSignature(c);
const cached = mergedChatLinesCache.get(c.id);
if (cached && cached.sig === sig) return cached.lines;
const tagged = [
...String(c.chatLog || '').split('\n').filter(Boolean).map((text) => ({ source: 'chatLog', text })),
...String(c.chatLogWhatsApp || '').split('\n').filter(Boolean).map((text) => ({ source: 'chatLogWhatsApp', text })),
...String(c.chatLogTelegram || '').split('\n').filter(Boolean).map((text) => ({ source: 'chatLogTelegram', text })),
];
const lines = tagged.sort((a, b) => {
const da = (a.text.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]/) || [])[1] || '';
const db = (b.text.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]/) || [])[1] || '';
return da < db ? -1 : da > db ? 1 : 0;
});
mergedChatLinesCache.set(c.id, { sig, lines });
return lines;
}

// cityMap is passed in rather than recomputed here -- it's built from
// every connection's location, so rebuilding it once per card (as this
// used to) is an O(n) rebuild done n times over for a full list render.
function connectionCardHtml(c, cityMap, matcher) {
const since = daysSince(c.lastContact);
const travelPaused = isTravelPaused(c);
const overdue = topReachOutIdSet.has(c.id);
const stars = [1, 2, 3, 4, 5].map((n) => `<svg class="star priority-star ${n <= c.priority ? 'filled' : ''}" data-conn="${c.id}" data-star="${n}" viewBox="0 0 20 20" fill="currentColor"><path d="M10 1l2.6 5.9 6.4.6-4.8 4.3 1.4 6.2L10 14.9 4.4 18l1.4-6.2L1 7.5l6.4-.6z"/></svg>`).join('');
const nameMeta = [displayAge(c), (c.location || []).join(', ')].map((s) => String(s || '').trim()).filter(Boolean).join(' · ');
const flags = computeFlags(c, data.flagRules);
const action = suggestedAction(c, data.flagRules);
const questions = suggestedQuestions(c);
const flagDotHtml = flags.worst ? `<span class="dot ${flags.worst}" title="${escapeHtml(flags.hits.map((h) => `${h.label}: ${h.color}`).join(', '))}"></span> ` : '';
// A highlighted preview is only worth showing when it would actually
// surface something the plain text doesn't — a flagged word, or a city
// already on file for someone else. Comparing against a plain escape is
// what applyFlagMatcher() itself falls back to when nothing matched, so
// an unequal result means a span really got inserted, not just that
// Notes happens to be non-empty. Uses the pre-built matcher (see
// renderConnections' own comment) rather than calling highlightFlagValues()
// itself, which would rebuild it from scratch for every card's Notes.
const notesHighlighted = c.notes ? applyFlagMatcher(c.notes, matcher) : '';
const notesHasHits = notesHighlighted && notesHighlighted !== escapeHtml(c.notes);
// The preview and the raw textarea used to both render at once — the
// same text twice in a row, once plain and once highlighted, read as
// duplicated rather than as two views of one thing. Now the preview (or
// the chat transcript's bubbles) is what's actually shown; the editable
// textarea sits behind an "Edit raw text" disclosure instead of always
// being visible underneath. Plain <label> only when there's nothing to
// preview — the .field-block pattern (not <label>) is what the Photos
// row already uses for the same reason: a <details> toggle sharing a row
// with a <label> would forward clicks on it into whatever the label's
// first control is, same implicit-association hazard fixed there.
const notesFieldHtml = notesHasHits
? `<div class="field-block full"><span class="field-label">Notes</span>
<div class="tinder-notes-preview">${notesHighlighted}</div>
<details class="tinder-edit-details"><summary>Edit raw text</summary>
<textarea rows="2" data-field="notes" data-conn-detail="${c.id}">${escapeHtml(c.notes || '')}</textarea>
</details></div>`
: `<label class="full">Notes<textarea rows="2" data-field="notes" data-conn-detail="${c.id}">${escapeHtml(c.notes || '')}</textarea></label>`;
const chatSources = [
{ field: 'chatLog', label: 'Tinder', text: c.chatLog },
{ field: 'chatLogWhatsApp', label: 'WhatsApp', text: c.chatLogWhatsApp },
{ field: 'chatLogTelegram', label: 'Telegram', text: c.chatLogTelegram },
].filter((s) => s.text);
// Merging and highlighting a chat history is real work for a long
// conversation (a genuinely active WhatsApp thread can run thousands of
// lines) -- and this whole field sits inside the collapsible Details
// section below, invisible while collapsed regardless. Skipped entirely
// for a card that isn't expanded, confirmed live as the remaining cost
// behind "search still feels slow with 300+ matches" even after the
// per-line highlight-matcher fix, since every match's full chat was still
// being built into HTML on every render whether or not anyone could see
// it. The toggle handler in bindConnectionEvents re-renders just this one
// card the moment it's actually opened, so nothing stays permanently
// hidden -- it's deferred until looked at, not skipped.
const isExpanded = expandedConnections.has(c.id);
let chatFieldHtml;
if (chatSources.length && !isExpanded) {
chatFieldHtml = `<div class="field-block full"><span class="field-label">Chat history</span><span class="settings-note">Expand Details to view.</span></div>`;
} else {
const mergedLines = mergedChatLines(c);
// Per-line source icons only kick in once there's genuinely more than
// one platform to tell apart -- a single-source chat doesn't need
// clarifying.
const multiSource = chatSources.length > 1;
const chatSourceRow = multiSource
? `<div class="icon-row" style="margin:0 0 6px;">${chatSources.map((s) => iconSpan(CHAT_FIELD_SOURCE_ICONS[s.field].icon, `${s.label} chat`, CHAT_FIELD_SOURCE_ICONS[s.field].cls)).join('')}</div>`
: '';
chatFieldHtml = mergedLines.length
? `<div class="field-block full"><span class="field-label">Chat history</span>
${chatSourceRow}
<div class="tinder-chat-block" style="margin:0;">${chatTranscriptHtml(mergedLines, matcher, multiSource ? CHAT_FIELD_SOURCE_ICONS : null)}</div>
<details class="tinder-edit-details"><summary>Edit raw text</summary>
${chatSources.map((s) => `<div class="settings-note" style="margin:6px 0 2px;">${escapeHtml(s.label)}</div><textarea rows="4" placeholder="One message per line" data-field="${s.field}" data-conn-detail="${c.id}">${escapeHtml(s.text)}</textarea>`).join('')}
</details></div>`
: `<label class="full">Chat history<textarea rows="4" placeholder="Imported from Tinder — one message per line" data-field="chatLog" data-conn-detail="${c.id}"></textarea></label>`;
}
return `<div class="match-card" data-conn-row="${c.id}">
<div class="match-row">
${avatarHtml(c.photoId, c.name)}
<div class="match-id">
<div class="match-name">${flagDotHtml}${escapeHtml(c.name)}${nameMeta ? ` <span class="match-meta">${escapeHtml(nameMeta)}</span>` : ''}</div>
<div class="icon-row">${sourceIconsHtml(c)}${stageIconHtml(c)}${milestoneIconsHtml(c)}</div>
</div>
<div class="stars">${stars}</div>
<div class="match-stage">
<select data-conn-stage="${c.id}">
${CONN_STAGES.map((s) => `<option value="${s}" ${s === c.stage ? 'selected' : ''}>${s}</option>`).join('')}
</select>
</div>
<div class="match-actions">
${c.contactStatus === 'review' ? `<span class="contact-badge review">${escapeHtml(CONTACT_STATUS_LABELS.review)}</span>` : ''}
${travelBadgeHtml(c)}
<span class="match-contact">${since === 0 ? 'today' : since + 'd since contact'}</span>
${overdue ? `<span class="reach-badge" title="${escapeHtml(`${since}d since contact, ${c.priority}★ threshold is ${reachOutThreshold(c.priority)}d${questions.length ? ` — also: ${questions.join('; ')}` : ''}`)}">Reach out</span><button type="button" class="snooze-btn" data-snooze="${c.id}" title="Snooze this for a week">💤</button>` : ''}
${action ? `<span class="suggested-action" title="Suggested next step, recomputed fresh each time">${escapeHtml(action)}</span>` : ''}
<button class="log-btn" data-log="${c.id}">Log contact</button>
<span class="del-x" style="opacity:1;" data-del-conn="${c.id}">&times;</span>
</div>
</div>
${flags.hits.length ? `<div class="flag-breakdown">${flags.hits.map((h) => `<span class="dot ${h.color}"></span>${escapeHtml(h.label)}`).join(' &nbsp; ')}</div>` : ''}
${questions.length ? `<ul class="suggested-questions" title="Deterministic prompts, recomputed fresh each time">${questions.map((q) => `<li>${escapeHtml(q)}</li>`).join('')}</ul>` : ''}
${contactPickerHtml(c.id)}
<details class="match-details" data-conn-details="${c.id}" ${expandedConnections.has(c.id) ? 'open' : ''}>
<summary>Details</summary>
<div class="details-grid">
${c.photoId ? `<div class="full conn-hero-photo">${avatarHtml(c.photoId, c.name, 'hero')}</div>` : ''}
<label>Name<input type="text" autocomplete="off" data-field="name" data-conn-detail="${c.id}" value="${escapeHtml(c.name)}"></label>
<label class="full">Platform identities<span class="settings-note">What each app called them, and its own match key where there is one</span>${identityListHtml(c)}</label>
<label>Source<select data-field="app" data-conn-detail="${c.id}">${appOptions(c.app)}</select></label>
<label>Age when recorded${ageNoteHtml(c)}<input type="text" autocomplete="off" data-field="age" data-conn-detail="${c.id}" value="${escapeHtml(c.age || '')}"></label>
<label>Date of birth<input type="text" inputmode="numeric" autocomplete="off" placeholder="YYYY-MM-DD" pattern="\d{4}-\d{2}-\d{2}" data-field="dob" data-conn-detail="${c.id}" value="${escapeHtml(c.dob || '')}"></label>
<label class="full">City <span class="settings-note">Groups in Overview — a borough and its city, or two homes, are two separate entries</span><div class="tag-editor">${tagChips(c.location, c.id, 'location')}</div></label>
<label>Distance<input type="text" autocomplete="off" placeholder="e.g. &lt; 10 mi" data-field="distance" data-conn-detail="${c.id}" value="${escapeHtml(c.distance || '')}"></label>
<label>Matched on<input type="date" data-field="matchedOn" data-conn-detail="${c.id}" value="${escapeHtml(c.matchedOn || '')}"></label>
<label>Travel status<select data-field="travelStatus" data-conn-detail="${c.id}">
<option value="" ${!c.travelStatus ? 'selected' : ''}>&mdash; normal reach-out rotation</option>
<option value="standby" ${c.travelStatus === 'standby' ? 'selected' : ''}>Standby (foreign city, no end date)</option>
<option value="travelling" ${c.travelStatus === 'travelling' ? 'selected' : ''}>Travelling (auto-resumes on a date)</option>
</select></label>
${c.travelStatus === 'travelling' ? `<label>Travelling until<input type="date" data-field="travelUntil" data-conn-detail="${c.id}" value="${escapeHtml(c.travelUntil || '')}"></label>` : ''}
<label class="full">Full address<input type="text" autocomplete="off" placeholder="Not grouped — detail only" data-field="address" data-conn-detail="${c.id}" value="${escapeHtml(c.address || '')}"></label>
<label>Kids<input type="text" autocomplete="off" data-field="kids" data-conn-detail="${c.id}" value="${escapeHtml(c.kids || '')}"></label>
<label>Job<input type="text" autocomplete="off" data-field="job" data-conn-detail="${c.id}" value="${escapeHtml(c.job || '')}"></label>
<label>Height<input type="text" autocomplete="off" data-field="height" data-conn-detail="${c.id}" value="${escapeHtml(c.height || '')}"></label>
<label>Education<input type="text" autocomplete="off" data-field="education" data-conn-detail="${c.id}" value="${escapeHtml(c.education || '')}"></label>
<label>Drinking<input type="text" autocomplete="off" placeholder="e.g. Socially, at the weekend" data-field="drinking" data-conn-detail="${c.id}" value="${escapeHtml(c.drinking || '')}"></label>
<label>Smoking<input type="text" autocomplete="off" placeholder="e.g. Trying to quit" data-field="smoking" data-conn-detail="${c.id}" value="${escapeHtml(c.smoking || '')}"></label>
<div class="field-block">
<span class="field-label">Phone</span>
<span class="phone-row">
<select class="dial-code" data-dial-for="${c.id}" autocomplete="off">${dialCodeOptions((splitDialCode(c.phone) || {}).dial)}</select>
<input type="tel" autocomplete="off" placeholder="Used to match Google Contacts" data-field="phone" data-conn-detail="${c.id}" value="${escapeHtml(c.phone || '')}" name="conn-phone-${c.id}">
</span>
</div>
<label>Email<input type="email" autocomplete="off" placeholder="Also used to match" data-field="email" data-conn-detail="${c.id}" value="${escapeHtml(c.email || '')}" name="conn-email-${c.id}"></label>
<label>What I like most<input type="text" autocomplete="off" data-field="likes" data-conn-detail="${c.id}" value="${escapeHtml(c.likes || '')}"></label>
${notesFieldHtml}
${chatFieldHtml}
${visibleTagFields().filter((f) => f.field !== 'location').map((f) => `<label class="full${f.sensitive ? ' sensitive-field' : ''}">${escapeHtml(f.label)}<div class="tag-editor">${tagChips(c[f.field], c.id, f.field)}</div></label>`).join('')}
<label class="full">Ratings${averageRatingHtml(c)}<div class="ratings-block">${data.ratingCategories.map(({ field, label }) => ratingStars(label, field, c.id, (c.ratings && c.ratings[field]) || 0)).join('')}</div></label>
<label class="full">Things to do<div>${todoListHtml(c)}</div></label>
<div class="field-block full"><span class="field-label">Photos</span>${galleryHtml(c)}
<label class="file-btn" for="parse-profile-${c.id}">📥 Add photos &amp; parse profile</label>
<input type="file" id="parse-profile-${c.id}" accept="image/*" multiple style="display:none;" data-parse-profile="${c.id}">
<span class="settings-note" id="parse-profile-status-${c.id}"></span>
</div>
<label class="full">Google Photos albums${albumListHtml(c)}</label>
<label class="full">Drive/OneDrive link (optional, for full-res photos filed elsewhere)<input type="text" autocomplete="off" placeholder="Paste a share link" data-field="driveLink" data-conn-detail="${c.id}" value="${escapeHtml(c.driveLink || '')}"></label>
${c.driveLink ? `<div class="full"><a href="${escapeHtml(c.driveLink)}" target="_blank" rel="noopener" style="font-size:12px;color:var(--rose);">Open full-res photos &#8599;</a></div>` : ''}
</div>
</details>
</div>`;
}

function bindConnectionEvents(list) {
contactPicker.bind(list);
list.querySelectorAll('.priority-star').forEach((star) => {
star.addEventListener('click', () => {
const conn = data.connections.find((x) => x.id === star.dataset.conn);
conn.priority = parseInt(star.dataset.star, 10);
renderConnections();
queueSave();
});
});
list.querySelectorAll('.rate-star').forEach((star) => {
star.addEventListener('click', () => {
const conn = data.connections.find((x) => x.id === star.dataset.rateConn);
if (!conn.ratings) conn.ratings = {};
conn.ratings[star.dataset.rateCat] = parseInt(star.dataset.rateStar, 10);
renderConnections();
queueSave();
});
});
list.querySelectorAll('[data-conn-stage]').forEach((sel) => {
sel.addEventListener('change', () => {
const conn = data.connections.find((x) => x.id === sel.dataset.connStage);
conn.stage = sel.value;
// Reaching "Met in person" or beyond through the normal stage
// progression records the milestone automatically -- milestones stays a
// separate field precisely so it isn't lost if Stage moves on again
// later (Faded/Archived rank the same as never-progressed), and this
// saves a manual tick for the common case of getting there the ordinary
// way rather than jumping straight to Archived.
if ((STAGE_RANK[sel.value] ?? 0) >= STAGE_RANK['Met in person']) {
if (!Array.isArray(conn.milestones)) conn.milestones = [];
unionInto(conn.milestones, ['Met']);
}
renderConnections();
renderOverviewRef();
queueSave();
});
});
list.querySelectorAll('[data-log]').forEach((btn) => {
btn.addEventListener('click', () => {
const conn = data.connections.find((x) => x.id === btn.dataset.log);
conn.lastContact = todayStr();
renderConnections();
queueSave();
});
});
list.querySelectorAll('[data-snooze]').forEach((btn) => {
btn.addEventListener('click', () => {
const conn = data.connections.find((x) => x.id === btn.dataset.snooze);
if (!conn) return;
const d = new Date();
d.setDate(d.getDate() + 7);
conn.attentionSnoozedUntil = d.toISOString().slice(0, 10);
renderConnections();
queueSave();
});
});
list.querySelectorAll('[data-del-conn]').forEach((el) => {
el.addEventListener('click', async () => {
const conn = data.connections.find((x) => x.id === el.dataset.delConn);
if (!confirm(`Delete "${conn.name}"? This removes all notes, ratings, and photos for them.`)) return;
for (const id of conn.photoIds || []) await photoDelete(id);
data.connections = data.connections.filter((x) => x.id !== el.dataset.delConn);
renderConnections();
renderOverviewRef();
queueSave();
});
});
list.querySelectorAll('[data-conn-detail]').forEach((el) => {
el.addEventListener('change', () => {
const conn = data.connections.find((x) => x.id === el.dataset.connDetail);
conn[el.dataset.field] = el.type === 'checkbox' ? el.checked : el.value;
// A field you just typed into by hand has, by definition, just been
// resolved -- drop any stale "differs from Google Contacts" conflict still
// parked against it (contactConflicts is a snapshot taken at match/sync
// time, not recomputed live, so it otherwise keeps showing an outdated
// Keep/Use prompt referencing a value that's no longer even on the card).
if (Array.isArray(conn.contactConflicts) && conn.contactConflicts.some((k) => k.field === el.dataset.field)) {
conn.contactConflicts = conn.contactConflicts.filter((k) => k.field !== el.dataset.field);
}
// Typing an age states what they are TODAY, so record today as the date
// it was true — that's what lets it be carried forward later.
if (el.dataset.field === 'age') conn.ageAsOf = el.value.trim() ? todayStr() : '';
// "Travelling" without a date would silently never expire — default to a
// two-week pause (the case the status is named for) so it self-clears
// even if the actual return date is never filled in.
if (el.dataset.field === 'travelStatus' && el.value === 'travelling' && !String(conn.travelUntil || '').trim()) {
const until = new Date();
until.setDate(until.getDate() + 14);
conn.travelUntil = until.toISOString().slice(0, 10);
}
// These are echoed elsewhere in the card (the name line, the source tag,
// every merge dropdown), so a full re-render is the only way to keep
// those honest. `change` fires on blur, not per keystroke, so this costs
// one render per edit rather than one per character.
// The link fields are in here because pasting a URL has to redraw the card
// for its "Open …" hyperlink to appear — without that the link only shows
// up the next time something else happened to trigger a render, which looks
// exactly like the paste not working. travelStatus needs it too, to show/
// hide the "Travelling until" date field and refresh the badge/action.
// phone/email are here so a just-dropped stale conflict (above) actually
// disappears from the card instead of waiting for some other edit to
// trigger the next full render.
if (['name', 'app', 'age', 'dob', 'location', 'driveLink', 'travelStatus', 'phone', 'email'].includes(el.dataset.field)) renderConnections();
renderOverviewRef();
queueSave();
});
});
list.querySelectorAll('[data-dial-for]').forEach((sel) => {
sel.addEventListener('change', () => {
const conn = data.connections.find((x) => x.id === sel.dataset.dialFor);
if (!conn || !sel.value) return;
const input = list.querySelector(`input[data-field="phone"][data-conn-detail="${sel.dataset.dialFor}"]`);
// Replace any existing prefix rather than stacking them up, and drop a
// leading national 0 — "+44 07700…" is not a valid number.
const rest = String(input.value || '').replace(/^\s*\+\d{1,4}\s*/, '').replace(/^0/, '').trim();
conn.phone = `${sel.value} ${rest}`.trim();
input.value = conn.phone;
queueSave();
});
});

list.querySelectorAll('[data-tag-remove]').forEach((el) => {
el.addEventListener('click', () => {
const conn = data.connections.find((x) => x.id === el.dataset.tagRemove);
conn[el.dataset.tagField].splice(parseInt(el.dataset.tagIdx, 10), 1);
renderConnections();
renderOverviewRef();
queueSave();
});
});
const commitTagAdd = (connId, field, inputEl) => {
const raw = inputEl.value.trim().replace(/,$/, '').trim();
if (!raw) return;
const conn = data.connections.find((x) => x.id === connId);
if (!conn[field]) conn[field] = [];
// Reuse the spelling already in use elsewhere, so typing "sporty" when
// "Sporty" exists doesn't create a second tag that groups separately in
// Overview. Whatever was entered first wins.
const canonical = existingTagValues(field)
.find((v) => v.toLowerCase() === raw.toLowerCase()) || raw;
if (conn[field].some((v) => String(v).trim().toLowerCase() === canonical.toLowerCase())) {
inputEl.value = '';
return;
}
conn[field].push(canonical);
renderConnections();
renderOverviewRef();
queueSave();
};
list.querySelectorAll('[data-tag-add]').forEach((input) => {
input.addEventListener('keydown', (e) => {
if (e.key === 'Enter' || e.key === ',') {
e.preventDefault();
commitTagAdd(input.dataset.tagAdd, input.dataset.tagField, input);
}
});
});
list.querySelectorAll('[data-tag-add-btn]').forEach((btn) => {
btn.addEventListener('click', () => {
const input = list.querySelector(`[data-tag-add="${btn.dataset.tagAddBtn}"][data-tag-field="${btn.dataset.tagAddBtnField}"]`);
if (input) commitTagAdd(btn.dataset.tagAddBtn, btn.dataset.tagAddBtnField, input);
});
});
list.querySelectorAll('[data-todo-toggle]').forEach((cb) => {
cb.addEventListener('change', () => {
const conn = data.connections.find((x) => x.id === cb.dataset.todoToggle);
const todo = conn.todos.find((t) => t.id === cb.dataset.todoId);
if (todo) todo.done = cb.checked;
renderConnections();
queueSave();
});
});
list.querySelectorAll('[data-todo-remove]').forEach((el) => {
el.addEventListener('click', () => {
const conn = data.connections.find((x) => x.id === el.dataset.todoRemove);
conn.todos = conn.todos.filter((t) => t.id !== el.dataset.todoId);
renderConnections();
queueSave();
});
});
list.querySelectorAll('[data-todo-add]').forEach((btn) => {
const fire = () => {
const input = list.querySelector(`[data-todo-input="${btn.dataset.todoAdd}"]`);
const val = input.value.trim();
if (!val) return;
const conn = data.connections.find((x) => x.id === btn.dataset.todoAdd);
if (!conn.todos) conn.todos = [];
conn.todos.push({ id: uid(), text: val, done: false });
renderConnections();
queueSave();
};
btn.addEventListener('click', fire);
});
list.querySelectorAll('[data-todo-input]').forEach((input) => {
input.addEventListener('keydown', (e) => {
if (e.key === 'Enter') {
e.preventDefault();
list.querySelector(`[data-todo-add="${input.dataset.todoInput}"]`).click();
}
});
});
list.querySelectorAll('[data-identity-field]').forEach((el) => {
el.addEventListener('change', () => {
const conn = data.connections.find((x) => x.id === el.dataset.conn);
if (!conn) return;
const row = (conn.identities || []).find((r) => r.id === el.dataset.identityId);
if (!row) return;
row[el.dataset.identityField] = el.value;
queueSave();
});
});
list.querySelectorAll('[data-identity-remove]').forEach((el) => {
el.addEventListener('click', () => {
const conn = data.connections.find((x) => x.id === el.dataset.identityRemove);
if (!conn) return;
conn.identities = (conn.identities || []).filter((r) => r.id !== el.dataset.identityId);
renderConnections();
queueSave();
});
});
list.querySelectorAll('[data-identity-add]').forEach((btn) => {
btn.addEventListener('click', () => {
const conn = data.connections.find((x) => x.id === btn.dataset.identityAdd);
if (!conn) return;
if (!Array.isArray(conn.identities)) conn.identities = [];
conn.identities.push({ id: uid(), platform: 'Tinder', handle: '', matchId: '' });
renderConnections();
queueSave();
});
});
list.querySelectorAll('[data-photo-remove]').forEach((el) => {
el.addEventListener('click', async () => {
const conn = data.connections.find((x) => x.id === el.dataset.photoRemove);
const idx = parseInt(el.dataset.photoIdx, 10);
const [removedId] = conn.photoIds.splice(idx, 1);
if (conn.photoId === removedId) conn.photoId = conn.photoIds[0] || null;
if (removedId) await photoDelete(removedId);
renderConnections();
queueSave();
});
});
list.querySelectorAll('[data-album-remove]').forEach((el) => {
el.addEventListener('click', () => {
const conn = data.connections.find((x) => x.id === el.dataset.albumRemove);
if (!conn) return;
// Unlinks here only — the album itself stays in Google Photos.
conn.photoAlbums.splice(parseInt(el.dataset.albumIdx, 10), 1);
renderConnections();
queueSave();
});
});
list.querySelectorAll('[data-view-photo]').forEach((el) => {
el.addEventListener('click', async () => {
const url = await photoUrl(el.dataset.viewPhoto);
if (url) openLightbox(url);
});
});
list.querySelectorAll('[data-set-cover]').forEach((btn) => {
btn.addEventListener('click', (e) => {
e.preventDefault();
e.stopPropagation();
const conn = data.connections.find((x) => x.id === btn.dataset.setCover);
if (!conn) return;
conn.photoId = btn.dataset.setCoverId;
renderConnections();
queueSave();
});
});
// Wired identically for both Notes and Chat history previews -- a city or
// nationality mentioned mid-conversation is exactly as worth a click-to-add
// as one mentioned in Notes, and this was the one place that treatment
// hadn't reached (see chatTranscriptHtml() in utils.js, which now runs the
// same highlightFlagValues() pass Notes always has). data-tinder-city
// stays its own attribute (pre-dates the generic mechanism, and City's
// mapping is fixed); data-tinder-add-label/-value is the generic one
// highlightFlagValues() now also uses for country/nationality hits.
const ADD_LABEL_TO_FIELD = { Nationality: 'nationality' };
['.tinder-notes-preview', '.tinder-chat-block'].forEach((scope) => {
list.querySelectorAll(`${scope} [data-tinder-city]`).forEach((hit) => {
hit.addEventListener('click', () => {
const row = hit.closest('[data-conn-row]');
const conn = data.connections.find((x) => x.id === row?.dataset.connRow);
if (!conn) return;
if (!Array.isArray(conn.location)) conn.location = [];
unionInto(conn.location, [hit.dataset.tinderCity]);
renderConnections();
renderOverviewRef();
queueSave();
});
});
list.querySelectorAll(`${scope} [data-tinder-add-label]`).forEach((hit) => {
hit.addEventListener('click', () => {
const field = ADD_LABEL_TO_FIELD[hit.dataset.tinderAddLabel];
if (!field) return;
const row = hit.closest('[data-conn-row]');
const conn = data.connections.find((x) => x.id === row?.dataset.connRow);
if (!conn) return;
if (!Array.isArray(conn[field])) conn[field] = [];
unionInto(conn[field], [hit.dataset.tinderAddValue]);
renderConnections();
renderOverviewRef();
queueSave();
});
});
});
list.querySelectorAll('[data-photo-add]').forEach((input) => {
input.addEventListener('change', async (e) => {
const conn = data.connections.find((x) => x.id === input.dataset.photoAdd);
if (!conn.photoIds) conn.photoIds = [];
const files = Array.from(e.target.files).slice(0, 12 - conn.photoIds.length);
for (const file of files) {
try {
const blob = await resizeImageToBlob(file, 900, 0.85);
const id = await storePhoto(blob);
conn.photoIds.push(id);
if (!conn.photoId) conn.photoId = id;
} catch (err) { /* skip unreadable file */ }
}
renderConnections();
queueSave();
});
});
list.querySelectorAll('[data-conn-details]').forEach((el) => {
el.addEventListener('toggle', () => {
const id = el.dataset.connDetails;
const wasOpen = expandedConnections.has(id);
if (el.open) expandedConnections.add(id);
else expandedConnections.delete(id);
// Opening (not closing) needs a targeted re-render: connectionCardHtml
// skips the chat history entirely while collapsed (see its own comment),
// so the lightweight placeholder needs swapping for the real transcript
// now that it's actually visible. Closing doesn't need this -- the
// content already there just becomes hidden again by the browser: no
// need to tear it down and rebuild the (cheap) placeholder in its place.
// Scoped to this one card, not a full renderConnections(), so opening
// one connection's Details among 300+ search results doesn't pay to
// rebuild every other card too.
if (el.open && !wasOpen) {
const card = el.closest('.match-card');
const conn = data.connections.find((x) => x.id === id);
if (card && conn) {
const cityMap = knownCityMap(data.connections);
const matcher = buildFlagMatcher(data.flagRules, cityMap);
card.outerHTML = connectionCardHtml(conn, cityMap, matcher);
const fresh = list.querySelector(`[data-conn-row="${CSS.escape(id)}"]`);
if (fresh) {
hydratePhotoBackgrounds(fresh);
flagLowResThumbnails(fresh);
bindConnectionEvents(fresh);
}
}
}
});
});
list.querySelectorAll('[data-parse-profile]').forEach((input) => {
input.addEventListener('change', async (e) => {
const files = Array.from(e.target.files);
e.target.value = '';
if (!files.length) return;
await applyDirectProfileUpload(files, input.dataset.parseProfile);
});
});
list.querySelectorAll('[data-replace-photo]').forEach((input) => {
input.addEventListener('change', async (e) => {
const file = e.target.files[0];
e.target.value = '';
if (!file) return;
await replacePhotoInPlace(input.dataset.replacePhoto, parseInt(input.dataset.replaceIdx, 10), file);
});
});
}

// Settings -> "rating categories": add/remove which detailed star ratings
// exist at all. Mirrors the task-contexts editor's tag-chip pattern.
// Renaming isn't offered — unlike a task context (just a label on a task), a
// rating category's `field` key is where real per-person data lives, and
// there's no safe way to rename in place without either orphaning existing
// ratings or silently merging two categories' data together.
// All distinct values ever seen for this field across every connection,
// most common first, with whether any occurrence carried Tinder's own
// "(shared)" marker (see the console snippet) -- used to pre-colour a
// value green in the picker below, since a shared interest is a free,
// positive signal that didn't need a judgement call.
function collectFieldValues(field) {
const def = FLAG_FIELD_DEFS.find((d) => d.field === field);
if (!def) return [];
const counts = new Map(); // lowercase canonical value -> {label, count, wasShared}
data.connections.forEach((c) => {
(def.getValue(c) || []).forEach((raw) => {
const canonical = stripSharedSuffix(raw);
if (!canonical) return;
const key = canonical.toLowerCase();
const wasShared = /\(shared\)\s*$/i.test(String(raw));
const existing = counts.get(key);
if (existing) { existing.count++; if (wasShared) existing.wasShared = true; }
else counts.set(key, { label: canonical, count: 1, wasShared });
});
});
return [...counts.values()].sort((a, b) => b.count - a.count);
}

// A tedious comma-separated text box is a bad way to colour a field with
// dozens of real-world values (Interests especially) -- this picker shows
// every value actually seen across your connections instead, so setting
// up Interests colours is "click the ones that matter" rather than typing
// out and misspelling values from memory. Click cycles a chip through
// green -> amber -> red -> none; Save writes straight into the field's
// flagRules entry (creating one if it didn't exist yet), so it stays the
// exact same rule the plain text boxes edit -- either UI reflects the other.
let tagPickerState = null; // { field, values, colors: Map<lowercase, color|null> }
const TAG_PICKER_CYCLE = [null, 'green', 'amber', 'red'];

function openTagColorPicker(field) {
const def = FLAG_FIELD_DEFS.find((d) => d.field === field);
if (!def) return;
const rule = data.flagRules.find((r) => r.field === field);
const values = collectFieldValues(field);
const colors = new Map();
values.forEach((v) => {
let color = null;
if (rule) {
if ((rule.red || []).some((x) => stripSharedSuffix(x).toLowerCase() === v.label.toLowerCase())) color = 'red';
else if ((rule.amber || []).some((x) => stripSharedSuffix(x).toLowerCase() === v.label.toLowerCase())) color = 'amber';
else if ((rule.green || []).some((x) => stripSharedSuffix(x).toLowerCase() === v.label.toLowerCase())) color = 'green';
}
if (!color && v.wasShared) color = 'green';
colors.set(v.label.toLowerCase(), color);
});
tagPickerState = { field, values, colors };
renderTagColorPicker();
}

function closeTagColorPicker() {
tagPickerState = null;
const box = document.getElementById('tag-color-picker');
if (box) box.remove();
}

function renderTagColorPicker() {
let box = document.getElementById('tag-color-picker');
if (!box) {
box = document.createElement('div');
box.id = 'tag-color-picker';
box.className = 'cook-overlay';
document.body.appendChild(box);
}
if (!tagPickerState) { box.remove(); return; }
const { field, values, colors } = tagPickerState;
const def = FLAG_FIELD_DEFS.find((d) => d.field === field);
const anyShared = values.some((v) => v.wasShared);
box.innerHTML = `<div class="cook-sheet">
<div class="cook-head"><h2>${escapeHtml(def.label)} colours</h2><button class="sync-btn sm" type="button" id="tag-picker-close">&times;</button></div>
<div class="cook-body">
${values.length ? `<div class="settings-note" style="margin:0 0 10px;">Click a tag to cycle green &rarr; amber &rarr; red &rarr; none. Sorted by how often it comes up.${anyShared ? " Shared interests (Tinder's own marker) start green." : ''}</div>
<div class="tag-picker-grid">${values.map((v) => {
const key = v.label.toLowerCase();
const color = colors.get(key);
return `<button type="button" class="tag-picker-chip${color ? ' tag-picker-' + color : ''}" data-tag-picker-key="${escapeHtml(key)}" title="${v.count} connection${v.count === 1 ? '' : 's'}${v.wasShared ? ' · shared with you' : ''}">${escapeHtml(v.label)}</button>`;
}).join('')}</div>`
: '<div class="empty">No values on file yet for this field.</div>'}
</div>
<div class="cook-foot" style="display:flex;gap:8px;justify-content:flex-end;">
<button class="sync-btn" type="button" id="tag-picker-cancel">Cancel</button>
<button class="add-btn" type="button" id="tag-picker-save">Save</button>
</div>
</div>`;
box.addEventListener('click', (e) => { if (e.target === box) closeTagColorPicker(); });
document.getElementById('tag-picker-close').addEventListener('click', closeTagColorPicker);
document.getElementById('tag-picker-cancel').addEventListener('click', closeTagColorPicker);
box.querySelectorAll('[data-tag-picker-key]').forEach((chip) => {
chip.addEventListener('click', () => {
const key = chip.dataset.tagPickerKey;
const idx = TAG_PICKER_CYCLE.indexOf(tagPickerState.colors.get(key));
tagPickerState.colors.set(key, TAG_PICKER_CYCLE[(idx + 1) % TAG_PICKER_CYCLE.length]);
renderTagColorPicker();
});
});
document.getElementById('tag-picker-save').addEventListener('click', () => {
let rule = data.flagRules.find((r) => r.field === field);
if (!rule) { rule = { id: uid(), field, green: [], amber: [], red: [] }; data.flagRules.push(rule); }
rule.green = []; rule.amber = []; rule.red = [];
tagPickerState.colors.forEach((color, key) => {
if (!color) return;
const v = tagPickerState.values.find((x) => x.label.toLowerCase() === key);
rule[color].push(v ? v.label : key);
});
closeTagColorPicker();
initFlagRulesSettings();
renderConnections();
queueSave();
});
}

function flagRuleRowHtml(rule) {
const def = FLAG_FIELD_DEFS.find((d) => d.field === rule.field);
if (!def) return '';
// All four bounds, not just greenMax/redMin -- thresholdColor() in
// state.js has supported both directions (short-is-good like Distance,
// tall-is-good like Height) since the Height rule was added, but this
// form was never updated to match, so a rule using greenMin/redMax (like
// the seeded Height default) showed as two blank boxes with no way to
// see or edit its actual values. Confirmed live.
const inputs = def.kind === 'number'
? `<input type="number" class="mini" data-flag-bound="greenMin" data-flag-rule="${rule.id}" value="${rule.greenMin ?? ''}" placeholder="Green &ge;">`
+ `<input type="number" class="mini" data-flag-bound="greenMax" data-flag-rule="${rule.id}" value="${rule.greenMax ?? ''}" placeholder="Green &le;">`
+ `<input type="number" class="mini" data-flag-bound="redMin" data-flag-rule="${rule.id}" value="${rule.redMin ?? ''}" placeholder="Red &ge;">`
+ `<input type="number" class="mini" data-flag-bound="redMax" data-flag-rule="${rule.id}" value="${rule.redMax ?? ''}" placeholder="Red &le;">`
: `<input type="text" autocomplete="off" data-flag-list="green" data-flag-rule="${rule.id}" value="${escapeHtml((rule.green || []).join(', '))}" placeholder="Green values, comma separated">`
+ `<input type="text" autocomplete="off" data-flag-list="amber" data-flag-rule="${rule.id}" value="${escapeHtml((rule.amber || []).join(', '))}" placeholder="Amber values, comma separated">`
+ `<input type="text" autocomplete="off" data-flag-list="red" data-flag-rule="${rule.id}" value="${escapeHtml((rule.red || []).join(', '))}" placeholder="Red values, comma separated">`
+ `<button type="button" class="sync-btn sm" data-tag-picker-open="${escapeHtml(rule.field)}">Pick tags&hellip;</button>`;
return `<div class="flag-rule-row">
<strong>${escapeHtml(def.label)}</strong>
${inputs}
<span class="tag-x" data-del-flag-rule="${rule.id}">&times;</span>
</div>`;
}

// Settings -> "Red/amber/green flags": a generic rule per field, either a
// numeric threshold (Distance, Age) or a value list (everything else,
// including the TAG_FIELDS chip lists) -- see computeFlags()/
// FLAG_FIELD_DEFS in state.js for how a rule actually gets evaluated.
function initFlagRulesSettings() {
const el = document.getElementById('flag-rules-list');
if (!el) return;

function render() {
if (!Array.isArray(data.flagRules)) data.flagRules = [];
const addOptions = FLAG_FIELD_DEFS.map((d) => `<option value="${escapeHtml(d.field)}">${escapeHtml(d.label)}</option>`).join('');
el.innerHTML = data.flagRules.map(flagRuleRowHtml).join('')
+ `<div class="flag-rule-row"><select id="new-flag-rule-field">${addOptions}</select><button class="sync-btn sm" type="button" id="add-flag-rule-btn">+ Add rule</button></div>`;

el.querySelectorAll('[data-del-flag-rule]').forEach((x) => {
x.addEventListener('click', () => {
data.flagRules = data.flagRules.filter((r) => r.id !== x.dataset.delFlagRule);
render();
renderConnections();
queueSave();
});
});
el.querySelectorAll('[data-flag-bound]').forEach((input) => {
input.addEventListener('change', () => {
const rule = data.flagRules.find((r) => r.id === input.dataset.flagRule);
if (!rule) return;
const v = input.value.trim();
rule[input.dataset.flagBound] = v === '' ? null : parseFloat(v);
renderConnections();
queueSave();
});
});
el.querySelectorAll('[data-flag-list]').forEach((input) => {
input.addEventListener('change', () => {
const rule = data.flagRules.find((r) => r.id === input.dataset.flagRule);
if (!rule) return;
rule[input.dataset.flagList] = input.value.split(',').map((s) => s.trim()).filter(Boolean);
renderConnections();
queueSave();
});
});
el.querySelectorAll('[data-tag-picker-open]').forEach((btn) => {
btn.addEventListener('click', () => openTagColorPicker(btn.dataset.tagPickerOpen));
});
const addBtn = document.getElementById('add-flag-rule-btn');
if (addBtn) addBtn.addEventListener('click', () => {
const field = document.getElementById('new-flag-rule-field').value;
const def = FLAG_FIELD_DEFS.find((d) => d.field === field);
if (!def) return;
data.flagRules.push(def.kind === 'number'
? { id: uid(), field, greenMax: null, redMin: null }
: { id: uid(), field, green: [], amber: [], red: [] });
render();
queueSave();
});
}
render();
}

function initRatingCategoriesSettings() {
const el = document.getElementById('rating-categories-list');
if (!el) return;

function render() {
const taken = new Set(data.ratingCategories.map((c) => c.field));
el.innerHTML = data.ratingCategories.map((c) => `<span class="tag-chip">${escapeHtml(c.label)}<span class="tag-x" data-del-rating-cat="${escapeHtml(c.field)}">&times;</span></span>`).join('')
+ '<input type="text" autocomplete="off" class="tag-add-input" id="new-rating-cat-input" placeholder="+ add rating">';

el.querySelectorAll('[data-del-rating-cat]').forEach((x) => {
x.addEventListener('click', () => {
const field = x.dataset.delRatingCat;
const cat = data.ratingCategories.find((c) => c.field === field);
if (!cat) return;
const ratedCount = data.connections.filter((c) => c.ratings && c.ratings[field]).length;
const warning = ratedCount
? `Remove "${cat.label}"? ${ratedCount} connection${ratedCount === 1 ? ' has' : 's have'} a rating under it — those ratings are lost, not just hidden.`
: `Remove "${cat.label}"? Nobody has been rated under it yet.`;
if (!confirm(warning)) return;
data.ratingCategories = data.ratingCategories.filter((c) => c.field !== field);
data.connections.forEach((c) => { if (c.ratings) delete c.ratings[field]; });
render();
renderConnections();
queueSave();
});
});

const input = el.querySelector('#new-rating-cat-input');
input.addEventListener('keydown', (e) => {
if (e.key !== 'Enter') return;
e.preventDefault();
const label = input.value.trim();
if (!label || data.ratingCategories.some((c) => c.label.toLowerCase() === label.toLowerCase())) { input.value = ''; return; }
data.ratingCategories.push({ field: slugifyField(label, taken), label });
render();
renderConnections();
queueSave();
});
}
render();
}

function initConnectionForm() {
fillAppSelect('conn-app-input');
fillAppSelect('import-app-input');
bindForm('connection-form', () => {
const nameInput = document.getElementById('conn-name-input');
const appInput = document.getElementById('conn-app-input');
const name = nameInput.value.trim();
if (!name) return;
const newId = uid();
data.connections.push(blankConnection({ id: newId, name, app: appInput.value, lastContact: todayStr() }));
nameInput.value = '';
renderConnections();
renderOverviewRef();
queueSave();
setTimeout(() => scrollAndFlash(`[data-conn-row="${newId}"]`), 50);
});

document.getElementById('conn-needs-attention-btn').addEventListener('click', () => {
if (idFilter && idFilter.label === 'Needs attention') { clearFilters(); return; }
filterByIds(needsAttentionIds(), 'Needs attention');
});
document.getElementById('conn-thin-profiles-btn').addEventListener('click', () => {
if (idFilter && idFilter.label === 'Thin profiles') { clearFilters(); return; }
filterByIds(thinProfileIds(), 'Thin profiles');
});
document.getElementById('conn-show-archived-btn').addEventListener('click', () => {
showArchivedFaded = !showArchivedFaded;
setLocalSetting('showArchivedFaded', showArchivedFaded);
renderConnections();
});
document.getElementById('merge-admin-btn').addEventListener('click', () => {
const targetSel = document.getElementById('merge-target-input');
const sourceSel = document.getElementById('merge-source-input');
const status = document.getElementById('merge-admin-status');
const target = data.connections.find((x) => x.id === targetSel.value);
const source = data.connections.find((x) => x.id === sourceSel.value);
if (!target || !source) { status.textContent = 'Pick both a profile to keep and one to merge in.'; return; }
if (target.id === source.id) { status.textContent = "Can't merge a profile into itself."; return; }
if (!confirm(`Merge "${source.name}" into "${target.name}"?\n\nEverything from "${source.name}" — photos, notes, ratings, tags, to-dos — is folded in, keeping "${target.name}"'s values wherever both have one. "${source.name}" is then removed.\n\nThis can't be undone.`)) return;
mergeConnectionInto(target, source);
data.connections = data.connections.filter((x) => x.id !== source.id);
status.textContent = `Merged "${source.name}" into "${target.name}".`;
targetSel.value = '';
sourceSel.value = '';
renderConnections();
renderOverviewRef();
queueSave();
});
document.getElementById('conn-attention-task-btn').addEventListener('click', async (e) => {
if (e.target.dataset.gotoTask) {
const { switchTab } = await import('../tabs.js');
switchTab('tasks');
revealTask(e.target.dataset.gotoTask);
return;
}
if (e.target.dataset.captureAttentionTask) {
const n = needsAttentionIds().length;
captureTask({
title: `Ask ${n} connection${n === 1 ? '' : 's'} the outstanding questions`,
notes: 'Open the "Needs attention" filter on the Dating tab and work through the list — each card shows what to ask or check.',
source: ATTENTION_TASK_SOURCE,
link: '#dating',
});
renderConnections();
}
});
initReachOutSettings();
document.getElementById('conn-backlog-review-btn').addEventListener('click', () => {
const candidates = data.connections.filter((c) => c.stage !== 'Backlog review' && !isDormantStage(c.stage) && !isTravelPaused(c) && daysSince(c.lastContact) >= 180);
if (!candidates.length) {
// "Nobody qualifies" reads as "you have no stale matches" -- but this
// only ever looks at people NOT already in Backlog review (so a repeat
// click doesn't re-flag the same people every time), so the far more
// common reason for zero is that everyone currently 180+ days stale is
// already sitting there from an earlier run. Distinguish the two rather
// than showing one message for both. Confirmed live: reported as
// confusing when a connections list already had plenty in that stage.
const alreadyThere = data.connections.filter((c) => c.stage === 'Backlog review' && daysSince(c.lastContact) >= 180).length;
alert(alreadyThere
? `No NEW connections crossed 180 days since last contact — ${alreadyThere} already in "Backlog review" are still that stale, if you want to review them.`
: 'Nobody is 180+ days since last contact right now (outside Faded/Archived/FriendZone/travel-paused).');
return;
}
if (!confirm(`Move ${candidates.length} connection${candidates.length === 1 ? '' : 's'} (180+ days since last contact) to "Backlog review"?`)) return;
candidates.forEach((c) => { c.stage = 'Backlog review'; });
renderConnections();
renderOverviewRef();
queueSave();
});
document.getElementById('conn-search').addEventListener('input', (e) => {
connectionSearchTerm = e.target.value;
// Typing a search is an implicit "forget the None filter" — leaving both
// active would show a filtered subset with no indication why.
emptyFieldFilter = null;
// Debounced: a full render (every visible card's chat/tags/highlighting
// rebuilt) is real work even after the per-line matcher fix below, so
// firing it on every single keystroke rather than once you pause typing
// is wasted work piling up behind whatever's currently mid-render.
clearTimeout(searchDebounceTimer);
searchDebounceTimer = setTimeout(renderConnections, 150);
});
document.getElementById('conn-sort-primary').addEventListener('change', (e) => {
connectionSortPrimary = e.target.value;
renderConnections();
});
document.getElementById('conn-sort-secondary').addEventListener('change', (e) => {
connectionSortSecondary = e.target.value;
renderConnections();
});

initImport();
}

// ---- Screenshot import ----

async function withImportStatus(statusEl, fn) {
try {
await fn();
} catch (err) {
console.error('Screenshot import failed:', err);
if (err instanceof MissingKeyError) {
statusEl.textContent = 'Add an Anthropic API key in Settings first.';
} else {
statusEl.textContent = `Couldn't read that screenshot: ${err.message || err}`;
}
}
}

function existingMatchCaption(m) {
const parts = [];
if (m.app) parts.push(m.app);
parts.push(m.lastContact ? `contacted ${daysSince(m.lastContact)}d ago` : 'never contacted');
return parts.join(' · ');
}

// Wraps avatarHtml with a click-to-zoom hook (same [data-view-photo] +
// openLightbox pattern the main connections list already uses) -- only
// when there's an actual photo to zoom into, since a blank initials
// circle has nothing to show.
function zoomableAvatarHtml(photoId, name, sizeClass) {
const html = avatarHtml(photoId, name, sizeClass);
if (!photoId) return html;
return `<span class="zoomable-avatar" data-view-photo="${escapeHtml(photoId)}">${html}</span>`;
}

// Ranks existing connections as candidates for "is this the same person".
// Two tiers, scored so exact/alias matches always outrank loose ones
// rather than needing to be kept in separate lists:
//  - 100: name (or a recorded "also known as") matches exactly, or the
//    extracted name is a bare first name that's a prefix of a fuller
//    stored name (a screenshot rarely has a surname).
//  - 40 minus 10 per edit: small spelling/transliteration drift on the
//    first name alone (e.g. Bumble's "Alena" vs a Ukrainian-convention
//    "Alona" for the same Cyrillic name) -- same tolerance already
//    proven in googlecontacts.js's widerNameCandidates.
// +20 if the connection is already tracked on this same platform (its
// primary app, or a recorded identity row for it) -- the user's own
// ranking ask: a same-platform exact match should beat a cross-platform
// one. Capped to the 5 closest total, same shape as widerNameCandidates,
// so a large connections list can't flood the review card the way an
// uncapped edit-distance pass once did (26 "matches" for one name).
function candidateExistingMatches(cand, app) {
const candKey = nameKey(cand.name);
if (!candKey) return [];
const candFirst = candKey.split(' ')[0];
const appKey = String(app || '').trim().toLowerCase();
const scored = [];
data.connections.forEach((c) => {
const cKey = nameKey(c.name);
let tier = 0; let viaAlias = '';
if (cKey && (cKey === candKey || cKey.startsWith(candKey + ' ') || candKey.startsWith(cKey + ' '))) {
tier = 100;
} else {
const aliasHit = (c.aliases || []).find((a) => nameKey(a) === candKey);
if (aliasHit) { tier = 100; viaAlias = aliasHit; }
}
if (!tier && candFirst.length >= 4) {
const cFirst = cKey.split(' ')[0];
if (cFirst.length >= 4) {
const d = editDistance(candFirst, cFirst, 2);
if (d <= 2) tier = 40 - d * 10;
}
}
if (!tier) return;
const samePlatform = !!appKey && (String(c.app || '').toLowerCase() === appKey
|| (c.identities || []).some((i) => String(i.platform || '').toLowerCase() === appKey));
scored.push({ c, score: tier + (samePlatform ? 20 : 0), viaAlias, samePlatform });
});
return scored
.sort((a, b) => b.score - a.score || String(b.c.createdAt || '').localeCompare(String(a.c.createdAt || '')))
.slice(0, 5);
}

// photoId is already a durably-stored photo by the time this renders (see
// queuePendingImport) -- same avatarHtml() every existing-connection avatar
// on this page already uses, rather than the special ObjectURL-from-Blob
// hydration the old ephemeral review list needed before photos were saved
// this early.
//
// Every option -- each possible match, "pick a different connection",
// "add as new", "skip" -- is one radio in a single visible list rather
// than hidden inside a <select>, so the photo, name and decision for a
// candidate all sit in the same row instead of the avatar strip and the
// dropdown text needing to be cross-referenced by eye. The new profile
// itself is shown first, since that's what's actually being decided on.
function candidateRowHtml(pendingId, idx, name, age, matches, extraDetail, photoId) {
const groupName = `decision-${pendingId}-${idx}`;
if (matches && matches.length > 0) {
const matchOptions = matches.map((m) => `
<label class="pending-option">
<input type="radio" name="${groupName}" value="update:${m.c.id}" data-decision="${idx}">
${zoomableAvatarHtml(m.c.photoId, m.c.name, 'sm')}
<span class="pending-option-info">
<strong>${escapeHtml(m.c.name)}</strong>
<span class="compare-caption">${escapeHtml(existingMatchCaption(m.c))}${m.viaAlias ? ` &middot; also known as "${escapeHtml(m.viaAlias)}"` : ''}${m.samePlatform ? ' &middot; same platform' : ''}</span>
</span>
</label>`).join('');
const tag = matches.length > 1 ? `${matches.length} possible matches` : '1 possible match';
return `<div class="candidate-row ambiguous" data-idx="${idx}">
<div class="pending-new">
${zoomableAvatarHtml(photoId, name, 'md')}
<div class="pending-new-info">
<div>${escapeHtml(name)}${age ? ', ' + escapeHtml(age) : ''} <span class="candidate-tag">${tag}</span></div>
${extraDetail ? `<div style="font-size:11px;color:var(--muted);">${escapeHtml(extraDetail)}</div>` : ''}
</div>
</div>
<div class="pending-options">
${matchOptions}
<label class="pending-option">
<input type="radio" name="${groupName}" value="pick" data-decision="${idx}">
<span class="pending-option-info">Different existing connection&hellip;</span>
</label>
<select class="decision-pick" data-pending-pick="${idx}" hidden><option value="">Choose&hellip;</option>${connectionOptionsHtml()}</select>
<label class="pending-option">
<input type="radio" name="${groupName}" value="new" data-decision="${idx}">
<span class="pending-option-info">Different person &mdash; add as new</span>
</label>
<label class="pending-option">
<input type="radio" name="${groupName}" value="skip" data-decision="${idx}" checked>
<span class="pending-option-info">Skip for now</span>
</label>
</div>
</div>`;
}
return `<label class="candidate-row" data-idx="${idx}">
<input type="checkbox" data-new-idx="${idx}" checked>
${avatarHtml(photoId, name, 'sm')}
<span>${escapeHtml(name)}${age ? ', ' + escapeHtml(age) : ''}${extraDetail ? `<br><span style="font-size:11px;color:var(--muted);">${escapeHtml(extraDetail)}</span>` : ''}</span>
<span class="candidate-tag">new</span>
</label>`;
}

// Keeps the "Add photos to…" picker in step with the connection list. The
// import box sits outside #connections-list so it isn't rebuilt by
// renderConnections' innerHTML assignment — it has to be refreshed here.
// Shared by every "pick a connection" dropdown in Dating admin (photo
// target, both merge slots) -- built once per render rather than once per
// select, and each select keeps its own previous value independently.
function connectionOptionsHtml() {
return [...data.connections]
.sort((a, b) => a.name.localeCompare(b.name))
.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}${displayAge(c) ? ', ' + escapeHtml(displayAge(c)) : ''}${c.app ? ' — ' + escapeHtml(c.app) : ''}</option>`)
.join('');
}

// Lets Capture Inbox's "Send selected to…" picker create the person on the
// spot instead of forcing a trip to the manual Add-connection form first
// before the photos have anywhere to go -- same "why is this an extra step"
// friction already fixed for screenshot+photo grouping. Minimal on purpose:
// just a name, same "Unnamed match"/thin-profile precedent
// addNewConnectionFromCandidate already uses for a screenshot-derived
// candidate -- everything else (app, stage, bio...) fills in later from the
// connection's own card, exactly as it would for any thin profile.
function createBlankConnection(name) {
const conn = blankConnection({ name: (name || '').trim() || 'Unnamed match', lastContact: todayStr() });
data.connections.push(conn);
queueSave();
renderConnections();
renderOverviewRef();
return conn;
}

function fillConnectionSelect(id, placeholder) {
const select = document.getElementById(id);
if (!select) return;
const previous = select.value;
select.innerHTML = `<option value="">${placeholder}</option>` + connectionOptionsHtml();
if ([...select.options].some((o) => o.value === previous)) select.value = previous;
}

function refreshPhotoTargets() {
fillConnectionSelect('photo-target-input', 'Add photos to&hellip;');
// Was per-card before (one "everyone else" dropdown rendered inside EVERY
// connection's Details) -- with a few hundred connections that's a few
// hundred times a few hundred options, most of them inside a closed
// <details> nobody was looking at. Two flat pickers here cost the same
// list built twice, not once per card.
fillConnectionSelect('merge-target-input', 'Keep this one&hellip;');
fillConnectionSelect('merge-source-input', 'Merge this one in&hellip;');
}

// Stores photos straight onto a connection with no API call. Most profile
// photos are just more pictures of someone already recorded, so paying to
// re-read fields you already have is pure waste — this is the same code path
// the per-connection gallery "+" uses, just reachable in bulk.
async function addPhotosWithoutParsing(files, status) {
const conn = data.connections.find((c) => c.id === document.getElementById('photo-target-input').value);
if (!conn) {
status.textContent = 'Pick who these photos belong to first.';
return;
}
if (!Array.isArray(conn.photoIds)) conn.photoIds = [];
const room = 12 - conn.photoIds.length;
if (room <= 0) {
status.textContent = `${conn.name} already has the maximum of 12 photos.`;
return;
}
status.textContent = `Adding ${Math.min(files.length, room)} photo${files.length === 1 ? '' : 's'} to ${conn.name}…`;
let added = 0;
let failed = 0;
for (const file of files.slice(0, room)) {
try {
const blob = await resizeImageToBlob(file, 900, 0.85);
const id = await storePhoto(blob);
conn.photoIds.push(id);
if (!conn.photoId) conn.photoId = id;
added++;
} catch (err) {
failed++;
console.error('Could not add photo:', err);
}
}
const skipped = files.length - Math.min(files.length, room);
status.textContent = `Added ${added} photo${added === 1 ? '' : 's'} to ${conn.name}, no AI used.`
+ (failed ? ` ${failed} couldn't be read.` : '')
+ (skipped ? ` ${skipped} skipped — 12 photo limit.` : '');
renderConnections();
queueSave();
}

// The source picked next to the import buttons, but only when it names an
// app whose layout the model can actually use as a hint.
function screenshotAppHint() {
const app = document.getElementById('import-app-input').value;
return SCREENSHOT_APPS.has(app) ? app : null;
}

function renderImportLastRun() {
const fileLine = document.getElementById('import-file-last-run');
const profileLine = document.getElementById('import-profile-last-run');
if (fileLine) fileLine.textContent = importStatusLine('screenshotMatches');
if (profileLine) profileLine.textContent = importStatusLine('screenshotProfile');
}

// The one place a raw extraction result becomes durable. Candidate photo
// Blobs are stored via storePhoto() right here -- BEFORE anything is
// rendered or the user gets a chance to navigate away -- and the pending
// import itself is pushed into data.pendingImports and saved immediately.
// Confirmed live as a real bug otherwise: a matches-list import that only
// existed as an in-memory array plus unsaved Blobs, referenced by a closure
// around the confirm button, "disappeared" before it could be reviewed --
// Android backgrounding the PWA tab is an unpredictable reload from this
// app's point of view, the same root cause already fixed for Capture Inbox
// and wellness extraction by storing first and processing after.
async function queuePendingImport({ candidates, kind, app, sourceLabel }) {
for (const cand of candidates) {
const blobs = kind === 'profile' ? (cand.photoBlobs || []) : (cand.photoBlob ? [cand.photoBlob] : []);
// Preserve any ids a caller already stored (e.g. loose photos ticked
// alongside this candidate's own screenshot -- see
// importProfileWithPhotosFile) rather than starting a fresh array, so
// the screenshot's own photo(s) land alongside them, not instead of them.
if (!Array.isArray(cand.photoIds)) cand.photoIds = [];
for (const blob of blobs) cand.photoIds.push(await storePhoto(blob));
delete cand.photoBlob;
delete cand.photoBlobs;
}
const pending = blankPendingImport({ kind, app: app || '', sourceLabel: sourceLabel || '', candidates });
data.pendingImports.push(pending);
queueSave();
renderPendingImports();
return pending;
}

// Shared by the manual "Import matches list" file input below and Capture
// Inbox's auto-detected/manual Bumble-screenshot paths (see
// autoRouteBumbleScreenshot in captureinbox.js) -- same extraction, same
// persisted review queue, same bookkeeping, regardless of how the
// screenshot arrived. statusEl is optional: Capture Inbox's auto-trigger
// has nowhere sensible to print interim status, so it just omits one.
async function importMatchesListFile(file, appHint, statusEl) {
if (statusEl) statusEl.textContent = 'Reading screenshot…';
const { candidates, truncated } = await extractMatchesFromScreenshot(file, appHint);
recordImportRun('screenshotMatches', { scope: appHint || 'matches list', count: candidates.length });
renderImportLastRun();
if (candidates.length === 0) {
if (statusEl) statusEl.textContent = 'No people found in that screenshot.';
return { candidates, truncated };
}
const truncatedNote = truncated ? ' (the screenshot had more people than fit in one response — the rest were skipped; try cropping the screenshot shorter and importing the remainder separately)' : '';
if (statusEl) statusEl.textContent = `Found ${candidates.length} ${candidates.length === 1 ? 'person' : 'people'}${truncatedNote} — review below:`;
await queuePendingImport({ candidates, kind: 'matches', app: appHint, sourceLabel: file.name || 'matches list' });
return { candidates, truncated };
}

// One person's name/label for a File or an array of Files (see
// extractProfileFromScreenshot -- several files can be combined into one
// profile when captured as native-resolution pieces rather than a single
// long stitched screenshot).
function screenshotSourceLabel(fileOrFiles) {
const files = Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles];
if (files.length === 1) return files[0].name || 'profile screenshot';
return `${files.length} screenshots (combined)`;
}

// One full profile per call, same shape used by the manual "Import profile
// screenshot(s)" input and by Capture Inbox's type-2 auto-route. `file`
// may be a single File, or an array when several native-resolution
// pieces of the same profile are being combined (see
// extractProfileFromScreenshot).
async function importProfileScreenshotFile(file, appHint, statusEl) {
if (statusEl) statusEl.textContent = 'Reading screenshot…';
let candidate;
try {
candidate = await extractProfileFromScreenshot(file, appHint);
} catch (err) {
console.error('Profile screenshot import failed:', err);
if (statusEl) statusEl.textContent = err instanceof MissingKeyError ? err.message : `Couldn't read that screenshot: ${err.message || err}`;
// Surfaced to the caller (not just written to statusEl and dropped) --
// extractDatingScreenshot needs to tell "genuinely didn't look like
// either shape" apart from "couldn't even attempt it" so it can show
// the real reason instead of a generic not-found message.
return { candidate: null, error: err };
}
const sourceLabel = screenshotSourceLabel(file);
recordImportRun('screenshotProfile', { scope: appHint || sourceLabel, count: 1 });
renderImportLastRun();
if (statusEl) statusEl.textContent = `Found a profile — review below:`;
await queuePendingImport({ candidates: [candidate], kind: 'profile', app: appHint, sourceLabel });
return { candidate };
}

// Same as importProfileScreenshotFile, but for when the screenshot was
// ticked together with loose photos of the same person -- the "tick who
// belongs together" convention Capture Inbox already uses for Send-to-
// connection. Those extra photos get cropped/stored the exact same way
// applyDirectProfileUpload already does for an EXISTING connection
// (contentCropBounds + cropToContentBlob, trimming letterbox bars rather
// than squashing to a fixed thumbnail), and attached to THIS candidate
// before it's queued, so confirming it creates the connection with every
// photo already on it -- no separate manual pass through Capture Inbox
// needed, matching what the pull-side combined upload could already do.
async function importProfileWithPhotosFile(file, appHint, extraFiles, statusEl) {
if (statusEl) statusEl.textContent = 'Reading screenshot…';
let candidate;
try {
candidate = await extractProfileFromScreenshot(file, appHint);
} catch (err) {
console.error('Profile screenshot import failed:', err);
if (statusEl) statusEl.textContent = err instanceof MissingKeyError ? err.message : `Couldn't read that screenshot: ${err.message || err}`;
return { candidate: null, error: err };
}
recordImportRun('screenshotProfile', { scope: appHint || file.name || 'profile screenshot', count: 1 });
renderImportLastRun();
candidate.photoIds = [];
for (const f of extraFiles) {
const img = await loadImage(f);
const bounds = contentCropBounds(img);
const blob = await cropToContentBlob(img, bounds, 0.85, 900);
if (blob) candidate.photoIds.push(await storePhoto(blob));
}
if (statusEl) statusEl.textContent = `Found a profile with ${extraFiles.length} extra photo${extraFiles.length === 1 ? '' : 's'} — review below:`;
await queuePendingImport({ candidates: [candidate], kind: 'profile', app: appHint, sourceLabel: file.name || 'profile screenshot' });
return { candidate };
}

// Capture Inbox's "Extract dating screenshot" button, for an explicit,
// deliberate user action -- unlike autoRouteBumbleScreenshot (captureinbox.js's
// unconfirmed auto-trigger, deliberately gated by a cheap Haiku pre-scan
// since it fires with no confirmation), this composes the SAME two
// functions the Dating-admin "Import matches list" and "Import profile
// screenshot(s)" buttons already call directly, with no classifier in
// between deciding which one to even attempt. Confirmed live as a real
// bug this replaces: a Bumble "Chats" screen (several people, each row
// showing a message preview) succeeded via "Import matches list" directly
// -- extractMatchesFromScreenshot is explicitly built to read a message-
// preview row as someone you're "Chatting in app" with -- but the 4-way
// Haiku pre-scan gating the auto-detecting path only sees "chat" (singular)
// as a bucket distinct from "matches" (a list), misrouted it, and rejected
// the screenshot before the real extraction ever ran. Trying the matches
// extraction first and accepting any candidates found, exactly matching
// that button's own success condition, removes the extra unreliable layer
// entirely rather than trying to make it smarter.
async function extractDatingScreenshot(file, appHint, extraFiles, statusEl) {
const matchesResult = await importMatchesListFile(file, appHint, statusEl);
if (matchesResult.candidates.length > 0) return { kind: 'matches', ...matchesResult };
const profileResult = (extraFiles && extraFiles.length)
? await importProfileWithPhotosFile(file, appHint, extraFiles, statusEl)
: await importProfileScreenshotFile(file, appHint, statusEl);
return { kind: profileResult.candidate ? 'profile' : null, ...profileResult };
}

function initImport() {
const status = document.getElementById('import-status');
renderImportLastRun();
renderPendingImports();

document.getElementById('photo-only-input').addEventListener('change', async (e) => {
const files = Array.from(e.target.files);
e.target.value = '';
if (files.length === 0) return;
await addPhotosWithoutParsing(files, status);
});

document.getElementById('import-file-input').addEventListener('change', async (e) => {
const file = e.target.files[0];
if (!file) return;
await withImportStatus(status, () => importMatchesListFile(file, screenshotAppHint(), status));
e.target.value = '';
});

document.getElementById('import-profile-input').addEventListener('change', async (e) => {
const files = Array.from(e.target.files);
if (files.length === 0) return;
const combine = files.length > 1 && document.getElementById('import-profile-combine').checked;
const appHint = screenshotAppHint();
if (combine) {
// Several native-resolution pieces of ONE profile (see
// extractProfileFromScreenshot) -- one merged candidate, not one per
// file the way the default multi-select below works.
status.textContent = `Reading ${files.length} pieces of one profile…`;
await withImportStatus(status, async () => {
const { candidate } = await importProfileScreenshotFile(files, appHint, null);
status.textContent = candidate ? 'Found a profile — review below:' : "Couldn't read those screenshots — see console.";
});
e.target.value = '';
return;
}
status.textContent = `Reading ${files.length} profile screenshot${files.length === 1 ? '' : 's'}…`;
await withImportStatus(status, async () => {
let done = 0, failed = 0;
for (const f of files) {
const { candidate } = await importProfileScreenshotFile(f, appHint, null);
if (candidate) done++; else failed++;
}
status.textContent = `Found ${done} profile${done === 1 ? '' : 's'}${failed ? ` (${failed} unreadable — see console)` : ''}${done ? ' — review below:' : '.'}`;
});
e.target.value = '';
});

// Delegated once, on the (never-destroyed) list container itself -- every
// renderPendingImports() call rebuilds its innerHTML, but confirm/discard
// buttons inside it are re-generated content, not stable elements, so a
// listener bound directly to a button would need re-binding after every
// render. Same pattern captureinbox.js/health.js already use for their own
// repeatedly-rebuilt lists.
const candidateList = document.getElementById('candidate-list');
if (candidateList) {
candidateList.addEventListener('click', async (e) => {
const confirmBtn = e.target.closest('[data-confirm-pending]');
if (confirmBtn) { await confirmPendingImport(confirmBtn.dataset.confirmPending); return; }
const discardBtn = e.target.closest('[data-discard-pending]');
if (discardBtn) { await discardPendingImport(discardBtn.dataset.discardPending); return; }
const zoom = e.target.closest('[data-view-photo]');
if (zoom) {
const url = await photoUrl(zoom.dataset.viewPhoto);
if (url) openLightbox(url);
}
});
// Reveals the "choose a connection" picker only while its own "pick"
// radio is the checked one in that candidate's group -- every other
// radio in the group (including "skip") hides it again.
candidateList.addEventListener('change', (e) => {
const radio = e.target.closest('input[type=radio][data-decision]');
if (!radio) return;
// candidate indices reset to 0 per card, so the picker lookup has to
// stay scoped to this radio's own card -- a global lookup would grab
// index 0's picker in a DIFFERENT pending-import card if more than one
// is on screen at once.
const card = radio.closest('[data-pending-import]');
const picker = card && card.querySelector(`[data-pending-pick="${radio.dataset.decision}"]`);
if (picker) picker.hidden = radio.value !== 'pick';
});
}
}

// Renders every entry in data.pendingImports as its own reviewable card --
// N cards, not one ephemeral list, since the queue can now hold as many
// pending screenshots as piled up (the old single-slot ephemeral version
// could only ever hold one, which is exactly the state a second successful
// extraction used to silently clobber). Candidate photos are already
// durably stored by the time this runs (see queuePendingImport), so this
// is one hydratePhotoBackgrounds() pass same as everywhere else in the app
// -- no special ObjectURL-from-Blob handling needed any more.
async function renderPendingImports() {
const candidateList = document.getElementById('candidate-list');
if (!candidateList) return;
candidateList.innerHTML = data.pendingImports.map((p) => {
const isProfile = p.kind === 'profile';
const rows = p.candidates.map((cand, idx) => {
const matches = candidateExistingMatches(cand, p.app);
const extra = isProfile
? [cand.age, cand.height, cand.location, cand.job, cand.education, (cand.languages || []).join('/'), cand.bio].filter(Boolean).join(' · ')
: (cand.stage ? `Detected stage: ${cand.stage}` : '');
return candidateRowHtml(p.id, idx, cand.name, cand.age, matches, extra, (cand.photoIds || [])[0] || null);
}).join('');
const when = new Date(p.createdAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
return `<div class="alloc-card" data-pending-import="${p.id}">
<div class="alloc-title">${escapeHtml(isProfile ? 'Profile' : 'Matches list')}</div>
<div class="alloc-notes">${escapeHtml(p.app || 'unknown app')} &middot; ${escapeHtml(p.sourceLabel)} &middot; ${escapeHtml(when)}</div>
<div class="candidate-list" style="margin-top:8px;">${rows}</div>
<div class="alloc-controls">
<button class="add-btn" type="button" data-confirm-pending="${p.id}">Add / update selected</button>
<button class="del-x" type="button" data-discard-pending="${p.id}">Discard</button>
</div>
</div>`;
}).join('');
await hydratePhotoBackgrounds(candidateList);
}

async function confirmPendingImport(id) {
const pending = data.pendingImports.find((p) => p.id === id);
const card = document.querySelector(`[data-pending-import="${id}"]`);
if (!pending || !card) return;
const isProfile = pending.kind === 'profile';
const app = pending.app || document.getElementById('import-app-input').value;
let addedCount = 0, updatedCount = 0;

for (const cb of card.querySelectorAll('input[data-new-idx]:checked')) {
const cand = pending.candidates[parseInt(cb.dataset.newIdx, 10)];
await addNewConnectionFromCandidate(cand, app, isProfile);
addedCount++;
}
for (const radio of card.querySelectorAll('input[type=radio][data-decision]:checked')) {
const idx = radio.dataset.decision;
const cand = pending.candidates[parseInt(idx, 10)];
let value = radio.value;
if (value === 'pick') {
const picker = card.querySelector(`select[data-pending-pick="${idx}"]`);
value = picker && picker.value ? `update:${picker.value}` : 'skip';
}
if (value.startsWith('update:')) {
const existing = data.connections.find((c) => c.id === value.slice(7));
if (existing) {
await applyCandidateUpdate(existing, cand, isProfile, app);
updatedCount++;
}
} else if (value === 'new') {
await addNewConnectionFromCandidate(cand, app, isProfile);
addedCount++;
}
}

data.pendingImports = data.pendingImports.filter((p) => p.id !== id);
renderPendingImports();
const status = document.getElementById('import-status');
if (status) status.textContent = `Added ${addedCount}, updated ${updatedCount}.`;
renderConnections();
renderOverviewRef();
queueSave();
}

async function discardPendingImport(id) {
const pending = data.pendingImports.find((p) => p.id === id);
if (!pending) return;
const count = pending.candidates.length;
if (!confirm(`Discard this ${pending.kind === 'profile' ? 'profile' : 'matches list'} import (${count} ${count === 1 ? 'person' : 'people'})? This deletes ${count === 1 ? 'their' : 'their'} photo${count === 1 ? '' : 's'} too.`)) return;
for (const cand of pending.candidates) {
for (const pid of cand.photoIds || []) {
try { await photoDelete(pid); } catch (err) { /* already gone */ }
}
}
data.pendingImports = data.pendingImports.filter((p) => p.id !== id);
renderPendingImports();
queueSave();
}

async function addNewConnectionFromCandidate(cand, app, isProfile) {
// photoIds are already durable by this point -- storePhoto() ran back in
// queuePendingImport(), right after extraction, not here. See its own
// comment for why that timing matters (a Blob only stored at confirm time
// is exactly the state that got lost when a review queue sat unreviewed).
const photoIds = cand.photoIds || [];
const photoId = photoIds[0] || null;
// profileName records what the app called them, so renaming the
// connection to their real name later doesn't orphan the photos. Falls
// back to a placeholder rather than null/'' -- a nameless connection
// isn't just cosmetically odd, every later screenshot import scans
// every existing connection by name (see renderPendingImports below)
// and a non-string name there crashes ALL future imports, not just
// this one (confirmed live: a Bumble matches-list row with no readable
// name broke every screenshot import after it until the record was
// found and fixed).
const conn = blankConnection({
name: cand.name || 'Unnamed match', profileName: cand.name || '', app, stage: cand.stage || 'Matched', lastContact: todayStr(),
photoId, photoIds, age: cand.age || '', location: cand.location ? [cand.location] : [], kids: cand.kids || '', job: cand.job || '',
height: cand.height || '', education: cand.education || '',
});
data.connections.push(conn);
upsertIdentity(conn, { platform: app, handle: cand.name });
// A profile screenshot (not a bare matches-list one) carries bio/
// languages/nationality/interests/lookingFor/drinking/smoking too --
// same fields an update to an EXISTING connection already picks up via
// applyCandidateUpdate's isProfile branch. This is the "new connection"
// counterpart, so a brand-new person parsed from a profile screenshot no
// longer loses everything beyond the handful of scalar fields above.
if (isProfile) applyProfileFieldsToConnection(conn, cand);
}

// location deliberately excluded -- it's a TAG_FIELDS member now (see
// state.js), so mergeConnectionInto's TAG_FIELDS.forEach loop below
// already unions it same as Interests/Languages/etc.
const SCALAR_MERGE_FIELDS = ['age', 'kids', 'job', 'height', 'education', 'likes', 'driveLink'];

// Adds anything in `values` that isn't already there, case-insensitively, so
// merging "English" into ["english"] doesn't produce a near-duplicate chip.
function unionInto(targetArr, values) {
const seen = new Set(targetArr.map((v) => String(v).trim().toLowerCase()));
(values || []).forEach((v) => {
const key = String(v).trim().toLowerCase();
if (!key || seen.has(key)) return;
seen.add(key);
targetArr.push(v);
});
}

// Folds `source` into `target` field by field, so a duplicate is never a
// pick-one-and-lose-the-rest choice. Scalars only fill gaps — `target` is the
// record being kept, so its values win wherever both sides have one — while
// arrays, notes, photos, to-dos and ratings accumulate. Caller removes
// `source` afterwards; note its photo blobs are deliberately NOT deleted,
// since `target` now references them.
function mergeConnectionInto(target, source) {
SCALAR_MERGE_FIELDS.forEach((k) => {
if (!String(target[k] || '').trim() && String(source[k] || '').trim()) target[k] = source[k];
});
TAG_FIELDS.forEach(({ field }) => {
if (!Array.isArray(target[field])) target[field] = [];
unionInto(target[field], source[field]);
});
const sourceNotes = String(source.notes || '').trim();
const targetNotes = String(target.notes || '').trim();
if (sourceNotes && sourceNotes !== targetNotes) {
target.notes = targetNotes ? `${targetNotes}\n${sourceNotes}` : sourceNotes;
}
// Structured field, not a TAG_FIELDS member, so the plain-string union
// loop above doesn't touch it -- reuse upsertIdentity's own fill-gaps
// rule so a same-platform row on each side merges into one rather than
// leaving two rows for what's really the same account.
(source.identities || []).forEach((r) => upsertIdentity(target, { platform: r.platform, handle: r.handle, matchId: r.matchId }));
if (!Array.isArray(target.photoIds)) target.photoIds = [];
(source.photoIds || []).forEach((pid) => { if (!target.photoIds.includes(pid)) target.photoIds.push(pid); });
if (!target.photoId) target.photoId = target.photoIds[0] || null;
if (!Array.isArray(target.todos)) target.todos = [];
(source.todos || []).forEach((t) => {
if (!target.todos.some((x) => x.text.trim().toLowerCase() === String(t.text).trim().toLowerCase())) target.todos.push(t);
});
if (!target.ratings) target.ratings = {};
data.ratingCategories.forEach(({ field }) => {
if (!target.ratings[field] && source.ratings && source.ratings[field]) target.ratings[field] = source.ratings[field];
});
if (!target.priority && source.priority) target.priority = source.priority;
if ((STAGE_RANK[source.stage] ?? 0) > (STAGE_RANK[target.stage] ?? 0)) target.stage = source.stage;
// Keep whichever contact is more recent — merging two records shouldn't
// make someone look staler than they actually are and trigger a false
// "reach out" nudge.
if (source.lastContact && (!target.lastContact || source.lastContact > target.lastContact)) target.lastContact = source.lastContact;
}

// Tinder appends " (shared)" to an interest it says you both have --
// stripSharedSuffix already exists so a flag rule listing "Hiking" matches
// either spelling, but the STORED value used to keep the literal
// "Hiking (shared)" text forever, showing up verbatim everywhere interests
// render. Trimmed before storing now; a genuinely shared one (the suffix
// was actually present, not just absent) is also folded into the
// interests flag rule's green list -- Tinder is telling you this is a real
// positive signal, the same as any other confirmed-good match criterion.
const SHARED_INTEREST_RE = /\(shared\)\s*$/i;
function markInterestGreen(cleanValue) {
if (!cleanValue) return;
let rule = data.flagRules.find((r) => r.field === 'interests');
if (!rule) {
rule = { id: 'default-interests-shared', field: 'interests', green: [], amber: [], red: [] };
data.flagRules.push(rule);
if (!data.flagRulesSeeded.includes(rule.id)) data.flagRulesSeeded.push(rule.id);
}
if (!Array.isArray(rule.green)) rule.green = [];
if (!Array.isArray(rule.amber)) rule.amber = [];
if (!Array.isArray(rule.red)) rule.red = [];
const norm = stripSharedSuffix(cleanValue).toLowerCase();
const alreadyColored = [...rule.green, ...rule.amber, ...rule.red]
.some((v) => stripSharedSuffix(v).toLowerCase() === norm);
// Never overrides a color the user already picked by hand -- this only
// fills in a fresh interest that isn't colored anywhere yet.
if (!alreadyColored) rule.green.push(cleanValue);
}
function processIncomingInterest(raw) {
const wasShared = SHARED_INTEREST_RE.test(String(raw || ''));
const clean = stripSharedSuffix(raw);
if (wasShared && clean) markInterestGreen(clean);
return clean;
}

// Everything a PROFILE screenshot/scrape can add beyond the basic scalar
// fields (bio, languages, nationality, interests, relationship-goal tag,
// drinking/smoking) -- shared by both the "update an existing connection"
// and "create a brand new one from this screenshot" paths, so a new
// connection no longer loses fields an update of the same screenshot would
// have kept (confirmed real: addNewConnectionFromCandidate used to skip
// this whole block entirely).
function applyProfileFieldsToConnection(existing, cand) {
const bio = String(cand.bio || '').trim();
const notes = String(existing.notes || '').trim();
if (bio && bio !== notes) existing.notes = notes ? `${notes}\n${bio}` : bio;
unionInto(existing.languages, cand.languages);
unionInto(existing.nationality, cand.nationality);
if (!Array.isArray(existing.interests)) existing.interests = [];
unionInto(existing.interests, (cand.interests || []).map(processIncomingInterest).filter(Boolean));
// "Looking for" is Bumble/Tinder's own relationship-goal question --
// TAG_FIELDS' relationshipTags, same field the Tinder console-snippet
// importer's Orientation/"Relationship type"/"Looking for" chip already
// writes into.
if (!Array.isArray(existing.relationshipTags)) existing.relationshipTags = [];
unionInto(existing.relationshipTags, cand.lookingFor ? [cand.lookingFor] : []);
// Own fields now (see blankConnection in state.js), captured verbatim --
// "Trying to quit" or "Socially, at the weekend" stores as exactly that,
// rather than being squeezed into a fixed Yes/No vocabulary that couldn't
// represent it. Fill-if-empty, same rule SCALAR_MERGE_FIELDS' own fields
// already follow: what you typed yourself outranks a re-scrape.
if (!String(existing.drinking || '').trim() && String(cand.drinking || '').trim()) existing.drinking = cand.drinking.trim();
if (!String(existing.smoking || '').trim() && String(cand.smoking || '').trim()) existing.smoking = cand.smoking.trim();
}

async function applyCandidateUpdate(existing, cand, isProfile, app) {
// photoIds are already durable -- see addNewConnectionFromCandidate's own
// comment on why this reads them rather than storing Blobs here.
for (const pid of cand.photoIds || []) {
existing.photoIds.push(pid);
if (!existing.photoId) existing.photoId = pid;
}
upsertIdentity(existing, { platform: app, handle: cand.name });
// Same merge semantics as mergeConnectionInto: fill gaps, never overwrite.
// What you typed yourself outranks what a model read off a screenshot.
const incoming = {
age: cand.age, job: cand.job, kids: cand.kids,
height: cand.height, education: cand.education,
};
SCALAR_MERGE_FIELDS.forEach((k) => {
if (!String(existing[k] || '').trim() && String(incoming[k] || '').trim()) existing[k] = incoming[k];
});
// location is a TAG_FIELDS member (multi-value) -- cand.location is still
// a single AI best-guess (a screenshot shows one thing), unioned in as one
// candidate value rather than fill-if-empty overwriting the whole array.
if (!Array.isArray(existing.location)) existing.location = [];
unionInto(existing.location, cand.location ? [cand.location] : []);
if (isProfile) applyProfileFieldsToConnection(existing, cand);
// Only move the stage forward, never back — a screenshot re-import
// shouldn't undo progress you've logged manually since (e.g. re-scanning
// an old "New Matches" screenshot after you've already met up).
if (cand.stage && (STAGE_RANK[cand.stage] ?? 0) > (STAGE_RANK[existing.stage] ?? 0)) {
existing.stage = cand.stage;
}
// A screenshot of an open chat is direct evidence you were in contact —
// re-importing one used to leave lastContact untouched, so re-scanning a
// WhatsApp/chat screenshot never cleared a "reach out" nudge even though
// the screenshot itself was proof you just had. Only "today" is known
// here, not when the screenshot was actually taken.
if (cand.stage === 'Chatting in app') existing.lastContact = todayStr();
}

// Combined upload scoped to ONE connection -- no match-selection dropdown,
// since the target is already known. Accepts individual photos and/or a
// composite profile screenshot together in one picker: each file is
// classified by its CONTENT aspect ratio (classifyProfileUpload, which
// trims letterbox/pillarbox bars first) into a photo (direct local
// resize+save, no AI) or a screenshot (banded AI parse). Both buckets fire
// concurrently -- neither waits on the other -- and the "how many full-res
// photos came in this batch" count is known synchronously from the file
// list itself, not from whichever finishes first, so the AI parse's photo
// crops can skip that many up front: no low-res duplicate ever sits next
// to a full-res photo of the same picture.
// `onStatus`, if given, replaces the two default status writes below --
// lets a caller with no `#parse-profile-status-${connId}` element in the
// DOM (the Capture Inbox triage card, which isn't a connection card) get
// the same progress/result text through its own UI instead.
async function applyDirectProfileUpload(files, connId, { onStatus } = {}) {
const conn = data.connections.find((c) => c.id === connId);
const report = onStatus || ((msg) => {
const el = document.getElementById(`parse-profile-status-${connId}`);
if (el) el.textContent = msg;
});
if (!conn || !files.length) return;
report(`Reading ${files.length} file${files.length === 1 ? '' : 's'}…`);
try {
const classified = await Promise.all(files.map(async (f) => ({ f, ...(await classifyProfileUpload(f)) })));
const photoItems = classified.filter((c) => !c.isScreenshot);
const screenshotItems = classified.filter((c) => c.isScreenshot);
const skipCount = photoItems.length;

const [photoIds, screenshotResults] = await Promise.all([
Promise.all(photoItems.map(({ img, bounds }) => cropToContentBlob(img, bounds, 0.85, 900).then((b) => (b ? storePhoto(b) : null)))),
Promise.all(screenshotItems.map(({ f }) => extractProfileFromScreenshot(f, conn.app).catch((err) => { console.error('Profile parse failed:', err); return null; }))),
]);

photoIds.filter(Boolean).forEach((id) => {
if (!conn.photoIds.includes(id)) conn.photoIds.push(id);
});
if (!conn.photoId) conn.photoId = conn.photoIds[0] || null;

let parsedCount = 0;
for (const cand of screenshotResults) {
if (!cand) continue;
// applyCandidateUpdate now expects durable photoIds, not Blobs -- see its
// own comment (same fix as the pendingImports queue: store as soon as the
// bytes exist, not deferred until some later confirm step).
const blobs = (cand.photoBlobs || []).slice(skipCount);
cand.photoIds = [];
for (const blob of blobs) cand.photoIds.push(await storePhoto(blob));
await applyCandidateUpdate(conn, cand, true, conn.app);
parsedCount++;
}
recordImportRun('directProfileUpload', { scope: conn.name, count: photoIds.filter(Boolean).length + parsedCount });
const message = `Added ${photoIds.filter(Boolean).length} photo${photoIds.filter(Boolean).length === 1 ? '' : 's'}${parsedCount ? `, parsed ${parsedCount} screenshot${parsedCount === 1 ? '' : 's'}` : ''}.`;
renderConnections();
renderOverviewRef();
queueSave();
// After renderConnections(), not before -- it redraws this whole card
// (fresh, empty status span included), and report()'s default branch
// re-queries the DOM by id on every call rather than closing over a
// stale element, so this still lands correctly.
report(message);
} catch (err) {
console.error('Direct profile upload failed:', err);
report(err instanceof MissingKeyError ? 'Add an Anthropic API key in Settings first.' : `Couldn't read that: ${err.message || err}`);
}
}

function expandConnection(id) {
expandedConnections.add(id);
renderConnections();
}

export {
renderConnections, initConnectionForm, expandConnection, CONN_STAGES,
initSensitiveFields, setShowSensitiveFields, visibleTagFields,
filterByEmptyField, filterBySearch, filterByIds, clearFilters,
STAGE_RANK, setContactPicker, phoneWithFlagHtml, initRatingCategoriesSettings,
initFlagRulesSettings, unionInto, initHideArchivedFaded,
connectionOptionsHtml, applyDirectProfileUpload, applyProfileFieldsToConnection,
importMatchesListFile, importProfileScreenshotFile, importProfileWithPhotosFile, extractDatingScreenshot, renderPendingImports,
createBlankConnection,
};
