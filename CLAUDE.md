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
`revealTask(id)`. NOT the same as a connection's own `todos` list or
Planner's `plannerActivities`/`plannerEntries` — those are deliberately
lighter, never created via `captureTask`, no due/bucket/source fields;
don't force them to look like real tasks.

**A known value found inside free text**, offered as "click to add to a
field": the shared detector `buildFlagMatcher`/`applyFlagMatcher`
(`js/utils.js`) — if wiring up a NEW consumer of it, check whether
`bindMentionHits`-style shared click-wiring exists yet before writing a
fourth bespoke copy (as of this writing, `connections.js`,
`tinderimport.js`, `whatsappimport.js`, and `telegramimport.js` each
have their own copy — a real consolidation opportunity, not yet done).

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

## Deploy ritual

Every shipped change: bump `sw.js`'s `CACHE_NAME` and `index.html`'s
build-stamp together (same number), `git add` the specific changed
files (never `git add -A` — this checkout also has unrelated untracked
scratch content), commit ending `Co-Authored-By: Claude <model>
<noreply@anthropic.com>` where `<model>` is whichever model actually
wrote the commit, `git push`. This line used to name Sonnet 5
specifically and went stale the moment a different model picked the work
up — sign as who you are, don't copy the name out of this file.
