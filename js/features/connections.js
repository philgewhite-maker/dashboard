import { data, queueSave, reachOutThreshold, isDormantStage, getLocalSettings, TAG_FIELDS, CONTACT_STATUS_LABELS } from '../state.js';
import { photoPut, photoDelete, photoUrl } from '../db.js';
import {
uid, todayStr, daysSince, escapeHtml, avatarHtml, hydratePhotos, scrollAndFlash, bindForm,
resizeImageToBlob,
} from '../utils.js';
import { MissingKeyError, extractMatchesFromScreenshot, extractProfileFromScreenshot } from '../ai.js';

const CONN_STAGES = ['Superswiped', 'Matched', 'Chatting in app', 'Moved to WhatsApp', 'Moved to Telegram', 'Arranged to meet', 'Met in person', 'Dating', 'Faded', 'Archived'];
const STAGE_RANK = { Dating: 8, 'Met in person': 7, 'Arranged to meet': 6, 'Moved to Telegram': 5, 'Moved to WhatsApp': 4, 'Chatting in app': 3, Matched: 2, Superswiped: 1, Faded: 0, Archived: 0 };
const RATING_CATS = [['looks', 'Looks'], ['intelligence', 'Intelligence'], ['figure', 'Figure'], ['humour', 'Humour'], ['sex', 'Sex'], ['practicality', 'Practicality']];
// Where a connection came from. Rendered into every source dropdown from
// here so the add form, the import picker, and the per-connection editor
// can't drift apart.
const CONN_APPS = ['Bumble', 'Tinder', 'Hinge', 'WhatsApp', 'Telegram', 'Instagram', 'Real life', 'Other'];
// Sources that are an actual app with a recognisable screenshot layout —
// worth naming in the vision prompt. "Real life"/"Other" describe how you
// met, not a UI, so they're deliberately left out of that hint.
const SCREENSHOT_APPS = new Set(['Bumble', 'Tinder', 'Hinge', 'WhatsApp', 'Telegram', 'Instagram']);

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

function dialCodeOptions() {
return '<option value="">Country code…</option>' + DIAL_CODES
.map(([iso, dial, name]) => `<option value="${dial}">${flagEmoji(iso)} ${dial} — ${escapeHtml(name)}</option>`)
.join('');
}

let connectionSearchTerm = '';
let connectionSortPrimary = 'default';
let connectionSortSecondary = 'none';
// Set by the "None" chips in Connections Overview: {field, label}. Kept
// separate from the text search because "has nothing in this field" isn't
// something a substring match can express.
let emptyFieldFilter = null;
const expandedConnections = new Set();

// Works for both the array tag fields and the plain text ones (location,
// education), so one "None" chip implementation covers every dimension.
function isFieldEmpty(c, field) {
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

const SORT_FIELDS = {
default: { getValue: (c) => (isDormantStage(c.stage) ? -999 : daysSince(c.lastContact) - reachOutThreshold(c.priority)) },
priority: { getValue: (c) => c.priority || 0 },
looks: { getValue: (c) => (c.ratings && c.ratings.looks) || 0 },
intelligence: { getValue: (c) => (c.ratings && c.ratings.intelligence) || 0 },
figure: { getValue: (c) => (c.ratings && c.ratings.figure) || 0 },
humour: { getValue: (c) => (c.ratings && c.ratings.humour) || 0 },
sex: { getValue: (c) => (c.ratings && c.ratings.sex) || 0 },
practicality: { getValue: (c) => (c.ratings && c.ratings.practicality) || 0 },
contact: { getValue: (c) => daysSince(c.lastContact) },
stage: { getValue: (c) => STAGE_RANK[c.stage] ?? 0 },
};

function ageDecade(age) {
const n = parseInt(age, 10);
if (isNaN(n)) return null;
return `${Math.floor(n / 10) * 10}s`;
}

function ratingStars(label, cat, connId, value) {
const stars = [1, 2, 3, 4, 5].map((n) => `<svg class="star rate-star ${n <= value ? 'filled' : ''}" data-rate-conn="${connId}" data-rate-cat="${cat}" data-rate-star="${n}" viewBox="0 0 20 20" fill="currentColor"><path d="M10 1l2.6 5.9 6.4.6-4.8 4.3 1.4 6.2L10 14.9 4.4 18l1.4-6.2L1 7.5l6.4-.6z"/></svg>`).join('');
return `<div class="rating-row"><span class="rating-label">${escapeHtml(label)}</span><div class="stars">${stars}</div></div>`;
}

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
return (items || []).map((t, i) => `<span class="tag-chip">${escapeHtml(t)}<span class="tag-x" data-tag-remove="${connId}" data-tag-field="${field}" data-tag-idx="${i}">&times;</span></span>`).join('')
+ `<input type="text" class="tag-add-input" placeholder="+ add" list="taglist-${field}" data-tag-add="${connId}" data-tag-field="${field}">`
+ `<button type="button" class="todo-add-btn" data-tag-add-btn="${connId}" data-tag-add-btn-field="${field}" style="padding:3px 8px;">+</button>`;
}

function galleryHtml(c) {
const thumbs = (c.photoIds || []).map((id, i) => `<div class="gallery-thumb"><span class="thumb-img" data-photo-id="${escapeHtml(id)}" data-view-photo="${escapeHtml(id)}"></span><span class="tag-x" data-photo-remove="${c.id}" data-photo-idx="${i}">&times;</span></div>`).join('');
return `<div class="photo-gallery">${thumbs}<label class="gallery-add" for="photo-add-${c.id}">+</label><input type="file" id="photo-add-${c.id}" accept="image/*" multiple style="display:none;" data-photo-add="${c.id}"></div>`;
}

function todoListHtml(c) {
const items = (c.todos || []).map((t) => `<div class="todo-item ${t.done ? 'done' : ''}"><input type="checkbox" ${t.done ? 'checked' : ''} data-todo-toggle="${c.id}" data-todo-id="${t.id}"><span>${escapeHtml(t.text)}</span><span class="tag-x" data-todo-remove="${c.id}" data-todo-id="${t.id}">&times;</span></div>`).join('');
return `<div class="todo-list">${items}</div>
<div class="todo-add-row">
<input type="text" placeholder="e.g. Theatre trip" data-todo-input="${c.id}">
<button class="todo-add-btn" type="button" data-todo-add="${c.id}">Add</button>
</div>`;
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

function renderConnections() {
const list = document.getElementById('connections-list');
document.getElementById('connections-count').textContent = data.connections.length + (data.connections.length === 1 ? ' connection' : ' connections');
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
: missing.map(connectionCardHtml).join(''))
+ tagDatalistsHtml();
document.getElementById('clear-empty-filter').addEventListener('click', () => {
emptyFieldFilter = null;
renderConnections();
});
hydratePhotos(list);
bindConnectionEvents(list);
refreshPhotoTargets();
return;
}

if (idFilter) {
const picked = data.connections.filter((c) => idFilter.ids.has(c.id));
list.innerHTML = `<div class="filter-banner">${picked.length} matching ${escapeHtml(idFilter.label)} <button class="filter-clear" type="button" id="clear-id-filter">Clear</button></div>`
+ (picked.length === 0 ? '<div class="empty">Nobody matches all of those.</div>' : picked.map(connectionCardHtml).join(''))
+ tagDatalistsHtml();
document.getElementById('clear-id-filter').addEventListener('click', () => { idFilter = null; renderConnections(); });
hydratePhotos(list);
bindConnectionEvents(list);
refreshPhotoTargets();
return;
}

const term = connectionSearchTerm.trim().toLowerCase();
const filtered = term ? data.connections.filter((c) => {
const haystack = [
c.name, c.location, c.job, c.education, c.stage, ageDecade(c.age),
// So the Connections Overview "Contact match" chips actually filter —
// they search by their own label, which otherwise matches nothing.
CONTACT_STATUS_LABELS[c.contactStatus],
// Hidden sensitive fields stay out of the haystack too — otherwise
// searching could surface a row *because* of a field you've chosen
// not to display, with no visible reason why it matched.
...visibleTagFields().flatMap((f) => c[f.field] || []),
].filter(Boolean).join(' ').toLowerCase();
return haystack.includes(term);
}) : data.connections;

if (filtered.length === 0) {
list.innerHTML = '<div class="empty">No connections match that search.</div>';
return;
}

const primary = SORT_FIELDS[connectionSortPrimary] || SORT_FIELDS.default;
const secondary = SORT_FIELDS[connectionSortSecondary];
const sorted = [...filtered].sort((a, b) => {
const diff = primary.getValue(b) - primary.getValue(a);
if (diff !== 0 || !secondary) return diff;
return secondary.getValue(b) - secondary.getValue(a);
});

list.innerHTML = sorted.map(connectionCardHtml).join('') + tagDatalistsHtml();

hydratePhotos(list);
bindConnectionEvents(list);
refreshPhotoTargets();
}

function connectionCardHtml(c) {
const since = daysSince(c.lastContact);
const overdue = !isDormantStage(c.stage) && since >= reachOutThreshold(c.priority);
const stars = [1, 2, 3, 4, 5].map((n) => `<svg class="star priority-star ${n <= c.priority ? 'filled' : ''}" data-conn="${c.id}" data-star="${n}" viewBox="0 0 20 20" fill="currentColor"><path d="M10 1l2.6 5.9 6.4.6-4.8 4.3 1.4 6.2L10 14.9 4.4 18l1.4-6.2L1 7.5l6.4-.6z"/></svg>`).join('');
const nameMeta = [c.age, c.location].map((s) => String(s || '').trim()).filter(Boolean).join(' · ');
return `<div class="match-card" data-conn-row="${c.id}">
<div class="match-row">
${avatarHtml(c.photoId, c.name)}
<div class="match-id">
<div class="match-name">${escapeHtml(c.name)}${nameMeta ? ` <span class="match-meta">${escapeHtml(nameMeta)}</span>` : ''}</div>
<div class="app-tag">${escapeHtml(c.app)}</div>
</div>
<div class="stars">${stars}</div>
<div class="match-stage">
<select data-conn-stage="${c.id}">
${CONN_STAGES.map((s) => `<option value="${s}" ${s === c.stage ? 'selected' : ''}>${s}</option>`).join('')}
</select>
</div>
<div class="match-actions">
${c.contactStatus ? `<span class="contact-badge ${escapeHtml(c.contactStatus)}">${escapeHtml(CONTACT_STATUS_LABELS[c.contactStatus] || '')}</span>` : ''}
<span class="match-contact">${since === 0 ? 'today' : since + 'd since contact'}</span>
${overdue ? '<span class="reach-badge">Reach out</span>' : ''}
<button class="log-btn" data-log="${c.id}">Log contact</button>
<span class="del-x" style="opacity:1;" data-del-conn="${c.id}">&times;</span>
</div>
</div>
${contactPickerHtml(c.id)}
<details class="match-details" data-conn-details="${c.id}" ${expandedConnections.has(c.id) ? 'open' : ''}>
<summary>Details</summary>
<div class="details-grid">
<label>Name<input type="text" data-field="name" data-conn-detail="${c.id}" value="${escapeHtml(c.name)}"></label>
<label>Profile name<input type="text" placeholder="If different — keeps photos findable" data-field="profileName" data-conn-detail="${c.id}" value="${escapeHtml(c.profileName || '')}"></label>
<label>Source<select data-field="app" data-conn-detail="${c.id}">${appOptions(c.app)}</select></label>
<label>Age<input type="text" data-field="age" data-conn-detail="${c.id}" value="${escapeHtml(c.age || '')}"></label>
<label>Location<input type="text" data-field="location" data-conn-detail="${c.id}" value="${escapeHtml(c.location || '')}"></label>
<label>Kids<input type="text" data-field="kids" data-conn-detail="${c.id}" value="${escapeHtml(c.kids || '')}"></label>
<label>Job<input type="text" data-field="job" data-conn-detail="${c.id}" value="${escapeHtml(c.job || '')}"></label>
<label>Height<input type="text" data-field="height" data-conn-detail="${c.id}" value="${escapeHtml(c.height || '')}"></label>
<label>Education<input type="text" data-field="education" data-conn-detail="${c.id}" value="${escapeHtml(c.education || '')}"></label>
<div class="field-block">
<span class="field-label">Phone</span>
<span class="phone-row">
<select class="dial-code" data-dial-for="${c.id}">${dialCodeOptions()}</select>
<input type="tel" placeholder="Used to match Google Contacts" data-field="phone" data-conn-detail="${c.id}" value="${escapeHtml(c.phone || '')}">
</span>
</div>
<label>Email<input type="email" placeholder="Also used to match" data-field="email" data-conn-detail="${c.id}" value="${escapeHtml(c.email || '')}"></label>
<label>What I like most<input type="text" data-field="likes" data-conn-detail="${c.id}" value="${escapeHtml(c.likes || '')}"></label>
<label class="full">Notes<textarea rows="2" data-field="notes" data-conn-detail="${c.id}">${escapeHtml(c.notes || '')}</textarea></label>
${visibleTagFields().map((f) => `<label class="full${f.sensitive ? ' sensitive-field' : ''}">${escapeHtml(f.label)}<div class="tag-editor">${tagChips(c[f.field], c.id, f.field)}</div></label>`).join('')}
<label class="full">Ratings<div class="ratings-block">${RATING_CATS.map(([cat, lbl]) => ratingStars(lbl, cat, c.id, (c.ratings && c.ratings[cat]) || 0)).join('')}</div></label>
<label class="full">Things to do<div>${todoListHtml(c)}</div></label>
<label class="full">Photos${galleryHtml(c)}</label>
<label class="full">Drive/OneDrive link (optional, for full-res photos filed elsewhere)<input type="text" placeholder="Paste a share link" data-field="driveLink" data-conn-detail="${c.id}" value="${escapeHtml(c.driveLink || '')}"></label>
${c.driveLink ? `<div class="full"><a href="${escapeHtml(c.driveLink)}" target="_blank" rel="noopener" style="font-size:12px;color:var(--rose);">Open full-res photos &#8599;</a></div>` : ''}
<label class="full">Merge a duplicate into this one
<div class="merge-row">
<select data-merge-source="${c.id}">
<option value="">Pick a duplicate&hellip;</option>
${data.connections.filter((o) => o.id !== c.id).map((o) => `<option value="${o.id}">${escapeHtml(o.name)}${o.age ? ', ' + escapeHtml(o.age) : ''}${o.app ? ' — ' + escapeHtml(o.app) : ''}</option>`).join('')}
</select>
<button class="todo-add-btn" type="button" data-merge-btn="${c.id}">Merge in</button>
</div>
</label>
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
conn[el.dataset.field] = el.value;
// These are echoed elsewhere in the card (the name line, the source tag,
// every merge dropdown), so a full re-render is the only way to keep
// those honest. `change` fires on blur, not per keystroke, so this costs
// one render per edit rather than one per character.
if (['name', 'app', 'age', 'location'].includes(el.dataset.field)) renderConnections();
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
sel.value = '';
queueSave();
});
});

list.querySelectorAll('[data-merge-btn]').forEach((btn) => {
btn.addEventListener('click', async () => {
const target = data.connections.find((x) => x.id === btn.dataset.mergeBtn);
const select = list.querySelector(`[data-merge-source="${btn.dataset.mergeBtn}"]`);
const source = data.connections.find((x) => x.id === select.value);
if (!target || !source) return;
if (!confirm(`Merge "${source.name}" into "${target.name}"?\n\nEverything from "${source.name}" — photos, notes, ratings, tags, to-dos — is folded in, keeping "${target.name}"'s values wherever both have one. "${source.name}" is then removed.\n\nThis can't be undone.`)) return;
mergeConnectionInto(target, source);
data.connections = data.connections.filter((x) => x.id !== source.id);
renderConnections();
renderOverviewRef();
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
list.querySelectorAll('[data-view-photo]').forEach((el) => {
el.addEventListener('click', async () => {
const url = await photoUrl(el.dataset.viewPhoto);
if (url) openLightbox(url);
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
const id = uid();
await photoPut(id, blob);
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
if (el.open) expandedConnections.add(el.dataset.connDetails);
else expandedConnections.delete(el.dataset.connDetails);
});
});
}

function openLightbox(url) {
const box = document.createElement('div');
box.className = 'lightbox';
box.innerHTML = `<img src="${url}" alt="">`;
box.addEventListener('click', () => box.remove());
document.body.appendChild(box);
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
data.connections.push({
id: newId, name, app: appInput.value, priority: 3, stage: 'Matched', lastContact: todayStr(),
photoId: null, photoIds: [], age: '', location: '', kids: '', job: '', height: '', education: '',
likes: '', notes: '',
languages: [], nationality: [], todos: [], tags: [], dateLocations: [], dateEvents: [], sexTags: [],
ratings: {}, driveLink: '',
});
nameInput.value = '';
renderConnections();
renderOverviewRef();
queueSave();
setTimeout(() => scrollAndFlash(`[data-conn-row="${newId}"]`), 50);
});

document.getElementById('conn-search').addEventListener('input', (e) => {
connectionSearchTerm = e.target.value;
// Typing a search is an implicit "forget the None filter" — leaving both
// active would show a filtered subset with no indication why.
emptyFieldFilter = null;
renderConnections();
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

function candidateRowHtml(idx, name, age, matches, extraDetail) {
if (matches && matches.length > 0) {
const existingHtml = matches.map((m) => `
<div class="compare-existing">
${avatarHtml(m.photoId, m.name, 'sm')}
<span class="compare-caption">${escapeHtml(existingMatchCaption(m))}</span>
</div>`).join('');
const updateOptions = matches.map((m) => `<option value="update:${m.id}">Same person &mdash; merge into ${escapeHtml(m.name)} (${escapeHtml(existingMatchCaption(m))})</option>`).join('');
const tag = matches.length > 1 ? `${matches.length} existing people share this name` : 'same name already tracked';
return `<div class="candidate-row ambiguous" data-idx="${idx}">
<div class="compare">
${existingHtml}
<span class="vs">existing vs new</span>
<span class="avatar sm" data-candidate-photo="${idx}">${escapeHtml((name || '?').charAt(0).toUpperCase())}</span>
</div>
<div>${escapeHtml(name)}${age ? ', ' + escapeHtml(age) : ''} <span class="candidate-tag">${tag}</span></div>
${extraDetail ? `<div style="font-size:11px;color:var(--muted);">${escapeHtml(extraDetail)}</div>` : ''}
<select class="decision-select" data-decision="${idx}">
${updateOptions}
<option value="new">Different person &mdash; add as new</option>
<option value="skip" selected>Skip for now</option>
</select>
</div>`;
}
return `<label class="candidate-row" data-idx="${idx}">
<input type="checkbox" data-new-idx="${idx}" checked>
<span class="avatar sm" data-candidate-photo="${idx}">${escapeHtml((name || '?').charAt(0).toUpperCase())}</span>
<span>${escapeHtml(name)}${age ? ', ' + escapeHtml(age) : ''}${extraDetail ? `<br><span style="font-size:11px;color:var(--muted);">${escapeHtml(extraDetail)}</span>` : ''}</span>
<span class="candidate-tag">new</span>
</label>`;
}

// Keeps the "Add photos to…" picker in step with the connection list. The
// import box sits outside #connections-list so it isn't rebuilt by
// renderConnections' innerHTML assignment — it has to be refreshed here.
function refreshPhotoTargets() {
const select = document.getElementById('photo-target-input');
if (!select) return;
const previous = select.value;
select.innerHTML = '<option value="">Add photos to&hellip;</option>'
+ [...data.connections]
.sort((a, b) => a.name.localeCompare(b.name))
.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}${c.age ? ', ' + escapeHtml(c.age) : ''}${c.app ? ' — ' + escapeHtml(c.app) : ''}</option>`)
.join('');
if ([...select.options].some((o) => o.value === previous)) select.value = previous;
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
const id = uid();
await photoPut(id, blob);
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

function initImport() {
const status = document.getElementById('import-status');
const candidateList = document.getElementById('candidate-list');

document.getElementById('photo-only-input').addEventListener('change', async (e) => {
const files = Array.from(e.target.files);
e.target.value = '';
if (files.length === 0) return;
candidateList.innerHTML = '';
await addPhotosWithoutParsing(files, status);
});

document.getElementById('import-file-input').addEventListener('change', async (e) => {
const file = e.target.files[0];
if (!file) return;
candidateList.innerHTML = '';
status.textContent = 'Reading screenshot…';
await withImportStatus(status, async () => {
const { candidates, truncated } = await extractMatchesFromScreenshot(file, screenshotAppHint());
if (candidates.length === 0) { status.textContent = 'No people found in that screenshot.'; return; }
const truncatedNote = truncated ? ' (the screenshot had more people than fit in one response — the rest were skipped; try cropping the screenshot shorter and importing the remainder separately)' : '';
status.textContent = `Found ${candidates.length} ${candidates.length === 1 ? 'person' : 'people'}${truncatedNote} — review below:`;
await renderCandidateReview(candidateList, candidates);
});
e.target.value = '';
});

document.getElementById('import-profile-input').addEventListener('change', async (e) => {
const files = Array.from(e.target.files);
if (files.length === 0) return;
candidateList.innerHTML = '';
status.textContent = `Reading ${files.length} profile screenshot${files.length === 1 ? '' : 's'}…`;
await withImportStatus(status, async () => {
const results = await Promise.allSettled(files.map((f) => extractProfileFromScreenshot(f, screenshotAppHint())));
const profiles = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
const failures = results.filter((r) => r.status === 'rejected').map((r) => r.reason);
failures.forEach((err) => console.error('Profile screenshot import failed:', err));
const failedCount = failures.length;
if (profiles.length === 0) {
const firstMissingKey = failures.find((err) => err instanceof MissingKeyError);
const detail = firstMissingKey ? firstMissingKey.message : (failures[0]?.message || 'unknown error');
status.textContent = `Couldn't read ${failedCount === 1 ? 'that screenshot' : 'those screenshots'}: ${detail}`;
return;
}
status.textContent = `Found ${profiles.length} profile${profiles.length === 1 ? '' : 's'}${failedCount ? ` (${failedCount} unreadable — see console)` : ''} — review below:`;
await renderCandidateReview(candidateList, profiles.map((p) => ({ ...p, photoBlob: p.photoBlobs[0] || null })), true);
});
e.target.value = '';
});
}

async function renderCandidateReview(candidateList, candidates, isProfile) {
candidateList.innerHTML = candidates.map((cand, idx) => {
const matches = data.connections.filter((c) => c.name.toLowerCase() === String(cand.name).toLowerCase());
const extra = isProfile
? [cand.age, cand.height, cand.location, cand.job, cand.education, (cand.languages || []).join('/'), cand.bio].filter(Boolean).join(' · ')
: (cand.stage ? `Detected stage: ${cand.stage}` : '');
return candidateRowHtml(idx, cand.name, cand.age, matches, extra);
}).join('') + '<button class="add-btn" id="confirm-import-btn" type="button" style="margin-top:6px;align-self:flex-start;">Add / update selected</button>';

// hydrate candidate avatar previews from their in-memory blobs (not yet saved to IndexedDB)
candidateList.querySelectorAll('[data-candidate-photo]').forEach((el) => {
const idx = parseInt(el.dataset.candidatePhoto, 10);
const blob = candidates[idx].photoBlob;
if (blob) {
const img = document.createElement('img');
img.src = URL.createObjectURL(blob);
el.textContent = '';
el.appendChild(img);
}
});
// hydrate existing-match avatars (already-saved photos, loaded from IndexedDB)
await hydratePhotos(candidateList);

document.getElementById('confirm-import-btn').addEventListener('click', async () => {
const app = document.getElementById('import-app-input').value;
let addedCount = 0, updatedCount = 0;

for (const cb of candidateList.querySelectorAll('input[data-new-idx]:checked')) {
const cand = candidates[parseInt(cb.dataset.newIdx, 10)];
await addNewConnectionFromCandidate(cand, app, isProfile);
addedCount++;
}

for (const sel of candidateList.querySelectorAll('select[data-decision]')) {
const cand = candidates[parseInt(sel.dataset.decision, 10)];
if (sel.value.startsWith('update:')) {
const existing = data.connections.find((c) => c.id === sel.value.slice(7));
if (existing) {
await applyCandidateUpdate(existing, cand, isProfile);
updatedCount++;
}
} else if (sel.value === 'new') {
await addNewConnectionFromCandidate(cand, app, isProfile);
addedCount++;
}
}

candidateList.innerHTML = '';
document.getElementById('import-status').textContent = `Added ${addedCount}, updated ${updatedCount}.`;
renderConnections();
renderOverviewRef();
queueSave();
});
}

async function addNewConnectionFromCandidate(cand, app, isProfile) {
const id = uid();
let photoId = null;
const photoIds = [];
const blobs = isProfile ? (cand.photoBlobs || []) : (cand.photoBlob ? [cand.photoBlob] : []);
for (const blob of blobs) {
const pid = uid();
await photoPut(pid, blob);
photoIds.push(pid);
if (!photoId) photoId = pid;
}
data.connections.push({
// profileName records what the app called them, so renaming the
// connection to their real name later doesn't orphan the photos.
id, name: cand.name, profileName: cand.name, app, priority: 3, stage: cand.stage || 'Matched', lastContact: todayStr(),
photoId, photoIds, age: cand.age || '', location: cand.location || '', kids: cand.kids || '', job: cand.job || '',
height: cand.height || '', education: cand.education || '',
likes: '', notes: cand.bio || '', languages: cand.languages || [], nationality: cand.nationality || [],
todos: [], tags: [], dateLocations: [], dateEvents: [], sexTags: [], ratings: {}, driveLink: '',
});
}

const SCALAR_MERGE_FIELDS = ['age', 'location', 'kids', 'job', 'height', 'education', 'likes', 'driveLink'];

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
if (!Array.isArray(target.photoIds)) target.photoIds = [];
(source.photoIds || []).forEach((pid) => { if (!target.photoIds.includes(pid)) target.photoIds.push(pid); });
if (!target.photoId) target.photoId = target.photoIds[0] || null;
if (!Array.isArray(target.todos)) target.todos = [];
(source.todos || []).forEach((t) => {
if (!target.todos.some((x) => x.text.trim().toLowerCase() === String(t.text).trim().toLowerCase())) target.todos.push(t);
});
if (!target.ratings) target.ratings = {};
RATING_CATS.forEach(([cat]) => {
if (!target.ratings[cat] && source.ratings && source.ratings[cat]) target.ratings[cat] = source.ratings[cat];
});
if (!target.priority && source.priority) target.priority = source.priority;
if ((STAGE_RANK[source.stage] ?? 0) > (STAGE_RANK[target.stage] ?? 0)) target.stage = source.stage;
// Keep whichever contact is more recent — merging two records shouldn't
// make someone look staler than they actually are and trigger a false
// "reach out" nudge.
if (source.lastContact && (!target.lastContact || source.lastContact > target.lastContact)) target.lastContact = source.lastContact;
}

async function applyCandidateUpdate(existing, cand, isProfile) {
const blobs = isProfile ? (cand.photoBlobs || []) : (cand.photoBlob ? [cand.photoBlob] : []);
for (const blob of blobs) {
const pid = uid();
await photoPut(pid, blob);
existing.photoIds.push(pid);
if (!existing.photoId) existing.photoId = pid;
}
// Same merge semantics as mergeConnectionInto: fill gaps, never overwrite.
// What you typed yourself outranks what a model read off a screenshot.
const incoming = {
age: cand.age, location: cand.location, job: cand.job, kids: cand.kids,
height: cand.height, education: cand.education,
};
SCALAR_MERGE_FIELDS.forEach((k) => {
if (!String(existing[k] || '').trim() && String(incoming[k] || '').trim()) existing[k] = incoming[k];
});
if (isProfile) {
const bio = String(cand.bio || '').trim();
const notes = String(existing.notes || '').trim();
if (bio && bio !== notes) existing.notes = notes ? `${notes}\n${bio}` : bio;
unionInto(existing.languages, cand.languages);
unionInto(existing.nationality, cand.nationality);
}
// Only move the stage forward, never back — a screenshot re-import
// shouldn't undo progress you've logged manually since (e.g. re-scanning
// an old "New Matches" screenshot after you've already met up).
if (cand.stage && (STAGE_RANK[cand.stage] ?? 0) > (STAGE_RANK[existing.stage] ?? 0)) {
existing.stage = cand.stage;
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
STAGE_RANK, setContactPicker, phoneWithFlagHtml,
};
