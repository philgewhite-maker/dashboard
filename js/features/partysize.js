// A booking's party size (guests), wherever it is on record, and setting it in the right place.
// Sources, first that has one: the record itself (an Airbnb stay's `guests`, or an income entry's own `guests`), then, for
// an income entry, the Airbnb stay it was made from (its reservationId: most synced entries carry no booking code), then the
// earnings-export row with the same booking code (filled from its confirmation email, airbnb.js backfillEarningGuests),
// then an Airbnb stay with that code. Used by the Letting income list, the occupancy page's data-gaps list and, through
// the same fields, the booking model's extra-guest charge.
import { data } from '../state.js';

function byCode(code) {
if (!code) return null;
const row = (data.airbnbEarnings || []).find((e) => e.confirmationCode === code && Number(e.guests) > 0);
if (row) return Number(row.guests);
const r = (data.airbnbReservations || []).find((x) => x.confirmationCode === code && Number(x.guests) > 0);
return r ? Number(r.guests) : null;
}

// `id`: an Airbnb stay's id, or `led:<income entry id>` (the occupancy page's ids), or an income entry's own id with
// `ledger: true`.
function partySizeOf(id, { ledger = false } = {}) {
const sid = String(id || '');
if (ledger || sid.startsWith('led:')) {
const e = (data.lettingLedger || []).find((x) => x.id === (ledger ? sid : sid.slice(4)));
if (!e) return null;
if (Number(e.guests) > 0) return Number(e.guests);
const r = e.reservationId ? (data.airbnbReservations || []).find((x) => x.id === e.reservationId) : null;
if (r && Number(r.guests) > 0) return Number(r.guests);
return byCode(e.confirmationCode || (r && r.confirmationCode));
}
const r = (data.airbnbReservations || []).find((x) => x.id === sid);
if (!r) return null;
return Number(r.guests) > 0 ? Number(r.guests) : byCode(r.confirmationCode);
}

// Sets it on the record, and on the earnings rows with the same booking code (what the booking model reads first).
function setPartySize(id, n) {
const v = Math.round(Number(n));
if (!(v >= 1 && v <= 30)) return false;
const sid = String(id || '');
let code = '';
if (sid.startsWith('led:')) {
const e = (data.lettingLedger || []).find((x) => x.id === sid.slice(4));
if (!e) return false;
e.guests = v; code = e.confirmationCode || '';
const r = e.reservationId ? (data.airbnbReservations || []).find((x) => x.id === e.reservationId) : null;
if (r) { r.guests = v; r.guestDetail = null; code = code || r.confirmationCode || ''; }
} else {
const r = (data.airbnbReservations || []).find((x) => x.id === sid);
if (!r) return false;
r.guests = v; r.guestDetail = null; code = r.confirmationCode || '';
}
if (code) (data.airbnbEarnings || []).forEach((e) => { if (e.confirmationCode === code) { e.guests = v; e.guestDetail = null; } });
return true;
}

// An income row that is one rent payment of a long let (a stay record with letType 'long' lists it in paymentIds): it
// needs no party size of its own, as on the occupancy page's data-gaps list.
const isLongLetPayment = (ledgerId) => (data.airbnbReservations || []).some((r) => r.letType === 'long' && r.status !== 'cancelled' && (r.paymentIds || []).includes(ledgerId));

const partyLabel = (n) => `${n} guest${n === 1 ? '' : 's'}`;

export { partySizeOf, setPartySize, partyLabel, isLongLetPayment };
