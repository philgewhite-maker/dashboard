// Reads Google Contacts through the People API, using the same shared
// sign-in as Drive, Calendar and Gmail. Read-only unless you turn on the
// write scope in Settings — see googleauth.js for why that's separate.
import { googleFetch } from './sync/googleauth.js';

const PEOPLE_API = 'https://people.googleapis.com/v1';
// Only the fields that can actually join onto a connection. Asking for less
// keeps the response small and means the app never holds address-book data
// it has no use for.
const PERSON_FIELDS = 'names,nicknames,emailAddresses,phoneNumbers,birthdays,addresses,organizations,photos,biographies,metadata,memberships';

// Phone numbers are written a dozen ways for the same person (+44 7…, 07…,
// spaces, brackets). Comparing the last 9 digits matches across national and
// international formats without the weight of a full parsing library, and is
// long enough that collisions between real numbers are vanishingly unlikely.
function phoneKey(value) {
const digits = String(value || '').replace(/\D/g, '');
return digits.length >= 9 ? digits.slice(-9) : '';
}

function emailKey(value) {
return String(value || '').trim().toLowerCase();
}

// Folds accents, so "Zoë" and "Zoe" or "Chloé" and "Chloe" are the same key.
// Whoever typed the name into the phone and whoever typed it into Google
// rarely agree on the diacritics, and treating them as different names makes
// a confident exact match look like no match at all.
// Google gives addresses in parts, so a city is usually just there. Region
// (county/state) then country are the fallbacks — still groupable, unlike a
// street address. A formattedValue with no structure at all yields nothing
// rather than a guess, because slicing a free-text address on commas gets
// "Flat 2" as often as it gets a city.
function addressCity(address) {
if (!address) return '';
return String(address.city || address.region || address.country || '').trim();
}

// Approximate Cyrillic → Latin, so a contact saved as "Катя" is reachable
// from a connection recorded as "Katya". Deliberately rough: this is common
// usage romanisation, not BGN/PCGN or ISO 9. The schemes disagree with each
// other anyway (ю as yu/iu/ju), and the goal is only to get close enough to
// be offered as something to confirm — not to be standards-correct.
const CYRILLIC_MAP = {
а: 'a', б: 'b', в: 'v', г: 'g', ґ: 'g', д: 'd', е: 'e', ё: 'e', є: 'ie',
ж: 'zh', з: 'z', и: 'i', і: 'i', ї: 'i', й: 'i', к: 'k', л: 'l', м: 'm',
н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh',
ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e',
ю: 'yu', я: 'ya',
};

function transliterate(value) {
let out = '';
for (const ch of value) {
out += Object.prototype.hasOwnProperty.call(CYRILLIC_MAP, ch) ? CYRILLIC_MAP[ch] : ch;
}
return out;
}

// The comparison key for every name. Folds accents ("Zoë" = "Zoe") and
// romanises Cyrillic ("Катя" = "katya"), because whoever typed a name into a
// phone and whoever typed it into Google rarely agree on script or
// diacritics — and treating those as different names turns a confident match
// into an apparent miss. Display always uses the original.
function nameKey(value) {
return transliterate(String(value || '').trim().toLowerCase())
.normalize('NFD').replace(/[̀-ͯ]/g, '')
.replace(/\s+/g, ' ')
.trim();
}

// Flattens a People API person into just what the matcher and the UI need.
//
// On the metadata: the API exposes no contact CREATION date — only
// `updateTime` per source, which is last-modified. Two other bits of
// metadata turn out to be more useful for telling candidates apart:
// `type` distinguishes a contact you actually saved (CONTACT) from one
// Google auto-collected from your email (OTHER_CONTACT), and memberships
// give the labels you've filed them under.
function simplifyPerson(person, groupNames) {
const name = (person.names || [])[0] || {};
const birthday = (person.birthdays || []).map((b) => b.date).find(Boolean);
const org = (person.organizations || [])[0] || {};
const sources = (person.metadata || {}).sources || [];
const primary = sources.find((s) => s.type === 'CONTACT') || sources[0] || {};
const groups = (person.memberships || [])
.map((m) => (m.contactGroupMembership || {}).contactGroupResourceName)
.filter(Boolean)
.map((rn) => groupNames.get(rn) || '')
// The "myContacts" system group is on essentially everyone, so showing it
// would be noise rather than a distinguishing detail.
.filter((n) => n && n.toLowerCase() !== 'mycontacts');
return {
resourceName: person.resourceName,
etag: person.etag,
sourceType: primary.type || '',
updateTime: primary.updateTime || '',
groups,
displayName: name.displayName || '',
givenName: name.givenName || '',
nicknames: (person.nicknames || []).map((n) => n.value).filter(Boolean),
emails: (person.emailAddresses || []).map((e) => e.value).filter(Boolean),
phones: (person.phoneNumbers || []).map((p) => p.value).filter(Boolean),
// {year, month, day} — year is often absent, which is fine; a birthday
// without a year still tells you the date.
birthday: birthday || null,
// Addresses come back structured, so take the city rather than the whole
// formatted string — "London" is a useful grouping, "15 Cholmeley Park
// London N6 5ET" is a group of one. The full text is kept separately for
// display, where the detail does help you identify someone.
city: addressCity((person.addresses || [])[0]),
address: ((person.addresses || [])[0] || {}).formattedValue || '',
job: [org.title, org.name].filter(Boolean).join(', '),
photoUrl: ((person.photos || []).find((p) => !p.default) || {}).url || '',
notes: ((person.biographies || [])[0] || {}).value || '',
};
}

// Contact group labels come back as resource names, so fetch the directory
// once to turn them into readable names. Failure here is non-fatal — labels
// are extra context on a candidate, not something matching depends on.
async function fetchGroupNames() {
const names = new Map();
try {
const res = await googleFetch(`${PEOPLE_API}/contactGroups?pageSize=200`);
if (!res.ok) return names;
const json = await res.json();
(json.contactGroups || []).forEach((g) => {
names.set(g.resourceName, g.formattedName || g.name || '');
});
} catch (err) {
console.warn('Could not read contact group names:', err);
}
return names;
}

// Walks every page — an address book of a few thousand comes back in chunks
// of 1000, and a partial list would produce false "Missing in contacts".
async function listContacts(onProgress) {
const groupNames = await fetchGroupNames();
const people = [];
let pageToken = '';
do {
const params = new URLSearchParams({ personFields: PERSON_FIELDS, pageSize: '1000' });
if (pageToken) params.set('pageToken', pageToken);
const res = await googleFetch(`${PEOPLE_API}/people/me/connections?${params}`);
if (!res.ok) {
const detail = await res.text().catch(() => '');
throw new Error(`Contacts list failed: ${res.status}${res.status === 403 ? ' — enable the People API and add the contacts scope, then sign out and in again' : ''}${detail ? ` (${detail.slice(0, 120)})` : ''}`);
}
const json = await res.json();
(json.connections || []).forEach((p) => people.push(simplifyPerson(p, groupNames)));
pageToken = json.nextPageToken || '';
if (onProgress) onProgress(people.length);
} while (pageToken);
return people;
}

// Builds lookup indexes once, rather than scanning every contact for every
// connection — with a few hundred of each the difference is real.
function indexContacts(contacts) {
const byPhone = new Map();
const byEmail = new Map();
const byName = new Map();
contacts.forEach((c) => {
c.phones.forEach((p) => { const k = phoneKey(p); if (k) byPhone.set(k, c); });
c.emails.forEach((e) => { const k = emailKey(e); if (k) byEmail.set(k, c); });
[c.displayName, c.givenName, ...c.nicknames].forEach((n) => {
const k = nameKey(n);
if (!k) return;
if (!byName.has(k)) byName.set(k, []);
if (!byName.get(k).includes(c)) byName.get(k).push(c);
});
});
return { byPhone, byEmail, byName };
}

// Writes a birthday onto an existing contact. Requires the write scope.
//
// Two sharp edges the People API has here, both handled: updatePersonFields
// names what to overwrite, and a field named but not supplied is CLEARED —
// so only 'birthdays' is ever named. And the etag is a concurrency check: if
// the contact changed elsewhere since it was read, Google rejects the write
// rather than silently overwriting someone else's edit.
async function updateContactBirthday(resourceName, etag, { year, month, day }) {
const body = {
etag,
birthdays: [{ date: { ...(year ? { year } : {}), month, day } }],
};
const params = new URLSearchParams({ updatePersonFields: 'birthdays', personFields: 'birthdays' });
const res = await googleFetch(`${PEOPLE_API}/${resourceName}:updateContact?${params}`, {
method: 'PATCH',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify(body),
});
if (!res.ok) {
const detail = await res.text().catch(() => '');
if (res.status === 400 && detail.includes('etag')) {
throw new Error('That contact changed in Google since it was last read — re-sync contacts and try again.');
}
throw new Error(`Contact update failed: ${res.status}${detail ? ` (${detail.slice(0, 140)})` : ''}`);
}
const json = await res.json();
return json.etag;
}

// Levenshtein distance, capped — anything past `max` is "too different" and
// there's no point computing exactly how different.
function editDistance(a, b, max) {
if (Math.abs(a.length - b.length) > max) return max + 1;
let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
for (let i = 1; i <= a.length; i++) {
const row = [i];
let best = i;
for (let j = 1; j <= b.length; j++) {
row[j] = Math.min(
prev[j] + 1,
row[j - 1] + 1,
prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
);
best = Math.min(best, row[j]);
}
if (best > max) return max + 1;
prev = row;
}
return prev[b.length];
}

// The looser second pass, used only on connections the strict pass found
// nothing for. Catches shortenings and diminutives in either direction
// ("Katya" ↔ "Kat"), and small misspellings.
//
// Kept deliberately separate from the strict pass: these are guesses, and
// they must never auto-link — they exist to give you something to confirm
// instead of a bare "not found".
function widerNameCandidates(connName, contacts) {
const target = nameKey(connName);
if (target.length < 3) return [];
const first = target.split(' ')[0];
const scored = [];

contacts.forEach((c) => {
const names = [c.displayName, c.givenName, ...c.nicknames].map(nameKey).filter(Boolean);
let best = null;
names.forEach((n) => {
const nFirst = n.split(' ')[0];
let score = null;
let why = '';
// One name starting with the other, on the first word: Kat/Katya.
if (nFirst.length >= 3 && first.length >= 3) {
if (nFirst.startsWith(first) || first.startsWith(nFirst)) {
score = 100 - Math.abs(nFirst.length - first.length);
why = 'shortened name';
}
}
if (score === null && n.includes(first) && first.length >= 4) {
score = 70;
why = 'name contains';
}
if (score === null && first.length >= 4) {
const d = editDistance(first, nFirst, 2);
if (d <= 2) { score = 60 - d * 10; why = `${d} letter${d === 1 ? '' : 's'} different`; }
}
if (score !== null && (!best || score > best.score)) best = { score, why };
});
if (best) scored.push({ contact: c, ...best });
});

// A contact you actually saved beats one Google auto-collected from mail,
// and among equals the most recently touched is the better guess.
return scored.sort((a, b) => (b.score - a.score)
|| ((b.contact.sourceType === 'CONTACT') - (a.contact.sourceType === 'CONTACT'))
|| String(b.contact.updateTime).localeCompare(String(a.contact.updateTime)))
.slice(0, 5);
}

export {
listContacts, indexContacts, updateContactBirthday,
phoneKey, emailKey, nameKey, widerNameCandidates, editDistance,
};
