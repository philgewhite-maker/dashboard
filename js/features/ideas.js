import { data, queueSave } from '../state.js';
import { uid, todayStr, escapeHtml, bindForm, scrollAndFlash } from '../utils.js';

const STATUSES = ['Idea', 'Exploring', 'Building', 'Shelved'];

function renderBusinessIdeas() {
const list = document.getElementById('ideas-list');
document.getElementById('ideas-count').textContent = data.businessIdeas.length + (data.businessIdeas.length === 1 ? ' idea' : ' ideas');
if (data.businessIdeas.length === 0) {
list.innerHTML = '<div class="empty">No ideas logged yet. Add one below.</div>';
return;
}
const sorted = [...data.businessIdeas].sort((a, b) => b.date.localeCompare(a.date));
list.innerHTML = sorted.map((idea) => `
<div class="idea-row" data-idea-row="${idea.id}">
<div class="idea-top">
<span class="idea-title">${escapeHtml(idea.title)}</span>
<span class="idea-date">${escapeHtml(idea.date)}</span>
</div>
<div class="idea-notes">${escapeHtml(idea.notes)}</div>
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
queueSave();
});
});
list.querySelectorAll('[data-del-idea]').forEach((el) => {
el.addEventListener('click', () => {
const idea = data.businessIdeas.find((x) => x.id === el.dataset.delIdea);
if (!confirm(`Delete idea "${idea.title}"?`)) return;
data.businessIdeas = data.businessIdeas.filter((x) => x.id !== el.dataset.delIdea);
renderBusinessIdeas();
queueSave();
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
data.businessIdeas.push({ id: newId, title, date: todayStr(), notes: notesInput.value.trim(), status: 'Idea' });
titleInput.value = '';
notesInput.value = '';
renderBusinessIdeas();
queueSave();
setTimeout(() => scrollAndFlash(`[data-idea-row="${newId}"]`), 50);
});
}

export { renderBusinessIdeas, initIdeaForm };
