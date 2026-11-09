// Settings -> Finances -> Booking evaluator: the assumptions the booking evaluator
// (js/features/bookingmodel.js) starts from, stored in data.prefs.bookingEvaluator
// (defaults in state.js DEFAULT_PREFS). Every box is a number or a tick; the model blends
// each with your own data as it builds up.
import { data, queueSave, DEFAULT_PREFS } from '../state.js';
import { escapeHtml, uid } from '../utils.js';
import { nightRateRooms } from './letting.js';

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function settings() {
const s = { ...DEFAULT_PREFS.bookingEvaluator, ...(data.prefs.bookingEvaluator || {}) };
// Never edit the defaults' own arrays/objects in place (a spread copies their reference).
const d = DEFAULT_PREFS.bookingEvaluator;
if (s.leadMedian === d.leadMedian) s.leadMedian = [...d.leadMedian];
// The discount steps: own copies, so editing never reaches the defaults.
const dd = s.discounts || {};
const copySteps = (xs) => (Array.isArray(xs) ? xs.map((x) => ({ ...x })) : []);
s.discounts = { airbnb: { shortNotice: copySteps((dd.airbnb || {}).shortNotice), length: copySteps((dd.airbnb || {}).length) }, direct: { shortNotice: copySteps((dd.direct || {}).shortNotice), length: copySteps((dd.direct || {}).length) } };
if (s.rooms === d.rooms) s.rooms = {};
if (!Array.isArray(s.unavailable) || s.unavailable === d.unavailable) s.unavailable = Array.isArray(s.unavailable) ? s.unavailable.map((u) => ({ ...u })) : [];
if (!Array.isArray(s.voidPlans) || s.voidPlans === d.voidPlans) s.voidPlans = Array.isArray(s.voidPlans) ? s.voidPlans.map((p) => ({ ...p })) : [];
data.prefs.bookingEvaluator = s;
return s;
}

// Guest rooms the evaluator looks at: physical rooms (listings sharing a room count once),
// leaving out a space with no guests (cleaning switched off on all its listings).
function evaluatorRooms() {
return nightRateRooms().filter((room) => room.listingIds.some((id) => {
const l = (data.airbnbListings || []).find((x) => x.id === id);
return l && l.needsCleaning !== false;
}));
}

function roomSettings(key) {
const s = settings();
if (!s.rooms || typeof s.rooms !== 'object') s.rooms = {};
return { include: true, weight: 1, minNights: 1, priceWeekday: null, priceWeekend: null, ...(s.rooms[key] || {}) };
}

const numBox = (path, value, { step = 1, min = 0, width = 64, placeholder = '', title = '' } = {}) => `<input type="number" class="settings-input" data-be="${escapeHtml(path)}" value="${value == null ? '' : escapeHtml(String(value))}" step="${step}" min="${min}" style="width:${width}px;" placeholder="${escapeHtml(placeholder)}"${title ? ` title="${escapeHtml(title)}"` : ''}>`;
const row = (label, inner, note = '') => `<div class="be-set-row"><span class="be-set-label">${label}</span><span class="be-set-inputs">${inner}</span>${note ? `<span class="settings-note" style="margin:0;">${note}</span>` : ''}</div>`;

// Discounts, one block per channel, mirroring Airbnb: a list of short-notice steps (booked within N days of arrival
// takes P%) and a list of length steps (a stay of at least N nights takes P%). The largest of each applies.
function discountsHtml(s) {
const block = (channel, label, note) => {
const d = s.discounts[channel];
const list = (kind, steps, unit, text) => `<div class="be-disc-kind"><span class="settings-note" style="margin:0;">${text}</span>${steps.map((st, i) => `<div class="be-set-row"><span>${unit === 'days' ? 'within' : 'at least'} ${numBox(`discounts.${channel}.${kind}.${i}.${unit}`, st[unit], { width: 52 })} ${unit === 'days' ? 'days' : 'nights'} takes ${numBox(`discounts.${channel}.${kind}.${i}.pct`, st.pct, { width: 52, step: 0.5 })}%</span><span class="del-x" data-be-disc-del="${channel}.${kind}.${i}" title="Remove this step">&times;</span></div>`).join('')}<button class="sync-btn sm inline" type="button" data-be-disc-add="${channel}.${kind}">Add a step</button></div>`;
return `<div class="be-disc"><div style="font-size:12px;font-weight:600;margin:6px 0 2px;">${label}</div>${note ? `<div class="settings-note" style="margin:0 0 2px;">${note}</div>` : ''}${list('shortNotice', d.shortNotice, 'days', 'Short notice')}${list('length', d.length, 'nights', 'Longer stays')}</div>`;
};
return `<h4 class="be-set-h">Discounts</h4>
<div class="settings-note" style="margin:0 0 4px;">As on Airbnb: the nightly rate you set is cut by the largest short-notice step and the largest length step that apply to a booking. The model uses them two ways: it undoes them on past stays to get back to a raw nightly rate, and applies them to the bookings it simulates. The occasional guest-rating discount (such as 15% for top-rated guests) has no source in your data, so it stays inside the rate.</div>
${block('airbnb', 'Airbnb', '')}
${block('direct', 'Direct bookings (your own site)', 'Not used until bookings come through your own site.')}`;
}

function earningsDataHtml() {
const rows = data.airbnbEarnings || [];
if (!rows.length) return `<div class="settings-note" style="margin:0;">No Airbnb earnings stored yet. <span class="inline-goto-link" data-goto-tab="finances" data-goto-target="#airbnb-earnings-import">Import an earnings CSV</span> in Letting income: its rows are kept in full, and the raw nightly rates and cleaning fees below are worked out from them.</div>`;
const stays = rows.filter((r) => String(r.type).toLowerCase() === 'reservation').length;
const dates = rows.map((r) => r.date).filter(Boolean).sort();
const accounts = [...new Set(rows.map((r) => r.ownerKey))].length;
return `<div class="settings-note" style="margin:0;">${rows.length} rows stored in full (${stays} stays, ${accounts} account${accounts === 1 ? '' : 's'}), ${escapeHtml(dates[0] || '')} to ${escapeHtml(dates[dates.length - 1] || '')}. <span class="inline-goto-link" data-goto-tab="finances" data-goto-target="#airbnb-earnings-import">Import another export</span>.</div>`;
}

// The table of what the model worked out for each room, so the rates can be sanity-checked before relying on them.
async function renderEstimatedRates() {
const el = document.getElementById('be-est-rates');
if (!el) return;
try {
const { buildContext, calibrate } = await import('./bookingmodel.js');
const ctx = buildContext();
const p = calibrate(ctx);
const money = (v) => `£${Math.round(v)}`;
const rows = ctx.rooms.map((room, i) => {
const pr = p.prices[i];
const wd = pr.weekday ?? pr.base;
const we = pr.weekend ?? wd * pr.uplift;
return `<tr><td>${escapeHtml(room.label)}</td><td class="num">${pr.n} (${pr.nEarn} from export)</td><td class="num">${money(wd)}</td><td class="num">${money(we)}</td><td class="num">${money(pr.clean)}</td><td class="num">${(pr.avgShortNotice * 100).toFixed(1)}% / ${(pr.avgLength * 100).toFixed(1)}%</td><td class="settings-note" style="margin:0;">${escapeHtml(pr.source)}</td></tr>`;
}).join('');
el.innerHTML = rows ? `<div style="overflow-x:auto;"><table class="limits-table be-table"><thead><tr><th>Room</th><th class="num">Stays used</th><th class="num">Raw nightly, Sun–Thu</th><th class="num">Raw nightly, Fri–Sat</th><th class="num" title="Median cleaning fee guests were charged">Cleaning fee guests pay</th><th class="num" title="Average short-notice / length discount undone on those stays">Discounts undone (short notice / length)</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table></div><div class="settings-note" style="margin:4px 0 0;">The raw rate is what reached you per night with the cleaning fee taken out, and the discounts above undone. The cleaning fee is income on each booking; what a clean costs you is the separate figure under Cleaning and changeovers.</div>` : '<div class="settings-note" style="margin:0;">No rooms.</div>';
} catch (err) {
console.error('Estimated rates failed:', err);
el.innerHTML = `<div class="settings-note" style="margin:0;">Couldn't work them out: ${escapeHtml(err.message || String(err))}</div>`;
}
}

function renderBookingEvaluatorSettings() {
const el = document.getElementById('booking-evaluator-settings');
if (!el) return;
const s = settings();
const rooms = evaluatorRooms();
el.innerHTML = `
<div class="settings-note" style="margin:0 0 8px;">The booking evaluator weighs accepting a booking request against keeping its dates open. Each figure here is a starting assumption; the model blends it with your own stays and requests as they build up, and shows which it used.</div>
<h4 class="be-set-h">Earnings data</h4>
${earningsDataHtml()}
<h4 class="be-set-h">Estimated rates</h4>
<div id="be-est-rates"><div class="settings-note" style="margin:0;">Working out…</div></div>
<h4 class="be-set-h">Cleaning and changeovers</h4>
${row('First room cleaned', `£${numBox('airbnbCleaningCost', data.prefs.airbnbCleaningCost)}`, 'Same figure as Cleaning cost in Letting income.')}
${row('Each extra room the same day', `£${numBox('cleanExtra', s.cleanExtra)}`, 'Two rooms turned over on one day cost first + extra, shared between them.')}
${row('Changeover hassle', `Mon–Fri £${numBox('hassleWeekday', s.hassleWeekday)} Sat–Sun £${numBox('hassleWeekend', s.hassleWeekend)}`, 'Per changeover day, however many rooms turn over that day.')}
<h4 class="be-set-h">An empty night is worth to you</h4>
${row('Sun–Thu nights', `£${numBox('ownUseWeekday', s.ownUseWeekday)}`)}
${row('Fri and Sat nights', `£${numBox('ownUseWeekend', s.ownUseWeekend)}`)}
${row('A second room empty the same night', `${numBox('ownUseSecondPct', s.ownUseSecondPct, { width: 56 })}% of its value`)}
<h4 class="be-set-h">Rooms</h4>
${rooms.length ? `<table class="limits-table be-rooms"><thead><tr><th>Room</th><th title="Include this room in the evaluator">Use</th><th title="How much you value having this room empty, relative to the others (1 = the figures above; 1.5 = your preferred room)">Own-use weight</th><th>Min nights</th><th title="Blank = worked out from what this room has actually earned">Raw price Sun–Thu £</th><th title="Blank = worked out from what this room has actually earned">Price Fri–Sat £</th><th title="The cleaning fee guests pay on a booking, counted as income. Blank = the median of your earnings export. Your own clean cost is the figure under Cleaning and changeovers">Cleaning fee guests pay £</th></tr></thead><tbody>${rooms.map((room) => {
const r = roomSettings(room.key);
const p = `rooms.${room.key}`;
return `<tr><td>${escapeHtml(room.label)}</td>
<td style="text-align:center;"><input type="checkbox" data-be="${escapeHtml(p)}.include"${r.include ? ' checked' : ''}></td>
<td>${numBox(`${p}.weight`, r.weight, { step: 0.1, width: 56 })}</td>
<td>${numBox(`${p}.minNights`, r.minNights, { min: 1, width: 56 })}</td>
<td>${numBox(`${p}.priceWeekday`, r.priceWeekday, { placeholder: 'from data' })}</td>
<td>${numBox(`${p}.priceWeekend`, r.priceWeekend, { placeholder: 'from data' })}</td>
<td>${numBox(`${p}.cleaningIncome`, r.cleaningIncome, { placeholder: 'from data' })}</td></tr>`;
}).join('')}</tbody></table>` : '<div class="settings-note" style="margin:0;">No guest rooms set up yet.</div>'}
<h4 class="be-set-h">Times a room wasn't offered</h4>
<div class="settings-note" style="margin:0 0 4px;">In use yourself, or off Airbnb. These nights are left out of the occupancy demand is calibrated to, so an empty spell isn't read as nobody wanting the room. A month with no stay and no request or enquiry at all is left out on its own. A direct booking belongs in Letting income instead (it counts as occupied).</div>
${(s.unavailable || []).map((u) => `<div class="be-set-row"><span class="be-set-label">${escapeHtml((rooms.find((r) => r.key === u.roomKey) || {}).label || 'Room')}</span><span>${escapeHtml(u.from)} – ${escapeHtml(u.to)}</span><span class="del-x" data-be-unavail-del="${escapeHtml(u.id)}" title="Remove">&times;</span></div>`).join('')}
<div class="sync-row" style="align-items:center;">
<select id="be-unavail-room" class="settings-input">${rooms.map((r) => `<option value="${escapeHtml(r.key)}">${escapeHtml(r.label)}</option>`).join('')}</select>
<input type="date" id="be-unavail-from" class="settings-input" title="First night not offered">
<input type="date" id="be-unavail-to" class="settings-input" title="Last night not offered">
<button class="sync-btn sm inline" type="button" id="be-unavail-add">Add</button>
</div>
<h4 class="be-set-h">The request itself</h4>
${row('Direct booking income counts', `×${numBox('directWeight', s.directWeight, { step: 0.05, width: 56 })}`)}
${row('Guest with no reviews', `×${numBox('guestNoReviews', s.guestNoReviews, { step: 0.05, width: 56 })}`)}
${row('Guest rated below', `${numBox('lowRatingBelow', s.lowRatingBelow, { step: 0.1, width: 56 })} stars ×${numBox('guestLowRating', s.guestLowRating, { step: 0.05, width: 56 })}`)}
${row('Late cancellation', `within ${numBox('lateCancelDays', s.lateCancelDays, { width: 50 })} days of arrival still pays ${numBox('lateCancelPayPct', s.lateCancelPayPct, { width: 56 })}%`)}
<h4 class="be-set-h">When bookings arrive</h4>
<div class="settings-note" style="margin:0 0 4px;">Median days ahead a booking arrives, by the month of the stay.</div>
<div class="be-lead-grid">${MONTH_SHORT.map((m, i) => `<label>${m}${numBox(`leadMedian.${i}`, (s.leadMedian || [])[i], { width: 52 })}</label>`).join('')}<label>Christmas &amp; New Year${numBox('christmasLead', s.christmasLead, { width: 60 })}</label></div>
${row('Booking pace', `${numBox('paceFactor', s.paceFactor ?? 1, { step: 0.1, width: 56 })} times the learned request rate`, 'Scales how often the model expects requests to arrive, without changing the occupancy it was calibrated to (the monthly review demand factor scales that instead, so doubling it would aim for ~100% occupancy). 1 is as learned from your history; 2 means twice as many requests. The Model drift charts show how real requests are running against the model.')}
${row('Typical stay', `${numBox('stayMedian', s.stayMedian, { width: 50, placeholder: 'learn' })} nights (the median)`, 'Blank: the model learns stay lengths from your requests and stays, so a few month-long stays pull its typical stay up. Set 1 to 7 to pin the median (4 means half the stays it draws are 4 nights or fewer); the long stays stay in the mix, just rarer.')}
${row('Hidden 1-night demand', `${numBox('oneNightDemandPct', s.oneNightDemandPct ?? 10, { width: 50 })}% extra requests, as 1-night stays, if the minimum stay is lowered to 1`, 'A minimum of 2+ nights means Airbnb never shows you 1-night requests, so your own history cannot say how many there are. A guess until you try it. Used when the booking model tests allowing 1-night stays.')}
<h4 class="be-set-h">Discounts and price</h4>
${discountsHtml(s)}
${row('Gap discount', `${numBox('gapDiscountPct', s.gapDiscountPct, { width: 50 })}% on gaps of ${numBox('gapMaxNights', s.gapMaxNights, { width: 46 })} nights or fewer`)}
${row('Price sensitivity', numBox('elasticity', s.elasticity, { step: 0.1, width: 56 }), 'How much demand falls as price rises: 1.5 means 10% dearer gets about 15% fewer bookings. A guess until your request history says otherwise.')}
${row('An enquiry counts as', `${numBox('enquiryWeight', s.enquiryWeight, { step: 0.05, width: 56 })} of a request`, 'Enquiries are often guests shopping around.')}
<button class="sync-btn sm inline" type="button" id="be-reset" style="margin-top:8px;">Reset to starting assumptions</button>`;
renderEstimatedRates();
}

function setPath(obj, path, value) {
const parts = path.split('.');
let o = obj;
for (let i = 0; i < parts.length - 1; i++) {
const k = parts[i];
if (o[k] == null || typeof o[k] !== 'object') o[k] = /^\d+$/.test(parts[i + 1]) ? [] : {};
o = o[k];
}
o[parts[parts.length - 1]] = value;
}

function initBookingEvaluatorSettings() {
const el = document.getElementById('booking-evaluator-settings');
if (!el) return;
renderBookingEvaluatorSettings();
el.addEventListener('change', (e) => {
const input = e.target.closest('[data-be]');
if (!input) return;
const path = input.dataset.be;
let value;
if (input.type === 'checkbox') value = input.checked;
else if (input.value.trim() === '') value = /price|cleaningIncome|stayMedian/i.test(path) ? null : undefined;
else value = Number(input.value);
if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) { renderBookingEvaluatorSettings(); return; }
if (path === 'airbnbCleaningCost') {
data.prefs.airbnbCleaningCost = value;
const lettingBox = document.getElementById('letting-cleaning-cost');
if (lettingBox) lettingBox.value = value;
} else {
const s = settings();
if (path.startsWith('rooms.')) {
const [, key, field] = path.split('.');
s.rooms[key] = { ...roomSettings(key), [field]: value };
} else setPath(s, path, value);
}
renderEstimatedRates();
queueSave();
});
el.addEventListener('click', (e) => {
const addStep = e.target.closest('[data-be-disc-add]');
if (addStep) {
const [channel, kind] = addStep.dataset.beDiscAdd.split('.');
settings().discounts[channel][kind].push(kind === 'shortNotice' ? { days: 7, pct: 5 } : { nights: 7, pct: 10 });
queueSave(); renderBookingEvaluatorSettings(); return;
}
const delStep = e.target.closest('[data-be-disc-del]');
if (delStep) {
const [channel, kind, idx] = delStep.dataset.beDiscDel.split('.');
settings().discounts[channel][kind].splice(Number(idx), 1);
queueSave(); renderBookingEvaluatorSettings(); return;
}
const del = e.target.closest('[data-be-unavail-del]');
if (del) {
const s = settings();
s.unavailable = s.unavailable.filter((u) => u.id !== del.dataset.beUnavailDel);
queueSave(); renderBookingEvaluatorSettings(); return;
}
if (e.target.closest('#be-unavail-add')) {
const roomKey = document.getElementById('be-unavail-room').value;
const from = document.getElementById('be-unavail-from').value;
const to = document.getElementById('be-unavail-to').value;
if (!roomKey || !from || !to || to < from) return;
settings().unavailable.push({ id: uid(), roomKey, from, to });
queueSave(); renderBookingEvaluatorSettings(); return;
}
if (!e.target.closest('#be-reset')) return;
const { rooms, unavailable, calibration, voidPlans } = settings();
data.prefs.bookingEvaluator = { ...structuredClone(DEFAULT_PREFS.bookingEvaluator), rooms, unavailable, calibration, voidPlans };
queueSave();
renderBookingEvaluatorSettings();
});
}

export { initBookingEvaluatorSettings, renderBookingEvaluatorSettings, evaluatorRooms, roomSettings };
