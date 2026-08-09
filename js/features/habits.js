import { data, computeStreak, queueSave } from '../state.js';
import { uid, last7Dates, escapeHtml, bindForm } from '../utils.js';

const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function renderHabits() {
const list = document.getElementById('habits-list');
const dates = last7Dates();
document.getElementById('habits-count').textContent = data.habits.length + (data.habits.length === 1 ? ' habit' : ' habits');
if (data.habits.length === 0) {
list.innerHTML = '<div class="empty">No habits yet. Add one in Settings.</div>';
return;
}
list.innerHTML = data.habits.map((h) => {
const streak = computeStreak(h.completions);
const cells = dates.map((d) => {
const done = !!h.completions[d];
return `<div class="day"><span class="lbl">${DAY_LABELS[new Date(d).getUTCDay()]}</span><div class="cell ${done ? 'done' : ''}" data-habit="${h.id}" data-date="${d}"></div></div>`;
}).join('');
return `<div class="habit-row" data-habit-row="${h.id}">
<div class="habit-top">
<span class="habit-name">${escapeHtml(h.name)}</span>
<span style="display:flex;align-items:center;gap:8px;">
<span class="habit-streak">${streak > 0 ? streak + ' day streak' : 'no streak'}</span>
<span class="del-x" data-del-habit="${h.id}">&times;</span>
</span>
</div>
<div class="week">${cells}</div>
</div>`;
}).join('');

list.querySelectorAll('.cell').forEach((cell) => {
cell.addEventListener('click', () => {
const habit = data.habits.find((x) => x.id === cell.dataset.habit);
const date = cell.dataset.date;
habit.completions[date] = !habit.completions[date];
renderHabits();
queueSave();
});
});
list.querySelectorAll('[data-del-habit]').forEach((el) => {
el.addEventListener('click', () => {
const habit = data.habits.find((x) => x.id === el.dataset.delHabit);
if (!confirm(`Remove "${habit.name}"? This deletes its whole history.`)) return;
data.habits = data.habits.filter((x) => x.id !== el.dataset.delHabit);
renderHabits();
queueSave();
});
});
}

function initHabitForm() {
bindForm('habit-form', () => {
const input = document.getElementById('habit-input');
const name = input.value.trim();
if (!name) return;
data.habits.push({ id: uid(), name, completions: {} });
input.value = '';
renderHabits();
queueSave();
});
}

export { renderHabits, initHabitForm };
