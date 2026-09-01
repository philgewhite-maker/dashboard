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
import { STAGE_RANK, setContactPicker, phoneWithFlagHtml } from './connections.js';
import { switchTab } from '../tabs.js';

// Hand connections.js the inline picker renderer. Registering it rather than
// having connections.js import this module keeps the dependency one-way.
setContactPicker(
(connId) => {
const conn = data.connections.find((c) => c.id === connId);
return (conn ? conflictsHtml(conn) : '') + candidatePickerHtml(connId);
},
(root) => bindCandidatePickers(root),
);

// Candidates awaiting confirmation, keyed by connection id. Deliberately not
// persisted: they're derived from a contacts list that may be stale by the
// next session, so they're recomputed on each sync rather than resurrected.
let pendingMatches = new Map();
let lastSyncedAt = null;
// `total` from the most recent sync's result -- the one number that
// genuinely can't change between resolves (linked/review/missing all can,
// as matches get confirmed/rejected one by one on the Dating tab).
let lastSyncTotal = null;

function isPostAppStage(c) {
return (STAGE_RANK[c.stage] ?? 0) >= CONTACT_MATCH_MIN_STAGE;
}

function eligibleConnections() {
return data.connections.filter(isPostAppStage);
}

// Returns {matched, candidates} — `matched` only when the evidence is a
// phone or email, which identify a person; a name never does on its own.
//
// A connection's phone/email is expected to be THEIRS, but a scraping bug
// can attribute something the user typed about themselves to the match
// instead (confirmed live: a phone number typed in chat to arrange a
// date got saved as the match's phone). A phone/email match is normally
// trusted as certain and applied with no confirmation, so if that field
// happens to be YOUR OWN number/email, this would otherwise silently
// link the connection to your own contact card and pull in your own
// name and address. Checked here rather than only at the scrape source,
// since this guard also protects a record that was ALREADY poisoned
// before myPhone/myEmail were ever set.
function findMatch(conn, index) {
const myPhone = phoneKey(data.myPhone);
const myEmail = emailKey(data.myEmail);
const byPhone = phoneKey(conn.phone);
if (byPhone && byPhone !== myPhone && index.byPhone.has(byPhone)) return { matched: index.byPhone.get(byPhone), how: 'phone' };
const byEmail = emailKey(conn.email);
if (byEmail && byEmail !== myEmail && index.byEmail.has(byEmail)) return { matched: index.byEmail.get(byEmail), how: 'email' };

// Fall back to names, gathering every contact that could be them. Tries
// the full name and its first word (a connection is often recorded as just
// "Anna" against a contact of "Anna Schmidt"), plus every alias and the
// dating-profile name — "Kat" only finds the contact if the record knows
// she also goes by "Katya".
const names = new Set();
[conn.name, conn.profileName, ...(conn.aliases || [])].forEach((raw) => {
const full = nameKey(raw);
if (!full) return;
names.add(full);
const first = full.split(' ')[0];
if (first) names.add(first);
});
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
applyContactDiff(conn, matched);
linked++;
return;
}
// A previously confirmed link survives a re-sync even if the name no
// longer matches — you confirmed it, and a rename shouldn't undo that.
if (conn.contactStatus === 'linked' && conn.contactResourceName) {
const still = contacts.find((c) => c.resourceName === conn.contactResourceName);
if (still) {
conn.contactEtag = still.etag;
applyContactDiff(conn, still);
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
lastSyncTotal = contacts.length;
queueSave();
return { total: contacts.length, linked, review, missing };
}

function pendingFor(connId) {
return pendingMatches.get(connId) || [];
}

// Fills gaps, records disagreements. Called on confirm and on every re-sync
// of an already-linked contact, so a value that changes in Google later
// still surfaces rather than being missed because the link already existed.
function applyContactDiff(conn, contact) {
const { filled, conflicts } = diffAgainstContact(conn, contact);
filled.forEach(({ field, value }) => {
if (field === 'aliases') {
if (!Array.isArray(conn.aliases)) conn.aliases = [];
if (!conn.aliases.some((a) => nameKey(a) === nameKey(value))) conn.aliases.push(value);
} else if (ARRAY_COMPARABLE_FIELDS.has(field)) {
if (!Array.isArray(conn[field])) conn[field] = [];
if (!conn[field].some((v) => String(v).trim().toLowerCase() === value.trim().toLowerCase())) conn[field].push(value);
} else {
conn[field] = value;
}
});
conn.contactConflicts = conflicts;
return { filled, conflicts };
}

// Fields worth comparing between a connection and its matched contact.
const COMPARABLE = [
{ field: 'phone', label: 'Phone', from: (c) => c.phones[0] || '' },
{ field: 'email', label: 'Email', from: (c) => c.emails[0] || '' },
{ field: 'location', label: 'City', from: (c) => c.city || '' },
// Kept alongside the city, not instead of it: the city is what groups in
// Overview, the full address is detail worth having on the record.
{ field: 'address', label: 'Address', from: (c) => c.address || '' },
{ field: 'job', label: 'Job', from: (c) => c.job || '' },
];

// `location` is a TAG_FIELDS multi-value array on the connection (you can
// record more than one city), but Google Contacts only ever has one. Treated
// the same way as `aliases` below: Google's city is new information to ADD
// if it's not already one of the connection's cities, never a value to
// overwrite the field with (that would turn the array into a bare string —
// the exact bug that used to crash the whole Connections render) and never
// something to flag as a "conflict" (having *more* cities than Google knows
// about isn't a disagreement).
const ARRAY_COMPARABLE_FIELDS = new Set(['location']);

// Contact group labels that name a dating app. A contact filed under
// "tinder" while the connection says Bumble is exactly the kind of thing
// worth surfacing — it usually means the app was recorded wrong, or you met
// them twice.
function appFromGroups(groups) {
const known = ['bumble', 'tinder', 'hinge', 'whatsapp', 'telegram', 'instagram'];
const hit = (groups || []).map((g) => String(g).trim().toLowerCase()).find((g) => known.includes(g));
return hit ? hit.charAt(0).toUpperCase() + hit.slice(1) : '';
}

// Splits the difference between a connection and its contact into things
// that FILL a gap and things that DISAGREE. Gaps get filled silently — the
// contact is new information. Disagreements never get applied automatically;
// they're recorded for you to resolve, because overwriting what you typed
// with what Google happens to hold is exactly the wrong default.
function diffAgainstContact(conn, contact) {
const filled = [];
const conflicts = [];
COMPARABLE.forEach(({ field, label, from }) => {
const theirs = String(from(contact) || '').trim();
if (!theirs) return;
if (ARRAY_COMPARABLE_FIELDS.has(field)) {
const mine = Array.isArray(conn[field]) ? conn[field] : [];
const already = mine.some((v) => String(v).trim().toLowerCase() === theirs.toLowerCase());
if (!already) filled.push({ field, label, value: theirs });
return;
}
const mine = String(conn[field] || '').trim();
if (!mine) { filled.push({ field, label, value: theirs }); return; }
// Phones only "disagree" if they're genuinely different numbers, not
// merely written differently.
const same = field === 'phone'
? phoneKey(mine) === phoneKey(theirs)
: mine.toLowerCase() === theirs.toLowerCase();
if (!same) conflicts.push({ field, label, mine, theirs, source: 'contact' });
});

const groupApp = appFromGroups(contact.groups);
if (groupApp && conn.app && groupApp.toLowerCase() !== String(conn.app).toLowerCase()) {
conflicts.push({ field: 'app', label: 'Source', mine: conn.app, theirs: groupApp, source: 'contact label' });
}

// A name you don't already know them by is worth keeping as an alias
// rather than a conflict — people genuinely go by several.
const theirName = String(contact.displayName || contact.givenName || '').trim();
const known = [conn.name, conn.profileName, ...(conn.aliases || [])].map((n) => nameKey(n)).filter(Boolean);
if (theirName && !known.includes(nameKey(theirName))) {
filled.push({ field: 'aliases', label: 'Also known as', value: theirName });
}
return { filled, conflicts };
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
applyContactDiff(conn, candidate);
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

// Returns HTML, not text, because the phone's country code is rendered as
// its own tag — everything else is escaped individually.
function candidateSummaryHtml(c) {
const parts = [escapeHtml(c.displayName || c.givenName)];
if (c.phones[0]) parts.push(phoneWithFlagHtml(c.phones[0]));
if (c.emails[0]) parts.push(escapeHtml(c.emails[0]));
if (c.job) parts.push(escapeHtml(c.job));
return parts.filter(Boolean).join(' · ');
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
<span class="contact-candidate-summary">${candidateSummaryHtml(contact)}</span>
<span class="contact-candidate-why">${escapeHtml(why)}${contact.sourceType === 'OTHER_CONTACT' ? ' · auto-collected, not saved' : ''}${contact.groups.length ? ' · ' + escapeHtml(contact.groups.join(', ')) : ''}${contact.updateTime ? ' · updated ' + escapeHtml(String(contact.updateTime).slice(0, 10)) : ''}</span>
</span>
<button class="sync-btn" type="button" data-confirm-match="${escapeHtml(connId)}" data-resource="${escapeHtml(contact.resourceName)}">That's them</button>
</div>`).join('')}
<button class="file-btn" type="button" data-reject-match="${escapeHtml(connId)}">None of these</button>
</div>`;
}

// Disagreements between a connection and its linked contact, each resolvable
// either way. Shown on the card because that's where you can see the rest of
// the record and judge which side is right.
// Phone conflicts get the country-code tag too — "+44 vs +41" is usually
// the entire point of the disagreement, and quote marks around a raw string
// bury it.
function conflictValueHtml(field, value) {
return field === 'phone' ? phoneWithFlagHtml(value) : `“${escapeHtml(value)}”`;
}

function conflictsHtml(conn) {
if (!conn.contactConflicts || conn.contactConflicts.length === 0) return '';
return `<div class="conflict-box">
<div class="conflict-head">Differs from Google Contacts</div>
${conn.contactConflicts.map((k, i) => `<div class="conflict-row">
<span class="conflict-field">${escapeHtml(k.label)}</span>
<span class="conflict-values">
<button class="conflict-opt" type="button" data-keep-mine="${escapeHtml(conn.id)}" data-conflict-idx="${i}">Keep ${conflictValueHtml(k.field, k.mine)}</button>
<button class="conflict-opt theirs" type="button" data-take-theirs="${escapeHtml(conn.id)}" data-conflict-idx="${i}">Use ${conflictValueHtml(k.field, k.theirs)}${k.source === 'contact label' ? ' (their label)' : ''}</button>
</span>
</div>`).join('')}
</div>`;
}

function resolveConflict(connId, idx, takeTheirs) {
const conn = data.connections.find((c) => c.id === connId);
if (!conn) return;
const conflict = conn.contactConflicts[idx];
if (!conflict) return;
if (takeTheirs) conn[conflict.field] = conflict.theirs;
conn.contactConflicts.splice(idx, 1);
queueSave();
refreshConnections();
}

// Wires the inline pickers after connections.js has drawn the cards.
function bindCandidatePickers(root) {
root.querySelectorAll('[data-confirm-match]').forEach((btn) => {
btn.addEventListener('click', () => confirmMatch(btn.dataset.confirmMatch, btn.dataset.resource));
});
root.querySelectorAll('[data-reject-match]').forEach((btn) => {
btn.addEventListener('click', () => rejectMatch(btn.dataset.rejectMatch));
});
root.querySelectorAll('[data-keep-mine]').forEach((btn) => {
btn.addEventListener('click', () => resolveConflict(btn.dataset.keepMine, parseInt(btn.dataset.conflictIdx, 10), false));
});
root.querySelectorAll('[data-take-theirs]').forEach((btn) => {
btn.addEventListener('click', () => resolveConflict(btn.dataset.takeTheirs, parseInt(btn.dataset.conflictIdx, 10), true));
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
// The "Checked N contacts…" status line used to be written once, at the
// moment a sync completed, and never touched again -- so confirming or
// rejecting even one match afterward (each of which already calls this
// function) left it silently lying about how many were still "to
// review", while THIS panel's own count updated correctly right below it.
// Confirmed live as the actual source of the contradiction: "11 to
// review" frozen in the status line, "10 to review" (then fewer, as more
// got resolved) in the panel. Regenerated from the same live counts every
// time, so the two can never disagree again.
const statusEl = document.getElementById('contacts-sync-status');
if (statusEl && lastSyncTotal !== null) {
statusEl.textContent = `Checked ${lastSyncTotal} contacts: ${counts.linked} linked, ${counts.review} to review, ${counts.missing} not found.`;
}

// The panel is now just the action and a summary — the actual reviewing
// happens on each connection's own card, next to their photo and details.
if (pendingMatches.size === 0) {
el.innerHTML = lastSyncedAt
? '<div class="empty">Nothing waiting on you.</div>'
: '<div class="empty">Match your post-app connections against Google Contacts. Only people at “Moved to WhatsApp” and beyond are checked.</div>';
return;
}
// "Below" was wrong -- confirmed live -- this panel lives on the Dating
// admin tab, but the actual review cards render on each connection's own
// card in the Connections list, which is the separate Dating tab.
// filterBySearch() alone only scrolls to #connections-panel, which does
// nothing visible if that tab isn't already the active one; switchTab()
// first is what actually gets you there.
el.innerHTML = `<div class="empty">${pendingMatches.size} to review — each one is on its own card, on the Dating tab.
<button class="filter-clear" type="button" id="show-review-only">Show just those</button></div>`;
const btn = document.getElementById('show-review-only');
if (btn) {
btn.addEventListener('click', async () => {
const conns = await import('./connections.js');
switchTab('dating');
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
// renderContactReview() writes the "Checked…" summary itself now (from
// the same live counts its own panel uses), so this doesn't set it
// directly -- a second, separate write here is exactly how the two went
// out of sync before.
await syncContacts((msg) => { status.textContent = msg; });
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
