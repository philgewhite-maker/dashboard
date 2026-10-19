// Loyalty/rewards balances -- a monthly Gmail scan that reads each
// tracked program's own marketing/account emails for a real embedded
// balance, instead of the user retyping figures by hand every time.
//
// Every regex below was written against a REAL email body fetched
// live during this feature's own design, not guessed from a generic
// template -- see the plan file's own changelog for the exact
// examples. Two load-bearing facts that shaped every extractor:
//   - None of British Airways/Marriott Bonvoy/Virgin/Tesco/Boots sends
//     a dedicated "your balance" statement -- the real figure is
//     embedded inside an ordinary marketing email's own personalised
//     header/footer block, firing on THAT email's own irregular
//     schedule, not a fixed monthly cadence. A scan coming back empty
//     some months is expected, not a bug.
//   - This app's own stripHtml() (js/googlemail.js) is bare
//     `textContent` -- it inserts NO separator between adjacent table
//     cells or <br>-separated lines. A label and the NEXT field's
//     value routinely run together with zero whitespace (confirmed
//     live: British Airways' own template reads "...AVIOS750 TIER
//     POINTS5,864..." -- "750" is the tier-points VALUE stuck directly
//     onto the AVIOS label text, not part of the Avios figure). Every
//     regex here uses `\s*` (zero-or-more), never assumes a real gap.
import { data, queueSave, blankLoyaltyProgram, blankLoyaltyBalance } from '../state.js';
import { escapeHtml, uid, daysSince, todayStr, logoBadgeHtml, bindLogoFallbacks } from '../utils.js';
import { fetchMailSearches, getMessageDetail } from '../googlemail.js';
import { voucherChipHtml } from './vouchers.js';
import { matchBrandLogo } from '../brandLogos.js';

// How often a program is actually re-checked, independent of this
// file being invoked daily by js/features/scheduled.js's own (much
// shorter) global interval -- same split as mediarecs.js's own
// CADENCE_DAYS/isSourceDue.
const CADENCE_DAYS = 28;

// ---- Per-provider extractors --------------------------------------------
// Each takes (bodyText, subject) and returns either null (nothing
// recognised -- the caller counts this as "unmatched", not an error)
// or { membershipNumber, tier, date, metrics: [{label, balance, unit,
// expiryDate}] }. `date` is only set when the email itself states a
// precise as-of date (Marriott does); otherwise the caller falls back
// to the email's own Date header.

// Real example: "BLUE\nMEMBERSHIP 10975336\n188,672\nAVIOS750\nTIER
// POINTS5,864\nLIFETIME TIER POINTS". Each stat tile is VALUE then
// LABEL, but the next tile's value runs on with no separator -- so
// "750" (tier points) is stuck to the end of the "AVIOS" label, and
// "5,864" (lifetime tier points) to the end of "TIER POINTS".
function extractBritishAirways(bodyText) {
const text = String(bodyText || '');
const main = text.match(/([\d,]+)\s*AVIOS([\d,]+)\s*TIER POINTS([\d,]+)\s*LIFETIME TIER POINTS/i);
if (!main) return null;
const memberMatch = text.match(/([A-Z][A-Z ]{2,30}?)\s*MEMBERSHIP\s+(\d{5,12})(?!\d)/);
return {
membershipNumber: memberMatch ? memberMatch[2] : '',
tier: memberMatch ? memberMatch[1].trim() : '',
date: '',
metrics: [
{ label: 'Avios', balance: Number(main[1].replace(/,/g, '')), unit: 'Avios' },
{ label: 'Tier points', balance: Number(main[2].replace(/,/g, '')), unit: 'points' },
{ label: 'Lifetime tier points', balance: Number(main[3].replace(/,/g, '')), unit: 'points' },
],
};
}

// Real example: "...| 46,089 points | Platinum Elite | | | XXXXX5970
// |...| 18 nights this year as of 09/10/2026 |". The `.{0,30}?`
// non-greedy gap bridges whatever this account's own stripHtml()
// render puts between the number and the tier word -- a literal "|",
// a run of spaces, or nothing at all.
function extractMarriottBonvoy(bodyText) {
const text = String(bodyText || '');
const main = text.match(/([\d,]+)\s*points\b.{0,30}?(Platinum Elite|Titanium Elite|Gold Elite|Silver Elite|Ambassador|Member)/is);
if (!main) return null;
const memberMatch = text.match(/(X{3,}\d+)/);
const asOf = text.match(/nights this year as of\s*(\d{2})\/(\d{2})\/(\d{4})/i);
return {
membershipNumber: memberMatch ? memberMatch[1] : '',
tier: main[2],
date: asOf ? `${asOf[3]}-${asOf[2]}-${asOf[1]}` : '',
metrics: [{ label: 'Bonvoy points', balance: Number(main[1].replace(/,/g, '')), unit: 'points' }],
};
}

// A real architectural gap, confirmed live the SAME way Miles & More's
// was: this sender's own text/plain MIME part is just a "Can't see
// this email?" + unsubscribe footer, no account data in it at all --
// js/googlemail.js's bodyTextFromPayload() prefers text/plain whenever
// ANY part exists, so bodyText never has anything to match here
// regardless of how the regex is written (confirmed directly: "28
// emails found, none recognised" wasn't a missing/rare template, it
// was every single one being unreachable via bodyText). Reads bodyHtml
// instead. Two real template wordings confirmed from two different
// real fetched emails, both handled: an older one with its own
// "Membership tier:" line, and the more common one (confirmed live,
// Sep 2026) that folds the tier into the heading as "Your account
// summary : Red member" with no separate "Membership tier:" line at
// all -- `<strong>Label:</strong> value` is matched directly against
// the raw tags rather than via textContent, since that's the exact
// shape confirmed in the real HTML.
function extractVirginFlyingClub(bodyText, subject, bodyHtml) {
const html = String(bodyHtml || '');
if (!html) return null;
const pointsMatch = html.match(/Virgin Points:<\/strong>\s*([\d,]+)/i);
if (!pointsMatch) return null;
const numberMatch = html.match(/Membership number:<\/strong>\s*(\d+)/i);
const tierMatch = html.match(/Membership tier:<\/strong>\s*(\w+)/i) || html.match(/account summary\s*:\s*(\w+)\s*member/i);
return {
membershipNumber: numberMatch ? numberMatch[1] : '',
tier: tierMatch ? tierMatch[1].trim() : '',
date: '',
metrics: [{ label: 'Virgin Points', balance: Number(pointsMatch[1].replace(/,/g, '')), unit: 'points' }],
};
}

// Real example: "Your Advantage Card balance:### £9.00 worth of
// points" + "Advantage Card number: XXXX633035600012205193".
function extractBoots(bodyText) {
const text = String(bodyText || '');
const balMatch = text.match(/Advantage Card balance:?\s*#*\s*£([\d.,]+)\s*worth of points/i);
if (!balMatch) return null;
const numMatch = text.match(/Advantage Card number:\s*(\S+)/i);
return {
membershipNumber: numMatch ? numMatch[1] : '',
tier: '',
date: '',
metrics: [{ label: 'Advantage Card points', balance: Number(balMatch[1].replace(/,/g, '')), unit: '£ worth of points' }],
};
}

// Real example: "Ooooohyeah, you have 389 Clubcard Points". A second,
// real Tesco template renders its balance as an image with no number
// in the text at all -- this correctly returns null for that one; it
// genuinely has nothing to extract, not a bug.
function extractTescoClubcard(bodyText) {
const text = String(bodyText || '');
const m = text.match(/you have\s*([\d,]+)\s*Clubcard Points/i);
if (!m) return null;
return { membershipNumber: '', tier: '', date: '', metrics: [{ label: 'Clubcard points', balance: Number(m[1].replace(/,/g, '')), unit: 'points' }] };
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function parseDMonYyyy(day, mon, year) {
const idx = MONTH_NAMES.indexOf(String(mon).slice(0, 3).toLowerCase());
if (idx < 0) return '';
return `${year}-${String(idx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Two genuinely different real BA eVoucher templates, confirmed from
// two real fetched emails sent the SAME day (one replaced the other):
// an ISSUED voucher has a clean "Redeem your eVoucher" block --
// "Number: 125-4262603242\nName: White\nEmail Address: ...\nValue:
// GBP 401.45\nExpiry: 22 Nov 2026" (real value AND expiry, genuinely
// the richer of the two) -- checked FIRST since it's the one worth
// having. A USED voucher has no value/expiry at all, just "the
// British Airways eVoucher: 125-4252052359, ... has been used" --
// confirmed live: my first version only matched THIS shape (a bare
// "eVoucher:" + "£" check), silently missing the issued one entirely
// because its real format uses "Number:"/"Value: GBP" instead.
function extractBaVoucher(bodyText) {
const text = String(bodyText || '');
const issued = text.match(/Number:\s*([\w-]+)[\s\S]{0,150}?Value:\s*GBP\s*([\d.,]+)[\s\S]{0,60}?Expiry:\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i);
if (issued) {
return {
membershipNumber: '', tier: '', date: '',
// The voucher's own number (e.g. "125-4262603242") -- captured as
// `reference` so the Vouchers-panel linking review can tell two
// DIFFERENT eVouchers apart (a second one from an unrelated flight
// delay must never get matched against the first just because they
// share a program) rather than matching on program name alone.
metrics: [{ label: 'eVoucher issued', balance: Number(issued[2].replace(/,/g, '')), unit: '£', expiryDate: parseDMonYyyy(issued[3], issued[4], issued[5]), reference: issued[1] }],
};
}
const used = text.match(/eVoucher:\s*([\w-]+)[\s\S]{0,60}?has been used/i);
if (used) {
return { membershipNumber: '', tier: '', date: '', metrics: [{ label: 'eVoucher used', balance: null, unit: '£', expiryDate: '', reference: used[1] }] };
}
return null;
}

// Real example (plain text, with Hertz's own zero-width non-joiner
// characters around the number stripped before matching -- confirmed
// live, the raw text reads "Member Number: ‌53899031‌"):
// "Philip\n Loyalty Tier: Five Star\n Member Number: 53899031". No
// points balance ever appears in this template -- it's a "you earned
// a free day" trigger, not a statement -- so this records tier/
// membership only (balance: null), rather than inventing a number.
function extractHertz(bodyText, subject) {
const text = String(bodyText || '').replace(/[​‌‍﻿]/g, '');
const tierMatch = text.match(/Loyalty Tier:\s*([A-Za-z ]+)/i);
const numberMatch = text.match(/Member Number:\s*(\d+)/i) || text.match(/#(\d{6,10})\b/);
if (!tierMatch && !numberMatch) return null;
// Reported directly: this email IS the actual event ("Congrats! You
// earned a FREE day!"), not a generic status ping -- a bare "Status"
// label made every one of these look like an identical, repeated
// non-event instead of the real thing it's recording. No points
// balance is ever given a number here, hence balance:null -- see
// state.js's blankLoyaltyProgram and the UI's own manual-entry
// control for tracking an actual points figure by hand.
const earnedFreeDay = /earned a free day|free rental day/i.test(`${subject || ''} ${text}`);
return {
membershipNumber: numberMatch ? numberMatch[1] : '', tier: tierMatch ? tierMatch[1].trim() : '', date: '',
metrics: [{ label: earnedFreeDay ? 'Free day earned' : 'Status', balance: null, unit: '', expiryDate: '' }],
};
}

// Real example -- a one-off WELCOME email (confirmed live: "Thank you
// for joining SIXT ONE!"), so this will likely only ever match this
// single message, not something a fresh one shows up for every month
// -- "Member ID:SXT65175029" (no space after the colon) with the tier
// split across lines as "you're\nSilver,\n Philip!". No points figure
// anywhere in it -- confirmed live, this account genuinely has none
// accrued yet, not a missed match.
function extractSixt(bodyText) {
const text = String(bodyText || '');
const idMatch = text.match(/Member ID:\s*([\w-]+)/i);
const tierMatch = text.match(/you.re\s*\n?\s*([A-Za-z]+)\s*,/i);
if (!idMatch && !tierMatch) return null;
return {
membershipNumber: idMatch ? idMatch[1] : '', tier: tierMatch ? tierMatch[1].trim() : '', date: '',
metrics: [{ label: 'Status', balance: null, unit: '', expiryDate: '' }],
};
}

// A real architectural gap, not a regex problem -- confirmed live:
// this sender's own text/plain MIME part is just a one-line "view in
// browser" link, and js/googlemail.js's bodyTextFromPayload() prefers
// text/plain whenever ANY part exists, so it never falls through to
// stripHtml() here at all. Even stripHtml() wouldn't help regardless
// -- the Points/Qualifying Points figures are rendered as IMAGE ALT
// TEXT (`alt="20 Points"`), which textContent never sees (an
// attribute, not a text node), confirmed from the real HTML the user
// pasted directly. This extractor reads bodyHtml instead --
// getMessageDetail() already fetches it for the in-app mail reader,
// just unused by every other extractor here. Real example confirmed
// live: `alt="20 Points"`, `alt="20 Qualifying Points"`, a genuine
// plain-text "Miles" / "750" table-cell pair, and "Account balance
// from: 08-10-2026" (a real as-of date, DD-MM-YYYY).
function extractMilesAndMore(bodyText, subject, bodyHtml) {
const html = String(bodyHtml || '');
if (!html) return null;
const pointsMatch = html.match(/alt="(\d[\d,]*)\s*Points"/i);
const qualMatch = html.match(/alt="(\d[\d,]*)\s*Qualifying Points"/i);
const milesMatch = html.match(/>Miles<[\s\S]{0,400}?>([\d,]+)</i);
const dateMatch = html.match(/Account balance from:\s*(\d{2})-(\d{2})-(\d{4})/i);
if (!pointsMatch && !qualMatch && !milesMatch) return null;
const date = dateMatch ? `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}` : '';
const metrics = [];
if (milesMatch) metrics.push({ label: 'Miles', balance: Number(milesMatch[1].replace(/,/g, '')), unit: 'miles' });
if (pointsMatch) metrics.push({ label: 'Points', balance: Number(pointsMatch[1].replace(/,/g, '')), unit: 'points' });
if (qualMatch) metrics.push({ label: 'Qualifying points', balance: Number(qualMatch[1].replace(/,/g, '')), unit: 'points' });
return { membershipNumber: '', tier: '', date, metrics };
}

// Real example (this connector's own plaintext render of a real fetched
// email, 2026-05-21): "Retailer name:\nAgent Provocateur Date:\nThu 15
// January, 2026\nTotal amount: £616.00\nCashback earned:\n+£9.86" --
// retailer and "Date:" run together with only a space in THIS render,
// but the regex never assumes even that much (non-greedy `.+?` up to
// the next literal label, same discipline as every other extractor
// here) since this app's own bare stripHtml() may flatten the real
// HTML table with no separator at all. Each confirmed email is its own
// real, separate cashback amount -- never a running balance -- so
// `label` stays one fixed string ('Cashback confirmed', pre-classified
// 'voucher' in state.js's migrate()) and the retailer name goes into
// `detail` instead, which doesn't fragment the one-time classification
// the way folding it into `label` would.
//
// Quidco also sends an earlier "Your cashback has been tracked" email
// for the SAME purchase -- same four fields, a pending estimate rather
// than the final figure, reported directly as wanted alongside the
// confirmed one. Told apart by that exact phrase (confirmed live to
// appear as a plain heading in the body text, same place the pasted
// example shows it), labelled 'Cashback tracked' (also pre-classified
// 'voucher' in state.js) so it's never mistaken for the same reading.
// `reference` is `retailer|total amount` -- stable across both emails
// for the one purchase (the cashback figure itself can shift between
// tracked and confirmed, the order total doesn't) -- which is what
// lets runLoyaltyBalanceScan's own post-pass below recognise a
// confirmed reading as superseding its matching tracked one, and what
// lets a tracked reading already turned into a voucher be offered as a
// confident "Update" match (vouchers.js's own reference-first
// matching) rather than "add as new" once the confirmed email arrives.
function extractQuidco(bodyText, subject) {
const text = String(bodyText || '');
const cashMatch = text.match(/Cashback earned:\s*\+?£([\d.,]+)/i);
if (!cashMatch) return null;
const retailerDateMatch = text.match(/Retailer name:\s*(.+?)\s*Date:\s*\w*\s*(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})/i);
const retailer = retailerDateMatch ? retailerDateMatch[1].trim() : '';
const date = retailerDateMatch ? parseDMonYyyy(retailerDateMatch[2], retailerDateMatch[3], retailerDateMatch[4]) : '';
const totalMatch = text.match(/Total amount:\s*£([\d.,]+)/i);
const total = totalMatch ? Number(totalMatch[1].replace(/,/g, '')) : null;
// Real example confirmed live (Gmail connector, 26 Sept 2026 message):
// the body text itself reads "Your cashback has been\ntracked" -- a
// genuine newline between "been" and "tracked", not a space. A
// literal-space match against bodyText alone (the first version of
// this) silently fell through to "confirmed" for EVERY tracked email,
// mislabelling all of them -- same class of bug this file has hit
// before (BA/Marriott/Virgin/TopCashback's own body-flattening traps).
// The subject line has no such risk (confirmed as the clean, complete
// "Your cashback has been tracked"/"...confirmed" string), so it's
// checked first; the body-text check (now tolerant of the real
// newline via \s+) is only a fallback for the rare case subject isn't
// available.
const isTracked = /cashback has been tracked/i.test(String(subject || '')) || /cashback has been\s+tracked/i.test(text);
const label = isTracked ? 'Cashback tracked' : 'Cashback confirmed';
return {
membershipNumber: '', tier: '', date,
metrics: [{
label, balance: Number(cashMatch[1].replace(/,/g, '')), unit: '£', detail: retailer,
reference: retailer && total != null ? `${retailer}|${total.toFixed(2)}` : '',
}],
};
}

// Real example (two real fetched emails, confirmed live): the pasted
// Gmail view shows a clean "eBay\nCashback amount: £3.46" line, but
// the REAL underlying text is nothing like that -- confirmed via the
// Gmail connector: "...topcashback.co.uk/ebay/reviews/Cashback
// amount: £3.46Loved your experience?...Leave a review for eBay »
// (http://www.topcashback.co.uk/ebay/reviews/)...". The retailer name
// is NOT adjacent to the amount at all -- it only exists, as real
// readable text, in a "Leave a review for X »" prompt further down.
// This is exactly the "what you see in the Gmail app isn't what the
// real HTML flattens to" trap this file has hit before (BA, Marriott,
// Virgin) -- never trust a pasted example without verifying the real
// fetched body first. A second real example confirmed the same shape
// with a different retailer and amount (Santander, £20.00) -- both
// single-retailer emails, matched 1:1 below; a genuinely
// multi-retailer email (the intro text says "a summary of what's been
// updated", plural) isn't confirmed either way, so counts are only
// paired when they actually match -- otherwise the amount is kept
// with no retailer guessed, rather than risking a wrong pairing.
// TopCashback's own wording ("you might've already spotted it...just
// in case") suggests the SAME payable amount can be re-notified -- the
// existing same-value "apply to all" default in vouchers.js already
// handles that correctly with no TopCashback-specific code needed.
function extractTopCashback(bodyText) {
const text = String(bodyText || '');
const amounts = [...text.matchAll(/Cashback amount:\s*£([\d.,]+)/gi)].map((m) => Number(m[1].replace(/,/g, '')));
if (!amounts.length) return null;
const retailers = [...text.matchAll(/Leave a review for\s+(.+?)\s*»/gi)].map((m) => m[1].trim());
const pairable = retailers.length === amounts.length;
return {
membershipNumber: '', tier: '', date: '',
metrics: amounts.map((balance, i) => ({ label: 'Cashback confirmed', balance, unit: '£', detail: pairable ? retailers[i] : '' })),
};
}

const EXTRACTORS = {
'ba': extractBritishAirways,
'marriott-bonvoy': extractMarriottBonvoy,
'virgin-flying-club': extractVirginFlyingClub,
'boots': extractBoots,
'tesco-clubcard': extractTescoClubcard,
'ba-evoucher': extractBaVoucher,
'hertz': extractHertz,
'sixt': extractSixt,
'miles-and-more': extractMilesAndMore,
'quidco': extractQuidco,
'topcashback': extractTopCashback,
};

// ---- Scan engine ----------------------------------------------------------

function isProgramDue(program, force) {
return !!force || !program.lastCheckedAt || daysSince(program.lastCheckedAt) >= CADENCE_DAYS;
}

function dateFromHeader(dateHeader) {
const d = new Date(dateHeader);
return Number.isNaN(d.getTime()) ? todayStr() : d.toISOString().slice(0, 10);
}

// Reported directly: running all 9 programs back-to-back hit Gmail API
// 403s on the LAST two (Sixt, Miles & More) while everything earlier
// succeeded -- consistent with a short-lived rate-limit burst from
// firing a search + several message fetches per program with no
// pacing at all, not a per-program problem. Retries ONLY a 403 (a
// genuine error, e.g. a bad query, fails immediately rather than
// wasting 1.5s pretending a retry might help); two more attempts
// after the first, spaced out, is usually enough for a transient
// quota burst to clear.
async function withRetryOn403(fn) {
let lastErr;
for (let attempt = 0; attempt < 3; attempt++) {
try {
return await fn();
} catch (err) {
lastErr = err;
if (!/\b403\b/.test(String(err?.message || ''))) throw err;
await new Promise((r) => setTimeout(r, 1500));
}
}
throw lastErr;
}

// One program: search, fetch any new messages, extract, store. Never
// throws -- a single bad message or a failed AI call is logged and
// skipped so it can't take the rest of the scan down with it.
async function scanOneProgram(program, { force } = {}) {
if (!program.active || !program.senderAddresses.length) return null;
if (!isProgramDue(program, force)) return { programId: program.id, programName: program.name, skipped: true };

// contentFilter (e.g. `"Your account summary"` for Virgin,
// `subject:"mileage balance"` for Miles & More) narrows a high-volume
// sender down to the emails actually worth fetching -- reported
// directly as worth doing, both for efficiency and because it surfaces
// the right email even if pure marketing from the same sender would
// otherwise crowd it out of the fetch window.
const query = `from:(${program.senderAddresses.join(' OR ')})${program.contentFilter ? ` ${program.contentFilter}` : ''}`;
let messages = [];
try {
// 400 days, not 60 -- confirmed live as a real bug: Boots' own
// "account balance" email (used to write this feature's own Boots
// extractor) was ~6 months old, Tesco's ~75 days, both already
// outside a 60-day window, so Gmail's own `newer_than:` cut them
// before the extractor ever ran -- this looked exactly like a failed
// regex match but wasn't one. seenMessageIds-based dedup (not a
// sliding "since last check" cursor) means a wide window costs
// nothing on repeat scans -- an already-processed message is skipped
// instantly regardless of how far back the search reaches.
// maxEvents feeds fetchMailSearches' own headroom math (ceil(n*1.5)+5)
// -- 15 gave a hard cap of exactly 28 message ids per search, most
// recent first. Confirmed live as a real problem, not just theory: a
// program sending frequent pure-marketing mail (Virgin especially,
// per this feature's own research) can push its rarer, genuinely
// useful template (an occasional account-summary email, not every
// send) past the 28 most recent before the extractor ever sees it --
// "28 emails found, none recognised" is exactly what that looks like.
// Raised to 40 (fetch cap ~65) to cut the odds of that; seenMessageIds
// dedup means a wider net costs nothing extra on repeat scans.
const [section] = await withRetryOn403(() => fetchMailSearches([{ kind: 'query', value: query, maxDays: 400, maxEvents: 40 }]));
messages = section?.messages || [];
} catch (err) {
return { programId: program.id, programName: program.name, error: err.message };
}

const seen = new Set(program.seenMessageIds || []);
let matched = 0;
let unmatched = 0;
let alreadySeen = 0;
const newRows = [];

for (const msg of messages) {
if (seen.has(msg.id)) { alreadySeen++; continue; }
let detail;
try { detail = await withRetryOn403(() => getMessageDetail(msg.id)); } catch (err) { continue; } // transient fetch failure -- try again next scan, don't mark seen

const extractor = EXTRACTORS[program.extractorKey];
let result = extractor ? extractor(detail.bodyText, detail.subject, detail.bodyHtml) : null;
let method = extractor ? 'deterministic' : '';
let usedAi = false;

if (!result && !extractor) {
try {
const { extractLoyaltyBalanceWithAI } = await import('../ai.js');
const ai = await extractLoyaltyBalanceWithAI(program.name, detail.bodyText);
program.aiCallCount = (program.aiCallCount || 0) + 1;
program.lastAiCallAt = new Date().toISOString();
method = 'ai';
usedAi = true;
if (Number.isFinite(ai.balance)) {
result = { membershipNumber: ai.membershipNumber, tier: ai.tier, date: '', metrics: [{ label: 'Balance', balance: ai.balance, unit: ai.unit, expiryDate: ai.expiryDate }] };
}
} catch (err) { /* AI fallback failing shouldn't block the rest of the scan */ }
}

// Only mark "seen" when the message matched, or when a real AI call
// already ran against it (re-billing the same stubborn message every
// scan would be worse than never finishing it). A deterministic
// extractor that didn't match stays UNSEEN on purpose -- confirmed
// live as a real bug: the BA eVoucher "issued" email was marked seen
// by the OLD extractor (which only recognised the "used" format), so
// fixing that extractor afterward had nothing left to re-process; the
// user kept seeing only the "used" voucher no matter how the regex
// was improved. Regex checks are free, so retrying an unmatched one
// every scan costs nothing.
if (result || usedAi) seen.add(msg.id);

if (!result) { unmatched++; continue; }
matched++;
if (method) program.extractionMethod = method;
if (result.membershipNumber && !program.membershipNumber) program.membershipNumber = result.membershipNumber;
const date = result.date || dateFromHeader(detail.date);
result.metrics.forEach((metric) => {
// Guards against a real duplicate if this exact (program, message,
// label) was already recorded by an earlier scan -- what makes
// "Forget processed emails" (below) safe to offer: without this, re-
// scanning a message whose id was manually cleared from
// seenMessageIds would re-create a second identical reading instead
// of just reaching the one case that's actually new.
const alreadyRecorded = data.loyaltyBalances.some((b) => b.programId === program.id && b.sourceMessageId === msg.id && b.label === metric.label);
if (alreadyRecorded) return;
newRows.push(blankLoyaltyBalance({
programId: program.id, label: metric.label, date,
balance: metric.balance, unit: metric.unit || '',
tier: result.tier || '', expiryDate: metric.expiryDate || '',
sourceMessageId: msg.id, reference: metric.reference || '',
detail: metric.detail || '',
}));
});
}

program.seenMessageIds = [...seen];
program.lastCheckedAt = new Date().toISOString();
if (newRows.length) data.loyaltyBalances.push(...newRows);
// Quidco's tracked->confirmed lifecycle (see extractQuidco's own
// comment): a newly-confirmed reading supersedes the matching tracked
// one, by the shared retailer|total-amount reference. Only when the
// tracked reading hasn't already been turned into a voucher -- one
// that has is left for the user to resolve normally, where the SAME
// reference match now offers "Update" instead of "Add as new" (see
// vouchers.js). Skipping (not deleting) keeps the tracked reading's
// own history intact while dropping it out of the voucher-review
// queue, exactly as if the user had declined to voucher it themselves.
if (program.extractorKey === 'quidco' && newRows.length) {
newRows.filter((r) => r.label === 'Cashback confirmed' && r.reference).forEach((confirmed) => {
const tracked = data.loyaltyBalances.find((b) => b.programId === program.id && b.label === 'Cashback tracked' && b.reference === confirmed.reference && !b.voucherLinkStatus);
if (tracked) tracked.voucherLinkStatus = 'skipped';
});
}
return { programId: program.id, programName: program.name, matched, unmatched, newRows: newRows.length, messagesFound: messages.length, alreadySeen };
}

async function runLoyaltyBalanceScan({ force } = {}) {
const results = [];
for (const program of data.loyaltyPrograms) {
const result = await scanOneProgram(program, { force });
if (result) results.push(result);
// A small gap between programs, not just the 403 retry above --
// spreads out the burst of searches + message fetches across 9
// programs instead of firing them in a tight loop, which is the more
// likely reason a 403 only showed up on the LAST couple of programs.
await new Promise((r) => setTimeout(r, 300));
}
queueSave();
return results;
}

// Never a bare count, per this project's own standing convention --
// names which programs/labels/dates actually changed. Reported
// directly as a real gap: a program that scanned fine but found
// nothing new used to be silently dropped from this message entirely
// (the old `if (!r.newRows) return;`), which read as "this program
// wasn't checked at all" rather than "checked, nothing new" -- every
// result now gets its own line, no matter how uneventful.
function summariseResults(results) {
const lines = [];
results.forEach((r) => {
if (!r) return;
if (r.skipped) { lines.push(`${r.programName || r.programId}: already checked this month (use Check now to force it).`); return; }
if (r.error) { lines.push(`${r.programName || r.programId}: scan failed — ${r.error}`); return; }
if (!r.newRows) {
// Three genuinely different states, confirmed live as worth telling
// apart: the search found nothing at all (maybe the wrong sender, or
// genuinely nothing in 400 days); it found the SAME emails as a
// previous successful scan and correctly skipped them (expected,
// not a problem); or it found emails but none of them matched the
// extractor (worth knowing, possibly a template that's changed).
// These used to collapse into one "nothing new" line that read the
// same whether a program's search had ever actually worked or not.
if (!r.messagesFound) {
lines.push(`${r.programName}: no matching emails found in the last 400 days.`);
} else if (r.alreadySeen && !r.unmatched) {
lines.push(`${r.programName}: up to date — ${r.alreadySeen} matching email${r.alreadySeen === 1 ? '' : 's'} found, already processed from an earlier scan.`);
} else {
lines.push(`${r.programName}: ${r.messagesFound} email${r.messagesFound === 1 ? '' : 's'} found, none recognised${r.alreadySeen ? ` (${r.alreadySeen} already processed)` : ''}.`);
}
return;
}
lines.push(`${r.programName} — found ${r.newRows} new reading${r.newRows === 1 ? '' : 's'}${r.unmatched ? ` (${r.unmatched} email${r.unmatched === 1 ? '' : 's'} not recognised)` : ''}.`);
});
return lines.length ? lines.join(' ') : 'Nothing checked — no active programs with a sender address configured.';
}

// ---- Travel-strip / ticker helper -----------------------------------------
// Programs flagged showOnTravel, each with its latest reading per
// label -- shared by the Travel-tab summary strip and the Overview
// ticker's rotating 'loyalty' tile, so there's exactly one place that
// decides "what counts as the latest figure."
function latestBalancesFor(program) {
const rows = data.loyaltyBalances.filter((b) => b.programId === program.id);
const byLabel = new Map();
rows.forEach((r) => {
const prev = byLabel.get(r.label);
if (!prev || r.date > prev.date) byLabel.set(r.label, r);
});
return [...byLabel.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function travelStripPrograms() {
return data.loyaltyPrograms
.filter((p) => p.showOnTravel)
.map((p) => ({ program: p, readings: latestBalancesFor(p) }))
.filter((x) => x.readings.length);
}

function voucherChipHtmlFor(voucherId) {
const voucher = data.vouchers.find((v) => v.id === voucherId);
return voucher ? voucherChipHtml(voucher) : '';
}

// ---- Voucher classification + linking (Vouchers & Credits panel) --------
// Whether a (programId, label) pair is a running balance or a voucher-
// shaped event (BA eVoucher, Hertz's "free day earned") is a decision
// the USER makes once, not something baked into extractor code -- a
// program added later via "+ Add program" may have no deterministic
// extractor at all (just the AI fallback), which has no branch to hard-
// code a flag onto. Cached in data.loyaltyLabelKinds so the 50+ plain
// Avios readings per scan are classified once, ever, and never surface
// in the review queue again after that.
function labelKindFor(programId, label) {
const row = data.loyaltyLabelKinds.find((k) => k.programId === programId && k.label === label);
return row ? row.kind : undefined;
}
function setLabelKind(programId, label, kind) {
const row = data.loyaltyLabelKinds.find((k) => k.programId === programId && k.label === label);
if (row) row.kind = kind;
else data.loyaltyLabelKinds.push({ programId, label, kind });
queueSave();
}

// Grouped by (programId, label), one row per label still needing a
// balance-vs-voucher decision -- NOT one per historical reading.
// Reported directly as a real bug: a label scanned monthly for years
// (BA's Avios, say) showed the identical question once per past
// reading, 164 rows deep on a first-ever open of this feature. Shows
// up to the 3 most recent readings (with their dates) so the decision
// isn't made blind, and how many more exist beyond that.
function pendingClassifications() {
const groups = new Map();
data.loyaltyBalances.forEach((reading) => {
if (labelKindFor(reading.programId, reading.label) !== undefined) return;
const program = data.loyaltyPrograms.find((p) => p.id === reading.programId);
if (!program) return;
const key = `${reading.programId}|${reading.label}`;
if (!groups.has(key)) groups.set(key, { programId: reading.programId, program, label: reading.label, readings: [] });
groups.get(key).readings.push(reading);
});
return [...groups.values()].map((g) => {
const sorted = [...g.readings].sort((a, b) => b.date.localeCompare(a.date));
return { programId: g.programId, program: g.program, label: g.label, samples: sorted.slice(0, 3), total: sorted.length };
});
}

// One row per READING here, deliberately not deduped by label -- unlike
// classification, each voucher-shaped reading (an eVoucher issued, a
// free day earned) is its own genuine event that may need its own
// add/update/skip decision, not a repeat of the same question.
function pendingVoucherLinks() {
return data.loyaltyBalances
.map((reading) => ({ reading, program: data.loyaltyPrograms.find((p) => p.id === reading.programId) }))
.filter((x) => x.program && labelKindFor(x.reading.programId, x.reading.label) === 'voucher' && !x.reading.voucherLinkStatus);
}

function markVoucherLinked(readingId, voucherId) {
const reading = data.loyaltyBalances.find((b) => b.id === readingId);
if (!reading) return;
reading.voucherLinkStatus = 'linked';
reading.voucherId = voucherId;
queueSave();
}
function markVoucherSkipped(readingId) {
const reading = data.loyaltyBalances.find((b) => b.id === readingId);
if (!reading) return;
reading.voucherLinkStatus = 'skipped';
queueSave();
}

// ---- Rendering --------------------------------------------------------

// Per-program "Check now" status text, outside the saved data (purely
// ephemeral UI feedback) -- a full renderLoyaltyBalances() rebuilds
// the whole card list's innerHTML, which would otherwise wipe the
// status span the instant it's set (confirmed live: the message
// appeared then vanished immediately). Same "module-level message
// variable survives its own re-render" idiom as manualimport.js's
// manualImportMessage, just keyed per program since several cards can
// each have their own independent status.
const lastCheckMessages = new Map();

function methodBadgeHtml(program) {
if (program.extractionMethod === 'ai') return `<span class="tag-chip tag-chip-amber" title="Costs an AI call each scan — come back and ask for a deterministic extractor once you're confident this one's worth keeping.">AI-parsed (${program.aiCallCount || 0}x)</span>`;
if (program.extractionMethod === 'deterministic') return `<span class="tag-chip" title="A real pattern match, no AI call — free and exact.">Deterministic</span>`;
// Marriott Vacation Club only, as of writing -- there's no email to
// scan at all, this number only ever arrives by hand-pasting a
// DevTools console script's output. Links back to that script's own
// "Copy scan script" step (Travel tab), per CLAUDE.md's rule that a
// location named anywhere must be a real link, not bare prose.
if (program.extractionMethod === 'manual-scrape') return `<span class="tag-chip tag-chip-blue inline-goto-link" data-goto-tab="travel" data-goto-target="#mvc-copy-btn" title="Not scanned from email -- pasted by hand from a DevTools console script run against the provider's own site. Click to jump to the scan script.">Manual scrape</span>`;
return '';
}

function programCardHtml(program) {
const readings = latestBalancesFor(program);
// Same row anatomy as .voucher-row (vouchers.js) -- an id/meta column,
// a wide middle column, a right-aligned date, and an actions column --
// reported directly as wanting visual parity between the two panels,
// now that readings can link into real voucher records.
const rows = readings.map((r) => {
const valueText = r.balance != null ? (r.unit === '£' || r.unit === '£ worth of points' ? `£${r.balance.toLocaleString('en-GB')}` : r.balance.toLocaleString('en-GB')) : '—';
return `<div class="loyalty-reading" data-loyalty-reading="${escapeHtml(r.id)}">
<div class="loyalty-reading-id">
<span class="loyalty-reading-label">${escapeHtml(r.label)}</span>
<div class="loyalty-reading-meta">
<span class="loyalty-reading-value">${escapeHtml(valueText)}</span>
${r.unit && r.unit !== '£' ? `<span class="loyalty-reading-unit">${escapeHtml(r.unit)}</span>` : ''}
</div>
</div>
<div class="loyalty-reading-notes">${escapeHtml(r.detail || (r.sourceMessageId === 'manual' ? 'Entered by hand' : ''))}</div>
<div class="loyalty-reading-date">
<span class="loyalty-reading-asof">as of ${escapeHtml(r.date)}</span>
${r.expiryDate ? `<span class="expiry-badge">expires ${escapeHtml(r.expiryDate)}</span>` : ''}
</div>
<div class="loyalty-reading-actions">
${r.voucherId ? voucherChipHtmlFor(r.voucherId) : ''}
</div>
</div>`;
}).join('');
const tier = readings.find((r) => r.tier)?.tier || '';
const programInitials = (program.name || '?').trim().slice(0, 2).toUpperCase();
return `<div class="account-card" data-loyalty-program="${escapeHtml(program.id)}">
<div class="account-summary" style="cursor:default;">
${logoBadgeHtml(program.logoUrl, programInitials, 'plum')}
<strong>${escapeHtml(program.name)}</strong>
${tier ? `<span class="tag-chip tag-chip-blue">${escapeHtml(tier)}</span>` : ''}
${methodBadgeHtml(program)}
${!program.active ? '<span class="candidate-tag">inactive</span>' : ''}
</div>
${rows || `<div class="empty">${program.id === 'loyalty-marriott-vc'
? `No readings yet. This one isn't scanned from email -- paste a scan's results into <span class="inline-goto-link" data-goto-tab="travel" data-goto-target="#mvc-import-read-btn">Marriott availability &rarr; Import results</span> on the Travel tab, and its points balance is recorded here too.`
: 'No readings yet — run a scan, or Check now below.'}</div>`}
<details class="settings-item loyalty-settings-item">
<summary class="loyalty-settings-summary"><h3>Settings</h3></summary>
<div class="settings-block" style="margin-top:6px;">
<label><input type="checkbox" ${program.showOnTravel ? 'checked' : ''} data-loyalty-show-travel="${escapeHtml(program.id)}"> Show on Travel tab</label>
<label><input type="checkbox" ${program.active ? 'checked' : ''} data-loyalty-active="${escapeHtml(program.id)}"> Active</label>
${program.senderAddresses.length || program.id !== 'loyalty-marriott-vc' ? `<div class="sync-row" style="margin-top:6px;">
<input type="text" value="${escapeHtml((program.senderAddresses || []).join(', '))}" placeholder="Sender address(es), comma separated" data-loyalty-senders="${escapeHtml(program.id)}" style="flex:1 1 260px;">
</div>
<div class="sync-row">
<input type="text" value="${escapeHtml(program.membershipNumber)}" placeholder="Membership number (optional)" data-loyalty-member="${escapeHtml(program.id)}" style="flex:1 1 200px;">
<button type="button" class="sync-btn sm inline" data-loyalty-check-now="${escapeHtml(program.id)}">Check now</button>
<button type="button" class="sync-btn sm inline" data-loyalty-forget="${escapeHtml(program.id)}" title="Clears this program's record of which emails it's already looked at, so the next check re-examines everything in the last 400 days -- safe to use (a message already recorded won't be duplicated), useful after an extractor fix so a previously-unrecognised email gets a fresh try.">Forget processed emails</button>
${!program.builtIn ? `<button type="button" class="sync-btn sm inline" data-loyalty-remove="${escapeHtml(program.id)}">Remove</button>` : ''}
</div>
<div class="settings-note" id="loyalty-status-${escapeHtml(program.id)}">${escapeHtml(lastCheckMessages.get(program.id) || '')}</div>` : `<div class="settings-note">No email scan for this one -- its points balance comes from pasting a scan's results into <span class="inline-goto-link" data-goto-tab="travel" data-goto-target="#mvc-import-read-btn">Marriott availability &rarr; Import results</span> on the Travel tab.</div>`}
<div class="settings-note" style="margin:8px 0 2px;font-weight:600;">Record a reading by hand</div>
<div class="sync-row" style="align-items:flex-start;">
<input type="text" placeholder="Label, e.g. Gold Plus points" data-loyalty-manual-label="${escapeHtml(program.id)}" style="flex:1 1 160px;">
<input type="text" placeholder="Balance" data-loyalty-manual-balance="${escapeHtml(program.id)}" style="flex:0 1 90px;">
<input type="text" placeholder="Unit (optional)" data-loyalty-manual-unit="${escapeHtml(program.id)}" style="flex:0 1 110px;">
<button type="button" class="sync-btn sm inline" data-loyalty-manual-add="${escapeHtml(program.id)}">Record</button>
</div>
</div>
</details>
</div>`;
}

function renderLoyaltyBalances() {
const panel = document.getElementById('loyalty-balances-panel');
if (!panel) return;
const list = document.getElementById('loyalty-balances-list');
if (list) { list.innerHTML = data.loyaltyPrograms.map(programCardHtml).join(''); bindLogoFallbacks(list); }
const countEl = document.getElementById('loyalty-balances-count');
if (countEl) {
const n = data.loyaltyPrograms.filter((p) => p.active).length;
countEl.textContent = n ? `${n} program${n === 1 ? '' : 's'}` : '';
}
renderTravelStrip();
bindLoyaltyBalances(panel);
}

function renderTravelStrip() {
const mount = document.getElementById('travel-loyalty-strip');
if (!mount) return;
const entries = travelStripPrograms();
if (!entries.length) { mount.innerHTML = ''; return; }
mount.innerHTML = `<div class="sync-row" style="align-items:flex-start;flex-wrap:wrap;">${entries.map(({ program, readings }) =>
readings.map((r) => `<span class="tag-chip" title="${escapeHtml(program.name)} — as of ${escapeHtml(r.date)}">${escapeHtml(program.name)}: ${r.balance != null ? escapeHtml(r.balance.toLocaleString('en-GB')) : '—'} ${escapeHtml(r.unit)}</span>`).join('')
).join('')}</div>`;
}

function bindLoyaltyBalances(panel) {
if (panel.dataset.loyaltyBound) return;
panel.dataset.loyaltyBound = '1';
panel.addEventListener('change', (e) => {
const showTravel = e.target.closest('[data-loyalty-show-travel]');
if (showTravel) {
const program = data.loyaltyPrograms.find((p) => p.id === showTravel.dataset.loyaltyShowTravel);
if (program) { program.showOnTravel = showTravel.checked; queueSave(); renderLoyaltyBalances(); }
return;
}
const activeToggle = e.target.closest('[data-loyalty-active]');
if (activeToggle) {
const program = data.loyaltyPrograms.find((p) => p.id === activeToggle.dataset.loyaltyActive);
if (program) { program.active = activeToggle.checked; queueSave(); renderLoyaltyBalances(); }
return;
}
const sendersInput = e.target.closest('[data-loyalty-senders]');
if (sendersInput) {
const program = data.loyaltyPrograms.find((p) => p.id === sendersInput.dataset.loyaltySenders);
if (program) { program.senderAddresses = sendersInput.value.split(',').map((s) => s.trim()).filter(Boolean); queueSave(); }
return;
}
const memberInput = e.target.closest('[data-loyalty-member]');
if (memberInput) {
const program = data.loyaltyPrograms.find((p) => p.id === memberInput.dataset.loyaltyMember);
if (program) { program.membershipNumber = memberInput.value.trim(); queueSave(); }
}
});
panel.addEventListener('click', async (e) => {
const checkBtn = e.target.closest('[data-loyalty-check-now]');
if (checkBtn) {
const programId = checkBtn.dataset.loyaltyCheckNow;
const program = data.loyaltyPrograms.find((p) => p.id === programId);
const statusEl = document.getElementById(`loyalty-status-${programId}`);
if (!program) return;
checkBtn.disabled = true;
lastCheckMessages.set(programId, 'Checking…');
if (statusEl) statusEl.textContent = 'Checking…';
const result = await scanOneProgram(program, { force: true });
queueSave();
lastCheckMessages.set(programId, summariseResults([result]));
renderLoyaltyBalances();
return;
}
const manualAddBtn = e.target.closest('[data-loyalty-manual-add]');
if (manualAddBtn) {
const programId = manualAddBtn.dataset.loyaltyManualAdd;
const card = manualAddBtn.closest('[data-loyalty-program]');
const labelInput = card?.querySelector('[data-loyalty-manual-label]');
const balanceInput = card?.querySelector('[data-loyalty-manual-balance]');
const unitInput = card?.querySelector('[data-loyalty-manual-unit]');
const label = (labelInput?.value || '').trim();
const balanceNum = Number((balanceInput?.value || '').replace(/,/g, '').trim());
if (!label || !Number.isFinite(balanceNum)) return;
data.loyaltyBalances.push(blankLoyaltyBalance({
programId, label, date: todayStr(), balance: balanceNum,
unit: (unitInput?.value || '').trim(), tier: '', expiryDate: '', sourceMessageId: 'manual',
}));
// A hand-entered reading always carries a real number via this form --
// definitionally a balance, not a voucher event -- so it's classified
// immediately rather than sitting in the Vouchers review queue for no
// reason.
setLabelKind(programId, label, 'balance');
queueSave();
renderLoyaltyBalances();
return;
}
const forgetBtn = e.target.closest('[data-loyalty-forget]');
if (forgetBtn) {
const programId = forgetBtn.dataset.loyaltyForget;
const program = data.loyaltyPrograms.find((p) => p.id === programId);
if (!program) return;
if (!confirm(`Forget which ${program.name} emails have already been checked? The next scan will re-examine everything in the last 400 days (already-recorded readings won't be duplicated).`)) return;
program.seenMessageIds = [];
queueSave();
lastCheckMessages.set(programId, 'Forgotten — next check (or "Check now") will re-examine everything in the last 400 days.');
renderLoyaltyBalances();
return;
}
const removeBtn = e.target.closest('[data-loyalty-remove]');
if (removeBtn) {
const programId = removeBtn.dataset.loyaltyRemove;
if (!confirm('Remove this loyalty program and its stored readings?')) return;
data.loyaltyPrograms = data.loyaltyPrograms.filter((p) => p.id !== programId);
data.loyaltyBalances = data.loyaltyBalances.filter((b) => b.programId !== programId);
queueSave();
renderLoyaltyBalances();
}
});
}

function initLoyaltyBalances() {
const panel = document.getElementById('loyalty-balances-panel');
if (!panel) return;

const form = document.getElementById('loyalty-add-form');
const addBtn = document.getElementById('loyalty-add-btn');
addBtn?.addEventListener('click', () => {
const nameInput = document.getElementById('loyalty-add-name');
const senderInput = document.getElementById('loyalty-add-sender');
const name = nameInput.value.trim();
const senders = senderInput.value.split(',').map((s) => s.trim()).filter(Boolean);
if (!name || !senders.length) return;
data.loyaltyPrograms.push(blankLoyaltyProgram({ id: uid(), name, senderAddresses: senders, extractorKey: '', logoUrl: matchBrandLogo(name) || '' }));
queueSave();
nameInput.value = '';
senderInput.value = '';
renderLoyaltyBalances();
});

document.getElementById('loyalty-checknow-all-btn')?.addEventListener('click', async (e) => {
e.target.disabled = true;
const results = await runLoyaltyBalanceScan({ force: true });
const statusEl = document.getElementById('loyalty-scan-status');
if (statusEl) statusEl.textContent = summariseResults(results);
e.target.disabled = false;
renderLoyaltyBalances();
});

renderLoyaltyBalances();
}

export {
renderLoyaltyBalances, initLoyaltyBalances, runLoyaltyBalanceScan,
extractBritishAirways, extractMarriottBonvoy, extractVirginFlyingClub, extractBoots, extractTescoClubcard, extractBaVoucher,
extractHertz, extractSixt, extractMilesAndMore, extractQuidco, extractTopCashback,
latestBalancesFor, travelStripPrograms,
labelKindFor, setLabelKind, pendingClassifications, pendingVoucherLinks, markVoucherLinked, markVoucherSkipped,
};
