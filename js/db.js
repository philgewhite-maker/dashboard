// Thin IndexedDB wrapper. Two stores:
//  - "kv"     small keyed JSON blobs (the app's data document)
//  - "photos" binary image blobs, keyed by a generated id, referenced from
//             connection records instead of embedding base64 in the JSON.
// Photos live here (not in the "kv" document) so the document stays small
// and fast to read/write even once photo storage grows into the 10s of MB.

const DB_NAME = 'dashboard-db';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
if (dbPromise) return dbPromise;
dbPromise = new Promise((resolve, reject) => {
const req = indexedDB.open(DB_NAME, DB_VERSION);
req.onupgradeneeded = () => {
const db = req.result;
if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos');
};
req.onsuccess = () => resolve(req.result);
req.onerror = () => reject(req.error);
});
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

export { openDb, kvGet, kvSet, photoPut, photoGet, photoDelete, photoUrl };
