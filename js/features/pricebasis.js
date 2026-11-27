// A stay's price basis: whether what it paid is a market price the booking model can learn its rates from.
// `priceBasis` on a record: absent = market price; { kind: 'discount', pct } = you gave a special discount the model can't
// know about (cash, goodwill, a friend), undone on that stay like the short-notice one; { kind: 'exclude' } = not a market
// price at all, left out of the rates (the stay still counts as a booking). Kept on the income entry, the Airbnb stay it
// came from and the earnings rows with the same booking code, as partysize.js does for the party size, so the model finds
// it whichever record it reads. Set from the Letting income row's detail panel.
import { data } from '../state.js';

function normaliseBasis(b) {
if (!b || typeof b !== 'object') return null;
if (b.kind === 'exclude') return { kind: 'exclude' };
const pct = Number(b.pct);
if (b.kind === 'discount' && pct > 0 && pct < 90) return { kind: 'discount', pct: Math.round(pct * 10) / 10 };
return null;
}

function byCode(code) {
if (!code) return null;
for (const list of [data.lettingLedger, data.airbnbReservations, data.airbnbEarnings]) {
const hit = (list || []).find((x) => x.confirmationCode === code && normaliseBasis(x.priceBasis));
if (hit) return normaliseBasis(hit.priceBasis);
}
return null;
}

// `id`: an Airbnb stay's id, `led:<income entry id>`, or an income entry's own id with `ledger: true`.
function priceBasisOf(id, { ledger = false } = {}) {
const sid = String(id || '');
if (ledger || sid.startsWith('led:')) {
const e = (data.lettingLedger || []).find((x) => x.id === (ledger ? sid : sid.slice(4)));
if (!e) return null;
const own = normaliseBasis(e.priceBasis);
if (own) return own;
const r = e.reservationId ? (data.airbnbReservations || []).find((x) => x.id === e.reservationId) : null;
if (r && normaliseBasis(r.priceBasis)) return normaliseBasis(r.priceBasis);
return byCode(e.confirmationCode || (r && r.confirmationCode));
}
const r = (data.airbnbReservations || []).find((x) => x.id === sid);
if (!r) return null;
return normaliseBasis(r.priceBasis) || byCode(r.confirmationCode);
}

// `basis` null clears it (back to a market price). Returns false when the record isn't found.
function setPriceBasis(id, basis) {
const v = normaliseBasis(basis);
const sid = String(id || '');
const put = (x) => { if (v) x.priceBasis = v; else delete x.priceBasis; };
let code = '';
if (sid.startsWith('led:')) {
const e = (data.lettingLedger || []).find((x) => x.id === sid.slice(4));
if (!e) return false;
put(e); code = e.confirmationCode || '';
const r = e.reservationId ? (data.airbnbReservations || []).find((x) => x.id === e.reservationId) : null;
if (r) { put(r); code = code || r.confirmationCode || ''; }
} else {
const r = (data.airbnbReservations || []).find((x) => x.id === sid);
if (!r) return false;
put(r); code = r.confirmationCode || '';
}
if (code) [data.lettingLedger, data.airbnbReservations, data.airbnbEarnings].forEach((list) => (list || []).forEach((x) => { if (x.confirmationCode === code) put(x); }));
return true;
}

const priceBasisLabel = (b) => !b ? '' : b.kind === 'exclude' ? 'not a market price' : `special discount ${b.pct}%`;

export { normaliseBasis, priceBasisOf, setPriceBasis, priceBasisLabel };
