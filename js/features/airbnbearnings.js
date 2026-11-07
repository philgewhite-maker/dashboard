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
import { data, queueSave } from '../state.js';
import { escapeHtml, splitCsvLine, dateStrAdd, scrollAndFlash, uid } from '../utils.js';
import { owners, ownerNameFor, ownerKeyFor, splitAmountFor, shareRuleAt, nightRateRooms, renderLetting } from './letting.js';

const usDate = (s) => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || '').trim()); return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : ''; };
const num = (s) => { const v = Number(String(s || '').replace(/[£,\s]/g, '')); return Number.isFinite(v) && String(s || '').trim() !== '' ? v : null; };
const near = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.02;

// One record per HM code: the reservation row plus what adjusts it.
function parseEarningsCsv(text) {
const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
if (!lines.length) return { stays: [], cancelled: [], error: 'The file is empty.' };
const head = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
const col = (name) => head.indexOf(name);
const need = ['date', 'type', 'confirmation code', 'start date', 'end date', 'amount'];
const missing = need.filter((n) => col(n) < 0);
if (missing.length) return { stays: [], cancelled: [], error: `This doesn't look like Airbnb's earnings export (no ${missing.join(', ')} column).` };
const rows = lines.slice(1).map((l) => { const c = splitCsvLine(l); const g = (n) => (col(n) >= 0 ? (c[col(n)] || '').trim() : ''); return g; });
const payoutArriving = new Map(); // payout date -> latest arriving-by date that day
const byCode = new Map();
const cancelled = new Map();
rows.forEach((g) => {
const type = g('type').toLowerCase();
const date = usDate(g('date'));
if (type === 'payout') {
const arr = usDate(g('arriving by date'));
if (date && arr && (!payoutArriving.has(date) || payoutArriving.get(date) < arr)) payoutArriving.set(date, arr);
return;
}
const code = g('confirmation code');
if (!code) return;
const base = { code, bookingDate: usDate(g('booking date')), checkin: usDate(g('start date')), checkout: usDate(g('end date')), nights: num(g('nights')), guest: g('guest').trim(), listingTitle: g('listing'), date };
if (type === 'reservation') {
byCode.set(code, { ...(byCode.get(code) || { adjustments: 0 }), ...base, amount: num(g('amount')), cleaningFee: num(g('cleaning fee')), serviceFee: num(g('service fee')), grossEarnings: num(g('gross earnings')) });
} else if (type.startsWith('resolution') || type === 'adjustment') {
const held = byCode.get(code) || { ...base, adjustments: 0 };
held.adjustments = (held.adjustments || 0) + (num(g('amount')) || 0);
byCode.set(code, held);
} else if (type.startsWith('cancellation fee')) {
cancelled.set(code, { ...base });
}
});
const stays = [...byCode.values()].filter((s) => s.amount != null && s.checkin && s.checkout).map((s) => ({ ...s, arriving: payoutArriving.get(s.date) || '', net: Math.round((s.amount + (s.adjustments || 0)) * 100) / 100 }));
stays.sort((a, b) => b.checkin.localeCompare(a.checkin));
return { stays, cancelled: [...cancelled.values()].filter((c) => !byCode.has(c.code)) };
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
else if (!near(stay.income, s.amount) && !near(stay.income, s.net)) item.differs.push(`income £${stay.income} here, £${s.amount} in the export`);
if (stay.checkin !== s.checkin || stay.checkout !== s.checkout) item.differs.push(`dates ${stay.checkin}–${stay.checkout} here, ${s.checkin}–${s.checkout} in the export`);
return item;
}
const until = dateStrAdd(s.arriving || s.date || s.checkout, s.arriving ? 10 : 14);
const from = dateStrAdd(s.date || s.checkout, -3);
const hits = (data.lettingLedger || []).filter((e) => ['earned', 'accrual', 'cancellation'].includes(e.kind) && !claimed.has(e.id)
&& (e.confirmationCode === s.code || ((near(e.gross, s.amount) || near(e.gross, s.net) || near(e.amount, s.amount) || near(e.amount, s.net)) && e.date >= from && e.date <= until)));
const byCode = hits.find((e) => e.confirmationCode === s.code);
const entry = byCode || (hits.length === 1 ? hits[0] : null);
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
state.parsed = parseEarningsCsv(await file.text());
if (state.parsed.error) { report().innerHTML = `<div class="settings-note" style="margin:6px 0;">${escapeHtml(state.parsed.error)}</div>`; state.parsed = null; return; }
rerun();
} else if (e.target.id === 'aex-owner') rerun();
});
root.addEventListener('click', (e) => {
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

export { parseEarningsCsv, planImport, applyImport, initAirbnbEarningsImport };
