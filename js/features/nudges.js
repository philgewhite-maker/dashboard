import { data, reachOutThreshold, isDormantStage } from '../state.js';
import { escapeHtml, scrollAndFlash, daysSince, daysUntil } from '../utils.js';
import { switchTab } from '../tabs.js';

const TARGET_TABS = { connection: 'dating', search: 'dating', habit: 'overview', goal: 'overview', job: 'jobhunt', voucher: 'finances', calendar: 'overview', business: 'business' };
let currentPool = [];
let currentShuffled = [];

function groupByLocation() {
const groups = {};
data.connections.forEach((c) => {
if (!c.location) return;
if (!groups[c.location]) groups[c.location] = [];
groups[c.location].push(c);
});
return groups;
}

function buildNudgePool() {
const pool = [];

data.connections.forEach((c) => {
const since = daysSince(c.lastContact);
const overdue = !isDormantStage(c.stage) && since >= reachOutThreshold(c.priority);
if (overdue) {
pool.push({ text: `Reach out to ${c.name} — it's been ${since} days since you last spoke.`, target: { type: 'connection', id: c.id } });
}
(c.todos || []).filter((t) => !t.done).forEach((t) => {
pool.push({ text: `What about that "${t.text}" with ${c.name}?`, target: { type: 'connection', id: c.id } });
});
});
Object.keys(groupByLocation()).forEach((loc) => {
pool.push({ text: `What about visiting your connections in ${loc}?`, target: { type: 'search', term: loc } });
});

data.habits.forEach((h) => {
let streak = 0;
for (let i = 0; i < 60; i++) {
const d = new Date(); d.setDate(d.getDate() - i);
if (h.completions[d.toISOString().slice(0, 10)]) streak++; else break;
}
if (streak === 0) pool.push({ text: `Keep your streak going — log "${h.name}" today.`, target: { type: 'habit', id: h.id } });
});

data.goals.filter((g) => g.progress < 50).forEach((g) => {
pool.push({ text: `Your goal "${g.title}" is at ${g.progress}% — worth a push?`, target: { type: 'goal', id: g.id } });
});

data.jobs.filter((j) => j.stage === 'Applied' || j.stage === 'Interview').forEach((j) => {
pool.push({ text: `Follow up on your ${j.stage.toLowerCase()} application to ${j.company}?`, target: { type: 'job', id: j.id } });
});

data.vouchers.forEach((v) => {
if (!v.expiry) return;
const dn = daysUntil(v.expiry);
if (dn >= 0 && dn <= 30) {
pool.push({ text: `${v.name} expires in ${dn} day${dn === 1 ? '' : 's'} — use it soon.`, target: { type: 'voucher', id: v.id } });
}
});

data.calendars.forEach((name) => {
const status = data.calendarStatus[name];
if (!status || !status.found || !status.date) return;
const dn = daysUntil(status.date);
if (dn >= 0 && dn <= 7) {
pool.push({ text: `${name}: "${status.title}" is in ${dn === 0 ? 'today' : dn + ' day' + (dn === 1 ? '' : 's')}.`, target: { type: 'calendar', name } });
}
});

data.businessIdeas.filter((i) => i.status !== 'Shelved').forEach((idea) => {
const days = daysSince(idea.date);
if (days >= 1) {
pool.push({ text: `Still thinking about "${idea.title}"? Logged ${days} days ago.`, target: { type: 'business', id: idea.id } });
}
});

return pool;
}

function goToTarget(target) {
if (!target) return;
const tab = TARGET_TABS[target.type];
if (tab) switchTab(tab);
if (target.type === 'connection') {
import('./connections.js').then((m) => {
m.expandConnection(target.id);
setTimeout(() => scrollAndFlash(`[data-conn-row="${target.id}"]`), 80);
});
} else if (target.type === 'search') {
setTimeout(() => {
const searchInput = document.getElementById('conn-search');
searchInput.value = target.term;
searchInput.dispatchEvent(new Event('input'));
searchInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
}, 50);
} else if (target.type === 'habit') {
setTimeout(() => scrollAndFlash(`[data-habit-row="${target.id}"]`), 50);
} else if (target.type === 'goal') {
setTimeout(() => scrollAndFlash(`[data-goal-row="${target.id}"]`), 50);
} else if (target.type === 'job') {
setTimeout(() => scrollAndFlash(`[data-job-row="${target.id}"]`), 50);
} else if (target.type === 'voucher') {
setTimeout(() => scrollAndFlash(`[data-voucher-row="${target.id}"]`), 50);
} else if (target.type === 'calendar') {
setTimeout(() => scrollAndFlash(`[data-cal-row="${CSS.escape(target.name)}"]`), 50);
} else if (target.type === 'business') {
setTimeout(() => scrollAndFlash(`[data-idea-row="${target.id}"]`), 50);
}
}

function renderNudges() {
const el = document.getElementById('nudges-list');
currentPool = buildNudgePool();
if (currentPool.length === 0) {
el.innerHTML = '<div class="nudge-empty">Nothing to nudge you about right now.</div>';
return;
}
currentShuffled = [...currentPool].sort(() => Math.random() - 0.5).slice(0, 4);
el.innerHTML = `<div class="nudge-list">${currentShuffled.map((n, i) => `<div class="nudge-item" data-nudge-idx="${i}">${escapeHtml(n.text)} &rarr;</div>`).join('')}</div>`;
el.querySelectorAll('[data-nudge-idx]').forEach((item) => {
item.addEventListener('click', () => {
goToTarget(currentShuffled[parseInt(item.dataset.nudgeIdx, 10)].target);
});
});
}

function initNudges() {
document.getElementById('shuffle-nudge-btn').addEventListener('click', renderNudges);
}

export { renderNudges, initNudges };
