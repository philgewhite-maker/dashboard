// A one-way-in, one-way-out channel for questions Claude needs answered
// while you're away from the desk.
//
// Questions arrive by git push (questions.json in this repo, fetched
// same-origin so there's no CORS or auth involved). Answers are stored in
// your synced dashboard document, so they reach your other devices like
// everything else — and "Copy answers" puts them on the clipboard to paste
// back into a Claude session.
//
// The clipboard is deliberately the return path. It needs no credentials,
// no polling, and nothing of yours has to be readable by anything external
// for it to work.
import { data, queueSave } from '../state.js';
import { escapeHtml } from '../utils.js';

let questions = [];
let showAnswered = false;

async function loadQuestions() {
try {
// cache: 'no-store' because the whole point is picking up a freshly
// pushed question — a cached copy would silently show yesterday's list.
const res = await fetch('./questions.json', { cache: 'no-store' });
if (!res.ok) return;
const json = await res.json();
questions = Array.isArray(json.questions) ? json.questions : [];
} catch (err) {
// Offline, or the file isn't deployed yet. The panel just stays hidden
// rather than showing an error for something you can't act on.
console.warn('Could not load questions.json:', err);
questions = [];
}
renderQuestions();
}

function answerFor(id) { return (data.claudeAnswers || {})[id]; }

function renderQuestions() {
const panel = document.getElementById('questions-panel');
const el = document.getElementById('questions-list');
if (!panel || !el) return;

const unanswered = questions.filter((q) => !answerFor(q.id));
const visible = showAnswered ? questions : unanswered;

// Nothing to ask and nothing answered yet — keep the panel out of the way
// entirely rather than showing an empty box on every load.
if (questions.length === 0) { panel.style.display = 'none'; return; }
panel.style.display = '';
document.getElementById('questions-count').textContent = unanswered.length
? `${unanswered.length} waiting` : 'all answered';

if (visible.length === 0) {
el.innerHTML = '<div class="empty">All answered. Tap “Copy answers” and paste them into Claude.</div>';
return;
}

el.innerHTML = visible.map((q) => {
const existing = answerFor(q.id);
const options = (q.options || []).map((o) => `<button class="q-option${existing && existing.answer === o ? ' chosen' : ''}" type="button" data-q-option="${escapeHtml(q.id)}" data-q-value="${escapeHtml(o)}">${escapeHtml(o)}</button>`).join('');
return `<div class="q-item${existing ? ' answered' : ''}" data-q-item="${escapeHtml(q.id)}">
<div class="q-topic">${escapeHtml(q.topic || 'General')} &middot; ${escapeHtml(q.asked || '')}</div>
<div class="q-question">${escapeHtml(q.question)}</div>
${q.why ? `<div class="q-why">${escapeHtml(q.why)}</div>` : ''}
${options ? `<div class="q-options">${options}</div>` : ''}
<textarea class="q-notes" rows="2" placeholder="Notes, or your own answer…" data-q-notes="${escapeHtml(q.id)}">${escapeHtml(existing?.notes || '')}</textarea>
${existing ? `<div class="q-answered">Answered ${escapeHtml(new Date(existing.answeredAt).toLocaleString())} <button class="q-clear" type="button" data-q-clear="${escapeHtml(q.id)}">clear</button></div>` : ''}
</div>`;
}).join('');

el.querySelectorAll('[data-q-option]').forEach((btn) => {
btn.addEventListener('click', () => {
saveAnswer(btn.dataset.qOption, { answer: btn.dataset.qValue });
});
});
let notesTimer = null;
el.querySelectorAll('[data-q-notes]').forEach((ta) => {
ta.addEventListener('input', () => {
clearTimeout(notesTimer);
notesTimer = setTimeout(() => saveAnswer(ta.dataset.qNotes, { notes: ta.value }, { quiet: true }), 500);
});
});
el.querySelectorAll('[data-q-clear]').forEach((btn) => {
btn.addEventListener('click', () => {
delete data.claudeAnswers[btn.dataset.qClear];
renderQuestions();
queueSave();
});
});
}

// `quiet` skips the re-render, so typing in the notes box doesn't rip the
// textarea out from under the cursor on every keystroke.
function saveAnswer(id, patch, { quiet } = {}) {
if (!data.claudeAnswers) data.claudeAnswers = {};
const prev = data.claudeAnswers[id] || {};
data.claudeAnswers[id] = { ...prev, ...patch, answeredAt: new Date().toISOString() };
queueSave();
if (!quiet) renderQuestions();
}

// A compact block that's readable as-is when pasted into a chat — no JSON
// for you to wade through, and it names the question so I don't have to
// guess which one an answer belongs to.
function answersAsText() {
const lines = ['Answers from the dashboard:', ''];
questions.forEach((q) => {
const a = answerFor(q.id);
if (!a) return;
lines.push(`Q (${q.topic}): ${q.question}`);
if (a.answer) lines.push(`A: ${a.answer}`);
if (a.notes && a.notes.trim()) lines.push(`Notes: ${a.notes.trim()}`);
lines.push('');
});
if (lines.length === 2) return 'No questions answered yet.';
return lines.join('\n');
}

function initQuestions() {
const copyBtn = document.getElementById('copy-answers-btn');
const status = document.getElementById('questions-status');
copyBtn.addEventListener('click', async () => {
const text = answersAsText();
try {
await navigator.clipboard.writeText(text);
status.textContent = 'Copied — paste it into Claude.';
} catch (err) {
// Clipboard access needs a secure context and can be refused; falling
// back to a selectable box means the answers are never trapped.
status.textContent = 'Clipboard blocked — select and copy below.';
const box = document.getElementById('answers-fallback');
box.style.display = 'block';
box.value = text;
box.select();
}
setTimeout(() => { status.textContent = ''; }, 4000);
});

document.getElementById('show-answered-toggle').addEventListener('change', (e) => {
showAnswered = e.target.checked;
renderQuestions();
});

loadQuestions();
}

export { initQuestions, renderQuestions, answersAsText };
