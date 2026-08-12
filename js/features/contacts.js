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
import { listContacts, indexContacts, updateContactBirthday, phoneKey, emailKey, nameKey, widerNameCandidates } from '../googlecontacts.js';
import { STAGE_RANK, setContactPicker } from './connections.js';

// Hand connections.js the inline picker renderer. Registering it rather than
// having connections.js import this module keeps the dependency one-way.
setContactPicker((connId) => candidatePickerHtml(connId), (root) => bindCandidatePickers(root));

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
// Exact-name candidates first, then the looser pass appended. The wider
// search runs even when an exact name DID match, because an exact match
// is not necessarily the right one: "Katya" matching a contact saved as
// "Katya PDN" shouldn't hide the "Kat" who is actually her. Offering both
// and letting you choose beats silently picking the tidier-looking one.
const suggestions = [];
const seen = new Set();
(candidates || []).forEach((c) => {
if (seen.has(c.resourceName)) return;
seen.add(c.resourceName);
suggestions.push({ contact: c, why: 'same name' });
});
widerNameCandidates(conn.name, contacts).forEach(({ contact, why }) => {
if (seen.has(contact.resourceName)) return;
seen.add(contact.resourceName);
suggestions.push({ contact, why });
});

if (suggestions.length) {
conn.contactStatus = 'review';
pendingMatches.set(conn.id, suggestions);
review++;
return;
}
conn.contactStatus = 'missing';
conn.contactResourceName = '';
conn.contactEtag = '';
missing++;
});

lastSyncedAt = new Date().toISOString();
queueSave();
return { total: contacts.length, linked, review, missing };
}

function pendingFor(connId) {
return pendingMatches.get(connId) || [];
}

function confirmMatch(connId, resourceName) {
const conn = data.connections.find((c) => c.id === connId);
const entry = pendingFor(connId).find((e) => e.contact.resourceName === resourceName);
const candidate = entry && entry.contact;
if (!conn || !candidate) return;
conn.contactStatus = 'linked';
conn.contactResourceName = candidate.resourceName;
conn.contactEtag = candidate.etag;
conn.contactMatchedBy = 'confirmed';
// Fill gaps from the contact, never overwrite — same rule as every other
// merge in this app: what you typed outranks what was imported.
if (!conn.phone && candidate.phones.length) conn.phone = candidate.phones[0];
if (!conn.email && candidate.emails.length) conn.email = candidate.emails[0];
// City, not the full address — Location is a grouping field in
// Connections Overview, and a street address makes a group of one.
if (!conn.location && candidate.city) conn.location = candidate.city;
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

// Rendered inside the connection's own card, where the photo, age and stage
// already are — deciding "is this the same person" needs that context, and a
// separate panel had none of it.
function candidatePickerHtml(connId) {
const entries = pendingFor(connId);
if (entries.length === 0) return '';
return `<div class="contact-picker">
<div class="contact-picker-head">Possible Google Contacts match</div>
${entries.map(({ contact, why }) => `<div class="contact-candidate">
<span class="contact-candidate-main">
${escapeHtml(candidateSummary(contact))}
<span class="contact-candidate-why">${escapeHtml(why)}${contact.sourceType === 'OTHER_CONTACT' ? ' · auto-collected, not saved' : ''}${contact.groups.length ? ' · ' + escapeHtml(contact.groups.join(', ')) : ''}${contact.updateTime ? ' · updated ' + escapeHtml(String(contact.updateTime).slice(0, 10)) : ''}</span>
</span>
<button class="sync-btn" type="button" data-confirm-match="${escapeHtml(connId)}" data-resource="${escapeHtml(contact.resourceName)}">That's them</button>
</div>`).join('')}
<button class="file-btn" type="button" data-reject-match="${escapeHtml(connId)}">None of these</button>
</div>`;
}

// Wires the inline pickers after connections.js has drawn the cards.
function bindCandidatePickers(root) {
root.querySelectorAll('[data-confirm-match]').forEach((btn) => {
btn.addEventListener('click', () => confirmMatch(btn.dataset.confirmMatch, btn.dataset.resource));
});
root.querySelectorAll('[data-reject-match]').forEach((btn) => {
btn.addEventListener('click', () => rejectMatch(btn.dataset.rejectMatch));
});
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

// The panel is now just the action and a summary — the actual reviewing
// happens on each connection's own card, next to their photo and details.
if (pendingMatches.size === 0) {
el.innerHTML = lastSyncedAt
? '<div class="empty">Nothing waiting on you.</div>'
: '<div class="empty">Match your post-app connections against Google Contacts. Only people at “Moved to WhatsApp” and beyond are checked.</div>';
return;
}
el.innerHTML = `<div class="empty">${pendingMatches.size} to review — each one is on its own card below.
<button class="filter-clear" type="button" id="show-review-only">Show just those</button></div>`;
const btn = document.getElementById('show-review-only');
if (btn) {
btn.addEventListener('click', async () => {
const conns = await import('./connections.js');
conns.filterBySearch(CONTACT_STATUS_LABELS.review);
});
}
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
candidatePickerHtml, bindCandidatePickers,
CONTACT_STATUS_LABELS, hasContactsWrite, updateContactBirthday,
};
