// Airbnb booking requests and enquiries, read from the inbox.
//
// Two of Airbnb's host emails carry a guest's interest before anything is booked:
//   "Pending: Reservation Request at <listing title> for 27–29 Nov 2026" (Request to Book:
//     guest, "Identity verified · 30 reviews", city, the listing's rooms id, check-in/out,
//     party size, "Based on your rate of £158 per night ... your potential payout for this
//     reservation is £317", and the HM... code the confirmed stay will carry), and
//   "Enquiry for <listing title> for 27 Nov – 5 Dec 2026" (a question with dates: the same
//     guest details and the Airbnb thread id, but no payout or code).
// "Reminder:" and "RE:" copies are not matched (the subject must start with one of the two).
//
// Each becomes a data.bookingRequests record (blankBookingRequest, state.js), including the
// ones that never became stays: that is the demand the booking evaluator calibrates
// against. Whether one became a stay is worked out here too (resolveRequestOutcomes).
import { data, queueSave, blankBookingRequest } from '../state.js';
import { escapeHtml, todayStr, dateStrAdd } from '../utils.js';
import { canAttemptGoogleAction } from '../sync/googleauth.js';
import { nightRateRooms } from './letting.js';

const QUERY = 'from:automated@airbnb.com (subject:"Pending: Reservation Request" OR subject:"Enquiry for")';
const SUBJECT_RE = /^(Pending:\s*Reservation Request at|Enquiry for)\s+(.+)\s+for\s+(\d.+)$/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const RECENT_LIMIT = 30;
// The backfill walks back this many months, one month per search, so no single search
// asks Gmail for hundreds of messages at once.
const BACKFILL_MONTHS = 24;
const BACKFILL_WINDOW_LIMIT = 30;

const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const monthIdx = (s) => MONTHS.indexOf(String(s || '').slice(0, 3).toLowerCase());
const num = (s) => (s == null ? null : Number(String(s).replace(/,/g, '')));

// "27–29 Nov 2026", "27 Nov – 5 Dec 2026", "30 Dec 2026 – 2 Jan 2027", or with no year at
// all, in which case the stay is the next one on or after the day the email arrived.
function parseDateRange(text, receivedIso) {
const m = /^(\d{1,2})(?:\s+([a-z]+))?(?:\s+(\d{4}))?\s*[–—-]\s*(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?/i.exec(String(text || '').trim());
if (!m) return null;
const endMonth = monthIdx(m[5]);
const startMonth = m[2] ? monthIdx(m[2]) : endMonth;
if (endMonth < 0 || startMonth < 0) return null;
const received = receivedIso || todayStr();
let endYear = m[6] ? Number(m[6]) : null;
let startYear = m[3] ? Number(m[3]) : null;
if (!endYear && !startYear) {
startYear = Number(received.slice(0, 4));
if (iso(startYear, startMonth + 1, Number(m[1])) < dateStrAdd(received, -1)) startYear += 1;
endYear = startMonth > endMonth ? startYear + 1 : startYear;
} else if (!startYear) startYear = startMonth > endMonth ? endYear - 1 : endYear;
else if (!endYear) endYear = startMonth > endMonth ? startYear + 1 : startYear;
const checkin = iso(startYear, startMonth + 1, Number(m[1]));
const checkout = iso(endYear, endMonth + 1, Number(m[4]));
return checkout > checkin ? { checkin, checkout } : null;
}

function listingForAirbnbId(airbnbId) {
if (!airbnbId) return null;
return (data.airbnbListings || []).find((l) => (String(l.icsUrl || '').match(/ical\/(\d+)/) || [])[1] === airbnbId) || null;
}

const decodeEntities = (s) => String(s || '').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');
const titleCase = (s) => String(s || '').toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (a, b, c) => b + c.toUpperCase());

// Everything one email says, or null when the subject isn't one of the two kinds. Pure,
// so it can be checked against a real email's text.
function parseRequestEmail({ subject, bodyText, snippet, receivedAt }) {
const sm = SUBJECT_RE.exec(String(subject || '').trim());
if (!sm) return null;
const kind = /^Enquiry/i.test(sm[1]) ? 'enquiry' : 'request';
const receivedIso = String(receivedAt || '').slice(0, 10) || todayStr();
const range = parseDateRange(sm[3], receivedIso);
if (!range) return null;
const body = String(bodyText || '');
// The name is the line just above the guest's avatar link; the "Respond to X's ..."
// heading (upper-cased in the text part) and the snippet are fallbacks.
let guestName = ((/\n([^\n[\]]{1,60}?)\s*\n+\s*\[https?:[^\]]*AVATAR/.exec(body) || [])[1] || '').trim();
if (!guestName) guestName = ((/Respond to (.+?)'s (?:request|enquiry)/i.exec(decodeEntities(snippet)) || [])[1] || '').trim();
if (!guestName) guestName = titleCase(((/RESPOND TO (.+?)[’']S (?:REQUEST|ENQUIRY)/.exec(body) || [])[1] || '').trim());
const reviewsMatch = /(\d+)\s+reviews?\b/i.exec(body.slice(0, 1500));
const newMember = /On Airbnb since \d{4}/i.test(body);
const cityMatch = /(?:reviews?|On Airbnb since \d{4})\s*\n\s*\n?\s*([^\n[\]]{2,60}?,[^\n[\]]{1,40})\s*\n/i.exec(body);
const guestsMatch = /GUESTS\s*\n+\s*(\d+)\s+adults?(?:[,\s]+(\d+)\s+(?:children|child))?/i.exec(body);
const airbnbListingId = (/\/rooms\/(\d+)/.exec(body) || [])[1] || '';
const listing = listingForAirbnbId(airbnbListingId);
return {
kind,
listingId: listing ? listing.id : '',
airbnbListingId,
listingTitle: sm[2].trim(),
checkin: range.checkin,
checkout: range.checkout,
guests: guestsMatch ? Number(guestsMatch[1]) + (guestsMatch[2] ? Number(guestsMatch[2]) : 0) : null,
guestName,
guestReviews: reviewsMatch ? Number(reviewsMatch[1]) : (newMember ? 0 : null),
identityVerified: /Identity verified/i.test(body),
guestCity: cityMatch ? cityMatch[1].trim() : '',
nightlyRate: num((/rate of £\s*([\d,]+(?:\.\d+)?)\s*per night/i.exec(body) || [])[1]),
payout: num((/payout for this\s+reservation is £\s*([\d,]+(?:\.\d+)?)/i.exec(body) || [])[1]),
confirmationCode: (/reservations\/details\/(HM[A-Z0-9]+)/.exec(body) || [])[1] || '',
airbnbThreadId: (/hosting\/thread\/(\d+)/.exec(body) || [])[1] || '',
receivedAt: receivedAt || '',
};
}

// Reads the emails of one Gmail search into data.bookingRequests. Messages already on file
// (by Gmail id) or that couldn't be read before are not fetched again.
async function readSearch(query, limit) {
const { fetchMailSearches, getMessageDetail } = await import('../googlemail.js');
const sections = await fetchMailSearches([{ kind: 'query', value: query, maxDays: 0, maxEvents: limit }], limit);
if (!Array.isArray(data.prefs.bookingRequestsSkipped)) data.prefs.bookingRequestsSkipped = [];
const skipped = new Set(data.prefs.bookingRequestsSkipped);
const known = new Set((data.bookingRequests || []).map((r) => r.messageId));
let added = 0;
let unmatchedListing = 0;
for (const m of sections[0]?.messages || []) {
if (known.has(m.id) || skipped.has(m.id)) continue;
if (!SUBJECT_RE.test(String(m.subject || '').trim())) { skipped.add(m.id); continue; }
let detail;
try { detail = await getMessageDetail(m.id); } catch (err) { console.error('Booking request email fetch failed:', err); continue; }
const receivedAt = new Date(m.date).toISOString();
const parsed = parseRequestEmail({ subject: m.subject, bodyText: detail.bodyText, snippet: m.snippet, receivedAt });
if (!parsed) { skipped.add(m.id); continue; }
if (!parsed.listingId) unmatchedListing++;
const { listingTitle, ...fields } = parsed;
data.bookingRequests.push(blankBookingRequest({ ...fields, messageId: m.id }));
known.add(m.id);
added++;
}
data.prefs.bookingRequestsSkipped = [...skipped];
return { added, unmatchedListing };
}

// Recent requests and enquiries, run with every Airbnb Sync.
async function syncBookingRequestsFromEmail() {
if (!(await canAttemptGoogleAction())) return { added: 0 };
let result;
try {
result = await readSearch(`${QUERY} newer_than:45d`, RECENT_LIMIT);
} catch (err) {
console.error('Booking request email search failed:', err);
return { added: 0, error: err.message || String(err) };
}
resolveRequestOutcomes();
queueSave();
return result;
}

// The whole history, a month at a time, newest first. Gmail limits how many reads a second an
// app may make (it answers 403 past that), so each month is a small search, there is a pause
// between months, and a refused month is retried after a longer wait. `onProgress(text)` for
// a status line.
async function backfillBookingRequests(onProgress = () => {}) {
if (!(await canAttemptGoogleAction())) return { added: 0, error: 'Not signed in to Google.' };
const fmt = (d) => d.replace(/-/g, '/');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let added = 0;
let unmatchedListing = 0;
let end = dateStrAdd(todayStr(), 1);
for (let i = 0; i < BACKFILL_MONTHS; i++) {
const start = dateStrAdd(end, -31);
let tries = 0;
for (;;) {
onProgress(`Reading ${start.slice(0, 7)}${tries ? ` (retry ${tries})` : ''}…`);
try {
const r = await readSearch(`${QUERY} after:${fmt(start)} before:${fmt(end)}`, BACKFILL_WINDOW_LIMIT);
added += r.added;
unmatchedListing += r.unmatchedListing;
break;
} catch (err) {
tries++;
if (tries > 3) {
console.error('Booking request backfill failed:', err);
resolveRequestOutcomes();
queueSave();
return { added, unmatchedListing, error: `${err.message || String(err)} (read up to ${end.slice(0, 7)}; run it again to carry on)` };
}
await wait(15000 * tries);
}
}
queueSave();
await wait(1500);
end = start;
}
data.prefs.bookingRequestsBackfilledAt = new Date().toISOString();
resolveRequestOutcomes();
queueSave();
return { added, unmatchedListing };
}

// The physical room a listing is (two listings of one room count as the same room).
function roomOf(listingId) {
const room = nightRateRooms().find((r) => r.listingIds.includes(listingId));
return room ? room.key : listingId;
}
function nameFits(stayName, reqName) {
const a = String(stayName || '').trim().toLowerCase();
const b = String(reqName || '').trim().toLowerCase().split(/\s+/)[0];
if (!a || !b) return true; // a stay with no name yet can still be this guest's
return a.startsWith(b) || a.includes(b);
}

// Whether each request or enquiry became a stay. A request matches by its HM code; failing
// that (and for an enquiry, which has none) by the same room, the same check-in or
// check-out, and a guest name that fits. With no stay, a request is 'not-booked' two days
// after it arrived (Airbnb gives 24 hours to answer) and an enquiry once its check-in has
// passed. A decision you set yourself ('declined') is left alone.
function resolveRequestOutcomes() {
const stays = data.airbnbReservations || [];
const today = todayStr();
let changed = 0;
(data.bookingRequests || []).forEach((q) => {
if (q.decision === 'declined' || q.decision === 'accepted') return;
let stay = q.confirmationCode ? stays.find((s) => s.confirmationCode === q.confirmationCode) : null;
if (!stay) {
stay = stays.find((s) => roomOf(s.listingId) === roomOf(q.listingId)
&& (s.checkin === q.checkin || s.checkout === q.checkout)
&& nameFits(s.guestName, q.guestName));
}
if (stay) {
q.decision = 'accepted';
q.reservationId = stay.id;
q.decidedOn = stay.confirmedOn || String(q.receivedAt || '').slice(0, 10);
changed++;
return;
}
const received = String(q.receivedAt || '').slice(0, 10);
const lapsed = q.kind === 'request' ? received && dateStrAdd(received, 2) < today : q.checkin < today;
if (lapsed && q.decision !== 'not-booked') { q.decision = 'not-booked'; changed++; }
});
return changed;
}

// ---- List on the Airbnb panel ---------------------------------------------------

const DECISION_LABEL = { '': 'Waiting', accepted: 'Became a stay', 'not-booked': 'Not booked', declined: 'Declined' };
const nightsOf = (q) => Math.round((new Date(`${q.checkout}T00:00:00`) - new Date(`${q.checkin}T00:00:00`)) / 86400000);
const shortDate = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

function requestRowHtml(q, stayChip) {
const listing = (data.airbnbListings || []).find((l) => l.id === q.listingId);
const n = nightsOf(q);
const money = q.payout != null ? `£${Math.round(q.payout)}` : (q.nightlyRate != null ? `£${Math.round(q.nightlyRate)}/night` : '');
const who = `${q.guestName || 'Guest'}${q.guestReviews != null ? ` · ${q.guestReviews} review${q.guestReviews === 1 ? '' : 's'}` : ''}${q.identityVerified ? '' : ' · not verified'}`;
const stay = q.reservationId ? (data.airbnbReservations || []).find((r) => r.id === q.reservationId) : null;
const outcome = q.decision === 'accepted' && stay ? stayChip(stay) : `<span class="bkreq-outcome ${escapeHtml(q.decision || 'waiting')}">${escapeHtml(DECISION_LABEL[q.decision] || q.decision)}</span>`;
return `<div class="bkreq-row" data-bkreq="${escapeHtml(q.id)}">
<span class="bkreq-kind ${escapeHtml(q.kind)}">${q.kind === 'enquiry' ? 'Enquiry' : 'Request'}</span>
<span class="bkreq-dates"><span class="dot ${escapeHtml((listing && listing.colour) || 'slate')}" title="${escapeHtml((listing && listing.label) || 'Listing not matched')}"></span>${escapeHtml(`${shortDate(q.checkin)} – ${shortDate(q.checkout)}`)} <span class="settings-note" style="margin:0;">${n} night${n === 1 ? '' : 's'}</span></span>
<span class="bkreq-who">${escapeHtml(who)}</span>
<span class="bkreq-money">${escapeHtml(money)}</span>
<span class="bkreq-out">${outcome}</span>
${q.checkin >= todayStr() ? `<button class="sync-btn sm inline" type="button" data-bkreq-eval="${escapeHtml(q.id)}" title="Weigh accepting this against keeping the dates open">Evaluate</button>` : ''}
${q.messageId ? `<span class="bkreq-mail" data-bkreq-open="${escapeHtml(q.messageId)}" title="Read the email">&#9993;</span>` : ''}
</div>`;
}

let bound = false;
async function renderBookingRequests() {
const el = document.getElementById('booking-requests');
if (!el) return;
const { stayChipHtml, bindStayChips } = await import('./airbnb.js');
bindStayChips();
const all = (data.bookingRequests || []).slice().sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)));
const today = todayStr();
const open = all.filter((q) => q.checkout >= today);
const past = all.filter((q) => q.checkout < today);
const requests = all.filter((q) => q.kind === 'request');
const became = requests.filter((q) => q.decision === 'accepted').length;
const since = all.length ? String(all[all.length - 1].receivedAt).slice(0, 10) : '';
const summary = all.length
? `${requests.length} request${requests.length === 1 ? '' : 's'} (${became} became stays) and ${all.length - requests.length} enquir${all.length - requests.length === 1 ? 'y' : 'ies'} on file${since ? ` since ${shortDate(since)} ${since.slice(0, 4)}` : ''}.`
: 'None read yet.';
const wasOpen = el.open;
el.innerHTML = `<summary>Requests and enquiries <span class="settings-note" style="margin:0;">${open.length ? `${open.length} for upcoming dates` : ''}</span></summary>
<div class="settings-note" style="margin:4px 0 6px;">Every booking request and enquiry read from your inbox, including the ones that never became stays: the demand the booking evaluator learns from. ${escapeHtml(summary)}</div>
<div class="bkreq-list">${open.map((q) => requestRowHtml(q, stayChipHtml)).join('') || '<div class="settings-note" style="margin:0;">None for upcoming dates.</div>'}</div>
${past.length ? `<details style="margin-top:6px;"><summary class="settings-note" style="margin:0;cursor:pointer;">Earlier (${past.length})</summary><div class="bkreq-list">${past.slice(0, 200).map((q) => requestRowHtml(q, stayChipHtml)).join('')}</div></details>` : ''}
<div class="sync-row" style="margin-top:8px;align-items:center;">
<button class="sync-btn sm inline" type="button" id="booking-requests-backfill" title="Reads every request and enquiry email from the last ${BACKFILL_MONTHS} months. Safe to run again: emails already read are skipped.">Read past requests from the inbox</button>
<span class="sync-status" id="booking-requests-status">${data.prefs.bookingRequestsBackfilledAt ? `Last read ${escapeHtml(String(data.prefs.bookingRequestsBackfilledAt).slice(0, 10))}.` : ''}</span>
</div>`;
el.open = wasOpen;
if (!bound) {
bound = true;
el.addEventListener('click', async (e) => {
const ev = e.target.closest('[data-bkreq-eval]');
if (ev) { const { openEvaluator } = await import('./bookingevaluator.js'); openEvaluator({ requestId: ev.dataset.bkreqEval }); return; }
const mail = e.target.closest('[data-bkreq-open]');
if (mail) { const { openMessage } = await import('./mailviewer.js'); openMessage(mail.dataset.bkreqOpen); return; }
if (!e.target.closest('#booking-requests-backfill')) return;
const btn = e.target.closest('#booking-requests-backfill');
const status = () => document.getElementById('booking-requests-status');
btn.disabled = true;
const r = await backfillBookingRequests((t) => { if (status()) status().textContent = t; });
btn.disabled = false;
await renderBookingRequests();
el.open = true;
if (status()) status().textContent = r.error ? `Stopped: ${r.error}` : `Read ${r.added} new email${r.added === 1 ? '' : 's'}${r.unmatchedListing ? `; ${r.unmatchedListing} for a listing not set up here` : ''}.`;
});
}
}

export { parseRequestEmail, parseDateRange, syncBookingRequestsFromEmail, backfillBookingRequests, resolveRequestOutcomes, renderBookingRequests };
