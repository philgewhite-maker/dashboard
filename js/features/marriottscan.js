// Marriott Vacation Club -- availability + points scanner.
//
// This is the canonical copy of a DevTools console script, reverse-
// engineered live against owners.marriottvacationclub.com's "Book with
// Points" search over many iterations (see the versioned log below). It
// used to live only as a standalone file pasted by hand into the
// Console; it's now a real function in this repo so the Travel tab's
// "Copy scan script" button (js/features/marriottavailability.js) can
// bake the dashboard's own config into it via Function.prototype.
// toString() -- the same snippet-building pattern already used by
// js/retailers/agentprovocateur.js's bookmarkletSource() and copied by
// shopping.js/tinderimport.js.
//
// HARD CONSTRAINT: marriottAvailabilityScan() below must never reference
// anything at MODULE scope (an import, a sibling const, another
// function declared outside it). toString() captures only the function's
// own source text, not its closure -- a stray outer reference would
// parse fine here but throw a ReferenceError the moment it's pasted into
// Marriott's own Console, where none of this module's scope exists. Every
// helper it needs is declared INSIDE its body instead.
//
// Run it in the DevTools Console (F12 -> Console tab) on the "Book with
// Points" search page, AFTER you've picked your resort(s), same as you
// would normally. For every (night count x month) combination, it sets
// the search form's own fields and clicks Search fresh, then for every
// resort that comes back: for every room type that resort offers, reads
// which check-in dates are open and how many points each one costs --
// all read from the page's own DOM, nothing it couldn't do by hand, just
// automated. No JSON API exists on this site to call directly (confirmed
// live -- it's a server-rendered owner portal, only analytics beacons on
// the wire), so DOM reading is the real mechanism, not a shortcut. It
// runs a FULL search per month, not one search with light in-page paging
// afterward -- see the v12 entry below for why.
//
// Reverse-engineered live on 2026-10-17 against owners.marriottvacationclub
// .com's current markup. Load-bearing details, each confirmed live:
//   - The nights/guests fields are stepper inputs with NO direct typing --
//     only their own increment/decrement buttons move them.
//   - An available check-in date is <button class="day enabled">; every
//     other day (unavailable, or outside the booking window) is plain
//     <button class="day">, no "enabled" class.
//   - Each day cell also carries its own points cost, in a MISSPELLED
//     attribute the site itself uses: arial-label="Points starting at: N"
//     (not aria-label) on the .tool-tip-content wrapper around the day
//     button -- read exactly that attribute, not the day button's own
//     aria-label (which is just the date).
//   - The "Points starting at" figure on a given day is the CHEAPEST
//     room type available that day, blended across whatever's offered --
//     to get a figure for one specific room size (confirmed live: a 3
//     Bedroom at Marbella showing 900 points for 19 Nov, which the
//     blended figure alone reported as 825), the Room Type filter has to
//     actually be set to that one type first. Filtering also changes
//     WHICH days show as available -- a day with no 3BR left drops out
//     of the "enabled" set entirely when filtered to 3BR, even though a
//     cheaper room was open that day.
//   - The calendar's own "next month"/"previous month" buttons page
//     through months WITHOUT re-running the whole search -- much cheaper
//     than resubmitting Search per month, confirmed live stepping Nov to
//     Dec 2026 mid-session. (No longer used as of v12 -- see that entry
//     below for why a resort missing from the starting month's own
//     results made this mechanism fundamentally unable to find that
//     resort's later-month availability at all, not just drift-prone.)
//   - The resort NAME is a <button>, not a/h2/h3 -- v2's guess at that
//     selector silently failed on every row, which is why a real 4-resort
//     run came back as "Resort 1" for everything AND stopped after just
//     one resort (the same wrong guess was used to confirm "Back to
//     search results" landed correctly; when it silently didn't, the loop
//     had nothing left to index into and just stopped). v3 reads resort
//     names from the destination picker's own checked boxes instead --
//     captured once, before Search is ever clicked -- and checks after
//     every "back" click that the expected number of resorts is actually
//     back in view, logging loudly instead of continuing silently if not.
//   - setStepper() had a floor bug: decrementing 20 times does NOT reach
//     0/empty, it floors at 1 (can't book 0 nights/guests) -- confirmed
//     live, 7 nights came out as 8, a 2-guest default came out as 3. v4
//     reads the real floor back off the field instead of assuming it,
//     and fixes the target regardless of what that floor turns out to be.
//   - A 0-resort first page didn't mean "nothing available anywhere" --
//     it could just mean the SEARCH's own single starting month had
//     nothing. v4 now steps the top-level "Search by Month" dropdown
//     forward and re-submits Search (a different control from the
//     in-calendar "next month" button, which only works once a resort
//     card already exists to click into) before giving up on a night
//     count entirely.
//   - Reported directly: a narrowed Room Type filter (e.g. "3 Bedroom")
//     was being left applied after a resort finished scanning -- nothing
//     ever widened it back. That's not just cosmetic: it carried into
//     the NEXT resort's results, and since this filter affects what the
//     search itself returns (not just local rendering), a later run
//     that never reloaded the page could see "0 resorts" purely because
//     the previous run's leftover 3-Bedroom-only filter was still
//     active. v5 clicks "Clear Filters" after every resort finishes.
//   - Reported directly: a run searching 2-3 months from November ended
//     up searching May. Root cause -- advanceSearchMonthSelect() (the
//     "0 resorts, try a later month" retry) moves the starting month
//     forward but never moves it back, so drift from EARLIER
//     NIGHT_COUNTS iterations' own retries carried into later ones with
//     no reset in between, compounding across the whole run. v6 captures
//     the real starting month once up front and resets to it at the top
//     of every nights iteration. (The # of Nights field itself was NOT
//     the bug: it's a single shared search field, intentionally held
//     constant across every resort within one nights value's own pass --
//     seeing it "stuck" at the LAST configured value, e.g. 7, during
//     that value's own pass over every resort is expected, not drift.)
//   - Reported directly: real-world page loads are slower than this was
//     tuned for. Wait times bumped up and pulled into one
//     SPEED_MULTIPLIER, so there's a single number to turn up further if
//     v6's defaults still aren't enough on a slow connection.
//   - Reported directly: EVERY row still came back as "Resort N", not
//     occasionally -- meaning both v3 name-reading paths were failing,
//     not just the fallback. Most likely cause: the destination picker's
//     checkbox list probably only exists in the DOM while the picker is
//     visibly open, so captureSelectedResortNames() returns nothing by
//     the time you've picked resorts and gone to paste this into
//     DevTools; and the per-card fallback's `btn.closest('div')` was
//     almost certainly too shallow -- the button's own small wrapper,
//     not the card that also holds the resort's name. v8 replaces the
//     fallback with one that walks UP from the button through ancestors
//     until a real hotel-chain name (Marriott/Westin/Sheraton/Ritz-
//     Carlton/Vistana -- all seen directly in this account's own resort
//     list) turns up nearby, which doesn't depend on guessing the exact
//     nesting depth. NOTE: this round wasn't re-confirmed against a live
//     multi-resort results page -- the session kept timing out mid-
//     session and I wasn't going to log back in myself. The fix is
//     reasoned from DOM facts already confirmed earlier (the name IS a
//     <button>, the real chain names in this account's own list), not a
//     fresh end-to-end run. Worth watching the console the first time.
//   - Reported directly: only the first resort was ever actually
//     processed per nights value, and the month window kept drifting
//     all the way to May again even with v6's per-iteration reset. Both
//     trace to the SAME root cause: v3 widened findBackToResultsLink()
//     to also match bare span/div leaf nodes, a version that was never
//     itself confirmed working -- if it clicks a non-interactive element
//     instead of the real one, nothing happens, the script is stranded
//     on that resort's own calendar page, and every later step that
//     expects the search form (# of Nights, Search by Month) silently
//     can't find it there, which ALSO explains the month "drift": v6's
//     reset genuinely works, but only once it can find a page with a
//     month dropdown on it to reset. v9 tries the originally-proven
//     `a, button` substring match first, the wider span/div form only as
//     a fallback, and adds a recovery step at the top of each nights
//     iteration that tries clicking back again if the search form isn't
//     where it should be, instead of silently stalling.
//   - Reported directly: the SECOND resort still started from May 2027.
//     Same bug as the top-level Search-by-Month drift, one level down:
//     scanMonthsForward() (the IN-CALENDAR "next month" stepping) is
//     called once per ROOM TYPE within a resort, and never moved the
//     calendar back between calls -- so with more than one room type,
//     each one's scan started wherever the previous one's left off. A
//     resort with 4 room types and MONTHS_TO_SCAN=3 drifts 2 months
//     further per room type, easily reaching May within a SINGLE
//     resort, before the next one even opens (and the drift carries
//     into it too, since the in-calendar month isn't reset when a new
//     resort's "Check Availability" is clicked either). v10 has
//     scanMonthsForward() report how many "next month" clicks it made,
//     and clicks "previous month" that many times after every room
//     type's own scan finishes, before moving to the next one.
//   - Reported directly: the page's own date text ("Sat Nov 07 2026")
//     doesn't sort or filter usefully in a spreadsheet -- that's a
//     string to Excel, not a date. v11 reformats every date to ISO 8601
//     (YYYY-MM-DD) before it's ever stored, which both Excel and Sheets
//     recognise as a real date on import regardless of the
//     spreadsheet's own locale settings.
//   - Reported directly, and a real structural gap rather than a bug in
//     the v10/v9/v6 mechanics: Marriott's own results page only shows a
//     "Check Availability" card for a resort that already has SOME
//     availability in the month the search was actually run against --
//     a resort with nothing open in the starting month never gets a
//     card, meaning there was never anything to click into, meaning the
//     old design (search once, then page forward through each resort's
//     OWN calendar) could never discover that resort's later-month
//     availability either, no matter how high MONTHS_TO_SCAN was set --
//     it simply never got the chance to open that resort's calendar at
//     all. v12 restructures around this: the month loop is now the
//     OUTER one, and Search is clicked fresh for every single (nights,
//     month) combination, not once per nights value with cheap paging
//     after. Every month gets its own full, independent chance to
//     surface every resort with anything open that month; results for
//     the same resort/room type across different months are appended
//     together rather than overwritten. This also retires the whole
//     in-calendar "next month" mechanism and the drift bugs that came
//     with it (v6/v9/v10) -- there's nothing left to page through or
//     reset, since each search already targets exactly one month. The
//     real cost: MONTHS_TO_SCAN times as many full searches as before,
//     which is a genuinely slower run for the same configuration -- the
//     necessary trade for not silently missing a resort that happened
//     to be empty in whichever month was tried first.
//   - v13 (this file): also attempts to read the account's current
//     points balance off the page header/nav (readPointsBalance(),
//     scoped away from the calendar/results area on purpose -- the rest
//     of this page is full of per-day "Points starting at: N" figures,
//     and an unscoped text search for "points" + a number would collide
//     with those constantly). NOT yet confirmed live against a real
//     account -- flagged loudly in both the console output and the
//     export so a missing/wrong balance is obvious rather than silently
//     trusted. Ported from a scratchpad file into the repo so
//     the dashboard's Travel tab can generate a ready-to-paste copy with
//     its own config baked in, instead of the config being hand-edited
//     at the top of the script. NIGHT_COUNTS/GUESTS/MONTHS_TO_SCAN/
//     ROOM_TYPES/SPEED_MULTIPLIER now come in as one CONFIG argument
//     instead of being hardcoded. The CSV download and
//     window.__marriottAvailability are byte-identical to v12 -- the
//     existing Excel workflow doesn't change. Added
//     window.__marriottAvailabilityExport, which additionally records
//     exactly which months were actually searched (monthsScanned) --
//     the dashboard's importer needs this to tell "scanned, found
//     nothing" apart from "never scanned", which the CSV alone can't
//     say (a month with nothing open leaves no row at all, not a marked
//     one).
//
// If Marriott changes their page layout, the selectors below will stop
// matching -- that's expected eventually, not a bug in this script. Run
// it once watching the console output before trusting it unattended, and
// expect to need the occasional selector tweak after a site redesign. If
// it still misbehaves, the console output itself (especially any red
// error/warning lines) is the fastest way to diagnose it further --
// paste it back rather than re-describing the symptom.

import { todayStr } from '../utils.js';

const SCAN_SCRIPT_VERSION = 'v13';

// ---- Everything below this line must be self-contained -- see the
// HARD CONSTRAINT note at the top of this file. ------------------------
async function marriottAvailabilityScan(CONFIG) {
  const SCRIPT_VERSION = 'v13'; // kept as a literal, not a reference to the outer const -- toString() drops the closure
  const NIGHT_COUNTS = CONFIG.nightCounts;
  const GUESTS = CONFIG.guests; // required field -- the search silently fails its own validation without it (confirmed live)
  const MONTHS_TO_SCAN = CONFIG.monthsToScan; // TOTAL distinct months read, INCLUDING the one currently selected on the search form -- e.g. starting on November, 3 covers Nov/Dec/Jan
  const ROOM_TYPES = CONFIG.roomTypes; // null = auto-detect every room type the resort's own filter offers; or e.g. ['2 Bedroom', '3 Bedroom'] to restrict it
  const SPEED_MULTIPLIER = CONFIG.speedMultiplier;
  const WAIT_AFTER_SEARCH_MS = 4000 * SPEED_MULTIPLIER;
  const WAIT_AFTER_CHECK_AVAILABILITY_MS = 3000 * SPEED_MULTIPLIER;
  const WAIT_AFTER_BACK_MS = 2000 * SPEED_MULTIPLIER;
  const WAIT_AFTER_FILTER_APPLY_MS = 2000 * SPEED_MULTIPLIER;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Confirmed live as a real bug: driving the decrement button 20 times
  // and then clicking increment `target` times assumed decrementing
  // reaches a true empty/zero baseline -- it doesn't, it floors at 1 (you
  // can't book 0 nights or 0 guests), so every call landed ONE HIGHER
  // than asked (7 nights came out as 8, a 2-guest default came out as 3).
  // Reading the real floor back off the field after decrementing, rather
  // than assuming what it is, fixes this regardless of what that floor
  // actually turns out to be for a given field.
  function setStepper(input, target) {
    const wrap = input.closest('div');
    const [incBtn, decBtn] = [...wrap.querySelectorAll('button')];
    for (let i = 0; i < 20; i++) decBtn.click();
    const floorMatch = (input.value || '').match(/\d+/);
    const floor = floorMatch ? Number(floorMatch[0]) : 0;
    const steps = Math.max(0, target - floor);
    for (let i = 0; i < steps; i++) incBtn.click();
  }

  function findVisibleButtonByText(text) {
    return [...document.querySelectorAll('button')].find(
      (b) => b.textContent.trim() === text && b.offsetParent !== null
    );
  }

  async function dismissContractModalIfPresent() {
    await sleep(500);
    const selectAll = [...document.querySelectorAll('label, span')].find(
      (e) => e.textContent.trim() === 'Select All'
    );
    if (!selectAll) return;
    (selectAll.closest('label') || selectAll).click();
    await sleep(300);
    const modalSearch = [...document.querySelectorAll('.modal button, [role="dialog"] button')].find(
      (b) => b.textContent.trim() === 'Search'
    );
    if (modalSearch) {
      modalSearch.click();
      await sleep(1500);
    }
  }

  function findCheckAvailabilityButtons() {
    return [...document.querySelectorAll('button')].filter(
      (b) => b.textContent.trim() === 'Check Availability'
    );
  }

  // The `a, button` + substring match below is the exact form directly
  // confirmed working in live testing earlier this session (clicked it,
  // watched the page actually return to the results list). A later
  // revision widened this to also match bare span/div leaf nodes, on
  // the theory that the real text might sit inside a nested icon+label
  // structure -- that widened version was NEVER itself confirmed
  // working, and is the most likely explanation for "only the first
  // resort gets processed, every time": if it matches a non-interactive
  // element instead of the real clickable one, the click does nothing,
  // the script is left stranded on that resort's own calendar page, and
  // every subsequent step that expects the search FORM (the # of Nights
  // field, the Search by Month dropdown) silently can't find it there --
  // which is also consistent with the month-drift reappearing even after
  // v6's per-iteration reset, since that reset itself depends on finding
  // a page that's no longer there. Tries the proven form first, the
  // wider one only as a fallback.
  function findBackToResultsLink() {
    const proven = [...document.querySelectorAll('a, button')].find((e) =>
      e.textContent.trim().includes('Back to search results')
    );
    if (proven) return proven;
    return [...document.querySelectorAll('span, div')].find(
      (e) => e.children.length === 0 && e.textContent.trim().includes('Back to search results')
    );
  }

  // Reported directly: every single row still came back as "Resort N" --
  // not just occasionally, which means BOTH of v3's name-reading paths
  // were failing, not just the fallback. The real reason: the
  // destination picker's own checkbox list almost certainly only exists
  // in the DOM while the picker is visibly OPEN -- by the time you've
  // picked your resorts and gone off to paste this into DevTools, it's
  // closed, so this always returned nothing. Kept as a first preference
  // when it DOES happen to still be open, but no longer the only path.
  function captureSelectedResortNames() {
    return [...document.querySelectorAll('li label')]
      .filter((l) => l.querySelector('input[type="checkbox"]')?.checked)
      .map((l) => l.textContent.trim())
      .filter(Boolean);
  }

  // The real primary path now: walks UP from the "Check Availability"
  // button itself, one ancestor at a time, until a hotel-chain name
  // actually turns up among that ancestor's descendants. This doesn't
  // depend on knowing the card's exact nesting depth (v3's
  // `btn.closest('div')` guessed ONE level up, which was almost
  // certainly too shallow -- just the button's own small wrapper, not
  // the card that also holds the resort's name) or on the picker still
  // being open at all.
  function extractResortNameFromCard(btn) {
    const chainPattern = /Marriott|Westin|Sheraton|Ritz-Carlton|Vistana/;
    let el = btn.parentElement;
    for (let depth = 0; depth < 8 && el; depth++, el = el.parentElement) {
      const candidates = [...el.querySelectorAll('button, a, h2, h3, p, span')]
        .map((c) => c.textContent.trim())
        .filter((t) => t && t !== 'Check Availability' && chainPattern.test(t));
      if (candidates.length) return candidates[0];
    }
    return null;
  }

  // Opens the "Room Type" filter panel -- on a wide layout it's its own
  // button; on a narrower one it's behind a "Filter & Sort" button first.
  // Tries both, since which one renders depends on viewport width, not
  // anything this script controls.
  async function openRoomTypeFilterPanel() {
    const filterSort = findVisibleButtonByText('Filter & Sort');
    if (filterSort) {
      filterSort.click();
      await sleep(500);
    }
    const span = [...document.querySelectorAll('span')].find((el) => el.textContent.trim() === 'Room Type');
    const trigger = span?.closest('button, [role="button"]') || span?.closest('div');
    trigger?.click();
    await sleep(500);
  }

  // Every room-type option the panel is currently offering, each paired
  // with its own checkbox -- read fresh per resort, since what a resort
  // offers (Studio only, up to 4 Bedroom...) varies.
  function readRoomTypeOptions() {
    const labelEls = [...document.querySelectorAll('label, span, div')].filter(
      (el) => el.children.length === 0 && /bedroom|studio/i.test(el.textContent)
    );
    const seen = new Set();
    const options = [];
    labelEls.forEach((el) => {
      const text = el.textContent.trim();
      if (seen.has(text)) return;
      const checkbox =
        el.closest('label')?.querySelector('input[type="checkbox"]') ||
        el.parentElement?.querySelector('input[type="checkbox"]');
      if (!checkbox) return;
      seen.add(text);
      options.push({ label: text, checkbox });
    });
    return options;
  }

  // Sets the filter to EXACTLY one room type -- flips any checkbox whose
  // current state doesn't match what's wanted, rather than assuming a
  // fresh click always means "select" (a prior loop iteration may have
  // already ticked it).
  async function setRoomTypeFilterTo(targetLabel, options) {
    options.forEach(({ label, checkbox }) => {
      const shouldBeChecked = label === targetLabel;
      if (checkbox.checked !== shouldBeChecked) checkbox.click();
    });
    await sleep(200);
    const applyBtn = findVisibleButtonByText('Apply');
    applyBtn?.click();
    await sleep(WAIT_AFTER_FILTER_APPLY_MS);
  }

  // Reported directly as a real bug: setRoomTypeFilterTo() narrows the
  // filter but nothing ever widened it back, so the LAST room type
  // tested stayed applied -- not just for the rest of that resort's own
  // results, but carried into the next resort, and (since this filter
  // state isn't just local render state, it affects what the search
  // itself returns) potentially into the next night-count's search too,
  // which is exactly how "0 resorts" can happen on a run that should
  // have found plenty: the leftover 3-Bedroom-only filter from the
  // PREVIOUS run was still active when this one started. Uses the
  // page's own "Clear Filters" button rather than unchecking each
  // option by hand, since that resets Room Type/View/Activities/Area in
  // one go and won't go stale if this resort offers a filter this
  // script doesn't otherwise know about.
  async function clearFilters() {
    const clearBtn = findVisibleButtonByText('Clear Filters');
    if (!clearBtn) return false;
    clearBtn.click();
    await sleep(WAIT_AFTER_FILTER_APPLY_MS);
    return true;
  }

  // Reported directly: the page's own date format ("Sat Nov 07 2026")
  // doesn't sort or filter usefully in a spreadsheet -- it's text, not a
  // date, to Excel. Reads the real year/month/day back off the Date
  // object's own LOCAL getters (never .toISOString(), which converts
  // through UTC first and can silently shift the date by a day) and
  // formats as ISO 8601 (YYYY-MM-DD), which Excel/Sheets both recognise
  // as a genuine date on import -- sorts, filters and date-math
  // correctly, regardless of the spreadsheet locale's own display
  // format. Falls back to the raw label rather than silently dropping a
  // row if the page's own date text ever stops parsing cleanly.
  function isoDateFromLabel(label) {
    if (!label) return null;
    const parsed = new Date(label);
    if (Number.isNaN(parsed.getTime())) return label;
    const y = parsed.getFullYear();
    const m = String(parsed.getMonth() + 1).padStart(2, '0');
    const d = String(parsed.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // One calendar month's worth of day cells. The points figure lives in
  // a MISSPELLED "arial-label" attribute (confirmed live, the site's own
  // typo) on the tooltip wrapper around the day button, not on the day
  // button's own aria-label (which is just the date).
  function extractCurrentMonthRows() {
    return [...document.querySelectorAll('td.week-day')]
      .map((td) => {
        const dayBtn = td.querySelector('button.day');
        const tip = td.querySelector('.tool-tip-content');
        const pointsMatch = (tip?.getAttribute('arial-label') || '').match(/(\d[\d,]*)/);
        return {
          date: isoDateFromLabel(dayBtn?.getAttribute('aria-label')),
          enabled: dayBtn?.classList.contains('enabled') || false,
          points: pointsMatch ? Number(pointsMatch[1].replace(/,/g, '')) : null,
        };
      })
      .filter((r) => r.date && r.enabled);
  }

  function findMonthSelect() {
    return [...document.querySelectorAll('select')].find((s) =>
      [...s.options].some((o) => o.text.includes('Search by Month'))
    );
  }

  // Jumps the TOP-LEVEL "Search by Month" dropdown to a specific option
  // index -- a completely separate control from the in-calendar
  // "next month" button the OLD per-resort paging used to rely on.
  // Returns false once `idx` is past the last real option.
  function setMonthSelectIndex(idx) {
    const monthSel = findMonthSelect();
    if (!monthSel || idx < 0 || idx >= monthSel.options.length) return false;
    if (monthSel.selectedIndex === idx) return true;
    monthSel.selectedIndex = idx;
    monthSel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  // Turns a month <option>'s own display text (e.g. "November 2026")
  // into a 'YYYY-MM' key -- this is how the dashboard tells "scanned
  // this month, found nothing" apart from "never scanned", which the
  // CSV alone can't say (a month with nothing open leaves no row at
  // all, not a marked one).
  function monthKeyFromOptionText(text) {
    const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    const m = String(text || '').match(/(january|february|march|april|may|june|july|august|september|october|november|december)\D*(\d{4})/i);
    if (m) {
      const idx = MONTH_NAMES.indexOf(m[1].toLowerCase());
      if (idx >= 0) return `${m[2]}-${String(idx + 1).padStart(2, '0')}`;
    }
    const parsed = new Date(`1 ${text}`);
    if (!Number.isNaN(parsed.getTime())) return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}`;
    return null;
  }

  // Best-effort account points balance, read once up front -- NOT yet
  // confirmed live against a real account (see the v13 changelog entry
  // above for why). Deliberately scoped to header/nav/account-ish
  // elements only, never the plain page body, since the calendar and
  // results area are full of unrelated per-day "Points starting at: N"
  // figures that an unscoped search would pick up instead.
  function readPointsBalance() {
    const scopes = [...document.querySelectorAll('header, nav, [class*="account" i], [class*="balance" i]')];
    for (const scope of scopes) {
      const text = scope.textContent || '';
      if (!/points/i.test(text) || !/balance|available/i.test(text)) continue;
      const m = text.match(/([\d,]{3,})\s*(?:vacation club )?points?/i);
      if (m) return Number(m[1].replace(/,/g, ''));
    }
    return null;
  }

  const results = {}; // { nights: { resortName: { roomType: [{date, points}] } } }
  const monthsScannedSet = new Set();
  const pointsBalance = readPointsBalance();
  if (pointsBalance != null) {
    console.log(`Points balance read from the page header: ${pointsBalance} -- this is a BEST-EFFORT read, not yet confirmed against a real account. Check it before trusting it.`);
  } else {
    console.log('Could not find a points balance anywhere in the page header/nav (best-effort only, may just mean this layout puts it somewhere else) -- the dashboard import will show "not found this scan" rather than guess a number.');
  }

  // Whatever month is selected on the search form right now -- the fixed
  // starting point every (nights, month-offset) combination below is
  // measured from.
  const startingMonthSelect = findMonthSelect();
  const startingMonthIndex = startingMonthSelect ? startingMonthSelect.selectedIndex : -1;
  if (startingMonthSelect) {
    console.log(`Starting month: ${startingMonthSelect.options[startingMonthIndex]?.text}`);
  }

  // Reported directly as a real structural gap, not a bug in the
  // mechanics above: Marriott's results page only shows a "Check
  // Availability" card for a resort that already has SOME availability
  // in the month the search was actually run against -- a resort with
  // nothing open in the starting month never gets a card at all, which
  // means there was never anything to click into, which means the OLD
  // design (search once, then page forward through each resort's own
  // calendar via "next month") could never discover that resort's later-
  // month availability either, regardless of MONTHS_TO_SCAN -- it simply
  // never got the chance to open that resort's calendar in the first
  // place. v12 restructures around this: the month loop is now the
  // OUTER one, and the Search button is clicked fresh for every single
  // (nights, month) combination, not just once per nights value. Each
  // month gets an independent, full chance to surface every resort that
  // has anything open THAT month, and results for the same resort/room
  // type across different months are appended together rather than
  // overwritten. This also means the in-calendar "next month" paging
  // (and the whole class of drift bugs that came with it, v6/v9/v10) is
  // gone entirely -- each top-level search already targets exactly one
  // month, so there's nothing left to page through or reset. The real
  // cost: this submits MONTHS_TO_SCAN times as many searches as before
  // (one full search per month, per nights value, instead of one search
  // plus cheap in-page clicks) -- a noticeably longer run for the same
  // NIGHT_COUNTS/MONTHS_TO_SCAN, which is the necessary trade for not
  // silently missing a resort that just happened to be empty in the
  // first month tried.
  for (const nights of NIGHT_COUNTS) {
    console.log(`\n=== ${nights} night(s) ===`);
    if (!results[nights]) results[nights] = {};

    for (let monthOffset = 0; monthOffset < MONTHS_TO_SCAN; monthOffset++) {
      console.log(`\n--- Month ${monthOffset + 1} of ${MONTHS_TO_SCAN} ---`);

      let nightsInput = document.querySelector('input[placeholder="# of Nights"]');
      if (!nightsInput) {
        // Most likely explanation: the previous resort's "Back to search
        // results" click didn't actually land, so this is still that
        // resort's own calendar page, which has no # of Nights field at
        // all -- try recovering via the same link/button before giving
        // up outright, rather than silently stopping mid-run.
        console.warn('Not on the search form -- likely stranded on a resort calendar page from the previous iteration. Trying "Back to search results" to recover.');
        const recoveryLink = findBackToResultsLink();
        if (recoveryLink) {
          recoveryLink.click();
          await sleep(WAIT_AFTER_BACK_MS);
        }
        nightsInput = document.querySelector('input[placeholder="# of Nights"]');
        if (!nightsInput) {
          console.error('Still could not find the # of Nights field after attempting recovery -- stopping here. Reload the search page and re-run.');
          return;
        }
        console.log('Recovered -- back on the search form.');
      }

      if (startingMonthIndex >= 0) {
        const jumped = setMonthSelectIndex(startingMonthIndex + monthOffset);
        if (!jumped) {
          console.warn(`No month ${monthOffset + 1} of ${MONTHS_TO_SCAN} left on the search form -- stopping this night count's month sweep early.`);
          break;
        }
        const monthSel = findMonthSelect();
        const monthKey = monthKeyFromOptionText(monthSel?.options[monthSel.selectedIndex]?.text);
        if (monthKey) monthsScannedSet.add(monthKey);
      }

      setStepper(nightsInput, nights);
      await sleep(300);

      const guestsInput = document.querySelector('input[placeholder="# of Guests"]');
      if (guestsInput) {
        setStepper(guestsInput, GUESTS);
        await sleep(300);
      }

      const selectedResortNames = captureSelectedResortNames();
      if (monthOffset === 0) {
        console.log(`Selected resorts: ${selectedResortNames.join(', ') || '(none read -- name fallback will kick in)'}`);
      }

      const searchBtn = findVisibleButtonByText('Search');
      if (!searchBtn) {
        console.error('Could not find the Search button.');
        continue;
      }
      searchBtn.click();
      await sleep(WAIT_AFTER_SEARCH_MS);
      await dismissContractModalIfPresent();
      await sleep(1000);

      const resortCount = findCheckAvailabilityButtons().length;
      console.log(`Found ${resortCount} resort(s) this month.`);
      if (selectedResortNames.length && selectedResortNames.length !== resortCount) {
        console.warn(`Picked ${selectedResortNames.length} resort(s) but this month shows ${resortCount} -- could genuinely mean some have nothing open this specific month, or a name mismatch; falling back to card text per resort where needed.`);
      }
      if (resortCount === 0) {
        console.log('No resorts with availability this month -- moving to the next month.');
        continue;
      }

      for (let i = 0; i < resortCount; i++) {
        // Always re-queried, never cached across the loop -- the DOM is
        // rebuilt wholesale every time "Back to search results" fires,
        // so an index into a stale NodeList can point at nothing (or the
        // wrong resort) by the second or third iteration.
        const btn = findCheckAvailabilityButtons()[i];
        if (!btn) {
          console.error(`Expected a "Check Availability" button at position ${i + 1} of ${resortCount} but didn't find one -- stopping here rather than guessing. ${resortCount - i} resort(s) were skipped this month.`);
          break;
        }
        const resortName = selectedResortNames[i] || extractResortNameFromCard(btn) || `Resort ${i + 1}`;
        if (!results[nights][resortName]) results[nights][resortName] = {};

        // One resort's own layout quirk (a filter panel that doesn't
        // open, a calendar that doesn't render) shouldn't take the
        // whole run down with it -- log it and move on to the next
        // resort instead.
        try {
          btn.click();
          await sleep(WAIT_AFTER_CHECK_AVAILABILITY_MS);

          await openRoomTypeFilterPanel();
          const options = readRoomTypeOptions();
          const targetTypes = ROOM_TYPES || options.map((o) => o.label);
          console.log(`${resortName}: room types found -- ${options.map((o) => o.label).join(', ') || '(none -- filter panel not found)'}`);

          for (const roomType of targetTypes) {
            if (options.length) await setRoomTypeFilterTo(roomType, options);
            const rows = extractCurrentMonthRows();
            if (!results[nights][resortName][roomType]) results[nights][resortName][roomType] = [];
            results[nights][resortName][roomType].push(...rows);
            console.log(
              `  ${roomType}: ${rows.length ? rows.map((r) => `${r.date} (${r.points}pt)`).join(', ') : 'none available'}`
            );
          }

          // Leave this resort's view the way it was found -- a narrowed
          // Room Type filter is exactly what bit a real run (see the
          // comment on clearFilters() for how far that leftover state
          // actually reached).
          if (options.length) await clearFilters();
        } catch (err) {
          console.error(`${resortName}: scan failed, skipping -- ${err.message}`);
        }

        const backLink = findBackToResultsLink();
        if (backLink) {
          backLink.click();
          await sleep(WAIT_AFTER_BACK_MS);
          // Confirms the click actually landed back on the full results
          // list (not stuck on the calendar, not dropped to fewer cards)
          // before the loop trusts the next index -- this is exactly the
          // silent-failure point that truncated a 4-resort run to 1
          // before.
          const backOnTrack = findCheckAvailabilityButtons().length;
          if (backOnTrack !== resortCount) {
            console.error(`After going back from ${resortName}, expected ${resortCount} resort(s) in view but found ${backOnTrack} -- the remaining resorts this month will likely be wrong or missing.`);
          }
        } else {
          console.error(`${resortName}: couldn't find "Back to search results" -- the remaining resorts this month will be skipped.`);
          break;
        }
      }
    }
  }

  const flatRows = Object.entries(results).flatMap(([n, byResort]) =>
    Object.entries(byResort).flatMap(([resort, byRoomType]) =>
      Object.entries(byRoomType).flatMap(([roomType, rows]) =>
        rows.length
          ? rows.map((r) => ({ nights: n, resort, roomType, date: r.date, points: r.points }))
          : [{ nights: n, resort, roomType, date: '(none available)', points: '' }]
      )
    )
  );

  console.log('\n=== SUMMARY ===');
  console.table(flatRows);

  // Straight to a downloadable file -- no extra copy/paste step. Same
  // Blob + synthetic <a download> pattern as any other export-to-file
  // button, nothing exotic.
  function downloadCsv(rows, filename) {
    const headers = ['nights', 'resort', 'roomType', 'date', 'points'];
    const escapeCell = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [headers.join(','), ...rows.map((r) => headers.map((h) => escapeCell(r[h])).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  const stamp = new Date().toISOString().slice(0, 10);
  downloadCsv(flatRows, `marriott-availability-${stamp}.csv`);
  window.__marriottAvailability = results;
  window.__marriottAvailabilityExport = {
    kind: 'marriott-availability',
    scriptVersion: SCRIPT_VERSION,
    scannedAt: new Date().toISOString(),
    config: CONFIG,
    monthsScanned: [...monthsScannedSet].sort(),
    pointsBalance: pointsBalance != null ? { balance: pointsBalance, asOf: new Date().toISOString().slice(0, 10) } : null,
    results,
  };
  console.log(`Downloaded marriott-availability-${stamp}.csv. Full structured results also kept at window.__marriottAvailability if you need them in that shape instead. For the dashboard's Travel tab import, run copy(window.__marriottAvailabilityExport) and paste THAT in instead -- it also records exactly which months were scanned, which the CSV alone can't.`);
}
// ---- End of the self-contained scan function. ------------------------

// Builds a ready-to-paste Console snippet with the dashboard's own
// config baked in -- same fn.toString()-based pattern as
// js/retailers/agentprovocateur.js's bookmarkletSource(). Safe to use
// outer imports/consts here, since this function itself is never
// toString()'d, only marriottAvailabilityScan is.
function buildScanSnippet(config) {
  return `// Generated by Dashboard (Travel -> Marriott availability) on ${todayStr()}, script ${SCAN_SCRIPT_VERSION}.
// Paste this into the Console (F12) on owners.marriottvacationclub.com's
// "Book with Points" search page, after picking your resort(s) and a
// starting month, same as you'd search by hand.
(${marriottAvailabilityScan.toString()})(${JSON.stringify(config, null, 2)});
`;
}

export { SCAN_SCRIPT_VERSION, buildScanSnippet, marriottAvailabilityScan };
