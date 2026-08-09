import { data, queueSave } from '../state.js';
import { uid, todayStr, escapeHtml, bindForm, scrollAndFlash } from '../utils.js';

const STATUSES = ['Idea', 'Exploring', 'Building', 'Shelved'];

function renderEnhancementIdeas() {
const list = document.getElementById('enhancements-list');
document.getElementById('enhancements-count').textContent = data.enhancementIdeas.length + (data.enhancementIdeas.length === 1 ? ' idea' : ' ideas');
if (data.enhancementIdeas.length === 0) {
list.innerHTML = '<div class="empty">No enhancement ideas logged yet. Add one below.</div>';
return;
}
const sorted = [...data.enhancementIdeas].sort((a, b) => b.date.localeCompare(a.date));
list.innerHTML = sorted.map((idea) => `
<div class="idea-row" data-enhancement-row="${idea.id}">
<div class="idea-top">
<span class="idea-title">${escapeHtml(idea.title)}</span>
<span class="idea-date">${escapeHtml(idea.date)}</span>
</div>
<div class="idea-notes">${escapeHtml(idea.notes)}</div>
<div class="idea-actions">
<select class="idea-status" data-enhancement-status="${idea.id}">
${STATUSES.map((s) => `<option value="${s}" ${s === idea.status ? 'selected' : ''}>${s}</option>`).join('')}
</select>
<span class="del-x" style="opacity:1;" data-del-enhancement="${idea.id}">&times;</span>
</div>
</div>
`).join('');

list.querySelectorAll('[data-enhancement-status]').forEach((sel) => {
sel.addEventListener('change', () => {
const idea = data.enhancementIdeas.find((x) => x.id === sel.dataset.enhancementStatus);
idea.status = sel.value;
queueSave();
});
});
list.querySelectorAll('[data-del-enhancement]').forEach((el) => {
el.addEventListener('click', () => {
const idea = data.enhancementIdeas.find((x) => x.id === el.dataset.delEnhancement);
if (!confirm(`Delete idea "${idea.title}"?`)) return;
data.enhancementIdeas = data.enhancementIdeas.filter((x) => x.id !== el.dataset.delEnhancement);
renderEnhancementIdeas();
queueSave();
});
});
}

function initEnhancementForm() {
bindForm('enhancement-form', () => {
const titleInput = document.getElementById('enhancement-title-input');
const notesInput = document.getElementById('enhancement-notes-input');
const title = titleInput.value.trim();
if (!title) return;
const newId = uid();
data.enhancementIdeas.push({ id: newId, title, date: todayStr(), notes: notesInput.value.trim(), status: 'Idea' });
titleInput.value = '';
notesInput.value = '';
renderEnhancementIdeas();
queueSave();
setTimeout(() => scrollAndFlash(`[data-enhancement-row="${newId}"]`), 50);
});
}

export { renderEnhancementIdeas, initEnhancementForm };
