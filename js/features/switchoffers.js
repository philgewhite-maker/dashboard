// Cross-references MoneySavingExpert's current bank-switch-offer page
// against your own bank account history (which banks you've already
// held or claimed a bonus from, and which open accounts are actually
// free to CASS away -- stage === 'CASS-ready') so you don't have to do
// that comparison by hand. Confirmed feasible before building: the
// offer text (headline AND detailed eligibility bullets) is embedded in
// the page's own server-rendered HTML, not injected by client-side JS,
// so a plain server-side fetch sees everything a real browser would.
// Same "scan -> human-reviewed list, never auto-apply" shape every
// other data-quality feature in this app already uses (Photo Quality,
// the duplicate finder, tag cleanup's location fill-ins) -- this is a
// real financial decision, so the feature only ever proposes.
import { data, queueSave } from '../state.js';
import { escapeHtml, uid, todayStr, daysSince } from '../utils.js';
import { fetchIcs, FilesNotConfiguredError } from '../files.js';
import { callTextJson, MissingKeyError } from '../ai.js';
import { accountLabel, expandAccountRow, formatShortDate } from './financeaccounts.js';

const MSE_SWITCH_URL = 'https://www.moneysavingexpert.com/banking/compare-best-bank-accounts/#switch';
// Locked, same reasoning as notionplan.js's own PLAN_MODEL choice --
// interpreting an offer's actual exclusion wording ("no account on
// [date]" vs. "never held one") deserves a real reasoning pass, not the
// cheap ranking tier nudges.js's own RANK_MODEL uses for a much simpler
// job.
const SWITCH_MODEL = 'claude-sonnet-5';
const SWITCH_MAX_TOKENS = 3000;
// A generous flat cap, not fragile section-anchor slicing (MSE could
// reword its own headings any time). Confirmed live: the ~670KB raw
// page is only ~77,000 characters once script/style tag bodies are
// stripped (see extractReadableText -- element.textContent otherwise
// pulls those in too, confirmed live as a real bug: a first pass
// without stripping them burned the entire cap on CSS before reaching
// any article text at all). 80,000 comfortably covers the whole
// article, not just the switching section, so a future MSE reshuffle
// can't accidentally push a relevant offer past the cut-off.
const PAGE_TEXT_CAP = 80000;

// DOMParser parses the string into a DOM tree without executing any
// embedded <script> -- safe to run on a large, untrusted third-party
// page purely to read its text.
function extractReadableText(html) {
const doc = new DOMParser().parseFromString(html, 'text/html');
// .textContent otherwise pulls in <script>/<style> tag bodies too --
// confirmed live as a real bug: a first pass without stripping these
// burned the entire cap on CSS before reaching any article text.
doc.querySelectorAll('script, style, noscript').forEach((el) => el.remove());
return (doc.body?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, PAGE_TEXT_CAP);
}

async function scanSwitchOffers() {
// fetchIcs is a generic "fetch this URL server-side, return its text"
// proxy despite the name (files.js) -- nothing calendar-specific on the
// client side, reused as-is rather than adding a new backend endpoint.
const html = await fetchIcs(MSE_SWITCH_URL);
const pageText = extractReadableText(html);
const ownAccounts = data.financeAccounts.map((a) => ({
bank: a.bank, name: a.name, openDate: a.openDate, closeDate: a.closeDate, stage: a.stage,
}));
const prompt = `Below is the current text of MoneySavingExpert's bank switch offers page, followed by my own bank account history (including closed accounts).

PAGE TEXT:
${pageText}

MY ACCOUNT HISTORY (JSON):
${JSON.stringify(ownAccounts)}

Extract every current switch/incentive offer mentioned for opening a NEW account. For each one, decide whether I appear eligible based on my account history -- read each offer's own stated exclusions carefully (e.g. "no account on [date]" is different from "never held one"), and if any of my OPEN accounts with stage "CASS-ready" could plausibly be the one I switch FROM, name it. If genuinely unsure, say so rather than guessing either way.

Return ONLY a JSON object, no other text, no markdown fences:
{"opportunities": [{"bank": "...", "offer": "e.g. £240 to switch", "eligible": "yes" | "no" | "unsure", "reasoning": "one or two sentences, specific to my own history", "suggestedFromBank": "one of my own CASS-ready accounts' bank name, or null"}]}`;

const { data: parsed } = await callTextJson(prompt, SWITCH_MAX_TOKENS, SWITCH_MODEL, 'Switch offers');
const opportunities = Array.isArray(parsed?.opportunities) ? parsed.opportunities : [];
return opportunities.map((o) => ({
id: uid(),
bank: String(o.bank || ''),
offer: String(o.offer || ''),
eligible: ['yes', 'no', 'unsure'].includes(o.eligible) ? o.eligible : 'unsure',
reasoning: String(o.reasoning || ''),
suggestedFromAccountId: (data.financeAccounts.find((a) => a.stage === 'CASS-ready' && a.bank === o.suggestedFromBank) || {}).id || '',
dismissed: false,
}));
}

const ELIGIBLE_LABEL = { yes: 'Eligible', unsure: 'Unsure', no: 'Not eligible' };
const ELIGIBLE_CLASS = { yes: 'tag-chip-green', unsure: 'tag-chip-amber' }; // 'no' stays the plain default chip -- not a warning, just inapplicable

function opportunityRowHtml(o) {
const account = o.suggestedFromAccountId ? data.financeAccounts.find((a) => a.id === o.suggestedFromAccountId) : null;
return `<div class="switch-offer-row" data-switch-offer="${escapeHtml(o.id)}">
<div class="switch-offer-head">
<span class="switch-offer-bank">${escapeHtml(o.bank)}</span>
<span class="tag-chip ${ELIGIBLE_CLASS[o.eligible] || ''}">${ELIGIBLE_LABEL[o.eligible]}</span>
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
: '<div class="empty">Nothing found yet — click Check for the current offers.</div>';
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
}

function initSwitchOffers() {
const btn = document.getElementById('switch-offers-scan-btn');
if (!btn) return; // panel not in this build's DOM
const statusEl = document.getElementById('switch-offers-scan-status');
const say = (m) => { if (statusEl) statusEl.textContent = m; };
btn.addEventListener('click', async () => {
btn.disabled = true;
say('Fetching the current offers…');
try {
data.switchOffers = await scanSwitchOffers();
data.prefs.switchOffersCheckedAt = todayStr();
queueSave();
say(data.switchOffers.length ? `Found ${data.switchOffers.length} offer${data.switchOffers.length === 1 ? '' : 's'}.` : 'No current switch offers found.');
renderSwitchOffers();
} catch (err) {
say(err instanceof FilesNotConfiguredError || err instanceof MissingKeyError
? err.message
: `Couldn't check: ${err.message || err}`);
console.error('Switch-offers scan failed:', err);
} finally {
btn.disabled = false;
}
});
renderSwitchOffers();
}

export { renderSwitchOffers, initSwitchOffers };
