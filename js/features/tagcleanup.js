// Fixes tag values that already drifted apart. The autocomplete added to the
// tag inputs only prevents NEW variants — anything already recorded as both
// "Sporty" and "sporty" stays split, grouping separately in Connections
// Overview and matching different searches.
//
// Two levels of help: groups that differ only by case or spacing are flagged
// automatically with a one-click merge, and everything else can be renamed
// or merged by hand.
import { data, queueSave, TAG_FIELDS, distanceMiles } from '../state.js';
import { escapeHtml, findMentions, COUNTRY_NAME_TO_NATIONALITY, scrollAndFlash } from '../utils.js';

// Values that should almost certainly be the same tag. Case and runs of
// whitespace are the differences worth auto-detecting; anything cleverer
// (plurals, typos) risks merging two genuinely different tags, which is far
// worse than leaving a duplicate for you to spot.
function normaliseKey(value) {
return String(value).trim().toLowerCase().replace(/\s+/g, ' ');
}

function valueCounts(field) {
const counts = new Map();
data.connections.forEach((c) => {
(c[field] || []).forEach((v) => {
const value = String(v).trim();
if (!value) return;
counts.set(value, (counts.get(value) || 0) + 1);
});
});
return counts;
}

function duplicateGroups(field) {
const groups = new Map();
[...valueCounts(field).keys()].forEach((value) => {
const key = normaliseKey(value);
if (!groups.has(key)) groups.set(key, []);
groups.get(key).push(value);
});
return [...groups.values()].filter((variants) => variants.length > 1);
}

// Rewrites `from` to `to` everywhere, de-duplicating within each connection
// so someone tagged both "Sporty" and "sporty" ends up with one chip rather
// than the same tag twice.
function renameValue(field, from, to) {
const target = String(to).trim();
if (!target) return;
data.connections.forEach((c) => {
if (!Array.isArray(c[field])) return;
const seen = new Set();
c[field] = c[field].reduce((acc, v) => {
const next = String(v).trim() === String(from).trim() ? target : v;
const key = normaliseKey(next);
if (!key || seen.has(key)) return acc;
seen.add(key);
acc.push(next);
return acc;
}, []);
});
}

function renderTagCleanup() {
const el = document.getElementById('tag-cleanup');
if (!el) return;

const sections = TAG_FIELDS.map(({ field, label }) => {
const counts = valueCounts(field);
if (counts.size === 0) return '';
const dupes = duplicateGroups(field);
const values = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

const dupeHtml = dupes.length ? `<div class="dupe-block">
${dupes.map((variants) => {
// Keep the most-used spelling by default — it's the one you've
// typed most often, so it's the likeliest intended form.
const winner = [...variants].sort((a, b) => counts.get(b) - counts.get(a))[0];
// The group is identified by its normalised key and recomputed on click,
// rather than serialised into the attribute — a value containing a quote
// would corrupt the markup, and the group is cheap to look up again.
return `<div class="dupe-row">
<span class="dupe-variants">${variants.map((v) => `<code>${escapeHtml(v)}</code> <span class="dupe-count">${counts.get(v)}</span>`).join(' + ')}</span>
<button class="sync-btn" type="button" data-merge-dupes="${escapeHtml(field)}" data-merge-key="${escapeHtml(normaliseKey(winner))}">Merge into “${escapeHtml(winner)}”</button>
</div>`;
}).join('')}
</div>` : '';

return `<div class="cleanup-section">
<h4>${escapeHtml(label)} <span class="cleanup-count">${counts.size} value${counts.size === 1 ? '' : 's'}</span></h4>
${dupeHtml}
<table class="limits-table">
<thead><tr><th>Value</th><th>Used</th><th>Rename to</th><th>Merge into</th></tr></thead>
<tbody>${values.map(([value, count]) => `<tr>
<td>${escapeHtml(value)}</td>
<td>${count}</td>
<td><input type="text" autocomplete="off" data-rename-field="${escapeHtml(field)}" data-rename-from="${escapeHtml(value)}" placeholder="${escapeHtml(value)}"></td>
<td><select data-mergeinto-field="${escapeHtml(field)}" data-mergeinto-from="${escapeHtml(value)}">
<option value="">—</option>
${values.filter(([other]) => other !== value).map(([other]) => `<option value="${escapeHtml(other)}">${escapeHtml(other)}</option>`).join('')}
</select></td>
</tr>`).join('')}</tbody>
</table>
</div>`;
}).filter(Boolean).join('');

el.innerHTML = sections || '<div class="settings-note" style="margin:0;">No tags recorded yet.</div>';

el.querySelectorAll('[data-merge-dupes]').forEach((btn) => {
btn.addEventListener('click', () => {
const field = btn.dataset.mergeDupes;
const group = duplicateGroups(field).find((variants) => variants.some((v) => normaliseKey(v) === btn.dataset.mergeKey));
if (!group) return;
const counts = valueCounts(field);
const keep = [...group].sort((a, b) => counts.get(b) - counts.get(a))[0];
group.filter((v) => v !== keep).forEach((v) => renameValue(field, v, keep));
afterChange();
});
});

el.querySelectorAll('[data-rename-field]').forEach((input) => {
input.addEventListener('change', () => {
const to = input.value.trim();
if (!to || to === input.dataset.renameFrom) { input.value = ''; return; }
renameValue(input.dataset.renameField, input.dataset.renameFrom, to);
afterChange();
});
});

el.querySelectorAll('[data-mergeinto-field]').forEach((sel) => {
sel.addEventListener('change', () => {
if (!sel.value) return;
renameValue(sel.dataset.mergeintoField, sel.dataset.mergeintoFrom, sel.value);
afterChange();
});
});
}

// ---- City/Nationality fill-in proposals ---------------------------------
//
// For anyone not obviously based in London, scans a few free-text fields
// for a city or nationality word ALREADY known to this app -- a city
// already recorded on some OTHER connection (findMentions' own
// knownCityMap), or a country/nationality word from the static built-in
// list (COUNTRY_NAME_TO_NATIONALITY). Deliberately keyword-only: no
// external gazetteer, no "which city is this university in" real-world
// knowledge -- a wrong guess dressed up as confident is worse than a
// blank field staying blank.
//
// Ranked by how many independent signals agree, not just scan order --
// confirmed by explicit feedback that a flat, unranked list of every
// single passing mention was unusable. A repeated mention of the same
// value across different fields, or a value corroborated by Distance
// being clearly non-local, is far more trustworthy than one passing
// mention, and a genuinely ambiguous case -- several DIFFERENT candidate
// values with no clear winner, or someone whose several languages don't
// obviously point at one particular home -- is DROPPED rather than
// guessed between and shown as noise. A language-based nationality guess
// only ever counts when it's the clear rarest among that PERSON'S OWN
// languages (checked against how rare it is across this dataset's own
// connections, not a hardcoded world-population figure -- "rare in your
// own dating pool", which is real, derived evidence, not invented
// geography knowledge) -- someone listing English, Spanish, French and
// Montenegrin proposes Montenegrin alone, someone listing only common
// languages proposes nothing.
const LONDON_RE = /london/i;
const NATIONALITY_WORDS = [...new Set(Object.values(COUNTRY_NAME_TO_NATIONALITY))];
const FAR_AWAY_MILES = 30; // corroborates a foreign guess -- clearly not just a nearby Londoner
const CLEARLY_LOCAL_MILES = 5; // contradicts one -- a "Paris" hit this close reads more like a name/venue than the city
const RARE_LANGUAGE_MAX_COUNT = 3; // spoken by more connections than this and it's not a distinctive signal any more

function languageFrequencies() {
const freq = new Map();
data.connections.forEach((c) => (c.languages || []).forEach((l) => {
const key = String(l).trim().toLowerCase();
if (key) freq.set(key, (freq.get(key) || 0) + 1);
}));
return freq;
}

// The single rarest of this person's OWN languages that's also a
// nationality word -- only if it's a clear, unique minimum among their
// own list (tied with another of their languages means no standout) and
// rare enough in absolute terms. Anything else returns null on purpose.
function rareLanguageNationality(conn, langFreq) {
const candidates = (conn.languages || [])
.map((l) => String(l).trim())
.filter((l) => NATIONALITY_WORDS.some((nat) => nat.toLowerCase() === l.toLowerCase()))
.map((l) => ({ value: l, count: langFreq.get(l.toLowerCase()) || 0 }));
if (!candidates.length) return null;
candidates.sort((a, b) => a.count - b.count);
const [best, second] = candidates;
if (second && second.count === best.count) return null; // tied -- no standout
if (best.count > RARE_LANGUAGE_MAX_COUNT) return null; // not actually rare
return best.value;
}

// Collapses every raw hit for one field down to a single winning value --
// the one with the most distinct corroborating sources. Two+ DIFFERENT
// candidate values tied for the lead are dropped rather than guessed
// between, same "either ignore it, or find the standout" rule the
// language signal follows.
function bestCandidate(hits) {
const byValue = new Map();
hits.forEach(({ value, source }) => {
const key = value.toLowerCase();
if (!byValue.has(key)) byValue.set(key, { value, sources: new Set() });
byValue.get(key).sources.add(source);
});
const ranked = [...byValue.values()].sort((a, b) => b.sources.size - a.sources.size);
if (!ranked.length) return null;
if (ranked.length > 1 && ranked[1].sources.size === ranked[0].sources.size) return null;
return ranked[0];
}

// The actual per-person check, pulled out of locationFillInProposals()'s
// own forEach so a not-yet-saved Tinder pending profile can run the
// identical test (see js/features/tinderimport.js's personShapeFromPending()),
// not just an already-saved connection -- nothing in here is specific to
// a saved connection, it only ever reads plain field values off `person`.
// `person` needs: id, name, location (array), nationality (array),
// languages (array), education/job/notes/likes/distance (strings).
// Returns null when there's nothing worth proposing.
function proposalsForPerson(person, langFreq) {
if (LONDON_RE.test((person.location || []).join(' '))) return null;
const missingCity = !(person.location || []).length;
const missingNationality = !(person.nationality || []).length;
if (!missingCity && !missingNationality) return null;

const cityHits = [], natHits = [];
[['Education', person.education], ['Job', person.job], ['Notes', person.notes], ['Likes', person.likes]].forEach(([label, text]) => {
findMentions(text, data.connections, data.flagRules).forEach((hit) => {
if (hit.field === 'location' && missingCity) cityHits.push({ value: hit.value, source: label });
else if (hit.field === 'nationality' && missingNationality) natHits.push({ value: hit.value, source: label });
});
});
if (missingNationality) {
const rareLang = rareLanguageNationality(person, langFreq);
if (rareLang) natHits.push({ value: rareLang, source: `rarest of the languages they speak` });
}

const distMiles = distanceMiles(person.distance);
const farAway = distMiles != null && distMiles >= FAR_AWAY_MILES;
const clearlyLocal = distMiles != null && distMiles <= CLEARLY_LOCAL_MILES;
if (clearlyLocal) return null; // Distance itself contradicts a foreign guess -- drop the whole person, not just weight it down

const fields = [];
[['location', 'City', missingCity ? bestCandidate(cityHits) : null], ['nationality', 'Nationality', missingNationality ? bestCandidate(natHits) : null]]
.forEach(([field, label, best]) => {
if (!best) return;
let sourceText = [...best.sources].join(', ');
let signals = best.sources.size;
if (farAway) { signals += 1; sourceText += `, ${Math.round(distMiles)}mi away`; }
fields.push({ field, label, value: best.value, signals, sourceText });
});
if (!fields.length) return null;
return { connId: person.id, name: person.name, fields, confidence: fields.reduce((sum, f) => sum + f.signals, 0) };
}

function locationFillInProposals() {
const langFreq = languageFrequencies();
const results = data.connections
.map((c) => proposalsForPerson({ id: c.id, name: c.name, location: c.location, nationality: c.nationality, languages: c.languages, education: c.education, job: c.job, notes: c.notes, likes: c.likes, distance: c.distance }, langFreq))
.filter(Boolean);
results.sort((a, b) => b.confidence - a.confidence);
return results;
}

// Cached from the last Scan click, not re-derived on every render -- a
// few hundred connections times several free-text fields each means a
// few hundred findMentions() calls, each rebuilding a matcher against a
// freshly-constructed city map (knownCityMap() returns a new Map every
// call, so nothing upstream can cache across calls either). Fine for a
// deliberate, occasional "check for anything worth fixing" click; not
// something to pay on every ordinary Connections-tab render.
let fillInResults = null;

function fillInRowHtml(p) {
const fieldsHtml = p.fields.map((f) => `<div class="tinder-field-row">
<strong>${escapeHtml(f.label)}:</strong> ${escapeHtml(f.value)}
<button class="sync-btn inline" type="button" data-fillin-apply="${escapeHtml(p.connId)}" data-fillin-apply-field="${escapeHtml(f.field)}" data-fillin-apply-value="${escapeHtml(f.value)}">Fill in</button>
<div class="settings-note" style="margin:2px 0 0;">${escapeHtml(f.sourceText)}</div>
</div>`).join('');
return `<div class="tinder-candidate-row">
<div class="album-caption"><a href="#" data-fillin-open="${escapeHtml(p.connId)}">${escapeHtml(p.name || '(no name)')}</a> <span class="cal-badge">${p.confidence} signal${p.confidence === 1 ? '' : 's'}</span></div>
${fieldsHtml}
</div>`;
}

function renderLocationFillIns() {
const el = document.getElementById('location-fillins');
if (!el) return;
if (fillInResults === null) {
el.innerHTML = '<div class="settings-note" style="margin:0;">Click "Scan" to check everyone not obviously based in London against known cities/nationalities from your own data.</div>';
return;
}
if (!fillInResults.length) {
el.innerHTML = '<div class="settings-note" style="margin:0;">Nothing worth proposing right now — not every gap is fillable, and an ambiguous one is dropped rather than guessed at.</div>';
return;
}
el.innerHTML = fillInResults.map(fillInRowHtml).join('');
el.querySelectorAll('[data-fillin-open]').forEach((a) => {
a.addEventListener('click', async (e) => {
e.preventDefault();
const id = a.dataset.fillinOpen;
const [{ switchTab }, { expandConnection }] = await Promise.all([import('../tabs.js'), import('./connections.js')]);
switchTab('dating');
expandConnection(id);
setTimeout(() => scrollAndFlash(`[data-conn-row="${id}"]`), 80);
});
});
el.querySelectorAll('[data-fillin-apply]').forEach((btn) => {
btn.addEventListener('click', () => {
const { fillinApply: connId, fillinApplyField: field, fillinApplyValue: value } = btn.dataset;
const conn = data.connections.find((c) => c.id === connId);
if (!conn) return;
if (!Array.isArray(conn[field])) conn[field] = [];
if (!conn[field].some((v) => String(v).toLowerCase() === value.toLowerCase())) conn[field].push(value);
// Drop just this field from that person's card; drop the whole card
// once nothing's left on it.
const person = fillInResults.find((p) => p.connId === connId);
if (person) {
person.fields = person.fields.filter((f) => f.field !== field);
if (!person.fields.length) fillInResults = fillInResults.filter((p) => p !== person);
}
queueSave();
renderLocationFillIns();
import('./connections.js').then((m) => m.renderConnections());
});
});
}

function initLocationFillIns() {
const btn = document.getElementById('location-fillins-scan-btn');
if (!btn) return;
btn.addEventListener('click', () => {
fillInResults = locationFillInProposals();
renderLocationFillIns();
});
renderLocationFillIns();
}

// Tag changes show up in the connection cards and in Connections Overview,
// so both need redrawing, not just this panel.
function afterChange() {
queueSave();
renderTagCleanup();
Promise.all([import('./connections.js'), import('./overview.js')])
.then(([conns, overview]) => { conns.renderConnections(); overview.renderOverview(); });
}

export { renderTagCleanup, duplicateGroups, renameValue, initLocationFillIns, locationFillInProposals, proposalsForPerson, languageFrequencies };
