// Review UI for data.agentInbox -- whole task trees proposed via
// server/agent-write.php (an unattended external Claude Code channel)
// but not yet reviewed. Nothing here is ever written by that channel
// directly -- entries only ever arrive via js/sync/agentstaging.js's
// drainAgentStaging(), copied out of an always-plaintext staging
// mailbox into this real, synced (and possibly end-to-end-encrypted)
// array. This module is the actual abuse-prevention backstop for the
// whole feature: agent-write.php has no code path to data.tasks at
// all -- only a human's own Accept click here ever calls the real
// captureTask().
import { data, queueSave } from '../state.js';
import { escapeHtml } from '../utils.js';
import { captureTask, revealTask } from './tasks.js';

// Topological (parent-first) walk. Defensive against a malformed tree
// even though agent-write.php already validates shape at propose time
// (exactly one root, every parentTempId resolves, no cycles) -- a node
// whose parent never resolves is simply never reached rather than
// looping forever.
function orderedNodes(nodes) {
const out = [];
const root = nodes.find((n) => !n.parentTempId);
if (!root) return out;
let guard = 0;
const walk = (node, depth) => {
out.push({ node, depth });
nodes.filter((n) => n.parentTempId === node.tempId).forEach((c) => { if (guard++ < 200) walk(c, depth + 1); });
};
walk(root, 0);
return out;
}

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
function cleanKey(k) {
const s = typeof k === 'string' ? k.trim().toLowerCase() : '';
return KEY_RE.test(s) ? s : '';
}

// A proposal's projectKey names a long-lived project the dashboard files
// every batch into; the first batch creates it, later ones find it. Also
// adopts a project you already made by hand when its title matches
// projectLabel, so the first batch doesn't duplicate it.
function findProject(entry) {
const key = cleanKey(entry.projectKey);
if (!key) return null;
const byKey = data.tasks.find((t) => t.agentProjectKey === key && t.bucket !== 'done');
if (byKey) return byKey;
const label = String(entry.projectLabel || '').trim().toLowerCase();
if (!label) return null;
return data.tasks.find((t) => !t.parentId && t.bucket === 'project' && String(t.title || '').trim().toLowerCase() === label) || null;
}

// The already-existing task a node maps onto, or null if it needs creating.
// With a projectKey the root IS the project; a groupKey node reuses the
// group of that key under the same parent.
function existingFor(node, isRoot, hasProject, project, parentTask) {
if (isRoot && hasProject) return project;
const gk = cleanKey(node.groupKey);
if (!gk) return null;
if (isRoot) return data.tasks.find((t) => t.agentGroupKey === gk && !t.parentId && t.bucket !== 'done') || null;
if (!parentTask) return null;
return data.tasks.find((t) => t.agentGroupKey === gk && t.parentId === parentTask.id && t.bucket !== 'done') || null;
}

// Agent-proposed contexts are matched case-insensitively to the known set
// and added to it when new, so "with claude" lands as the existing
// "With Claude" rather than a near-duplicate chip.
function canonContexts(list) {
const out = [];
(Array.isArray(list) ? list : []).forEach((raw) => {
const name = String(raw || '').trim();
if (!name) return;
let known = data.taskContexts.find((c) => c.toLowerCase() === name.toLowerCase());
if (!known) { data.taskContexts.push(name); known = name; }
if (!out.includes(known)) out.push(known);
});
return out;
}

function planFor(entry) {
const order = orderedNodes(entry.nodes);
const hasProject = !!cleanKey(entry.projectKey);
const project = hasProject ? findProject(entry) : null;
const map = new Map();
order.forEach(({ node }) => {
const isRoot = !node.parentTempId;
map.set(node.tempId, existingFor(node, isRoot, hasProject, project, isRoot ? null : map.get(node.parentTempId)));
});
return { order, hasProject, project, map };
}

function nodeSummaryHtml(node, depth, existing) {
const indent = depth > 0 ? `<span style="padding-left:${depth * 16}px;">&#8618; </span>` : '';
const attachHint = (node.attachments || []).length ? ` &middot; ${node.attachments.length} file${node.attachments.length === 1 ? '' : 's'}` : '';
const ctx = (node.contexts || []).length ? ` &middot; ${node.contexts.map(escapeHtml).join(', ')}` : '';
const tag = existing ? ' <em>(existing)</em>' : (cleanKey(node.groupKey) ? ' <em>(new group)</em>' : '');
return `<div class="settings-note" style="margin:2px 0;">${indent}${escapeHtml(node.title)}${tag}${node.due ? ` &mdash; due ${escapeHtml(node.due)}` : ''}${ctx}${attachHint}</div>`;
}

function entryCardHtml(entry) {
const { order, hasProject, project, map } = planFor(entry);
const projectLine = hasProject
? `<div class="settings-note" style="margin:0 0 4px;">Project: <strong>${escapeHtml(entry.projectLabel || entry.projectKey)}</strong> &middot; ${project ? 'files into your existing project' : 'new project'}</div>`
: '';
return `<div class="alloc-card" data-agentinbox-card="${escapeHtml(entry.id)}">
<div class="task-source">From claude${entry.createdAt ? ` &middot; ${new Date(entry.createdAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}</div>
<div class="settings-note" style="margin:0 0 4px;font-weight:600;">${escapeHtml(entry.label || 'Proposed task')}</div>
${projectLine}
${order.map(({ node, depth }) => nodeSummaryHtml(node, depth, map.get(node.tempId))).join('')}
<div class="alloc-controls" style="margin-top:6px;">
<button class="todo-add-btn" type="button" data-agentinbox-accept="${escapeHtml(entry.id)}">Accept</button>
<button class="del-x" type="button" data-agentinbox-decline="${escapeHtml(entry.id)}" title="Discard this proposal">&times;</button>
</div>
</div>`;
}

function renderAgentInbox() {
const el = document.getElementById('agent-inbox-list');
if (!el) return; // panel not in this build's DOM
const countEl = document.getElementById('agent-inbox-count');
if (countEl) countEl.textContent = data.agentInbox.length ? String(data.agentInbox.length) : '';
const panel = document.getElementById('agent-inbox-panel');
if (panel) panel.style.display = data.agentInbox.length ? '' : 'none';
el.innerHTML = data.agentInbox.length
? data.agentInbox.map(entryCardHtml).join('')
: '';
bindAgentInbox(el);
}

function bindAgentInbox(root) {
root.querySelectorAll('[data-agentinbox-accept]').forEach((btn) => {
btn.addEventListener('click', () => acceptAgentInboxEntry(btn.dataset.agentinboxAccept));
});
root.querySelectorAll('[data-agentinbox-decline]').forEach((btn) => {
btn.addEventListener('click', () => declineAgentInboxEntry(btn.dataset.agentinboxDecline));
});
}

// Walks the tree parent-first, creating a REAL task per node via the
// real captureTask() -- the only place in this whole feature that
// ever does. tempId -> real task id is remapped as it goes, so
// children get the correct real parentId. forConnectionId is
// revalidated against the real data.connections HERE (agent-write.php
// has no read access to connections, so a proposal's claim can't be
// checked server-side) -- an id that doesn't resolve to a real
// connection is dropped, along with its wantSpec, rather than creating
// a task that references nothing real.
function acceptAgentInboxEntry(entryId) {
const entry = data.agentInbox.find((e) => e.id === entryId);
if (!entry) return;
const projectKey = cleanKey(entry.projectKey);
const { order, hasProject } = planFor(entry);
let project = hasProject ? findProject(entry) : null;
const rootNode = order[0] && order[0].node;
if (hasProject && !project) {
const title = (entry.projectLabel || (rootNode && rootNode.title) || projectKey).trim();
project = captureTask({ title, bucket: 'project', agentProjectKey: projectKey, source: { kind: 'claude', label: title, url: '' } });
} else if (project && !project.agentProjectKey) {
project.agentProjectKey = projectKey;
}
const tempToTask = new Map();
let firstNew = null;
order.forEach(({ node }, i) => {
const isRoot = !node.parentTempId;
const parentTask = isRoot ? null : tempToTask.get(node.parentTempId) || null;
const existing = existingFor(node, isRoot, hasProject, project, parentTask);
if (existing) { tempToTask.set(node.tempId, existing); return; }
const connId = node.forConnectionId || '';
const connOk = connId && data.connections.some((c) => c.id === connId);
const task = captureTask({
title: node.title,
notes: node.notes || '',
due: node.due || '',
link: node.link || '',
contexts: canonContexts(node.contexts),
parentId: parentTask ? parentTask.id : null,
bucket: (parentTask || i > 0) ? 'next' : undefined,
attachments: Array.isArray(node.attachments) ? node.attachments : [],
forConnectionId: connOk ? connId : '',
wantSpec: connOk ? (node.wantSpec || null) : null,
agentGroupKey: cleanKey(node.groupKey),
source: { kind: 'claude', label: entry.label || node.title, url: '' },
});
tempToTask.set(node.tempId, task);
if (!firstNew) firstNew = task;
});
data.agentInbox = data.agentInbox.filter((e) => e.id !== entryId);
queueSave();
renderAgentInbox();
const target = firstNew || project;
if (target) revealTask(target.id);
}

function declineAgentInboxEntry(entryId) {
data.agentInbox = data.agentInbox.filter((e) => e.id !== entryId);
queueSave();
renderAgentInbox();
}

export { renderAgentInbox };
