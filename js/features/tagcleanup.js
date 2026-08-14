// Fixes tag values that already drifted apart. The autocomplete added to the
// tag inputs only prevents NEW variants — anything already recorded as both
// "Sporty" and "sporty" stays split, grouping separately in Connections
// Overview and matching different searches.
//
// Two levels of help: groups that differ only by case or spacing are flagged
// automatically with a one-click merge, and everything else can be renamed
// or merged by hand.
import { data, queueSave, TAG_FIELDS } from '../state.js';
import { escapeHtml } from '../utils.js';

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

// Tag changes show up in the connection cards and in Connections Overview,
// so both need redrawing, not just this panel.
function afterChange() {
queueSave();
renderTagCleanup();
Promise.all([import('./connections.js'), import('./overview.js')])
.then(([conns, overview]) => { conns.renderConnections(); overview.renderOverview(); });
}

export { renderTagCleanup, duplicateGroups, renameValue };
