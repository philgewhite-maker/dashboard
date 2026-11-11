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
import { parseIcsReservations, isForgettableStay } from './icsparse.js';
import { parseHealthPayloads, mergeHealthDaily } from './features/healthparse.js';

// Must match js/db.js and js/state.js exactly -- this reads the same
// stores the app writes. Duplicated rather than imported because db.js is
// reachable from utils.js's DOM helpers; these constants are stable
// and a mismatch fails loudly (a missing document, not a corrupt one).
const DB_NAME = 'dashboard-db';
const DB_VERSION = 2;
const LOCAL_SETTINGS_KEY = 'local-settings';
const SYNC_DIRTY_KEY = 'sync-dirty'; // js/state.js SYNC_DIRTY_KEY

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

// sync.php and its siblings all sit next to each other and share one
// secret -- same derivation js/files.js uses for every other proxy.
function endpoints(settings) {
const url = String(settings.syncUrl || '').trim();
const secret = String(settings.syncSecret || '').trim();
if (!url || !secret) return null;
return {
secret,
// Empty when the document isn't encrypted, which is also what a device
// that has lost its key looks like -- runBackgroundRefresh tells the
// two apart by whether what came back is an envelope.
key: String(settings.syncKey || '').trim(),
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
const res = await fetch(`${ep.health}?limit=500`, {
headers: { 'X-Sync-Secret': ep.secret },
});
if (!res.ok) throw new Error(`health.php returned ${res.status}`);
const json = await res.json();
const parsed = mergeHealthDaily(doc.healthDaily, parseHealthPayloads(json.entries || []), json.entries || []);
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
const feedText = await res.text();
const events = parseIcsReservations(feedText).filter((e) => e.checkout >= today);
// A truncated, non-ICS or empty feed is a failed fetch, not "every booking cancelled": change nothing for this listing.
if (!/BEGIN:VCALENDAR/.test(feedText) || !/END:VCALENDAR/.test(feedText)) continue;
if (!events.length && (doc.airbnbReservations || []).some((r) => r.listingId === listing.id && (r.source || 'ics') === 'ics' && !r.movedFrom && (r.status || 'booked') === 'booked' && r.checkout >= today)) continue;
// Same rules as the in-app sync: completed stays can't come back, a
// cancelled one can (and returns to booked), and nothing is ever deleted.
// A stay is known by its own calendar id and any others it has appeared under
// (altUids); a new id for a room and dates already on file is the same booking.
const feedStays = (doc.airbnbReservations || []).filter((r) => r.listingId === listing.id && (r.source || 'ics') === 'ics' && !r.movedFrom && r.status !== 'completed');
const existing = new Map();
feedStays.forEach((r) => { [r.uid, ...(r.altUids || [])].filter(Boolean).forEach((u) => { if (!existing.has(u)) existing.set(u, r); }); });
const seen = new Set();
events.forEach(({ uid: evUid, checkin, checkout }) => {
let found = existing.get(evUid);
if (!found) {
const twin = (doc.airbnbReservations || []).find((r) => r.listingId === listing.id && r.status !== 'cancelled' && r.checkin === checkin && r.checkout === checkout && !seen.has(r.id));
if (twin) {
if (!Array.isArray(twin.altUids)) twin.altUids = [];
if (twin.uid && twin.uid !== evUid && !twin.altUids.includes(evUid)) { twin.altUids.push(evUid); changed = true; }
else if (!twin.uid) { twin.uid = evUid; changed = true; }
found = twin;
}
}
if (found) {
if (found.status === 'cancelled') { found.status = 'booked'; found.cancelledOn = ''; changed = true; }
if (found.checkin !== checkin || found.checkout !== checkout) {
// Kept as a revision, and a recorded payout flagged for checking -- the
// same as noteDateChange in js/features/airbnb.js.
if (!Array.isArray(found.revisions)) found.revisions = [];
found.revisions.push({ at: new Date().toISOString(), oldCheckin: found.checkin, oldCheckout: found.checkout, newCheckin: checkin, newCheckout: checkout });
if (found.revisions.length > 20) found.revisions = found.revisions.slice(-20);
if (found.income != null) found.payoutCheck = true;
found.checkin = checkin; found.checkout = checkout; changed = true;
}
seen.add(found.id);
} else {
// Only the fields a feed can know. Everything else keeps whatever
// blankAirbnbReservation would have given it, filled in when the
// page next loads and migrate() runs over the document. The id comes from
// the listing and calendar id, so two devices adding the same event before
// syncing write the same record, not two.
const newId = `feed-${listing.id}-${evUid}`.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 190);
seen.add(newId);
doc.airbnbReservations.push({
id: newId,
listingId: listing.id, uid: evUid, source: 'ics', status: 'booked', cancelledOn: '',
checkin, checkout, guestName: '', notes: '',
googleEventId: '', googleCalendarId: '',
createdAt: new Date().toISOString(),
});
changed = true;
}
});
feedStays.forEach((r) => {
if (seen.has(r.id)) return;
// Out of the feed: finished if past its checkout, otherwise cancelled.
// Never deleted -- ledger rows, keys and cleaning pins point at its id.
if (r.status && r.status !== 'booked') return;
// An enquiry hold that lapsed (nothing confirmed it, nothing refers to it) is
// forgotten, not recorded as a cancelled booking (see isForgettableStay).
if (isForgettableStay(r, doc, today)) { doc.airbnbReservations = doc.airbnbReservations.filter((x) => x.id !== r.id); changed = true; return; }
if (r.checkout && r.checkout < today) r.status = 'completed';
else { r.status = 'cancelled'; r.cancelledOn = today; }
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
// This device holds edits the server hasn't seen (js/state.js sets the
// marker with every local save; js/sync/autosync.js clears it after a
// push). Leave the server alone: the page pushes them through its merge
// path when next opened, and refreshes health and ICS then anyway.
if (await kvGet(db, SYNC_DIRTY_KEY)) return { skipped: 'unsent edits on this device' };

const pull = await fetch(ep.sync, { headers: { 'X-Sync-Secret': ep.secret } });
if (!pull.ok) throw new Error(`sync.php returned ${pull.status}`);
const remote = await pull.json();
const { seal, open, isEnvelope } = await import('./cryptobox.js');
const sealed = isEnvelope(remote.data);
// No key for an encrypted document means this run does nothing at all --
// and in particular does not fall through to "no document yet" and then
// write a fresh plaintext one over the top. Background work gets the
// same refusal the foreground does, where nobody is watching to undo it.
if (sealed && !ep.key) return { skipped: 'encrypted, no key on this device' };
let doc;
try {
doc = sealed ? await open(ep.key, remote.data) : remote.data;
} catch (err) {
return { skipped: 'encrypted, key does not fit' };
}
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
// Goes back the way it came: sealed if it arrived sealed. Writing the
// plaintext back would silently undo the encryption from a code path
// that runs while the app is closed.
body: JSON.stringify({ rev: remote.rev, data: sealed ? await seal(ep.key, doc) : doc }),
});
if (!push.ok) {
// 409 is the stale-rev refusal, and is not an error worth shouting
// about: someone saved on another device while this ran, and the next
// run picks their version up.
if (push.status === 409) return { ...results, wrote: false, conflict: true };
throw new Error(`sync.php write returned ${push.status}`);
}
const written = await push.json();
// Deliberately NO local write. This used to put `doc` into app-data and
// the server rev into app-data-rev (the page's local save counter, not its
// sync rev), which overwrote unsent edits on disk and wound that counter
// backwards. The server now holds the refreshed copy; the page adopts it
// on its next open through its normal pull, which knows how to merge.
return { ...results, wrote: true, rev: written.rev };
}

export { runBackgroundRefresh };
