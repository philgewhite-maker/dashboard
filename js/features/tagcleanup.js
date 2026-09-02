// Fixes tag values that already drifted apart. The autocomplete added to the
// tag inputs only prevents NEW variants — anything already recorded as both
// "Sporty" and "sporty" stays split, grouping separately in Connections
// Overview and matching different searches.
//
// Two levels of help: groups that differ only by case or spacing are flagged
// automatically with a one-click merge, and everything else can be renamed
// or merged by hand.
import { data, queueSave, TAG_FIELDS } from '../state.js';
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
// list (COUNTRY_NAME_TO_NATIONALITY) -- and proposes it as a fill-in for
// whichever of City/Nationality is still blank on that connection.
// Deliberately keyword-only: no external gazetteer, no "which city is
// this university in" real-world knowledge -- a wrong guess dressed up as
// confident is worse than a blank field staying blank, so every
// proposal is a match against vocabulary already sitting in this data or
// already shipped in this app, never invented or looked up live. Every
// row names WHERE the match came from, and nothing is ever applied
// without a click -- these are things to check with the person, not
// facts.
const LONDON_RE = /london/i;
const NATIONALITY_WORDS = [...new Set(Object.values(COUNTRY_NAME_TO_NATIONALITY))];

function locationFillInProposals() {
const proposals = [];
data.connections.forEach((c) => {
if (LONDON_RE.test((c.location || []).join(' '))) return;
const missingCity = !(c.location || []).length;
const missingNationality = !(c.nationality || []).length;
if (!missingCity && !missingNationality) return;

const seen = new Set();
const add = (field, value, source) => {
if ((field === 'location' && !missingCity) || (field === 'nationality' && !missingNationality)) return;
const key = `${field}:${String(value).toLowerCase()}`;
if (seen.has(key)) return;
seen.add(key);
proposals.push({ connId: c.id, name: c.name, field, value, source });
};

[['Education', c.education], ['Job', c.job], ['Notes', c.notes], ['Likes', c.likes]].forEach(([label, text]) => {
findMentions(text, data.connections, data.flagRules).forEach((hit) => add(hit.field, hit.value, `mentioned in ${label}`));
});

// A language they speak sharing an exact name with a known nationality
// adjective (French/German/Italian/Japanese/...) -- a real but weak
// signal, since plenty of other countries share the same language, so
// always offered as "worth checking", never as a confident answer.
if (missingNationality) {
(c.languages || []).forEach((lang) => {
const norm = String(lang).trim().toLowerCase();
if (NATIONALITY_WORDS.some((nat) => nat.toLowerCase() === norm)) {
add('nationality', lang, `speaks ${lang} — other countries share this language too, worth checking`);
}
});
}
});
return proposals;
}

// Cached from the last Scan click, not re-derived on every render -- a
// few hundred connections times several free-text fields each means a
// few hundred findMentions() calls, each rebuilding a matcher against a
// freshly-constructed city map (knownCityMap() returns a new Map every
// call, so nothing upstream can cache across calls either). Fine for a
// deliberate, occasional "check for anything worth fixing" click; not
// something to pay on every ordinary Connections-tab render.
let fillInResults = null;

function fillInRowHtml(p, idx) {
const fieldLabel = p.field === 'location' ? 'City' : 'Nationality';
return `<tr>
<td><a href="#" data-fillin-open="${escapeHtml(p.connId)}">${escapeHtml(p.name || '(no name)')}</a></td>
<td>${fieldLabel}</td>
<td>${escapeHtml(p.value)}</td>
<td class="settings-note">${escapeHtml(p.source)}</td>
<td><button class="sync-btn sm" type="button" data-fillin-apply="${idx}">Fill in</button></td>
</tr>`;
}

function renderLocationFillIns() {
const el = document.getElementById('location-fillins');
if (!el) return;
if (fillInResults === null) {
el.innerHTML = '<div class="settings-note" style="margin:0;">Click "Scan" to check everyone not obviously based in London against known cities/nationalities from your own data.</div>';
return;
}
if (!fillInResults.length) {
el.innerHTML = '<div class="settings-note" style="margin:0;">Nothing to propose right now.</div>';
return;
}
el.innerHTML = `<table class="limits-table">
<thead><tr><th>Connection</th><th>Field</th><th>Proposed value</th><th>Why</th><th></th></tr></thead>
<tbody>${fillInResults.map(fillInRowHtml).join('')}</tbody>
</table>`;
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
const p = fillInResults[parseInt(btn.dataset.fillinApply, 10)];
if (!p) return;
const conn = data.connections.find((c) => c.id === p.connId);
if (!conn) return;
if (!Array.isArray(conn[p.field])) conn[p.field] = [];
if (!conn[p.field].some((v) => String(v).toLowerCase() === p.value.toLowerCase())) conn[p.field].push(p.value);
fillInResults = fillInResults.filter((x) => x !== p);
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

export { renderTagCleanup, duplicateGroups, renameValue, initLocationFillIns, locationFillInProposals };
