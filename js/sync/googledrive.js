// Google Drive sync — the Drive-specific half of Google integration; see
// googleauth.js for sign-in (shared with Calendar reading). Everything
// lives in Drive's hidden "appDataFolder" (the `drive.appdata` scope) —
// invisible in your normal Drive UI, and this app cannot see or touch
// anything else in your Drive.
//
// Sync stays explicit (Push / Pull buttons), not automatic — see
// README.md for why, after the incident that prompted this whole rewrite.
import { data, exportBackup, replaceData, setLocalSetting } from '../state.js';
import { photoGet, photoPut } from '../db.js';
import { googleFetch } from './googleauth.js';

const DRIVE_FILES_API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const DATA_FILENAME = 'data.json';

class NotSignedInError extends Error {
constructor() { super('Not signed in to Google Drive.'); this.name = 'NotSignedInError'; }
}

async function findFile(name) {
const q = encodeURIComponent(`name='${name.replace(/'/g, "\\'")}' and trashed=false`);
const res = await googleFetch(`${DRIVE_FILES_API}?spaces=appDataFolder&q=${q}&fields=files(id,name,modifiedTime,size)`);
if (!res.ok) throw new Error(`Drive lookup failed: ${res.status}`);
const json = await res.json();
return (json.files && json.files[0]) || null;
}

async function createFile(name, mimeType, body) {
const metadata = { name, parents: ['appDataFolder'], mimeType };
const boundary = 'dashsync' + Math.random().toString(36).slice(2);
const bodyBlob = body instanceof Blob ? body : new Blob([body], { type: mimeType });
const parts = [
new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`]),
bodyBlob,
new Blob([`\r\n--${boundary}--`]),
];
const res = await googleFetch(`${DRIVE_UPLOAD_API}?uploadType=multipart&fields=id`, {
method: 'POST',
headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
body: new Blob(parts),
});
if (!res.ok) throw new Error(`Drive upload failed: ${res.status}`);
return (await res.json()).id;
}

async function updateFileContent(fileId, mimeType, body) {
const res = await googleFetch(`${DRIVE_UPLOAD_API}/${fileId}?uploadType=media`, {
method: 'PATCH',
headers: { 'Content-Type': mimeType },
body,
});
if (!res.ok) throw new Error(`Drive update failed: ${res.status}`);
}

async function putFile(name, mimeType, body) {
const existing = await findFile(name);
if (existing) await updateFileContent(existing.id, mimeType, body);
else await createFile(name, mimeType, body);
}

async function getFileContent(name) {
const existing = await findFile(name);
if (!existing) return null;
const res = await googleFetch(`${DRIVE_FILES_API}/${existing.id}?alt=media`);
if (!res.ok) throw new Error(`Drive download failed: ${res.status}`);
return res;
}

function collectPhotoIds(fromData) {
const ids = new Set();
(fromData.connections || []).forEach((c) => (c.photoIds || []).forEach((id) => ids.add(id)));
return ids;
}

async function getRemoteInfo() {
const existing = await findFile(DATA_FILENAME);
if (!existing) return null;
return { lastModified: existing.modifiedTime, size: existing.size };
}

const COUNTED_LISTS = ['connections', 'habits', 'goals', 'jobs', 'vouchers', 'businessIdeas'];

function countsOf(d) {
const out = {};
COUNTED_LISTS.forEach((key) => { out[key] = Array.isArray(d[key]) ? d[key].length : 0; });
return out;
}

// Downloads and summarizes the remote copy without applying it — used to
// warn before Push if remote has records local doesn't, so a device that
// hasn't pulled yet (or lost local data some other way) can't silently
// erase a fuller remote copy the way it did before this existed.
async function getRemoteCounts() {
const res = await getFileContent(DATA_FILENAME);
if (!res) return null;
return countsOf(await res.json());
}

async function pushToGoogleDrive(onProgress) {
const progress = onProgress || (() => {});
progress('Uploading data…');
const payload = JSON.stringify({ ...data, _syncedAt: new Date().toISOString() }, null, 2);
await putFile(DATA_FILENAME, 'application/json', payload);

const photoIds = [...collectPhotoIds(data)];
for (let i = 0; i < photoIds.length; i++) {
progress(`Uploading photos… (${i + 1}/${photoIds.length})`);
const blob = await photoGet(photoIds[i]);
if (!blob) continue;
await putFile(`photo-${photoIds[i]}.jpg`, 'image/jpeg', blob);
}
await setLocalSetting('lastPushedAt', new Date().toISOString());
}

async function pullFromGoogleDrive(onProgress) {
const progress = onProgress || (() => {});
progress('Backing up your current local data first…');
await exportBackup();

progress('Downloading data…');
const res = await getFileContent(DATA_FILENAME);
if (!res) throw new Error('No backup found in Google Drive yet. Push from a device with your data first.');
const remote = await res.json();
delete remote._syncedAt;

const photoIds = [...collectPhotoIds(remote)];
for (let i = 0; i < photoIds.length; i++) {
const existing = await photoGet(photoIds[i]);
if (existing) continue; // photos are immutable once created — no need to re-fetch
progress(`Downloading photos… (${i + 1}/${photoIds.length})`);
const pres = await getFileContent(`photo-${photoIds[i]}.jpg`);
if (pres) await photoPut(photoIds[i], await pres.blob());
}

await replaceData(remote);
await setLocalSetting('lastPulledAt', new Date().toISOString());
}

export {
NotSignedInError,
getRemoteInfo, getRemoteCounts, countsOf, pushToGoogleDrive, pullFromGoogleDrive, collectPhotoIds,
};
