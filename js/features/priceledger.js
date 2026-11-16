// Price ledger (PRICING-PLAN.md phase 2): the asking price of each room, night by night, kept in the shape of a Beds24
// calendar day so the "Prices are pushed by: Me / Beds24" switch (phase 8) never has to change a stored record.
//
// ---- Beds24 API v2 shape this is modelled on (checked 16 Nov 2026) -------------------------------------------------
// Sources: OpenAPI spec https://beds24.com/api/v2/apiV2.yaml (components/schemas/calendar) and the wiki page
// https://wiki.beds24.com/index.php/API_V2.0 (Swagger UI: https://beds24.com/api/v2/).
//   GET  /inventory/rooms/calendar  "Get's per day values from the calendar."   (needs includePrices / includeMinStay /
//        includeMaxStay / includeNumAvail / includeMultiplier / includeOverride; with none, nothing is returned)
//   POST /inventory/rooms/calendar  "Modify per day calendar values."           (writes need a refresh-token token)
// Response is [{ roomId: integer, calendar: [ day items ] }]. A day item (a date RANGE: `from` and `to`, both date) has:
//   from, to        string, format date
//   numAvail        integer, may be negative if overbooked  ("reduce availability for a date by sending numAvail")
//   minStay         integer 1..365   (room's own value is returned when unset in the calendar)
//   maxStay         integer 1..364
//   multiplier      number 0.1..100, default 1
//   override        string enum: none | blackout | exception | noCheckIn | noCheckOut | noCheckInOrCheckOut
//                   ("To close a date completely set the override to blackout, and to reopen it ... back to none")
//   price1..price16 number (double). "A room can have up to 16 prices." price1 is the room's standard daily price.
//   channels        object keyed by channel (airbnb, booking, expedia, vrbo, agoda...), each {maxBookings: integer|null}
// Setting a property to null removes it. Not in this schema: separate closed-to-arrival / closed-to-departure booleans
// (that is the `override` enum above), cleaning fee, discounts. Reservation "booking made" date is NOT part of the
// calendar; it is on /bookings and is still unchecked for phase 8.
//
// ---- Mapping (ledger field -> Beds24) -------------------------------------------------------------------------------
//   roomKey          -> roomId (the evaluator's room key; the Beds24 roomId is looked up from a setting in phase 8)
//   date             -> from = to = date (one record per night; a range is just consecutive nights)
//   price            -> price1
//   minStay / maxStay-> minStay / maxStay
//   numAvail         -> numAvail
//   multiplier       -> multiplier (the "channel multiplier" row of PRICING-PLAN B)
//   override         -> override (same enum, same spelling)
// Ledger-only (Beds24 has no such field): source, setAt, confirmedAt, history.
//
// ---- Record and history ----------------------------------------------------------------------------------------------
// One record per room-night, id `${roomKey}:${date}` (blankPriceLedgerEntry in state.js; syncs as a per-record
// collection, js/sync/collections.js). `history` is an append-only array INSIDE the record, one entry
// {at, price, minStay, override, source} each time price, minStay or override really changes (and one on creation).
// Chosen over separate history rows because a night's price changes a handful of times, so the array stays tiny, it
// travels and conflicts as one unit with the night it describes, and a separate row type would multiply the synced
// rows (rooms x nights x changes). Re-entering the same values only refreshes `confirmedAt`; it adds no history, so the
// history is a record of price CHANGES, which is what an elasticity fit needs.
// source: 'airbnb-calendar' (read back by phase 7) | 'manual' (typed here) | 'model-proposal' (applied from a proposal).
import { data, queueSave, blankPriceLedgerEntry } from '../state.js';
import { escapeHtml, todayStr, dateStrAdd } from '../utils.js';

const SOURCES = ['airbnb-calendar', 'manual', 'model-proposal'];
const SOURCE_TEXT = { 'airbnb-calendar': 'read from Airbnb', manual: 'entered by hand', 'model-proposal': 'from a model proposal' };
const OVERRIDES = ['none', 'blackout', 'exception', 'noCheckIn', 'noCheckOut', 'noCheckInOrCheckOut'];
const MAX_RANGE_NIGHTS = 366;

const ledgerId = (roomKey, date) => `${roomKey}:${date}`;
const sameVal = (a, b) => (a == null ? null : a) === (b == null ? null : b);
const shortDay = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const money0 = (n) => `£${Math.round(n).toLocaleString('en-GB')}`;

function ledgerEntry(roomKey, date) {
return (data.priceLedger || []).find((r) => r.roomKey === roomKey && r.date === date) || null;
}

// Record a price (and optionally minimum nights) for every night from `from` to `to` INCLUSIVE.
// fields: {price, minStay, override, numAvail, maxStay, multiplier}; only those passed (not undefined) are set.
// Returns {nights, created, changed, unchanged} or {error}.
function setLedgerRange({ roomKey, from, to, source = 'manual', ...fields }) {
if (!roomKey) return { error: 'Pick a room.' };
if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) return { error: 'Pick both dates.' };
if (to < from) return { error: 'The last night is before the first.' };
if (!SOURCES.includes(source)) return { error: `Unknown source "${source}".` };
if (fields.price !== undefined && fields.price !== null && !(Number(fields.price) > 0)) return { error: 'The price must be above zero.' };
if (fields.minStay != null && !(Number.isInteger(Number(fields.minStay)) && fields.minStay >= 1 && fields.minStay <= 365)) return { error: 'Minimum nights must be 1 to 365.' };
if (fields.override !== undefined && !OVERRIDES.includes(fields.override)) return { error: 'Unknown override.' };
const nights = [];
for (let d = from; d <= to && nights.length <= MAX_RANGE_NIGHTS; d = dateStrAdd(d, 1)) nights.push(d);
if (nights.length > MAX_RANGE_NIGHTS) return { error: `That is more than ${MAX_RANGE_NIGHTS} nights.` };
if (!Array.isArray(data.priceLedger)) data.priceLedger = [];
const now = new Date().toISOString();
const out = { nights: nights.length, created: 0, changed: 0, unchanged: 0 };
nights.forEach((date) => {
let rec = ledgerEntry(roomKey, date);
const isNew = !rec;
if (isNew) { rec = blankPriceLedgerEntry({ id: ledgerId(roomKey, date), roomKey, date }); data.priceLedger.push(rec); }
const before = { price: rec.price, minStay: rec.minStay, override: rec.override };
['price', 'minStay', 'maxStay', 'numAvail', 'multiplier', 'override'].forEach((k) => {
if (fields[k] !== undefined) rec[k] = fields[k] === null || fields[k] === '' ? (k === 'override' ? 'none' : k === 'multiplier' ? 1 : null) : (k === 'override' ? fields[k] : Number(fields[k]));
});
const moved = isNew || !sameVal(before.price, rec.price) || !sameVal(before.minStay, rec.minStay) || before.override !== rec.override;
rec.confirmedAt = now;
if (moved) {
rec.source = source; rec.setAt = now;
rec.history.push({ at: now, price: rec.price, minStay: rec.minStay, override: rec.override, source });
if (isNew) out.created++; else out.changed++;
} else out.unchanged++;
});
queueSave();
return out;
}

// ---- Shown in the price breakdown ----------------------------------------------------------------------------------------
// One line: "£120, min 2 nights, entered by hand 14 Nov (changed 2 times)". null when nothing is recorded for the night.
function ledgerLine(roomKey, date) {
const r = ledgerEntry(roomKey, date);
if (!r || r.price == null) return null;
const changes = Math.max(0, (r.history || []).length - 1);
const parts = [money0(r.price)];
if (r.minStay != null) parts.push(`min ${r.minStay} night${Number(r.minStay) === 1 ? '' : 's'}`);
if (r.override && r.override !== 'none') parts.push(r.override === 'blackout' ? 'closed' : r.override.replace(/([A-Z])/g, ' $1').toLowerCase());
parts.push(`${SOURCE_TEXT[r.source] || r.source}${r.setAt ? ` ${shortDay(r.setAt.slice(0, 10))}` : ''}`);
return parts.join(', ') + (changes ? ` (changed ${changes} time${changes === 1 ? '' : 's'})` : '');
}

// ---- The compact entry form ------------------------------------------------------------------------------------------------
// Number boxes, date pickers and a room select only (no free text). `rooms` = [{key,label}].
function ledgerFormHtml(rooms, roomKey) {
const opts = rooms.map((r) => `<option value="${escapeHtml(r.key)}"${r.key === roomKey ? ' selected' : ''}>${escapeHtml(r.label)}</option>`).join('');
const t = todayStr();
return `<div class="sync-row pl-form" id="pl-form" style="align-items:center;flex-wrap:wrap;gap:8px;margin-top:8px;">
<span class="settings-note" style="margin:0;">Set in Airbnb:</span>
<select id="pl-room" class="mini" title="Room">${opts}</select>
<label class="settings-note" style="margin:0;">from <input type="date" id="pl-from" class="settings-input" value="${t}" style="width:140px;"></label>
<label class="settings-note" style="margin:0;">to (last night) <input type="date" id="pl-to" class="settings-input" value="${t}" style="width:140px;"></label>
<label class="settings-note" style="margin:0;">£ a night <input type="number" id="pl-price" class="settings-input" min="1" step="1" style="width:72px;"></label>
<label class="settings-note" style="margin:0;">min nights <input type="number" id="pl-min" class="settings-input" min="1" max="365" step="1" style="width:56px;" placeholder="same"></label>
<button type="button" class="sync-btn sm inline" id="pl-save" title="Record this price in the ledger for each night in the range">Record</button>
<span class="sync-status" id="pl-status"></span>
</div>`;
}

// Wire the form's Record button (delegated on `root`, so it survives the panel re-rendering). `onSaved` redraws the
// breakdown so the new price shows. Status text is built with textContent.
function bindLedgerForm(root, onSaved) {
root.addEventListener('click', (e) => {
if (!e.target.closest('#pl-save')) return;
const g = (id) => root.querySelector(`#${id}`);
const status = g('pl-status');
const say = (t) => { if (status) status.textContent = t; };
const price = g('pl-price').value;
const min = g('pl-min').value;
if (price === '' && min === '') { say('Enter a price or minimum nights.'); return; }
const f = { roomKey: g('pl-room').value, from: g('pl-from').value, to: g('pl-to').value, source: 'manual' };
if (price !== '') f.price = Number(price);
if (min !== '') f.minStay = Number(min);
const res = setLedgerRange(f);
if (res.error) { say(res.error); return; }
const bits = [res.created && `${res.created} new`, res.changed && `${res.changed} changed`, res.unchanged && `${res.unchanged} already that`].filter(Boolean);
say(`${res.nights} night${res.nights === 1 ? '' : 's'}: ${bits.join(', ')}.`);
if (typeof onSaved === 'function') onSaved(res);
});
}

export { ledgerEntry, setLedgerRange, ledgerLine, ledgerFormHtml, bindLedgerForm, ledgerId, OVERRIDES, SOURCES };
