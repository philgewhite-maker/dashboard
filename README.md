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
  googleaccount, mail, tasks, questions)
- `questions.json` — questions Claude is waiting on answers to; see below
- `js/render-all.js`, `js/tabs.js`, `js/app.js` — bootstrapping and
  cross-panel wiring
- `js/sync/googleauth.js` — shared Google sign-in (Drive, Calendar, and Mail
  all use it)
- `js/sync/googledrive.js`, `js/sync/config.js` — Google Drive sync (see below)
- `js/googlecalendar.js` — Google Calendar reading (see below)
- `js/googlemail.js` — Gmail reading (see below)
- `js/googlecontacts.js` — Google Contacts via the People API (see below)

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

## Google sign-in (shared by Drive sync, Calendar, Mail, Contacts, and Tasks)

One sign-in covers all the features below — `js/sync/googleauth.js`
requests all five scopes (`drive.appdata` + `calendar.readonly` +
`gmail.readonly` + `contacts.readonly` + `tasks.readonly`) up front so you
only get asked once. The Contacts scope becomes the read/write `contacts`
instead if you turn on write-back in Settings; Tasks stays read-only always —
pulling an item into the dashboard's Inbox never changes it in Google Tasks.
The sign-in
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
API, Gmail API, People API, *and* Tasks API → OAuth consent screen with
`drive.appdata`, `calendar.readonly`, `gmail.readonly`, `contacts.readonly`,
and `tasks.readonly` scopes, yourself as a test user → OAuth client ID), then
paste the resulting **Client ID** (ends in
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

## Tasks (GTD)

The Tasks tab is built around capture being separate from deciding.

**Capture** takes a line of text or a photo/screenshot and drops it in the
Inbox unfiled — no bucket, no context, no thinking. Mail rows and calendar
events also have a small "+ task" button that captures with a link back to
the source.

**Inbox** is the allocation workspace. Each item can be filed two ways: a
"File to…" dropdown, or dragged onto a bucket. Both exist deliberately —
HTML5 drag-and-drop is unreliable on touch and this gets used on a phone, so
the dropdown is the real interface and dragging is an enhancement.

**Lists** are the six GTD buckets (Inbox, Next actions, Projects, Waiting
for, Someday/maybe, Done), filterable by context. Contexts default to
Office / Home / DIY / Home PC / Outdoor errands and are editable in the tab.

Per task: subtasks (any task can be "part of" another, with cycles
rejected), a due date, a **bring-forward** date, a reference link for the
detail behind a project, and attached photos. A task with a bring-forward
date in the future is hidden from the working lists and parked under
"Scheduled to surface" — that's the point of a tickler, and it nudges you
when the date arrives.

Nudges cover tasks too: an unfiled inbox (one nudge for the pile, not one
per item), due and overdue tasks, bring-forwards that have arrived, and
"waiting for" items nobody has chased in a fortnight.

## Notion

The dashboard holds the GTD skeleton — what exists, what's next, what
context it needs. Notion holds the flesh: research, options, long-form
thinking that would be miserable in a one-line task. "Draft a plan" is the
join between them.

**Why there's a proxy.** The Notion API sends no CORS headers, so a browser
simply cannot call `api.notion.com` — the request is blocked before it
leaves. Every browser-based Notion integration needs a server in the middle.
Since `sync.php` already exists, `notion.php` sits beside it. The forced
detour is a security win: your Notion token stays on your host and never
reaches the browser, which matters because that token can read and write
your entire workspace.

**Setup**

1. Create an integration at
   [notion.so/profile/integrations](https://www.notion.so/profile/integrations).
   Copy the token (starts with `ntn_`).
2. Make a database in Notion for projects. Any title property name works —
   the code reads the schema rather than assuming "Name".
3. **Share the database with the integration**: open it, ⋯ menu →
   Connections → add your integration. Skipping this is the single most
   common failure, and produces a "not found" rather than a permission error.
4. Copy `server/notion.php.example` to `notion.php`, set `$SECRET` to the
   same secret as `sync.php` and `$NOTION_TOKEN` to your integration token.
   Upload to `public_html`.
5. Settings → Notion: the proxy URL and the database ID (the 32 characters
   in the database URL), then **Test connection**.

`server/notion.php` is gitignored for the same reason as `sync.php`.

**The workflow**

1. Capture anything, however vague, into the dashboard Inbox.
2. File the big ones as **Projects**.
3. On a project, **Create in Notion + draft a plan**. Claude expands the one
   line into a summary, sections of real substance, open questions, and 3–8
   concrete next actions.
4. The *detail* is written into the Notion page. Only the *actions* come back
   as dashboard subtasks, with contexts assigned from your own list.

That asymmetry is deliberate — detail flows out to Notion, actionable items
flow back. Duplicating the detail in both places is how two-system setups
rot. Re-running on the same project appends more thinking and adds only
actions that don't already exist, so it refines rather than duplicates.

**Pinned API version.** `notion.php` pins `Notion-Version` because Notion
makes breaking changes between versions — the 2025-09-03 release moved page
creation from `database_id` to `data_source_id`, which the client handles by
resolving the data source once and caching it. Raise the pin only after
reading that version's upgrade guide.

## Questions from Claude

A channel for answering questions while away from the desk.

Claude publishes questions by pushing `questions.json` to this repo; the
dashboard fetches it same-origin, so there's no auth or CORS involved. You
answer on any device — tap an option, or type your own — and answers are
stored in the synced document, so they follow you around.

**Copy answers** puts them on the clipboard as readable text to paste into a
Claude session. The clipboard is deliberately the return path: it needs no
credentials and nothing of yours has to be externally readable for it to
work. If the browser blocks clipboard access, the text appears in a
selectable box instead.

The panel hides itself entirely when there are no questions.

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

## Photo comparison for album matches

Matching an album to a connection is still ultimately a name comparison —
"Alena" and "Alena A" matched each other by string alone right up until a
human noticed they're different people. Dating admin → Google Photos albums
now helps with that two ways, for any match that isn't an exact name match
(those don't need it):

1. **Always shown**: the connection's existing photo appears right next to
   the incoming album cover, so it's a glance instead of re-reading two
   names carefully.
2. **"AI compare faces" button**: sends both images to Claude (haiku, cheap)
   and reports same / different / unsure with a one-line reason. Never
   applies anything automatically — same rule as every other AI-assisted
   match in this app, it only ever informs the decision on screen.

**Setup, once**: copy `server/image-proxy.php.example` to
`server/image-proxy.php`, set `$SECRET` to the same value as `sync.php`, and
upload it next to the others. **Needs PHP's `curl` extension enabled** —
unlike `sync.php`/`files.php`, this one actually makes an outbound request.
Most shared hosting has it on by default; if the endpoint fails immediately
after uploading, that's the first thing to check.

**Why a proxy is needed at all**: an `<img>` tag can display a Google Photos
URL fine, but the browser can't read those bytes back out — no CORS header
on Google's side — which is exactly what sending the image to Claude
requires. `image-proxy.php` fetches it server-side (PHP has no such
restriction) and hands the bytes back. It is deliberately not a general
proxy: it only ever fetches from `photos.fife.usercontent.google.com` and
`lh3.googleusercontent.com`, checked before any request is made, because
without that allowlist this would fetch any URL a caller supplied —
including internal network addresses.

## Shopping tab

Not a separate system — a filtered view over ordinary GTD tasks, grouped by
four new contexts (Supermarket, Pharmacy, Black Friday, Aspirational
purchases) added to the same context list Tasks already uses. That's
deliberate: it's what lets "buy paint" sit under a DIY project *and* show up
here, and what lets any shopping item be broken into subtasks, dated, or
given a photo just by opening it — that's the normal task detail screen,
nothing shopping-specific duplicates it.

The quick-capture box skips the Inbox triage step: picking a context there
already answers the one question triage exists to ask, so the item goes
straight to Next Actions.

**Search prices**: each item has a "Search prices" button that runs an AI web
search (Claude's server-hosted `web_search` tool — the search itself runs on
Anthropic's side within one API call, no server of ours involved) for that
item across a couple of well-known UK retailers, and shows retailer/name/price
as clickable links straight to the product page.

**Not built**: a two-click add-to-basket. That would need an authenticated
session against each retailer's site — driving a real browser, not something
an API call can do — so it stays a manual click-through from the search
results. Flagged in the panel itself rather than silently dropped.

## Menu tab

Recipes imported from a photo, a PDF, or a web page URL, rated on the same
configurable star mechanism as Connections (a separate list — Taste/Health/
Prep by default), with an occasional nudge to actually cook one of them.

**Import**: a photo or PDF goes straight to Claude's vision/document reading
(the PDF path uses the Messages API's `document` content block). A web URL is
fetched server-side by `server/recipe-fetch.php` (SSRF-hardened: resolves the
hostname, rejects anything pointing at a private/internal address, then pins
the connection to the validated IP) and checked for a schema.org Recipe
JSON-LD block first — most recipe sites embed one for search-engine rich
snippets, and reading it is free and more reliable than a model call. Only
when that's absent does the raw HTML go to Claude as a fallback. Either way
you get an editable review screen (name/ingredients/instructions/notes)
before anything is saved.

**Setup**: like `recipe-fetch.php` needs the same treatment as the other
server files — copy `server/recipe-fetch.php.example` to
`server/recipe-fetch.php`, set `$SECRET` to match `sync.php`, upload it next
to the others. Without it, photo and PDF import still work; only the web-URL
import needs it.

**Cook mode**: opens a full-screen, large-text view of just the ingredients
and steps — the "actually cooking, phone propped up, hands messy" view,
separate from the edit form. "Made it today" from there stamps `lastMade` and
feeds the nudge on the list view, which picks whichever recipe has gone
longest without being made (weighted slightly by rating) and offers a
one-tap "Cook it".

**Google Photos**: unlike Connections' full harvest-and-match pipeline, a
recipe just takes a single pasted album share link — a deliberate scope cut
given how much smaller a recipe's photo needs are than a person's.

## Task attachments

Any task can carry files of any type — PDF, Word, spreadsheets, images,
anything. Open a task in **Tasks → Lists** and use "+ Attach a file".

Attachments need live sync (above) set up first, because they use the same
host and the same secret. **Setup is one extra file:** copy
`server/files.php.example` to `server/files.php`, set `$SECRET` to the *same*
value as `sync.php`, and upload it to `public_html` next to `sync.php`. No
per-device configuration — the app derives the attachments URL from your
existing sync URL by swapping `sync.php` for `files.php`.

`server/files.php` is gitignored for the same reason as `sync.php`: it holds
the secret and this repo is public.

**Why files aren't just put in the synced document.** That document is
rewritten in full on every save, so a single 5MB PDF inside it would make
every autosave push 5MB. Instead the bytes live in their own file on your
host, and only `{id, name, type, size}` travels in the document — a task with
two attachments syncs in well under a kilobyte no matter how large they are.
That metadata is what makes an attachment appear on your other devices; the
bytes are fetched the first time you actually open it, then cached locally,
so the device that uploaded a file never re-downloads it and an
already-opened attachment still opens offline.

## Share to the dashboard from Android

Share a link, a note, or a file from any Android app straight into the GTD
Inbox — Chrome, Gmail, Photos, anywhere with a share button.

**Setup:** open the dashboard in Chrome on the phone, then ⋮ → **Add to Home
screen**. "Dashboard" then appears in the Android share sheet. This only
works from the *installed* PWA, and only on Android — iOS has no share
target.

Shared files are uploaded as task attachments, so live sync and `files.php`
need to be set up first (above). Text and links work without them.

**How it works.** The manifest declares a `share_target`, so Android POSTs
the payload to `./share`. GitHub Pages can't handle a POST at all, so the
*service worker* is the endpoint: it stashes the payload in a cache and
redirects to the app, which picks it up on load and captures the task. That
cache is deliberately exempt from the version eviction in the worker's
`activate` handler — a share can land moments before a new worker activates,
and clearing it would silently lose whatever was just shared.

The payload is read on every load rather than only when `?shared=1` is
present, because the query string is easily lost to a redirect or a restored
session, and a stranded share would then never be captured. Android apps are
also inconsistent about which field carries what — some put the link in
`url`, many put it in `text`, some send only a title — so the task is built
from whatever actually arrived.

## Google Photos albums

Dating admin → "Google Photos albums". Links albums to connections using a
positional title convention:

```
<Name>_<Location or sensitive>_<Date>_<Other>
```

Leave any slot empty if it doesn't apply:

- `Kat_` — their default album
- `Kat_Lisbon` — location Lisbon
- `Kat_x` — private; blurred until hovered, never promoted to a tag
- `Alena__2026_Birthday` — **no** location (note the double underscore),
  date 2026, other "Birthday"
- `Kat_Lisbon_Mar 2026_Sintra day trip` — all four slots

**Only the second slot ever becomes a location tag.** The date can take any
form (`2026`, `Mar 2026`, `summer 25`) and is never parsed or tagged, and
neither is "other" — that's the whole reason the title is positional. An
earlier version tagged everything after the first underscore, which filed
"Birthday" as a place.

The **trailing underscore matters**: without it, `Kat` would prefix-match
`Katerina`. It also makes albums findable by typing `Kat_` into Google
Photos' own search.

Google has no albums API, so the list comes from a console snippet (in the
panel) run on `photos.google.com/albums`. Run it again on `/people` and it
also collects face-group *names* — not links — which feeds the third gap
check below.

**This replaced an earlier people-links import.** That matched face groups
from the people page and stored their URLs, which turned out not to persist:
a face group's `/search/` URL carries a token that stops resolving. An album
is a real, permanent object, so its URL is safe to keep. Matching by name
happens once, at import; what's stored is the URL — so renaming an album
later doesn't break an already-linked person.

Three gaps are reported after matching, the last being the one that's hard
to spot by eye:

- **Connections with no album** — nothing named `Name_` exists for them yet
- **Albums with no connection** — the name differs, or they aren't tracked
- **Faces in Photos with no album** — Google has grouped someone, but you
  never made them an album

## Photo sync

Every photo capture point (screenshot import, "add photo" on a connection,
task/recipe photo attachments) now uploads straight to the same server as
attachments as soon as it's added, so a photo added on one device shows up on
every other device without any extra step. If the upload fails for any
reason — sync isn't set up yet, you're offline, the server hiccups — it falls
back to storing the photo locally on that device only and doesn't block
saving whatever you were adding.

Photos predate that behaviour, though, and older photos (or ones added while
offline) can still end up local-only: their *ids* were always part of the
synced document, but the bytes weren't, so a connection imported on one
device shows initials instead of a face on another, looking identical to "no
photo was ever added". **Settings → Photo sync** is the mop-up for that: it
counts what's on this device only and uploads it to the server, rewriting
every reference (including a connection's avatar `photoId` and any photo
shared between records) to the new server id. It's safe to re-run and safe to
stop partway — a failed or interrupted upload leaves the original photo
untouched and still queued. Worth running once on each device that's been
used offline or before sync was set up.

Anything still unresolved renders as a hatched "?" rather than a blank
square, so a photo that lives on another device is visibly different from
one that was never added. Once uploaded, photos load from the server on
first view and are cached locally after that.

Uploads are capped at 25MB in `files.php`, but your host's own
`post_max_size` / `upload_max_filesize` also apply and are often lower —
whichever is smallest wins. Files are stored outside `public_html`, are only
retrievable with the secret, and are always served as a forced download with
`X-Content-Type-Options: nosniff`, so an uploaded HTML or SVG file can never
execute as a page on your domain. Deleting an attachment, or deleting the
task holding it, removes the file from the server for every device.

## Connections: ratings and sorting

The detailed star ratings (Looks, Figure, Voice, IQ, EQ, Humour, Sex,
Practicality by default) are configurable in **Settings → Connections —
rating categories**, add/remove only — renaming isn't offered, since a
category's storage key is where real per-person data lives and there's no
safe way to rename in place without either orphaning existing ratings or
silently merging two categories together. Removing a category deletes every
rating already given under it, which it warns about before doing.

An **average of whatever's actually been rated** shows next to "Ratings" on
each card and is sortable — an unrated category doesn't drag the average
down, it's just excluded, so "not rated" and "rated low" stay distinguishable.

Sorting also gained **date added** and **record completeness** (a curated
set of fields — the niche optional ones like a full address are deliberately
left out, so completeness doesn't feel unfairly punishing for someone
otherwise well-tracked). Connections that already existed before this had no
recorded add date, so they sort as unknown/oldest rather than guessing
today's date for all of them.

`Intelligence` became `IQ` — anyone already rated under the old name had
that rating moved automatically, not lost.

## Google Contacts match

Dating tab → "Match contacts". Joins connections to your Google Contacts via
the People API, but only for people at **"Moved to WhatsApp" and beyond** —
below that you're still talking inside an app, almost certainly have no
number for them, and every result would be a weak name guess.

Each eligible connection ends up tagged:

- **In contacts** — matched on phone or email, or a name match you confirmed
- **Review contact match** — one or more contacts share the name; needs you
- **Missing in contacts** — nothing plausible found

Matching rules, in order: phone number, then email, then name. Phone and
email identify a person, so those link automatically. **A name match never
links on its own**, even when there's exactly one candidate — the failure
being avoided is a confident-looking wrong link quietly attaching someone
else's address book entry.

Suggestions come from two passes, and **both** run even when the first
succeeds: an exact-name pass, then a wider one catching shortenings in
either direction ("Katya" ↔ "Kat"), substrings, and misspellings within two
letters. An exact match isn't necessarily the right one — a "Katya" saved in
Google as "Katya PDN" shouldn't hide the "Kat" who is actually her.

Choosing is done on the connection's own card, next to their photo, age and
stage, since that's the context the decision needs. Each candidate shows its
phone, email and job, plus why it was suggested and three things from the
People API metadata: whether it's a contact you **saved** or one Google
**auto-collected** from your mail, its labels, and when it was last updated.
There is no contact *creation* date — the API doesn't expose one.

**Age.** An age typed in once is only true on the day you typed it, so `age`
is stored with `ageAsOf` — the date it was correct — and the current age is
derived from it. Someone recorded as 29 two years ago shows as **~31** and
groups in the 30s, rather than staying frozen at 29 forever. A **date of
birth** can be entered alongside and takes precedence, giving an exact age
with no tilde. The tilde is the honest signal that an estimate could be a
year out either way. Editing the age restamps `ageAsOf` to today.

Existing ages had no recorded vintage, so the migration stamps them with
today's date — the least-wrong assumption, since an age is far likelier to
have been entered recently than years ago, and the alternative (leaving it
blank) means it never ages at all.

**Location.** `location` is the **city** and is what Connections Overview
groups by; `address` holds the full postal address as detail only. Both are
kept and both are searchable, but only the city becomes a chip — "15
Cholmeley Park London N6 5ET" would be a group of one.

**Names.** A connection has three name fields, all used for matching:
`name`, `profileName` (what the dating app called them, often not real —
kept so renaming doesn't orphan the photos filed under it), and an **Also
known as** list. "Kat" only finds her Google contact if the record knows she
also goes by "Katya".

**Conflicts and enrichment.** Confirming a match, and every later re-sync,
compares the two records. Anything the contact has that the connection
doesn't gets filled in. Anything they *disagree* on is never applied
automatically — it's flagged on the card with both values and a choice,
because overwriting what you typed with what Google happens to hold is the
wrong default. Contact **group labels** are compared too, so a connection
recorded as Bumble whose contact is filed under "tinder" gets caught.

Names are compared with accents folded and Cyrillic romanised, so
"Zoë"/"Zoe", "Chloé"/"Chloe" and "Катя"/"Katya" match rather than looking
like different people. The transliteration is deliberately rough common
usage rather than BGN/PCGN or ISO 9 — the schemes disagree with each other
anyway, and the goal is only to get close enough to offer for confirmation.

Location is filled from the contact's **city**, not its full address —
"London" is a useful grouping in Connections Overview, "15 Cholmeley Park
London N6 5ET" is a group of one. Google returns addresses in structured
parts, so the city is simply read rather than parsed out.

## Scanning a batch of screenshots

Dating tab → "Scan a batch of screenshots". Two tiers, because fully parsing
every image in an album is the expensive way to do it:

1. **Cheap pass** on everything — a small fast model reading only a name, an
   age, what kind of screenshot it is, and whether it looks detailed enough
   to be worth more. Fractions of a penny each.
2. **Full parse** only on the ones you pick, giving bio, height, education,
   job, languages and cropped photos.

**Nothing is ever parsed twice.** Results are cached against a SHA-256 of the
image bytes, so re-scanning an album as it grows costs nothing for what
you've already seen — and because it hashes the *content*, a renamed or
re-downloaded copy is still recognised. The summary line says how many of a
batch actually cost anything.

**Capture dates feed the age.** The date a screenshot was taken is when the
age on it was true, so it becomes `ageAsOf`: a 2024 screenshot reading 29
shows as ~31 today rather than a stale 29. The date comes from EXIF
`DateTimeOriginal`, else the filename (`Screenshot_20240312-…`), else the
file's modified time — and those are *ranked*, so a renamed copy falling
back to its download date never overwrites a better date recorded earlier.

The cache lives in IndexedDB alongside photos, not in the synced document —
it's a local cost optimisation, not data worth syncing.

## Finding what needs fixing

Two derived Overview dimensions exist to surface gaps rather than to browse:

- **Photos** — No photos / One photo only / 2–5 / 6+. Bucketed rather than
  an exact count, because a chip per count fragments into groups of one. The
  useful question is "who is still on the single thumbnail an import gave
  them?"
- **Photo links** — Album link / Person link / Drive link, multi-valued, so
  the **None** chip lists everyone with no link out to their photos at all.

Connections hold a Google Photos **album** link and a **person/face** link
separately from the Drive link, because those are different gaps to go and
fix. Combine them with drill-down mode to ask things like "one photo AND no
album link".

## Connections Overview modes

The chips work two ways, toggled on the panel:

- **Filter list** (default) — a chip filters the connections below, and
  every chip always shows its total, so the panel stays a map of everything.
- **Drill down** — chips become facets that combine. Pick several and you
  narrow to people matching all of them, with every *other* dimension
  recounting against that narrowed set. A faceted dimension still shows its
  own alternatives, so picking "London" doesn't strand you unable to switch
  to "Paris".

Both answer different questions ("who is in London?" versus "which of my
London people haven't I contacted?"), which is why it's a toggle rather than
a decision. Single-value dimensions like Stage replace rather than add a
second facet, since nobody is in two stages at once.

Phone numbers are compared on their last 9 digits, so `+44 7700 900123`,
`07700 900123` and `(0770) 090-0123` all match. Connections gained Phone and
Email fields to make this possible; confirming a match fills any of phone,
email, location and job that were blank, and never overwrites what you typed.

A link you confirmed survives a re-sync even if the contact is later renamed.

**Writing back** (e.g. saving a birthday to a contact) needs a different,
much broader scope — `contacts` rather than `contacts.readonly` — which can
alter and clear fields in your real address book. It's off by default;
Settings → Google Contacts turns it on, and you have to sign out and in
again because Google won't widen an already-issued token. Two sharp edges in
the People API are handled in `googlecontacts.js`: updates carry the
contact's `etag` so a concurrent change elsewhere is rejected rather than
overwritten, and `updatePersonFields` names only `birthdays`, because a
field named there but not supplied is **cleared**.

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
