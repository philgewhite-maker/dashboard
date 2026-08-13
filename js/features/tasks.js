// A GTD-shaped task system: capture without thinking, decide where things
// belong as a separate deliberate step, then work from context-filtered
// lists.
//
// Two design choices worth knowing:
//
// 1. Filing is available by BOTH drag-and-drop and plain controls. Drag is
//    nicer with a mouse, but HTML5 drag-and-drop is unreliable-to-absent on
//    touch, and this dashboard gets used on a phone constantly — so the
//    dropdowns are the real interface and dragging is an enhancement on top,
//    never the only way to do something.
//
// 2. `bringForward` hides a task from the active lists until its date. That
//    is the point of a tickler: something you genuinely cannot act on until
//    March should not be adding noise in January.
import { data, queueSave, TASK_BUCKETS, blankTask } from '../state.js';
import { photoPut, photoDelete } from '../db.js';
import { uid, todayStr, escapeHtml, hydratePhotos, resizeImageToBlob, daysUntil, daysSince } from '../utils.js';

const BUCKET_LABEL = Object.fromEntries(TASK_BUCKETS.map((b) => [b.bucket, b.label]));
// Buckets shown as filing destinations. `done` is reached by ticking a task
// off, not by filing something into it.
const FILING_BUCKETS = TASK_BUCKETS.filter((b) => b.bucket !== 'done' && b.bucket !== 'inbox');

let contextFilter = 'all';
let showDone = false;
const expandedTasks = new Set();

function taskById(id) { return data.tasks.find((t) => t.id === id); }
function childrenOf(id) { return data.tasks.filter((t) => t.parentId === id); }

// A task is "dormant" while its bring-forward date is still in the future.
// It stays in the document and in the Scheduled list, but keeps out of the
// lists you work from.
function isDormant(t) {
return !!t.bringForward && daysUntil(t.bringForward) > 0;
}

function matchesContext(t) {
if (contextFilter === 'all') return true;
if (contextFilter === 'none') return (t.contexts || []).length === 0;
return (t.contexts || []).includes(contextFilter);
}

// ---- rendering pieces ----

function contextChipsHtml(t) {
const chips = (t.contexts || []).map((c) => `<span class="task-context">${escapeHtml(c)}<span class="tag-x" data-ctx-remove="${t.id}" data-ctx-name="${escapeHtml(c)}">&times;</span></span>`).join('');
const available = data.taskContexts.filter((c) => !(t.contexts || []).includes(c));
const adder = available.length
? `<select class="task-ctx-add" data-ctx-add="${t.id}">
<option value="">+ context</option>
${available.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')}
</select>`
: '';
return `<span class="task-contexts">${chips}${adder}</span>`;
}

function dateBadgeHtml(t) {
if (t.bucket === 'done') return '';
if (t.due) {
const dn = daysUntil(t.due);
const cls = dn < 0 ? 'overdue' : dn <= 2 ? 'soon' : '';
const text = dn < 0 ? `${-dn}d overdue` : dn === 0 ? 'Due today' : `due in ${dn}d`;
return `<span class="task-badge ${cls}">${text}</span>`;
}
if (isDormant(t)) return `<span class="task-badge dormant">back ${escapeHtml(t.bringForward)}</span>`;
return '';
}

function taskRowHtml(t, depth = 0) {
const kids = childrenOf(t.id);
const openDetail = expandedTasks.has(t.id);
const doneKids = kids.filter((k) => k.bucket === 'done').length;
return `<div class="task-row${t.bucket === 'done' ? ' done' : ''}${isDormant(t) ? ' dormant' : ''}" data-task-row="${t.id}" style="--depth:${depth};">
<div class="task-main">
<input type="checkbox" class="task-check" data-task-done="${t.id}" ${t.bucket === 'done' ? 'checked' : ''}>
<span class="task-title" data-task-expand="${t.id}">${escapeHtml(t.title || '(untitled)')}</span>
${kids.length ? `<span class="task-kidcount">${doneKids}/${kids.length}</span>` : ''}
${dateBadgeHtml(t)}
${contextChipsHtml(t)}
<span class="del-x" style="opacity:1;" data-task-del="${t.id}">&times;</span>
</div>
${openDetail ? taskDetailHtml(t) : ''}
${kids.map((k) => taskRowHtml(k, depth + 1)).join('')}
</div>`;
}

function taskDetailHtml(t) {
const photos = (t.photoIds || []).map((id, i) => `<div class="gallery-thumb"><span class="thumb-img" data-photo-id="${escapeHtml(id)}"></span><span class="tag-x" data-task-photo-remove="${t.id}" data-photo-idx="${i}">&times;</span></div>`).join('');
return `<div class="task-detail">
<label class="full">Title<input type="text" data-task-field="title" data-task-id="${t.id}" value="${escapeHtml(t.title)}"></label>
<label class="full">Notes<textarea rows="2" data-task-field="notes" data-task-id="${t.id}">${escapeHtml(t.notes || '')}</textarea></label>
<div class="task-detail-grid">
<label>List<select data-task-field="bucket" data-task-id="${t.id}">
${TASK_BUCKETS.map((b) => `<option value="${b.bucket}"${b.bucket === t.bucket ? ' selected' : ''}>${escapeHtml(b.label)}</option>`).join('')}
</select></label>
<label>Due<input type="date" data-task-field="due" data-task-id="${t.id}" value="${escapeHtml(t.due || '')}"></label>
<label>Bring forward<input type="date" data-task-field="bringForward" data-task-id="${t.id}" value="${escapeHtml(t.bringForward || '')}"></label>
<label>Part of<select data-task-field="parentId" data-task-id="${t.id}">
<option value="">— nothing —</option>
${data.tasks.filter((o) => o.id !== t.id && o.parentId !== t.id).map((o) => `<option value="${o.id}"${o.id === t.parentId ? ' selected' : ''}>${escapeHtml(o.title || '(untitled)')}</option>`).join('')}
</select></label>
</div>
<label class="full">Reference link (OneNote, doc, anything)<input type="text" placeholder="https://…" data-task-field="link" data-task-id="${t.id}" value="${escapeHtml(t.link || '')}"></label>
${t.link ? `<a class="task-link" href="${escapeHtml(t.link)}" target="_blank" rel="noopener">Open reference &#8599;</a>` : ''}
${t.source ? `<div class="task-source">From ${escapeHtml(t.source.kind)}: ${t.source.url ? `<a href="${escapeHtml(t.source.url)}" target="_blank" rel="noopener">${escapeHtml(t.source.label)}</a>` : escapeHtml(t.source.label)}</div>` : ''}
<div class="task-photos">${photos}<label class="gallery-add" for="task-photo-${t.id}">+</label>
<input type="file" id="task-photo-${t.id}" accept="image/*" multiple style="display:none;" data-task-photo-add="${t.id}"></div>
<button class="todo-add-btn" type="button" data-task-addsub="${t.id}">+ Subtask</button>
${notionPanel.html(t)}
</div>`;
}

// notionplan.js imports from here, so it registers its renderer rather than
// being imported back — same one-way pattern as the contacts picker.
let notionPanel = { html: () => '', bind: () => {} };
function setNotionPanel(html, bind) { notionPanel = { html, bind }; }

// ---- the three panels ----

function renderCapture() {
const el = document.getElementById('task-contexts-list');
if (!el) return;
el.innerHTML = data.taskContexts.map((c) => `<span class="tag-chip">${escapeHtml(c)}<span class="tag-x" data-delctx="${escapeHtml(c)}">&times;</span></span>`).join('')
+ '<input type="text" class="tag-add-input" id="new-context-input" placeholder="+ add context">';
el.querySelectorAll('[data-delctx]').forEach((x) => {
x.addEventListener('click', () => {
const name = x.dataset.delctx;
data.taskContexts = data.taskContexts.filter((c) => c !== name);
// Leaving the context on tasks would show a chip you can no longer
// filter by or re-add, so strip it everywhere.
data.tasks.forEach((t) => { t.contexts = (t.contexts || []).filter((c) => c !== name); });
renderTasks();
queueSave();
});
});
const input = el.querySelector('#new-context-input');
input.addEventListener('keydown', (e) => {
if (e.key !== 'Enter') return;
e.preventDefault();
const name = input.value.trim();
if (!name || data.taskContexts.some((c) => c.toLowerCase() === name.toLowerCase())) { input.value = ''; return; }
data.taskContexts.push(name);
renderTasks();
queueSave();
});
}

// The allocation workspace: everything still in the Inbox, each with a
// one-tap route to a bucket, plus drop zones for mouse users.
function renderInbox() {
const el = document.getElementById('task-inbox');
const inbox = data.tasks.filter((t) => t.bucket === 'inbox');
document.getElementById('inbox-count').textContent = inbox.length ? `${inbox.length} to file` : 'empty';
if (inbox.length === 0) {
el.innerHTML = '<div class="empty">Inbox clear. Anything you capture lands here to be filed.</div>';
return;
}
el.innerHTML = `<div class="alloc-grid">
<div class="alloc-cards">
${inbox.map((t) => `<div class="alloc-card" draggable="true" data-alloc-card="${t.id}">
<div class="alloc-title">${escapeHtml(t.title || '(untitled)')}</div>
${t.notes ? `<div class="alloc-notes">${escapeHtml(t.notes)}</div>` : ''}
${(t.photoIds || []).length ? `<div class="alloc-photo"><span class="thumb-img" data-photo-id="${escapeHtml(t.photoIds[0])}"></span></div>` : ''}
${t.source ? `<div class="alloc-source">from ${escapeHtml(t.source.kind)}</div>` : ''}
<div class="alloc-controls">
<select data-alloc-bucket="${t.id}">
<option value="">File to…</option>
${FILING_BUCKETS.map((b) => `<option value="${b.bucket}">${escapeHtml(b.label)}</option>`).join('')}
</select>
${contextChipsHtml(t)}
</div>
</div>`).join('')}
</div>
<div class="alloc-targets">
${FILING_BUCKETS.map((b) => `<div class="alloc-target" data-drop-bucket="${b.bucket}">
<strong>${escapeHtml(b.label)}</strong>
<span>${escapeHtml(b.hint)}</span>
</div>`).join('')}
</div>
</div>`;
hydratePhotos(el);
bindAllocation(el);
}

function renderLists() {
const el = document.getElementById('task-lists');
const active = data.tasks.filter((t) => t.bucket !== 'inbox' && t.parentId === null);
const sections = TASK_BUCKETS.filter((b) => b.bucket !== 'inbox').map((b) => {
if (b.bucket === 'done' && !showDone) return '';
let items = active.filter((t) => t.bucket === b.bucket && matchesContext(t));
// Dormant items live in their own section rather than cluttering the
// list you actually work from.
if (b.bucket !== 'done') items = items.filter((t) => !isDormant(t));
if (items.length === 0) return '';
items = [...items].sort((a, b2) => {
const ad = a.due ? daysUntil(a.due) : Infinity;
const bd = b2.due ? daysUntil(b2.due) : Infinity;
return ad - bd;
});
return `<div class="task-section">
<h3>${escapeHtml(b.label)} <span class="task-section-count">${items.length}</span></h3>
${items.map((t) => taskRowHtml(t)).join('')}
</div>`;
}).filter(Boolean).join('');

const dormant = data.tasks.filter((t) => t.bucket !== 'done' && isDormant(t));
const dormantHtml = dormant.length ? `<div class="task-section">
<h3>Scheduled to surface <span class="task-section-count">${dormant.length}</span></h3>
${dormant.sort((a, b) => daysUntil(a.bringForward) - daysUntil(b.bringForward)).map((t) => taskRowHtml(t)).join('')}
</div>` : '';

el.innerHTML = (sections + dormantHtml) || '<div class="empty">Nothing filed yet — capture something above, then file it from the Inbox.</div>';
hydratePhotos(el);
bindTaskRows(el);
}

function renderTasks() {
renderCapture();
renderContextFilter();
renderInbox();
renderLists();
}

function renderContextFilter() {
const el = document.getElementById('task-filter');
if (!el) return;
const counts = {};
data.tasks.forEach((t) => {
if (t.bucket === 'done' || t.bucket === 'inbox' || isDormant(t)) return;
(t.contexts || []).forEach((c) => { counts[c] = (counts[c] || 0) + 1; });
});
const chip = (value, label, count) => `<button class="overview-chip${contextFilter === value ? ' active' : ''}" data-ctx-filter="${escapeHtml(value)}">${escapeHtml(label)}${count === undefined ? '' : ` (${count})`}</button>`;
el.innerHTML = chip('all', 'All')
+ data.taskContexts.map((c) => chip(c, c, counts[c] || 0)).join('')
+ chip('none', 'No context');
el.querySelectorAll('[data-ctx-filter]').forEach((b) => {
b.addEventListener('click', () => {
contextFilter = b.dataset.ctxFilter;
renderContextFilter();
renderLists();
});
});
}

// ---- event wiring ----

function bindAllocation(root) {
root.querySelectorAll('[data-alloc-bucket]').forEach((sel) => {
sel.addEventListener('change', () => {
fileTask(sel.dataset.allocBucket, sel.value);
});
});
bindContextControls(root);

root.querySelectorAll('[data-alloc-card]').forEach((card) => {
card.addEventListener('dragstart', (e) => {
e.dataTransfer.setData('text/plain', card.dataset.allocCard);
e.dataTransfer.effectAllowed = 'move';
card.classList.add('dragging');
});
card.addEventListener('dragend', () => card.classList.remove('dragging'));
});
root.querySelectorAll('[data-drop-bucket]').forEach((zone) => {
zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
zone.addEventListener('dragleave', () => zone.classList.remove('over'));
zone.addEventListener('drop', (e) => {
e.preventDefault();
zone.classList.remove('over');
fileTask(e.dataTransfer.getData('text/plain'), zone.dataset.dropBucket);
});
});
}

function fileTask(taskId, bucket) {
if (!bucket) return;
const t = taskById(taskId);
if (!t) return;
t.bucket = bucket;
renderTasks();
queueSave();
}

function bindContextControls(root) {
root.querySelectorAll('[data-ctx-add]').forEach((sel) => {
sel.addEventListener('change', () => {
const t = taskById(sel.dataset.ctxAdd);
if (!t || !sel.value) return;
if (!t.contexts.includes(sel.value)) t.contexts.push(sel.value);
renderTasks();
queueSave();
});
});
root.querySelectorAll('[data-ctx-remove]').forEach((x) => {
x.addEventListener('click', () => {
const t = taskById(x.dataset.ctxRemove);
if (!t) return;
t.contexts = t.contexts.filter((c) => c !== x.dataset.ctxName);
renderTasks();
queueSave();
});
});
}

function bindTaskRows(root) {
bindContextControls(root);
notionPanel.bind(root, renderTasks);

root.querySelectorAll('[data-task-done]').forEach((cb) => {
cb.addEventListener('change', () => {
const t = taskById(cb.dataset.taskDone);
if (!t) return;
if (cb.checked) {
t.bucket = 'done';
t.completedAt = new Date().toISOString();
} else {
// Un-ticking has to land somewhere sensible; "next action" is the
// most likely thing you meant, and it's one tap to move it on.
t.bucket = 'next';
t.completedAt = '';
}
renderTasks();
queueSave();
});
});

root.querySelectorAll('[data-task-expand]').forEach((el) => {
el.addEventListener('click', () => {
const id = el.dataset.taskExpand;
if (expandedTasks.has(id)) expandedTasks.delete(id); else expandedTasks.add(id);
renderLists();
});
});

root.querySelectorAll('[data-task-field]').forEach((input) => {
input.addEventListener('change', () => {
const t = taskById(input.dataset.taskId);
if (!t) return;
const field = input.dataset.taskField;
if (field === 'parentId') {
// Guard against making a task its own ancestor, which would recurse
// forever when rendering the tree.
const wouldCycle = (candidate) => {
let cursor = candidate ? taskById(candidate) : null;
while (cursor) {
if (cursor.id === t.id) return true;
cursor = cursor.parentId ? taskById(cursor.parentId) : null;
}
return false;
};
t.parentId = wouldCycle(input.value) ? null : (input.value || null);
} else {
t[field] = input.value;
}
renderTasks();
queueSave();
});
});

root.querySelectorAll('[data-task-del]').forEach((x) => {
x.addEventListener('click', async () => {
const t = taskById(x.dataset.taskDel);
if (!t) return;
const kids = childrenOf(t.id);
const msg = kids.length
? `Delete "${t.title}" and its ${kids.length} subtask${kids.length === 1 ? '' : 's'}?`
: `Delete "${t.title}"?`;
if (!confirm(msg)) return;
const doomed = [t.id, ...kids.map((k) => k.id)];
for (const id of doomed) {
const task = taskById(id);
for (const pid of (task?.photoIds || [])) await photoDelete(pid);
}
data.tasks = data.tasks.filter((x2) => !doomed.includes(x2.id));
renderTasks();
queueSave();
});
});

root.querySelectorAll('[data-task-addsub]').forEach((btn) => {
btn.addEventListener('click', () => {
const parent = taskById(btn.dataset.taskAddsub);
if (!parent) return;
const sub = blankTask({ title: 'New subtask', bucket: 'next', parentId: parent.id, contexts: [...parent.contexts] });
data.tasks.push(sub);
expandedTasks.add(sub.id);
renderTasks();
queueSave();
});
});

root.querySelectorAll('[data-task-photo-add]').forEach((input) => {
input.addEventListener('change', async (e) => {
const t = taskById(input.dataset.taskPhotoAdd);
const files = Array.from(e.target.files);
e.target.value = '';
if (!t) return;
for (const file of files.slice(0, 6 - (t.photoIds || []).length)) {
try {
const blob = await resizeImageToBlob(file, 1200, 0.85);
const id = uid();
await photoPut(id, blob);
t.photoIds.push(id);
} catch (err) { console.error('Could not attach task photo:', err); }
}
renderTasks();
queueSave();
});
});

root.querySelectorAll('[data-task-photo-remove]').forEach((x) => {
x.addEventListener('click', async () => {
const t = taskById(x.dataset.taskPhotoRemove);
if (!t) return;
const [removed] = t.photoIds.splice(parseInt(x.dataset.photoIdx, 10), 1);
if (removed) await photoDelete(removed);
renderTasks();
queueSave();
});
});
}

// ---- capture ----

// Exported so Mail and Calendar rows can push straight into the Inbox,
// carrying a link back to whatever prompted the task.
function captureTask({ title, notes = '', source = null, photoIds = [] }) {
const task = blankTask({ title, notes, source, photoIds });
data.tasks.push(task);
renderTasks();
queueSave();
return task;
}

function initTasks() {
const input = document.getElementById('capture-input');
const status = document.getElementById('capture-status');

const submit = () => {
const title = input.value.trim();
if (!title) return;
captureTask({ title });
input.value = '';
status.textContent = 'Captured to Inbox.';
setTimeout(() => { status.textContent = ''; }, 2000);
};
document.getElementById('capture-btn').addEventListener('click', submit);
input.addEventListener('keydown', (e) => {
if (e.key === 'Enter') { e.preventDefault(); submit(); }
});

document.getElementById('capture-photo-input').addEventListener('change', async (e) => {
const files = Array.from(e.target.files);
e.target.value = '';
if (files.length === 0) return;
status.textContent = 'Saving…';
const photoIds = [];
for (const file of files) {
try {
const blob = await resizeImageToBlob(file, 1200, 0.85);
const id = uid();
await photoPut(id, blob);
photoIds.push(id);
} catch (err) { console.error('Could not save captured photo:', err); }
}
if (photoIds.length === 0) { status.textContent = "Couldn't read those images."; return; }
captureTask({ title: input.value.trim() || `Screenshot ${todayStr()}`, photoIds, source: { kind: 'photo', label: 'Captured image' } });
input.value = '';
status.textContent = `Captured ${photoIds.length} image${photoIds.length === 1 ? '' : 's'} to Inbox.`;
setTimeout(() => { status.textContent = ''; }, 3000);
});

document.getElementById('show-done-toggle').addEventListener('change', (e) => {
showDone = e.target.checked;
renderLists();
});
}

export { renderTasks, initTasks, captureTask, isDormant, setNotionPanel };
