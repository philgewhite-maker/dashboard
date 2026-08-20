// Bulk-imports a Telegram Desktop "Export Telegram data" folder. Unlike
// WhatsApp (one chat pasted at a time), Telegram's own export is a full
// local folder containing every chat plus a contacts list with real phone
// numbers -- so this reads the whole thing at once (via a folder picker),
// cross-matches every chat against existing connections, and lets a bulk
// review pass apply the confident ones while flagging the rest for a glance.
import { data, queueSave, recordImportRun, importStatusLine, upsertIdentity } from '../state.js';
import { escapeHtml, findMentions } from '../utils.js';
import { nameKey, editDistance, phoneKey } from '../googlecontacts.js';
import { STAGE_RANK, renderConnections, unionInto } from './connections.js';
import { formatMessageLine, buildChatLogText } from './whatsappimport.js';
import { storePhoto } from '../files.js';

const FIELD_LABELS = { location: 'City', nationality: 'Nationality' };

// ---------- parsing lists/chats.html and lists/contacts.html ----------

function parseChatsList(html) {
const doc = new DOMParser().parseFromString(html, 'text/html');
return [...doc.querySelectorAll('.entry_list > a.entry')].map((a) => {
const href = a.getAttribute('href') || '';
const m = href.match(/chats\/(chat_\d+)\//);
const name = (a.querySelector('.name')?.textContent || '').trim();
const countText = (a.querySelector('.details_entry')?.textContent || '').trim();
const count = parseInt(countText, 10) || 0;
const type = (a.querySelector('.pull_right.info')?.textContent || '').trim();
return m ? { chatId: m[1], name, messageCount: count, type } : null;
}).filter(Boolean);
}

function parseContactsList(html) {
const doc = new DOMParser().parseFromString(html, 'text/html');
return [...doc.querySelectorAll('.entry_list > .entry')].map((el) => {
const name = (el.querySelector('.name')?.textContent || '').trim();
const phone = (el.querySelector('.details_entry')?.textContent || '').trim();
return { name, phone };
}).filter((c) => c.name);
}

// ---------- parsing one chat's messages.html ----------

// Every real message's full timestamp lives in this title attribute --
// "DD.MM.YYYY HH:MM:SS UTC+00:00" -- the visible text is just HH:MM, with
// no date at all on the vast majority of lines. Confirmed against a real
// export.
const TITLE_DATE_RE = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2})/;

function mediaIconGuess(name) {
if (/\.(mp4|mov|3gp|avi)$/i.test(name)) return '🎥';
if (/\.(ogg|opus|m4a|aac|mp3)$/i.test(name)) return '🎤';
return '📷';
}

// Consecutive messages from the same sender collapse into "joined" blocks
// with no from_name/avatar of their own (confirmed against a real export --
// unlike WhatsApp, which repeats the sender on every single line) -- the
// sender has to be carried forward from the last labelled message instead
// of read fresh each time.
// initialSender carries the last-known sender across a page boundary --
// Telegram splits a long chat into messages.html, messages2.html,
// messages3.html... and each page after the first can still open with a
// "joined" (unlabelled) block, so parsing a later page cold would
// miscount its opening run as unattributed system lines.
function parseTelegramMessages(html, initialSender = '') {
const doc = new DOMParser().parseFromString(html, 'text/html');
const nodes = [...doc.querySelectorAll('.history > .message')];
const messages = [];
let currentSender = initialSender;
let systemCount = 0;

nodes.forEach((el) => {
if (el.classList.contains('service')) { systemCount++; return; }

const nameEl = el.querySelector('.from_name');
if (nameEl) currentSender = nameEl.textContent.trim();
if (!currentSender) { systemCount++; return; }

const dateEl = el.querySelector('.pull_right.date.details');
const dm = (dateEl?.getAttribute('title') || '').match(TITLE_DATE_RE);
if (!dm) { systemCount++; return; }
const [, dd, mm, yyyy, hh, min] = dm;

let mediaFile = null;
const photoLink = el.querySelector('a.photo_wrap');
if (photoLink) {
mediaFile = decodeURIComponent((photoLink.getAttribute('href') || '').split('/').pop());
} else {
const mediaBody = el.querySelector('.media_wrap .media .body');
if (mediaBody) {
const title = (mediaBody.querySelector('.title')?.textContent || 'Attachment').trim();
const status = (mediaBody.querySelector('.status')?.textContent || '').trim();
// Telegram's own description text here is a full sentence written for
// someone reading the export in a browser ("Not included, change data
// exporting settings to download.") -- too long to sit inline in a chat
// line next to a real caption, so this only keeps a short marker.
const excluded = /not included/i.test(mediaBody.querySelector('.description')?.textContent || '');
mediaFile = [title, status].filter(Boolean).join(', ') + (excluded ? ' (not included)' : '');
}
}

let text = '';
const textEl = el.querySelector('.text');
if (textEl) {
const tmp = document.createElement('div');
tmp.innerHTML = textEl.innerHTML.replace(/<br\s*\/?>/gi, ' ');
text = tmp.textContent.replace(/[ \t]+/g, ' ').trim();
}

messages.push({ dateISO: `${yyyy}-${mm}-${dd}`, time: `${hh}:${min}`, sender: currentSender, mediaFile, text });
});

return { messages, systemCount, lastSender: currentSender };
}

function detectSenders(messages) {
const counts = new Map();
messages.forEach((m) => counts.set(m.sender, (counts.get(m.sender) || 0) + 1));
return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
}

// ---------- matching a chat to an existing connection ----------

// Same shape as tinderimport.js/whatsappimport.js's own matchCandidates --
// kept local rather than shared, same reasoning as those two.
function matchByName(name, limit) {
const key = nameKey(name);
if (!key) return [];
const results = [];
data.connections.forEach((c) => {
let best = null;
[c.name, c.profileName, ...(c.aliases || [])].filter(Boolean).forEach((n) => {
const nk = nameKey(n);
let score = null; let why = '';
if (nk === key) { score = 200; why = 'exact name'; }
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

// Joins a chat's display name to contacts.html's name->phone list, then
// matches that phone against an existing connection's phone field the same
// way Google Contacts auto-linking already trusts a phone match as
// certain (see contacts.js's findMatch()) -- this is the one signal
// reliable enough to bulk-apply without a glance, since two different
// "Kate"s can't share a phone number.
function matchByPhone(chatName, contactsByName) {
const phone = contactsByName.get(nameKey(chatName));
if (!phone) return null;
const key = phoneKey(phone);
if (!key) return null;
const conn = data.connections.find((c) => phoneKey(c.phone) === key);
return conn ? { conn, phone } : null;
}

function createConnectionFor(name) {
const conn = {
id: `tg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, profileName: '', identities: [], app: 'Telegram', priority: 3,
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

// ---------- folder picker + bulk review UI ----------

// Matched by suffix rather than a stripped-prefix path, so this doesn't
// care what the export's top-level folder is named (it changes every
// export -- "DataExport_2026-08-18" today, a different date next time).
//
// A chat past a few hundred messages splits across messages.html,
// messages2.html, messages3.html... (confirmed: Vanessa Torres' 5768-message
// chat is nowhere near one file) -- every page for a chat is collected and
// sorted here so applyImport() can walk them in order rather than silently
// reading only the first.
function indexFiles(fileList) {
const files = [...fileList];
const chatsHtmlFile = files.find((f) => /(^|\/)lists\/chats\.html$/.test(f.webkitRelativePath));
const contactsHtmlFile = files.find((f) => /(^|\/)lists\/contacts\.html$/.test(f.webkitRelativePath));
const messagePages = new Map();
const photosByChat = new Map();
files.forEach((f) => {
const mm = f.webkitRelativePath.match(/(^|\/)chats\/(chat_\d+)\/messages(\d*)\.html$/);
if (mm) {
const chatId = mm[2];
const page = mm[3] ? parseInt(mm[3], 10) : 1;
if (!messagePages.has(chatId)) messagePages.set(chatId, []);
messagePages.get(chatId).push({ page, file: f });
return;
}
const pm = f.webkitRelativePath.match(/(^|\/)chats\/(chat_\d+)\/photos\/([^/]+)$/);
if (pm) {
if (!photosByChat.has(pm[2])) photosByChat.set(pm[2], new Map());
photosByChat.get(pm[2]).set(pm[3], f);
}
});
const messagesByChat = new Map();
messagePages.forEach((pages, chatId) => {
pages.sort((a, b) => a.page - b.page);
messagesByChat.set(chatId, pages.map((p) => p.file));
});
return { chatsHtmlFile, contactsHtmlFile, messagesByChat, photosByChat };
}

let pending = null;

async function handleFolderPick(fileList) {
const status = document.getElementById('telegram-status');
const { chatsHtmlFile, contactsHtmlFile, messagesByChat, photosByChat } = indexFiles(fileList);
if (!chatsHtmlFile || !contactsHtmlFile) {
status.textContent = "Couldn't find lists/chats.html and lists/contacts.html in that folder — pick the export's top-level folder (the one containing \"lists\" and \"chats\").";
return;
}
status.textContent = 'Reading contacts and chat list…';
const [chatsHtml, contactsHtml] = await Promise.all([chatsHtmlFile.text(), contactsHtmlFile.text()]);
const allChats = parseChatsList(chatsHtml);
const contacts = parseContactsList(contactsHtml);
const contactsByName = new Map();
contacts.forEach((c) => { if (c.phone) contactsByName.set(nameKey(c.name), c.phone); });

// A "1 message" chat is Telegram's own join announcement, not a real
// conversation -- confirmed against two real examples, both of which
// parse to zero actual messages (the single entry is a .message.service
// line, not a real one). Anything without its own messages.html on disk
// (export settings can exclude chat content entirely) is skipped too.
const chats = allChats.filter((c) => c.type === 'private' && c.messageCount > 1 && messagesByChat.has(c.chatId));

const rows = chats.map((chat) => {
const phoneMatch = matchByPhone(chat.name, contactsByName);
const nameMatches = matchByName(chat.name, 5);
let chosenId = '';
let confident = false;
if (phoneMatch) { chosenId = phoneMatch.conn.id; confident = true; }
else if (nameMatches[0] && nameMatches[0].why === 'exact name') { chosenId = nameMatches[0].conn.id; confident = true; }
return { chat, nameMatches, phoneMatch, chosenId, confident, checked: confident };
});
rows.sort((a, b) => b.chat.messageCount - a.chat.messageCount);

const generation = (pending?.generation || 0) + 1;
pending = { messagesByChat, photosByChat, rows, importPhotos: false, skippedCount: allChats.length - chats.length, generation };
status.textContent = '';
render();
scanMentions(generation);
}

// Runs after the list is already on screen -- reading and highlighting
// every chat up front would delay the initial render for no reason, so
// this walks rows in the background and patches each "Mentioned" cell in
// as its result lands, same city/flag-rule pipeline the WhatsApp and
// Tinder reviews already use. Caches the parsed messages on the row too,
// so applyImport() doesn't re-read the same files a second time.
async function scanMentions(generation) {
if (!pending || pending.generation !== generation) return;
for (let i = 0; i < pending.rows.length; i++) {
if (!pending || pending.generation !== generation) return;
const row = pending.rows[i];
const files = pending.messagesByChat.get(row.chat.chatId);
if (!files || !files.length) continue;
const messages = await readAllMessages(files);
if (!pending || pending.generation !== generation) return;
row.messages = messages;
const flatText = messages.map((m) => m.text).filter(Boolean).join('\n');
row.mentions = findMentions(flatText, data.connections, data.flagRules);
const cell = document.querySelector(`[data-tg-mentions="${i}"]`);
if (cell) cell.innerHTML = mentionsChipsHtml(row, i);
}
}

// Chips are clickable once a real connection is chosen for the row, same
// "pick who this is first" gate as WhatsApp's import -- rendered by both
// the initial table build and scanMentions()'s later per-cell patch, so
// they need to stay in sync rather than duplicating the markup twice.
function mentionsChipsHtml(row, i) {
if (!row.mentions) return '<span class="settings-note" style="margin:0;">scanning…</span>';
if (!row.mentions.length) return '—';
const conn = row.chosenId && row.chosenId !== '__new__' ? data.connections.find((c) => c.id === row.chosenId) : null;
return row.mentions.map((h, j) => conn
? `<button type="button" class="tag-chip" style="cursor:pointer;border:none;" data-tg-mention="${i}:${j}" title="Click to add to ${FIELD_LABELS[h.field]}">+ ${escapeHtml(h.value)} (${FIELD_LABELS[h.field]})</button>`
: `<span class="tag-chip" title="Pick who this is to add it">${escapeHtml(h.value)} (${FIELD_LABELS[h.field]})</span>`).join(' ');
}

function optionsFor(chosenId, nameMatches) {
const matchIds = new Set(nameMatches.map((m) => m.conn.id));
const rest = data.connections.filter((c) => !matchIds.has(c.id)).sort((a, b) => a.name.localeCompare(b.name));
const matchOptions = nameMatches.map((m) => `<option value="${escapeHtml(m.conn.id)}"${m.conn.id === chosenId ? ' selected' : ''}>${escapeHtml(m.conn.name)} (${escapeHtml(m.why)})</option>`).join('');
const restOptions = rest.map((c) => `<option value="${escapeHtml(c.id)}"${c.id === chosenId ? ' selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
return `<option value=""${chosenId ? '' : ' selected'}>— skip —</option>`
+ (matchOptions ? `<optgroup label="Likely match">${matchOptions}</optgroup>` : '')
+ `<optgroup label="Everyone else">${restOptions}</optgroup>`
+ `<option value="__new__">+ New connection…</option>`;
}

function render() {
const el = document.getElementById('telegram-review');
if (!el) return;
if (!pending) { el.innerHTML = ''; return; }
if (!pending.rows.length) { el.innerHTML = '<div class="settings-note" style="margin:0;">No chats with more than one message found.</div>'; return; }

const confidentCount = pending.rows.filter((r) => r.confident).length;
el.innerHTML = `
<div class="settings-note" style="margin:0 0 10px;">
${pending.rows.length} chat${pending.rows.length === 1 ? '' : 's'} with a real conversation (${pending.skippedCount} join-only/group/excluded chats skipped)
&nbsp;·&nbsp; ${confidentCount} phone- or exact-name-matched
</div>
<div class="sync-row" style="margin-bottom:8px;">
<button class="sync-btn" type="button" id="tg-select-confident">Select all confident matches</button>
<button class="sync-btn" type="button" id="tg-import-go">Import selected</button>
<label><input type="checkbox" id="tg-import-photos" ${pending.importPhotos ? 'checked' : ''}> Also bring in the photos actually included in each chat (uses more space/sync)</label>
</div>
<div style="overflow-x:auto;">
<table class="limits-table">
<thead><tr><th></th><th>Chat</th><th>Messages</th><th>Match into</th><th>Mentioned</th></tr></thead>
<tbody>
${pending.rows.map((row, i) => `<tr>
<td><input type="checkbox" data-tg-row="${i}" ${row.checked ? 'checked' : ''}></td>
<td>${escapeHtml(row.chat.name)}${row.phoneMatch ? ' <span class="settings-note" style="display:inline;margin:0;">(phone match)</span>' : ''}${pending.photosByChat.has(row.chat.chatId) ? ' 📷' : ''}</td>
<td>${row.chat.messageCount}</td>
<td><select data-tg-select="${i}">${optionsFor(row.chosenId, row.nameMatches)}</select></td>
<td data-tg-mentions="${i}">${mentionsChipsHtml(row, i)}</td>
</tr>`).join('')}
</tbody>
</table>
</div>
`;

el.querySelectorAll('[data-tg-row]').forEach((cb) => {
cb.addEventListener('change', () => { pending.rows[+cb.dataset.tgRow].checked = cb.checked; });
});
el.querySelectorAll('[data-tg-select]').forEach((sel) => {
sel.addEventListener('change', () => {
const i = +sel.dataset.tgSelect;
const row = pending.rows[i];
row.chosenId = sel.value;
row.checked = !!sel.value;
// Whether a mention chip is clickable depends on a real connection
// being chosen -- refresh just that cell rather than the whole table.
const cell = document.querySelector(`[data-tg-mentions="${i}"]`);
if (cell) cell.innerHTML = mentionsChipsHtml(row, i);
});
});
document.getElementById('tg-select-confident').addEventListener('click', () => {
pending.rows.forEach((r) => { if (r.confident) r.checked = true; });
render();
});
document.getElementById('tg-import-photos').addEventListener('change', (e) => { pending.importPhotos = e.target.checked; });
document.getElementById('tg-import-go').addEventListener('click', () => applyImport());
}

// Reads every page of a chat in order (messages.html, messages2.html, ...),
// threading the last-seen sender across the page boundary so a page that
// opens mid-"joined"-run still attributes correctly.
async function readAllMessages(files) {
let messages = [];
let lastSender = '';
for (const file of files) {
const html = await file.text();
const parsed = parseTelegramMessages(html, lastSender);
messages = messages.concat(parsed.messages);
lastSender = parsed.lastSender;
}
return messages;
}

async function applyImport() {
const status = document.getElementById('telegram-status');
const toImport = pending.rows.filter((r) => r.checked && r.chosenId);
if (!toImport.length) { status.textContent = 'Nothing selected.'; return; }
const importPhotos = pending.importPhotos;

let importedCount = 0;
let photoCount = 0;
let changed = false;
for (const row of toImport) {
status.textContent = `Importing ${row.chat.name}… (${importedCount + 1}/${toImport.length})`;
// Reuses scanMentions()'s cached parse when it's already landed for this
// row, rather than reading the same files a second time.
let messages = row.messages;
if (!messages) {
const files = pending.messagesByChat.get(row.chat.chatId);
if (!files || !files.length) continue;
messages = await readAllMessages(files);
}
if (!messages.length) continue;
const senders = detectSenders(messages);
const themName = row.chat.name;
const meName = senders.find((s) => s.name !== themName)?.name || senders[0]?.name || '';

const conn = row.chosenId === '__new__' ? createConnectionFor(row.chat.name) : data.connections.find((c) => c.id === row.chosenId);
if (!conn) continue;

const newText = buildChatLogText(messages, meName);
const oldCount = String(conn.chatLogTelegram || '').split('\n').filter(Boolean).length;
if (messages.length > oldCount) { conn.chatLogTelegram = newText; changed = true; }
if ((STAGE_RANK['Moved to Telegram'] ?? 0) > (STAGE_RANK[conn.stage] ?? 0)) { conn.stage = 'Moved to Telegram'; changed = true; }
if (!conn.lastContact) conn.lastContact = messages[messages.length - 1].dateISO;
upsertIdentity(conn, { platform: 'Telegram', handle: row.chat.name, matchId: row.chat.chatId });

// mediaFile is only ever a real filename for an actually-included photo
// -- the excluded-media placeholder is a human-readable sentence that
// never matches a real file, so this needs no separate type tag.
if (importPhotos) {
const chatPhotos = pending.photosByChat.get(row.chat.chatId);
if (chatPhotos) {
const seen = new Set();
for (const m of messages) {
if (!m.mediaFile || seen.has(m.mediaFile)) continue;
const file = chatPhotos.get(m.mediaFile);
if (!file) continue;
seen.add(m.mediaFile);
const id = await storePhoto(file);
if (!conn.photoIds.includes(id)) conn.photoIds.push(id);
photoCount++;
changed = true;
}
}
}
importedCount++;
}

status.textContent = `Imported ${importedCount} chat${importedCount === 1 ? '' : 's'}${importPhotos ? `, ${photoCount} photo${photoCount === 1 ? '' : 's'}` : ''}.`;
recordImportRun('telegram', { scope: `${toImport.length} chat${toImport.length === 1 ? '' : 's'} selected`, count: importedCount });
renderTelegramLastRun();
if (changed) { queueSave(); renderConnections(); }
pending = null;
render();
}

function renderTelegramLastRun() {
const el = document.getElementById('telegram-last-run');
if (el) el.textContent = importStatusLine('telegram');
}

function initTelegramImport() {
renderTelegramLastRun();
const input = document.getElementById('telegram-folder-input');
if (!input) return;
input.addEventListener('change', () => {
if (input.files.length) handleFolderPick(input.files);
});
// Delegated once here rather than re-attached on every render() -- the
// review table's innerHTML gets replaced often (row toggles, "select all
// confident"), and re-adding a listener each time would fire a click
// handler once per render since old listeners on the same #telegram-review
// element are never removed.
const reviewEl = document.getElementById('telegram-review');
if (reviewEl) {
reviewEl.addEventListener('click', (e) => {
const btn = e.target.closest('[data-tg-mention]');
if (!btn || !pending) return;
const [rowIdx, mentionIdx] = btn.dataset.tgMention.split(':').map(Number);
const row = pending.rows[rowIdx];
if (!row) return;
const conn = row.chosenId && row.chosenId !== '__new__' ? data.connections.find((c) => c.id === row.chosenId) : null;
if (!conn) return;
const hit = row.mentions[mentionIdx];
unionInto(conn[hit.field], [hit.value]);
queueSave();
renderConnections();
const status = document.getElementById('telegram-status');
if (status) status.textContent = `Added ${hit.value} to ${conn.name}'s ${FIELD_LABELS[hit.field]}.`;
});
}
}

export {
initTelegramImport, parseChatsList, parseContactsList, parseTelegramMessages, detectSenders,
matchByName, matchByPhone, createConnectionFor, formatMessageLine, buildChatLogText,
};
