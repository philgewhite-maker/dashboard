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
import { escapeHtml, uid, todayStr, dateStrAdd, daysSince, stripHtmlForExtraction } from '../utils.js';
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

function computeNotAtSchoolPeriods(extracted) {
const breakPeriods = extracted.breaks.map((b) => {
const ext = extendToWeekends(b.start, b.end);
return { label: b.label, start: ext.start, end: ext.end };
});
const covered = (dateStr) => breakPeriods.some((p) => dateStr >= p.start && dateStr <= p.end);
const inTerm = (dateStr) => extracted.termRanges.some((r) => dateStr >= r.start && dateStr <= r.end);
// Only a holiday that falls DURING term time and ISN'T already inside a
// break is worth its own entry -- one during the summer break, say, is
// already fully covered and would just be a redundant duplicate.
const holidayPeriods = (extracted.holidays || [])
.filter((h) => h.date && inTerm(h.date) && !isWeekend(h.date) && !covered(h.date))
.map((h) => ({ label: h.label || 'Public holiday', start: h.date, end: h.date }));
return mergePeriods([...breakPeriods, ...holidayPeriods]);
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
data.schoolCalendarUpdates = (data.schoolCalendarUpdates || [])
.filter((u) => u.siteKey !== site.key || u.periods.some((p) => p.pushed));
data.schoolCalendarUpdates.push({
id: uid(), siteKey: site.key, label: site.label, url: site.url,
foundAt: nowIso,
periods: periods.map((p) => ({ id: uid(), ...p, pushed: false, googleEventId: '', googleCalendarId: '' })),
});
checks[site.key] = { baselineHash: hash, lastCheckedAt: nowIso, foundYear: year };
queueSave();
return { changed: true, firstRun, periods };
}

async function runSchoolCalendarCheck({ force = false } = {}) {
for (const site of SCHOOL_CALENDAR_SITES) {
if (!force && !isDueForSite(site)) continue;
const { reportCheck } = await import('./sitehealth.js');
try {
const result = await checkSite(site, { force });
const detail = result.changed
? `${result.firstRun ? 'First run' : 'Update found'} -- ${result.periods.length} period(s), see the Family tab.`
: 'No change.';
reportCheck(`school-calendar-${site.key}`, true, detail);
} catch (err) {
console.error(`School calendar check failed (${site.label}):`, err);
reportCheck(`school-calendar-${site.key}`, false, err.message || String(err));
}
}
renderSchoolCalendar();
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
await runSchoolCalendarCheck({ force: true });
}

// ---- Dashboard rendering (Family tab) ----------------------------------

function periodRowHtml(update, period) {
return `<div class="sync-row" style="margin:4px 0;flex-wrap:wrap;">
<span class="settings-note" style="margin:0;min-width:140px;">${escapeHtml(period.label)}</span>
<span style="font-variant-numeric:tabular-nums;">${escapeHtml(period.start)} &rarr; ${escapeHtml(period.end)}</span>
${period.pushed
? '<span class="settings-note" style="margin:0;">Pushed &#10003;</span>'
: `<button class="sync-btn sm inline" type="button" data-school-push="${update.id}:${period.id}">Push</button>`}
</div>`;
}

function updateHtml(update) {
return `<div class="cal-row" data-school-update="${update.id}">
<div class="cal-head">
<span class="cal-name">${escapeHtml(update.label)}</span>
<a href="${escapeHtml(update.url)}" target="_blank" rel="noopener" class="settings-note" style="margin:0;">View page</a>
</div>
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
}

async function pushPeriodToCalendar(updateId, periodId) {
const update = (data.schoolCalendarUpdates || []).find((u) => u.id === updateId);
const period = update && update.periods.find((p) => p.id === periodId);
const statusEl = document.getElementById('school-calendar-status');
const say = (t) => { if (statusEl) statusEl.textContent = t; };
if (!update || !period) return;
if (!(await canAttemptGoogleAction())) { say('Sign in to Google at the top of Overview first.'); return; }
if (!hasCalendarWrite()) { say('Turn on "Allow creating events in Google Calendar" in Settings, then sign out and back in.'); return; }
const calendarId = data.prefs.schoolCalendarId;
if (!calendarId) { say('Pick a calendar above first.'); return; }
say('Pushing…');
try {
const { createEvent } = await import('../googlecalendar.js');
const created = await createEvent(calendarId, {
title: `${update.label} — not at school (${period.label})`,
description: `Source: ${update.url}`,
date: period.start,
// All-day events' end is EXCLUSIVE (googlecalendar.js's own
// createEvent comment) -- period.end is the last INCLUSIVE day off,
// so it needs bumping one day forward, same convention every other
// all-day push in this app already follows.
endDate: dateStrAdd(period.end, 1),
});
period.pushed = true;
period.googleEventId = created.id;
period.googleCalendarId = calendarId;
queueSave();
renderSchoolCalendar();
say('Pushed.');
} catch (err) {
say(`Couldn't push: ${err.message || err}`);
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
select.innerHTML = cals.length
? cals.map((c) => `<option value="${escapeHtml(c.id)}"${c.id === previous ? ' selected' : ''}>${escapeHtml(c.summary)}</option>`).join('')
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
await forceSchoolCalendarCheck();
if (status) status.textContent = 'Done.';
});
}

export { runSchoolCalendarCheck, forceSchoolCalendarCheck, renderSchoolCalendar, initSchoolCalendar, computeNotAtSchoolPeriods, hashText };
