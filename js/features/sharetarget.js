// Turns an Android "Share → Dashboard" into a task in the Inbox.
//
// The service worker answers the POST from the share sheet (GitHub Pages
// can't) and stashes the payload in a cache; this reads it on the next page
// load and captures it. Splitting it that way is forced by the platform, but
// it also means a share survives being interrupted — if the app is killed
// before this runs, the payload is still in the cache next time.
//
// Only works from an installed PWA on Android. iOS has no share target.
import { escapeHtml } from '../utils.js';
import { captureTask, revealTask } from './tasks.js';
import { uploadAttachment } from '../files.js';

const SHARE_CACHE = 'pending-share';

function metaUrl() {
return new URL('__share-meta', new URL('./', location.href)).href;
}

// Reads and clears the stash. Cleared even on a partial failure, so a
// payload that can't be processed doesn't re-appear on every single load.
async function takePendingShare() {
if (!('caches' in window)) return null;
let cache;
try { cache = await caches.open(SHARE_CACHE); } catch (e) { return null; }
const res = await cache.match(metaUrl());
if (!res) return null;

let meta;
try { meta = await res.json(); } catch (e) { await cache.delete(metaUrl()); return null; }

const files = [];
for (const f of meta.files || []) {
try {
const fileRes = await cache.match(f.key);
if (fileRes) files.push(new File([await fileRes.blob()], f.name, { type: f.type || 'application/octet-stream' }));
} catch (e) {
console.error('Could not read a shared file:', e);
} finally {
await cache.delete(f.key).catch(() => {});
}
}
await cache.delete(metaUrl()).catch(() => {});
return { ...meta, files };
}

// Android apps are inconsistent about which field carries what: some put the
// link in `url`, many put it in `text`, some send a title and nothing else.
// So build the task from whatever actually arrived rather than trusting any
// one field.
function composeTask(share) {
const title = (share.title || '').trim();
const text = (share.text || '').trim();
const url = (share.url || '').trim();

// A bare URL sitting in `text` is the common Chrome case.
const textIsUrl = /^https?:\/\/\S+$/i.test(text);
const link = url || (textIsUrl ? text : '');

let taskTitle = title;
if (!taskTitle && text && !textIsUrl) taskTitle = text.split('\n')[0].slice(0, 120);
if (!taskTitle && link) taskTitle = link;
if (!taskTitle && share.files.length) taskTitle = share.files[0].name;
if (!taskTitle) taskTitle = 'Shared item';

// The link isn't repeated in the notes: it already has its own field on
// the task (rendered as "Open reference") and is kept on `source`.
const notes = (text && text !== taskTitle && !textIsUrl) ? text : '';

return {
title: taskTitle,
notes,
link,
source: { kind: 'share', label: title || link || 'Shared from another app', url: link },
};
}

function banner(message, taskId) {
const el = document.createElement('div');
el.className = 'share-banner';
el.innerHTML = `<span>${escapeHtml(message)}</span>${taskId ? '<button type="button">Open it</button>' : ''}<span class="share-x">&times;</span>`;
document.body.appendChild(el);
const close = () => el.remove();
el.querySelector('.share-x').addEventListener('click', close);
const open = el.querySelector('button');
if (open) {
open.addEventListener('click', async () => {
const { switchTab } = await import('../tabs.js');
switchTab('tasks');
revealTask(taskId);
close();
});
}
setTimeout(close, 12000);
}

async function initShareTarget() {
// Checked on every load rather than only when ?shared=1 is present: the
// query string is easily lost (a redirect, a restored session), and a
// stranded payload would then never be captured.
let share;
try { share = await takePendingShare(); } catch (e) { console.error('Share pickup failed:', e); return; }
if (!share) return;

const task = captureTask(composeTask(share));

const failed = [];
for (const file of share.files) {
try {
task.attachments.push(await uploadAttachment(file));
} catch (err) {
console.error('Could not attach a shared file:', err);
failed.push(`${file.name}: ${err.message || err}`);
}
}
if (share.files.length) {
const { queueSave } = await import('../state.js');
queueSave();
const { renderTasks } = await import('./tasks.js');
renderTasks();
}

const n = share.files.length - failed.length;
let msg = `Captured "${task.title.slice(0, 60)}" to your Inbox`;
if (n) msg += ` with ${n} file${n === 1 ? '' : 's'}`;
msg += '.';
if (failed.length) msg += ` ${failed.length} file${failed.length === 1 ? '' : 's'} couldn't be attached — see Settings.`;
banner(msg, task.id);
}

export { initShareTarget, composeTask, takePendingShare };
