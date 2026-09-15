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
// Fetched generously above `limit` -- js/features/mail.js hides any
// message already turned into a task/trip-leg/date-event in its own
// collapsed section, without it counting against this search's
// configured count. Gmail's own maxResults can't exclude specific ids
// server-side, so the only way an already-processed message doesn't
// silently crowd out a genuinely new one is fetching enough headroom
// that filtering some out at render time still leaves `limit` worth of
// actionable ones in the common case.
const fetchLimit = Math.ceil(limit * 1.5) + 5;
return { search, limit, ids: await searchMessageIds(query, fetchLimit) };
}));

const seen = new Set();
const sections = [];
for (const { search, limit, ids } of results) {
const unique = ids.filter((id) => !seen.has(id));
unique.forEach((id) => seen.add(id));
sections.push({ search, limit, ids: unique });
}

const allIds = sections.flatMap((s) => s.ids);
const summaries = {};
await Promise.all(allIds.map(async (id) => {
try { summaries[id] = await getMessageSummary(id); } catch (e) { /* skip unreadable message */ }
}));

return sections.map(({ search, limit, ids }) => ({
search,
limit,
messages: ids.map((id) => summaries[id]).filter(Boolean)
.sort((a, b) => new Date(b.date) - new Date(a.date)),
}));
}

// Gmail's API uses URL-safe base64 (- and _ instead of + and /), often
// without the trailing = padding a normal atob() needs.
function base64UrlDecode(data) {
const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
const binary = atob(padded);
const bytes = new Uint8Array(binary.length);
for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
return new TextDecoder('utf-8').decode(bytes);
}

function stripHtml(html) {
const doc = new DOMParser().parseFromString(html, 'text/html');
return (doc.body?.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

// Depth-first search through a (possibly multipart/nested) message payload
// for the first part of the given MIME type's raw base64 body data.
function findBodyPart(payload, mimeType) {
if (!payload) return null;
if (payload.mimeType === mimeType && payload.body?.data) return payload.body.data;
for (const part of payload.parts || []) {
const found = findBodyPart(part, mimeType);
if (found) return found;
}
return null;
}

// Full message body, for AI extraction (trip logistics) rather than the
// From/Subject/snippet metadata fetchMailSearches deals in -- a separate,
// heavier call so the normal mail list stays cheap. Prefers the plain-text
// part; falls back to stripping the HTML part, since some booking
// confirmations are HTML-only.
async function getMessageBody(id) {
const res = await googleFetch(`${GMAIL_API}/messages/${id}?format=full`);
if (!res.ok) throw new Error(`Gmail message fetch failed: ${res.status}`);
const json = await res.json();
const plain = findBodyPart(json.payload, 'text/plain');
if (plain) return base64UrlDecode(plain);
const html = findBodyPart(json.payload, 'text/html');
if (html) return stripHtml(base64UrlDecode(html));
return '';
}

export { fetchMailSearches, buildQuery, getMessageBody };
