// Bulk-fills the "photos person link" field on connections from Google
// Photos' face groups.
//
// Why paste rather than fetch: Google Photos has no API for face groups at
// all — the Library API was withdrawn in March 2025 and its replacement, the
// Picker API, exposes neither people nor albums. The names and links only
// exist in the web page's DOM. So the browser you're already signed into
// does the reading, and the dashboard does the matching.
import { data, queueSave } from '../state.js';
import { escapeHtml } from '../utils.js';
import { nameKey, editDistance } from '../googlecontacts.js';

// Google Photos face-group URLs carry the group id, whose base64 always
// contains AF1Qip. The three shortcut tiles at the top of the people page
// (Favourites, Videos, Recently added) don't, which is what separates a
// person from a saved search without hard-coding English tile names.
function looksLikePerson(url) {
return /QUYxUWlw|AF1Qip/.test(String(url || ''));
}

// Accepts what the snippet copies (JSON), and also a plain two-column paste
// out of a spreadsheet, because that's the obvious thing to try.
function parseInput(text) {
const trimmed = String(text || '').trim();
if (!trimmed) return [];
if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
const parsed = JSON.parse(trimmed);
const rows = Array.isArray(parsed) ? parsed : (parsed.rows || parsed.people || []);
return rows
.map((r) => ({ label: String(r.label || r.name || '').trim(), url: String(r.href || r.url || '').trim() }))
.filter((r) => r.label && r.url);
}
return trimmed.split(/\r?\n/).map((line) => {
const [label, url] = line.split(/\t|\s{2,}|,(?=https?:)/);
return { label: String(label || '').trim(), url: String(url || '').trim() };
}).filter((r) => r.label && r.url);
}

// Best connection for a face-group name. Exact on any known name first —
// including aliases and the dating-profile name, which is exactly the case
// aliases were added for. Only then the loose pass, and a loose hit is
// always presented as a guess rather than applied.
function bestMatch(label) {
const key = nameKey(label);
if (!key) return null;

const namesOf = (c) => [c.name, c.profileName, ...(c.aliases || [])].filter(Boolean);
const exact = data.connections.find((c) => namesOf(c).some((n) => nameKey(n) === key));
if (exact) return { conn: exact, why: 'exact', score: 200 };

// Face groups are often labelled with a qualifier the dashboard doesn't
// have — "Katya PDN", "Aya Tinder", "Irina UK". Matching on the first word
// picks those up.
const first = key.split(' ')[0];
let best = null;
data.connections.forEach((c) => {
namesOf(c).forEach((n) => {
const nk = nameKey(n);
const nf = nk.split(' ')[0];
let score = null;
let why = '';
if (nk === first || nf === key) { score = 150; why = 'name without the label suffix'; }
else if (nf.length >= 3 && first.length >= 3 && (nf.startsWith(first) || first.startsWith(nf))) {
score = 100 - Math.abs(nf.length - first.length); why = 'shortened name';
} else if (first.length >= 4) {
const d = editDistance(first, nf, 2);
if (d <= 2) { score = 60 - d * 10; why = `${d} letter${d === 1 ? '' : 's'} different`; }
}
if (score !== null && (!best || score > best.score)) best = { conn: c, why, score };
});
});
return best;
}

let rows = [];

function optionsFor(row) {
const chosen = row.chosenId;
const opts = data.connections
.slice()
.sort((a, b) => a.name.localeCompare(b.name))
.map((c) => `<option value="${escapeHtml(c.id)}"${c.id === chosen ? ' selected' : ''}>${escapeHtml(c.name)}${c.photosPersonUrl ? ' — has a link' : ''}</option>`)
.join('');
return `<option value=""${chosen ? '' : ' selected'}>— skip —</option>${opts}`;
}

function rowHtml(row, i) {
const conn = row.chosenId ? data.connections.find((c) => c.id === row.chosenId) : null;
const clash = conn && conn.photosPersonUrl && conn.photosPersonUrl !== row.url;
return `<div class="scan-row${row.applied ? ' chosen' : ''}">
<span class="scan-main">
<span class="scan-name">${escapeHtml(row.label)}</span>
<span class="scan-meta">
${row.match ? `${escapeHtml(row.match.why)}` : 'no match found'}
${clash ? ' · <strong>would replace an existing link</strong>' : ''}
${row.applied ? ' · <strong>saved</strong>' : ''}
</span>
</span>
<span class="scan-actions">
<select data-link-pick="${i}">${optionsFor(row)}</select>
</span>
</div>`;
}

function render() {
const el = document.getElementById('photolinks-results');
if (!el) return;
const count = document.getElementById('photolinks-count');
if (rows.length === 0) {
if (count) count.textContent = '';
el.innerHTML = '';
return;
}
const ready = rows.filter((r) => r.chosenId && !r.applied).length;
if (count) count.textContent = `${rows.length} people · ${ready} ready to link`;
el.innerHTML = `${rows.map(rowHtml).join('')}
<div class="sync-row" style="margin-top:10px;">
<button class="add-btn" type="button" id="photolinks-apply"${ready ? '' : ' disabled'}>Save ${ready} link${ready === 1 ? '' : 's'}</button>
</div>`;

el.querySelectorAll('[data-link-pick]').forEach((sel) => {
sel.addEventListener('change', () => {
const row = rows[parseInt(sel.dataset.linkPick, 10)];
row.chosenId = sel.value;
row.applied = false;
render();
});
});
const applyBtn = document.getElementById('photolinks-apply');
if (applyBtn) applyBtn.addEventListener('click', apply);
}

function apply() {
let n = 0;
rows.forEach((row) => {
if (!row.chosenId || row.applied) return;
const conn = data.connections.find((c) => c.id === row.chosenId);
if (!conn) return;
conn.photosPersonUrl = row.url;
// The face-group label is often a name he actually uses for her, so
// it's worth keeping — but only as an alias, never overwriting the name.
const known = [conn.name, conn.profileName, ...(conn.aliases || [])].map(nameKey);
if (!known.includes(nameKey(row.label))) conn.aliases.push(row.label);
row.applied = true;
n++;
});
if (n === 0) return;
queueSave();
document.getElementById('photolinks-status').textContent = `Linked ${n} connection${n === 1 ? '' : 's'} to a Google Photos face group.`;
Promise.all([import('./connections.js'), import('./overview.js')])
.then(([c, o]) => { c.renderConnections(); o.renderOverview(); });
render();
}

function initPhotoLinks() {
const box = document.getElementById('photolinks-input');
if (!box) return;
const status = document.getElementById('photolinks-status');

document.getElementById('photolinks-match-btn').addEventListener('click', () => {
let parsed;
try {
parsed = parseInput(box.value);
} catch (err) {
status.textContent = `Couldn't read that: ${err.message}. Paste the JSON the snippet copied, or Name<tab>URL per line.`;
return;
}
const people = parsed.filter((p) => looksLikePerson(p.url));
const dropped = parsed.length - people.length;
rows = people.map((p) => {
const match = bestMatch(p.label);
return { ...p, match, chosenId: match ? match.conn.id : '', applied: false };
});
const matched = rows.filter((r) => r.chosenId).length;
status.textContent = rows.length === 0
? 'Nothing that looked like a face group in that paste.'
: `${rows.length} face group${rows.length === 1 ? '' : 's'} · ${matched} matched to a connection${dropped ? ` · ${dropped} non-person tile${dropped === 1 ? '' : 's'} ignored` : ''}. Check each one, then save.`;
render();
});

document.getElementById('photolinks-clear-btn').addEventListener('click', () => {
box.value = '';
rows = [];
status.textContent = '';
render();
});

const copyBtn = document.getElementById('photolinks-copy-snippet');
if (copyBtn) {
copyBtn.addEventListener('click', async () => {
const snippet = document.getElementById('photolinks-snippet').textContent;
try {
await navigator.clipboard.writeText(snippet);
copyBtn.textContent = 'Copied';
setTimeout(() => { copyBtn.textContent = 'Copy snippet'; }, 2000);
} catch (err) {
status.textContent = 'Copy failed — select the snippet and copy it manually.';
}
});
}
render();
}

export { initPhotoLinks, parseInput, bestMatch, looksLikePerson };
