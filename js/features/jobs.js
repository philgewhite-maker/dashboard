import { data, queueSave, blankJob } from '../state.js';
import { escapeHtml, bindForm, looksLikeUrl, affiliateLink } from '../utils.js';

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
${j.link ? `<a class="task-link" href="${escapeHtml(affiliateLink(j.link))}" target="_blank" rel="noopener">Open reference &#8599;</a>` : ''}
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
const coInput = document.getElementById('job-co-input');
const roleInput = document.getElementById('job-role-input');
const resolveBtn = document.getElementById('job-resolve-btn');

// A pasted job-posting URL, in either field -- "🪄 Resolve title" (shown
// the moment either field is JUST a URL) splits it into Company/Role via
// AI; submitting without ever clicking it still saves the URL as `link`
// on the created application, just with the raw URL left as whichever
// field it was typed into (same free fallback every other quick-add
// input with this button follows).
function currentUrl() {
if (looksLikeUrl(coInput.value)) return coInput.value.trim();
if (looksLikeUrl(roleInput.value)) return roleInput.value.trim();
return '';
}
if (resolveBtn) {
const syncVisibility = () => { resolveBtn.hidden = !currentUrl(); };
coInput.addEventListener('input', syncVisibility);
roleInput.addEventListener('input', syncVisibility);
resolveBtn.addEventListener('click', async () => {
const url = currentUrl();
if (!url) return;
resolveBtn.disabled = true;
resolveBtn.textContent = 'Resolving…';
try {
const { resolveJobPostingUrl } = await import('../ai.js');
const { company, role } = await resolveJobPostingUrl(url);
if (company) coInput.value = company;
if (role) roleInput.value = role;
} catch (err) {
console.error('Resolving job posting URL failed:', err);
} finally {
resolveBtn.disabled = false;
resolveBtn.textContent = '✨ Resolve title';
resolveBtn.hidden = true;
}
});
}

bindForm('job-form', () => {
const url = currentUrl();
const company = coInput.value.trim();
const role = roleInput.value.trim();
if (!company || !role) return;
data.jobs.push(blankJob({ company, role, link: url }));
coInput.value = '';
roleInput.value = '';
if (resolveBtn) resolveBtn.hidden = true;
renderJobs();
queueSave();
});
}

export { renderJobs, initJobForm };
