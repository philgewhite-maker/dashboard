// Joins connections to Google Contacts, but only for people who have moved
// off the dating app — see CONTACT_MATCH_MIN_STAGE for why.
//
// Nothing is linked automatically on a weak signal. A phone or email match is
// treated as certain; a name match is only ever a suggestion you confirm.
// The failure mode being avoided is a confident-looking wrong link that
// quietly attaches someone else's address book entry to a person.
import { data, queueSave, CONTACT_STATUS_LABELS, CONTACT_MATCH_MIN_STAGE } from '../state.js';
import { escapeHtml } from '../utils.js';
import { canAttemptGoogleAction, hasContactsWrite } from '../sync/googleauth.js';
import { listContacts, indexContacts, updateContactBirthday, phoneKey, emailKey, nameKey } from '../googlecontacts.js';
import { STAGE_RANK } from './connections.js';

// Candidates awaiting confirmation, keyed by connection id. Deliberately not
// persisted: they're derived from a contacts list that may be stale by the
// next session, so they're recomputed on each sync rather than resurrected.
let pendingMatches = new Map();
let lastSyncedAt = null;

function isPostAppStage(c) {
return (STAGE_RANK[c.stage] ?? 0) >= CONTACT_MATCH_MIN_STAGE;
}

function eligibleConnections() {
return data.connections.filter(isPostAppStage);
}

// Returns {matched, candidates} — `matched` only when the evidence is a
// phone or email, which identify a person; a name never does on its own.
function findMatch(conn, index) {
const byPhone = phoneKey(conn.phone);
if (byPhone && index.byPhone.has(byPhone)) return { matched: index.byPhone.get(byPhone), how: 'phone' };
const byEmail = emailKey(conn.email);
if (byEmail && index.byEmail.has(byEmail)) return { matched: index.byEmail.get(byEmail), how: 'email' };

// Fall back to the name, gathering every contact that could be them. Both
// the full name and the first word are tried, since a connection is often
// recorded as just "Anna" against a contact of "Anna Schmidt".
const names = new Set();
const full = nameKey(conn.name);
if (full) {
names.add(full);
const first = full.split(' ')[0];
if (first) names.add(first);
}
const candidates = [];
names.forEach((n) => {
(index.byName.get(n) || []).forEach((c) => { if (!candidates.includes(c)) candidates.push(c); });
});
return { matched: null, candidates };
}

async function syncContacts(onStatus) {
const contacts = await listContacts((n) => onStatus(`Reading contacts… ${n}`));
return classifyAgainst(contacts);
}

// Split out from the fetch so the matching rules can be exercised directly
// against a known contact list — this is the part where a wrong answer
// silently attaches the wrong person, so it's worth being able to test.
function classifyAgainst(contacts) {
const index = indexContacts(contacts);
pendingMatches = new Map();

let linked = 0;
let review = 0;
let missing = 0;

eligibleConnections().forEach((conn) => {
const { matched, how, candidates } = findMatch(conn, index);
if (matched) {
conn.contactStatus = 'linked';
conn.contactResourceName = matched.resourceName;
conn.contactEtag = matched.etag;
conn.contactMatchedBy = how;
linked++;
return;
}
// A previously confirmed link survives a re-sync even if the name no
// longer matches — you confirmed it, and a rename shouldn't undo that.
if (conn.contactStatus === 'linked' && conn.contactResourceName) {
const still = contacts.find((c) => c.resourceName === conn.contactResourceName);
if (still) {
conn.contactEtag = still.etag;
linked++;
return;
}
}
if (candidates && candidates.length) {
conn.contactStatus = 'review';
pendingMatches.set(conn.id, candidates);
review++;
} else {
conn.contactStatus = 'missing';
conn.contactResourceName = '';
conn.contactEtag = '';
missing++;
}
});

lastSyncedAt = new Date().toISOString();
queueSave();
return { total: contacts.length, linked, review, missing };
}

function confirmMatch(connId, resourceName) {
const conn = data.connections.find((c) => c.id === connId);
const candidate = (pendingMatches.get(connId) || []).find((c) => c.resourceName === resourceName);
if (!conn || !candidate) return;
conn.contactStatus = 'linked';
conn.contactResourceName = candidate.resourceName;
conn.contactEtag = candidate.etag;
conn.contactMatchedBy = 'confirmed';
// Fill gaps from the contact, never overwrite — same rule as every other
// merge in this app: what you typed outranks what was imported.
if (!conn.phone && candidate.phones.length) conn.phone = candidate.phones[0];
if (!conn.email && candidate.emails.length) conn.email = candidate.emails[0];
if (!conn.location && candidate.address) conn.location = candidate.address;
if (!conn.job && candidate.job) conn.job = candidate.job;
pendingMatches.delete(connId);
queueSave();
renderContactReview();
refreshConnections();
}

function rejectMatch(connId) {
const conn = data.connections.find((c) => c.id === connId);
if (!conn) return;
conn.contactStatus = 'missing';
conn.contactResourceName = '';
conn.contactEtag = '';
pendingMatches.delete(connId);
queueSave();
renderContactReview();
refreshConnections();
}

function refreshConnections() {
Promise.all([import('./connections.js'), import('./overview.js')])
.then(([conns, overview]) => { conns.renderConnections(); overview.renderOverview(); });
}

function candidateSummary(c) {
return [c.displayName || c.givenName, c.phones[0], c.emails[0], c.job]
.filter(Boolean).join(' · ');
}

function renderContactReview() {
const el = document.getElementById('contact-review');
if (!el) return;
const counts = { linked: 0, review: 0, missing: 0 };
eligibleConnections().forEach((c) => { if (counts[c.contactStatus] !== undefined) counts[c.contactStatus]++; });
const countEl = document.getElementById('contacts-count');
if (countEl) {
countEl.textContent = lastSyncedAt
? `${counts.linked} linked · ${counts.review} to review · ${counts.missing} missing`
: `${eligibleConnections().length} eligible`;
}

if (pendingMatches.size === 0) {
el.innerHTML = lastSyncedAt
? '<div class="empty">Nothing waiting on you.</div>'
: '<div class="empty">Sync to match your post-app connections against Google Contacts. Only people at “Moved to WhatsApp” and beyond are checked.</div>';
return;
}

el.innerHTML = [...pendingMatches.entries()].map(([connId, candidates]) => {
const conn = data.connections.find((c) => c.id === connId);
if (!conn) return '';
return `<div class="contact-review-row">
<div class="contact-review-head">
<strong>${escapeHtml(conn.name)}</strong>
<span class="contact-review-meta">${escapeHtml([conn.age, conn.stage, conn.app].filter(Boolean).join(' · '))}</span>
</div>
<div class="contact-candidates">
${candidates.map((c) => `<div class="contact-candidate">
<span>${escapeHtml(candidateSummary(c))}</span>
<button class="sync-btn" type="button" data-confirm-match="${escapeHtml(connId)}" data-resource="${escapeHtml(c.resourceName)}">That's them</button>
</div>`).join('')}
<button class="file-btn" type="button" data-reject-match="${escapeHtml(connId)}">None of these</button>
</div>
</div>`;
}).join('');

el.querySelectorAll('[data-confirm-match]').forEach((btn) => {
btn.addEventListener('click', () => confirmMatch(btn.dataset.confirmMatch, btn.dataset.resource));
});
el.querySelectorAll('[data-reject-match]').forEach((btn) => {
btn.addEventListener('click', () => rejectMatch(btn.dataset.rejectMatch));
});
}

function initContacts() {
const btn = document.getElementById('sync-contacts-btn');
if (!btn) return;
const status = document.getElementById('contacts-sync-status');

btn.addEventListener('click', async () => {
if (!(await canAttemptGoogleAction())) {
status.textContent = 'Sign in to Google at the top of the page first.';
return;
}
const eligible = eligibleConnections().length;
if (eligible === 0) {
status.textContent = 'Nobody is past “Moved to WhatsApp” yet, so there is nothing to match.';
return;
}
btn.disabled = true;
try {
const result = await syncContacts((msg) => { status.textContent = msg; });
status.textContent = `Checked ${result.total} contacts: ${result.linked} linked, ${result.review} to review, ${result.missing} not found.`;
renderContactReview();
refreshConnections();
} catch (err) {
status.textContent = err.message || String(err);
console.error('Contacts sync failed:', err);
} finally {
btn.disabled = false;
}
});

renderContactReview();
}

export {
initContacts, renderContactReview, syncContacts, classifyAgainst, isPostAppStage,
CONTACT_STATUS_LABELS, hasContactsWrite, updateContactBirthday,
};
