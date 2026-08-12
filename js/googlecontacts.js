// Reads Google Contacts through the People API, using the same shared
// sign-in as Drive, Calendar and Gmail. Read-only unless you turn on the
// write scope in Settings — see googleauth.js for why that's separate.
import { googleFetch } from './sync/googleauth.js';

const PEOPLE_API = 'https://people.googleapis.com/v1';
// Only the fields that can actually join onto a connection. Asking for less
// keeps the response small and means the app never holds address-book data
// it has no use for.
const PERSON_FIELDS = 'names,nicknames,emailAddresses,phoneNumbers,birthdays,addresses,organizations,photos,biographies,metadata';

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

function nameKey(value) {
return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Flattens a People API person into just what the matcher and the UI need.
function simplifyPerson(person) {
const name = (person.names || [])[0] || {};
const birthday = (person.birthdays || []).map((b) => b.date).find(Boolean);
const org = (person.organizations || [])[0] || {};
return {
resourceName: person.resourceName,
etag: person.etag,
displayName: name.displayName || '',
givenName: name.givenName || '',
nicknames: (person.nicknames || []).map((n) => n.value).filter(Boolean),
emails: (person.emailAddresses || []).map((e) => e.value).filter(Boolean),
phones: (person.phoneNumbers || []).map((p) => p.value).filter(Boolean),
// {year, month, day} — year is often absent, which is fine; a birthday
// without a year still tells you the date.
birthday: birthday || null,
address: ((person.addresses || [])[0] || {}).formattedValue || '',
job: [org.title, org.name].filter(Boolean).join(', '),
photoUrl: ((person.photos || []).find((p) => !p.default) || {}).url || '',
notes: ((person.biographies || [])[0] || {}).value || '',
};
}

// Walks every page — an address book of a few thousand comes back in chunks
// of 1000, and a partial list would produce false "Missing in contacts".
async function listContacts(onProgress) {
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
(json.connections || []).forEach((p) => people.push(simplifyPerson(p)));
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

export { listContacts, indexContacts, updateContactBirthday, phoneKey, emailKey, nameKey };
