// Guest ratings from Airbnb's review emails, for the Superhost assessment (js/features/superhost.js).
//
//   "Stacey has left a 5-star review!"  -> the rating is in the subject; the body carries the stay dates
//                                          ("5-8 Nov 2026"). Sets the stay's reviewRating.
//   "Helmut has written you a review"   -> Airbnb hides the rating until both sides have reviewed, so this only says
//                                          a review exists. Marks the stay reviewSeen (shown as a hollow star with ?).
//
// A stay is found by its exact check-in and check-out dates (the guest's name only breaks a tie, since two rooms can
// turn over on the same days). A rating you've already set is never overwritten. Dedup is by Gmail message id
// (data.prefs.airbnbReviewMailSeen).

import { data, queueSave } from '../state.js';
import { todayStr, dateStrAdd, foldDiacritics } from '../utils.js';
import { canAttemptGoogleAction } from '../sync/googleauth.js';

const QUERY = 'from:airbnb.com (subject:"star review" OR subject:"written you a review")';
const RATED_RE = /^(.+?)\s+has left an?\s+(\d)-star review/i;
const WRITTEN_RE = /^(.+?)\s+has written you a review/i;
const MONTH_WORD = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*$/i;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const RANGE_RE = /(\d{1,2})(?:\s+([A-Za-z]{3,9}))?\s*[–—-]\s*(\d{1,2})\s+([A-Za-z]{3,9})(?:\s+(\d{4}))?/g;

const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const monthOf = (w) => (w && MONTH_WORD.test(w) ? MONTHS[w.slice(0, 3).toLowerCase()] : 0);

// The stay's "5-8 Nov 2026" / "16 Oct - 2 Nov" range from an email body. The year is the email's own when the range
// omits it (the day before the email at the latest, since a review follows the stay).
export function parseStayRange(text, emailIso) {
  const body = String(text || '').replace(/[​-‏­͏⁠﻿]/g, '');
  RANGE_RE.lastIndex = 0;
  let m;
  while ((m = RANGE_RE.exec(body))) {
    const endM = monthOf(m[4]);
    if (!endM) continue;
    const startM = m[2] ? monthOf(m[2]) : endM;
    if (!startM) continue;
    const endD = Number(m[3]);
    const startD = Number(m[1]);
    let endY = m[5] ? Number(m[5]) : Number(emailIso.slice(0, 4));
    if (!m[5] && iso(endY, endM, endD) > dateStrAdd(emailIso, 2)) endY -= 1;
    const startY = startM > endM ? endY - 1 : endY;
    return { checkin: iso(startY, startM, startD), checkout: iso(endY, endM, endD) };
  }
  return null;
}

// What a review email's subject says: {kind:'rated', name, rating} | {kind:'written', name} | null.
export function parseReviewSubject(subject) {
  const s = String(subject || '').trim();
  let m = RATED_RE.exec(s);
  if (m) return { kind: 'rated', name: m[1].trim(), rating: Number(m[2]) };
  m = WRITTEN_RE.exec(s);
  if (m) return { kind: 'written', name: m[1].trim() };
  return null;
}

// Stays on file with exactly these dates: reservations first, then income-only ledger rows (older stays whose
// reservation is gone), which are used only when no reservation matches.
function candidatesFor(range) {
  const res = (data.airbnbReservations || []).filter((r) => r.status !== 'cancelled' && r.checkin === range.checkin && r.checkout === range.checkout)
    .map((r) => ({ rec: r, guest: r.guestName || '' }));
  if (res.length) return res;
  const resIds = new Set((data.airbnbReservations || []).map((r) => r.id));
  const out = [];
  (data.lettingLedger || []).forEach((e) => {
    if (!['accrual', 'earned'].includes(e.kind) || e.platform === 'other' || (e.reservationId && resIds.has(e.reservationId))) return;
    const nights = Number(e.nights) || 0;
    const co = e.checkout || (e.startDate && nights ? dateStrAdd(e.startDate, nights) : '');
    const ci = e.startDate || (co && nights ? dateStrAdd(co, -nights) : '');
    if (ci === range.checkin && co === range.checkout) out.push({ rec: e, guest: e.guest || '' });
  });
  return out;
}

const fold = (s) => foldDiacritics(String(s || '')).toLowerCase();

// The one stay a review email is about, or null (none on file) / 'ambiguous'.
export function matchStay(range, firstName) {
  const c = candidatesFor(range);
  if (!c.length) return null;
  if (c.length === 1) return c[0].rec;
  const first = fold(firstName);
  const named = c.filter((x) => fold(x.guest).split(/\s+/).includes(first));
  return named.length === 1 ? named[0].rec : 'ambiguous';
}

// Apply one parsed email to a stay record. Returns 'rated' | 'written' | '' (nothing changed).
export function applyReview(rec, parsed) {
  if (rec.reviewRating != null) return ''; // never overwrite a rating already set
  if (parsed.kind === 'rated') {
    rec.reviewRating = parsed.rating;
    delete rec.reviewSeen;
    return 'rated';
  }
  if (rec.reviewSeen) return '';
  rec.reviewSeen = true;
  return 'written';
}

export async function syncReviewsFromEmail() {
  const out = { rated: 0, written: 0, ambiguous: 0, read: 0 };
  if (!(await canAttemptGoogleAction())) return out;
  if (!Array.isArray(data.prefs.airbnbReviewMailSeen)) data.prefs.airbnbReviewMailSeen = [];
  const seen = new Set(data.prefs.airbnbReviewMailSeen);
  const firstRun = seen.size === 0; // a long look back once, then only recent mail
  const { fetchMailSearches, getMessageDetail } = await import('../googlemail.js');
  let sections;
  try {
    sections = await fetchMailSearches([{ kind: 'query', value: QUERY, maxDays: firstRun ? 460 : 45, maxEvents: firstRun ? 90 : 25 }], firstRun ? 90 : 25);
  } catch (err) {
    console.error('Review email search failed:', err);
    return { ...out, error: err.message || String(err) };
  }
  for (const m of sections[0]?.messages || []) {
    if (seen.has(m.id)) continue;
    const parsed = parseReviewSubject(m.subject);
    if (!parsed) continue;
    let range = null;
    try {
      const detail = await getMessageDetail(m.id);
      const sent = new Date(m.date);
      const emailIso = Number.isNaN(sent.getTime()) ? todayStr() : sent.toISOString().slice(0, 10);
      range = parseStayRange(detail.bodyText || '', emailIso);
    } catch (err) {
      console.error('Reading a review email failed:', err);
      return { ...out, error: err.message || String(err) };
    }
    out.read += 1;
    if (!range) { seen.add(m.id); continue; } // nothing to match on; retrying won't help
    const stay = matchStay(range, parsed.name);
    if (stay === 'ambiguous') { out.ambiguous += 1; continue; } // try again once a name or a date separates them
    seen.add(m.id);
    if (!stay) continue; // a stay older than anything on file
    const result = applyReview(stay, parsed);
    if (result) out[result] += 1;
  }
  data.prefs.airbnbReviewMailSeen = [...seen].slice(-500);
  if (out.rated || out.written) {
    queueSave();
    import('./letting.js').then((l) => l.renderLetting()).catch(() => {});
  }
  return out;
}
