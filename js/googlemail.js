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

// Turns one configured row into a Gmail query string. Returns null when
// there's nothing to search for, so an incomplete row is skipped rather
// than sent as an empty query — Gmail would read that as "everything".
function buildQuery(search) {
const value = String(search.value || '').trim();
let base;
switch (search.kind) {
case 'starred': base = 'is:starred'; break;
case 'from': base = value && `from:${value}`; break;
case 'to': base = value && `to:${value}`; break;
case 'subject': base = value && `subject:(${value})`; break;
case 'contains': base = value; break;
default: base = value; // raw Gmail query
}
if (!base) return null;
const days = Math.max(0, Number(search.maxDays) || 0);
return days > 0 ? `${base} newer_than:${days}d` : base;
}

// Runs each configured search and returns [{label, messages}] in the order
// they're listed. A message matching several rows appears only under the
// first — you control the order, so first-match-wins is predictable, and it
// keeps the panel from repeating the same email under three headings.
async function fetchMailSearches(searches, defaultCount) {
const runnable = (searches || [])
.map((s) => ({ search: s, query: buildQuery(s) }))
.filter((r) => r.query);

const results = await Promise.all(runnable.map(async ({ search, query }) => {
const limit = Math.max(1, Number(search.maxEvents) || Number(defaultCount) || 5);
return { search, ids: await searchMessageIds(query, limit) };
}));

const seen = new Set();
const sections = [];
for (const { search, ids } of results) {
const unique = ids.filter((id) => !seen.has(id));
unique.forEach((id) => seen.add(id));
sections.push({ search, ids: unique });
}

const allIds = sections.flatMap((s) => s.ids);
const summaries = {};
await Promise.all(allIds.map(async (id) => {
try { summaries[id] = await getMessageSummary(id); } catch (e) { /* skip unreadable message */ }
}));

return sections.map(({ search, ids }) => ({
search,
messages: ids.map((id) => summaries[id]).filter(Boolean)
.sort((a, b) => new Date(b.date) - new Date(a.date)),
}));
}

export { fetchMailSearches, buildQuery };
