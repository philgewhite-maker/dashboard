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

function nodeSummaryHtml(node, depth) {
const indent = depth > 0 ? `<span style="padding-left:${depth * 16}px;">&#8618; </span>` : '';
const attachHint = (node.attachments || []).length ? ` &middot; ${node.attachments.length} file${node.attachments.length === 1 ? '' : 's'}` : '';
return `<div class="settings-note" style="margin:2px 0;">${indent}${escapeHtml(node.title)}${node.due ? ` &mdash; due ${escapeHtml(node.due)}` : ''}${attachHint}</div>`;
}

function entryCardHtml(entry) {
const order = orderedNodes(entry.nodes);
return `<div class="alloc-card" data-agentinbox-card="${escapeHtml(entry.id)}">
<div class="task-source">From claude${entry.createdAt ? ` &middot; ${new Date(entry.createdAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}</div>
<div class="settings-note" style="margin:0 0 4px;font-weight:600;">${escapeHtml(entry.label || 'Proposed task')}</div>
${order.map(({ node, depth }) => nodeSummaryHtml(node, depth)).join('')}
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
const order = orderedNodes(entry.nodes);
const tempToReal = new Map();
let rootTaskId = null;
order.forEach(({ node }, i) => {
const parentId = node.parentTempId ? (tempToReal.get(node.parentTempId) || null) : null;
const connId = node.forConnectionId || '';
const connOk = connId && data.connections.some((c) => c.id === connId);
const task = captureTask({
title: node.title,
notes: node.notes || '',
due: node.due || '',
link: node.link || '',
contexts: Array.isArray(node.contexts) ? node.contexts : [],
parentId,
bucket: (parentId || i > 0) ? 'next' : undefined,
attachments: Array.isArray(node.attachments) ? node.attachments : [],
forConnectionId: connOk ? connId : '',
wantSpec: connOk ? (node.wantSpec || null) : null,
source: { kind: 'claude', label: entry.label || node.title, url: '' },
});
tempToReal.set(node.tempId, task.id);
if (!node.parentTempId) rootTaskId = task.id;
});
data.agentInbox = data.agentInbox.filter((e) => e.id !== entryId);
queueSave();
renderAgentInbox();
if (rootTaskId) revealTask(rootTaskId);
}

function declineAgentInboxEntry(entryId) {
data.agentInbox = data.agentInbox.filter((e) => e.id !== entryId);
queueSave();
renderAgentInbox();
}

export { renderAgentInbox };
