import { data, reachOutThreshold, isDormantStage, getLocalSettings, setLocalSetting } from '../state.js';
import { escapeHtml, scrollAndFlash, daysSince, daysUntil } from '../utils.js';
import { switchTab } from '../tabs.js';
import { callTextJson, MissingKeyError } from '../ai.js';

const TARGET_TABS = { connection: 'dating', search: 'dating', habit: 'overview', goal: 'overview', job: 'jobhunt', voucher: 'finances', calendar: 'overview', business: 'business', task: 'tasks' };
const TOP_N = 4;
// Cheap, fast model for a ranking task — no need for the vision model the
// user may have set for screenshot import.
const RANK_MODEL = 'claude-haiku-4-5-20251001';
let currentPool = [];
let currentShown = [];
let renderGen = 0; // guards a slow AI response from clobbering a newer render
let aiCache = { signature: '', order: null };

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
if (c.stage === 'Superswiped') {
// Not matched yet, so "reach out — you last spoke" doesn't apply; this
// is a fixed 7-day check rather than the priority-scaled one below,
// since there's no relationship yet to weigh by priority.
if (since >= 7) {
pool.push({
text: `Still no match with ${c.name} after ${since} days — worth a follow-up superswipe, or time to move on?`,
target: { type: 'connection', id: c.id },
signals: { kind: 'superswipe-follow-up', daysSince: since },
});
}
} else {
const overdue = !isDormantStage(c.stage) && since >= reachOutThreshold(c.priority, c.stage);
if (overdue) {
pool.push({
text: `Reach out to ${c.name} — it's been ${since} days since you last spoke.`,
target: { type: 'connection', id: c.id },
signals: { kind: 'overdue-contact', daysSince: since, priority: c.priority || 0 },
});
}
}
(c.todos || []).filter((t) => !t.done).forEach((t) => {
pool.push({
text: `What about that "${t.text}" with ${c.name}?`,
target: { type: 'connection', id: c.id },
signals: { kind: 'todo', priority: c.priority || 0 },
});
});
});
Object.keys(groupByLocation()).forEach((loc) => {
pool.push({
text: `What about visiting your connections in ${loc}?`,
target: { type: 'search', term: loc },
signals: { kind: 'suggestion' },
});
});

data.habits.forEach((h) => {
let streak = 0;
for (let i = 0; i < 60; i++) {
const d = new Date(); d.setDate(d.getDate() - i);
if (h.completions[d.toISOString().slice(0, 10)]) streak++; else break;
}
if (streak === 0) {
// How long the streak was before it broke — a lapsed 30-day streak is a
// bigger deal than a habit that was never really going.
let priorStreak = 0;
for (let i = 1; i < 90; i++) {
const d = new Date(); d.setDate(d.getDate() - i);
if (h.completions[d.toISOString().slice(0, 10)]) priorStreak++; else break;
}
pool.push({
text: `Keep your streak going — log "${h.name}" today.`,
target: { type: 'habit', id: h.id },
signals: { kind: 'habit-streak-broken', priorStreak },
});
}
});

data.goals.filter((g) => g.progress < 50).forEach((g) => {
pool.push({
text: `Your goal "${g.title}" is at ${g.progress}% — worth a push?`,
target: { type: 'goal', id: g.id },
signals: { kind: 'goal', progress: g.progress },
});
});

data.jobs.filter((j) => j.stage === 'Applied' || j.stage === 'Interview').forEach((j) => {
pool.push({
text: `Follow up on your ${j.stage.toLowerCase()} application to ${j.company}?`,
target: { type: 'job', id: j.id },
signals: { kind: 'job-followup', stage: j.stage },
});
});

data.vouchers.forEach((v) => {
if (!v.expiry) return;
const dn = daysUntil(v.expiry);
if (dn >= 0 && dn <= 30) {
pool.push({
text: `${v.name} expires in ${dn} day${dn === 1 ? '' : 's'} — use it soon.`,
target: { type: 'voucher', id: v.id },
signals: { kind: 'voucher-expiring', daysUntil: dn },
});
}
});

data.calendars.forEach((cal) => {
const status = data.calendarStatus[cal.name];
// Nudge on every upcoming event within a week, not just the soonest —
// a calendar showing 5 events shouldn't hide four of them from here.
((status && status.events) || []).forEach((event) => {
if (!event.date) return;
const dn = daysUntil(event.date);
if (dn >= 0 && dn <= 7) {
pool.push({
text: `${cal.name}: "${event.title}" is in ${dn === 0 ? 'today' : dn + ' day' + (dn === 1 ? '' : 's')}.`,
target: { type: 'calendar', name: cal.name },
signals: { kind: 'upcoming-event', daysUntil: dn },
});
}
});
});

// Tasks. The inbox one is deliberately a single nudge about the pile
// rather than one per item — an unprocessed inbox is one decision ("go
// and file these"), not fifteen.
const inbox = data.tasks.filter((t) => t.bucket === 'inbox');
if (inbox.length > 0) {
const oldest = Math.max(...inbox.map((t) => daysSince(String(t.createdAt).slice(0, 10))));
pool.push({
text: `${inbox.length} thing${inbox.length === 1 ? '' : 's'} sitting unfiled in your task inbox.`,
target: { type: 'task', id: inbox[0].id },
signals: { kind: 'inbox-unprocessed', count: inbox.length, daysSince: oldest },
});
}

data.tasks.forEach((t) => {
if (t.bucket === 'done') return;
// A bring-forward date that has arrived is the whole reason you set one.
if (t.bringForward && daysUntil(t.bringForward) <= 0 && t.bucket !== 'inbox') {
pool.push({
text: `"${t.title}" was scheduled to come back on ${t.bringForward}.`,
target: { type: 'task', id: t.id },
signals: { kind: 'task-resurfaced', daysSince: -daysUntil(t.bringForward) },
});
}
if (t.due) {
const dn = daysUntil(t.due);
if (dn <= 3) {
pool.push({
text: dn < 0 ? `"${t.title}" is ${-dn} day${dn === -1 ? '' : 's'} overdue.` : `"${t.title}" is due ${dn === 0 ? 'today' : `in ${dn} day${dn === 1 ? '' : 's'}`}.`,
target: { type: 'task', id: t.id },
signals: { kind: 'task-due', daysUntil: dn },
});
}
}
});

// A "waiting for" that nobody has chased in a fortnight has usually been
// forgotten rather than genuinely still pending.
data.tasks.filter((t) => t.bucket === 'waiting').forEach((t) => {
const age = daysSince(String(t.createdAt).slice(0, 10));
if (age >= 14) {
pool.push({
text: `Still waiting on "${t.title}" after ${age} days — worth a chase?`,
target: { type: 'task', id: t.id },
signals: { kind: 'waiting-stale', daysSince: age },
});
}
});

data.businessIdeas.filter((i) => i.status !== 'Shelved').forEach((idea) => {
const days = daysSince(idea.date);
if (days >= 1) {
pool.push({
text: `Still thinking about "${idea.title}"? Logged ${days} days ago.`,
target: { type: 'business', id: idea.id },
signals: { kind: 'stale-idea', daysSince: days },
});
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
} else if (target.type === 'task') {
setTimeout(() => scrollAndFlash(`[data-task-row="${target.id}"], [data-alloc-card="${target.id}"]`), 50);
}
}

function itemKey(n) {
return `${n.target.type}:${n.target.id || n.target.term || n.target.name}:${n.text}`;
}

// A stable fingerprint of the current pool. Changes whenever an item is
// added/removed, or when any signal in its text changes (e.g. "3 days"
// becomes "4 days" tomorrow) — so a stale AI ranking never gets reused past
// the day it was computed for.
function poolSignature(pool) {
return pool.map(itemKey).sort().join('|');
}

function randomPick(pool, n) {
return [...pool].sort(() => Math.random() - 0.5).slice(0, n);
}

function paintNudgeList(list) {
const el = document.getElementById('nudges-list');
currentShown = list;
if (list.length === 0) {
el.innerHTML = '<div class="nudge-empty">Nothing to nudge you about right now.</div>';
return;
}
el.innerHTML = `<div class="nudge-list">${list.map((n, i) => `<div class="nudge-item" data-nudge-idx="${i}">${escapeHtml(n.text)} &rarr;</div>`).join('')}</div>`;
el.querySelectorAll('[data-nudge-idx]').forEach((item) => {
item.addEventListener('click', () => {
goToTarget(currentShown[parseInt(item.dataset.nudgeIdx, 10)].target);
});
});
}

// Asks Claude to pick and order the TOP_N items worth surfacing right now,
// balancing urgency (deadlines/expiries/events), importance (priority/
// rating), and neglect (long overdue). Returns pool items, not rewritten
// text — the model only chooses indices, so a bad response can never
// hallucinate a click target that doesn't exist.
async function rankWithAI(pool) {
const items = pool.map((n, i) => ({ i, text: n.text, ...n.signals }));
const prompt = `You're picking which reminders to surface on someone's personal dashboard home screen. Below is a JSON array of candidate reminders, each with an index "i", the reminder text, and signal fields explaining why it might matter: daysSince/daysUntil (age or time to a deadline), priority (1-5, how much they personally rated that person/goal), progress (% complete, lower means more room to matter), priorStreak (a habit streak that just broke — bigger is a bigger loss), stage/kind (category context). Choose the ${TOP_N} most worth showing RIGHT NOW. Balance genuine time pressure (something expiring or happening soon), importance (high priority/rating items), and neglect (things aged the longest) — don't just pick the single biggest number in one field. Avoid picking near-duplicate items about the same person or thing. Respond with ONLY a JSON array of the chosen "i" values, most important first, e.g. [3,0,7,1]. No other text.

${JSON.stringify(items)}`;
const { data: order } = await callTextJson(prompt, 300, RANK_MODEL, 'Smart nudges');
if (!Array.isArray(order)) throw new Error('Unexpected response shape from ranking call');
const picked = order.filter((i) => Number.isInteger(i) && i >= 0 && i < pool.length).map((i) => pool[i]);
return picked.slice(0, TOP_N);
}

async function renderNudges() {
currentPool = buildNudgePool();
const myGen = ++renderGen;
const status = document.getElementById('nudges-ai-status');
if (status) status.textContent = '';

if (currentPool.length === 0) {
paintNudgeList([]);
return;
}

const settings = await getLocalSettings();
if (myGen !== renderGen) return;
if (!settings.smartNudges) {
paintNudgeList(randomPick(currentPool, TOP_N));
return;
}

const sig = poolSignature(currentPool);
if (aiCache.signature === sig && aiCache.order) {
paintNudgeList(aiCache.order);
return;
}

// Smart mode, and nothing cached for this exact pool yet — show a random
// pick instantly so the panel isn't empty, then swap in Claude's ranking
// when it's ready.
paintNudgeList(randomPick(currentPool, TOP_N));
if (status) status.textContent = 'Thinking…';
try {
const ranked = await rankWithAI(currentPool);
if (myGen !== renderGen) return;
if (ranked.length > 0) {
aiCache = { signature: sig, order: ranked };
paintNudgeList(ranked);
}
if (status) status.textContent = '';
} catch (err) {
if (myGen !== renderGen) return;
console.error('Smart nudges failed, showing a random pick instead:', err);
if (status) status.textContent = err instanceof MissingKeyError
? 'Add an Anthropic API key in Settings to enable smart nudges.'
: "Couldn't rank smartly — showing a random pick instead.";
}
}

async function shuffleNudges() {
const settings = await getLocalSettings();
if (settings.smartNudges) aiCache = { signature: '', order: null }; // force a fresh AI call
await renderNudges();
}

function initNudges() {
document.getElementById('shuffle-nudge-btn').addEventListener('click', shuffleNudges);
const toggle = document.getElementById('smart-nudges-toggle');
if (toggle) {
getLocalSettings().then((settings) => { toggle.checked = !!settings.smartNudges; });
toggle.addEventListener('change', async () => {
await setLocalSetting('smartNudges', toggle.checked);
renderNudges();
});
}
}

export { renderNudges, initNudges };
