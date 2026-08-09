import { data, queueSave } from '../state.js';
import { uid, escapeHtml, bindForm } from '../utils.js';

function renderGoals() {
const list = document.getElementById('goals-list');
document.getElementById('goals-count').textContent = data.goals.length + (data.goals.length === 1 ? ' goal' : ' goals');
if (data.goals.length === 0) {
list.innerHTML = '<div class="empty">No goals yet. Add one in Settings.</div>';
return;
}
list.innerHTML = data.goals.map((g) => `
<div class="goal-card" data-goal-row="${g.id}">
<div class="goal-top">
<span class="goal-title">${escapeHtml(g.title)}</span>
<span class="goal-pct">${g.progress}%</span>
</div>
<div class="bar-track"><div class="bar-fill" style="width:${g.progress}%"></div></div>
<input type="range" min="0" max="100" step="5" value="${g.progress}" data-goal="${g.id}">
<div class="goal-meta">
<span class="goal-cat">${escapeHtml(g.category || 'General')}</span>
<span class="del-x" style="opacity:1;" data-del-goal="${g.id}">&times;</span>
</div>
</div>
`).join('');

list.querySelectorAll('input[type=range]').forEach((inp) => {
inp.addEventListener('input', () => {
const goal = data.goals.find((x) => x.id === inp.dataset.goal);
goal.progress = parseInt(inp.value, 10);
const card = inp.closest('.goal-card');
card.querySelector('.goal-pct').textContent = goal.progress + '%';
card.querySelector('.bar-fill').style.width = goal.progress + '%';
queueSave();
});
});
list.querySelectorAll('[data-del-goal]').forEach((el) => {
el.addEventListener('click', () => {
const goal = data.goals.find((x) => x.id === el.dataset.delGoal);
if (!confirm(`Remove goal "${goal.title}"?`)) return;
data.goals = data.goals.filter((x) => x.id !== el.dataset.delGoal);
renderGoals();
queueSave();
});
});
}

function initGoalForm() {
bindForm('goal-form', () => {
const input = document.getElementById('goal-input');
const title = input.value.trim();
if (!title) return;
data.goals.push({ id: uid(), title, category: 'General', progress: 0 });
input.value = '';
renderGoals();
queueSave();
});
}

export { renderGoals, initGoalForm };
