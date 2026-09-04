# Dashboard — standing conventions

This file is loaded into every session working in this repo, unlike
`memory/*.md` notes (recalled probabilistically by relevance match, which
is why a documented convention can still get missed when heads-down on a
new feature's mechanics — confirmed live: `js/features/photoquality.js`
shipped with a bare-text connection name despite the standard below
already existing). Check this file's tables BEFORE writing any new
render function for a person, task, trip, or chip-shaped value — not
after.

## Record-reference standards

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
connection, a task, a trip, or a chip-shaped value? If yes, use the
matching pattern above from the start. After writing it, before calling
it done: re-read this checklist against the diff, the same way a
`/code-review` or `/simplify` pass would — don't rely on having kept it
in mind while deep in the feature's own mechanics.

## Deploy ritual

Every shipped change: bump `sw.js`'s `CACHE_NAME` and `index.html`'s
build-stamp together (same number), `git add` the specific changed
files (never `git add -A` — this checkout also has unrelated untracked
scratch content), commit ending `Co-Authored-By: Claude Sonnet 5
<noreply@anthropic.com>`, `git push`.
