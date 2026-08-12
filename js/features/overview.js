import { data, queueSave, getLocalSettings, setLocalSetting } from '../state.js';
import { escapeHtml } from '../utils.js';
import { visibleTagFields } from './connections.js';

// Which sections are folded away, and which chip (if any) is expanded for
// bulk-assignment. Collapsed state is device-local and remembered across
// reloads; the open assigner is transient and resets on re-render.
let collapsed = {};
let openAssigner = null; // { field, key }

async function initOverviewPrefs() {
const settings = await getLocalSettings();
collapsed = settings.overviewCollapsed || {};
}

function ageDecade(age) {
const n = parseInt(age, 10);
if (isNaN(n)) return null;
return `${Math.floor(n / 10) * 10}s`;
}

function groupConnectionsBy(getKeys) {
const groups = {};
data.connections.forEach((c) => {
const keys = getKeys(c);
keys.forEach((k) => {
if (!k) return;
if (!groups[k]) groups[k] = [];
groups[k].push(c);
});
});
return groups;
}

// `field` is the connection array property behind these chips, or null for
// derived groupings (stage, age decade) that aren't directly assignable.
function overviewDimension(title, groups, field) {
const keys = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);
if (keys.length === 0) return '';
const isCollapsed = !!collapsed[title];
const chips = keys.map((k) => {
const isOpen = openAssigner && openAssigner.field === field && openAssigner.key === k;
const assigner = isOpen ? assignerHtml(field, k, groups[k]) : '';
return `<span class="overview-chip-wrap">
<button class="overview-chip${isOpen ? ' active' : ''}" data-overview-key="${escapeHtml(k)}" data-overview-field="${escapeHtml(field || '')}">${escapeHtml(k)} (${groups[k].length})</button>
${assigner}
</span>`;
}).join('');
return `<div class="overview-group">
<button class="overview-head" type="button" data-collapse="${escapeHtml(title)}">
<span class="overview-caret">${isCollapsed ? '▸' : '▾'}</span>${escapeHtml(title)}
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
// Same-name connections are common enough (and the whole reason the merge
// flow exists) that age and source both earn their place here — without
// them two rows read as identical and you can't tell which you're picking.
.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}${c.age ? ', ' + escapeHtml(c.age) : ''}${c.app ? ' — ' + escapeHtml(c.app) : ''}</option>`)
.join('');
if (!options) return `<span class="assigner"><span class="assigner-note">Everyone already has this.</span></span>`;
return `<span class="assigner">
<select class="assigner-select" data-assign-field="${escapeHtml(field)}" data-assign-key="${escapeHtml(key)}">
<option value="">Add someone&hellip;</option>
${options}
</select>
<button class="todo-add-btn" type="button" data-assign-btn="1" data-assign-field="${escapeHtml(field)}" data-assign-key="${escapeHtml(key)}">Add</button>
</span>`;
}

function renderOverview() {
const el = document.getElementById('overview-content');
if (data.connections.length === 0) {
el.innerHTML = '<div class="empty">Add some connections to see them grouped here.</div>';
return;
}
const sections = [
overviewDimension('Stage', groupConnectionsBy((c) => [c.stage].filter(Boolean)), null),
overviewDimension('Location', groupConnectionsBy((c) => [c.location].filter(Boolean)), null),
overviewDimension('Age', groupConnectionsBy((c) => [ageDecade(c.age)].filter(Boolean)), null),
...visibleTagFields().map((f) => overviewDimension(f.label, groupConnectionsBy((c) => c[f.field] || []), f.field)),
];

el.innerHTML = sections.filter(Boolean).join('')
|| '<div class="empty">Add locations, languages, nationality, ages, or tags to your connections to see them grouped here.</div>';

el.querySelectorAll('[data-collapse]').forEach((head) => {
head.addEventListener('click', () => {
const title = head.dataset.collapse;
collapsed[title] = !collapsed[title];
setLocalSetting('overviewCollapsed', collapsed);
renderOverview();
});
});

el.querySelectorAll('.overview-chip').forEach((chip) => {
chip.addEventListener('click', () => {
const key = chip.dataset.overviewKey;
const field = chip.dataset.overviewField;
// Filtering the list below is the primary action and always happens;
// opening the assigner is the secondary one, and only for tag fields.
const searchInput = document.getElementById('conn-search');
searchInput.value = key;
searchInput.dispatchEvent(new Event('input'));
if (field) {
const alreadyOpen = openAssigner && openAssigner.field === field && openAssigner.key === key;
openAssigner = alreadyOpen ? null : { field, key };
renderOverview();
} else {
searchInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

export { renderOverview, initOverviewPrefs };
