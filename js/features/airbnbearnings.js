// Airbnb earnings export (Earnings -> Transaction history -> download CSV), read into the
// stays and Letting income entries already on file.
//
// The export is per Airbnb account (whoever the payouts go to). Each stay is a "Reservation"
// row with its HM code, booking date, start/end, nights, guest, listing title and payout
// ("Amount"), preceded by the "Payout" row that paid it (its "Arriving by date" is about the
// date a hand-entered income entry carries). "Resolution Adjustment" rows are refunds
// against a stay (already in Letting income as refund entries); "Cancellation Fee" /
// "Cancellation Fee Refund" pairs are bookings cancelled with no payout.
//
// Matching, most certain first: a stay with the same HM code; a stay in the same room with
// the same dates; an income entry (earned, accrual or cancellation) whose amount is the payout
// (or the payout less its adjustments) and whose date falls between the payout and a few days
// after it arrived, and that nothing else claimed. Only blanks are filled in, apart from a
// check-in that was guessed backwards from the payout date: the export's real dates replace
// it. Anything that differs from what you typed is listed, not changed. Stays not in Letting
// income at all are listed and can be added as Earned entries.
import { data, queueSave, blankAirbnbEarning } from '../state.js';
import { escapeHtml, splitCsvLine, dateStrAdd, scrollAndFlash, uid } from '../utils.js';
import { owners, ownerNameFor, ownerKeyFor, splitAmountFor, shareRuleAt, nightRateRooms, renderLetting } from './letting.js';

const usDate = (s) => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || '').trim()); return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : ''; };
const num = (s) => { const v = Number(String(s || '').replace(/[£,\s]/g, '')); return Number.isFinite(v) && String(s || '').trim() !== '' ? v : null; };
const near = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.02;
const within = (a, b, tol) => a != null && b != null && Math.abs(Number(a) - Number(b)) <= tol;
// A guest name that fits (first name contained), or nothing to compare.
const nameFits = (have, want) => { const a = String(have || '').toLowerCase(); const b = String(want || '').toLowerCase().split(/\s+/)[0]; return !a || !b || a.includes(b); };

// Every row of the CSV as a stored record (blankAirbnbEarning): all columns, dates as ISO. `ownerKey` is whose
// Airbnb account the export is from. The id is derived from the row, so the same row read again is the same record.
function rowsFromCsv(text, ownerKey = '', source = '') {
const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
if (!lines.length) return { records: [], error: 'The file is empty.' };
const head = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
const col = (name) => head.indexOf(name);
const need = ['date', 'type', 'confirmation code', 'start date', 'end date', 'amount'];
const missing = need.filter((n) => col(n) < 0);
if (missing.length) return { records: [], error: `This doesn't look like Airbnb's earnings export (no ${missing.join(', ')} column).` };
const importedAt = new Date().toISOString();
const records = lines.slice(1).map((l) => {
const c = splitCsvLine(l);
const g = (n) => (col(n) >= 0 ? (c[col(n)] || '').trim() : '');
const rec = blankAirbnbEarning({
ownerKey, type: g('type'), date: usDate(g('date')), arrivingBy: usDate(g('arriving by date')), confirmationCode: g('confirmation code'),
bookingDate: usDate(g('booking date')), start: usDate(g('start date')), end: usDate(g('end date')), nights: num(g('nights')), guest: g('guest'),
listingTitle: g('listing'), details: g('details'), referenceCode: g('reference code'), currency: g('currency') || 'GBP', amount: num(g('amount')),
paidOut: num(g('paid out')), serviceFee: num(g('service fee')), fastPayFee: num(g('fast pay fee')), cleaningFee: num(g('cleaning fee')),
grossEarnings: num(g('gross earnings')), tax: num(g('airbnb remitted tax')), earningsYear: g('earnings year'), importedAt, source,
});
rec.id = `ae|${ownerKey}|${rec.type}|${rec.confirmationCode || rec.referenceCode}|${rec.date}|${rec.amount ?? ''}|${rec.paidOut ?? ''}|${rec.details.slice(0, 40)}`;
return rec;
}).filter((r) => r.type);
return { records };
}

// Stores rows not already held (by id). Rows already there keep their resolved listing; a row that is new gets
// the listing it was on where that can be told (the booking request with its code, else the owner's listing in
// the room its title names).
function storeEarnings(records, ownerKey) {
const have = new Set((data.airbnbEarnings || []).map((r) => r.id));
let added = 0;
records.forEach((r) => {
if (have.has(r.id)) return;
if (r.type.toLowerCase() === 'reservation' || r.confirmationCode) r.listingId = listingFor({ code: r.confirmationCode, listingTitle: r.listingTitle }, ownerKey);
data.airbnbEarnings.push(r);
have.add(r.id);
added++;
});
if (added) queueSave();
return { added, already: records.length - added, total: data.airbnbEarnings.length };
}

// The stays and cancellations in a set of stored rows: one entry per HM code, the reservation row plus what adjusts
// it, and the payout it was paid in (its "arriving by" date).
function parseFromRecords(records) {
const payoutArriving = new Map(); // payout date -> latest arriving-by date that day
const byCode = new Map();
const cancelled = new Map();
records.forEach((r) => {
const type = r.type.toLowerCase();
if (type === 'payout') {
if (r.date && r.arrivingBy && (!payoutArriving.has(r.date) || payoutArriving.get(r.date) < r.arrivingBy)) payoutArriving.set(r.date, r.arrivingBy);
return;
}
const code = r.confirmationCode;
if (!code) return;
const base = { code, bookingDate: r.bookingDate, checkin: r.start, checkout: r.end, nights: r.nights, guest: r.guest.trim(), listingTitle: r.listingTitle, date: r.date, recordId: r.id };
if (type === 'reservation') {
byCode.set(code, { ...(byCode.get(code) || { adjustments: 0 }), ...base, amount: r.amount, cleaningFee: r.cleaningFee, serviceFee: r.serviceFee, grossEarnings: r.grossEarnings });
} else if (type.startsWith('resolution') || type === 'adjustment') {
const held = byCode.get(code) || { ...base, adjustments: 0 };
held.adjustments = (held.adjustments || 0) + (r.amount || 0);
byCode.set(code, held);
} else if (type.startsWith('cancellation fee')) {
cancelled.set(code, { ...base });
}
});
const stays = [...byCode.values()].filter((s) => s.amount != null && s.checkin && s.checkout).map((s) => ({ ...s, arriving: payoutArriving.get(s.date) || '', net: Math.round((s.amount + (s.adjustments || 0)) * 100) / 100 }));
stays.sort((a, b) => b.checkin.localeCompare(a.checkin));
return { stays, cancelled: [...cancelled.values()].filter((c) => !byCode.has(c.code)) };
}

// Straight from a file's text, without storing anything (what the matching reads).
function parseEarningsCsv(text) {
const { records, error } = rowsFromCsv(text);
if (error) return { stays: [], cancelled: [], error };
return parseFromRecords(records);
}

// The listing a stay was on: from a booking request with the same code, else the chosen
// owner's listing in the room the title names ("Ensuite …" / "Double …").
function listingFor(stay, ownerKey) {
const q = (data.bookingRequests || []).find((x) => x.confirmationCode === stay.code && x.listingId);
if (q) return q.listingId;
const title = stay.listingTitle.toLowerCase().replace(/[^a-z]/g, '');
const room = nightRateRooms().find((r) => title.startsWith(String(r.label || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 6)));
if (!room) return '';
const mine = room.listingIds.filter((id) => { const l = (data.airbnbListings || []).find((x) => x.id === id); return l && ownerKeyFor(l) === ownerKey; });
return mine.length === 1 ? mine[0] : '';
}

const ledgerCheckin = (e) => e.startDate || e.checkin || '';

// What applying would do, without doing it.
function planImport(parsed, ownerKey) {
const claimed = new Set();
const roomOf = new Map();
nightRateRooms().forEach((r) => r.listingIds.forEach((id) => roomOf.set(id, r.key)));
const items = parsed.stays.map((s) => {
const listingId = listingFor(s, ownerKey);
const item = { s, listingId, kind: 'none', target: null, fill: {}, differs: [] };
let stay = (data.airbnbReservations || []).find((r) => r.confirmationCode === s.code);
if (!stay && listingId) stay = (data.airbnbReservations || []).find((r) => roomOf.get(r.listingId) === roomOf.get(listingId) && r.checkin === s.checkin && r.checkout === s.checkout && r.status !== 'cancelled');
if (stay && !claimed.has(stay.id)) {
claimed.add(stay.id);
item.kind = 'stay'; item.target = stay;
if (!stay.confirmationCode) item.fill.confirmationCode = s.code;
if (!stay.confirmedOn && s.bookingDate) item.fill.confirmedOn = s.bookingDate;
if (stay.income == null) item.fill.income = s.amount;
else if (!within(stay.income, s.amount, 1) && !within(stay.income, s.net, 1)) item.differs.push(`income £${stay.income} here, £${s.amount} in the export`);
if (stay.checkin !== s.checkin || stay.checkout !== s.checkout) item.differs.push(`dates ${stay.checkin}–${stay.checkout} here, ${s.checkin}–${s.checkout} in the export`);
return item;
}
const until = dateStrAdd(s.arriving || s.date || s.checkout, s.arriving ? 10 : 14);
const from = dateStrAdd(s.date || s.checkout, -3);
const hits = (data.lettingLedger || []).filter((e) => ['earned', 'accrual', 'cancellation'].includes(e.kind) && !claimed.has(e.id)
&& (e.confirmationCode === s.code || ((near(e.gross, s.amount) || near(e.gross, s.net) || near(e.amount, s.amount) || near(e.amount, s.net)) && e.date >= from && e.date <= until)));
const byCode = hits.find((e) => e.confirmationCode === s.code);
let entry = byCode || (hits.length === 1 ? hits[0] : null);
// Looser, for entries typed by hand at the month end with a rounded amount: within £1, dated
// from check-in to six weeks after checkout, same room, and the guest's name must fit.
if (!entry && !hits.length) {
const loose = (data.lettingLedger || []).filter((e) => ['earned', 'accrual', 'cancellation'].includes(e.kind) && !claimed.has(e.id)
&& (within(e.gross, s.amount, 1) || within(e.gross, s.net, 1) || within(e.amount, s.amount, 1) || within(e.amount, s.net, 1))
&& e.date >= dateStrAdd(s.checkin, -3) && e.date <= dateStrAdd(s.checkout, 45)
&& (!listingId || !e.listingId || roomOf.get(e.listingId) === roomOf.get(listingId))
&& nameFits(e.guest || e.note, s.guest));
if (loose.length === 1) entry = loose[0];
else if (loose.length > 1) { item.ambiguous = true; return item; }
}
if (!entry) { item.ambiguous = hits.length > 1; return item; }
claimed.add(entry.id);
item.kind = 'ledger'; item.target = entry;
const derived = !e2Has(entry, 'startDate') && !e2Has(entry, 'checkin');
if (entry.kind === 'cancellation') {
if (!entry.checkin) item.fill.checkin = s.checkin;
if (!entry.checkout) item.fill.checkout = s.checkout;
} else {
if (derived || ledgerCheckin(entry) === s.checkin) { if (entry.startDate !== s.checkin) item.fill.startDate = s.checkin; }
else item.differs.push(`check-in ${ledgerCheckin(entry)} here, ${s.checkin} in the export`);
if (!entry.nights) item.fill.nights = s.nights;
else if (s.nights != null && Number(entry.nights) !== s.nights) item.differs.push(`${entry.nights} nights here, ${s.nights} in the export`);
}
if (!entry.bookedOn && s.bookingDate) item.fill.bookedOn = s.bookingDate;
if (!entry.confirmationCode) item.fill.confirmationCode = s.code;
if (!entry.listingId && listingId) item.fill.listingId = listingId;
if ((!entry.guest || entry.guest === entry.description) && s.guest) item.fill.guest = s.guest;
else if (entry.guest && s.guest && !entry.guest.toLowerCase().includes(s.guest.split(/\s+/)[0].toLowerCase())) item.differs.push(`guest "${entry.guest}" here, "${s.guest}" in the export`);
return item;
});
return items;
}
function e2Has(e, k) { return !!(e && e[k]); }

function applyImport(items, { addMissing = false, ownerKey }) {
let filled = 0; let added = 0;
items.forEach((it) => {
if ((it.kind === 'stay' || it.kind === 'ledger') && Object.keys(it.fill).length) {
Object.assign(it.target, it.fill);
filled++;
}
if (addMissing && it.kind === 'none' && !it.ambiguous) {
const s = it.s;
const listing = (data.airbnbListings || []).find((l) => l.id === it.listingId) || (data.airbnbListings || []).find((l) => ownerKeyFor(l) === ownerKey);
const date = s.arriving || s.date || s.checkout;
const gross = s.amount;
data.lettingLedger.push({
id: uid(), ownerKey, kind: 'earned', gross, pct: shareRuleAt(listing, date).pct,
amount: Math.round(splitAmountFor(listing, gross, date) * 100) / 100,
nights: s.nights || undefined, startDate: s.checkin, bookedOn: s.bookingDate || undefined,
confirmationCode: s.code, listingId: it.listingId || undefined, platform: 'airbnb', date,
guest: s.guest, description: 'From the Airbnb earnings export', note: s.guest || 'Airbnb stay',
});
added++;
}
});
queueSave();
return { filled, added };
}

// ---- UI: an import block in the Letting panel ----------------------------------------------

const state = { parsed: null, items: null, ownerKey: '' };
const short = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const money = (v) => `£${Number(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const FIELD_LABEL = { confirmationCode: 'booking code', confirmedOn: 'booking date', bookedOn: 'booking date', income: 'payout', startDate: 'check-in', nights: 'nights', listingId: 'room', guest: 'guest', checkin: 'check-in', checkout: 'check-out' };

// A link to an income entry: switches to Finances and flashes its row.
function ledgerLinkHtml(e, text) {
return `<span class="inline-goto-link" data-open-ledger="${escapeHtml(e.id)}" title="Open this Letting income entry">${escapeHtml(text)}</span>`;
}

function reportHtml() {
const items = state.items;
const { stayChipHtml } = state;
const matched = items.filter((i) => i.kind !== 'none');
const willFill = matched.filter((i) => Object.keys(i.fill).length);
const missing = items.filter((i) => i.kind === 'none');
const differs = matched.filter((i) => i.differs.length);
const row = (i) => {
const s = i.s;
const what = `${s.guest || 'Guest'} · ${short(s.checkin)} – ${short(s.checkout)} · ${money(s.amount)}${s.adjustments ? ` (${money(s.net)} after refunds)` : ''}`;
const target = i.kind === 'stay' ? stayChipHtml(i.target) : i.kind === 'ledger' ? ledgerLinkHtml(i.target, `${i.target.kind === 'cancellation' ? 'Cancellation' : 'Income'} entry ${short(i.target.date)}`) : '';
const fill = Object.keys(i.fill).map((k) => FIELD_LABEL[k] || k);
return `<div class="aex-row"><span class="aex-what">${escapeHtml(what)}</span><span class="aex-target">${target}</span>${fill.length ? `<span class="settings-note" style="margin:0;">adds ${escapeHtml(fill.join(', '))}</span>` : ''}${i.differs.length ? `<span class="aex-differs">${escapeHtml(i.differs.join('; '))} (yours kept)</span>` : ''}${i.ambiguous ? '<span class="aex-differs">more than one entry fits; left alone</span>' : ''}</div>`;
};
const cancelledNote = state.parsed.cancelled.length ? `<div class="settings-note" style="margin:6px 0 0;">${state.parsed.cancelled.length} booking${state.parsed.cancelled.length === 1 ? ' was' : 's were'} cancelled with nothing paid (${state.parsed.cancelled.map((c) => `${escapeHtml(c.guest || 'guest')}, ${escapeHtml(short(c.checkin))}`).join('; ')}); not added.</div>` : '';
return `<div class="settings-note" style="margin:8px 0 4px;"><b>${items.length}</b> stays in the file: <b>${matched.length}</b> found here (${willFill.length} gain details), <b>${missing.length}</b> not in Letting income${differs.length ? `, <b>${differs.length}</b> differ from what you entered (yours kept)` : ''}.</div>
${matched.length ? `<details class="settings-subgroup"${willFill.length ? ' open' : ''}><summary>Found here (${matched.length})</summary><div class="aex-list">${matched.map(row).join('')}</div></details>` : ''}
${missing.length ? `<details class="settings-subgroup" open><summary>Not in Letting income (${missing.length}, ${money(missing.reduce((a, i) => a + i.s.amount, 0))})</summary><div class="aex-list">${missing.map(row).join('')}</div>
<label class="settings-note" style="margin:4px 0 0;display:flex;gap:6px;align-items:center;"><input type="checkbox" id="aex-add-missing"> Add these as Earned entries for ${escapeHtml(ownerNameFor(state.ownerKey))} (each with its dates, nights, booking date and code)</label></details>` : ''}
${cancelledNote}
<div class="sync-row" style="margin-top:8px;"><button class="sync-btn sm inline" type="button" id="aex-apply">Apply</button><span class="sync-status" id="aex-status"></span></div>`;
}

function blockHtml() {
const keys = owners();
return `<details class="settings-subgroup" id="airbnb-earnings-import" style="margin-top:10px;"><summary>Import Airbnb earnings (CSV)</summary>
<div class="settings-note" style="margin:4px 0 6px;">Airbnb: Menu → Earnings → Transaction history → Export CSV. Each Airbnb account exports its own payouts, so say whose it is. Matching stays and income entries gain their booking code, booking date and real dates; nothing you entered is overwritten. You see what it would do before anything changes.</div>
<div class="sync-row" style="align-items:center;">
<label class="settings-note" style="margin:0;">Whose account <select id="aex-owner" class="settings-input">${keys.map((k) => `<option value="${escapeHtml(k)}">${escapeHtml(ownerNameFor(k))}</option>`).join('')}</select></label>
<input type="file" id="aex-file" accept=".csv,text/csv">
</div>
<div class="settings-note" id="aex-stored" style="margin:4px 0;"></div>
<div id="aex-report"></div>
</details>`;
}

let bound = false;
async function initAirbnbEarningsImport() {
const anchor = document.getElementById('letting-cleaning-cost');
const row = anchor && anchor.closest('.sync-row');
if (!row || document.getElementById('airbnb-earnings-import')) return;
row.insertAdjacentHTML('afterend', blockHtml());
const { stayChipHtml, bindStayChips } = await import('./airbnb.js');
state.stayChipHtml = stayChipHtml;
bindStayChips();
if (bound) return;
bound = true;
const root = document.getElementById('airbnb-earnings-import');
const report = () => document.getElementById('aex-report');
const storedNote = () => {
  const el = document.getElementById('aex-stored');
  if (!el) return;
  const rows = data.airbnbEarnings || [];
  const stays = rows.filter((r) => r.type.toLowerCase() === 'reservation').length;
  const dates = rows.map((r) => r.date).filter(Boolean).sort();
  const who = [...new Set(rows.map((r) => r.ownerKey))].map((k) => ownerNameFor(k)).join(', ');
  el.innerHTML = rows.length ? `Stored in full: ${rows.length} rows (${stays} stays) from ${escapeHtml(who)}, ${escapeHtml(dates[0])} to ${escapeHtml(dates[dates.length - 1])}. The booking model reads its rates and cleaning fees from these. <button class="sync-btn sm inline" type="button" id="aex-rerun-stored" title="Match the stored rows of the chosen account to your stays and income entries again, without the file">Match stored rows</button>` : 'Nothing stored yet: the rows of every file you pick are kept in full.';
};
storedNote();
const rerun = () => {
if (!state.parsed) return;
state.ownerKey = document.getElementById('aex-owner').value;
state.items = planImport(state.parsed, state.ownerKey);
report().innerHTML = reportHtml();
};
root.addEventListener('change', async (e) => {
if (e.target.id === 'aex-file') {
const file = e.target.files && e.target.files[0];
if (!file) return;
const text = await file.text();
const ownerKey = document.getElementById('aex-owner').value;
const read = rowsFromCsv(text, ownerKey, file.name);
if (read.error) { report().innerHTML = `<div class="settings-note" style="margin:6px 0;">${escapeHtml(read.error)}</div>`; state.parsed = null; return; }
const saved = storeEarnings(read.records, ownerKey);
state.parsed = parseFromRecords(read.records);
rerun();
storedNote();
const note = document.createElement('div'); note.className = 'settings-note'; note.style.margin = '4px 0';
note.textContent = `Read ${read.records.length} rows from ${file.name}: ${saved.added} new, ${saved.already} already stored.`;
report().prepend(note);
} else if (e.target.id === 'aex-owner') rerun();
});
root.addEventListener('click', (e) => {
if (e.target.closest('#aex-rerun-stored')) {
const ownerKey = document.getElementById('aex-owner').value;
state.parsed = parseFromRecords((data.airbnbEarnings || []).filter((r) => r.ownerKey === ownerKey));
rerun();
return;
}
const link = e.target.closest('[data-open-ledger]');
if (link) { scrollAndFlash(`[data-letting-date="${CSS.escape(link.dataset.openLedger)}"]`); return; }
if (!e.target.closest('#aex-apply') || !state.items) return;
const addMissing = !!(document.getElementById('aex-add-missing') || {}).checked;
const r = applyImport(state.items, { addMissing, ownerKey: state.ownerKey });
import('./bookingrequests.js').then((m) => { m.resolveRequestOutcomes(); queueSave(); });
renderLetting();
rerun();
const status = document.getElementById('aex-status');
if (status) status.textContent = `Filled in ${r.filled} stay${r.filled === 1 ? '' : 's'} and entr${r.filled === 1 ? 'y' : 'ies'}${r.added ? `; added ${r.added} Earned entr${r.added === 1 ? 'y' : 'ies'}` : ''}.`;
});
}

export { parseEarningsCsv, parseFromRecords, rowsFromCsv, storeEarnings, planImport, applyImport, initAirbnbEarningsImport };
