import { data, reachOutThreshold, isDormantStage, isTravelPaused, getLocalSettings, setLocalSetting } from '../state.js';
import { escapeHtml, scrollAndFlash, daysSince, daysUntil } from '../utils.js';
import { switchTab } from '../tabs.js';
import { callTextJson, MissingKeyError } from '../ai.js';

const TARGET_TABS = { connection: 'dating', search: 'dating', habit: 'overview', goal: 'overview', job: 'jobhunt', voucher: 'finances', calendar: 'overview', business: 'business', task: 'tasks', health: 'health' };
const TOP_N = 6;
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
(c.location || []).forEach((loc) => {
if (!groups[loc]) groups[loc] = [];
groups[loc].push(c);
});
});
return groups;
}

// A newly-imported high-priority match hasn't had time to become
// "overdue" by the usual timer below — lastContact is set to today at
// import, so that check wouldn't fire for weeks. Surfaced separately so
// a 4-5 star match doesn't just sit unseen in the pool until then. "No
// real outreach yet" is approximated as still sitting at Matched or
// Chatting in app — anything further along already has something
// happening. Bounded to the last 14 days so this doesn't keep duplicating
// the normal overdue-contact nudge forever once that one takes over.
const NEW_MATCH_STAGES = new Set(['Matched', 'Chatting in app']);

function buildNudgePool() {
const pool = [];

data.connections.forEach((c) => {
const since = daysSince(c.lastContact);
// Standby/Travelling deliberately takes someone out of reach-out rotation
// — the whole point is not being nagged about a foreign-city match every
// few days, so every nudge below that's really just "it's been a while"
// in disguise skips her while paused. Explicit todos still fire below —
// those are a decision you already made, not a cadence check.
if (!isTravelPaused(c)) {
// lastContact defaults to the match date at import (see the comment
// above), so it only moves forward once real outreach happens. Without
// this check, marking someone contacted (which sets lastContact but
// doesn't necessarily change stage) had no effect on this nudge -- it
// kept firing "reach out?" for up to 14 days after you already had.
const createdDate = String(c.createdAt || '').slice(0, 10);
const contactedSinceMatch = c.lastContact && c.lastContact > createdDate;
if (!contactedSinceMatch && (c.priority || 0) >= 4 && NEW_MATCH_STAGES.has(c.stage) && daysSince(createdDate) <= 14) {
pool.push({
text: `You rated ${c.name} ${c.priority} stars — reach out?`,
target: { type: 'connection', id: c.id },
signals: { kind: 'high-priority-new-match', priority: c.priority },
category: 'dating',
});
}
if (c.stage === 'Superswiped') {
// Not matched yet, so "reach out — you last spoke" doesn't apply; this
// is a fixed 7-day check rather than the priority-scaled one below,
// since there's no relationship yet to weigh by priority.
if (since >= 7) {
pool.push({
text: `Still no match with ${c.name} after ${since} days — worth a follow-up superswipe, or time to move on?`,
target: { type: 'connection', id: c.id },
signals: { kind: 'superswipe-follow-up', daysSince: since },
category: 'dating',
});
}
} else {
const overdue = !isDormantStage(c.stage) && since >= reachOutThreshold(c.priority, c.stage);
if (overdue) {
pool.push({
text: `Reach out to ${c.name} — it's been ${since} days since you last spoke.`,
target: { type: 'connection', id: c.id },
signals: { kind: 'overdue-contact', daysSince: since, priority: c.priority || 0 },
category: 'dating',
});
}
}
}
(c.todos || []).filter((t) => !t.done).forEach((t) => {
pool.push({
text: `What about that "${t.text}" with ${c.name}?`,
target: { type: 'connection', id: c.id },
signals: { kind: 'todo', priority: c.priority || 0 },
category: 'dating',
});
});
});
// A location with 2+ connections is a genuinely different suggestion from
// "go see this one person" — worth framing as its own trip rather than
// just repeating the single-connection phrasing N times. Your own home
// city (Settings → Privacy → My info) is excluded entirely: "plan a trip
// to see everyone in the city you already live in" isn't a suggestion.
const myCity = String(data.myCity || '').trim().toLowerCase();
Object.entries(groupByLocation()).forEach(([loc, conns]) => {
if (myCity && loc.trim().toLowerCase() === myCity) return;
if (conns.length >= 2) {
pool.push({
text: `You've got ${conns.length} connections in ${loc} — worth planning a city-break weekend to see them all?`,
target: { type: 'search', term: loc },
signals: { kind: 'city-break-suggestion', count: conns.length },
category: 'creative',
});
} else {
pool.push({
text: `What about visiting your connection in ${loc}?`,
target: { type: 'search', term: loc },
signals: { kind: 'suggestion' },
category: 'creative',
});
}
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
category: 'habit',
});
}
});

data.goals.filter((g) => g.progress < 50).forEach((g) => {
pool.push({
text: `Your goal "${g.title}" is at ${g.progress}% — worth a push?`,
target: { type: 'goal', id: g.id },
signals: { kind: 'goal', progress: g.progress },
category: 'goal',
});
});

data.jobs.filter((j) => j.stage === 'Applied' || j.stage === 'Interview').forEach((j) => {
pool.push({
text: `Follow up on your ${j.stage.toLowerCase()} application to ${j.company}?`,
target: { type: 'job', id: j.id },
signals: { kind: 'job-followup', stage: j.stage },
category: 'job',
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
category: 'voucher',
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
category: 'calendar',
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
category: 'task',
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
category: 'task',
});
}
if (t.due) {
const dn = daysUntil(t.due);
if (dn <= 3) {
pool.push({
text: dn < 0 ? `"${t.title}" is ${-dn} day${dn === -1 ? '' : 's'} overdue.` : `"${t.title}" is due ${dn === 0 ? 'today' : `in ${dn} day${dn === 1 ? '' : 's'}`}.`,
target: { type: 'task', id: t.id },
signals: { kind: 'task-due', daysUntil: dn },
category: 'task',
});
}
} else if (t.bucket === 'next') {
// No due date, but sitting in "doable now" for a while unattended — the
// broader project/build-config work that has no natural deadline of its
// own, so it never trips the due-date check above and would otherwise
// only ever surface via the allocation workspace.
const age = daysSince(String(t.createdAt).slice(0, 10));
if (!(t.bringForward && daysUntil(t.bringForward) > 0) && age >= 10) {
pool.push({
text: `"${t.title}" has been sitting in Next actions for ${age} days.`,
target: { type: 'task', id: t.id },
signals: { kind: 'task-stale-next', daysSince: age },
category: 'task',
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
category: 'task',
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
category: 'business',
});
}
});

buildHealthNudges(pool);

return pool;
}

// Sleep/weight/exercise only — heart rate and oxygen saturation are left out
// deliberately. The Health tab's HR range is known to be a partial picture
// while the bridge app's sync window is still catching up (see the Health
// tab investigation), so a nudge built on it would just be reacting to a
// sync gap, not a real signal. Steps/sleep/weight/exercise don't have that
// problem — they're either present for a day or they're not.
function buildHealthNudges(pool) {
const days = data.healthDaily || [];
if (days.length === 0) return; // Health tab never parsed — nothing to say yet
const recent = days.slice(0, 7); // newest first, per healthparse.js

const sleepNights = recent.filter((d) => d.sleepMinutes > 0);
if (sleepNights.length >= 2) {
const avgMins = sleepNights.reduce((sum, d) => sum + d.sleepMinutes, 0) / sleepNights.length;
if (avgMins < 360) { // under 6h average
const avgH = Math.round((avgMins / 60) * 10) / 10;
pool.push({
text: `Average sleep the last ${sleepNights.length} logged nights is ${avgH}h — worth an early night?`,
target: { type: 'health' },
signals: { kind: 'health-low-sleep', avgHours: avgH },
category: 'health',
});
}
}

const weighIns = days.filter((d) => d.weightKg != null); // already newest first
if (weighIns.length >= 2) {
const latest = weighIns[0];
const prior = weighIns[1];
const delta = Math.round((latest.weightKg - prior.weightKg) * 10) / 10;
const gapDays = Math.round((new Date(latest.date) - new Date(prior.date)) / 86400000);
if (Math.abs(delta) >= 1 && gapDays >= 3) {
pool.push({
text: `Weight's ${delta > 0 ? 'up' : 'down'} ${Math.abs(delta)}kg over the last ${gapDays} days — ${latest.weightKg}kg as of ${formatHealthDate(latest.date)}.`,
target: { type: 'health' },
signals: { kind: 'health-weight-trend', deltaKg: delta, daysSince: gapDays },
category: 'health',
});
}
}

const withCoverage = recent.filter((d) => d.steps > 0 || d.sleepMinutes > 0);
if (withCoverage.length >= 5 && recent.every((d) => d.exerciseMinutes === 0)) {
pool.push({
text: `No exercise logged in the last week.`,
target: { type: 'health' },
signals: { kind: 'health-no-exercise', daysSince: 7 },
category: 'health',
});
}
}

function formatHealthDate(iso) {
const d = new Date(`${iso}T00:00:00`);
return isNaN(d) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
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

// Round-robins across categories (one from dating, one from task, one from
// health, ...) before ever repeating a category, so the instant fallback
// shown while the AI ranking is still thinking is already a reasonable,
// varied set rather than whatever the dice happened to favour -- a pool
// with 15 overdue-contact nudges and one business idea would otherwise show
// 4 dating nudges nearly every shuffle just by sample size. Shuffled within
// each category too, so repeated shuffles still vary.
function diversePick(pool, n) {
const byCategory = new Map();
pool.forEach((item) => {
const cat = item.category || 'other';
if (!byCategory.has(cat)) byCategory.set(cat, []);
byCategory.get(cat).push(item);
});
byCategory.forEach((items) => items.sort(() => Math.random() - 0.5));
const cats = [...byCategory.keys()].sort(() => Math.random() - 0.5);
const picked = [];
for (let round = 0; picked.length < n && picked.length < pool.length; round++) {
let addedThisRound = false;
for (const cat of cats) {
if (picked.length >= n) break;
const items = byCategory.get(cat);
if (items[round]) { picked.push(items[round]); addedThisRound = true; }
}
if (!addedThisRound) break;
}
return picked;
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
const items = pool.map((n, i) => ({ i, text: n.text, category: n.category || 'other', ...n.signals }));
const prompt = `You're picking which reminders to surface on someone's personal dashboard home screen. Below is a JSON array of candidate reminders, each with an index "i", the reminder text, a "category" (dating, task, health, business, habit, goal, job, voucher, calendar, creative), and signal fields explaining why it might matter: daysSince/daysUntil (age or time to a deadline), priority (1-5, how much they personally rated that person/goal), progress (% complete, lower means more room to matter), priorStreak (a habit streak that just broke — bigger is a bigger loss), stage/kind (further context). Choose the ${TOP_N} most worth showing RIGHT NOW. Balance genuine time pressure (something expiring or happening soon), importance (high priority/rating items), and neglect (things aged the longest) — don't just pick the single biggest number in one field. Also actively prefer a MIX of categories over filling most slots from one — a panel that's nothing but "reach out to so-and-so" reads as naggy and one-note even when each one is individually justified. Only repeat a category if the pool genuinely has nothing else worth surfacing. Avoid picking near-duplicate items about the same person or thing. Respond with ONLY a JSON array of the chosen "i" values, most important first, e.g. [3,0,7,1]. No other text.

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
paintNudgeList(diversePick(currentPool, TOP_N));
return;
}

const sig = poolSignature(currentPool);
if (aiCache.signature === sig && aiCache.order) {
paintNudgeList(aiCache.order);
return;
}

// Smart mode, and nothing cached for this exact pool yet — show a diverse
// pick instantly so the panel isn't empty, then swap in Claude's ranking
// when it's ready. Both passes are diversity-aware, so the swap reads as a
// refinement rather than a contradiction.
paintNudgeList(diversePick(currentPool, TOP_N));
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
