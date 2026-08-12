# Dashboard

A personal life-admin dashboard — habits, goals, job hunt, dating/connections,
calendars, vouchers, and business ideas. Runs entirely client-side: no
backend, no account, no build step. Data is stored in this browser's
IndexedDB and never leaves your device unless you export a backup.

This replaces an earlier version that lived as a Claude.ai artifact. That
version stored data via Claude's own `window.storage` API, which only exists
inside a claude.ai chat — it can't run standalone or on your phone. This
version is a real static web app so it can eventually be hosted at a URL and
used from any device.

## Running it locally

Any static file server works. From this folder:

```bash
python3 -m http.server 8080
```

(or the included `serve.ps1` on Windows: `powershell -File serve.ps1`).
Then open `http://localhost:8080`. It won't work opened directly as a
`file://` URL — browsers block ES module imports over `file://`.

## What's here

- `index.html` / `css/style.css` — shell and styling
- `js/db.js` — IndexedDB wrapper (app data + photo blobs, stored separately
  so photos scale without bloating the main data document)
- `js/state.js` — data model, migrations, save orchestration
- `js/ai.js` — direct-from-browser calls to the Anthropic API for the
  photo/screenshot import feature (see below)
- `js/features/*.js` — one module per panel (habits, goals, jobs,
  connections, calendars, vouchers, ideas, overview, nudges, settings,
  googleaccount, mail)
- `js/render-all.js`, `js/tabs.js`, `js/app.js` — bootstrapping and
  cross-panel wiring
- `js/sync/googleauth.js` — shared Google sign-in (Drive, Calendar, and Mail
  all use it)
- `js/sync/googledrive.js`, `js/sync/config.js` — Google Drive sync (see below)
- `js/googlecalendar.js` — Google Calendar reading (see below)
- `js/googlemail.js` — Gmail reading (see below)

## Data safety

Every save is a full-document overwrite of one IndexedDB record — there's no
field-level merge. To make that safe, `state.js` tracks a revision number:
before writing, it checks whether the on-disk revision has moved past what
this session last saw. If it has (another tab saved, or a sync pulled
something in), it refuses to overwrite — it pulls the newer data in and
re-renders instead of silently erasing it. The trade-off is that *this*
session's very latest unsaved change can be dropped in that situation (the
save-status line at the bottom of the page says so when it happens) — but
nothing already-saved is ever silently destroyed by a stale write. The same
principle carries into Google Drive sync below: pulling always backs up
local data first, and nothing overwrites without you seeing a summary and
confirming.

A separate safeguard: saves are debounced by 250ms for rapid interactions
(dragging a goal's progress slider), but `app.js` also forces an immediate
save on `visibilitychange`/`pagehide` — so closing the tab, refreshing, or
switching apps can't lose whatever's inside that debounce window.

## Google sign-in (shared by Drive sync, Calendar, and Mail)

One sign-in covers all three features below — `js/sync/googleauth.js`
requests all three scopes (`drive.appdata` + `calendar.readonly` +
`gmail.readonly`) up front so you only get asked once. The sign-in
button/status lives in the header, next to the date, since — with no refresh
token in this client-side-only flow — reconnecting is common enough that it
needed to be one click away rather than buried in a tab. The chattier
account details (last pushed/pulled, sign-in/out status messages) live in
**Settings → Google account**, so the header itself stays a single small
button or dot.

Sign-in uses Google's pure client-side flow (no backend to hold a refresh
token), so a session lasts about an hour before needing a quiet re-request —
usually invisible if you're still logged into Google in that browser, but
not guaranteed. If a reload ever drops you back to "Sign in" instead of
showing you as connected, that's this trade-off, not a bug — see the
`tryReconnectSilently()` comment in that file for why it's deliberately
silent rather than throwing an error at you (a background reconnect attempt
opens a real popup under the hood, and browsers correctly block popups that
aren't a direct result of a click — showing an error for that would be
alarming for no reason, so it fails quietly and falls back to a reliable
one-click Sign In / Reconnect instead).

**One-time setup**, per the Google Cloud Console steps (ask Claude Code to
repeat them if you need them again — project → enable Drive API, Calendar
API, *and* Gmail API → OAuth consent screen with `drive.appdata`,
`calendar.readonly`, and `gmail.readonly` scopes, yourself as a test user →
OAuth client ID), then paste the resulting **Client ID** (ends in
`.apps.googleusercontent.com`) into `js/sync/config.js` — it's not a secret,
safe to commit. If you add a scope to an app that didn't request it before
(e.g. adding Gmail to an app that only had Drive+Calendar), you'll need to
**sign out and sign in again** once — that's Google requiring fresh consent
for a new permission, not a bug; a token issued before the scope existed
won't retroactively carry it.

**Seeing "Couldn't sync: calendar list failed: 403"** (or the equivalent for
Mail)? That's not an auth failure (you're signed in fine, or Drive wouldn't
work either) — it means either the relevant API isn't enabled on the Google
Cloud project, or its scope was never added to the OAuth consent screen.
Fix both (Library → enable the API; OAuth consent screen → Edit app →
Scopes → add the scope → save), then **sign out and sign in again**.

## Google Calendar sync

Overview tab → "Sync calendars." Read-only — this never creates, edits, or
deletes anything in your Google Calendar. Add calendar names to track in
Settings (must match how they appear in Google Calendar, e.g. "Work",
"Family" — case-insensitive, and a partial match is accepted if there's no
exact one). Sync resolves each name to a real calendar and shows its single
next upcoming event. This replaces what the original claude.ai artifact did
via an MCP connector only available inside claude.ai chats — a standalone
app needs its own direct OAuth to Google Calendar, which is what the shared
sign-in above provides.

## Gmail

Overview tab → "Refresh mail." Read-only (`gmail.readonly`) — this never
sends, labels, or deletes anything. Shows your top 5 starred messages, plus
anything from a couple of tracked senders (`TRACKED_SENDERS` in
`js/googlemail.js`) in the last 2 days. A message that's both starred and
from a tracked sender only appears once, under Starred.

## Live sync to your own server

Settings → "Live sync (your own server)". Saves to your own hosting a couple
of seconds after you stop editing, and picks up other devices' changes on
load, on returning to the tab, and on a 45-second poll while the tab is
visible. No OAuth, so unlike the Google paths below there's no hourly token
to re-request and nothing to be popup-blocked.

**Setup**, once on the server and once per device:

1. Copy `server/sync.php.example` to `server/sync.php`, and set `$SECRET` to
   a long random string. Check `$ALLOWED_ORIGINS` lists wherever you load the
   app from. Generate a secret with `openssl rand -hex 32`, or on Windows
   PowerShell (where openssl usually isn't on PATH):
   `$b=[byte[]]::new(32); [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b|%{$_.ToString('x2')})`
2. Upload `sync.php` to `public_html` on your host (cPanel → File Manager).
   `server/.htaccess` is optional — with the default `$DATA_FILE` the document
   already lives outside `public_html`. Only add it (appending to any
   existing `.htaccess`, never replacing one) if you move the data file into
   a web-served directory.

`server/sync.php` is gitignored, because this repo is public and the
configured file contains your secret. Only the `.example` is tracked — don't
rename it back.
3. In Settings, enter the URL (e.g. `https://yourdomain/sync.php`) and the
   same secret, then press **Test & start syncing**.
4. Repeat step 3 on every other device, same URL and secret.

The URL and secret are stored per-device and are deliberately never
committed (this repo is public) and never included in a backup export. The
data file itself defaults to one directory *above* `public_html`, so it
isn't reachable over the web even if the `.htaccess` is lost.

**How conflicts are handled.** Every save rewrites the whole document, so
without a guard a phone save would silently erase a desktop save made
seconds earlier. Each write therefore carries the revision it was based on,
and the server refuses it with a 409 if that revision has moved on, handing
back the newer document. The client adopts the newer copy, re-renders, and
downloads a backup of what this device had first — the same safety net
"Pull from Google Drive" already provides.

The remaining gap: conflicts resolve at whole-document granularity, so if
two devices edit *different* records inside the same few seconds, one of
those edits ends up only in the downloaded backup rather than merged. The
frequent polling makes that window small, but closing it properly means
per-record timestamps and merge, which isn't built yet.

If you'd rather avoid cross-origin requests entirely, serve the whole app
from the same host as `sync.php` instead of GitHub Pages — then
`$ALLOWED_ORIGINS` stops mattering.

## Google Drive sync

Settings → Sync (Google Drive). Explicit, not automatic: Push uploads your
current local data over whatever's already in Drive; Pull downloads Drive's
copy and replaces local data with it (after auto-downloading a timestamped
backup of what it's about to overwrite, so a bad pull is always recoverable
from your Downloads folder). It's deliberately not a silent background sync
— bidirectional auto-merge across devices is a much harder problem, and
after the data-loss incident that prompted the revision-check above, an
explicit, confirmed action seemed like the right place to start.

Everything lives in Drive's hidden `appDataFolder` (the `drive.appdata`
scope) — invisible in your normal Drive UI, and this app cannot see or touch
anything else in your Drive. (OneDrive was the original plan — three
different Azure/Entra account errors in a row made Google Drive the more
practical choice; the sync module was written generically enough that
switching only meant rewriting `js/sync/*`, nothing else in the app.)

Push also checks what's already in Drive before uploading — if Drive has
more records than this device does in any category, it warns explicitly
with a per-category breakdown instead of a generic confirm, because a quiet
overwrite in that direction is exactly what caused a real data-loss incident
during development (ask Claude Code for the story if you want the details).

## AI photo import

Settings → paste an Anthropic API key. It's stored in a separate IndexedDB
key from the rest of your data (`local-settings`, never touched by backup
export/import), and used only for direct browser→Anthropic calls via the
`anthropic-dangerous-direct-browser-access` header — no server in between.
You'll need to paste the key again on each device you use.

The Dating tab's "Import matches list" / "Import profile screenshot(s)"
buttons use this to pull names, ages, and cropped avatar photos out of
dating-app screenshots. A profile screenshot also yields height, education,
location, job, kids, languages, nationality and a bio summary. The source
picked next to the import buttons is passed into the prompt (layouts differ
per app), except for "Real life"/"Other", which describe how you met rather
than a screen.

Imported people are matched against existing connections by name. A match
is a **merge**, not a replace: empty fields fill in, arrays union, notes
concatenate, photos and to-dos append, and stage only ever moves forward.
Anything you typed yourself wins over anything read off a screenshot. Every
existing person sharing that name is shown with their photo so you can tell
two Sarahs apart. Duplicates spotted later can be merged from the connection
itself, via "Merge a duplicate into this one".

## API usage and cost

Settings → AI features shows this month's calls, tokens and estimated spend,
split by purpose (photo import vs smart nudges) and by model. It's an
estimate: token counts come from the API, but prices are a table in
`js/ai.js` you may need to update, and it counts only calls made on this
device. Models missing from that table show tokens but no cost rather than
a wrong one.

## Private fields

Connections have a "Sex" tag field that is hidden by default; Settings →
Private fields turns it on. While hidden it isn't displayed, isn't grouped
in Connections Overview, and isn't searchable — otherwise a row could match
a search for a reason you can't see. The visibility choice is per-device;
anything recorded still saves and syncs regardless.

## Smart nudges

Settings → AI features → "Smart nudges" (off by default). The Nudges panel
normally shows 4 random items from the pool of everything that might be
worth a nudge (overdue contacts, broken habit streaks, expiring vouchers,
upcoming events, stale goals/ideas). With this on, `js/features/nudges.js`
instead sends the full pool — each item tagged with structured signals
(days since/until, your 1-5 priority rating, habit streak length, goal
progress) — to Claude (a cheap/fast model, independent of whatever model
you've set for photo import) and asks it to pick the 4 most worth surfacing
right now, balancing urgency, importance, and neglect rather than just
whichever number is biggest. The model only ever returns which items to
show, never rewritten text, so a bad response can't produce a broken or
hallucinated click target — it just falls back to a random pick, same as
smart mode being off. Results are cached per unique pool state so it isn't
re-calling the API on every render; Shuffle forces a fresh call.

## Bugs fixed vs. the original artifact version

- Photos are stored as real IndexedDB blobs instead of base64 strings jammed
  into the synced JSON — the old approach hit storage limits fast and forced
  a workaround (auto-downloading full-res originals to disk rather than
  keeping them in the app at all). Now photos just live in the app.
- Destructive deletes (connections, habits, goals, business ideas, backup
  import) now ask for confirmation — losing months of dating notes or a
  habit streak to a stray click was too easy before.
- Business ideas got a status field (Idea → Exploring → Building → Shelved)
  instead of being the one panel with no way to track progress.
- Split a single 2,600-line file into ~20 focused modules.

## Hosting

Live at [philgewhite-maker.github.io/dashboard](https://philgewhite-maker.github.io/dashboard/)
via GitHub Pages, built straight from this repo's `master` branch — pushing
to `master` and reloading is the entire deploy step (the service worker
fetches network-first, so a normal reload picks up new pushes without
needing to clear anything).

## Backup

Settings → Export backup downloads a JSON file with everything except your
API key (device-local, never exported) and photo binaries. Photos are
referenced by ID in the backup but the actual image bytes stay in this
browser's IndexedDB — restoring a backup on a *different* device brings back
every connection's notes/ratings/etc. but not their photos (you'd see the
initials fallback instead). This is the same gap Google Drive sync is meant
to close for photos specifically. Import backup replaces all current data,
so it'll ask you to confirm.
