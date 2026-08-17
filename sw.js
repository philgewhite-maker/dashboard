// Bump this whenever cached assets change shape. The activate handler
// deletes every cache that isn't the current name, so raising the version is
// what actually evicts a stale copy from a device that has been running the
// app for a while.
const CACHE_NAME = 'dashboard-v78';
const CORE_ASSETS = [
'./',
'./index.html',
'./css/style.css',
'./js/app.js',
'./js/db.js',
'./js/state.js',
'./js/utils.js',
'./js/ai.js',
'./js/contactscan.js',
'./js/features/habits.js',
'./js/features/goals.js',
'./js/features/jobs.js',
'./js/features/connections.js',
'./js/features/calendars.js',
'./js/features/vouchers.js',
'./js/features/subscriptions.js',
'./js/features/dealexpiries.js',
'./js/features/ideas.js',
'./js/features/enhancements.js',
'./js/features/overview.js',
'./js/features/tasks.js',
'./js/features/questions.js',
'./js/features/tagcleanup.js',
'./js/features/nudges.js',
'./js/features/settings.js',
'./js/features/googleaccount.js',
'./js/features/mail.js',
'./js/sync/config.js',
'./js/sync/googleauth.js',
'./js/sync/googledrive.js',
'./js/sync/selfhost.js',
'./js/sync/autosync.js',
'./js/googlecalendar.js',
'./js/googlecontacts.js',
'./js/googletasks.js',
'./js/files.js',
'./js/features/googletasksfeed.js',
'./js/features/photoalbums.js',
'./js/features/tinderimport.js',
'./js/features/health.js',
'./js/features/photosync.js',
'./js/features/shopping.js',
'./js/features/recipes.js',
'./js/features/sharetarget.js',
'./js/features/contacts.js',
'./js/features/photoscan.js',
'./js/features/notionplan.js',
'./js/notion.js',
'./js/googlemail.js',
'./manifest.webmanifest',
];

self.addEventListener('install', (event) => {
event.waitUntil(
caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting())
);
});

// Holds a share handed over by Android until the page can pick it up. Kept
// out of the version-eviction below: a share can arrive moments before a new
// service worker activates, and wiping it would silently lose whatever was
// just shared.
const SHARE_CACHE = 'pending-share';

self.addEventListener('activate', (event) => {
event.waitUntil(
caches.keys().then((keys) => Promise.all(
keys.filter((k) => k !== CACHE_NAME && k !== SHARE_CACHE).map((k) => caches.delete(k))
)).then(() => self.clients.claim())
);
});

// Android's share sheet POSTs here (see share_target in the manifest). This
// is served from GitHub Pages, which cannot handle a POST at all, so the
// service worker *is* the endpoint: it stashes the payload, then redirects
// to the app, which picks it up and turns it into a task.
async function handleShare(request) {
const shareUrl = (name) => new URL(name, self.registration.scope).href;
try {
const form = await request.formData();
const stamp = Date.now();
const cache = await caches.open(SHARE_CACHE);
const meta = {
title: form.get('title') || '',
text: form.get('text') || '',
url: form.get('url') || '',
files: [],
at: stamp,
};
const shared = form.getAll('files').filter((f) => f && typeof f === 'object' && f.size > 0);
for (let i = 0; i < shared.length; i++) {
const file = shared[i];
const key = shareUrl(`__share-file-${stamp}-${i}`);
await cache.put(key, new Response(file, {
headers: { 'Content-Type': file.type || 'application/octet-stream' },
}));
meta.files.push({ key, name: file.name || `shared-${i + 1}`, type: file.type || '' });
}
await cache.put(shareUrl('__share-meta'), new Response(JSON.stringify(meta), {
headers: { 'Content-Type': 'application/json' },
}));
} catch (err) {
// Redirect regardless: landing in the app with nothing captured is
// recoverable, being left on a blank error page is not.
console.error('Share handling failed:', err);
}
// 303 so the browser follows with a GET rather than re-POSTing.
return Response.redirect(shareUrl('index.html?shared=1'), 303);
}

// Network-first for same-origin app files (so edits show up quickly),
// falling back to cache when offline. Never intercepts API calls.
self.addEventListener('fetch', (event) => {
const url = new URL(event.request.url);
if (url.origin !== self.location.origin) return;
// Must come before the GET-only guard below — this is the one POST the
// worker is expected to answer itself.
if (event.request.method === 'POST' && url.pathname.endsWith('/share')) {
event.respondWith(handleShare(event.request));
return;
}
if (event.request.method !== 'GET') return;

event.respondWith(
fetch(event.request)
.then((res) => {
const clone = res.clone();
caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
return res;
})
.catch(() => caches.match(event.request))
);
});
