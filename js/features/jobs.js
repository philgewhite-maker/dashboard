import { data, queueSave, blankJob } from '../state.js';
import { escapeHtml, bindForm, looksLikeUrl, affiliateLink, todayStr, daysSince, MISSING_KEY_LINK_HTML } from '../utils.js';

// "Closed" is where a rejected or withdrawn application goes, so it keeps its
// history without being deleted and without nudging (only Applied and
// Interview nudge).
const STAGES = ['Wishlist', 'Applied', 'Interview', 'Offer', 'Closed'];
const STAGE_TITLES = { Closed: 'Rejected or withdrawn' };
const SINCE_VERB = { Wishlist: 'Added', Applied: 'Applied', Interview: 'Interview since', Offer: 'Offer since', Closed: 'Closed' };

function sinceHtml(job) {
if (!job.stageAt) return '';
const d = new Date(`${job.stageAt}T00:00:00`);
if (isNaN(d)) return '';
const when = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const days = daysSince(job.stageAt);
return `<span class="job-since">${SINCE_VERB[job.stage] || job.stage} ${when}${days > 0 ? ` &middot; ${days}d` : ''}</span>`;
}

function renderJobs() {
const list = document.getElementById('jobs-list');
document.getElementById('jobs-count').textContent = data.jobs.length + (data.jobs.length === 1 ? ' application' : ' applications');
if (data.jobs.length === 0) {
list.innerHTML = '<div class="empty">No applications yet. Add one below.</div>';
return;
}
list.innerHTML = STAGES.map((stage) => {
// Longest in this stage first, so the one that has waited longest sits on top.
const items = data.jobs.filter((j) => j.stage === stage)
.sort((a, b) => (a.stageAt || '9999').localeCompare(b.stageAt || '9999'));
if (items.length === 0) return '';
return `<div class="stage-col">
<div class="stage-head"${STAGE_TITLES[stage] ? ` title="${escapeHtml(STAGE_TITLES[stage])}"` : ''}><span>${stage}</span><span>${items.length}</span></div>
${items.map((j) => `
<div class="job-card" data-job-row="${j.id}">
<div class="job-top">
<div class="job-fields">
<input type="text" autocomplete="off" class="voucher-edit job-co-edit" data-job-field="company" data-job-id="${j.id}" value="${escapeHtml(j.company)}" placeholder="Company">
<input type="text" autocomplete="off" class="voucher-edit job-role-edit" data-job-field="role" data-job-id="${j.id}" value="${escapeHtml(j.role)}" placeholder="Role">
<div class="job-link-row">
<input type="text" autocomplete="off" class="voucher-edit job-link-edit" data-job-field="link" data-job-id="${j.id}" value="${escapeHtml(j.link || '')}" placeholder="Posting link (optional)">
${j.link ? `<a class="task-link" href="${escapeHtml(affiliateLink(j.link))}" target="_blank" rel="noopener">Open reference &#8599;</a>` : ''}
</div>
</div>
<span class="del-x" style="opacity:1;" data-del-job="${j.id}">&times;</span>
</div>
<input type="text" autocomplete="off" class="voucher-edit job-notes-edit" data-job-field="notes" data-job-id="${j.id}" value="${escapeHtml(j.notes || '')}" placeholder="Notes: contact, salary, next step">
<div class="job-actions">
<select class="mini" data-job="${j.id}">
${STAGES.map((s) => `<option value="${s}" ${s === j.stage ? 'selected' : ''}>${s}</option>`).join('')}
</select>
${sinceHtml(j)}
</div>
</div>
`).join('')}
</div>`;
}).join('');

list.querySelectorAll('select.mini').forEach((sel) => {
sel.addEventListener('change', () => {
const job = data.jobs.find((x) => x.id === sel.dataset.job);
if (!job || job.stage === sel.value) return;
job.stage = sel.value;
job.stageAt = todayStr();
renderJobs();
queueSave();
});
});
// Every field on a card is editable in place, same as a voucher row. A
// company can't be emptied (it is what names the card), so a blank one
// reverts to what it was.
list.querySelectorAll('[data-job-field]').forEach((el) => {
el.addEventListener('change', () => {
const job = data.jobs.find((x) => x.id === el.dataset.jobId);
if (!job) return;
const value = el.value.trim();
if (el.dataset.jobField === 'company' && !value) { renderJobs(); return; }
job[el.dataset.jobField] = value;
renderJobs();
queueSave();
});
});
list.querySelectorAll('[data-del-job]').forEach((el) => {
el.addEventListener('click', () => {
const doomed = data.jobs.find((x) => x.id === el.dataset.delJob);
if (!confirm(`Delete ${doomed && doomed.company ? `the ${doomed.company} application` : 'this application'}? To keep it but stop being reminded, move it to Closed instead.`)) return;
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
const note = document.getElementById('job-form-note');
const say = (html) => { if (!note) return; note.innerHTML = html; note.hidden = !html; };

// A pasted job-posting URL, in either field -- "🪄 Resolve title" (shown
// the moment either field is JUST a URL) splits it into Company/Role via
// AI; submitting without ever clicking it still saves the URL as `link`
// on the created application, just with the raw URL left as whichever
// field it was typed into (same free fallback every other quick-add
// input with this button follows).
let resolvedUrl = '';
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
say('');
try {
const { resolveJobPostingUrl } = await import('../ai.js');
const { company, role } = await resolveJobPostingUrl(url);
if (company) coInput.value = company;
if (role) roleInput.value = role;
resolvedUrl = url;
if (!company && !role) say('Couldn\'t read that page. Type the company and role yourself; the link is kept.');
} catch (err) {
console.error('Resolving job posting URL failed:', err);
if (err && err.name === 'MissingKeyError') say(`Resolving a link needs an Anthropic key. Add one in ${MISSING_KEY_LINK_HTML}, or type the company and role yourself.`);
else say(`Couldn't resolve that link (${escapeHtml((err && err.message) || 'unknown error')}). Type the company and role yourself; the link is kept.`);
resolvedUrl = url;
} finally {
resolveBtn.disabled = false;
resolveBtn.textContent = '✨ Resolve title';
resolveBtn.hidden = true;
}
});
}

bindForm('job-form', () => {
const url = currentUrl() || resolvedUrl;
const company = coInput.value.trim();
const role = roleInput.value.trim();
// A company is enough; the role can be filled in on the card later.
if (!company) { say('Type a company to add a job. The role is optional.'); coInput.focus(); return; }
say('');
data.jobs.push(blankJob({ company, role, link: url }));
coInput.value = '';
roleInput.value = '';
resolvedUrl = '';
if (resolveBtn) resolveBtn.hidden = true;
renderJobs();
queueSave();
});
}

export { renderJobs, initJobForm };
