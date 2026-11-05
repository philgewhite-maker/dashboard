// Data-model migrations from the data-model review (docs/data-model.html).
// Pure: each takes the document, changes it in place, and returns a report of
// what it did, so it can be dry-run on a copy of the live document before it is
// wired into state.js's migrate(). Every one is idempotent and gated on the old
// shape still being present (not only on a version number), because a device on
// older code can push the old shape back once after another device migrated.
// New ids are deterministic for the same reason: two devices migrating the same
// record separately must produce the same id, or a sync merge would keep both.
import { splitProvider, normProv, matchBrandLogo } from './brandLogos.js';
import { matchBankLogo } from './bankLogos.js';

const SCHEMA_VERSION = 1;

const slug = (s) => normProv(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';

// ---- Airbnb stays: one list, never deleted ---------------------------------
//
// Past and cancelled stays move into airbnbReservations with a status. A past
// stay takes the id of a ledger accrual row that points at a reservation that
// no longer exists, when that row is for the same listing and checkout date,
// which repairs the link. Migrated stays are marked as already charged so the
// accrual never charges historic income a second time.
function migrateStays(doc) {
  const report = { pastMoved: 0, pastMerged: 0, cancelledMoved: 0, cancelledMerged: 0, ledgerRelinked: 0, cancellationRowsLinked: 0, pastWithIncomeButNoAccrual: 0, keysCleared: 0, statusSet: 0 };
  if (!Array.isArray(doc.airbnbReservations)) doc.airbnbReservations = [];
  const res = doc.airbnbReservations;
  const ledger = Array.isArray(doc.lettingLedger) ? doc.lettingLedger : [];
  res.forEach((r) => {
    if (!r.status) { r.status = 'booked'; report.statusSet++; }
    if (typeof r.cancelledOn !== 'string') r.cancelledOn = '';
  });
  const sameStay = (a, b) => a.listingId === b.listingId && a.checkin === b.checkin && a.checkout === b.checkout;
  const ids = () => new Set(res.map((r) => r.id));

  (doc.airbnbPastStays || []).forEach((s) => {
    if (!s || !s.listingId) return;
    const existing = res.find((r) => sameStay(r, s));
    if (existing) {
      if (existing.income == null && s.income != null) existing.income = s.income;
      if (!existing.confirmationCode && s.confirmationCode) existing.confirmationCode = s.confirmationCode;
      if (existing.status === 'booked' && s.checkout < todayIso()) existing.status = 'completed';
      report.pastMerged++;
      return;
    }
    const known = ids();
    const accrual = ledger.find((e) => e.kind === 'accrual' && e.listingId === s.listingId && e.date === s.checkout && e.reservationId && !known.has(e.reservationId));
    const id = accrual ? accrual.reservationId : `stay-${s.listingId}-${s.checkin}-${s.checkout}`;
    if (accrual) report.ledgerRelinked++;
    else if (s.income != null && !ledger.some((e) => e.kind === 'accrual' && e.listingId === s.listingId && e.date === s.checkout)) report.pastWithIncomeButNoAccrual++;
    res.push({
      id, listingId: s.listingId, uid: '', source: 'ics', status: 'completed', cancelledOn: '',
      checkin: s.checkin, checkout: s.checkout, guestName: s.guestName || '', notes: '',
      confirmationCode: s.confirmationCode || '', revisions: Array.isArray(s.revisions) ? s.revisions : [], payoutCheck: false,
      income: s.income ?? null, accruedAt: 'migrated', confirmedOn: s.bookedOn || '', paidOn: '',
      platform: s.platform === 'other' ? 'other' : 'airbnb', googleEventId: '', googleCalendarId: '',
      createdAt: s.bookedOn ? `${s.bookedOn}T00:00:00.000Z` : new Date().toISOString(),
    });
    report.pastMoved++;
  });

  (doc.airbnbCancelledStays || []).forEach((s) => {
    if (!s || !s.listingId) return;
    let stay = res.find((r) => r.id === s.id) || res.find((r) => sameStay(r, s) && r.status !== 'booked');
    if (stay) {
      if (stay.status === 'booked') { stay.status = 'cancelled'; stay.cancelledOn = s.cancelledOn || ''; }
      report.cancelledMerged++;
    } else {
      stay = {
        id: s.id || `stay-${s.listingId}-${s.checkin}-${s.checkout}`, listingId: s.listingId, uid: '', source: 'ics',
        status: 'cancelled', cancelledOn: s.cancelledOn || '',
        checkin: s.checkin, checkout: s.checkout, guestName: s.guestName || '', notes: '',
        confirmationCode: s.confirmationCode || '', revisions: Array.isArray(s.revisions) ? s.revisions : [], payoutCheck: false,
        income: null, accruedAt: 'migrated', confirmedOn: s.bookedOn || '', paidOn: '',
        platform: 'airbnb', googleEventId: '', googleCalendarId: '',
        createdAt: s.bookedOn ? `${s.bookedOn}T00:00:00.000Z` : new Date().toISOString(),
      };
      res.push(stay);
      report.cancelledMoved++;
    }
    ledger.filter((e) => e.kind === 'cancellation' && !e.reservationId && e.listingId === stay.listingId && e.checkin === stay.checkin).forEach((e) => {
      e.reservationId = stay.id;
      report.cancellationRowsLinked++;
    });
  });
  delete doc.airbnbPastStays;
  delete doc.airbnbCancelledStays;

  report.duplicateAccrualsRemoved = dedupeAccruals(doc);

  // Stays deleted before past stays were kept at all: the accrual row still
  // holds listing, checkout, nights, gross and the guest in its note, which is
  // enough to put the stay back under the id the row already points at.
  report.rebuiltFromLedger = 0;
  const known = ids();
  doc.lettingLedger.forEach((e) => {
    if (e.kind !== 'accrual' || !e.reservationId || known.has(e.reservationId) || !e.listingId || !e.date) return;
    const nights = Number(e.nights) || 0;
    const checkin = nights > 0 ? new Date(Date.parse(`${e.date}T00:00:00Z`) - nights * 86400000).toISOString().slice(0, 10) : e.date;
    const comma = String(e.note || '').indexOf(', ');
    res.push({
      id: e.reservationId, listingId: e.listingId, uid: '', source: 'ics', status: 'completed', cancelledOn: '',
      checkin, checkout: e.date, guestName: comma >= 0 ? e.note.slice(comma + 2) : '', notes: 'Rebuilt from its Letting income entry',
      confirmationCode: '', revisions: [], payoutCheck: false,
      income: Number.isFinite(Number(e.gross)) ? Number(e.gross) : null, accruedAt: 'migrated', confirmedOn: '', paidOn: e.capDate || '',
      platform: e.platform === 'other' ? 'other' : 'airbnb', googleEventId: '', googleCalendarId: '',
      createdAt: `${e.date}T00:00:00.000Z`,
    });
    known.add(e.reservationId);
    report.rebuiltFromLedger++;
  });

  (doc.airbnbKeys || []).forEach((k) => {
    if ('forReservationId' in k || 'forNote' in k) { delete k.forReservationId; delete k.forNote; report.keysCleared++; }
  });
  return report;
}

function todayIso() { return new Date().toISOString().slice(0, 10); }

// The same stay charged twice: two accrual rows for one reservation (seen
// live on 2026-11-04 and 2026-11-05: a device on code older than v734 charged
// with a random row id). Not one-shot: state.js runs it on every load, since
// such a device can add a second row at any time. The survivor is chosen by
// id, never by array order, so two devices holding both rows keep the same
// one: the id derived from the stay if present, otherwise the smallest id.
function dedupeAccruals(doc) {
  const ledger = Array.isArray(doc.lettingLedger) ? doc.lettingLedger : [];
  const keep = new Map();
  ledger.forEach((e) => {
    if (e.kind !== 'accrual' || !e.reservationId) return;
    const cur = keep.get(e.reservationId);
    const derived = `accrual-${e.reservationId}`;
    if (!cur || e.id === derived || (cur.id !== derived && String(e.id) < String(cur.id))) keep.set(e.reservationId, e);
  });
  const removed = [];
  const kept = ledger.filter((e) => {
    if (e.kind !== 'accrual' || !e.reservationId || keep.get(e.reservationId) === e) return true;
    removed.push({ id: e.id, date: e.date, amount: e.amount, note: e.note || '' });
    return false;
  });
  if (removed.length) doc.lettingLedger = kept;
  return removed;
}

// ---- Duplicate stays --------------------------------------------------------
//
// One room holds one guest on a given night, so two stays on the same listing
// with the same check-in and check-out are one stay recorded twice (seen live:
// three records for one booking; two devices each added the same feed event
// before syncing, and Airbnb gave a third copy a different calendar id). Runs
// on every load. The survivor is chosen by content then id, never by array
// order, so two devices holding the same copies keep the same one. Calendar
// ids of the removed copies are kept on the survivor (altUids) so the next
// feed read recognises them instead of adding the stay again. Everything that
// pointed at a removed copy is repointed first.
const stayScore = (r) => (r.accruedAt ? 4 : 0) + (r.income != null ? 2 : 0) + (r.guestName ? 1 : 0);
function dedupeStays(doc) {
  const res = Array.isArray(doc.airbnbReservations) ? doc.airbnbReservations : [];
  const groups = new Map();
  res.forEach((r) => {
    if (!r.listingId || !r.checkin || !r.checkout || r.status === 'cancelled') return;
    const k = `${r.listingId}|${r.checkin}|${r.checkout}|${r.status || 'booked'}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  });
  const removed = [];
  const gone = new Map(); // removed id -> survivor id
  groups.forEach((list) => {
    if (list.length < 2) return;
    list.sort((a, b) => stayScore(b) - stayScore(a) || String(a.id).localeCompare(String(b.id)));
    const keep = list[0];
    if (!Array.isArray(keep.altUids)) keep.altUids = [];
    list.slice(1).forEach((x) => {
      ['guestName', 'confirmationCode', 'paidOn', 'confirmedOn', 'googleEventId', 'googleCalendarId', 'notes'].forEach((f) => { if (!keep[f] && x[f]) keep[f] = x[f]; });
      if (keep.income == null && x.income != null) keep.income = x.income;
      if (!keep.accruedAt && x.accruedAt) keep.accruedAt = x.accruedAt;
      if (x.payoutCheck) keep.payoutCheck = true;
      if (Array.isArray(x.revisions) && x.revisions.length) keep.revisions = [...(keep.revisions || []), ...x.revisions];
      [x.uid, ...(x.altUids || [])].forEach((u) => { if (u && u !== keep.uid && !keep.altUids.includes(u)) keep.altUids.push(u); });
      gone.set(x.id, keep.id);
      removed.push({ id: x.id, kept: keep.id, checkin: x.checkin, checkout: x.checkout });
    });
  });
  if (!removed.length) return removed;
  doc.airbnbReservations = res.filter((r) => !gone.has(r.id));
  (doc.lettingLedger || []).forEach((e) => { if (gone.has(e.reservationId)) e.reservationId = gone.get(e.reservationId); });
  (doc.airbnbCleanerEvents || []).forEach((e) => { if (gone.has(e.reservationId)) e.reservationId = gone.get(e.reservationId); });
  if (Array.isArray(doc.airbnbCleanerBlocks)) {
    doc.airbnbCleanerBlocks = [...new Set(doc.airbnbCleanerBlocks.map((b) => {
      const i = String(b).lastIndexOf(':');
      const id = String(b).slice(0, i);
      return gone.has(id) ? `${gone.get(id)}${String(b).slice(i)}` : b;
    }))];
  }
  if (Array.isArray(doc.airbnbKeyAssignments)) {
    const seen = new Set();
    doc.airbnbKeyAssignments = doc.airbnbKeyAssignments.map((a) => (gone.has(a.reservationId) ? { ...a, reservationId: gone.get(a.reservationId) } : a))
      .filter((a) => { const k = `${a.keyId}|${a.reservationId}`; if (seen.has(k)) return false; seen.add(k); return true; });
  }
  return removed;
}

// ---- Vouchers: typed amount, one-way link from readings ---------------------

const VOUCHER_UNITS = ['GBP', 'EUR', 'points', 'Avios', 'miles', 'nights', 'other'];
const UNIT_WORDS = { '£': 'GBP', gbp: 'GBP', '€': 'EUR', eur: 'EUR', points: 'points', pts: 'points', point: 'points', avios: 'Avios', miles: 'miles', mile: 'miles', nights: 'nights', night: 'nights' };
function parseVoucherValue(text) {
  const t = String(text || '').trim();
  if (!t) return { amount: null, unit: '' };
  const m = /^(£|€|eur|gbp)?\s*([\d,]+(?:\.\d+)?)\s*(£|€|eur|gbp|points?|pts|avios|miles?|nights?)?\b/i.exec(t);
  if (!m) return null;
  const amount = Number(m[2].replace(/,/g, ''));
  if (!Number.isFinite(amount)) return null;
  const word = (m[1] || m[3] || '').toLowerCase();
  return { amount, unit: UNIT_WORDS[word] || UNIT_WORDS[m[1] || ''] || '' };
}

function migrateVouchers(doc) {
  const report = { parsed: 0, noUnit: [], unparsed: [], usedSentinel: 0, linksRestored: 0, voucherIdsDropped: 0, danglingDropped: 0 };
  const vouchers = Array.isArray(doc.vouchers) ? doc.vouchers : [];
  vouchers.forEach((v) => {
    if (typeof v.unit !== 'string') v.unit = '';
    if (v.amount === undefined) v.amount = null;
    if (String(v.value || '').trim() === 'Used') { v.used = true; v.value = ''; report.usedSentinel++; }
    // Only a voucher still holding just the old text needs parsing; a
    // number already set (by hand or an earlier run) is never overwritten.
    if (v.amount != null || !String(v.value || '').trim()) return;
    const p = parseVoucherValue(v.value);
    if (p === null || p.amount == null) { report.unparsed.push(`${v.name}: "${v.value}"`); return; }
    v.amount = p.amount;
    if (!v.unit) v.unit = p.unit;
    report.parsed++;
    if (!v.unit) report.noUnit.push(`${v.name}: "${v.value}"`);
  });
  const byId = new Map(vouchers.map((v) => [v.id, v]));
  (doc.loyaltyBalances || []).forEach((b) => {
    if (!('voucherId' in b)) return;
    if (b.voucherId) {
      const v = byId.get(b.voucherId);
      if (!v) report.danglingDropped++;
      else if (!(v.sourceLoyaltyReadingIds || []).includes(b.id)) { v.sourceLoyaltyReadingIds = [...(v.sourceLoyaltyReadingIds || []), b.id]; report.linksRestored++; }
    }
    delete b.voucherId;
    report.voucherIdsDropped++;
  });
  return report;
}

// ---- Providers registry ------------------------------------------------------

function canonicalName(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  const hit = splitProvider(t);
  return hit ? hit.provider : t;
}
function providerIdFor(name) { return `prov-${slug(name)}`; }

function ensureProvider(doc, name, logoHint) {
  if (!Array.isArray(doc.providers)) doc.providers = [];
  const canon = canonicalName(name);
  if (!canon) return null;
  const key = normProv(canon);
  let p = doc.providers.find((x) => normProv(x.name) === key || (x.aliases || []).some((a) => normProv(a) === key));
  if (!p) {
    p = { id: providerIdFor(canon), name: canon, logoUrl: logoHint || matchBrandLogo(canon) || matchBankLogo(canon) || '', aliases: [] };
    if (doc.providers.some((x) => x.id === p.id)) p.id = `${p.id}-${doc.providers.length}`;
    doc.providers.push(p);
  } else if (!p.logoUrl && logoHint) p.logoUrl = logoHint;
  return p;
}

// The four collections that name a provider, and the text field each uses.
const PROVIDER_FIELDS = [['vouchers', 'provider'], ['loyaltyPrograms', 'provider'], ['subscriptions', 'provider'], ['financeAccounts', 'bank']];

function providerMatches(p, text) {
  const key = normProv(canonicalName(text));
  return !!p && (normProv(p.name) === key || (p.aliases || []).some((a) => normProv(a) === key));
}

// Points every record's providerId at the registry entry its provider text
// names, creating the entry for a new name. The text is what the edit forms
// change, so a record whose id no longer matches its text is relinked; the
// registry's own rename and merge rewrite the text of every linked record, so
// they never look like a mismatch. Run on every load; cheap and idempotent.
function linkProviders(doc) {
  const report = { created: 0, linked: { vouchers: 0, loyaltyPrograms: 0, subscriptions: 0, financeAccounts: 0 } };
  if (!Array.isArray(doc.providers)) doc.providers = [];
  const before = doc.providers.length;
  PROVIDER_FIELDS.forEach(([list, field]) => (doc[list] || []).forEach((r) => {
    const text = String(r[field] || '').trim();
    if (!text) { if (r.providerId) r.providerId = ''; return; }
    if (r.providerId && providerMatches(doc.providers.find((x) => x.id === r.providerId), text)) return;
    const p = ensureProvider(doc, text, r.logoUrl);
    if (!p || r.providerId === p.id) return;
    r.providerId = p.id;
    report.linked[list]++;
  }));
  report.created = doc.providers.length - before;
  return report;
}

function migrateProviders(doc) {
  const report = linkProviders(doc);
  report.names = doc.providers.map((p) => p.name);
  return report;
}

// ---- Connections: legacy chat text, saved UI flags -----------------------------

const LEGACY_CHAT = [['chatLog', 'Tinder'], ['chatLogWhatsApp', 'WhatsApp'], ['chatLogTelegram', 'Telegram']];
const CHAT_PLATFORMS = ['Tinder', 'Bumble', 'Telegram', 'WhatsApp'];
const lines = (t) => String(t || '').split('\n').map((l) => l.trim()).filter(Boolean);
// "Sender: message" without the leading [time] or [date time]: an older
// scrape wrote only the time, a newer one the date too, for the same message.
const messageKey = (l) => l.replace(/^\[[^\]]*\]\s*/, '');

function migrateConnections(doc) {
  const report = { chatCleared: 0, chatMovedToNewRow: 0, notCovered: [], flagsStripped: 0, coverFixed: 0 };
  (doc.connections || []).forEach((c) => {
    if (!Array.isArray(c.identities)) c.identities = [];
    LEGACY_CHAT.forEach(([field, platform]) => {
      if (!(field in c)) return;
      const legacy = lines(c[field]);
      if (legacy.length) {
        // The connection-level "chatLog" was whichever app the chat came from,
        // not always Tinder: use the connection's own app when it is a chat app.
        const target = field === 'chatLog' && CHAT_PLATFORMS.includes(c.app) ? c.app : platform;
        const rows = c.identities.filter((r) => r.platform === target);
        const covered = rows.some((r) => { const have = new Set(lines(r.chatLog).map(messageKey)); return legacy.every((l) => have.has(messageKey(l))); });
        if (covered) report.chatCleared++;
        else {
          const empty = rows.find((r) => !lines(r.chatLog).length);
          if (empty) empty.chatLog = c[field];
          else {
            c.identities.push({
              id: `${c.id}-legacy-${target.toLowerCase()}`, platform: target,
              handle: rows.length ? 'earlier chat' : (c.profileName || c.name || ''),
              matchId: target === 'Tinder' && !rows.some((r) => r.matchId === c.tinderMatchId) ? (c.tinderMatchId || '') : '',
              chatLog: c[field],
            });
          }
          report.chatMovedToNewRow++;
          report.notCovered.push(`${c.name} (${target}, ${legacy.length} lines${rows.length ? '' : ', had no chat row'})`);
        }
      }
      delete c[field];
    });
    if ('createdJustNow' in c) { delete c.createdJustNow; report.flagsStripped++; }
    if (c.photoId && Array.isArray(c.photoIds) && !c.photoIds.includes(c.photoId)) { c.photoIds.unshift(c.photoId); report.coverFixed++; }
  });
  return report;
}

export { SCHEMA_VERSION, migrateStays, dedupeStays, dedupeAccruals, migrateVouchers, migrateProviders, linkProviders, providerMatches, PROVIDER_FIELDS, migrateConnections, parseVoucherValue, ensureProvider, canonicalName, providerIdFor, VOUCHER_UNITS };
