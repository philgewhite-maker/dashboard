import { data, queueSave, getLocalSettings, setLocalSetting, CONTACT_STATUS_LABELS, currentAge, displayAge, photoCoverage, photoLinkLabels } from '../state.js';
import { escapeHtml } from '../utils.js';
import { visibleTagFields } from './connections.js';

// Which sections are folded away, and which chip (if any) is expanded for
// bulk-assignment. Collapsed state is device-local and remembered across
// reloads; the open assigner is transient and resets on re-render.
let collapsed = {};
let openAssigner = null; // { field, key }

// Two ways to use the chips:
//
//   Filter list (default) — clicking a chip filters the connections below.
//     Every chip always shows its total, so it stays a map of everything.
//   Drill down — chips become facets that combine. Clicking several narrows
//     to people matching all of them, and every other dimension recounts
//     against that narrowed set, so you can see what's actually left.
//
// Both are useful for different questions ("who is in London?" vs "which of
// my London people have I not contacted?"), which is why there's a toggle
// rather than a decision.
let drillDown = false;
let facets = []; // [{title, key}]

async function initOverviewPrefs() {
const settings = await getLocalSettings();
collapsed = settings.overviewCollapsed || {};
drillDown = !!settings.overviewDrillDown;
}

// Uses the derived current age, so someone recorded at 29 two years ago is
// grouped in the 30s rather than staying frozen where they were entered.
function ageDecade(conn) {
const age = currentAge(conn);
if (!age) return null;
return `${Math.floor(age.value / 10) * 10}s`;
}

// One place defining what the chips group by, so faceting can re-apply the
// same rule that produced a chip in order to filter by it.
function dimensions() {
return [
{ title: 'Stage', getKeys: (c) => [c.stage], field: null, emptyField: 'stage' },
{ title: 'Location', getKeys: (c) => [c.location], field: null, emptyField: 'location' },
{ title: 'Age', getKeys: (c) => [ageDecade(c)], field: null, emptyField: 'age' },
{ title: 'Job', getKeys: (c) => [c.job], field: null, emptyField: 'job' },
{ title: 'Contact match', getKeys: (c) => [CONTACT_STATUS_LABELS[c.contactStatus]], field: null, emptyField: null },
// Both derived, for finding what needs fixing: who is still on a single
// import thumbnail, and who has no link out to their photos anywhere.
{ title: 'Photos', getKeys: (c) => [photoCoverage(c)], field: null, emptyField: null },
{ title: 'Photo links', getKeys: (c) => photoLinkLabels(c), field: null, emptyField: 'photoLinks' },
...visibleTagFields().map((f) => ({
title: f.label, getKeys: (c) => c[f.field] || [], field: f.field, emptyField: f.field,
})),
];
}

function keysFor(dim, c) {
return (dim.getKeys(c) || []).filter(Boolean);
}

function matchesFacet(c, facet, dims) {
const dim = dims.find((d) => d.title === facet.title);
return dim ? keysFor(dim, c).includes(facet.key) : true;
}

// Connections matching every active facet, optionally ignoring facets on one
// dimension. Ignoring its own facets is what lets a faceted dimension still
// show its siblings — otherwise picking "London" would leave Location
// showing only London, and you could never switch to Paris.
function connectionsMatching(dims, exceptTitle) {
const active = facets.filter((f) => f.title !== exceptTitle);
if (active.length === 0) return data.connections;
return data.connections.filter((c) => active.every((f) => matchesFacet(c, f, dims)));
}

function groupConnectionsBy(list, getKeys) {
const groups = {};
const none = [];
list.forEach((c) => {
const keys = (getKeys(c) || []).filter(Boolean);
if (keys.length === 0) { none.push(c); return; }
keys.forEach((k) => {
if (!groups[k]) groups[k] = [];
groups[k].push(c);
});
});
return { groups, none };
}

function isFaceted(title, key) {
return facets.some((f) => f.title === title && f.key === key);
}

function overviewDimension(dim, { groups, none }) {
const keys = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);
const activeHere = facets.filter((f) => f.title === dim.title);
if (keys.length === 0 && none.length === 0 && activeHere.length === 0) return '';
const isCollapsed = !!collapsed[dim.title];
const field = dim.field;

const chips = keys.map((k) => {
const isOpen = openAssigner && openAssigner.field === field && openAssigner.key === k;
const assigner = isOpen ? assignerHtml(field, k, groups[k]) : '';
const on = isFaceted(dim.title, k);
return `<span class="overview-chip-wrap">
<button class="overview-chip${isOpen || on ? ' active' : ''}" data-overview-key="${escapeHtml(k)}" data-overview-title="${escapeHtml(dim.title)}" data-overview-field="${escapeHtml(field || '')}">${escapeHtml(k)} (${groups[k].length})</button>
${assigner}
</span>`;
}).join('')
+ (none.length && dim.emptyField
? `<button class="overview-chip none" data-overview-none="${escapeHtml(dim.emptyField)}" data-overview-none-label="${escapeHtml(dim.title)}">None (${none.length})</button>`
: '');

return `<div class="overview-group">
<button class="overview-head" type="button" data-collapse="${escapeHtml(dim.title)}">
<span class="overview-caret">${isCollapsed ? '▸' : '▾'}</span>${escapeHtml(dim.title)}
<span class="overview-head-count">${keys.length}</span>
</button>
<div class="overview-chips"${isCollapsed ? ' hidden' : ''}>${chips}</div>
</div>`;
}

// The "add someone else to this tag" panel. Only offered for real array
// fields — you can't assign someone into an age decade, and stage is a
// single-value field that belongs on the connection row itself.
function assignerHtml(field, key, members) {
if (!field) return '';
const memberIds = new Set(members.map((c) => c.id));
const options = data.connections
.filter((c) => !memberIds.has(c.id))
.sort((a, b) => a.name.localeCompare(b.name))
.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}${displayAge(c) ? ', ' + escapeHtml(displayAge(c)) : ''}${c.app ? ' — ' + escapeHtml(c.app) : ''}</option>`)
.join('');
if (!options) return '<span class="assigner"><span class="assigner-note">Everyone already has this.</span></span>';
return `<span class="assigner">
<select class="assigner-select" data-assign-field="${escapeHtml(field)}" data-assign-key="${escapeHtml(key)}">
<option value="">Add someone&hellip;</option>
${options}
</select>
<button class="todo-add-btn" type="button" data-assign-btn="1" data-assign-field="${escapeHtml(field)}" data-assign-key="${escapeHtml(key)}">Add</button>
</span>`;
}

function activeFacetsHtml() {
if (!drillDown || facets.length === 0) return '';
const matching = connectionsMatching(dimensions()).length;
return `<div class="facet-bar">
<span class="facet-label">${matching} match${matching === 1 ? '' : 'es'}</span>
${facets.map((f, i) => `<button class="facet-pill" type="button" data-drop-facet="${i}">${escapeHtml(f.title)}: ${escapeHtml(f.key)} ×</button>`).join('')}
<button class="filter-clear" type="button" id="clear-facets">Clear all</button>
</div>`;
}

function renderOverview() {
const el = document.getElementById('overview-content');
if (data.connections.length === 0) {
el.innerHTML = '<div class="empty">Add some connections to see them grouped here.</div>';
return;
}
const dims = dimensions();

const modeHtml = `<div class="overview-mode">
<label><input type="checkbox" id="drilldown-toggle"${drillDown ? ' checked' : ''}> Drill down — chips combine and filter each other</label>
</div>`;

const sections = dims.map((dim) => {
// Each dimension counts against everything EXCEPT its own facets, so its
// alternatives stay visible and switchable.
const scope = drillDown ? connectionsMatching(dims, dim.title) : data.connections;
return overviewDimension(dim, groupConnectionsBy(scope, dim.getKeys));
}).filter(Boolean).join('');

el.innerHTML = modeHtml + activeFacetsHtml() + (sections
|| '<div class="empty">Nothing matches those filters.</div>');

document.getElementById('drilldown-toggle').addEventListener('change', (e) => {
drillDown = e.target.checked;
facets = [];
setLocalSetting('overviewDrillDown', drillDown);
renderOverview();
applyToList();
});

el.querySelectorAll('[data-drop-facet]').forEach((pill) => {
pill.addEventListener('click', () => {
facets.splice(parseInt(pill.dataset.dropFacet, 10), 1);
renderOverview();
applyToList();
});
});
const clearBtn = document.getElementById('clear-facets');
if (clearBtn) {
clearBtn.addEventListener('click', () => { facets = []; renderOverview(); applyToList(); });
}

el.querySelectorAll('[data-overview-none]').forEach((chip) => {
chip.addEventListener('click', async () => {
const m = await import('./connections.js');
m.filterByEmptyField(chip.dataset.overviewNone, chip.dataset.overviewNoneLabel);
openAssigner = null;
renderOverview();
});
});

el.querySelectorAll('.overview-chip:not(.none)').forEach((chip) => {
chip.addEventListener('click', () => {
const key = chip.dataset.overviewKey;
const title = chip.dataset.overviewTitle;
const field = chip.dataset.overviewField;

if (drillDown) {
// Toggle this facet. Selecting a different value in a dimension that
// already has one replaces it, since a connection can only be in one
// stage or age band — two facets there would match nobody.
const existingSame = facets.findIndex((f) => f.title === title && f.key === key);
if (existingSame >= 0) facets.splice(existingSame, 1);
else {
if (!field) facets = facets.filter((f) => f.title !== title);
facets.push({ title, key });
}
renderOverview();
applyToList();
return;
}

// Filter to exactly this dimension's key, not a free-text search — a
// substring search across every field would also catch, say, a
// Date-locations tag that happens to contain the same word as a
// Location chip ("Mallorca" the city vs. "Mallorca" a date-location).
const dim = dims.find((d) => d.title === title);
const ids = dim ? data.connections.filter((c) => keysFor(dim, c).includes(key)).map((c) => c.id) : [];
import('./connections.js').then((m) => m.filterByIds(ids, `${title}: ${key}`));
if (field) {
const alreadyOpen = openAssigner && openAssigner.field === field && openAssigner.key === key;
openAssigner = alreadyOpen ? null : { field, key };
renderOverview();
}
});
});

el.querySelectorAll('[data-assign-btn]').forEach((btn) => {
btn.addEventListener('click', () => {
const { assignField: field, assignKey: key } = btn.dataset;
const select = el.querySelector(`select[data-assign-field="${CSS.escape(field)}"][data-assign-key="${CSS.escape(key)}"]`);
const conn = data.connections.find((c) => c.id === select.value);
if (!conn) return;
if (!Array.isArray(conn[field])) conn[field] = [];
if (!conn[field].some((v) => String(v).trim().toLowerCase() === key.trim().toLowerCase())) {
conn[field].push(key);
}
queueSave();
import('./connections.js').then((m) => m.renderConnections());
renderOverview();
});
});
}

// Several facets can't be expressed in the single search box, so drill-down
// hands the connections list an explicit set of ids instead.
function applyToList() {
import('./connections.js').then((m) => {
if (!drillDown || facets.length === 0) { m.clearFilters(); return; }
const dims = dimensions();
const matching = connectionsMatching(dims);
m.filterByIds(matching.map((c) => c.id), facets.map((f) => `${f.title}: ${f.key}`).join(' + '));
});
}

export { renderOverview, initOverviewPrefs };
