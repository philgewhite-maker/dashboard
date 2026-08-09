import { data, queueSave, reachOutThreshold, isDormantStage } from '../state.js';
import { photoPut, photoDelete, photoUrl } from '../db.js';
import {
uid, todayStr, daysSince, escapeHtml, avatarHtml, hydratePhotos, scrollAndFlash, bindForm,
resizeImageToBlob,
} from '../utils.js';
import { MissingKeyError, extractMatchesFromScreenshot, extractProfileFromScreenshot } from '../ai.js';

const CONN_STAGES = ['Superswiped', 'Matched', 'Chatting in app', 'Moved to WhatsApp', 'Moved to Telegram', 'Arranged to meet', 'Met in person', 'Faded', 'Archived'];
const STAGE_RANK = { 'Met in person': 7, 'Arranged to meet': 6, 'Moved to Telegram': 5, 'Moved to WhatsApp': 4, 'Chatting in app': 3, Matched: 2, Superswiped: 1, Faded: 0, Archived: 0 };
const RATING_CATS = [['looks', 'Looks'], ['intelligence', 'Intelligence'], ['figure', 'Figure'], ['humour', 'Humour'], ['sex', 'Sex'], ['practicality', 'Practicality']];

let connectionSearchTerm = '';
let connectionSortPrimary = 'default';
let connectionSortSecondary = 'none';
const expandedConnections = new Set();

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

function tagChips(items, connId, field) {
return (items || []).map((t, i) => `<span class="tag-chip">${escapeHtml(t)}<span class="tag-x" data-tag-remove="${connId}" data-tag-field="${field}" data-tag-idx="${i}">&times;</span></span>`).join('')
+ `<input type="text" class="tag-add-input" placeholder="+ add" data-tag-add="${connId}" data-tag-field="${field}">`
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

function renderConnections() {
const list = document.getElementById('connections-list');
document.getElementById('connections-count').textContent = data.connections.length + (data.connections.length === 1 ? ' connection' : ' connections');
if (data.connections.length === 0) {
list.innerHTML = '<div class="empty">No matches logged yet. Add one below.</div>';
return;
}
const term = connectionSearchTerm.trim().toLowerCase();
const filtered = term ? data.connections.filter((c) => {
const haystack = [
c.name, c.location, c.job, c.stage, ageDecade(c.age),
...(c.tags || []), ...(c.languages || []), ...(c.nationality || []),
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

list.innerHTML = sorted.map((c) => {
const since = daysSince(c.lastContact);
const overdue = !isDormantStage(c.stage) && since >= reachOutThreshold(c.priority);
const stars = [1, 2, 3, 4, 5].map((n) => `<svg class="star priority-star ${n <= c.priority ? 'filled' : ''}" data-conn="${c.id}" data-star="${n}" viewBox="0 0 20 20" fill="currentColor"><path d="M10 1l2.6 5.9 6.4.6-4.8 4.3 1.4 6.2L10 14.9 4.4 18l1.4-6.2L1 7.5l6.4-.6z"/></svg>`).join('');
return `<div class="match-card" data-conn-row="${c.id}">
<div class="match-row">
${avatarHtml(c.photoId, c.name)}
<div class="match-id">
<div class="match-name">${escapeHtml(c.name)}${c.age ? ', ' + escapeHtml(c.age) : ''}</div>
<div class="app-tag">${escapeHtml(c.app)}</div>
</div>
<div class="stars">${stars}</div>
<div class="match-stage">
<select data-conn-stage="${c.id}">
${CONN_STAGES.map((s) => `<option value="${s}" ${s === c.stage ? 'selected' : ''}>${s}</option>`).join('')}
</select>
</div>
<div class="match-actions">
<span class="match-contact">${since === 0 ? 'today' : since + 'd since contact'}</span>
${overdue ? '<span class="reach-badge">Reach out</span>' : ''}
<button class="log-btn" data-log="${c.id}">Log contact</button>
<span class="del-x" style="opacity:1;" data-del-conn="${c.id}">&times;</span>
</div>
</div>
<details class="match-details" data-conn-details="${c.id}" ${expandedConnections.has(c.id) ? 'open' : ''}>
<summary>Details</summary>
<div class="details-grid">
<label>Age<input type="text" data-field="age" data-conn-detail="${c.id}" value="${escapeHtml(c.age || '')}"></label>
<label>Location<input type="text" data-field="location" data-conn-detail="${c.id}" value="${escapeHtml(c.location || '')}"></label>
<label>Kids<input type="text" data-field="kids" data-conn-detail="${c.id}" value="${escapeHtml(c.kids || '')}"></label>
<label>Job<input type="text" data-field="job" data-conn-detail="${c.id}" value="${escapeHtml(c.job || '')}"></label>
<label>What I like most<input type="text" data-field="likes" data-conn-detail="${c.id}" value="${escapeHtml(c.likes || '')}"></label>
<label class="full">Notes<textarea rows="2" data-field="notes" data-conn-detail="${c.id}">${escapeHtml(c.notes || '')}</textarea></label>
<label class="full">Languages<div class="tag-editor">${tagChips(c.languages, c.id, 'languages')}</div></label>
<label class="full">Nationality<div class="tag-editor">${tagChips(c.nationality, c.id, 'nationality')}</div></label>
<label class="full">Tags<div class="tag-editor">${tagChips(c.tags, c.id, 'tags')}</div></label>
<label class="full">Ratings<div class="ratings-block">${RATING_CATS.map(([cat, lbl]) => ratingStars(lbl, cat, c.id, (c.ratings && c.ratings[cat]) || 0)).join('')}</div></label>
<label class="full">Things to do<div>${todoListHtml(c)}</div></label>
<label class="full">Photos${galleryHtml(c)}</label>
<label class="full">Drive/OneDrive link (optional, for full-res photos filed elsewhere)<input type="text" placeholder="Paste a share link" data-field="driveLink" data-conn-detail="${c.id}" value="${escapeHtml(c.driveLink || '')}"></label>
${c.driveLink ? `<div class="full"><a href="${escapeHtml(c.driveLink)}" target="_blank" rel="noopener" style="font-size:12px;color:var(--rose);">Open full-res photos &#8599;</a></div>` : ''}
</div>
</details>
</div>`;
}).join('');

hydratePhotos(list);
bindConnectionEvents(list);
}

function bindConnectionEvents(list) {
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
if (el.dataset.field === 'age') {
const nameEl = el.closest('.match-card').querySelector('.match-name');
if (nameEl) nameEl.textContent = conn.name + (conn.age ? ', ' + conn.age : '');
}
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
const val = inputEl.value.trim().replace(/,$/, '');
if (!val) return;
const conn = data.connections.find((x) => x.id === connId);
if (!conn[field]) conn[field] = [];
conn[field].push(val);
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
bindForm('connection-form', () => {
const nameInput = document.getElementById('conn-name-input');
const appInput = document.getElementById('conn-app-input');
const name = nameInput.value.trim();
if (!name) return;
const newId = uid();
data.connections.push({
id: newId, name, app: appInput.value, priority: 3, stage: 'Matched', lastContact: todayStr(),
photoId: null, photoIds: [], age: '', location: '', kids: '', job: '', likes: '', notes: '',
languages: [], nationality: [], todos: [], tags: [], ratings: {}, driveLink: '',
});
nameInput.value = '';
renderConnections();
renderOverviewRef();
queueSave();
setTimeout(() => scrollAndFlash(`[data-conn-row="${newId}"]`), 50);
});

document.getElementById('conn-search').addEventListener('input', (e) => {
connectionSearchTerm = e.target.value;
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
const updateOptions = matches.map((m) => `<option value="update:${m.id}">Same person &mdash; update ${escapeHtml(m.name)} (${escapeHtml(existingMatchCaption(m))})</option>`).join('');
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

function initImport() {
const status = document.getElementById('import-status');
const candidateList = document.getElementById('candidate-list');

document.getElementById('import-file-input').addEventListener('change', async (e) => {
const file = e.target.files[0];
if (!file) return;
candidateList.innerHTML = '';
status.textContent = 'Reading screenshot…';
await withImportStatus(status, async () => {
const { candidates, truncated } = await extractMatchesFromScreenshot(file);
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
const results = await Promise.allSettled(files.map((f) => extractProfileFromScreenshot(f)));
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
? [cand.age, cand.job, (cand.languages || []).join('/'), cand.bio].filter(Boolean).join(' · ')
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
id, name: cand.name, app, priority: 3, stage: cand.stage || 'Matched', lastContact: todayStr(),
photoId, photoIds, age: cand.age || '', location: '', kids: cand.kids || '', job: cand.job || '',
likes: '', notes: cand.bio || '', languages: cand.languages || [], nationality: cand.nationality || [],
todos: [], tags: [], ratings: {}, driveLink: '',
});
}

async function applyCandidateUpdate(existing, cand, isProfile) {
const blobs = isProfile ? (cand.photoBlobs || []) : (cand.photoBlob ? [cand.photoBlob] : []);
for (const blob of blobs) {
const pid = uid();
await photoPut(pid, blob);
existing.photoIds.push(pid);
if (!existing.photoId) existing.photoId = pid;
}
if (cand.age) existing.age = cand.age;
// Only move the stage forward, never back — a screenshot re-import
// shouldn't undo progress you've logged manually since (e.g. re-scanning
// an old "New Matches" screenshot after you've already met up).
if (cand.stage && (STAGE_RANK[cand.stage] ?? 0) > (STAGE_RANK[existing.stage] ?? 0)) {
existing.stage = cand.stage;
}
if (isProfile) {
if (cand.job) existing.job = cand.job;
if (cand.kids) existing.kids = cand.kids;
if (cand.bio) existing.notes = existing.notes ? existing.notes + ' | ' + cand.bio : cand.bio;
(cand.languages || []).forEach((l) => { if (!existing.languages.includes(l)) existing.languages.push(l); });
(cand.nationality || []).forEach((n) => { if (!existing.nationality.includes(n)) existing.nationality.push(n); });
}
}

function expandConnection(id) {
expandedConnections.add(id);
renderConnections();
}

export { renderConnections, initConnectionForm, expandConnection, CONN_STAGES };
