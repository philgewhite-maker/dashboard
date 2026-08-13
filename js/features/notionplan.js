// The bridge between the two halves of the system.
//
// The dashboard holds the GTD skeleton: what exists, what's next, what
// context it needs. Notion holds the flesh — the research, the options, the
// long-form thinking that would be miserable in a one-line task.
//
// "Draft a plan" is the join: it takes a one-line project, has Claude expand
// it into structure, writes that structure into Notion, and brings only the
// ACTIONS back as dashboard subtasks. Deliberately asymmetric — detail flows
// out to Notion, actionable items flow back — because duplicating the detail
// in both places is how two-system setups rot.
import { data, queueSave, blankTask } from '../state.js';
import { escapeHtml } from '../utils.js';
import { callTextJson, MissingKeyError } from '../ai.js';
import { setNotionPanel } from './tasks.js';
import {
NotionNotConfiguredError, createPageForTask, appendBlocks,
textBlocks, headingBlock, todoBlock,
} from '../notion.js';

const PLAN_MODEL = 'claude-opus-5';
const PLAN_MAX_TOKENS = 4000;

async function draftPlan(task) {
const contexts = (data.taskContexts || []).join(', ');
const prompt = `You are helping plan a piece of personal work. The person keeps a GTD system: a dashboard holds their next actions, and Notion holds the detail behind bigger projects.

The project is: "${task.title}"${task.notes ? `\n\nTheir notes so far:\n${task.notes}` : ''}

Produce a plan. Return ONLY a JSON object, no other text, no markdown fences:
{
  "summary": "two or three sentences on what this actually involves and the main decision to make",
  "sections": [ {"heading": "...", "body": "a paragraph or two of substance — options, considerations, things to find out"} ],
  "actions": [ {"title": "a concrete next action, phrased as something you could sit down and do", "context": "one of: ${contexts || 'Office, Home'}", "why": "one short line"} ],
  "questions": ["anything genuinely ambiguous that the person needs to decide before this can proceed"]
}

Rules for the actions: each must be a single physical next step, not a vague intention — "email the Lisbon apartment about April availability", not "sort accommodation". Between 3 and 8 of them. Choose the context from the list given, picking the one where that action can actually be done. Order them so anything blocking the rest comes first.

Sections should hold the thinking that doesn't belong in a task list: comparisons, constraints, budget shapes, things worth researching. Aim for 3 to 6 sections of real substance.`;

const { data: plan } = await callTextJson(prompt, PLAN_MAX_TOKENS, PLAN_MODEL, 'Project planning');
if (!plan || typeof plan !== 'object') throw new Error('Unexpected plan shape from the model');
return {
summary: String(plan.summary || ''),
sections: Array.isArray(plan.sections) ? plan.sections : [],
actions: Array.isArray(plan.actions) ? plan.actions : [],
questions: Array.isArray(plan.questions) ? plan.questions : [],
};
}

function planToBlocks(plan) {
const blocks = [];
if (plan.summary) {
blocks.push(headingBlock('In short'));
blocks.push(...textBlocks(plan.summary));
}
plan.sections.forEach((s) => {
if (!s || !s.heading) return;
blocks.push(headingBlock(s.heading));
blocks.push(...textBlocks(s.body || ''));
});
if (plan.questions.length) {
blocks.push(headingBlock('Needs a decision'));
plan.questions.forEach((q) => blocks.push(...textBlocks(`• ${q}`)));
}
if (plan.actions.length) {
// The actions also live in Notion as checkboxes, so the page reads as a
// complete document on its own — but the dashboard subtasks are the
// copy you actually work from.
blocks.push(headingBlock('Next actions (tracked in the dashboard)'));
plan.actions.forEach((a) => blocks.push(todoBlock(`${a.title}${a.context ? ` — ${a.context}` : ''}`)));
}
return blocks;
}

// Brings the plan's actions back as subtasks. Skips any that already exist by
// title, so re-drafting a plan refines rather than duplicating the list.
function actionsToSubtasks(task, actions) {
const existing = data.tasks
.filter((t) => t.parentId === task.id)
.map((t) => t.title.trim().toLowerCase());
let added = 0;
actions.forEach((a) => {
const title = String(a.title || '').trim();
if (!title || existing.includes(title.toLowerCase())) return;
const context = (data.taskContexts || []).find((c) => c.toLowerCase() === String(a.context || '').toLowerCase());
data.tasks.push(blankTask({
title,
notes: a.why || '',
bucket: 'next',
parentId: task.id,
contexts: context ? [context] : [],
}));
existing.push(title.toLowerCase());
added++;
});
return added;
}

// The whole round trip: make the page if there isn't one, plan it, write the
// plan into Notion, pull the actions back.
async function expandTaskIntoNotion(task, onStatus) {
if (!task.notionPageId) {
onStatus('Creating the Notion page…');
const page = await createPageForTask(task);
task.notionPageId = page.id;
task.link = page.url || task.link;
queueSave();
}

onStatus('Thinking through the plan…');
const plan = await draftPlan(task);

onStatus('Writing it into Notion…');
await appendBlocks(task.notionPageId, planToBlocks(plan));

const added = actionsToSubtasks(task, plan.actions);
// A project with a plan is no longer just an idea.
if (task.bucket === 'inbox' || task.bucket === 'someday') task.bucket = 'project';
queueSave();

return {
added,
sections: plan.sections.length,
questions: plan.questions,
url: task.link,
};
}

// Buttons shown on a task's detail panel, injected by tasks.js.
function notionControlsHtml(task) {
return `<div class="notion-row">
${task.notionPageId
? `<a class="notion-link" href="${escapeHtml(task.link || '#')}" target="_blank" rel="noopener">Open in Notion &#8599;</a>`
: ''}
<button class="sync-btn" type="button" data-notion-plan="${escapeHtml(task.id)}">${task.notionPageId ? 'Add more detail with AI' : 'Create in Notion + draft a plan'}</button>
<span class="sync-status" data-notion-status="${escapeHtml(task.id)}"></span>
</div>`;
}

function bindNotionControls(root, rerender) {
root.querySelectorAll('[data-notion-plan]').forEach((btn) => {
btn.addEventListener('click', async () => {
const task = data.tasks.find((t) => t.id === btn.dataset.notionPlan);
if (!task) return;
const status = root.querySelector(`[data-notion-status="${CSS.escape(task.id)}"]`);
const say = (m) => { if (status) status.textContent = m; };
btn.disabled = true;
try {
const result = await expandTaskIntoNotion(task, say);
say(`Wrote ${result.sections} sections to Notion and added ${result.added} next action${result.added === 1 ? '' : 's'}.`);
if (result.questions.length) {
say(`${result.sections} sections written, ${result.added} actions added. It needs a decision on: ${result.questions[0]}`);
}
if (rerender) rerender();
} catch (err) {
say(err instanceof NotionNotConfiguredError || err instanceof MissingKeyError
? err.message
: `Failed: ${err.message || err}`);
console.error('Notion plan failed:', err);
} finally {
btn.disabled = false;
}
});
});
}

// Register with tasks.js so the controls appear on every task's detail panel.
setNotionPanel(notionControlsHtml, bindNotionControls);

export { expandTaskIntoNotion, draftPlan, planToBlocks, actionsToSubtasks, notionControlsHtml, bindNotionControls };
