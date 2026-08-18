// Bulk-imports a Telegram Desktop "Export Telegram data" folder. Unlike
// WhatsApp (one chat pasted at a time), Telegram's own export is a full
// local folder containing every chat plus a contacts list with real phone
// numbers -- so this reads the whole thing at once (via a folder picker),
// cross-matches every chat against existing connections, and lets a bulk
// review pass apply the confident ones while flagging the rest for a glance.
import { data, queueSave } from '../state.js';
import { escapeHtml, knownCityMap, highlightFlagValues } from '../utils.js';
import { nameKey, editDistance, phoneKey } from '../googlecontacts.js';
import { STAGE_RANK, renderConnections } from './connections.js';
import { formatMessageLine, buildChatLogText } from './whatsappimport.js';

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
function parseTelegramMessages(html) {
const doc = new DOMParser().parseFromString(html, 'text/html');
const nodes = [...doc.querySelectorAll('.history > .message')];
const messages = [];
let currentSender = '';
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

return { messages, systemCount };
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
id: `tg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name, profileName: '', app: 'Telegram', priority: 3,
stage: 'Matched', lastContact: '', createdAt: new Date().toISOString(),
photoId: null, photoIds: [], tinderPhotoKeys: [], photoAlbums: [], age: '', dob: '', ageAsOf: '', location: [], address: '',
kids: '', job: '', height: '', education: '', phone: '', email: '',
contactStatus: '', contactResourceName: '', contactEtag: '', contactConflicts: [],
likes: '', notes: '', chatLog: '', languages: [], nationality: [],
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
function indexFiles(fileList) {
const files = [...fileList];
const chatsHtmlFile = files.find((f) => /(^|\/)lists\/chats\.html$/.test(f.webkitRelativePath));
const contactsHtmlFile = files.find((f) => /(^|\/)lists\/contacts\.html$/.test(f.webkitRelativePath));
const messagesByChat = new Map();
files.forEach((f) => {
const m = f.webkitRelativePath.match(/(^|\/)chats\/(chat_\d+)\/messages\.html$/);
if (m) messagesByChat.set(m[2], f);
});
return { chatsHtmlFile, contactsHtmlFile, messagesByChat };
}

let pending = null;

async function handleFolderPick(fileList) {
const status = document.getElementById('telegram-status');
const { chatsHtmlFile, contactsHtmlFile, messagesByChat } = indexFiles(fileList);
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

pending = { messagesByChat, rows, skippedCount: allChats.length - chats.length };
status.textContent = '';
render();
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
</div>
<div style="overflow-x:auto;">
<table class="limits-table">
<thead><tr><th></th><th>Chat</th><th>Messages</th><th>Match into</th></tr></thead>
<tbody>
${pending.rows.map((row, i) => `<tr>
<td><input type="checkbox" data-tg-row="${i}" ${row.checked ? 'checked' : ''}></td>
<td>${escapeHtml(row.chat.name)}${row.phoneMatch ? ' <span class="settings-note" style="display:inline;margin:0;">(phone match)</span>' : ''}</td>
<td>${row.chat.messageCount}</td>
<td><select data-tg-select="${i}">${optionsFor(row.chosenId, row.nameMatches)}</select></td>
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
const row = pending.rows[+sel.dataset.tgSelect];
row.chosenId = sel.value;
row.checked = !!sel.value;
});
});
document.getElementById('tg-select-confident').addEventListener('click', () => {
pending.rows.forEach((r) => { if (r.confident) r.checked = true; });
render();
});
document.getElementById('tg-import-go').addEventListener('click', () => applyImport());
}

async function applyImport() {
const status = document.getElementById('telegram-status');
const toImport = pending.rows.filter((r) => r.checked && r.chosenId);
if (!toImport.length) { status.textContent = 'Nothing selected.'; return; }
status.textContent = `Importing ${toImport.length} chat${toImport.length === 1 ? '' : 's'}…`;

let importedCount = 0;
let changed = false;
for (const row of toImport) {
const file = pending.messagesByChat.get(row.chat.chatId);
if (!file) continue;
const html = await file.text();
const { messages } = parseTelegramMessages(html);
if (!messages.length) continue;
const senders = detectSenders(messages);
const themName = row.chat.name;
const meName = senders.find((s) => s.name !== themName)?.name || senders[0]?.name || '';

const conn = row.chosenId === '__new__' ? createConnectionFor(row.chat.name) : data.connections.find((c) => c.id === row.chosenId);
if (!conn) continue;

const newText = buildChatLogText(messages, meName);
const oldCount = String(conn.chatLog || '').split('\n').filter(Boolean).length;
if (messages.length > oldCount) { conn.chatLog = newText; changed = true; }
if ((STAGE_RANK['Moved to Telegram'] ?? 0) > (STAGE_RANK[conn.stage] ?? 0)) { conn.stage = 'Moved to Telegram'; changed = true; }
if (!conn.lastContact) conn.lastContact = messages[messages.length - 1].dateISO;
importedCount++;
}

status.textContent = `Imported ${importedCount} chat${importedCount === 1 ? '' : 's'}.`;
if (changed) { queueSave(); renderConnections(); }
pending = null;
render();
}

function initTelegramImport() {
const input = document.getElementById('telegram-folder-input');
if (!input) return;
input.addEventListener('change', () => {
if (input.files.length) handleFolderPick(input.files);
});
}

export {
initTelegramImport, parseChatsList, parseContactsList, parseTelegramMessages, detectSenders,
matchByName, matchByPhone, createConnectionFor, formatMessageLine, buildChatLogText,
};
