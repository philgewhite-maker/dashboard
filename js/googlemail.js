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

// Gmail's web UI is asked for one specific message by its RFC822
// Message-ID, not by the API's thread id.
//
// `#all/<threadId>` used to open the thread, and stopped: the API's
// thread id is a hex string, while Gmail's own URLs now use a different
// permalink id (FMfcg...), and an id it doesn't recognise simply drops
// you in the inbox -- which is exactly the reported symptom. A
// Message-ID search is the stable way to address one message: it's the
// id the mail itself carries, so it doesn't depend on Google's internal
// id scheme at all.
function gmailLink(headers, threadId, id) {
// The MESSAGE id, not the thread id. Both come back from the same API
// response and it's easy to reach for the wrong one -- the first
// version of this used threadId and always landed on the inbox.
// `#all/` rather than `#inbox/` so an archived message still resolves.
//
// Still not certain this id space works at all: Gmail's own URLs use a
// different permalink id (FMfcg...) that the API never returns, and a
// thread id in this position is definitely ignored. If a message id is
// ignored too, no URL we can build will open a specific message, and
// the answer is to render it in the app instead.
return `https://mail.google.com/mail/u/0/#all/${id}`;
}

async function getMessageSummary(id) {
const params = new URLSearchParams({ format: 'metadata' });
['From', 'Subject', 'Date', 'Message-ID'].forEach((h) => params.append('metadataHeaders', h));
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
link: gmailLink(headers, json.threadId, id),
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
// without the trailing = padding a normal atob() needs. Returns raw bytes --
// base64UrlDecode below is the text-specific wrapper most callers actually
// want (a message body, an .ics file); an image/PDF attachment needs the
// bytes themselves, undecoded as text, so it gets this one directly.
function base64UrlDecodeBytes(data) {
const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
const binary = atob(padded);
const bytes = new Uint8Array(binary.length);
for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
return bytes;
}

function base64UrlDecode(data) {
return new TextDecoder('utf-8').decode(base64UrlDecodeBytes(data));
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

function bodyTextFromPayload(payload) {
const plain = findBodyPart(payload, 'text/plain');
if (plain) return base64UrlDecode(plain);
const html = findBodyPart(payload, 'text/html');
if (html) return stripHtml(base64UrlDecode(html));
return '';
}

// Depth-first walk collecting every part that's a real attachment (inline
// or not -- a boarding-pass QR is often inline, a "Manage booking" PDF
// usually isn't, and this doesn't need to tell the two apart). `size` comes
// free with the metadata (no attachment fetch needed to know it), which is
// what lets js/features/mail.js's ticket-attachment heuristic filter before
// ever spending a byte on a tiny tracking-pixel image.
function findAttachmentParts(payload) {
if (!payload) return [];
const found = [];
if (payload.body?.attachmentId) {
found.push({ attachmentId: payload.body.attachmentId, filename: payload.filename || '', mimeType: payload.mimeType || '', size: payload.body.size || 0 });
}
(payload.parts || []).forEach((part) => found.push(...findAttachmentParts(part)));
return found;
}

// The one rich per-message fetch every mail.js extraction flow (task, trip
// leg, date event) needs -- body text (for the AI fallback each already
// reads), the .ics calendar invite's text when one is attached (date-
// event's own ICS-first waterfall), and every attachment's metadata (so a
// caller can decide which ones look like a ticket/QR and fetch just those
// bytes via fetchMessageAttachmentBytes below). One format=full fetch
// serves all three, rather than three separate fetches of the same message.
async function getMessageDetail(id) {
const res = await googleFetch(`${GMAIL_API}/messages/${id}?format=full`);
if (!res.ok) throw new Error(`Gmail message fetch failed: ${res.status}`);
const json = await res.json();
const bodyText = bodyTextFromPayload(json.payload);
// The HTML part as sent, for the in-app reader (mailviewer.js) to show
// in a sandboxed frame. Separate from bodyText, which is deliberately
// stripped to plain text for the AI extractions -- they want words, the
// reader wants the layout the sender intended.
const htmlPart = findBodyPart(json.payload, 'text/html');
const bodyHtml = htmlPart ? base64UrlDecode(htmlPart) : '';
const headers = {};
(json.payload?.headers || []).forEach((h) => { headers[h.name.toLowerCase()] = h.value; });
const attachments = findAttachmentParts(json.payload);
const icsPart = attachments.find((a) => a.mimeType === 'text/calendar' || /\.ics$/i.test(a.filename || ''));
let icsText = null;
if (icsPart) {
try { icsText = new TextDecoder('utf-8').decode(await fetchMessageAttachmentBytes(id, icsPart.attachmentId)); }
catch (err) { /* attachment fetch failing shouldn't block the AI fallback */ }
}
return {
bodyText, bodyHtml, icsText, attachments,
from: headers.from || '', to: headers.to || '',
subject: headers.subject || '', date: headers.date || '',
};
}

// Raw bytes of one attachment, by the id findAttachmentParts/getMessageDetail
// already found -- a second Gmail call, since format=full never inlines
// attachment content itself, only its metadata.
async function fetchMessageAttachmentBytes(id, attachmentId) {
const res = await googleFetch(`${GMAIL_API}/messages/${id}/attachments/${attachmentId}`);
if (!res.ok) throw new Error(`Gmail attachment fetch failed: ${res.status}`);
const json = await res.json();
if (!json.data) throw new Error('Attachment had no data.');
return base64UrlDecodeBytes(json.data);
}

export { fetchMailSearches, buildQuery, getMessageDetail, fetchMessageAttachmentBytes, gmailLink };
