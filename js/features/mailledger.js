// A ledger of every email an importer has handled: one row per (importer,
// Gmail message), with the sender, subject, date, a snippet, what happened to
// it and which record it produced. Importers used to keep a private "seen"
// list of bare message ids, so once an email was marked seen there was no way
// to find it, see why nothing came of it, or run it again. This is the one
// place to search by sender/topic and press Retry on a single message.
//
// It stores NO bodies (Gmail has them; a retry fetches the message fresh by
// id), only enough to find a message and show what became of it.
//
// An importer calls recordMail() where it decides a message's fate, and
// registerRetry() once so the Retry button knows how to run it again.
import { data, queueSave } from '../state.js';
import { escapeHtml } from '../utils.js';
import { tripById, tripChipHtml, bindTripChips } from './travel.js';
import { runTracked } from './activity.js';

const MAX_ROWS = 800;
const SNIPPET_CHARS = 100;
const PAGE_SIZE = 60;

const FEATURES = {
catsitting: 'Cat sitting',
loyalty: 'Loyalty balances',
aporders: 'Agent Provocateur orders',
'airbnb-cancel': 'Airbnb cancellations',
};
const OUTCOMES = {
filed: { label: 'Filed', cls: 'ok' },
nomatch: { label: 'Not recognised', cls: 'warn' },
failed: { label: 'Failed', cls: 'bad' },
waiting: { label: 'Waiting', cls: 'warn' },
seen: { label: 'Handled earlier', cls: 'muted' },
};
// Rows that need a look: everything except filed and the pre-ledger backfill.
const ATTENTION = new Set(['nomatch', 'failed', 'waiting']);

const retryHandlers = {};
function registerRetry(feature, handler) { retryHandlers[feature] = handler; }

function isoOrBlank(value) {
const d = new Date(value);
return value && !Number.isNaN(d.getTime()) ? d.toISOString() : '';
}

// One row per (feature, message). `msg` is whatever the importer has: a search
// result (from/subject/date/snippet) or a full message detail (from/subject/date).
// `onlyIfMissing` is for the "already handled before the ledger existed"
// backfill, which must never overwrite a real outcome.
function recordMail(msg, feature, outcome, { note = '', ref = '', produced = null, onlyIfMissing = false } = {}) {
const messageId = msg && (msg.id || msg.messageId);
if (!messageId || !feature) return null;
if (!Array.isArray(data.mailLedger)) data.mailLedger = [];
const key = `${feature}:${messageId}`;
let row = data.mailLedger.find((r) => r.key === key);
if (row && onlyIfMissing) return row;
if (!row) {
row = { key, messageId, feature, outcome, from: '', subject: '', date: '', snippet: '', seenAt: '', tries: 0, note: '', ref: '', produced: [] };
data.mailLedger.push(row);
}
if (msg.from) row.from = String(msg.from);
if (msg.subject) row.subject = String(msg.subject);
if (msg.date) row.date = isoOrBlank(msg.date) || row.date;
if (msg.snippet) row.snippet = String(msg.snippet).replace(/\s+/g, ' ').slice(0, SNIPPET_CHARS);
row.outcome = outcome;
row.note = note;
if (ref) row.ref = ref;
if (produced) row.produced = produced;
row.seenAt = new Date().toISOString();
if (!onlyIfMissing) row.tries = (row.tries || 0) + 1;
if (data.mailLedger.length > MAX_ROWS) {
data.mailLedger.sort((a, b) => String(b.seenAt).localeCompare(String(a.seenAt)));
data.mailLedger.length = MAX_ROWS;
}
queueSave();
return row;
}

// ---- Panel -----------------------------------------------------------------

let searchText = '';
let featureFilter = '';
let outcomeFilter = '';
let shown = PAGE_SIZE;

function senderLabel(from) {
const m = /^\s*"?([^"<]+?)"?\s*</.exec(from || '');
return (m ? m[1] : (from || '').replace(/[<>]/g, '')).trim() || '(unknown sender)';
}

function gotoLink(tab, target, label) {
return `<span class="inline-goto-link" role="button" tabindex="0" data-goto-tab="${tab}" data-goto-target="${target}">${escapeHtml(label)}</span>`;
}

// Each produced record is shown the way the rest of the app shows that kind
// of record: a trip as its chip, anything else as a link to where it lives.
function producedHtml(p) {
if (p.kind === 'trip') {
const trip = tripById(p.id);
return trip ? tripChipHtml(trip) : escapeHtml(p.label || 'Trip (deleted)');
}
if (p.kind === 'catvisit') return gotoLink('travel', '#cat-sitting-rollup-strip', p.label || 'Cat-sitting visit');
if (p.kind === 'loyalty') return gotoLink('finances', '#loyalty-balances-panel', p.label || 'Loyalty balance');
if (p.kind === 'aporder') {
// aporders.js already opens and flashes the real order card from this attribute.
return p.id ? `<span class="inline-goto-link" role="button" tabindex="0" data-open-ap-order="${escapeHtml(p.id)}">${escapeHtml(p.label || 'AP order')}</span>` : gotoLink('shopping', '#ap-orders-panel', p.label || 'AP order');
}
if (p.kind === 'letting') return gotoLink('finances', '#letting-panel', p.label || 'Letting income');
return escapeHtml(p.label || '');
}

function matches(row, terms) {
if (featureFilter && row.feature !== featureFilter) return false;
if (outcomeFilter === 'attention' ? !ATTENTION.has(row.outcome) : (outcomeFilter && row.outcome !== outcomeFilter)) return false;
if (!terms.length) return true;
const hay = [row.from, row.subject, row.snippet, row.note, FEATURES[row.feature], ...(row.produced || []).map((p) => p.label)].join(' ').toLowerCase();
return terms.every((t) => hay.includes(t));
}

function renderMailHistory() {
const rowsEl = document.getElementById('mail-history-rows');
if (!rowsEl) return;
const countEl = document.getElementById('mail-history-count');
const all = data.mailLedger || [];
const terms = searchText.toLowerCase().split(/\s+/).filter(Boolean);
const list = all.filter((r) => matches(r, terms))
.sort((a, b) => String(b.date || b.seenAt).localeCompare(String(a.date || a.seenAt)));
const needAttention = all.filter((r) => ATTENTION.has(r.outcome)).length;
if (countEl) countEl.textContent = `${all.length} email${all.length === 1 ? '' : 's'} recorded${needAttention ? ` · ${needAttention} need a look` : ''}`;

if (!all.length) {
rowsEl.innerHTML = '<div class="settings-note" style="margin:0;">Nothing recorded yet. Emails appear here as the cat-sitting, loyalty, Agent Provocateur and Airbnb cancellation checks read them.</div>';
return;
}
if (!list.length) {
rowsEl.innerHTML = '<div class="settings-note" style="margin:0;">No recorded email matches that.</div>';
return;
}
const page = list.slice(0, shown);
rowsEl.innerHTML = `<table class="limits-table mail-history-table">
<thead><tr><th>Date</th><th>From</th><th>Subject</th><th>Check</th><th>Result</th><th></th></tr></thead>
<tbody>${page.map((r) => {
const o = OUTCOMES[r.outcome] || OUTCOMES.seen;
const date = r.date ? new Date(r.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : '';
const produced = (r.produced || []).map(producedHtml).join(' ');
const canRetry = !!retryHandlers[r.feature];
return `<tr>
<td>${escapeHtml(date)}</td>
<td>${escapeHtml(senderLabel(r.from))}</td>
<td><span class="inline-goto-link" role="button" tabindex="0" data-mh-open="${escapeHtml(r.messageId)}" data-mh-subject="${escapeHtml(r.subject || '')}" title="${escapeHtml(r.snippet || '')}">${escapeHtml(r.subject || '(no subject)')}</span></td>
<td>${escapeHtml(FEATURES[r.feature] || r.feature)}</td>
<td><span class="tag-chip mh-${o.cls}">${escapeHtml(o.label)}</span>${r.note ? ` <span class="settings-note" style="margin:0;display:inline;">${escapeHtml(r.note)}</span>` : ''}${produced ? `<div>${produced}</div>` : ''}</td>
<td>${canRetry ? `<button type="button" class="mini-task-btn" data-mh-retry="${escapeHtml(r.key)}" title="Read this email again and try to file it">Retry</button>` : ''}</td>
</tr>`;
}).join('')}</tbody>
</table>${list.length > page.length ? `<button type="button" class="sync-btn sm inline" id="mail-history-more" style="margin-top:8px;">Show ${Math.min(PAGE_SIZE, list.length - page.length)} more (${list.length - page.length} left)</button>` : ''}`;

rowsEl.querySelectorAll('[data-mh-open]').forEach((x) => {
const open = async () => {
const { openMessage } = await import('./mailviewer.js');
openMessage(x.dataset.mhOpen, { subject: x.dataset.mhSubject });
};
x.addEventListener('click', open);
x.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
});
rowsEl.querySelectorAll('[data-mh-retry]').forEach((b) => b.addEventListener('click', () => retryEntry(b.dataset.mhRetry, b)));
document.getElementById('mail-history-more')?.addEventListener('click', () => { shown += PAGE_SIZE; renderMailHistory(); });
bindTripChips();
}

async function retryEntry(key, button) {
const row = (data.mailLedger || []).find((r) => r.key === key);
const handler = row && retryHandlers[row.feature];
if (!handler) return;
if (button) button.disabled = true;
const where = [{ tab: 'settings', target: '#mail-history-block', label: 'Settings → Mail history' }];
try {
await runTracked({ id: 'mail-retry', label: 'Retry email', hint: 'a few seconds', leave: 'stops', where }, async (t) => {
t.note(`Reading "${row.subject || 'this email'}" again…`);
await handler.retry(row);
const after = (data.mailLedger || []).find((r) => r.key === key) || row;
const what = `${FEATURES[after.feature] || after.feature}: ${after.subject || 'email'}`;
if (after.outcome === 'filed') t.done(`${what} — filed.`, { where });
else if (after.outcome === 'failed') t.fail(`${what} — ${after.note || 'it failed again.'}`);
else t.zero(`${what} — ${after.note || OUTCOMES[after.outcome]?.label || 'nothing to file.'}`, { where });
});
} finally {
renderMailHistory();
}
}

function initMailHistory() {
const search = document.getElementById('mail-history-search');
const feature = document.getElementById('mail-history-feature');
const outcome = document.getElementById('mail-history-outcome');
if (feature && !feature.options.length) {
feature.innerHTML = `<option value="">All checks</option>${Object.entries(FEATURES).map(([k, v]) => `<option value="${k}">${escapeHtml(v)}</option>`).join('')}`;
}
search?.addEventListener('input', () => { searchText = search.value; shown = PAGE_SIZE; renderMailHistory(); });
feature?.addEventListener('change', () => { featureFilter = feature.value; shown = PAGE_SIZE; renderMailHistory(); });
outcome?.addEventListener('change', () => { outcomeFilter = outcome.value; shown = PAGE_SIZE; renderMailHistory(); });
renderMailHistory();
}

export { recordMail, registerRetry, initMailHistory, renderMailHistory, FEATURES };
