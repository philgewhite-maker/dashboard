// Imports a WhatsApp "Export chat" .txt file (with or without media) into an
// existing or new connection's chat history. Every export WhatsApp produces
// is the full transcript from the start of the chat, never a delta -- same
// assumption Tinder's own chat import already makes (see tinderimport.js's
// summarizeCleanMatch) -- so importing again just overwrites chatLog with
// whatever's now longer, rather than needing to dedupe line by line.
import { data, queueSave, recordImportRun, importStatusLine } from '../state.js';
import { escapeHtml, findMentions } from '../utils.js';
import { nameKey, editDistance } from '../googlecontacts.js';
import { STAGE_RANK, renderConnections, unionInto } from './connections.js';

// "DD/MM/YYYY, HH:MM - rest of line". Everything after this prefix belongs
// to whichever entry it starts; a line that doesn't match is a continuation
// of the previous entry (WhatsApp wraps long messages, captions, and even
// blank paragraph breaks onto bare lines with no prefix of their own --
// confirmed against two real exports, including a multi-paragraph message
// with an embedded blank line in the middle of it).
const LINE_START_RE = /^(\d{2})\/(\d{2})\/(\d{4}), (\d{2}):(\d{2}) - (.*)$/;

// The with-media export's placeholder for an attached file -- confirmed
// against a real export that this is exactly what replaces "<Media
// omitted>" when media is included, filename and all, with any caption
// following as a normal continuation line.
const MEDIA_ATTACHED_RE = /^(.+?\.[a-z0-9]{2,4}) \(file attached\)$/i;

function mediaIcon(filename) {
if (/\.(mp4|mov|3gp|avi)$/i.test(filename)) return '🎥';
if (/\.(opus|ogg|m4a|aac)$/i.test(filename)) return '🎤';
return '📷';
}

// Scans every "DATE, TIME - " line for a "Name: " prefix and ranks by how
// often each name appears -- the two most frequent are, in practice, always
// the two chat participants (a saved contact name or a raw phone number for
// someone not yet saved). System lines ("X is a contact", the encryption
// notice) never match this shape at all, so they fall out for free rather
// than needing their own detection.
function detectSenders(text) {
const counts = new Map();
String(text || '').replace(/\r\n/g, '\n').split('\n').forEach((line) => {
const m = line.match(LINE_START_RE);
if (!m) return;
const nm = m[6].match(/^([^:]{1,40}?): /);
if (nm) counts.set(nm[1], (counts.get(nm[1]) || 0) + 1);
});
return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
}

// meName/themName are exact sender strings from detectSenders() -- passing
// the wrong pair just means every line falls through to "system", which is
// visibly obvious in the review screen's counts rather than silently wrong.
function parseWhatsAppExport(text, meName, themName) {
const rawLines = String(text || '').replace(/\r\n/g, '\n').split('\n');
const entries = [];
rawLines.forEach((line) => {
const m = line.match(LINE_START_RE);
if (m) {
const [, dd, mm, yyyy, hh, min, rest] = m;
entries.push({ dateISO: `${yyyy}-${mm}-${dd}`, time: `${hh}:${min}`, rest, extra: [] });
} else if (entries.length) {
entries[entries.length - 1].extra.push(line);
}
});

const messages = [];
let systemCount = 0;
entries.forEach((e) => {
let sender = null;
let firstLine = e.rest;
if (meName && e.rest.startsWith(`${meName}: `)) { sender = meName; firstLine = e.rest.slice(meName.length + 2); }
else if (themName && e.rest.startsWith(`${themName}: `)) { sender = themName; firstLine = e.rest.slice(themName.length + 2); }
if (!sender) { systemCount++; return; }

const lines = [firstLine, ...e.extra];
let mediaFile = null; // null = no media; '' = media present but filename unknown (no-media export)
const mediaMatch = lines[0].match(MEDIA_ATTACHED_RE);
if (mediaMatch) { mediaFile = mediaMatch[1]; lines.shift(); }
else if (lines[0].trim() === '<Media omitted>') { mediaFile = ''; lines.shift(); }

const msgText = lines.join(' ').replace(/[ \t]+/g, ' ').trim();
messages.push({ dateISO: e.dateISO, time: e.time, sender, mediaFile, text: msgText });
});

return { messages, systemCount };
}

function formatMessageLine(m, meName) {
const senderLabel = m.sender === meName ? 'You' : m.sender;
let body = m.text;
if (m.mediaFile !== null) {
const tag = m.mediaFile ? `${mediaIcon(m.mediaFile)} ${m.mediaFile}` : `${mediaIcon('')} media (no caption in this export)`;
body = body ? `${tag} — ${body}` : tag;
}
if (!body) body = '🎙️ voice note or call (not captured in export)';
return `[${m.dateISO} ${m.time}] ${senderLabel}: ${body}`;
}

function buildChatLogText(messages, meName) {
return messages.map((m) => formatMessageLine(m, meName)).join('\n');
}

// Same shape as tinderimport.js's own matchCandidates(), minus the age
// nudge WhatsApp has no signal for -- kept local rather than imported since
// each importer owns its own thin matching layer over the shared
// nameKey/editDistance primitives (see tinderimport.js, photoscan.js).
function matchCandidates(name, limit) {
const key = nameKey(name);
if (!key) return [];
const results = [];
data.connections.forEach((c) => {
let best = null;
[c.name, c.profileName, ...(c.aliases || [])].filter(Boolean).forEach((n) => {
const nk = nameKey(n);
let score = null; let why = '';
if (nk === key) { score = 200; why = 'exact'; }
else if (nk.startsWith(key) || key.startsWith(nk)) { score = 100 - Math.abs(nk.length - key.length); why = 'shortened name'; }
else if (key.length >= 4) {
const d = editDistance(key, nk, 2);
if (d <= 2) { score = 60 - d * 10; why = `${d} letter${d === 1 ? '' : 's'} different`; }
}
if (score !== null && (!best || score > best.score)) best = { why, score };
});
if (best) results.push({ conn: c, why: best.why, score: best.score });
});
results.sort((a, b) => b.score - a.score);
return typeof limit === 'number' ? results.slice(0, limit) : results;
}

function createConnectionFor(name) {
const conn = {
id: `wa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, profileName: '', app: 'WhatsApp', priority: 3,
stage: 'Matched', lastContact: '', createdAt: new Date().toISOString(),
photoId: null, photoIds: [], tinderPhotoKeys: [], photoAlbums: [], age: '', dob: '', ageAsOf: '', location: [], address: '',
kids: '', job: '', height: '', education: '', phone: '', email: '',
contactStatus: '', contactResourceName: '', contactEtag: '', contactConflicts: [],
likes: '', notes: '', chatLog: '', chatLogWhatsApp: '', chatLogTelegram: '', languages: [], nationality: [],
todos: [], tags: [], aliases: [], dateLocations: [], dateEvents: [], sexTags: [],
ratings: {}, driveLink: '', photosAlbumUrl: '', photosPersonUrl: '',
};
data.connections.push(conn);
return conn;
}

const FIELD_LABELS = { location: 'City', nationality: 'Nationality' };

let pending = null;

function parseInput(text) {
const senders = detectSenders(text);
const meGuess = senders.find((s) => nameKey(s.name) === nameKey(data.myName)) || senders[0] || null;
const themGuess = senders.find((s) => s !== meGuess) || null;
pending = {
rawText: text,
senders,
meName: meGuess ? meGuess.name : '',
themName: themGuess ? themGuess.name : '',
chosenId: '',
};
reparse();
}

// Re-run the parse against pending.meName/themName -- called on load and
// whenever the "which of these is you" pickers change, since swapping them
// changes which lines are "You" vs the connection in the resulting chatLog.
function reparse() {
if (!pending) return;
const { messages, systemCount } = parseWhatsAppExport(pending.rawText, pending.meName, pending.themName);
pending.messages = messages;
pending.systemCount = systemCount;
pending.mediaCount = messages.filter((m) => m.mediaFile !== null).length;
pending.mediaNamedCount = messages.filter((m) => m.mediaFile).length;
pending.dateRange = messages.length ? [messages[0].dateISO, messages[messages.length - 1].dateISO] : null;
pending.candidates = pending.themName ? matchCandidates(pending.themName, 6) : [];
if (!pending.chosenId) {
const exact = pending.candidates.find((c) => c.why === 'exact');
if (exact) pending.chosenId = exact.conn.id;
}
const flatText = messages.map((m) => m.text).filter(Boolean).join('\n');
pending.mentions = findMentions(flatText, data.connections, data.flagRules);
}

function optionsFor(chosenId, candidates) {
const rest = data.connections.filter((c) => !candidates.some((m) => m.conn.id === c.id)).sort((a, b) => a.name.localeCompare(b.name));
const candidateOptions = candidates.map((m) => `<option value="${escapeHtml(m.conn.id)}"${m.conn.id === chosenId ? ' selected' : ''}>${escapeHtml(m.conn.name)}${m.why === 'exact' ? '' : ` (${escapeHtml(m.why)})`}</option>`).join('');
const restOptions = rest.map((c) => `<option value="${escapeHtml(c.id)}"${c.id === chosenId ? ' selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
return `<option value=""${chosenId ? '' : ' selected'}>— pick who this is —</option>`
+ (candidateOptions ? `<optgroup label="Likely match">${candidateOptions}</optgroup>` : '')
+ `<optgroup label="Everyone else">${restOptions}</optgroup>`
+ `<option value="__new__">+ New connection…</option>`;
}

function senderOptions(selected) {
return pending.senders.map((s) => `<option value="${escapeHtml(s.name)}"${s.name === selected ? ' selected' : ''}>${escapeHtml(s.name)} (${s.count})</option>`).join('');
}

function render() {
const el = document.getElementById('whatsapp-review');
if (!el) return;
if (!pending) { el.innerHTML = ''; return; }

if (!pending.senders.length) {
el.innerHTML = '<div class="settings-note">No timestamped messages found — check this is a real WhatsApp export .txt.</div>';
return;
}

const conn = pending.chosenId && pending.chosenId !== '__new__' ? data.connections.find((c) => c.id === pending.chosenId) : null;
const rangeHtml = pending.dateRange ? `${pending.dateRange[0]} → ${pending.dateRange[1]}` : '—';
const existingLines = conn ? String(conn.chatLogWhatsApp || '').split('\n').filter(Boolean).length : 0;
const newLines = pending.messages.length;
const growthNote = conn
? (newLines > existingLines ? `+${newLines - existingLines} chat line${newLines - existingLines === 1 ? '' : 's'} over what's saved` : 'No longer than what’s already saved — importing would not add anything')
: `${newLines} chat line${newLines === 1 ? '' : 's'}`;

el.innerHTML = `
<div class="settings-note" style="margin:0 0 10px;">
<label>You are <select id="wa-me-select">${senderOptions(pending.meName)}</select></label>
&nbsp; the other side is <b>${escapeHtml(pending.themName || '?')}</b>
&nbsp;·&nbsp; ${newLines} message${newLines === 1 ? '' : 's'}, ${rangeHtml}
&nbsp;·&nbsp; ${pending.mediaCount} media${pending.mediaNamedCount !== pending.mediaCount ? ` (${pending.mediaNamedCount} named)` : ''}
${pending.systemCount ? `&nbsp;·&nbsp; ${pending.systemCount} system line${pending.systemCount === 1 ? '' : 's'} skipped` : ''}
</div>
${pending.mentions.length ? `<div class="settings-note" style="margin:0 0 10px;"><b>Mentioned:</b> ${pending.mentions.map((h, i) => conn
? `<button type="button" class="tag-chip" style="cursor:pointer;border:none;" data-wa-mention="${i}" title="Click to add to ${FIELD_LABELS[h.field]}">+ ${escapeHtml(h.value)} (${FIELD_LABELS[h.field]})</button>`
: `<span class="tag-chip" title="Pick who this is to add it">${escapeHtml(h.value)} (${FIELD_LABELS[h.field]})</span>`).join(' ')}</div>` : ''}
<div class="sync-row">
<label>Import into <select id="wa-conn-select">${optionsFor(pending.chosenId, pending.candidates)}</select></label>
<span class="sync-status">${escapeHtml(growthNote)}</span>
</div>
<div class="sync-row" style="margin-top:8px;">
<button class="sync-btn" type="button" id="wa-import-go" ${pending.chosenId ? '' : 'disabled'}>Import chat</button>
</div>
`;

document.getElementById('wa-me-select').addEventListener('change', (e) => {
const newMe = e.target.value;
pending.themName = pending.senders.find((s) => s.name !== newMe)?.name || pending.themName;
pending.meName = newMe;
reparse();
render();
});
document.getElementById('wa-conn-select').addEventListener('change', (e) => {
pending.chosenId = e.target.value;
render();
});
el.querySelectorAll('[data-wa-mention]').forEach((btn) => {
btn.addEventListener('click', () => {
if (!conn) return;
const hit = pending.mentions[+btn.dataset.waMention];
unionInto(conn[hit.field], [hit.value]);
queueSave();
renderConnections();
const status = document.getElementById('whatsapp-status');
if (status) status.textContent = `Added ${hit.value} to ${conn.name}'s ${FIELD_LABELS[hit.field]}.`;
});
});
document.getElementById('wa-import-go').addEventListener('click', () => applyImport());
}

function applyImport() {
if (!pending || !pending.chosenId) return;
const conn = pending.chosenId === '__new__' ? createConnectionFor(pending.themName || 'New connection') : data.connections.find((c) => c.id === pending.chosenId);
if (!conn) return;

const newText = buildChatLogText(pending.messages, pending.meName);
const oldCount = String(conn.chatLogWhatsApp || '').split('\n').filter(Boolean).length;
const newCount = pending.messages.length;
let changed = false;
if (newCount > oldCount) { conn.chatLogWhatsApp = newText; changed = true; }

if ((STAGE_RANK['Moved to WhatsApp'] ?? 0) > (STAGE_RANK[conn.stage] ?? 0)) {
conn.stage = 'Moved to WhatsApp';
changed = true;
}
if (!conn.lastContact && pending.dateRange) conn.lastContact = pending.dateRange[1];

const status = document.getElementById('whatsapp-status');
if (status) status.textContent = changed ? `Saved to ${conn.name} (+${Math.max(newCount - oldCount, 0)} lines).` : `Nothing new for ${conn.name}.`;

recordImportRun('whatsapp', { scope: conn.name, count: changed ? 1 : 0 });
renderWhatsAppLastRun();
if (changed) { queueSave(); renderConnections(); }
pending = null;
render();
const textarea = document.getElementById('whatsapp-input');
if (textarea) textarea.value = '';
}

// ---------- bulk mode: many .txt files at once ----------

// WhatsApp's own export filename, e.g. "WhatsApp Chat with Katrina.txt" or
// "...no media.txt" -- a much more reliable "who is this" signal than
// guessing from message-count alone (a very one-sided chat could otherwise
// pick the wrong side as "them"), so it's preferred when present.
const FILENAME_NAME_RE = /^WhatsApp Chat with (.+?)(?:\s*\(\d+\))?(?:\s*no media)?\.txt$/i;

let bulkPending = null;

async function handleBulkFiles(fileList) {
const status = document.getElementById('whatsapp-status');
const el = document.getElementById('whatsapp-bulk-review');
document.getElementById('whatsapp-review').innerHTML = '';
pending = null;
if (status) status.textContent = `Reading ${fileList.length} files…`;

const rows = [];
for (const file of [...fileList]) {
const text = await file.text();
const nameMatch = file.name.match(FILENAME_NAME_RE);
const filenameHint = nameMatch ? nameMatch[1].trim() : '';
const senders = detectSenders(text);
if (!senders.length) { rows.push({ fileName: file.name, error: 'No timestamped messages found', senders: [] }); continue; }

let themGuess = filenameHint ? senders.find((s) => nameKey(s.name) === nameKey(filenameHint)) : null;
if (!themGuess) themGuess = senders.find((s) => nameKey(s.name) !== nameKey(data.myName)) || senders[senders.length > 1 ? 1 : 0];
const meGuess = senders.find((s) => s !== themGuess) || senders[0];

const { messages } = parseWhatsAppExport(text, meGuess.name, themGuess.name);
const flatText = messages.map((m) => m.text).filter(Boolean).join('\n');
const mentions = findMentions(flatText, data.connections, data.flagRules);
const displayName = filenameHint || themGuess.name;
const candidates = matchCandidates(displayName, 5);
let chosenId = '';
let confident = false;
const exact = candidates.find((c) => c.why === 'exact');
if (exact) { chosenId = exact.conn.id; confident = true; }

rows.push({
fileName: file.name, displayName, meName: meGuess.name, themName: themGuess.name,
messages, mentions, candidates, chosenId, confident, checked: confident,
});
}
bulkPending = { rows };
if (status) status.textContent = '';
renderBulk();
}

function bulkOptionsFor(chosenId, candidates) {
const matchIds = new Set(candidates.map((m) => m.conn.id));
const rest = data.connections.filter((c) => !matchIds.has(c.id)).sort((a, b) => a.name.localeCompare(b.name));
const matchOptions = candidates.map((m) => `<option value="${escapeHtml(m.conn.id)}"${m.conn.id === chosenId ? ' selected' : ''}>${escapeHtml(m.conn.name)}${m.why === 'exact' ? '' : ` (${escapeHtml(m.why)})`}</option>`).join('');
const restOptions = rest.map((c) => `<option value="${escapeHtml(c.id)}"${c.id === chosenId ? ' selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
return `<option value=""${chosenId ? '' : ' selected'}>— skip —</option>`
+ (matchOptions ? `<optgroup label="Likely match">${matchOptions}</optgroup>` : '')
+ `<optgroup label="Everyone else">${restOptions}</optgroup>`
+ `<option value="__new__">+ New connection…</option>`;
}

function bulkMentionsChipsHtml(row, i) {
if (!row.mentions.length) return '—';
const conn = row.chosenId && row.chosenId !== '__new__' ? data.connections.find((c) => c.id === row.chosenId) : null;
return row.mentions.map((h, j) => conn
? `<button type="button" class="tag-chip" style="cursor:pointer;border:none;" data-wab-mention="${i}:${j}" title="Click to add to ${FIELD_LABELS[h.field]}">+ ${escapeHtml(h.value)} (${FIELD_LABELS[h.field]})</button>`
: `<span class="tag-chip" title="Pick who this is to add it">${escapeHtml(h.value)} (${FIELD_LABELS[h.field]})</span>`).join(' ');
}

function renderBulk() {
const el = document.getElementById('whatsapp-bulk-review');
if (!el) return;
if (!bulkPending) { el.innerHTML = ''; return; }
if (!bulkPending.rows.length) { el.innerHTML = '<div class="settings-note" style="margin:0;">No files read.</div>'; return; }

const errorRows = bulkPending.rows.filter((r) => r.error);
const goodRows = bulkPending.rows.filter((r) => !r.error);
const confidentCount = goodRows.filter((r) => r.confident).length;

el.innerHTML = `
<div class="settings-note" style="margin:0 0 10px;">
${goodRows.length} chat${goodRows.length === 1 ? '' : 's'} read${errorRows.length ? `, ${errorRows.length} couldn't be parsed (${errorRows.map((r) => escapeHtml(r.fileName)).join(', ')})` : ''}
&nbsp;·&nbsp; ${confidentCount} exact-name-matched
</div>
<div class="sync-row" style="margin-bottom:8px;">
<button class="sync-btn" type="button" id="wab-select-confident">Select all confident matches</button>
<button class="sync-btn" type="button" id="wab-import-go">Import selected</button>
</div>
<div style="overflow-x:auto;">
<table class="limits-table">
<thead><tr><th></th><th>File</th><th>Messages</th><th>Match into</th><th>Mentioned</th></tr></thead>
<tbody>
${goodRows.map((row, i) => `<tr>
<td><input type="checkbox" data-wab-row="${i}" ${row.checked ? 'checked' : ''}></td>
<td>${escapeHtml(row.displayName)} <span class="settings-note" style="display:inline;margin:0;">(${escapeHtml(row.fileName)})</span></td>
<td>${row.messages.length}</td>
<td><select data-wab-select="${i}">${bulkOptionsFor(row.chosenId, row.candidates)}</select></td>
<td data-wab-mentions="${i}">${bulkMentionsChipsHtml(row, i)}</td>
</tr>`).join('')}
</tbody>
</table>
</div>
`;

el.querySelectorAll('[data-wab-row]').forEach((cb) => {
cb.addEventListener('change', () => { goodRows[+cb.dataset.wabRow].checked = cb.checked; });
});
el.querySelectorAll('[data-wab-select]').forEach((sel) => {
sel.addEventListener('change', () => {
const i = +sel.dataset.wabSelect;
const row = goodRows[i];
row.chosenId = sel.value;
row.checked = !!sel.value;
const cell = document.querySelector(`[data-wab-mentions="${i}"]`);
if (cell) cell.innerHTML = bulkMentionsChipsHtml(row, i);
});
});
document.getElementById('wab-select-confident').addEventListener('click', () => {
goodRows.forEach((r) => { if (r.confident) r.checked = true; });
renderBulk();
});
document.getElementById('wab-import-go').addEventListener('click', () => applyBulkImport());
}

async function applyBulkImport() {
const status = document.getElementById('whatsapp-status');
const goodRows = bulkPending.rows.filter((r) => !r.error);
const toImport = goodRows.filter((r) => r.checked && r.chosenId);
if (!toImport.length) { if (status) status.textContent = 'Nothing selected.'; return; }

let importedCount = 0;
let changed = false;
for (const row of toImport) {
const conn = row.chosenId === '__new__' ? createConnectionFor(row.displayName) : data.connections.find((c) => c.id === row.chosenId);
if (!conn) continue;
const newText = buildChatLogText(row.messages, row.meName);
const oldCount = String(conn.chatLogWhatsApp || '').split('\n').filter(Boolean).length;
if (row.messages.length > oldCount) { conn.chatLogWhatsApp = newText; changed = true; }
if ((STAGE_RANK['Moved to WhatsApp'] ?? 0) > (STAGE_RANK[conn.stage] ?? 0)) { conn.stage = 'Moved to WhatsApp'; changed = true; }
if (!conn.lastContact && row.messages.length) conn.lastContact = row.messages[row.messages.length - 1].dateISO;
importedCount++;
}

if (status) status.textContent = `Imported ${importedCount} chat${importedCount === 1 ? '' : 's'}.`;
recordImportRun('whatsapp', { scope: `bulk, ${toImport.length} file${toImport.length === 1 ? '' : 's'}`, count: importedCount });
renderWhatsAppLastRun();
if (changed) { queueSave(); renderConnections(); }
bulkPending = null;
renderBulk();
}

function renderWhatsAppLastRun() {
const el = document.getElementById('whatsapp-last-run');
if (el) el.textContent = importStatusLine('whatsapp');
}

function initWhatsAppImport() {
renderWhatsAppLastRun();
const btn = document.getElementById('whatsapp-import-btn');
const textarea = document.getElementById('whatsapp-input');
const fileInput = document.getElementById('whatsapp-file-input');
const status = document.getElementById('whatsapp-status');
if (!btn || !textarea) return;

btn.addEventListener('click', () => {
const text = textarea.value.trim();
if (!text) { if (status) status.textContent = 'Paste the exported chat text first.'; return; }
if (status) status.textContent = '';
document.getElementById('whatsapp-bulk-review').innerHTML = '';
bulkPending = null;
parseInput(text);
render();
});

fileInput.addEventListener('change', async () => {
if (!fileInput.files.length) return;
if (fileInput.files.length > 1) {
await handleBulkFiles(fileInput.files);
fileInput.value = '';
return;
}
const file = fileInput.files[0];
const text = await file.text();
textarea.value = text;
if (status) status.textContent = '';
document.getElementById('whatsapp-bulk-review').innerHTML = '';
bulkPending = null;
parseInput(text);
render();
fileInput.value = '';
});

// Delegated once, same reasoning as telegramimport.js's own mention
// click handler -- #whatsapp-bulk-review's innerHTML gets replaced on
// every renderBulk() call, and re-attaching a listener each time would
// fire once per render.
const bulkEl = document.getElementById('whatsapp-bulk-review');
if (bulkEl) {
bulkEl.addEventListener('click', (e) => {
const mBtn = e.target.closest('[data-wab-mention]');
if (!mBtn || !bulkPending) return;
const [rowIdx, mentionIdx] = mBtn.dataset.wabMention.split(':').map(Number);
const goodRows = bulkPending.rows.filter((r) => !r.error);
const row = goodRows[rowIdx];
if (!row) return;
const conn = row.chosenId && row.chosenId !== '__new__' ? data.connections.find((c) => c.id === row.chosenId) : null;
if (!conn) return;
const hit = row.mentions[mentionIdx];
unionInto(conn[hit.field], [hit.value]);
queueSave();
renderConnections();
if (status) status.textContent = `Added ${hit.value} to ${conn.name}'s ${FIELD_LABELS[hit.field]}.`;
});
}
}

export { initWhatsAppImport, parseWhatsAppExport, detectSenders, buildChatLogText, formatMessageLine };
