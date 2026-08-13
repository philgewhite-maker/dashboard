// Thin IndexedDB wrapper. Three stores:
//  - "kv"     small keyed JSON blobs (the app's data document)
//  - "photos" binary image blobs, keyed by a generated id, referenced from
//             connection records instead of embedding base64 in the JSON.
//  - "parses" AI results keyed by a hash of the image bytes, so reviewing
//             the same album twice never pays to read the same photo twice.
// Photos live here (not in the "kv" document) so the document stays small
// and fast to read/write even once photo storage grows into the 10s of MB.
// Parses live here for the same reason, and because they're a local cache
// rather than data worth syncing.

const DB_NAME = 'dashboard-db';
const DB_VERSION = 2;

let dbPromise = null;

function openDb() {
if (dbPromise) return dbPromise;
dbPromise = new Promise((resolve, reject) => {
const req = indexedDB.open(DB_NAME, DB_VERSION);
req.onupgradeneeded = () => {
const db = req.result;
if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos');
if (!db.objectStoreNames.contains('parses')) db.createObjectStore('parses');
};
// A version bump can't proceed while another tab still holds the old
// version open. Without this the promise never settles and the whole app
// hangs at startup with no clue why — which is exactly what happened when
// this store was added with a second tab open.
req.onblocked = () => {
reject(new Error('The dashboard is open in another tab running an older version. Close the other tabs and reload.'));
};
req.onsuccess = () => {
// If a LATER version is opened elsewhere, this connection must yield or
// it blocks that tab in turn.
req.result.onversionchange = () => { try { req.result.close(); } catch (e) { /* already closing */ } };
resolve(req.result);
};
req.onerror = () => reject(req.error);
});
// A failed open must not be cached, or every later call reuses the
// rejection and the app can never recover without a reload.
dbPromise.catch(() => { dbPromise = null; });
return dbPromise;
}

async function kvGet(key) {
const db = await openDb();
return new Promise((resolve, reject) => {
const tx = db.transaction('kv', 'readonly');
const req = tx.objectStore('kv').get(key);
req.onsuccess = () => resolve(req.result);
req.onerror = () => reject(req.error);
});
}

async function kvSet(key, value) {
const db = await openDb();
return new Promise((resolve, reject) => {
const tx = db.transaction('kv', 'readwrite');
tx.objectStore('kv').put(value, key);
tx.oncomplete = () => resolve();
tx.onerror = () => reject(tx.error);
});
}

async function photoPut(id, blob) {
const db = await openDb();
return new Promise((resolve, reject) => {
const tx = db.transaction('photos', 'readwrite');
tx.objectStore('photos').put(blob, id);
tx.oncomplete = () => resolve();
tx.onerror = () => reject(tx.error);
});
}

async function photoGet(id) {
if (!id) return null;
const db = await openDb();
return new Promise((resolve, reject) => {
const tx = db.transaction('photos', 'readonly');
const req = tx.objectStore('photos').get(id);
req.onsuccess = () => resolve(req.result || null);
req.onerror = () => reject(req.error);
});
}

async function photoDelete(id) {
if (!id) return;
const db = await openDb();
return new Promise((resolve, reject) => {
const tx = db.transaction('photos', 'readwrite');
tx.objectStore('photos').delete(id);
tx.oncomplete = () => resolve();
tx.onerror = () => reject(tx.error);
});
}

// Object URLs are cached per photo id for the life of the page so repeated
// renders (every re-render of the connections list) don't re-read the blob.
const urlCache = new Map();

async function photoUrl(id) {
if (!id) return null;
if (urlCache.has(id)) return urlCache.get(id);
const blob = await photoGet(id);
if (!blob) return null;
const url = URL.createObjectURL(blob);
urlCache.set(id, url);
return url;
}

// ---- AI parse cache -------------------------------------------------
// Keyed by "<sha256 of the image bytes>:<kind>", so the same picture reached
// by any route — re-picked from an album, re-downloaded, renamed — is
// recognised as already read. Kind separates the cheap name/age scan from
// the full profile parse, since one may exist without the other.

async function parseCacheGet(hash, kind) {
const db = await openDb();
return new Promise((resolve, reject) => {
const tx = db.transaction('parses', 'readonly');
const req = tx.objectStore('parses').get(`${hash}:${kind}`);
req.onsuccess = () => resolve(req.result || null);
req.onerror = () => reject(req.error);
});
}

async function parseCachePut(hash, kind, entry) {
const db = await openDb();
return new Promise((resolve, reject) => {
const tx = db.transaction('parses', 'readwrite');
tx.objectStore('parses').put({ ...entry, hash, kind, cachedAt: new Date().toISOString() }, `${hash}:${kind}`);
tx.oncomplete = () => resolve();
tx.onerror = () => reject(tx.error);
});
}

async function parseCacheClear() {
const db = await openDb();
return new Promise((resolve, reject) => {
const tx = db.transaction('parses', 'readwrite');
tx.objectStore('parses').clear();
tx.oncomplete = () => resolve();
tx.onerror = () => reject(tx.error);
});
}

async function parseCacheCount() {
const db = await openDb();
return new Promise((resolve, reject) => {
const tx = db.transaction('parses', 'readonly');
const req = tx.objectStore('parses').count();
req.onsuccess = () => resolve(req.result);
req.onerror = () => reject(req.error);
});
}

export {
openDb, kvGet, kvSet, photoPut, photoGet, photoDelete, photoUrl,
parseCacheGet, parseCachePut, parseCacheClear, parseCacheCount,
};
