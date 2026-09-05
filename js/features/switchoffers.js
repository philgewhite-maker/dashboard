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
// fixes. Deliberately NOT chasing this further (TLS fingerprint
// spoofing, rotating through other services) -- that crosses from
// "personal convenience automation" into actively defeating a site's
// anti-bot measures, which its own terms almost certainly prohibit.
// Instead: open the page in your own browser (never blocked -- it's a
// real browsing session), copy its text, paste it in below. Same
// eligibility-reasoning call either way -- only how the page text
// arrives changed. Same "scan -> human-reviewed list, never auto-apply"
// shape every other data-quality feature in this app already uses
// (Photo Quality, the duplicate finder, tag cleanup's location
// fill-ins) -- this is a real financial decision, so the feature only
// ever proposes.
import { data, queueSave } from '../state.js';
import { escapeHtml, uid, todayStr } from '../utils.js';
import { callTextJson, MissingKeyError } from '../ai.js';
import { accountLabel, expandAccountRow, formatShortDate } from './financeaccounts.js';

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
// comment documents. Sized generously to leave real room after thinking,
// same "output tokens are cheap, a failed check isn't" reasoning as that
// constant and notionplan.js's PLAN_MAX_TOKENS.
const SWITCH_MAX_TOKENS = 8000;
// A generous flat cap -- a pasted selection is normally just the
// switching section, but this guards against pasting the whole page
// (or several) without needing fragile section-anchor slicing.
const PAGE_TEXT_CAP = 80000;

function cleanPastedText(text) {
return String(text || '').replace(/\s+/g, ' ').trim().slice(0, PAGE_TEXT_CAP);
}

async function scanSwitchOffers(rawText) {
const pageText = cleanPastedText(rawText);
const ownAccounts = data.financeAccounts.map((a) => ({
bank: a.bank, name: a.name, openDate: a.openDate, closeDate: a.closeDate, stage: a.stage,
}));
const prompt = `Below is text pasted from MoneySavingExpert's bank switch offers page, followed by my own bank account history (including closed accounts).

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
data.switchOffers = await scanSwitchOffers(text);
data.prefs.switchOffersCheckedAt = todayStr();
queueSave();
say(data.switchOffers.length ? `Found ${data.switchOffers.length} offer${data.switchOffers.length === 1 ? '' : 's'}.` : 'No current switch offers found in that text.');
textarea.value = '';
renderSwitchOffers();
} catch (err) {
say(err instanceof MissingKeyError ? err.message : `Couldn't check: ${err.message || err}`);
console.error('Switch-offers scan failed:', err);
} finally {
btn.disabled = false;
}
});
renderSwitchOffers();
}

export { renderSwitchOffers, initSwitchOffers };
