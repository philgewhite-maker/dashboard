// Bump this whenever cached assets change shape. The activate handler
// deletes every cache that isn't the current name, so raising the version is
// what actually evicts a stale copy from a device that has been running the
// app for a while.
const CACHE_NAME = 'dashboard-v354';
const CORE_ASSETS = [
'./',
'./index.html',
'./css/style.css',
'./js/app.js',
'./js/db.js',
'./js/state.js',
'./js/utils.js',
'./js/bankLogos.js',
'./js/ai.js',
'./js/contactscan.js',
'./js/features/habits.js',
'./js/features/goals.js',
'./js/features/jobs.js',
'./js/features/connections.js',
'./js/features/calendars.js',
'./js/features/airbnb.js',
'./js/features/vouchers.js',
'./js/features/subscriptions.js',
'./js/features/financeaccounts.js',
'./js/features/switchoffers.js',
'./js/features/ideas.js',
'./js/features/enhancements.js',
'./js/features/overview.js',
'./js/features/tasks.js',
'./js/features/questions.js',
'./js/features/tagcleanup.js',
'./js/features/photoquality.js',
'./js/features/nudges.js',
'./js/features/settings.js',
'./js/features/googleaccount.js',
'./js/features/mail.js',
'./js/features/mailActions.js',
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
'./js/features/manualimport.js',
'./js/features/health.js',
'./js/features/healthparse.js',
'./js/features/renpho.js',
'./js/features/wellness.js',
'./js/features/healthrollup.js',
'./js/features/healthchart.js',
'./js/features/travel.js',
'./js/features/planner.js',
'./js/features/telegramfamily.js',
'./js/features/photosync.js',
'./js/features/shopping.js',
'./js/features/recipes.js',
'./js/features/sharetarget.js',
'./js/features/captureinbox.js',
'./js/features/captureOutcomes.js',
'./js/features/readinglist.js',
'./js/features/voicecapture.js',
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
// Hoisted to module scope -- the fetch listener below needs it too, to
// build the redirect Response it now sends immediately, before
// handleShare has even started reading the shared file (see the fetch
// listener's own comment on why that ordering changed).
const shareUrl = (name) => new URL(name, self.registration.scope).href;

async function handleShare(request) {
// Read before formData() consumes the body -- these are raw facts about
// what the network request itself looked like, kept separate from
// anything formData() goes on to parse out of it. The point: if a real
// file was staged in the OS share sheet (confirmed live once -- Android
// showed "1 image, 489.60 KB" staged for this app) but form.getAll
// ('files') below still comes back empty, these two numbers are what
// distinguish "the POST body never actually carried the bytes" from "the
// bytes arrived but formData() parsed them out wrong" -- two different
// bugs with the same downstream symptom, not distinguishable without
// this. Not a diagnosis by themselves, just the facts to diagnose from.
const requestContentType = request.headers.get('content-type') || '';
const requestContentLength = request.headers.get('content-length') || '';
// A real multipart Content-Type with a real boundary has now been
// confirmed arriving here (live, twice -- from Gallery and directly
// from MBNA, same result both times: ruling out the source app
// entirely) while formData() still parses zero fields out of it. That
// means either the body itself is empty despite the header claiming
// otherwise, or formData() is failing to parse a body that IS there --
// two different bugs, indistinguishable without seeing the actual
// bytes. Cloned so this read doesn't consume the body formData() below
// still needs -- Request/Response bodies can only be read once each,
// clone() is what makes two independent reads possible.
let rawBodyByteLength = null;
let rawBodySnippet = '';
try {
const buf = await request.clone().arrayBuffer();
rawBodyByteLength = buf.byteLength;
// First 400 bytes as text is enough to show the multipart preamble --
// boundary line, Content-Disposition headers, field names -- before
// hitting a file part's actual binary bytes. Non-printable bytes
// (the binary itself, once the snippet runs into it) are flattened to
// "." rather than left as raw control characters, which JSON.stringify
// would otherwise mangle or bloat via escaping.
rawBodySnippet = new TextDecoder('utf-8', { fatal: false }).decode(buf.slice(0, 400)).replace(/[^\x20-\x7E\n]/g, '.');
} catch (err) {
rawBodySnippet = `(raw body read failed: ${err.message || err})`;
}
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
requestContentType,
requestContentLength,
rawBodyByteLength,
rawBodySnippet,
// Every field name formData() actually parsed out, regardless of
// whether it's one this code reads (title/text/url/files) -- if the
// source app sent the file under some other field name, or the
// manifest's declared "files" param name and what actually arrived
// don't match for some reason, this is what would show it.
formFieldNames: [...new Set([...form.keys()])],
};
// A file entry can arrive in the FormData but be unreadable (0 bytes).
// Recording the attempt count here (before the size>0 filter below
// drops it) is what lets sharetarget.js tell "nothing was shared"
// apart from "something was shared but couldn't be read" -- the two
// look identical downstream otherwise, and the whole point is not
// leaving a share that silently lost its content indistinguishable from
// one that never had any. (Which of these two is actually happening,
// and why, isn't established yet -- see the comment above requestContent
// Type for the live case that ruled out "the source app never attached
// a file" as the explanation, without yet pinning down the real cause.)
const fileAttempts = form.getAll('files').filter((f) => f && typeof f === 'object');
meta.fileAttemptCount = fileAttempts.length;
meta.emptyFileNames = fileAttempts.filter((f) => !(f.size > 0)).map((f) => f.name || '').filter(Boolean);
const shared = fileAttempts.filter((f) => f.size > 0);
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
// Best-effort: still stash SOMETHING so this doesn't vanish with no
// task and no banner at all -- indistinguishable, until now, from the
// share never having reached this handler in the first place. If
// request.formData() itself is what threw (a real possibility --
// that's the exact call whose output is currently unexplained), this
// is the only record of the attempt that survives.
try {
const cache = await caches.open(SHARE_CACHE);
await cache.put(shareUrl('__share-meta'), new Response(JSON.stringify({
title: '', text: '', url: '', files: [], at: Date.now(),
requestContentType, requestContentLength, formFieldNames: [],
rawBodyByteLength, rawBodySnippet,
handlerError: String(err && err.message || err),
}), { headers: { 'Content-Type': 'application/json' } }));
} catch (err2) { /* even the fallback stash failed -- truly nothing left to record */ }
}
// No response returned here any more -- the fetch listener below now
// sends the redirect itself, immediately, before calling this function.
// See that listener's own comment for why.
}

// Network-first for same-origin app files (so edits show up quickly),
// falling back to cache when offline. Never intercepts API calls.
//
// `cache: 'no-store'` on the fetch itself matters: without it, "network-
// first" only means "ask the network" -- it does NOT mean the network
// actually gets asked. A plain fetch() still consults the browser's own
// native HTTP cache first (governed by whatever Cache-Control/Expires
// GitHub Pages happens to send), completely separate from this file's
// own CACHE_NAME/Cache-API storage below. Confirmed live: a genuine
// fresh reload showed the new build-stamp (index.html itself came
// through) while a deployed JS file's actual BEHAVIOUR was still the
// old version for a few minutes after push -- the exact silent-stale
// case this line exists to rule out, not just GitHub Pages' own CDN
// propagation delay (which no client-side fix can shorten, but at least
// isn't compounded by an extra, avoidable browser-cache layer on top).
self.addEventListener('fetch', (event) => {
const url = new URL(event.request.url);
if (url.origin !== self.location.origin) return;
// Must come before the GET-only guard below — this is the one POST the
// worker is expected to answer itself.
//
// Responds with the redirect IMMEDIATELY, before handleShare has read a
// single byte of the shared file, and does the actual reading/stashing
// afterward via waitUntil() instead of awaiting it first. This used to
// be the other way round (await the full read, THEN redirect) and a
// large image share consistently arrived with real headers/boundary but
// a genuinely empty body -- confirmed live via raw byte inspection, not
// a parsing bug. The leading theory: Android's content:// grant for the
// shared file has its own short lifetime, and our handler taking even a
// little time (cloning, hashing into Cache Storage) before responding
// was enough for Android to tear it down before the bytes were actually
// read -- this ordering (respond first, read second) is the standard
// pattern other Web Share Target implementations use specifically to
// avoid that. Unconfirmed as THE fix rather than A fix; the tradeoff is
// a real one -- if the page loads and checks for a pending share before
// the background write finishes, that first check finds nothing.
// takePendingShare() already re-checks on every load (not just ?shared=1),
// so nothing is lost permanently, and sharetarget.js's own initShareTarget
// adds a short retry specifically for this race when ?shared=1 is present.
if (event.request.method === 'POST' && url.pathname.endsWith('/share')) {
event.respondWith(Response.redirect(shareUrl('index.html?shared=1'), 303));
event.waitUntil(handleShare(event.request));
return;
}
if (event.request.method !== 'GET') return;

event.respondWith(
fetch(event.request, { cache: 'no-store' })
.then((res) => {
const clone = res.clone();
caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
return res;
})
.catch(() => caches.match(event.request))
);
});
