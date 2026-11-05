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

  (doc.airbnbKeys || []).forEach((k) => {
    if ('forReservationId' in k || 'forNote' in k) { delete k.forReservationId; delete k.forNote; report.keysCleared++; }
  });
  return report;
}

function todayIso() { return new Date().toISOString().slice(0, 10); }

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
    if (v.amount !== undefined && v.unit !== undefined) return;
    if (String(v.value || '').trim() === 'Used') { v.used = true; v.value = ''; report.usedSentinel++; }
    const p = parseVoucherValue(v.value);
    if (p === null) { v.amount = null; v.unit = ''; report.unparsed.push(`${v.name}: "${v.value}"`); return; }
    v.amount = p.amount; v.unit = p.unit;
    if (p.amount != null) { report.parsed++; if (!p.unit) report.noUnit.push(`${v.name}: "${v.value}"`); }
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

function migrateProviders(doc) {
  const report = { created: 0, linked: { vouchers: 0, loyaltyPrograms: 0, subscriptions: 0, financeAccounts: 0 } };
  const before = (doc.providers || []).length;
  const link = (list, field, key) => (list || []).forEach((r) => {
    if (r.providerId) return;
    const p = ensureProvider(doc, r[field], r.logoUrl);
    if (!p) return;
    r.providerId = p.id;
    report.linked[key]++;
  });
  link(doc.vouchers, 'provider', 'vouchers');
  link(doc.loyaltyPrograms, 'provider', 'loyaltyPrograms');
  link(doc.subscriptions, 'provider', 'subscriptions');
  link(doc.financeAccounts, 'bank', 'financeAccounts');
  if (!Array.isArray(doc.providers)) doc.providers = [];
  report.created = doc.providers.length - before;
  report.names = doc.providers.map((p) => p.name);
  return report;
}

// ---- Connections: legacy chat text, saved UI flags -----------------------------

const LEGACY_CHAT = [['chatLog', 'Tinder'], ['chatLogWhatsApp', 'WhatsApp'], ['chatLogTelegram', 'Telegram']];
const lines = (t) => String(t || '').split('\n').map((l) => l.trim()).filter(Boolean);

function migrateConnections(doc) {
  const report = { chatCleared: 0, chatMovedToNewRow: 0, notCovered: [], flagsStripped: 0, coverFixed: 0 };
  (doc.connections || []).forEach((c) => {
    if (!Array.isArray(c.identities)) c.identities = [];
    LEGACY_CHAT.forEach(([field, platform]) => {
      if (!(field in c)) return;
      const legacy = lines(c[field]);
      if (legacy.length) {
        const rows = c.identities.filter((r) => r.platform === platform);
        const covered = rows.some((r) => { const have = new Set(lines(r.chatLog)); return legacy.every((l) => have.has(l)); });
        if (covered) report.chatCleared++;
        else {
          const empty = rows.find((r) => !lines(r.chatLog).length);
          if (empty) empty.chatLog = c[field];
          else c.identities.push({ id: `${c.id}-legacy-${platform.toLowerCase()}`, platform, handle: 'earlier chat', matchId: '', chatLog: c[field] });
          report.chatMovedToNewRow++;
          report.notCovered.push(`${c.name} (${platform}, ${legacy.length} lines)`);
        }
      }
      delete c[field];
    });
    if ('createdJustNow' in c) { delete c.createdJustNow; report.flagsStripped++; }
    if (c.photoId && Array.isArray(c.photoIds) && !c.photoIds.includes(c.photoId)) { c.photoIds.unshift(c.photoId); report.coverFixed++; }
  });
  return report;
}

export { SCHEMA_VERSION, migrateStays, migrateVouchers, migrateProviders, migrateConnections, parseVoucherValue, ensureProvider, canonicalName, providerIdFor, VOUCHER_UNITS };
