// Weekly, no-AI watch for the three school/university term-date pages
// (Charlotte/Zara/Lewis -- state.js's SCHOOL_CALENDAR_SITES), registered
// into scheduled.js exactly like mediarecs.js's own monthly check: a
// function task with its own internal staleness gate, not that file's
// ordinary hours-scale cadence.
//
// The weekly check itself is a plain content hash -- deliberately no AI,
// since it runs every time the app is opened (gated to roughly once a
// week per site, 1 May through whenever that year's change is found)
// and finds nothing almost every time. AI only enters once a real
// year-over-year change is actually detected (a handful of calls total
// per year, see ai.js's extractSchoolCalendar), to turn that site's own
// messy real-world text into structured term/break dates -- the three
// pages are genuinely different shapes (loose prose with a typo'd
// ordinal, a clean HTML table, prose plus a closures list), which is
// exactly the kind of varied real-world content a hand-rolled regex
// parser per site would be the wrong, fragile tool for.
import { data, queueSave, SCHOOL_CALENDAR_SITES } from '../state.js';
import { escapeHtml, uid, todayStr, dateStrAdd, daysSince, stripHtmlForExtraction, MISSING_KEY_LINK_HTML } from '../utils.js';
import { fetchPageHtml } from '../files.js';
import { canAttemptGoogleAction, hasCalendarWrite } from '../sync/googleauth.js';

const CHECK_INTERVAL_DAYS = 7;

// A cheap, deterministic digest -- djb2, the smallest well-known string
// hash that's good enough here: this only ever needs to answer "did the
// page's own text change at all since last year," nothing more.
function hashText(text) {
let h = 5381;
const s = String(text || '');
for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
return h.toString(36);
}

function checksStore() {
if (!data.prefs.schoolCalendarChecks || typeof data.prefs.schoolCalendarChecks !== 'object') data.prefs.schoolCalendarChecks = {};
return data.prefs.schoolCalendarChecks;
}

// Weekly, but only 1 May through whenever THIS year's change is found --
// before 1 May there's nothing new to expect yet, and once found there's
// nothing left to watch for until next year's own 1 May naturally resets
// foundYear (it stops matching the new current year).
function isDueForSite(site) {
const today = todayStr();
const year = Number(today.slice(0, 4));
if (today < `${year}-05-01`) return false;
const st = checksStore()[site.key];
if (st && st.foundYear === year) return false;
if (st && st.lastCheckedAt && daysSince(st.lastCheckedAt) < CHECK_INTERVAL_DAYS) return false;
return true;
}

async function fetchSiteText(site) {
const html = await fetchPageHtml(site.url);
return stripHtmlForExtraction(html);
}

// ---- Public holidays -------------------------------------------------

async function fetchNagerHolidays(countryCode, year) {
const res = await fetch(`https://date.nager.at/api/v3/publicholidays/${year}/${countryCode}`);
if (!res.ok) throw new Error(`Nager.Date ${res.status}`);
const items = await res.json();
return items.map((h) => ({ label: h.localName || h.name, date: h.date }));
}

// Not year-scoped (one feed, several years) -- fetched once and cached
// for the life of this module rather than re-fetched per site/year.
let govUkHolidaysCache = null;
async function fetchGovUkHolidays(division) {
if (!govUkHolidaysCache) {
const res = await fetch('https://www.gov.uk/bank-holidays.json');
if (!res.ok) throw new Error(`gov.uk bank holidays ${res.status}`);
govUkHolidaysCache = await res.json();
}
const events = (govUkHolidaysCache[division] && govUkHolidaysCache[division].events) || [];
return events.map((e) => ({ label: e.title, date: e.date }));
}

// Holidays for whichever calendar years a site's own term ranges
// actually touch -- an academic year usually crosses a calendar year
// boundary, so this asks for every distinct year rather than assuming
// one. 'own-page' sites (UNBC, which already lists BC's own statutory
// holidays directly) use nothing but what the AI extraction already
// found on the page itself -- no external call at all.
async function holidaysForSite(site, extracted) {
if (site.holidaySource === 'own-page') return extracted.holidays;
const years = new Set();
extracted.termRanges.forEach((r) => { years.add(r.start.slice(0, 4)); years.add(r.end.slice(0, 4)); });
if (!years.size) return extracted.holidays;
const [kind, region] = site.holidaySource.split(':');
const all = [];
for (const year of years) {
if (kind === 'nager') all.push(...await fetchNagerHolidays(region, year));
else if (kind === 'govuk') all.push(...await fetchGovUkHolidays(region));
}
// De-dup by date -- gov.uk's own feed isn't year-scoped, so a term
// span touching 3 calendar years would otherwise fetch (and merge in)
// the same identical full feed three times over.
const seen = new Set();
return [...extracted.holidays, ...all].filter((h) => {
if (!h.date || seen.has(h.date)) return false;
seen.add(h.date);
return true;
});
}

// ---- Not-at-school computation (deterministic, after extraction) -----

function isWeekend(dateStr) {
const day = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
return day === 0 || day === 6;
}

// A break given as "Mon-Fri" still means the adjoining weekend is ALSO
// not school -- walks outward from each end while the next day out is
// still a weekend day, absorbing it.
function extendToWeekends(start, end) {
let s = start;
while (isWeekend(dateStrAdd(s, -1))) s = dateStrAdd(s, -1);
let e = end;
while (isWeekend(dateStrAdd(e, 1))) e = dateStrAdd(e, 1);
return { start: s, end: e };
}

// Touching or overlapping periods (a weekend-extended break meeting an
// adjacent single-day holiday, say) collapse into one rather than
// showing as two adjacent calendar entries for what's really one block.
function mergePeriods(periods) {
const sorted = periods.slice().sort((a, b) => a.start.localeCompare(b.start));
const merged = [];
sorted.forEach((p) => {
const last = merged[merged.length - 1];
if (last && p.start <= dateStrAdd(last.end, 1)) {
if (p.end > last.end) last.end = p.end;
} else {
merged.push({ ...p });
}
});
return merged;
}

// Collapses touching/overlapping termRanges into one continuous
// "enrolled" span each -- the same operation mergePeriods does, kept
// separate because this one feeds computeTermGaps below rather than
// the final period list, and termRanges (unlike breaks/holidays) carry
// no label worth preserving on a merge.
function mergedTermSpans(termRanges) {
const plain = (termRanges || []).map((r) => ({ start: r.start, end: r.end, label: '' }));
return mergePeriods(plain);
}

// The time BETWEEN two consecutive terms is not-at-school whether or
// not the page itself named it as a break -- confirmed live as a real
// gap, not just a defensive fallback: Lewis's own page names only its
// office closures (far narrower than the actual student gap between
// terms), and UNBC's page states a "Winter Break" window that starts
// three days after the real last exam. Computed purely from the
// extracted term boundaries, so a page whose named breaks already
// cover the full gap just produces an exact duplicate that mergePeriods
// (in the caller) collapses away for free.
function computeTermGaps(spans) {
const gaps = [];
for (let i = 1; i < spans.length; i++) {
const start = dateStrAdd(spans[i - 1].end, 1);
const end = dateStrAdd(spans[i].start, -1);
if (start <= end) gaps.push({ label: 'Break', start, end });
}
return gaps;
}

function computeNotAtSchoolPeriods(extracted) {
const breakPeriods = extracted.breaks.map((b) => {
const ext = extendToWeekends(b.start, b.end);
return { label: b.label, start: ext.start, end: ext.end };
});
const termRanges = extracted.termRanges || [];
const spans = mergedTermSpans(termRanges);
// Gaps are computed from the term boundaries themselves, not run
// through extendToWeekends -- a gap's own start/end already sit
// exactly one day past the real last/next term day, so extending it
// further out would eat into real term time instead of a weekend.
const gapPeriods = computeTermGaps(spans);
const covered = (dateStr) => [...breakPeriods, ...gapPeriods].some((p) => dateStr >= p.start && dateStr <= p.end);
const inTerm = (dateStr) => termRanges.some((r) => dateStr >= r.start && dateStr <= r.end);
// Only a holiday that falls DURING term time and ISN'T already inside a
// break is worth its own entry -- one during the summer break, say, is
// already fully covered and would just be a redundant duplicate.
// Weekend-extended same as breaks -- a Friday holiday and the following
// Monday holiday (Good Friday/Easter Monday, say) are two single dates
// three days apart, but the weekend between them is non-school time
// regardless, so without this they'd show as two separate 1-day pushes
// either side of a weekend mergePeriods has no reason to bridge. This
// is the app's own job, not the AI's -- ai.js's own holidays
// instruction already says each one is a single stated date; widening
// it into a real multi-day block happens here, deterministically.
const holidayPeriods = (extracted.holidays || [])
.filter((h) => h.date && inTerm(h.date) && !isWeekend(h.date) && !covered(h.date))
.map((h) => {
const ext = extendToWeekends(h.date, h.date);
return { label: h.label || 'Public holiday', start: ext.start, end: ext.end };
});
const closed = mergePeriods([...breakPeriods, ...gapPeriods, ...holidayPeriods]);
// The run of terms has to end somewhere, but next year's own first
// day isn't known yet -- rather than silently stopping at the last
// term's own end date (which reads as "nothing after this," not "we
// don't know yet"), this adds an explicit, open-ended marker the user
// can push now and update once the school/uni publishes next year's
// dates. No `end` -- periodRowHtml and the push handler both treat a
// blank end as "TBC", not a date to compute with.
const openEnded = spans.length
? [{ label: 'First day of summer break, end TBC', start: dateStrAdd(spans[spans.length - 1].end, 1), end: '' }]
: [];
return [...closed, ...openEnded];
}

// ---- Running the check -------------------------------------------------

async function checkSite(site, { force = false } = {}) {
const text = await fetchSiteText(site);
const hash = hashText(text);
const checks = checksStore();
const st = checks[site.key] || {};
const nowIso = new Date().toISOString();
const year = Number(todayStr().slice(0, 4));
const firstRun = !st.baselineHash;
if (!force && !firstRun && st.baselineHash === hash) {
checks[site.key] = { ...st, lastCheckedAt: nowIso };
queueSave();
return { changed: false };
}
// Either a genuine year-over-year change, OR the very first run ever
// (nothing to compare against yet) -- confirmed live this needs to
// extract on first run too, not just silently seed a hash: with
// nothing else to show, "run it now as the baseline" would otherwise
// leave nothing to actually review or push on that very first check.
// AI only ever runs here, never in the weekly no-op gate above.
const { extractSchoolCalendar } = await import('../ai.js');
const extracted = await extractSchoolCalendar(text, site.guidance || `${site.label}'s term-dates page.`);
const holidays = await holidaysForSite(site, extracted);
const periods = computeNotAtSchoolPeriods({ ...extracted, holidays });
// A re-check (force, or next year's genuine change) supersedes this
// site's own prior entry rather than stacking a second one alongside
// it -- but only when nothing in that prior entry was actually pushed
// to a calendar yet; one with real pushed events stays, since that's a
// record of something that actually happened, not just a stale guess.
// An earlier update only stays when it holds a pushed period the new
// result does NOT repeat (same dates). A pushed period the new result
// does repeat is carried over as already pushed, with its event id, so
// pressing Check now after pushing never leaves the same dates twice.
const sameDates = (a, b) => a.start === b.start && (a.end || '') === (b.end || '');
const pushedBefore = (data.schoolCalendarUpdates || []).filter((u) => u.siteKey === site.key).flatMap((u) => u.periods.filter((p) => p.pushed));
data.schoolCalendarUpdates = (data.schoolCalendarUpdates || [])
.filter((u) => u.siteKey !== site.key || u.periods.some((p) => p.pushed && !periods.some((n) => sameDates(n, p))));
data.schoolCalendarUpdates.push({
id: uid(), siteKey: site.key, label: site.label, url: site.url,
calendarPrefix: site.calendarPrefix || site.label,
foundAt: nowIso,
// Shown in the Family tab panel, not just logged -- both so the user
// can sanity-check what the AI actually read as "the terms" before
// trusting the computed periods below it, and because three rounds of
// "still wrong" couldn't be diagnosed any further from the computed
// output alone (no way to tell an empty extraction from a term span
// that just didn't produce any additional not-at-school period).
termRanges: extracted.termRanges,
periods: periods.map((p) => {
const done = pushedBefore.find((o) => sameDates(o, p));
return { id: uid(), ...p, pushed: !!done, googleEventId: done ? done.googleEventId : '', googleCalendarId: done ? done.googleCalendarId : '' };
}),
});
checks[site.key] = { baselineHash: hash, lastCheckedAt: nowIso, foundYear: year };
queueSave();
return { changed: true, firstRun, periods };
}

// Returns one result per site that was actually checked --
// {label, state: 'changed' | 'unchanged' | 'failed', periods?, error?,
// missingKey?} -- so "Check now" can say what really happened instead
// of a blanket "Done." (the weekly background run ignores the return).
async function runSchoolCalendarCheck({ force = false } = {}) {
const results = [];
for (const site of SCHOOL_CALENDAR_SITES) {
if (!force && !isDueForSite(site)) continue;
const { reportCheck } = await import('./sitehealth.js');
try {
const result = await checkSite(site, { force });
const detail = result.changed
? `${result.firstRun ? 'First run' : 'Update found'} -- ${result.periods.length} period(s), see the Family tab.`
: 'No change.';
reportCheck(`school-calendar-${site.key}`, true, detail);
results.push({ label: site.label, state: result.changed ? 'changed' : 'unchanged', periods: result.periods ? result.periods.length : 0 });
} catch (err) {
console.error(`School calendar check failed (${site.label}):`, err);
reportCheck(`school-calendar-${site.key}`, false, err.message || String(err));
results.push({ label: site.label, state: 'failed', error: err.message || String(err), missingKey: err.name === 'MissingKeyError' });
}
}
renderSchoolCalendar();
return results;
}

// One line per checked school, as HTML (a missing key links to Settings).
function checkSummaryHtml(results) {
if (!results.length) return 'Nothing to check.';
return results.map((r) => {
if (r.state === 'failed') return `${escapeHtml(r.label)}: failed &mdash; ${r.missingKey ? `needs your Anthropic key in ${MISSING_KEY_LINK_HTML}` : escapeHtml(r.error)}`;
if (r.state === 'changed') return `${escapeHtml(r.label)}: ${r.periods} period${r.periods === 1 ? '' : 's'} found`;
return `${escapeHtml(r.label)}: no change`;
}).join(' &middot; ');
}

// "Check now" is a rare, explicit, human-triggered click, not the
// automatic weekly background run -- so it bypasses BOTH of that run's
// gates, not just the interval one: isDueForSite's own-year "already
// found" lock (confirmed live as the actual cause of "Check now" ->
// nothing: a stale foundYear from an earlier run, before this fix
// existed, meant isDueForSite always skipped the site, so checkSite was
// never even called) AND the content-hash short-circuit inside
// checkSite (otherwise a genuinely-unchanged site would still show
// nothing on a manual click, which defeats the entire point of a button
// whose job is "show me the current state right now").
async function forceSchoolCalendarCheck() {
return runSchoolCalendarCheck({ force: true });
}

// ---- Dashboard rendering (Family tab) ----------------------------------

function periodRowHtml(update, period) {
return `<div class="sync-row" style="margin:4px 0;flex-wrap:wrap;">
<span class="settings-note" style="margin:0;min-width:140px;">${escapeHtml(period.label)}</span>
<span style="font-variant-numeric:tabular-nums;">${escapeHtml(period.start)} &rarr; ${period.end ? escapeHtml(period.end) : 'end TBC'}</span>
${period.pushed
? `<span class="settings-note" style="margin:0;">Pushed &#10003;</span>${period.googleEventId ? `<button class="sync-btn sm inline" type="button" data-school-unpush="${update.id}:${period.id}" title="Delete the event this created in Google Calendar">Remove from calendar</button>` : ''}`
: `${period.end ? '' : `<input type="date" min="${escapeHtml(period.start)}" data-school-end="${update.id}:${period.id}" title="Set the real last day of the break (once the school publishes it) before pushing, or push as a one-day marker" style="width:auto;">`}<button class="sync-btn sm inline" type="button" data-school-push="${update.id}:${period.id}">Push</button>`}
</div>`;
}

function termRangesLineHtml(update) {
const ranges = update.termRanges || [];
// Shown plainly, not tucked in a details/debug block -- it's as much
// "does this look right before I push it" context for the user as it
// is a way to tell an AI miss apart from a term that genuinely has no
// further not-at-school period in it.
const text = ranges.length
? ranges.map((r) => `${escapeHtml(r.start)} &rarr; ${escapeHtml(r.end)}`).join(' &nbsp;&middot;&nbsp; ')
: 'none found -- the page may need its own extraction guidance adjusted (js/state.js SCHOOL_CALENDAR_SITES)';
return `<div class="settings-note" style="margin:2px 0 6px;">Term dates read: ${text}</div>`;
}

function updateHtml(update) {
return `<div class="cal-row" data-school-update="${update.id}">
<div class="cal-head">
<span class="cal-name">${escapeHtml(update.label)}</span>
<a href="${escapeHtml(update.url)}" target="_blank" rel="noopener" class="settings-note" style="margin:0;">View page</a>
<button class="sync-btn sm inline" type="button" data-school-dismiss="${update.id}" title="Remove this result from the list (events already pushed stay on your calendar)">Dismiss</button>
</div>
${termRangesLineHtml(update)}
${update.periods.map((p) => periodRowHtml(update, p)).join('')}
</div>`;
}

function renderSchoolCalendar() {
const el = document.getElementById('school-calendar-list');
if (!el) return;
const updates = data.schoolCalendarUpdates || [];
el.innerHTML = updates.length
? updates.map(updateHtml).join('')
: '<div class="settings-note" style="margin:0;">No changes detected yet -- checked weekly from 1 May each year, no AI involved unless one actually is. Per-site status: <span class="inline-goto-link" data-goto-tab="settings" data-goto-target="#site-health-row-school-calendar-charlotte">Site health</span>.</div>';
el.querySelectorAll('[data-school-push]').forEach((btn) => {
btn.addEventListener('click', () => {
const sep = btn.dataset.schoolPush.indexOf(':');
pushPeriodToCalendar(btn.dataset.schoolPush.slice(0, sep), btn.dataset.schoolPush.slice(sep + 1));
});
});
const findPeriod = (key) => {
const sep = key.indexOf(':');
const update = (data.schoolCalendarUpdates || []).find((u) => u.id === key.slice(0, sep));
const period = update && update.periods.find((p) => p.id === key.slice(sep + 1));
return { update, period };
};
// The open-ended "first day of summer break" marker gets its real last
// day once the school publishes it; the ", end TBC" in its title goes
// with it so the pushed event reads as the break it is.
el.querySelectorAll('[data-school-end]').forEach((input) => {
input.addEventListener('change', () => {
const { period } = findPeriod(input.dataset.schoolEnd);
if (!period || !input.value || input.value < period.start) return;
period.end = input.value;
period.label = period.label.replace(/,?\s*end TBC$/i, '');
queueSave();
renderSchoolCalendar();
});
});
el.querySelectorAll('[data-school-dismiss]').forEach((btn) => {
btn.addEventListener('click', () => {
const update = (data.schoolCalendarUpdates || []).find((u) => u.id === btn.dataset.schoolDismiss);
if (!update) return;
const pushed = update.periods.filter((p) => p.pushed).length;
if (!confirm(`Remove ${update.label}'s result from this list?${pushed ? ` The ${pushed} event${pushed === 1 ? '' : 's'} already pushed stay on your calendar.` : ''} Press Check now to read the page again.`)) return;
data.schoolCalendarUpdates = data.schoolCalendarUpdates.filter((u) => u.id !== update.id);
queueSave();
renderSchoolCalendar();
});
});
el.querySelectorAll('[data-school-unpush]').forEach((btn) => {
btn.addEventListener('click', async () => {
const { update, period } = findPeriod(btn.dataset.schoolUnpush);
if (!update || !period) return;
const statusEl = document.getElementById('school-calendar-status');
const say = (html) => { if (statusEl) statusEl.innerHTML = html; };
if (!confirm(`Delete "${period.label}" (${period.start}) from your Google Calendar?`)) return;
if (!(await canAttemptGoogleAction())) { say(SIGN_IN_HTML); return; }
if (!hasCalendarWrite()) { say(WRITE_ON_HTML); return; }
say('Removing…');
try {
const { deleteEvent } = await import('../googlecalendar.js');
await deleteEvent(period.googleCalendarId || data.prefs.schoolCalendarId, period.googleEventId);
period.pushed = false;
period.googleEventId = '';
period.googleCalendarId = '';
queueSave();
renderSchoolCalendar();
say('Removed from your calendar.');
} catch (err) {
say(`Couldn't remove it: ${escapeHtml(err.message || String(err))}`);
}
});
});
}

// Shared "go and fix it" messages for the Push/Remove buttons -- the
// places they name are real links, not plain text.
const SIGN_IN_HTML = 'Sign in to Google first: <span class="inline-goto-link" data-goto-tab="overview" data-goto-target="#google-bar">Google sign-in</span> (top of Overview).';
const WRITE_ON_HTML = 'Turn on <span class="inline-goto-link" data-goto-tab="settings" data-goto-target="#calendar-write-toggle">Allow creating events in Google Calendar</span> in Settings, then sign out and back in.';

async function pushPeriodToCalendar(updateId, periodId) {
const update = (data.schoolCalendarUpdates || []).find((u) => u.id === updateId);
const period = update && update.periods.find((p) => p.id === periodId);
const statusEl = document.getElementById('school-calendar-status');
const say = (html) => { if (statusEl) statusEl.innerHTML = html; };
if (!update || !period) return;
if (!(await canAttemptGoogleAction())) { say(SIGN_IN_HTML); return; }
if (!hasCalendarWrite()) { say(WRITE_ON_HTML); return; }
const calendarId = data.prefs.schoolCalendarId || document.getElementById('school-calendar-picker')?.value;
if (!calendarId) { say('Pick a <span class="inline-goto-link" data-goto-tab="family" data-goto-target="#school-calendar-picker">calendar</span> to push to first.'); return; }
say('Pushing…');
try {
const { createEvent } = await import('../googlecalendar.js');
// An open-ended period (no period.end -- the run after the last known
// term, before next year's dates are published) pushes as a single-day
// marker on its start date instead of a range: omitting endDate makes
// createEvent default end to date itself (see its own eventBody
// comment), which is the only sensible all-day shape for "starts here,
// end not yet known" -- a fake far-future end date would misrepresent
// it as a real, bounded break.
const prefix = update.calendarPrefix || update.label;
const created = await createEvent(calendarId, {
title: `${prefix}: ${period.label}`,
description: `Source: ${update.url}`,
date: period.start,
// All-day events' end is EXCLUSIVE (googlecalendar.js's own
// createEvent comment) -- period.end is the last INCLUSIVE day off,
// so it needs bumping one day forward, same convention every other
// all-day push in this app already follows.
...(period.end ? { endDate: dateStrAdd(period.end, 1) } : {}),
});
period.pushed = true;
period.googleEventId = created.id;
period.googleCalendarId = calendarId;
queueSave();
renderSchoolCalendar();
say('Pushed.');
} catch (err) {
say(`Couldn't push: ${escapeHtml(err.message || String(err))}`);
}
}

async function loadSchoolCalendarOptions() {
const select = document.getElementById('school-calendar-picker');
if (!select) return;
if (!(await canAttemptGoogleAction().catch(() => false))) return;
try {
const { listCalendars } = await import('../googlecalendar.js');
const cals = await listCalendars();
const previous = data.prefs.schoolCalendarId;
// A blank first option stays selected until a calendar is really
// chosen, so what the box shows is always what Push will use.
select.innerHTML = cals.length
? `<option value=""${cals.some((c) => c.id === previous) ? '' : ' selected'}>Choose a calendar&hellip;</option>`
+ cals.map((c) => `<option value="${escapeHtml(c.id)}"${c.id === previous ? ' selected' : ''}>${escapeHtml(c.summary)}</option>`).join('')
: '<option value="">No calendars found</option>';
} catch (err) {
console.error('Could not load calendars for the school-calendar push:', err);
}
}

function initSchoolCalendar() {
renderSchoolCalendar();
loadSchoolCalendarOptions();
const picker = document.getElementById('school-calendar-picker');
if (picker) picker.addEventListener('change', () => { data.prefs.schoolCalendarId = picker.value; queueSave(); });
const checkBtn = document.getElementById('school-calendar-check-btn');
if (checkBtn) checkBtn.addEventListener('click', async () => {
const status = document.getElementById('school-calendar-status');
if (status) status.textContent = 'Checking…';
const results = await forceSchoolCalendarCheck();
if (status) status.innerHTML = checkSummaryHtml(results);
});
}

export { runSchoolCalendarCheck, forceSchoolCalendarCheck, renderSchoolCalendar, initSchoolCalendar, computeNotAtSchoolPeriods, hashText, fetchGovUkHolidays };
