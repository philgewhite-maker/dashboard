import { data, queueSave } from '../state.js';
import { uid, todayStr, escapeHtml, bindForm, scrollAndFlash } from '../utils.js';
import { captureTask, revealTask } from './tasks.js';

// "Done" is for an idea that was carried through (a Project that finished),
// so it can be retired without reading as abandoned like Shelved does.
const STATUSES = ['Idea', 'Exploring', 'Building', 'Done', 'Shelved'];
// Live ideas first, then finished ones, then shelved ones; newest first within each.
const STATUS_RANK = { Idea: 0, Exploring: 0, Building: 0, Done: 1, Shelved: 2 };

// An idea turned into a Project whose Project has since been completed
// becomes Done by itself, instead of staying "Building" forever.
function syncIdeasFromTasks() {
let changed = false;
data.businessIdeas.forEach((idea) => {
if (!idea.taskId || idea.status !== 'Building') return;
const task = data.tasks.find((t) => t.id === idea.taskId);
if (task && task.bucket === 'done') { idea.status = 'Done'; changed = true; }
});
if (changed) queueSave();
}

// How far the linked Project/task has got, read from the real tasks so it
// never goes stale: "3 of 5 steps done" for a Project with steps, otherwise
// whether the task itself is done.
function ideaProgressText(idea) {
const task = data.tasks.find((t) => t.id === idea.taskId);
if (!task) return '';
const steps = data.tasks.filter((t) => t.parentId === task.id);
if (steps.length) return `${steps.filter((t) => t.bucket === 'done').length} of ${steps.length} steps done`;
return task.bucket === 'done' ? 'Done' : '';
}

// Same {id, text, done} shape as a connection's own todos (connections.js)
// -- fleshing an idea out before it's real enough for the actual GTD lists
// needs a checklist, not a fresh shape invented for this. Deliberately no
// due dates here; that pressure only starts once a step becomes a real
// subtask (see ideaUpgradeHtml below).
function ideaStepsHtml(idea) {
const items = (idea.steps || []).map((s) => `<div class="todo-item ${s.done ? 'done' : ''}"><input type="checkbox" ${s.done ? 'checked' : ''} data-idea-step-toggle="${idea.id}" data-step-id="${s.id}"><span>${escapeHtml(s.text)}</span><span class="tag-x" data-idea-step-remove="${idea.id}" data-step-id="${s.id}">&times;</span></div>`).join('');
return `<div class="todo-list">${items}</div>
<div class="todo-add-row">
<input type="text" autocomplete="off" placeholder="e.g. Register the domain" data-idea-step-input="${idea.id}">
<button class="todo-add-btn" type="button" data-idea-step-add="${idea.id}">Add</button>
</div>`;
}

// While the idea hasn't become a real task yet: two always-available
// buttons rather than trying to infer Project vs plain task from the step
// count -- with no steps recorded on any idea yet, that inference has
// nothing to go on. Once it HAS become one, this collapses to the
// standard record-reference link (CLAUDE.md's convention) instead of
// staying a set of buttons, so re-clicking can't spawn a second task for
// the same idea.
function ideaUpgradeHtml(idea) {
if (idea.taskId) {
const task = data.tasks.find((t) => t.id === idea.taskId);
const noun = task && task.bucket === 'project' ? 'Project' : 'task';
const progress = ideaProgressText(idea);
return `<span class="inline-goto-link" data-idea-open-task="${idea.taskId}">&rarr; Now tracked as a ${noun} -- open it</span>${progress ? `<span class="idea-progress">${escapeHtml(progress)}</span>` : ''}`;
}
return `<div class="idea-upgrade-row">
<button class="sync-btn" type="button" data-idea-upgrade="${idea.id}" data-upgrade-bucket="project">Turn into Project</button>
<button class="sync-btn" type="button" data-idea-upgrade="${idea.id}" data-upgrade-bucket="next">Turn into Task</button>
</div>`;
}

function renderBusinessIdeas() {
const list = document.getElementById('ideas-list');
document.getElementById('ideas-count').textContent = data.businessIdeas.length + (data.businessIdeas.length === 1 ? ' idea' : ' ideas');
if (data.businessIdeas.length === 0) {
list.innerHTML = '<div class="empty">No ideas logged yet. Add one above.</div>';
return;
}
syncIdeasFromTasks();
const sorted = [...data.businessIdeas].sort((a, b) => ((STATUS_RANK[a.status] ?? 0) - (STATUS_RANK[b.status] ?? 0)) || b.date.localeCompare(a.date));
list.innerHTML = sorted.map((idea) => `
<div class="idea-row${idea.status === 'Shelved' || idea.status === 'Done' ? ' idea-closed' : ''}" data-idea-row="${idea.id}">
<div class="idea-top">
<input type="text" autocomplete="off" class="voucher-edit idea-title-edit" data-idea-field="title" data-idea-id="${idea.id}" value="${escapeHtml(idea.title)}" placeholder="Idea title">
<span class="idea-date">${escapeHtml(idea.date)}</span>
</div>
<textarea class="voucher-edit idea-notes-edit" data-idea-field="notes" data-idea-id="${idea.id}" rows="${Math.min(8, Math.max(2, String(idea.notes || '').split('\n').length))}" placeholder="Notes">${escapeHtml(idea.notes)}</textarea>
${idea.taskId ? '' : `<div class="field-block">
<span class="field-label">Steps</span>
${ideaStepsHtml(idea)}
</div>`}
${ideaUpgradeHtml(idea)}
<div class="idea-actions">
<select class="idea-status" data-idea-status="${idea.id}">
${STATUSES.map((s) => `<option value="${s}" ${s === idea.status ? 'selected' : ''}>${s}</option>`).join('')}
</select>
<span class="del-x" style="opacity:1;" data-del-idea="${idea.id}">&times;</span>
</div>
</div>
`).join('');

list.querySelectorAll('[data-idea-status]').forEach((sel) => {
sel.addEventListener('change', () => {
const idea = data.businessIdeas.find((x) => x.id === sel.dataset.ideaStatus);
idea.status = sel.value;
renderBusinessIdeas();
queueSave();
});
});
// Title and note are edited in place. A title can't be emptied (it names
// the idea), so a blank one goes back to what it was.
list.querySelectorAll('[data-idea-field]').forEach((el) => {
el.addEventListener('change', () => {
const idea = data.businessIdeas.find((x) => x.id === el.dataset.ideaId);
if (!idea) return;
const value = el.value.trim();
if (el.dataset.ideaField === 'title' && !value) { renderBusinessIdeas(); return; }
idea[el.dataset.ideaField] = value;
queueSave();
});
});
list.querySelectorAll('[data-del-idea]').forEach((el) => {
el.addEventListener('click', () => {
const idea = data.businessIdeas.find((x) => x.id === el.dataset.delIdea);
const kept = idea.taskId && data.tasks.some((t) => t.id === idea.taskId) ? ' The Project or task made from it stays in Tasks.' : '';
if (!confirm(`Delete idea "${idea.title}"?${kept}`)) return;
data.businessIdeas = data.businessIdeas.filter((x) => x.id !== el.dataset.delIdea);
renderBusinessIdeas();
queueSave();
});
});

// ---- steps checklist -- same toggle/remove/add trio connections.js's
// own todos use, just scoped by idea id instead of connection id.
list.querySelectorAll('[data-idea-step-toggle]').forEach((cb) => {
cb.addEventListener('change', () => {
const idea = data.businessIdeas.find((x) => x.id === cb.dataset.ideaStepToggle);
const step = idea && idea.steps.find((s) => s.id === cb.dataset.stepId);
if (!step) return;
step.done = cb.checked;
renderBusinessIdeas();
queueSave();
});
});
list.querySelectorAll('[data-idea-step-remove]').forEach((el) => {
el.addEventListener('click', () => {
const idea = data.businessIdeas.find((x) => x.id === el.dataset.ideaStepRemove);
if (!idea) return;
idea.steps = idea.steps.filter((s) => s.id !== el.dataset.stepId);
renderBusinessIdeas();
queueSave();
});
});
list.querySelectorAll('[data-idea-step-add]').forEach((btn) => {
btn.addEventListener('click', () => {
const idea = data.businessIdeas.find((x) => x.id === btn.dataset.ideaStepAdd);
const input = list.querySelector(`[data-idea-step-input="${btn.dataset.ideaStepAdd}"]`);
const val = input.value.trim();
if (!idea || !val) return;
idea.steps.push({ id: uid(), text: val, done: false });
input.value = '';
renderBusinessIdeas();
queueSave();
});
});
list.querySelectorAll('[data-idea-step-input]').forEach((input) => {
input.addEventListener('keydown', (e) => {
if (e.key !== 'Enter') return;
e.preventDefault();
list.querySelector(`[data-idea-step-add="${input.dataset.ideaStepInput}"]`).click();
});
});

// ---- upgrade to a real task/project ----
list.querySelectorAll('[data-idea-upgrade]').forEach((btn) => {
btn.addEventListener('click', () => {
const idea = data.businessIdeas.find((x) => x.id === btn.dataset.ideaUpgrade);
if (!idea || idea.taskId) return; // already upgraded -- button shouldn't still be showing, but don't double-create
const bucket = btn.dataset.upgradeBucket; // 'project' or 'next'
const project = captureTask({ title: idea.title, notes: idea.notes, bucket, source: { kind: 'business idea', label: idea.title, ideaId: idea.id } });
// Each step becomes its own real subtask -- a step already ticked off
// keeps that history instead of starting the new task's checklist from
// scratch, same done-state tasks.js's own toggle sets (bucket:'done' +
// completedAt), not a separate "done" flag real tasks don't have.
idea.steps.forEach((step) => {
const sub = captureTask({ title: step.text, bucket: 'next', parentId: project.id });
if (step.done) { sub.bucket = 'done'; sub.completedAt = new Date().toISOString(); }
});
idea.taskId = project.id;
idea.status = 'Building';
renderBusinessIdeas();
queueSave();
});
});
list.querySelectorAll('[data-idea-open-task]').forEach((el) => {
el.addEventListener('click', async () => {
const { switchTab } = await import('../tabs.js');
switchTab('tasks');
revealTask(el.dataset.ideaOpenTask);
});
});
}

function initIdeaForm() {
bindForm('idea-form', () => {
const titleInput = document.getElementById('idea-title-input');
const notesInput = document.getElementById('idea-notes-input');
const title = titleInput.value.trim();
if (!title) return;
const newId = uid();
data.businessIdeas.push({ id: newId, title, date: todayStr(), notes: notesInput.value.trim(), status: 'Idea', steps: [], taskId: '' });
titleInput.value = '';
notesInput.value = '';
renderBusinessIdeas();
queueSave();
setTimeout(() => scrollAndFlash(`[data-idea-row="${newId}"]`), 50);
});
}

export { renderBusinessIdeas, initIdeaForm };
