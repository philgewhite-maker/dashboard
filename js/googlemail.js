// Reads (never sends, modifies, or deletes) Gmail — the top 5 starred
// messages, plus anything from a couple of tracked senders in the last 2
// days. Uses the same shared Google sign-in as Drive and Calendar
// (googleauth.js), via the `gmail.readonly` scope.
import { googleFetch } from './sync/googleauth.js';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

async function searchMessageIds(query, maxResults) {
const params = new URLSearchParams({ q: query, maxResults: String(maxResults) });
const res = await googleFetch(`${GMAIL_API}/messages?${params}`);
if (!res.ok) throw new Error(`Gmail search failed: ${res.status}`);
const json = await res.json();
return (json.messages || []).map((m) => m.id);
}

async function getMessageSummary(id) {
const params = new URLSearchParams({ format: 'metadata' });
['From', 'Subject', 'Date'].forEach((h) => params.append('metadataHeaders', h));
const res = await googleFetch(`${GMAIL_API}/messages/${id}?${params}`);
if (!res.ok) throw new Error(`Gmail message fetch failed: ${res.status}`);
const json = await res.json();
const headers = {};
(json.payload?.headers || []).forEach((h) => { headers[h.name] = h.value; });
return {
id,
threadId: json.threadId,
from: headers.From || '(unknown sender)',
subject: headers.Subject || '(no subject)',
date: headers.Date || '',
snippet: json.snippet || '',
link: `https://mail.google.com/mail/u/0/#all/${json.threadId || id}`,
};
}

// Returns { starred, fromTracked } — each an array of message summaries,
// newest first. A message that's both starred AND from a tracked sender
// only appears in `starred` (dedup by id), so the two lists never repeat
// the same email.
async function fetchMailSummary(prefs) {
const senders = (prefs.trackedSenders || []).map((s) => String(s).trim()).filter(Boolean);
const starredLimit = Math.max(0, Number(prefs.mailStarredLimit) || 0);
// With no senders configured there's no meaningful query to run — Gmail
// would treat `() newer_than:2d` as "everything from the last 2 days",
// which is emphatically not what an empty list should mean.
const senderQuery = senders.length
? `(${senders.map((e) => `from:${e}`).join(' OR ')}) newer_than:${Math.max(1, Number(prefs.mailSenderDays) || 1)}d`
: null;
const [starredIds, senderIds] = await Promise.all([
starredLimit > 0 ? searchMessageIds('is:starred', starredLimit) : Promise.resolve([]),
senderQuery ? searchMessageIds(senderQuery, Math.max(1, Number(prefs.mailSenderLimit) || 1)) : Promise.resolve([]),
]);

const starredIdSet = new Set(starredIds);
const uniqueSenderIds = senderIds.filter((id) => !starredIdSet.has(id));
const allIds = [...starredIds, ...uniqueSenderIds];

const summaries = {};
await Promise.all(allIds.map(async (id) => {
try { summaries[id] = await getMessageSummary(id); } catch (e) { /* skip unreadable message */ }
}));

const byNewest = (ids) => ids.map((id) => summaries[id]).filter(Boolean)
.sort((a, b) => new Date(b.date) - new Date(a.date));

return { starred: byNewest(starredIds), fromTracked: byNewest(uniqueSenderIds) };
}

export { fetchMailSummary };
