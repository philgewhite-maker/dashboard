// Which parts of the synced document move to per-record storage
// (server/records.php), and how each one is cut into rows. Pure: no state
// import, so it can be reused by the sync code, the check panel and tests.
//
// Kinds:
//   records   - array of objects with an `id`: one row per record
//   dated     - array keyed by a date field, no id: one row per date
//   singleton - the whole value as one row (small lists, caches of a scan)
//   prefs     - data.prefs, one row per pref key, so two devices editing
//               different prefs never collide
//
// Scope for now: the five tabs that matter most -- Tasks, Health, Travel,
// Planner, Finances. Everything else stays in the whole document.

const COLLECTIONS = [
// Tasks
{ key: 'tasks', kind: 'records', tab: 'tasks', label: 'Tasks' },
{ key: 'taskContexts', kind: 'singleton', tab: 'tasks', label: 'Task contexts' },
{ key: 'captureInbox', kind: 'records', tab: 'tasks', label: 'Capture inbox' },
{ key: 'captureDrafts', kind: 'records', tab: 'tasks', label: 'Capture drafts' },
// Health
{ key: 'healthDaily', kind: 'dated', dateField: 'date', tab: 'health', label: 'Health days' },
{ key: 'renphoDaily', kind: 'dated', dateField: 'date', tab: 'health', label: 'Renpho days' },
{ key: 'wellnessDaily', kind: 'dated', dateField: 'date', tab: 'health', label: 'Wellness days' },
// Travel
{ key: 'trips', kind: 'records', tab: 'travel', label: 'Trips' },
{ key: 'packingModules', kind: 'records', tab: 'travel', label: 'Packing modules' },
{ key: 'leaveYears', kind: 'records', tab: 'travel', label: 'Leave years' },
{ key: 'catSittingVisits', kind: 'records', tab: 'travel', label: 'Cat-sitting visits' },
// Planner
{ key: 'plannerEntries', kind: 'records', tab: 'planner', label: 'Planner entries' },
{ key: 'plannerActivities', kind: 'records', tab: 'planner', label: 'Planner activities' },
{ key: 'plannerExtraDays', kind: 'singleton', tab: 'planner', label: 'Planner extra days' },
// Finances
{ key: 'financeAccounts', kind: 'records', tab: 'finances', label: 'Accounts' },
{ key: 'subscriptions', kind: 'records', tab: 'finances', label: 'Subscriptions' },
{ key: 'lettingLedger', kind: 'records', tab: 'finances', label: 'Letting ledger' },
{ key: 'loans', kind: 'records', tab: 'finances', label: 'Loans' },
{ key: 'vouchers', kind: 'records', tab: 'finances', label: 'Vouchers' },
{ key: 'loyaltyPrograms', kind: 'records', tab: 'finances', label: 'Loyalty programmes' },
{ key: 'loyaltyBalances', kind: 'records', tab: 'finances', label: 'Loyalty balances' },
{ key: 'switchOffers', kind: 'singleton', tab: 'finances', label: 'Switch offers' },
{ key: 'switchOffersHistory', kind: 'singleton', tab: 'finances', label: 'Switch offer history' },
{ key: 'accountValueReviews', kind: 'singleton', tab: 'finances', label: 'Account value reviews' },
{ key: 'annualPerks', kind: 'singleton', tab: 'finances', label: 'Annual perks' },
// Shared
{ key: 'prefs', kind: 'prefs', tab: 'settings', label: 'Preferences' },
];

const ROW_ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;

// A key the server can store as an id. App ids are uid()s and dates already
// fit; anything else (an imported record with an odd id) is encoded rather
// than dropped, so no record is silently left out of the store.
function rowId(raw) {
const s = String(raw);
return ROW_ID_RE.test(s) ? s : `x.${Array.from(new TextEncoder().encode(s)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 190)}`;
}

// Every row of one collection, as Map(rowId -> value). `value` is the
// document's current value for that key.
function rowsOf(entry, value) {
const rows = new Map();
if (entry.kind === 'singleton') {
if (value !== undefined) rows.set('value', value);
return rows;
}
if (entry.kind === 'prefs') {
if (value && typeof value === 'object') Object.keys(value).forEach((k) => rows.set(rowId(k), value[k]));
return rows;
}
if (!Array.isArray(value)) return rows;
const seen = new Map();
value.forEach((item, i) => {
const raw = entry.kind === 'dated'
? (item && item[entry.dateField]) || `index-${i}`
: (item && item.id) || `index-${i}`;
let id = rowId(raw);
// Two rows with the same date or id would overwrite each other in the
// store; keep both, numbered, so a comparison shows the duplicate.
const n = seen.get(id) || 0;
seen.set(id, n + 1);
if (n) id = `${id}~${n}`;
rows.set(id, item);
});
return rows;
}

// Where each row id sits in a records/dated array, using the same id and
// de-duplication rules as rowsOf, so a row received from the store can be
// found (and replaced or removed) in the document.
function rowIndex(entry, arr) {
const out = new Map();
if (!Array.isArray(arr)) return out;
const seen = new Map();
arr.forEach((item, i) => {
const raw = entry.kind === 'dated'
? (item && item[entry.dateField]) || `index-${i}`
: (item && item.id) || `index-${i}`;
let id = rowId(raw);
const n = seen.get(id) || 0;
seen.set(id, n + 1);
if (n) id = `${id}~${n}`;
out.set(id, i);
});
return out;
}

// cyrb53: a fast 53-bit string hash. Only used to notice that a row
// changed, never for security.
function hashString(str) {
let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
for (let i = 0; i < str.length; i++) {
const ch = str.charCodeAt(i);
h1 = Math.imul(h1 ^ ch, 2654435761);
h2 = Math.imul(h2 ^ ch, 1597334677);
}
h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// Key order can differ between devices for the same content (a migration
// adds a field at the end on one, a merge rebuilds the object on another),
// so rows are hashed in a canonical form with sorted keys.
function canonical(v) {
if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
if (v && typeof v === 'object') {
return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}
return v === undefined ? 'null' : JSON.stringify(v);
}

function hashValue(v) {
return hashString(canonical(v));
}

// A short human label for a row, for the check panel.
function rowLabel(entry, id, value) {
if (entry.kind === 'dated') return id;
if (entry.kind === 'prefs') return id;
if (entry.kind === 'singleton') return entry.label;
const v = value || {};
return String(v.title || v.name || v.label || v.guestName || v.note || v.provider || v.date || id).slice(0, 60);
}

export { COLLECTIONS, rowsOf, rowIndex, rowId, hashValue, rowLabel };
