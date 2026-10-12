# Dashboard — standing conventions

This file is loaded into every session working in this repo, unlike
`memory/*.md` notes (recalled probabilistically by relevance match, which
is why a documented convention can still get missed when heads-down on a
new feature's mechanics — confirmed live TWICE: `js/features/
photoquality.js` shipped with a bare-text connection name despite the
standard below already existing, and `financeaccounts.js`'s own money-
flow diagram shipped with cards that didn't link back to their account
row — the SAME miss, on a BRAND-NEW record type the standard's own
wording didn't obviously cover, and in a DIAGRAM NODE rather than a
chip/badge, which apparently didn't register as "a reference to a
record" as readily as a chip does). Check this file's tables BEFORE
writing any new render function for a person, task, trip, chip-shaped
value, OR ANY OTHER RECORD TYPE THIS APP TRACKS (an Airbnb listing, a
Finance account, anything future) — not after.

## Record-reference standards

**The general rule, which applies beyond the specific types spelled out
below**: whenever ANY record this app tracks — not just connection/
task/trip, ANY of them, including ones added after this was written —
is shown somewhere OTHER than its own main card/list, in ANY visual
form (a chip, a badge, a table row, a diagram/graph NODE) **OR ANY
GENERATED TEXT** (a status line, a success/fail toast, an error
message, anything built with a template string rather than typed by
the user), it must link back to the real record: click it, land on the
real card, scrolled and flashed into view. A diagram node is not exempt
just because the diagram itself reads as "its own view" — it's still
just another place that record is shown. A success/fail message is not
exempt just because it's "just text" and scrolls away — confirmed live
a THIRD time: a mail action's "Added 6 fields to \"Opatija, Zadar,
Split\" — transfer." message named a trip in plain text with no way to
click through and check it, because this rule's wording only said
"visual form" and a status message didn't register as one. When a
genuinely new record type's own reference pattern doesn't exist yet (a
new type like Finance accounts, or — as of this writing — a trip), build
ONE canonical version (e.g. `expandAccountRow()` for accounts,
`tripChipHtml()`/`bindTripChips()` for trips) the first time that type
needs referencing anywhere, then reuse it everywhere else that type
appears — including anywhere-else built LATER in the same feature, like
a diagram added after the initial list, or a success message added
after the chip already exists elsewhere.

**Don't report a bare count with no way to judge it.** "Added 6
fields" means nothing without knowing how many were possible or which
were actually required — the reader has to go find out for themselves,
which is the same failure as not linking the record. If a completeness/
quality check already exists for that record type (e.g. `gapsFor(leg)`
in `travel.js`, which the trip-leg gap-review UI itself uses), reuse it
in the message instead of a raw number — "nothing required is missing"
or "2 required fields still missing" beats "6 fields" every time. Build
one if none exists yet, the same way a missing chip pattern gets built
once and reused.

**Same rule for a plain UI location, not just a record.** Text that
tells the user to go look somewhere else in the app — "see Settings",
"add one in Settings → X", "check Site health" — must be a real link,
never bare prose naming a tab or section. The mechanism already exists
and is used ~30 times over: `<span class="inline-goto-link"
data-goto-tab="settings" data-goto-target="#some-id">Settings</span>`,
bound once, document-wide, in `js/app.js` — it switches tab, opens every
collapsed `<details>` ancestor of the target (Settings' accordions are
closed by default), and scrolls/flashes it into view. Confirmed live:
`schoolcalendar.js`'s own empty-state placeholder said "See Settings →
Site health for per-site status" as bare text, no link at all, written
in the SAME session the pattern above was already being applied to
other record types — don't let "this is just a location, not a tracked
record" be the reason this gets skipped, the user should never have to
go hunting for a destination you already know the selector for.

Whenever a data record (connection, task, trip) is referenced somewhere
OTHER than its own main card/list, or a chip-shaped VALUE (City, Tag,
Nationality...) is shown away from its owning connection's card, use the
existing standard pattern below — never invent a new one.

**A connection**: `connectionChipHtml(conn, extraHtml)` +
`bindConnectionChips()` (`js/features/connections.js`) — avatar + name,
click navigates via `switchTab('dating')` → `expandConnection(id)` →
`scrollAndFlash('[data-conn-row="${id}"]')`. `extraHtml` is for a
context's own legitimate additions (a status dot, a trip-link icon) —
those sit alongside the base chip, never replace it.
*Legitimate exceptions, don't force these to the base pattern*: a
decision/disambiguation UI needing the full photo grid to visually
confirm identity (not just reference a settled record); a picker row
that *selects* rather than navigates; a plain `<select>` where the job
is genuinely "add one from a long list."

**A chip-shaped value** (City/Tag/Nationality/Milestone/...) shown away
from its owning connection: click → `filterByIds(data.connections.filter
(c => (c[field]||[]).includes(value)).map(c=>c.id), label)`
(`connections.js`) — exact match, same as Overview's own dimension
chips. **Never** `filterBySearch` — it's a cross-field substring match
over name/job/address/stage/every tag value concatenated together;
confirmed real collision risk (a City "Mallorca" vs. a Date-location
"Mallorca"). Doesn't apply on a connection's own card (nothing to filter
from there).

**A trip**: `tripChipHtml(trip, extraHtml)` + `bindTripChips()`
(`js/features/travel.js`) — plane glyph + title, click navigates via
`switchTab('travel')` → `revealTrip(id)` → `scrollAndFlash('[data-trip-
card="${id}"]')`. Mirrors `connectionChipHtml`/`bindConnectionChips`
exactly; use it for a trip referenced from Mail, Planner, or anywhere
else outside Travel's own card list — including inside a success/fail
message, per the general rule above.

**A task**: title + due badge (reuse `tasks.js`'s `dateBadgeHtml` shape,
don't reimplement it) + a link running `switchTab('tasks')` →
`revealTask(id)`. A connection's own `todos` list and Planner's
`plannerActivities`/`plannerEntries` with `kind: 'connection'` or
`kind: 'activity'` remain deliberately lighter — never created via
`captureTask`, no due/bucket/source fields; don't force those to look
like real tasks. **Exception, as of this writing**: a `plannerEntry`
with `kind: 'task'` is NOT lightweight — its `taskId` points at a real
`data.tasks` record, and it renders via the SAME `dateBadgeHtml`/
`revealTask`/`childCountHtml`/`contextChipsHtml(…, {readOnly:true})`/
`toggleTaskDone` helpers every other task surface uses (see
`js/features/planner.js`'s `taskEntryCardHtml`). Ticking it done flips
the real task's `bucket`, visible on the Tasks tab too — this is the one
planner-entry kind that is a real task, not a lighter shadow of one.

**A known value found inside free text**, offered as "click to add to a
field": the shared detector `buildFlagMatcher`/`applyFlagMatcher`
(`js/utils.js`) — if wiring up a NEW consumer of it, check whether
`bindMentionHits`-style shared click-wiring exists yet before writing a
fourth bespoke copy (as of this writing, `connections.js`,
`tinderimport.js`, `whatsappimport.js`, and `telegramimport.js` each
have their own copy — a real consolidation opportunity, not yet done).

## CSS gotchas

**`.sync-btn.sm` is `width:100%`** (`css/style.css`) — right for a
button stacked alone in a narrow card, wrong for one sitting inline in
a row next to a select/input/other button, where it stretches to fill
the whole row. Confirmed live on **at least nine** separate buttons now
(Airbnb push, shopping's "Search prices"/"Refresh"/"Paste price"/
"Want" state, book/inventory inline actions, mail-view dialog actions,
stock watch, and — the one that prompted this note —
`school-calendar-check-btn`, which rendered full-page-width in a row
with its calendar picker). **Add the `inline` class
(`.sync-btn.sm.inline{width:auto;margin-top:0;flex:0 0 auto;}`,
already defined) to any NEW `.sync-btn.sm` the moment it sits inline in
a row** — don't wait to confirm it live and add a tenth bespoke
override selector afterwards; check this BEFORE writing the markup, the
same way the record-reference tables above get checked before writing
a render function. If a button is genuinely alone/stacked in its own
card, the bare `.sm` (no `inline`) is correct and intentional — don't
add `inline` reflexively to every one.

**A full codebase sweep for this ran once** (confirmed live: ~25 missed
instances found and fixed across `js/features/*.js` and `index.html` in
one pass, after this exact bug recurred three separate times in one
session despite being documented). The check that actually finds them:
read the button's real layout context, not just its class list — a
`.sync-btn.sm` sitting in a plain `.sync-row`/flex row alongside ANY
sibling (an input, a select, another button, a status span) needs
`.inline`; one that's the only interactive child of a stacked/block
container (`.album-card`, `.tinder-candidate-row`, a lone `<td>`, a
dialog's own last row) is correct bare. `.mail-view-actions .sync-btn.sm`
already has its own scoped `width:auto` reset — don't add `.inline`
there too, it's redundant, not wrong, but a sign the context wasn't
actually checked.

**This bug class has two other, less common relatives** — both hit for
real this session, neither catchable by grepping for a class name:
- **Equal-specificity CSS ties.** Two selectors of the same specificity
  (e.g. `.cal-event-row .cal-badge` and `.cal-clean-group .cal-badge`,
  both 0,2,0) don't resolve by which one "should" win — the one later
  in the file wins, full stop, regardless of comments explaining intent
  above the one that loses. Writing an override that needs to beat an
  existing rule: either give it one more class (cheap, robust, doesn't
  depend on file position) or put it unambiguously after the rule it
  overrides — never rely on "it's defined first, that must mean it
  wins."
- **Flex `align-items` defaulting to `stretch`.** A flex row (`.sync-row`
  and friends) with no `align-items` set will stretch every child to
  match the TALLEST one on its line — invisible when all children are
  the same shape, a real visual bug the moment one child can be taller
  than its siblings (a form with several inputs that might wrap, next
  to a plain one-line badge). Set `align-items:flex-start` on any new
  flex row where that's even plausible, not just where it's already
  been seen to happen.

## When adding a brand-new file/feature

Before writing the first render function, ask: does this show a
connection, a task, a trip, a chip-shaped value, OR ANY OTHER RECORD
THIS APP TRACKS (an account, a listing, anything) more than once,
anywhere? If yes, use the matching pattern above from the start — or,
for a record type with no pattern yet, build the one canonical version
first and reuse it for every surface, present or later.

**Self-review pass, scoped to bigger changes only** — after finishing,
before calling it done, re-read this checklist against the diff, the
same way a `/code-review` or `/simplify` pass would. Trigger this when
the change is plan-mode-sized: a new file, a new UI surface that shows a
connection/task/trip/chip-value/ANY-OTHER-RECORD-TYPE in a list, card,
table row, DIAGRAM/GRAPH, **OR A STATUS/SUCCESS/ERROR MESSAGE**, or
anything that actually went through (or should have gone through)
`EnterPlanMode`. Explicitly: a diagram node counts as a "UI surface
that shows a record" just as much as a chip or a card does, and so does
a generated message string — don't let "it's a diagram, not a list" or
"it's just a toast, not a real surface" be the reason this gets skipped
again (both excuses have already happened once each). Concretely: when
a change adds or edits any `say(...)`/`status.textContent`/
`status.innerHTML`-style message that names a record, that message is
in scope for this checklist even if nothing else about the change is.
Skip the pass for a small, single-file fix, a copy/wording change with
no record reference in it, a CSS-only tweak, or a minor extension of an
already-reviewed pattern (e.g. one more field added to an existing
rename table) — running a review pass on every one-line fix is noise,
not signal, and the point is catching "invented a 5th variant instead
of reusing X," or "built a new reference surface with no link back at
all," in the cases large enough to actually risk it.

## Testing a live-site scraper directly — don't just build diagnostics and hand them back

`server/claude-test.php.example` (deployed as `claude-test.php` next to
`commands.php` on the web host) is a dedicated, isolated channel for
testing `page.render`/`page.fetch` against a real URL myself, without
routing through the user or the real dashboard queue. It has no verb
concept — the wire protocol can only ever do one thing, render a URL
and hand back the HTML:

```
POST {CLAUDE_TEST_URL}?action=enqueue   {"url": "https://..."}  -> {id}
GET  {CLAUDE_TEST_URL}?action=pending                            -> {jobs:[{id,url}]}   (the NAS agent polls this)
POST {CLAUDE_TEST_URL}?action=result&id=<id>  {ok,html,error}    (the NAS agent posts this)
GET  {CLAUDE_TEST_URL}?action=status&id=<id>                     -> {id,url,status,html,error}
```

All requests need header `X-Claude-Test-Secret: <CLAUDE_TEST_SECRET>`.
**Both values are already on disk, readable right now, at
`C:\Users\philg\OneDrive\Claude\.claude\nas-test.env`** — one directory
above this checkout (`dashboard`'s parent), NOT inside
`home-agent/.env` (that file only holds a `.example` with blanks in
this checkout). Read that file directly, then use curl: enqueue, poll
`status` every few seconds until it's `done`/`error`, read the real
HTML back. Do not ask the user for these values or claim they're
unavailable — this exact lookup has already been done before; check
the file first. This is a completely separate queue/secret from the
real dashboard (`commands.php`/`DASHBOARD_SECRET`) and from Plex/*arr
— nothing here can touch either.

**Use this instead of asking the user to relay `docker logs`, paste
page content, or manually test a URL**, whenever the question is "what
does this specific page actually render as" — that's exactly what this
channel exists for. I have repeatedly forgotten this channel exists and
defaulted to building a passive diagnostic (a byte-count note, a log
line) for the user to run and report back, when I could have queried
the real page myself in the same turn.

## Deploy ritual

Every shipped change: bump `sw.js`'s `CACHE_NAME` and `index.html`'s
build-stamp together (same number), `git add` the specific changed
files (never `git add -A` — this checkout also has unrelated untracked
scratch content), commit ending `Co-Authored-By: Claude <model>
<noreply@anthropic.com>` where `<model>` is whichever model actually
wrote the commit, `git push`. This line used to name Sonnet 5
specifically and went stale the moment a different model picked the work
up — sign as who you are, don't copy the name out of this file.

## Deploys that span machines

Three machines are in play — this PC, the web host, the QNAP — and the
commands for each are not interchangeable. Every confusion in this
project's deploys has come from a step that LOOKED like it worked:

- A `cd /share/...` run in the Code tab's Run button, which executes on
  the PC and resolves against C:.
- `docker compose up -d --build` rebuilding from files that were never
  copied to the NAS, so it cheerfully rebuilt the old image in 2s.
- A `git pull` in a folder that isn't a checkout, silenced by a
  `2>/dev/null` I had added myself.
- A commit whose `git add` quietly staged only the new files, so the
  live site stayed a version behind while the hash looked fine.
- The service worker serving cached JS, so a fix was "not working" when
  it was never loaded.
- A console snippet's `import('/js/homeagent.js')` (root-absolute),
  handed to the user to paste into the live site's console -- confirmed
  live, repeatedly: the local preview serves from `/`, so an absolute
  import path resolves and works there, but GitHub Pages serves this
  repo under its OWN path (`https://philgewhite-maker.github.io/
  dashboard/...`, not `.../...`), so the same snippet 404s on the one
  place it was actually meant to run.

So for any change touching the web host, the NAS or the agent:

**A console snippet meant for the live site imports with a RELATIVE
path** (`import('./js/homeagent.js')`), never root-absolute
(`import('/js/homeagent.js')`) -- the local preview can't tell the two
apart, so this only ever surfaces on the real deployed site, in front
of the user, which is the worst place to find out.

**Say which machine each command runs on**, before the command. "On the
NAS, over SSH" / "On your PC" / "In the browser console". A fenced block
with no owner will be run wherever the Run button points.

**List the files to copy, by source and destination path**, before the
command that consumes them. `docker compose up --build` reads whatever
is in that folder; it does not fetch anything.

**Never silence an error in a step the user runs.** No `2>/dev/null`,
no `|| true`. A step that fails silently is worse than one that stops.

**Give a check that proves the NEW thing is live**, not that something
ran: a version string the code prints, a build stamp, a string only the
new file contains. "It started" and "it started with your change in it"
are different claims, and only the second is worth making.

**Verify a deploy from outside** where it's reachable — curl the live
URL, don't trust the local tree or the commit. `git log` says what was
committed, not what is being served.
