// A registry of "does this NAS-browser fetch still work" canaries.
//
// This is the general version of a failure mode this project kept
// hitting case by case: Agent Provocateur served a stripped page to a
// plain fetch with no error at all; Cloudflare quietly substituted a
// challenge page for the real one; a guessed filter key silently
// returned the unfiltered list instead of erroring, five different
// times, before the real one was found. None of those failed loudly --
// each one returned SOMETHING, and only actually comparing it to what
// was expected ever caught it, by hand, after the fact. A scheduled
// task built on a fetch like that inherits the same risk every time, so
// this gives every one of them a place to report in rather than failing
// silently into its own corner the way each of the above did before it
// was caught.
//
// WIRING A NEW CHECK IN:
//   - A check with its own natural trigger already (cashback-quidco,
//     cashback-topcashback -- these run as part of every stock check,
//     see cashback.js) just calls reportCheck(id, ok, detail) from
//     wherever that fetch already happens. No entry in runAllChecks.
//   - A check with no natural trigger gets a `run()` here and is picked
//     up automatically, about once a week, by runAllChecks() -- which
//     this app's one `site-health` scheduled task (scheduled.js) already
//     calls at ordinary app-open/tab-return cadence. Each check gates
//     its OWN staleness inside runAllChecks, so the outer call can
//     happen far more often than weekly without re-running anything
//     early.
//   - An idea with no implementation yet still gets an entry, with
//     `run: null` and no reportCheck call anywhere -- shown as "Not
//     implemented" rather than omitted, so this list is also the TODO
//     for it, not just a status board for what already exists.
import { data, queueSave } from '../state.js';

const WEEK_MS = 7 * 24 * 3600000;

const CHECKS = [
{
id: 'ap-colours', label: 'Agent Provocateur — colour filter', site: 'agentprovocateur.com',
note: 'Re-runs the exact filters.colour_filter=Black query the set finder uses and confirms every result that comes back is genuinely black. Catches the filter silently reverting to the unfiltered list, the way 5 other guessed keys already did before the real one was found this session.',
weekly: true,
run: runApColoursCheck,
},
{
id: 'cashback-quidco', label: 'Quidco — cashback rate', site: 'quidco.com',
note: 'Reported by refreshCashbackRates() (stockwatch.js) whenever a stock check refreshes rates -- nothing runs from here, this only shows the last result.',
run: null, reportedExternally: true,
},
{
id: 'cashback-topcashback', label: 'TopCashback — cashback rate', site: 'topcashback.co.uk',
note: 'Same as Quidco above -- reported by refreshCashbackRates(), shown here, not run from here.',
run: null, reportedExternally: true,
},
{
id: 'mse-bank-switch', label: 'MoneySavingExpert — bank switch offers', site: 'moneysavingexpert.com',
note: 'Reported by runAutomaticSwitchCheck() / the "Check via home agent" button (switchoffers.js) whenever the home-agent page.render fetch runs -- nothing runs from here, this only shows the last result. Same shape as the two cashback checks above.',
run: null, reportedExternally: true,
},
{
id: 'health-sync', label: 'Life Dashboard — health sync', site: 'health.php (your own server)',
note: 'Checks that the bridge app on your phone has actually posted something recently, not just that health.php answers -- a stale feed still returns 200 OK on every GET, which is exactly how the Sept 16 gap went unnoticed for weeks. Also reported straight from Settings → Health data and the Health tab\'s "Sync & parse" (health.js) whenever either actually runs, so this reflects the real last-known state rather than waiting for its own weekly sweep.',
run: runHealthSyncCheck,
},
// Four more below, added on a deliberate sweep for "things this app
// depends on staying the same shape that we don't control" -- each one
// a page/endpoint this codebase has already been burned by going quiet
// (see this file's own header), just not yet given a place to report
// in. All four are reportedExternally: each already has a real trigger
// of its own (the ticker refreshing, a Switch-opportunities button),
// so this wires INTO that existing fetch rather than adding a second
// one that would just be asking the same question twice.
{
id: 'sonia-swap-feed', label: 'Chatham — 2y SONIA swap feed', site: 'cf.com (Chatham Financial)',
note: 'Reported by fetchSonia() (ticker.js) on every ticker refresh -- an undocumented JSON endpoint behind Cloudflare, parsed by picking out the 24-month tenor by name; either the tenor list or the field names changing would silently break the Overview tile otherwise.',
run: null, reportedExternally: true,
},
{
id: 'yahoo-finance-quote', label: 'Yahoo Finance — chart endpoint', site: 'query1.finance.yahoo.com',
note: 'Reported by fetchQuote() (ticker.js) whenever a share/commodity ticker tile refreshes -- an unofficial endpoint (no public contract) also used for the DBK share-scheme pricing. Yahoo has changed this shape before with no notice.',
run: null, reportedExternally: true,
},
{
id: 'cass-participant-list', label: 'Current Account Switch Service — participant list', site: 'currentaccountswitch.co.uk',
note: 'Reported by fetchCassParticipants() (switchoffers.js) whenever the cached list goes stale (every 90 days) and gets re-fetched. Deterministic name-matching against this list is what the user explicitly asked for instead of an AI guess, so a change to this page\'s own markup (the .accordion__item class, its data-value attribute) would quietly make every CASS-eligibility answer wrong rather than fail loudly.',
run: null, reportedExternally: true,
},
{
id: 'mse-cashback-section', label: 'MoneySavingExpert — ongoing cashback section', site: 'moneysavingexpert.com',
note: 'Reported by checkAccountValue() (switchoffers.js, the "Ongoing account value" check) whenever it runs -- a SEPARATE page anchor (#cashback) from the one mse-bank-switch already watches (#switch), extracted the same sibling-walk way, so the two sections can break independently of each other.',
run: null, reportedExternally: true,
},
];

function store() {
if (!data.siteHealth || typeof data.siteHealth !== 'object') data.siteHealth = {};
return data.siteHealth;
}

// Called by a check's own run() below, and by anything reporting in
// from elsewhere (cashback.js) that has its own trigger and was never
// routed through runCheck.
function reportCheck(id, ok, detail = '') {
const s = store();
const prev = s[id];
const now = new Date().toISOString();
s[id] = {
lastRunAt: now, ok, detail,
// Set once and kept until a run reports ok again -- "broken since"
// means nothing if it quietly resets on every failed retry.
brokenSince: ok ? null : ((prev && prev.ok === false && prev.brokenSince) || now),
};
queueSave();
return s[id];
}

async function runCheck(id) {
const check = CHECKS.find((c) => c.id === id);
if (!check || !check.run) return null;
try {
const detail = await check.run();
return reportCheck(id, true, detail || '');
} catch (err) {
return reportCheck(id, false, err.message || String(err));
}
}

// The weekly sweep: every check that defines its own run() and hasn't
// run in the last week. Checks fed from elsewhere (reportedExternally)
// are left alone here -- they report on whatever already triggers them.
async function runAllChecks() {
const s = store();
for (const check of CHECKS) {
if (!check.run) continue;
const last = s[check.id]?.lastRunAt;
if (last && Date.now() - new Date(last).getTime() < WEEK_MS) continue;
await runCheck(check.id);
}
}

// ---- The AP colour-filter canary -------------------------------------

async function runApColoursCheck() {
const { fetchPages } = await import('./stockwatch.js');
const agentProvocateur = await import('../retailers/agentprovocateur.js');
const url = agentProvocateur.listingUrl({ prodType: 'Bras', colours: ['Black'], sort: 'price' });
const { pages, errors } = await fetchPages([url]);
const html = pages.get(url);
if (!html) throw new Error(errors[0]?.error || "the page didn't come back");
const items = agentProvocateur.listingItems(html);
if (!items.length) throw new Error('the filtered listing came back with nothing in it');
const offColour = items.filter((i) => !agentProvocateur.bucketsForColour(i.colour).includes('Black'));
if (offColour.length) {
throw new Error(`${offColour.length} of ${items.length} results weren't black (e.g. "${offColour[0].colour}") -- the colour filter likely stopped working`);
}
return `${items.length} black bras found, all genuinely black.`;
}

// ---- The health-sync staleness canary ------------------------------------
//
// Life Dashboard syncs several times a day in ordinary use, so a gap this
// long means it's genuinely stopped, not just waiting for its next run --
// generous enough that the weekly sweep (the fallback for whenever
// Settings/Health hasn't been opened) doesn't fire a false alarm on an
// ordinary quiet day, tight enough to catch a real outage long before the
// next person-driven check would.
const HEALTH_SYNC_STALE_MS = 36 * 3600000;

// Every top-level key healthparse.js actually knows how to read -- kept
// here too (not just there) so a payload arriving with none of them can
// be caught as its own failure mode, distinct from "nothing arrived at
// all": the bridge app could rename its own fields in an update and every
// sync would still land a 200 at health.php, just carrying something
// parseHealthPayloads silently has nothing to do with.
const HEALTH_PAYLOAD_KEYS = ['steps', 'distance', 'total_calories', 'sleep', 'heart_rate', 'oxygen_saturation', 'weight', 'body_fat', 'exercise'];

// Pure (no fetch of its own) so health.js's "Sync & parse" can reuse it
// against entries it already fetched, instead of this check fetching a
// second time for the same answer.
function healthSyncDetail(entries) {
if (!entries.length) throw new Error("Nothing received yet from the bridge app.");
const age = Date.now() - new Date(entries[0].receivedAt).getTime();
if (age > HEALTH_SYNC_STALE_MS) throw new Error(`Last entry received ${agoLabel(entries[0].receivedAt)} -- the bridge app may have stopped sending.`);
const payload = entries[0].payload;
if (!payload || typeof payload !== 'object' || !HEALTH_PAYLOAD_KEYS.some((k) => Array.isArray(payload[k]))) {
throw new Error('The latest entry arrived, but carries none of the field names this app knows how to parse -- the bridge app may have changed its payload shape.');
}
return `Last entry received ${agoLabel(entries[0].receivedAt)}.`;
}

async function runHealthSyncCheck() {
const { fetchHealthEntries } = await import('./health.js');
return healthSyncDetail(await fetchHealthEntries(1));
}

// ---- Settings panel -----------------------------------------------------

function escapeHtmlLocal(s) {
return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function agoLabel(iso) {
if (!iso) return '';
const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
if (mins < 1) return 'just now';
if (mins < 60) return `${mins} min ago`;
const hours = Math.round(mins / 60);
if (hours < 48) return `${hours}h ago`;
return `${Math.round(hours / 24)}d ago`;
}

function statusHtml(check) {
if (!check.run && !check.reportedExternally) return '<span class="tag-chip">Not implemented</span>';
const row = store()[check.id];
if (!row) return '<span class="tag-chip">No run yet</span>';
if (row.ok) return `<span class="tag-chip tag-chip-green">Last ran OK</span> <span class="settings-note" style="display:inline;margin:0;">${escapeHtmlLocal(agoLabel(row.lastRunAt))}</span>`;
return `<span class="tag-chip tag-chip-red">Broken since ${escapeHtmlLocal(agoLabel(row.brokenSince))}</span> <span class="settings-note" style="display:inline;margin:0;">${escapeHtmlLocal(row.detail)}</span>`;
}

function renderSiteHealth() {
const el = document.getElementById('site-health-table');
if (!el) return;
el.innerHTML = `<table class="limits-table">
<thead><tr><th>Check</th><th>Status</th><th></th></tr></thead>
<tbody>${CHECKS.map((c) => `<tr id="site-health-row-${escapeHtmlLocal(c.id)}">
<td>${escapeHtmlLocal(c.label)}<div class="settings-note" style="margin:0;">${escapeHtmlLocal(c.note)}</div></td>
<td>${statusHtml(c)}</td>
<td>${c.run ? `<button class="sync-btn sm" type="button" data-health-run="${escapeHtmlLocal(c.id)}">Run now</button>` : ''}</td>
</tr>`).join('')}</tbody>
</table>`;
el.querySelectorAll('[data-health-run]').forEach((btn) => {
btn.addEventListener('click', async () => {
btn.disabled = true;
btn.textContent = 'Running…';
await runCheck(btn.dataset.healthRun);
renderSiteHealth();
});
});
}

export { CHECKS, reportCheck, runCheck, runAllChecks, renderSiteHealth, healthSyncDetail };
