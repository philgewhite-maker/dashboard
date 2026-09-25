// What refreshes while the app is closed.
//
// This runs inside the service worker (see sw.js's periodicsync handler),
// where there is no page, no DOM, and none of the app's state module is
// loaded. So it deliberately does NOT import state.js, selfhost.js or any
// feature file -- it opens IndexedDB itself and talks to sync.php itself,
// and imports only js/icsparse.js and js/features/healthparse.js, both of
// which import nothing at all.
//
// WHAT CAN AND CANNOT RUN HERE, and why it isn't a matter of effort:
// every Google-backed sync (Calendar, Mail, Contacts, Google Tasks, the
// Airbnb external-booking scan, pushing a booking to Calendar) authorises
// through js/sync/googleauth.js's initTokenClient, which issues a ~1 hour
// access token held in memory with NO refresh token. Nothing can renew
// that without a visible, signed-in page. Those syncs therefore only ever
// run when you open the app -- see js/features/scheduled.js, which is the
// other half of this feature.
//
// What's left is the two that need no Google identity, which happen to be
// the two worth having: the health log (already POSTed to your own server
// by the phone's Health Connect bridge, so this only re-parses it) and the
// Airbnb ICS feeds (fetched through your own ics-proxy.php).
import { parseIcsReservations } from './icsparse.js';
import { parseHealthPayloads } from './features/healthparse.js';

// Must match js/db.js and js/state.js exactly -- this reads the same
// stores the app writes. Duplicated rather than imported because db.js is
// reachable from utils.js's DOM helpers; these four constants are stable
// and a mismatch fails loudly (a missing document, not a corrupt one).
const DB_NAME = 'dashboard-db';
const DB_VERSION = 2;
const DATA_KEY = 'app-data';
const REV_KEY = 'app-data-rev';
const LOCAL_SETTINGS_KEY = 'local-settings';

function openDb() {
return new Promise((resolve, reject) => {
const req = indexedDB.open(DB_NAME, DB_VERSION);
req.onsuccess = () => resolve(req.result);
req.onerror = () => reject(req.error);
// No onupgradeneeded: the app owns the schema. If this fires at all,
// the worker has arrived before the page ever has, and there is no
// document to refresh yet anyway.
});
}

function kvGet(db, key) {
return new Promise((resolve, reject) => {
const req = db.transaction('kv', 'readonly').objectStore('kv').get(key);
req.onsuccess = () => resolve(req.result);
req.onerror = () => reject(req.error);
});
}

function kvSet(db, key, value) {
return new Promise((resolve, reject) => {
const tx = db.transaction('kv', 'readwrite');
tx.objectStore('kv').put(value, key);
tx.oncomplete = () => resolve();
tx.onerror = () => reject(tx.error);
});
}

// sync.php and its siblings all sit next to each other and share one
// secret -- same derivation js/files.js uses for every other proxy.
function endpoints(settings) {
const url = String(settings.syncUrl || '').trim();
const secret = String(settings.syncSecret || '').trim();
if (!url || !secret) return null;
return {
secret,
sync: url,
health: url.replace(/sync\.php(?=$|\?)/, 'health.php'),
icsProxy: url.replace(/sync\.php(?=$|\?)/, 'ics-proxy.php'),
};
}

// ---- The two refreshes ----------------------------------------------------

// The phone's Health Connect bridge has already POSTed today's readings to
// health.php on its own schedule -- nothing here reaches the phone. This
// only re-derives data.healthDaily from the log, which is exactly what the
// Refresh button does, and is why health was the easiest thing to stop
// having to remember.
async function refreshHealth(doc, ep) {
const res = await fetch(`${ep.health}?limit=500&secret=${encodeURIComponent(ep.secret)}`, {
headers: { 'X-Sync-Secret': ep.secret },
});
if (!res.ok) throw new Error(`health.php returned ${res.status}`);
const json = await res.json();
const parsed = parseHealthPayloads(json.entries || []);
const before = JSON.stringify(doc.healthDaily || []);
doc.healthDaily = parsed;
return { changed: JSON.stringify(parsed) !== before, days: parsed.length };
}

// The ICS half of the Airbnb sync only. The external-booking scan, the
// cleaner-event lookup and the guest-name-from-email pass all need Google
// and are skipped here by design, not by omission -- see this file's
// header. Mirrors syncAirbnbListing in js/features/airbnb.js: keyed on the
// feed's own event uid, past stays dropped, and feed-sourced reservations
// ONLY, so a manual or external booking on the same listing isn't swept.
async function refreshAirbnbFeeds(doc, ep) {
const listings = (doc.airbnbListings || []).filter((l) => l.icsUrl);
if (!listings.length) return { changed: false, listings: 0 };
const today = new Date().toISOString().slice(0, 10);
let changed = false;
for (const listing of listings) {
const res = await fetch(`${ep.icsProxy}?url=${encodeURIComponent(listing.icsUrl)}`, {
headers: { 'X-Sync-Secret': ep.secret },
});
if (!res.ok) throw new Error(`ics-proxy.php returned ${res.status} for "${listing.label || listing.id}"`);
const events = parseIcsReservations(await res.text()).filter((e) => e.checkout >= today);
const existing = new Map(
(doc.airbnbReservations || []).filter((r) => r.listingId === listing.id && (r.source || 'ics') === 'ics').map((r) => [r.uid, r])
);
events.forEach(({ uid: evUid, checkin, checkout }) => {
const found = existing.get(evUid);
if (found) {
if (found.checkin !== checkin || found.checkout !== checkout) { found.checkin = checkin; found.checkout = checkout; changed = true; }
existing.delete(evUid);
} else {
// Only the fields a feed can know. Everything else keeps whatever
// blankAirbnbReservation would have given it, filled in when the
// page next loads and migrate() runs over the document.
doc.airbnbReservations.push({
id: `bg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
listingId: listing.id, uid: evUid, source: 'ics',
checkin, checkout, guestName: '', notes: '',
googleEventId: '', googleCalendarId: '',
createdAt: new Date().toISOString(),
});
changed = true;
}
});
existing.forEach((r) => {
doc.airbnbReservations = doc.airbnbReservations.filter((x) => x.id !== r.id);
changed = true;
});
}
return { changed, listings: listings.length };
}

// ---- Document read/modify/write -------------------------------------------

// Pulls the CURRENT document from the server immediately before writing,
// rather than trusting whatever this device last stored. sync.php refuses
// a write whose rev is stale, so the worst case is a refused write and a
// retry next time -- a background job can never clobber something typed on
// another device.
async function runBackgroundRefresh() {
const db = await openDb();
const settings = (await kvGet(db, LOCAL_SETTINGS_KEY)) || {};
const ep = endpoints(settings);
if (!ep) return { skipped: 'not configured' };

const pull = await fetch(ep.sync, { headers: { 'X-Sync-Secret': ep.secret } });
if (!pull.ok) throw new Error(`sync.php returned ${pull.status}`);
const remote = await pull.json();
const doc = remote.data;
if (!doc || typeof doc !== 'object') return { skipped: 'no document yet' };
if (!Array.isArray(doc.airbnbReservations)) doc.airbnbReservations = [];

const results = {};
let changed = false;
// Each task is independent: one failing feed shouldn't cost you the
// health refresh that already succeeded.
for (const [name, fn] of [['health', refreshHealth], ['airbnb', refreshAirbnbFeeds]]) {
try {
const r = await fn(doc, ep);
results[name] = r;
if (r.changed) changed = true;
} catch (err) {
results[name] = { error: err.message || String(err) };
}
}
if (!changed) return { ...results, wrote: false };

const push = await fetch(ep.sync, {
method: 'POST',
headers: { 'Content-Type': 'application/json', 'X-Sync-Secret': ep.secret },
body: JSON.stringify({ rev: remote.rev, data: doc }),
});
if (!push.ok) {
// 409 is the stale-rev refusal, and is not an error worth shouting
// about: someone saved on another device while this ran, and the next
// run picks their version up.
if (push.status === 409) return { ...results, wrote: false, conflict: true };
throw new Error(`sync.php write returned ${push.status}`);
}
const written = await push.json();
// Keep this device's known rev in step, so the page doesn't wake up
// thinking it's behind and re-pull for no reason.
await kvSet(db, REV_KEY, written.rev);
await kvSet(db, DATA_KEY, doc);
return { ...results, wrote: true, rev: written.rev };
}

export { runBackgroundRefresh };
