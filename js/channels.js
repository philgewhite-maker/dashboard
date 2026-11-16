// Letting channels and long lets. Pure functions, no imports, so state.js (load-time migrations),
// the Settings editor and the stays panel share one definition and it can be tested without a browser.
//
// CHANNEL: where a stay came from, picked from data.prefs.lettingChannels (editable in Settings ->
// Finances -> Booking evaluator). A stay keeps `platform` ('airbnb' | 'other') derived from it so older
// readers keep working: platform is 'airbnb' only when channel === 'airbnb'.
//
// LONG LET: one stay (letType 'long', paymentIds [...]) in data.airbnbReservations. The ledger income rows it
// is paid by are NEVER edited: the stay points at them (stay.paymentIds), they do not point back. Its income
// stays null, because the money is already counted by those ledger rows; the stay exists to say "this block of
// nights is one let" and to hold the booking date.

const DAY_MS = 86400000;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

const CHANNEL_GROUPS = ['platform', 'ownsite', 'personal'];
const CHANNEL_GROUP_LABEL = { platform: 'Platform', ownsite: 'Own site', personal: 'Personal' };

// feePct is 0 until you enter your real figure: nothing here is a guess about what a platform charges.
const DEFAULT_LETTING_CHANNELS = [
  { id: 'airbnb', name: 'Airbnb', group: 'platform', feePct: 0, countsAsDemand: true, longLetDefault: false, active: true },
  { id: 'bookingcom', name: 'Booking.com', group: 'platform', feePct: 0, countsAsDemand: true, longLetDefault: false, active: false },
  { id: 'spareroom', name: 'Spareroom', group: 'platform', feePct: 0, countsAsDemand: false, longLetDefault: true, active: true },
  { id: 'ohana', name: 'Ohana', group: 'platform', feePct: 0, countsAsDemand: false, longLetDefault: true, active: true },
  { id: 'site-room', name: 'Direct site: room first', group: 'ownsite', feePct: 0, countsAsDemand: true, longLetDefault: false, active: false },
  { id: 'site-cat', name: 'Direct site: cat first', group: 'ownsite', feePct: 0, countsAsDemand: true, longLetDefault: false, active: false },
  { id: 'wordofmouth', name: 'Word of mouth', group: 'personal', feePct: 0, countsAsDemand: false, longLetDefault: false, active: true },
];
const BUILTIN_CHANNEL_IDS = DEFAULT_LETTING_CHANNELS.map((c) => c.id);

function cleanChannel(c, seed) {
  const s = seed || {};
  const fee = Number(c.feePct);
  return {
    id: String(c.id),
    name: String(c.name || s.name || c.id).trim() || String(c.id),
    group: CHANNEL_GROUPS.includes(c.group) ? c.group : (s.group || 'platform'),
    feePct: Number.isFinite(fee) && fee >= 0 ? fee : (s.feePct || 0),
    countsAsDemand: c.countsAsDemand === undefined ? !!s.countsAsDemand : !!c.countsAsDemand,
    longLetDefault: c.longLetDefault === undefined ? !!s.longLetDefault : !!c.longLetDefault,
    active: c.active === undefined ? s.active !== false : !!c.active,
  };
}

// The saved list with every built-in present (a built-in can be deactivated, never removed), every field valid,
// and ids unique. Idempotent. Rows keep the order they were saved in; missing built-ins are appended.
function normaliseChannels(list) {
  const out = [];
  const seen = new Set();
  (Array.isArray(list) ? list : []).forEach((c) => {
    if (!c || !c.id || seen.has(c.id)) return;
    seen.add(c.id);
    out.push(cleanChannel(c, DEFAULT_LETTING_CHANNELS.find((d) => d.id === c.id)));
  });
  DEFAULT_LETTING_CHANNELS.forEach((d) => { if (!seen.has(d.id)) out.push({ ...d }); });
  return out;
}

const platformForChannel = (channelId) => (channelId === 'airbnb' ? 'airbnb' : 'other');
const channelById = (channels, id) => (channels || []).find((c) => c.id === id) || null;
const channelName = (channels, id) => (channelById(channels, id) || { name: id || 'Unknown' }).name;

// What a stay's channel <select> offers: the active channels, plus the stay's own if it has been deactivated.
function channelChoices(channels, currentId) {
  return (channels || []).filter((c) => c.active || c.id === currentId);
}

// Stable slug for a user-added channel: from its name, made unique among the existing ids.
function newChannelId(channels, name) {
  const base = String(name || 'channel').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'channel';
  const taken = new Set((channels || []).map((c) => c.id));
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

// Set a stay's channel. `platform` follows (older readers), and a long-let-by-default channel makes it a long let.
function applyStayChannel(stay, channels, channelId) {
  stay.channel = channelId;
  stay.platform = platformForChannel(channelId);
  const c = channelById(channels, channelId);
  if (c && c.longLetDefault) stay.letType = 'long';
  return stay;
}

// One-time, idempotent: a stay with no channel gets one from its old platform (airbnb -> airbnb, anything else ->
// word of mouth) and letType 'short'; a stay that has a channel gets its platform re-derived from it. Returns true
// when it changed the stay. `r` is the stored record BEFORE any default fields are merged over it.
function migrateStayChannel(r) {
  let changed = false;
  if (!r.channel) { r.channel = r.platform === undefined || r.platform === 'airbnb' ? 'airbnb' : 'wordofmouth'; changed = true; }
  if (r.letType !== 'short' && r.letType !== 'long') { r.letType = 'short'; changed = true; }
  if (!Array.isArray(r.paymentIds)) { r.paymentIds = []; changed = true; }
  const p = platformForChannel(r.channel);
  if (r.platform !== p) { r.platform = p; changed = true; }
  return changed;
}

// ---- Long lets --------------------------------------------------------------------------------------------------

const toMs = (d) => new Date(`${d}T00:00:00Z`).getTime();
const addDays = (d, n) => new Date(toMs(d) + n * DAY_MS).toISOString().slice(0, 10);
const nightsBetween = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY_MS);

// The nights an income row covers, the same way letting.js's lettingIncomeItems reads it: a real start date plus
// nights wins; otherwise the nights end on the row's date. null for a row that spans nothing.
function ledgerRowSpan(e) {
  const n = Number(e && e.nights);
  if (!(n > 0)) return null;
  const start = e.startDate && ISO.test(e.startDate) ? e.startDate : (e.date && ISO.test(e.date) ? addDays(e.date, -n) : '');
  if (!start) return null;
  return { start, end: addDays(start, n), nights: n };
}

const linkedPaymentIds = (doc) => {
  const s = new Set();
  (doc.airbnbReservations || []).forEach((r) => { if (r.letType === 'long' && r.status !== 'cancelled') (r.paymentIds || []).forEach((id) => s.add(id)); });
  return s;
};

// The long-let stay a ledger row is part of, if any.
function longLetFor(doc, ledgerId) {
  return (doc.airbnbReservations || []).find((r) => r.letType === 'long' && r.status !== 'cancelled' && (r.paymentIds || []).includes(ledgerId)) || null;
}

// Income rows that could be paid towards a long let: 'earned' rows with a span, not already linked to one.
function longLetCandidates(doc) {
  const linked = linkedPaymentIds(doc);
  return (doc.lettingLedger || []).filter((e) => e.kind === 'earned' && Number(e.gross) > 0 && ledgerRowSpan(e) && !linked.has(e.id));
}

// Check a set of income rows can be one let, without changing anything.
// ok only when: every row exists, is an unlinked 'earned' row with a span, and together they cover one unbroken
// run of nights (a gap would make nights newly blocked that the rows did not block before).
function planLongLet(doc, paymentIds) {
  const ids = [...new Set(paymentIds || [])];
  const byId = new Map((doc.lettingLedger || []).map((e) => [e.id, e]));
  const linked = linkedPaymentIds(doc);
  const rows = [];
  for (const id of ids) {
    const e = byId.get(id);
    if (!e) return { ok: false, error: 'An income row is gone.' };
    if (e.kind !== 'earned') return { ok: false, error: 'Only income entries typed in as earned can join a long let.' };
    if (linked.has(id)) return { ok: false, error: 'An income row is already part of a long let.' };
    if (!ledgerRowSpan(e)) return { ok: false, error: 'An income row has no start date and nights.' };
    rows.push(e);
  }
  if (rows.length < 2) return { ok: false, error: 'Pick at least two payments.' };
  const spans = rows.map((e) => ({ e, ...ledgerRowSpan(e) })).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0) || a.end.localeCompare(b.end));
  let reach = spans[0].end;
  let gaps = 0;
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].start > reach) gaps += nightsBetween(reach, spans[i].start);
    if (spans[i].end > reach) reach = spans[i].end;
  }
  const start = spans[0].start;
  const end = reach;
  if (gaps) return { ok: false, error: `The payments leave ${gaps} night${gaps === 1 ? '' : 's'} uncovered between them; merging would block nights they never did.`, gaps };
  const listingId = (spans.find((s) => s.e.listingId) || { e: {} }).e.listingId || '';
  const booked = spans.map((s) => s.e.bookedOn).filter((d) => d && ISO.test(d)).sort();
  const total = rows.reduce((t, e) => t + (Number(e.gross) || 0), 0);
  return { ok: true, rows, ids: spans.map((s) => s.e.id), start, end, nights: nightsBetween(start, end), listingId, bookedOn: booked[0] || '', total: Math.round(total * 100) / 100 };
}

// Create the one stay. `blank` is state.js's blankAirbnbReservation. Idempotent: the id comes from the first payment,
// so a second device (or a second run) makes the same record and never a second one. Returns { stay, created } or
// { error }. Ledger rows are not touched.
function createLongLet(doc, opts, blank, todayIso) {
  const plan = planLongLet(doc, opts.paymentIds);
  if (!plan.ok) return { error: plan.error };
  const listingId = opts.listingId || plan.listingId;
  if (!listingId || !(doc.airbnbListings || []).some((l) => l.id === listingId)) return { error: 'Pick which listing the let is on.' };
  const id = `longlet-${plan.ids[0]}`;
  const held = (doc.airbnbReservations || []).find((r) => r.id === id);
  if (held) return { stay: held, created: false };
  const today = todayIso || new Date().toISOString().slice(0, 10);
  const stay = blank({
    id, listingId, source: 'manual', status: plan.end <= today ? 'completed' : 'booked',
    checkin: plan.start, checkout: plan.end, guestName: opts.guestName || '',
    confirmedOn: opts.bookedOn || plan.bookedOn || '',
    channel: opts.channel || 'wordofmouth', letType: 'long', platform: platformForChannel(opts.channel || 'wordofmouth'),
    paymentIds: plan.ids,
  });
  doc.airbnbReservations.push(stay);
  return { stay, created: true, plan };
}

// Unlinked income rows that would carry a long let on without a gap: same guest as the let's own payments, starting
// on its checkout (or ending on its checkin), chained. Rows from another guest are never offered.
function adjoiningPayments(doc, stay) {
  if (!stay || stay.letType !== 'long') return [];
  const key = (e) => String((e && (e.guest || e.note)) || '').trim().toLowerCase();
  const byId = new Map((doc.lettingLedger || []).map((e) => [e.id, e]));
  const guests = new Set((stay.paymentIds || []).map((id) => key(byId.get(id))).filter(Boolean));
  if (!guests.size) return [];
  const pool = longLetCandidates(doc).filter((e) => guests.has(key(e)));
  const picked = [];
  let start = stay.checkin;
  let end = stay.checkout;
  for (let more = true; more;) {
    more = false;
    for (const e of pool) {
      if (picked.includes(e.id)) continue;
      const s = ledgerRowSpan(e);
      if (s.start === end) { end = s.end; picked.push(e.id); more = true; } else if (s.end === start) { start = s.start; picked.push(e.id); more = true; }
    }
  }
  return picked;
}

// Add payments to an existing long let: re-plans the whole set (so the no-gap rule still holds) and moves the
// stay's dates. The stay keeps its id; the ledger rows are not touched. Returns { stay } or { error }.
function extendLongLet(doc, stayId, addIds, todayIso) {
  const stay = (doc.airbnbReservations || []).find((r) => r.id === stayId && r.letType === 'long');
  if (!stay) return { error: 'That long let is gone.' };
  const others = { ...doc, airbnbReservations: (doc.airbnbReservations || []).filter((r) => r.id !== stayId) };
  const ids = [...(stay.paymentIds || []), ...(addIds || [])];
  if (ids.length < 2) return { error: 'Pick at least two payments.' };
  const plan = planLongLet(others, ids);
  if (!plan.ok) return { error: plan.error };
  const today = todayIso || new Date().toISOString().slice(0, 10);
  stay.paymentIds = plan.ids;
  stay.checkin = plan.start;
  stay.checkout = plan.end;
  stay.status = plan.end <= today ? 'completed' : 'booked';
  return { stay, plan };
}

// Leo & Jerry: one direct contract signed up front, 27 Sep 2024 -> 23 May 2025 (238 nights), 17 fortnightly payments of
// £1,105 (8 on "En-Suite - Phil", then 9 on "En-Suite - Lewis" at £552.50 owner share each). Acts only when it finds
// exactly that; anything else returns { done: false, reason } and changes nothing (the manual merge is then the route).
const LJ = { start: '2024-09-27', end: '2025-05-23', nights: 238, payments: 17, gross: 1105, phil: 8, lewis: 9, lewisShare: 552.5 };
function migrateLeoJerry(doc, blank, todayIso) {
  const no = (reason) => ({ done: false, reason });
  const hasWord = (e, w) => new RegExp(`\\b${w}\\b`, 'i').test([e.guest, e.note, e.description].filter(Boolean).join(' '));
  const listingOf = (e) => (doc.airbnbListings || []).find((l) => l.id === e.listingId);
  const rows = (doc.lettingLedger || []).filter((e) => {
    if (e.kind !== 'earned') return false;
    const s = ledgerRowSpan(e);
    return s && s.start >= LJ.start && s.end <= LJ.end && (hasWord(e, 'leo') || hasWord(e, 'jerry'));
  });
  if (!rows.length) return no('no matching rows');
  const first = rows.map((e) => e.id).sort()[0];
  if ((doc.airbnbReservations || []).some((r) => r.letType === 'long' && (r.paymentIds || []).some((id) => rows.some((e) => e.id === id)))) return no('already merged');
  if (rows.length !== LJ.payments) return no(`expected ${LJ.payments} rows, found ${rows.length}`);
  if (rows.some((e) => Number(e.gross) !== LJ.gross)) return no('a row is not £1,105');
  const label = (e) => String((listingOf(e) || {}).label || '');
  const phil = rows.filter((e) => /en-?suite\s*[-–]\s*phil/i.test(label(e)));
  const lewis = rows.filter((e) => /en-?suite\s*[-–]\s*lewis/i.test(label(e)));
  if (phil.length !== LJ.phil || lewis.length !== LJ.lewis) return no(`expected ${LJ.phil} on En-Suite - Phil and ${LJ.lewis} on En-Suite - Lewis, found ${phil.length} and ${lewis.length}`);
  if (lewis.some((e) => Math.abs(Number(e.amount) - LJ.lewisShare) > 0.005)) return no('a Lewis row is not £552.50');
  const plan = planLongLet(doc, rows.map((e) => e.id));
  if (!plan.ok) return no(plan.error);
  if (plan.start !== LJ.start || plan.end !== LJ.end || plan.nights !== LJ.nights) return no(`rows cover ${plan.start} to ${plan.end} (${plan.nights} nights)`);
  const listingId = phil.slice().sort((a, b) => (ledgerRowSpan(a).start < ledgerRowSpan(b).start ? -1 : 1))[0].listingId;
  const r = createLongLet(doc, { paymentIds: plan.ids, listingId, guestName: 'Leo & Jerry', channel: 'wordofmouth' }, blank, todayIso);
  if (r.error) return no(r.error);
  return { done: r.created, stayId: r.stay.id, payments: plan.ids.length, first };
}

export {
  CHANNEL_GROUPS, CHANNEL_GROUP_LABEL, DEFAULT_LETTING_CHANNELS, BUILTIN_CHANNEL_IDS,
  normaliseChannels, platformForChannel, channelById, channelName, channelChoices, newChannelId, applyStayChannel, migrateStayChannel,
  ledgerRowSpan, linkedPaymentIds, longLetFor, longLetCandidates, planLongLet, createLongLet, adjoiningPayments, extendLongLet, migrateLeoJerry,
};
