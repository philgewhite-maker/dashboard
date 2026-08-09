const CACHE_NAME = 'dashboard-v1';
const CORE_ASSETS = [
'./',
'./index.html',
'./css/style.css',
'./js/app.js',
'./js/db.js',
'./js/state.js',
'./js/utils.js',
'./js/ai.js',
'./js/features/habits.js',
'./js/features/goals.js',
'./js/features/jobs.js',
'./js/features/connections.js',
'./js/features/calendars.js',
'./js/features/vouchers.js',
'./js/features/ideas.js',
'./js/features/overview.js',
'./js/features/nudges.js',
'./js/features/settings.js',
'./js/features/googleaccount.js',
'./js/features/mail.js',
'./js/sync/config.js',
'./js/sync/googleauth.js',
'./js/sync/googledrive.js',
'./js/googlecalendar.js',
'./js/googlemail.js',
'./manifest.webmanifest',
];

self.addEventListener('install', (event) => {
event.waitUntil(
caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting())
);
});

self.addEventListener('activate', (event) => {
event.waitUntil(
caches.keys().then((keys) => Promise.all(
keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
)).then(() => self.clients.claim())
);
});

// Network-first for same-origin app files (so edits show up quickly),
// falling back to cache when offline. Never intercepts API calls.
self.addEventListener('fetch', (event) => {
const url = new URL(event.request.url);
if (url.origin !== self.location.origin) return;
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
