// Cross-references MoneySavingExpert's current bank-switch-offer page
// against your own bank account history (which banks you've already
// held or claimed a bonus from, and which open accounts are actually
// free to CASS away -- stage === 'CASS-ready') so you don't have to do
// that comparison by hand.
//
// Originally built as an automatic server-side fetch (via the same
// ics-proxy.php used for Airbnb calendar feeds) -- confirmed live that
// the offer text really is server-rendered HTML, not client-JS-
// injected, so a plain fetch would see everything a real browser does.
// But confirmed live, twice, that MoneySavingExpert sits behind
// Cloudflare Bot Management and 403s the proxy's request even after
// swapping in a full real-browser User-Agent + headers -- an IP/ASN
// reputation block, not a header one, which no amount of header-tuning
// fixes. Deliberately NOT chasing THAT further (TLS fingerprint
// spoofing, rotating through other services FROM THE WEB HOST) -- that
// crosses from "personal convenience automation" into actively
// defeating a site's anti-bot measures, which its own terms almost
// certainly prohibit.
//
// What this now does instead is a genuinely different thing, not a
// sneakier version of the rejected one: the home agent's own real
// headless browser, running from your own home connection -- the exact
// same route js/cashback.js already uses for Quidco (which sits behind
// the identical Cloudflare JS challenge and renders fine through it).
// That's a real browsing session on a residential IP, the same shape a
// human opening the page themselves is, not a spoofed/rotated identity
// pretending to be one -- so it doesn't revisit the judgement call
// above. If that's ever down (the browser container not running, no
// live sync configured), pasting the page's own text by hand is still
// here as the fallback it always was. Same "scan -> human-reviewed
// list, never auto-apply" shape either way -- only how the page text
// arrives changed. This is a real financial decision, so the feature
// only ever proposes.
import { data, queueSave } from '../state.js';
import { escapeHtml, uid, todayStr, daysSince } from '../utils.js';
import { callTextJson, MissingKeyError } from '../ai.js';
import { accountLabel, expandAccountRow, formatShortDate } from './financeaccounts.js';
import { captureTask, revealTask } from './tasks.js';
import { run, AgentNotConfiguredError } from '../homeagent.js';

const MSE_SWITCH_URL = 'https://www.moneysavingexpert.com/banking/compare-best-bank-accounts/#switch';

// Locked, same reasoning as notionplan.js's own PLAN_MODEL choice --
// interpreting an offer's actual exclusion wording ("no account on
// [date]" vs. "never held one") deserves a real reasoning pass, not the
// cheap ranking tier nudges.js's own RANK_MODEL uses for a much simpler
// job.
const SWITCH_MODEL = 'claude-sonnet-5';
// Confirmed live: Sonnet 5 thinks by default at this call's effort level
// (no 'low' passed, deliberately -- see above), and that thinking block
// counts against max_tokens same as the real answer. At 3000 the whole
// budget went to thinking and the call hit stop_reason:'max_tokens' with
// NO text block at all -- same failure ai.js's own WELLNESS_MAX_TOKENS
// comment documents. Confirmed AGAIN at 8000 once the home-agent fetch
// path existed (stripHtmlNoise below, feeding a far bigger page dump
// than anyone ever pastes by hand) -- raised further, and stripHtmlNoise
// itself now tries to cut the input down too, since a bigger budget
// alone just delays the same failure on a big enough page. Same "output
// tokens are cheap, a failed check isn't" reasoning as that constant and
// notionplan.js's PLAN_MAX_TOKENS.
const SWITCH_MAX_TOKENS = 16000;
// A generous flat cap -- a pasted selection is normally just the
// switching section, but this guards against pasting the whole page
// (or several) without needing fragile section-anchor slicing.
const PAGE_TEXT_CAP = 80000;

function cleanPastedText(text) {
return String(text || '').replace(/\s+/g, ' ').trim().slice(0, PAGE_TEXT_CAP);
}

// The home-agent path hands back raw HTML (page.render's whole job is
// giving you what a browser sees, not picked-over text), where the paste
// path already hands back clean text a human selected by hand. Strips
// script/style/chrome OUT before reading textContent -- a plain
// .textContent walk (as googlemail.js's own stripHtml does, fine for an
// email body) would otherwise pull a modern page's analytics/CSS source,
// nav/cookie-banner/form chrome in as text, which cleanPastedText's own
// whitespace-collapse can't tell apart from real content and would burn
// real token budget in the AI call below -- confirmed live as a real
// failure, not just a theoretical one: the full page text blew through
// SWITCH_MAX_TOKENS entirely (stop_reason: 'max_tokens', no answer at
// all), on a page several times bigger and noisier than anyone pastes by
// hand.
function parseAndStripDoc(html) {
const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
doc.querySelectorAll('script, style, noscript, svg, nav, footer, header, aside, form, iframe, button, select, label').forEach((el) => el.remove());
return doc;
}

// Confirmed live (fetched the real page via the claude-test channel,
// home-agent/agent.py's poll_claude_test): MSE_SWITCH_URL's own #switch
// anchor, and the #cashback section right after it ("Don't want to
// switch? Top accounts for ongoing cashback & perks" --
// analyseOngoingAccountValue's own input, js/ai.js), BOTH sit on the
// section's <h2> heading ITSELF, not a wrapping container -- the real
// content that follows is a run of SIBLING elements, not descendants, so
// reading the heading's own textContent alone captures only its ~30
// characters. This walks forward through next-siblings instead, stopping
// at the next same-level <h2>, confirmed live to be exactly where the
// next, unrelated section starts either way (~13,700 characters for
// #switch, ~5,700 for #cashback, on the page fetched during testing) --
// a fraction of the ~328,000-character full page, without the dozen
// other unrelated comparisons it also covers. Falls back to the full
// page text if the id is missing entirely (a future redesign moves or
// renames it) or yields barely anything, same safety net as before this
// was confirmed.
function extractSection(doc, anchorId) {
const anchor = doc.getElementById(anchorId);
let scoped = '';
if (anchor) {
const parts = [anchor.textContent || ''];
let node = anchor.nextElementSibling;
while (node && !/^H[1-2]$/i.test(node.tagName)) {
parts.push(node.textContent || '');
node = node.nextElementSibling;
}
scoped = parts.join(' ').trim();
}
const text = scoped.length > 500 ? scoped : (doc.body?.textContent || '');
return text.replace(/\s+/g, ' ').trim();
}

function stripHtmlNoise(html) {
return extractSection(parseAndStripDoc(html), 'switch');
}

// Oldest-first, capped -- see data.switchOffersHistory's own comment in
// state.js. Every scan appends one, manual or automatic alike, so the
// log reflects every time this was actually checked, not just the
// automated ones.
const HISTORY_CAP = 104; // ~2 years of weekly snapshots
function recordHistorySnapshot(opportunities, source) {
data.switchOffersHistory.push({
at: new Date().toISOString(), source,
offers: opportunities.map((o) => ({ bank: o.bank, offer: o.offer })),
});
if (data.switchOffersHistory.length > HISTORY_CAP) data.switchOffersHistory = data.switchOffersHistory.slice(-HISTORY_CAP);
}

// Shared by the manual paste button, the new home-agent button, and the
// weekly automatic check -- one place that turns a scan's result into
// the same saved state and history entry regardless of how the page text
// arrived.
async function applyScan(rawText, source) {
const opportunities = await scanSwitchOffers(rawText);
data.switchOffers = opportunities;
data.prefs.switchOffersCheckedAt = todayStr();
recordHistorySnapshot(opportunities, source);
queueSave();
return opportunities;
}

// At least weekly, same "runs at ordinary app-open cadence far more
// often than the real threshold, so the threshold lives inside the job
// itself" shape as scheduled.js's own cashback sweep -- this is what
// actually enforces "weekly" rather than the scheduler's own (much
// shorter) global interval.
const AUTO_RECHECK_DAYS = 7;

// Called by scheduled.js's 'switch-offers' task and by sitehealth.js's
// already-reserved 'mse-bank-switch' slot. Silent no-op when the home
// agent isn't configured or down -- this is a nicety on top of the
// manual flow, never a reason to nag on every app open when it can't
// run. Returns null when it didn't run (not due, or couldn't reach the
// agent) so callers can tell "nothing to report" from "ran and found 0".
async function runAutomaticSwitchCheck() {
const last = data.prefs.switchOffersCheckedAt;
if (last && daysSince(last) < AUTO_RECHECK_DAYS) return null;
try {
const { pages } = await run('page.render', { url: MSE_SWITCH_URL });
const page = pages?.[0];
if (!page || !page.html) throw new Error(page?.error || 'the page never came back');
const opportunities = await applyScan(stripHtmlNoise(page.html), 'auto');
renderSwitchOffers();
import('./sitehealth.js').then(({ reportCheck }) => reportCheck('mse-bank-switch', true, `${opportunities.length} offer${opportunities.length === 1 ? '' : 's'} found`));
return { ok: true, count: opportunities.length };
} catch (err) {
if (err instanceof AgentNotConfiguredError) return null; // no live sync set up -- not an error, just can't run yet
console.error('Automatic switch-offers check failed:', err);
import('./sitehealth.js').then(({ reportCheck }) => reportCheck('mse-bank-switch', false, err.message || String(err)));
return { ok: false, detail: err.message || String(err) };
}
}

async function scanSwitchOffers(rawText) {
const pageText = cleanPastedText(rawText);
const ownAccounts = data.financeAccounts.map((a) => ({
bank: a.bank, name: a.name, openDate: a.openDate, closeDate: a.closeDate, stage: a.stage,
// The authoritative "did a bonus actually get paid here" record --
// confirmed live as a real gap otherwise: holding an account that
// falls within an offer's own exclusion window is only ever
// "plausible" evidence a past bonus was claimed, never proof either
// way, which is exactly the uncertainty this closes when a bonus is
// actually on file.
switchBonuses: (a.switchBonuses || []).map((sb) => ({ description: sb.description, amount: sb.amount, status: sb.status })),
}));
const prompt = `Below is text pasted from MoneySavingExpert's bank switch offers page, followed by my own bank account history (including closed accounts).

PAGE TEXT:
${pageText}

MY ACCOUNT HISTORY (JSON):
${JSON.stringify(ownAccounts)}

Extract every current switch/incentive offer mentioned for opening a NEW account. For each one, decide whether I appear eligible based on my account history -- read each offer's own stated exclusions carefully (e.g. "no account on [date]" is different from "never held one"). An account's own switchBonuses array, when it has one, is DEFINITIVE: a "Paid" entry means a bonus from that bank was genuinely claimed (don't hedge as "plausible" when you have this); no entries at all, or only "Working on"/"Met" ones, means none has been paid out yet regardless of how long the account was held. If any of my OPEN accounts (no closeDate) with stage "CASS-ready" could plausibly be the one I switch FROM, name it -- never a closed one, which can't be switched from at all. If genuinely unsure, say so rather than guessing either way.

Return ONLY a JSON object, no other text, no markdown fences:
{"opportunities": [{"bank": "...", "offer": "e.g. £240 to switch", "eligible": "yes" | "no" | "unsure", "reasoning": "one or two sentences, specific to my own history", "suggestedFromBank": "one of my own OPEN CASS-ready accounts' bank name, or null"}]}`;

const { data: parsed } = await callTextJson(prompt, SWITCH_MAX_TOKENS, SWITCH_MODEL, 'Switch offers');
const opportunities = Array.isArray(parsed?.opportunities) ? parsed.opportunities : [];
return opportunities.map((o) => ({
id: uid(),
bank: String(o.bank || ''),
offer: String(o.offer || ''),
eligible: ['yes', 'no', 'unsure'].includes(o.eligible) ? o.eligible : 'unsure',
reasoning: String(o.reasoning || ''),
// Never a CLOSED account, regardless of what the model named or what
// stage still says -- confirmed live as a real gap: a "CASS-ready"
// account that was since closed (its CASS switch already happened,
// stage just never got reset afterwards) was being suggested as a
// switch-FROM source months after it stopped being one.
suggestedFromAccountId: (data.financeAccounts.find((a) => a.stage === 'CASS-ready' && !a.closeDate && a.bank === o.suggestedFromBank) || {}).id || '',
dismissed: false,
taskId: '', // set once "Create task" is clicked -- see switchOfferActionHtml
}));
}

const ELIGIBLE_LABEL = { yes: 'Eligible', unsure: 'Unsure', no: 'Not eligible' };
const ELIGIBLE_CLASS = { yes: 'tag-chip-green', unsure: 'tag-chip-amber' }; // 'no' stays the plain default chip -- not a warning, just inapplicable

// Only offered for genuinely eligible offers -- "unsure"/"no" aren't
// something to act on yet. Once a task exists, this switches to the
// standard record-reference link (CLAUDE.md's convention) rather than
// staying a button, so re-clicking can't spawn a second task for the
// same offer.
function switchOfferActionHtml(o) {
if (o.eligible !== 'yes') return '';
if (o.taskId) return `<span class="dd-to-account-link" data-open-task-ref="${escapeHtml(o.taskId)}">&rarr; View task</span>`;
return `<button class="sync-btn inline" type="button" data-switch-offer-task="${escapeHtml(o.id)}">Create task</button>`;
}

function opportunityRowHtml(o) {
const account = o.suggestedFromAccountId ? data.financeAccounts.find((a) => a.id === o.suggestedFromAccountId) : null;
return `<div class="switch-offer-row" data-switch-offer="${escapeHtml(o.id)}">
<div class="switch-offer-head">
<span class="switch-offer-bank">${escapeHtml(o.bank)}</span>
<span class="tag-chip ${ELIGIBLE_CLASS[o.eligible] || ''}">${ELIGIBLE_LABEL[o.eligible]}</span>
${switchOfferActionHtml(o)}
<span class="del-x" style="opacity:1;margin-left:auto;" data-switch-offer-dismiss="${escapeHtml(o.id)}" title="Dismiss">&times;</span>
</div>
<div class="switch-offer-offer">${escapeHtml(o.offer)}</div>
<div class="switch-offer-reasoning">${escapeHtml(o.reasoning)}</div>
${account ? `<span class="dd-to-account-link" data-open-account-ref="${escapeHtml(account.id)}">&rarr; ${escapeHtml(accountLabel(account))}</span>` : ''}
</div>`;
}

function renderSwitchOffers() {
const list = document.getElementById('switch-offers-list');
const statusEl = document.getElementById('switch-offers-checked-status');
if (!list) return;
const visible = (data.switchOffers || []).filter((o) => !o.dismissed);
list.innerHTML = visible.length
? visible.map(opportunityRowHtml).join('')
: '<div class="empty">Nothing found yet — paste the page text below and click Analyse.</div>';
if (statusEl) {
statusEl.textContent = data.prefs.switchOffersCheckedAt
? `Last checked ${formatShortDate(data.prefs.switchOffersCheckedAt)}.`
: 'Never checked yet.';
}
list.querySelectorAll('[data-switch-offer-dismiss]').forEach((x) => {
x.addEventListener('click', () => {
const o = data.switchOffers.find((entry) => entry.id === x.dataset.switchOfferDismiss);
if (o) o.dismissed = true;
queueSave();
renderSwitchOffers();
});
});
list.querySelectorAll('[data-open-account-ref]').forEach((el) => {
el.addEventListener('click', () => expandAccountRow(el.dataset.openAccountRef));
});
list.querySelectorAll('[data-switch-offer-task]').forEach((btn) => {
btn.addEventListener('click', () => {
const o = data.switchOffers.find((entry) => entry.id === btn.dataset.switchOfferTask);
if (!o || o.taskId) return; // already actioned -- the button shouldn't still be showing, but don't double-create if it is
const account = o.suggestedFromAccountId ? data.financeAccounts.find((a) => a.id === o.suggestedFromAccountId) : null;
const task = captureTask({
title: `Switch to ${o.bank} (${o.offer})`,
notes: `${o.reasoning}${account ? ` Switch from ${accountLabel(account)}.` : ''}`,
source: { kind: 'switch offer', label: o.bank, url: MSE_SWITCH_URL },
});
o.taskId = task.id;
queueSave();
renderSwitchOffers();
});
});
list.querySelectorAll('[data-open-task-ref]').forEach((el) => {
el.addEventListener('click', async () => {
const { switchTab } = await import('../tabs.js');
switchTab('tasks');
revealTask(el.dataset.openTaskRef);
});
});
}

// ---- Ongoing account value (is one of MY OWN accounts worth keeping?) ----
//
// A genuinely different question from the switch-offers scan above: not
// "what new bonus am I eligible for", but "is an account I already HAVE
// bringing so little ongoing benefit that moving it is worth
// considering" -- weighing the account's own tracked deal/fee against
// MSE's "ongoing cashback & perks" section (the #cashback section right
// after #switch on the same page), the SWITCH section's own exclusion
// wording (closing an account now can HELP a future switch bonus from
// that bank, not just risk losing one), and whether the alternative is
// even a CASS participant (a great perk account that can't be left via
// the Current Account Switch Service later is a one-way door). See
// js/ai.js's analyseOngoingAccountValue for the free-text reasoning
// (the first two), and cassParticipants/isCassParticipant just below for
// the third -- that one has a real, published, exact answer (the CASS
// site's own participant list), so it's looked up directly rather than
// asked of an AI web search.
//
// Its own deliberate action, not folded into the switch-offers check
// automatically -- a second real AI call, same "costs money, make it a
// click" reasoning as every other AI-assisted step in this app. Does
// its OWN page.render fetch rather than reusing a cached copy from the
// switch-offers check, so this works standalone and never shows a stale
// page just because the other check happened to run first.
function accountValueRowHtml(r) {
const cassLabel = { yes: 'CASS participant', no: 'CASS dead end', unsure: 'CASS status unsure' }[r.cassSupported];
const cassClass = { yes: 'tag-chip-green', no: 'tag-chip-amber' }[r.cassSupported] || '';
return `<div class="switch-offer-row" data-account-value="${escapeHtml(r.id)}">
<div class="switch-offer-head">
<span class="switch-offer-bank">${escapeHtml(r.currentBank)}${r.currentAccountName ? ` — ${escapeHtml(r.currentAccountName)}` : ''}</span>
<span class="del-x" style="opacity:1;margin-left:auto;" data-account-value-dismiss="${escapeHtml(r.id)}" title="Dismiss">&times;</span>
</div>
${r.currentBenefitSummary ? `<div class="switch-offer-offer">Currently: ${escapeHtml(r.currentBenefitSummary)}</div>` : ''}
<div class="switch-offer-offer">Consider: <strong>${escapeHtml(r.suggestedProvider)}</strong>${r.suggestedPerkSummary ? ` — ${escapeHtml(r.suggestedPerkSummary)}` : ''} <span class="tag-chip ${cassClass}">${cassLabel}</span></div>
${r.futureEligibilityNote ? `<div class="switch-offer-reasoning">${escapeHtml(r.futureEligibilityNote)}</div>` : ''}
<div class="switch-offer-reasoning">${escapeHtml(r.recommendation)}</div>
</div>`;
}

function renderAccountValueReviews() {
const list = document.getElementById('account-value-list');
if (!list) return;
const visible = (data.accountValueReviews || []).filter((r) => !r.dismissed);
list.innerHTML = visible.length
? visible.map(accountValueRowHtml).join('')
: '<div class="empty">Nothing flagged yet — click "Review ongoing accounts" below.</div>';
list.querySelectorAll('[data-account-value-dismiss]').forEach((x) => {
x.addEventListener('click', () => {
const r = data.accountValueReviews.find((entry) => entry.id === x.dataset.accountValueDismiss);
if (r) r.dismissed = true;
queueSave();
renderAccountValueReviews();
});
});
}

const CASS_LIST_URL = 'https://www.currentaccountswitch.co.uk/banks-building-societies/';
// Months, not days -- the set of banks/building societies in CASS barely
// changes (confirmed live: 51 participants, each a stable institution,
// not a rotating promotion), so re-fetching it every single account-value
// check would be a home-agent round trip for a list that's essentially
// always the same answer. Re-fetched automatically once this goes stale.
const CASS_LIST_MAX_AGE_DAYS = 90;

// "Bank of", "Building Society", "plc", "Ltd", bracketed codicils --
// confirmed live against the REAL participant list (fetched via the
// claude-test channel): each entry's own data-value attribute is already
// a clean lowercased name ("santander", "hsbc uk bank plc", "aib (ni)"),
// so this only needs to strip the same handful of filler terms a human
// would ignore when eyeballing the list themselves, not fuzzy/AI matching.
function normalizeBankName(name) {
return String(name || '')
.toLowerCase()
.replace(/\([^)]*\)/g, ' ')
.replace(/\b(bank of|building society|bank|plc|ltd|limited|co\.?|&|group|holdings)\b/g, ' ')
.replace(/[^a-z0-9]+/g, ' ')
.trim()
.replace(/\s+/g, ' ');
}

// Confirmed live against the real page: each participant is
// `<div class="accordion__item banks-and-building-societies__accordion-item" data-value="...">`
// -- the attribute IS the clean name, no scraping of visible text (or its
// Personal:/Business: contact-detail noise) needed at all.
async function fetchCassParticipants() {
const { pages } = await run('page.render', { url: CASS_LIST_URL });
const page = pages?.[0];
if (!page || !page.html) throw new Error(page?.error || 'the CASS participant list page never came back');
const doc = new DOMParser().parseFromString(page.html, 'text/html');
const list = [...doc.querySelectorAll('.accordion__item.banks-and-building-societies__accordion-item')]
.map((el) => el.getAttribute('data-value'))
.filter(Boolean);
if (!list.length) throw new Error("couldn't read the CASS participant list -- the page's own markup may have changed");
data.cassParticipants = { list, fetchedAt: new Date().toISOString() };
queueSave();
return list;
}

async function cassParticipants() {
const cached = data.cassParticipants;
if (cached?.list?.length && cached.fetchedAt && daysSince(cached.fetchedAt) < CASS_LIST_MAX_AGE_DAYS) return cached.list;
return fetchCassParticipants();
}

// 'unsure' only when the AI gave no provider name to check at all --
// everything else is a real yes/no against the real list, not a guess.
function isCassParticipant(providerName, participants) {
const target = normalizeBankName(providerName);
if (!target) return 'unsure';
return participants.some((p) => {
const norm = normalizeBankName(p);
return norm && (norm === target || norm.includes(target) || target.includes(norm));
}) ? 'yes' : 'no';
}

async function checkAccountValue() {
const { pages } = await run('page.render', { url: MSE_SWITCH_URL });
const page = pages?.[0];
if (!page || !page.html) throw new Error(page?.error || 'the page never came back');
const doc = parseAndStripDoc(page.html);
const cashbackText = cleanPastedText(extractSection(doc, 'cashback'));
const switchText = cleanPastedText(extractSection(doc, 'switch'));
const ownAccounts = data.financeAccounts
.filter((a) => a.accountType === 'Current account' && !a.closeDate)
.map((a) => ({
bank: a.bank, name: a.name, stage: a.stage, openDate: a.openDate,
deal: a.deal, dealOngoing: a.dealOngoing, dealEndDate: a.dealEndDate,
// Same authoritative "was a bonus actually paid here" record as
// scanSwitchOffers' own ownAccounts above -- the futureEligibilityNote
// this feeds needs it for the identical reason.
switchBonuses: (a.switchBonuses || []).map((sb) => ({ description: sb.description, amount: sb.amount, status: sb.status })),
accountFee: a.accountFee, accountFeeBasis: a.accountFeeBasis, purpose: a.purpose,
}));
const [{ analyseOngoingAccountValue }, participants] = await Promise.all([import('../ai.js'), cassParticipants()]);
const reviews = await analyseOngoingAccountValue(cashbackText, switchText, ownAccounts);
data.accountValueReviews = reviews.map((r) => ({
id: uid(), dismissed: false, ...r,
cassSupported: isCassParticipant(r.suggestedProvider, participants),
}));
queueSave();
renderAccountValueReviews();
return reviews;
}

function initSwitchOffers() {
const btn = document.getElementById('switch-offers-scan-btn');
const textarea = document.getElementById('switch-offers-paste');
if (!btn || !textarea) return; // panel not in this build's DOM
const statusEl = document.getElementById('switch-offers-scan-status');
const say = (m) => { if (statusEl) statusEl.textContent = m; };
btn.addEventListener('click', async () => {
const text = textarea.value.trim();
if (!text) { say('Paste the page text first.'); return; }
btn.disabled = true;
say('Reading the offers…');
try {
const opportunities = await applyScan(text, 'manual');
say(opportunities.length ? `Found ${opportunities.length} offer${opportunities.length === 1 ? '' : 's'}.` : 'No current switch offers found in that text.');
textarea.value = '';
renderSwitchOffers();
} catch (err) {
say(err instanceof MissingKeyError ? err.message : `Couldn't check: ${err.message || err}`);
console.error('Switch-offers scan failed:', err);
} finally {
btn.disabled = false;
}
});
const homeAgentBtn = document.getElementById('switch-offers-homeagent-btn');
const homeAgentStatusEl = document.getElementById('switch-offers-homeagent-status');
const sayHomeAgent = (m) => { if (homeAgentStatusEl) homeAgentStatusEl.textContent = m; };
if (homeAgentBtn) {
homeAgentBtn.addEventListener('click', async () => {
homeAgentBtn.disabled = true;
sayHomeAgent('Fetching the page via the home agent…');
try {
const { pages } = await run('page.render', { url: MSE_SWITCH_URL });
const page = pages?.[0];
if (!page || !page.html) throw new Error(page?.error || 'the page never came back');
import('./sitehealth.js').then(({ reportCheck }) => reportCheck('mse-bank-switch', true, 'page fetched'));
sayHomeAgent('Reading the offers…');
const opportunities = await applyScan(stripHtmlNoise(page.html), 'manual');
sayHomeAgent(opportunities.length ? `Found ${opportunities.length} offer${opportunities.length === 1 ? '' : 's'}.` : 'No current switch offers found on the page.');
renderSwitchOffers();
} catch (err) {
sayHomeAgent(err instanceof AgentNotConfiguredError ? 'Set up live sync (Settings) to use the home agent, or paste the page text below instead.'
: err instanceof MissingKeyError ? err.message
: `Couldn't fetch via the home agent: ${err.message || err}`);
console.error('Switch-offers home-agent fetch failed:', err);
if (!(err instanceof AgentNotConfiguredError)) {
import('./sitehealth.js').then(({ reportCheck }) => reportCheck('mse-bank-switch', false, err.message || String(err)));
}
} finally {
homeAgentBtn.disabled = false;
}
});
}
const accountValueBtn = document.getElementById('account-value-check-btn');
const accountValueStatusEl = document.getElementById('account-value-check-status');
const sayAccountValue = (m) => { if (accountValueStatusEl) accountValueStatusEl.textContent = m; };
if (accountValueBtn) {
accountValueBtn.addEventListener('click', async () => {
accountValueBtn.disabled = true;
sayAccountValue('Fetching the page via the home agent…');
try {
sayAccountValue('Weighing your accounts against it (this includes a web search, so it can take a minute)…');
const reviews = await checkAccountValue();
sayAccountValue(reviews.length ? `Found ${reviews.length} account${reviews.length === 1 ? '' : 's'} worth a look.` : 'Nothing worth flagging — your current accounts already look fine against this.');
} catch (err) {
sayAccountValue(err instanceof AgentNotConfiguredError ? 'Set up live sync (Settings) to use the home agent.'
: err instanceof MissingKeyError ? err.message
: `Couldn't check: ${err.message || err}`);
console.error('Account value check failed:', err);
} finally {
accountValueBtn.disabled = false;
}
});
}
renderSwitchOffers();
renderAccountValueReviews();
}

export { renderSwitchOffers, initSwitchOffers, runAutomaticSwitchCheck };
