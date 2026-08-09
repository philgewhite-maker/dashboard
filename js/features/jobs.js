import { data, queueSave } from '../state.js';
import { uid, escapeHtml, bindForm } from '../utils.js';

const STAGES = ['Wishlist', 'Applied', 'Interview', 'Offer'];

function renderJobs() {
const list = document.getElementById('jobs-list');
document.getElementById('jobs-count').textContent = data.jobs.length + (data.jobs.length === 1 ? ' application' : ' applications');
if (data.jobs.length === 0) {
list.innerHTML = '<div class="empty">No applications yet. Add one below.</div>';
return;
}
list.innerHTML = STAGES.map((stage) => {
const items = data.jobs.filter((j) => j.stage === stage);
if (items.length === 0) return '';
return `<div class="stage-col">
<div class="stage-head"><span>${stage}</span><span>${items.length}</span></div>
${items.map((j) => `
<div class="job-card" data-job-row="${j.id}">
<div class="job-top">
<div>
<div class="job-co">${escapeHtml(j.company)}</div>
<div class="job-role">${escapeHtml(j.role)}</div>
</div>
<span class="del-x" style="opacity:1;" data-del-job="${j.id}">&times;</span>
</div>
<div class="job-actions">
<select class="mini" data-job="${j.id}">
${STAGES.map((s) => `<option value="${s}" ${s === j.stage ? 'selected' : ''}>${s}</option>`).join('')}
</select>
</div>
</div>
`).join('')}
</div>`;
}).join('');

list.querySelectorAll('select.mini').forEach((sel) => {
sel.addEventListener('change', () => {
const job = data.jobs.find((x) => x.id === sel.dataset.job);
job.stage = sel.value;
renderJobs();
queueSave();
});
});
list.querySelectorAll('[data-del-job]').forEach((el) => {
el.addEventListener('click', () => {
data.jobs = data.jobs.filter((x) => x.id !== el.dataset.delJob);
renderJobs();
queueSave();
});
});
}

function initJobForm() {
bindForm('job-form', () => {
const coInput = document.getElementById('job-co-input');
const roleInput = document.getElementById('job-role-input');
const company = coInput.value.trim();
const role = roleInput.value.trim();
if (!company || !role) return;
data.jobs.push({ id: uid(), company, role, stage: 'Wishlist' });
coInput.value = '';
roleInput.value = '';
renderJobs();
queueSave();
});
}

export { renderJobs, initJobForm };
