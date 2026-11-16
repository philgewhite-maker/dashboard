// Settings -> Finances -> Booking evaluator: the assumptions the booking evaluator
// (js/features/bookingmodel.js) starts from, stored in data.prefs.bookingEvaluator
// (defaults in state.js DEFAULT_PREFS). Every box is a number or a tick; the model blends
// each with your own data as it builds up.
import { data, queueSave, DEFAULT_PREFS, blankAirbnbReservation } from '../state.js';
import { CHANNEL_GROUPS, CHANNEL_GROUP_LABEL, BUILTIN_CHANNEL_IDS, normaliseChannels, newChannelId, longLetCandidates, planLongLet, createLongLet, adjoiningPayments, extendLongLet, ledgerRowSpan, channelName } from '../channels.js';
import { escapeHtml, uid, todayStr, dateStrAdd, bindLogoFallbacks } from '../utils.js';
import { channelBadgeHtml } from '../providers.js';
import { linkProviders } from '../migrations.js';
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
s.discounts = { airbnb: { shortNotice: copySteps((dd.airbnb || {}).shortNotice), length: copySteps((dd.airbnb || {}).length) }, direct: { shortNotice: copySteps((dd.direct || {}).shortNotice), length: copySteps((dd.direct || {}).length) },
// Per-listing steps (model v6): own copies too.
listings: Object.fromEntries(Object.entries(dd.listings && typeof dd.listings === 'object' ? dd.listings : {}).map(([id, l]) => [id, { ...l, shortNotice: copySteps(l && l.shortNotice), length: copySteps(l && l.length) }])) };
if (s.rooms === d.rooms) s.rooms = {};
// Model v7's guest price and elasticity prior: own copies when they are still the defaults' objects.
if (!s.guestPrice || typeof s.guestPrice !== 'object' || s.guestPrice === d.guestPrice) s.guestPrice = structuredClone(s.guestPrice && typeof s.guestPrice === 'object' ? s.guestPrice : d.guestPrice);
if (!s.guestPrice.roomTypes || typeof s.guestPrice.roomTypes !== 'object') s.guestPrice.roomTypes = {};
if (!s.guestPrice.cleaningFees || typeof s.guestPrice.cleaningFees !== 'object') s.guestPrice.cleaningFees = {};
if (!s.elasticityPrior || typeof s.elasticityPrior !== 'object' || s.elasticityPrior === d.elasticityPrior) s.elasticityPrior = structuredClone(s.elasticityPrior && typeof s.elasticityPrior === 'object' ? s.elasticityPrior : d.elasticityPrior);
if (!Array.isArray(s.elasticityPrior.season) || s.elasticityPrior.season.length !== 12) s.elasticityPrior.season = [...d.elasticityPrior.season];
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
// The same block serves an Airbnb listing's own steps: `scope` is the path under discounts ('airbnb', or 'listings.<key>').
const discBlock = (scope, d, label, note, extra = '') => {
const sc = escapeHtml(scope);
const list = (kind, steps, unit, text) => `<div class="be-disc-kind"><span class="settings-note" style="margin:0;">${text}</span>${steps.map((st, i) => `<div class="be-set-row"><span>${unit === 'days' ? 'within' : 'at least'} ${numBox(`discounts.${scope}.${kind}.${i}.${unit}`, st[unit], { width: 52 })} ${unit === 'days' ? 'days' : 'nights'} takes ${numBox(`discounts.${scope}.${kind}.${i}.pct`, st.pct, { width: 52, step: 0.5 })}%</span><span class="del-x" data-be-disc-del="${sc}.${kind}.${i}" title="Remove this step">&times;</span></div>`).join('')}<button class="sync-btn sm inline" type="button" data-be-disc-add="${sc}.${kind}">Add a step</button></div>`;
return `<div class="be-disc"><div style="font-size:12px;font-weight:600;margin:6px 0 2px;">${label}</div>${note ? `<div class="settings-note" style="margin:0 0 2px;">${note}</div>` : ''}${list('shortNotice', d.shortNotice || [], 'days', 'Short notice')}${list('length', d.length || [], 'nights', 'Longer stays')}${extra}</div>`;
};
// A listing's entry in discounts.listings is keyed by its Airbnb id (the digits before ".ics" in its calendar link) or its record id.
const listingKeys = (l) => { const m = /(\d{6,})\.ics/i.exec(String(l.icsUrl || '')); return [l.id, m ? m[1] : null].filter(Boolean); };
const listingLabel = (l) => l.label || l.prefix || 'Listing';
function discountsHtml(s) {
const listings = data.airbnbListings || [];
const stored = s.discounts.listings || {};
const seen = new Set();
const topBox = (key, d, btn) => `<div class="be-set-row"><span>Top-rated guests take ${numBox(`discounts.listings.${key}.topRatedPct`, d.topRatedPct ?? 0, { width: 52, step: 0.5 })}% off</span>${btn}</div>`;
const perListing = listings.map((l) => {
const key = listingKeys(l).find((k) => stored[k]);
if (key) { seen.add(key); const d = stored[key];
return discBlock(`listings.${key}`, d, escapeHtml(listingLabel(l)), '', topBox(key, d, `<button class="sync-btn sm inline" type="button" data-be-lst-del="${escapeHtml(key)}" title="Remove this listing's own steps, so it uses the shared Airbnb steps again">Use the shared steps</button>`)); }
const ks = listingKeys(l);
return `<div class="be-disc"><div style="font-size:12px;font-weight:600;margin:6px 0 2px;">${escapeHtml(listingLabel(l))}</div><div class="be-set-row"><span class="settings-note" style="margin:0;">Uses the shared Airbnb steps.</span><button class="sync-btn sm inline" type="button" data-be-lst-new="${escapeHtml(ks[ks.length - 1])}">Give it its own steps</button></div></div>`;
}).join('');
const orphans = Object.keys(stored).filter((k) => !seen.has(k)).map((k) => discBlock(`listings.${k}`, stored[k], `Airbnb listing ${escapeHtml(k)} (not matched to a listing here)`, '', topBox(k, stored[k], `<button class="sync-btn sm inline" type="button" data-be-lst-del="${escapeHtml(k)}">Remove</button>`))).join('');
return `<h4 class="be-set-h">Discounts</h4>
<div class="settings-note" style="margin:0 0 4px;">As on Airbnb: the nightly rate you set is cut by the largest short-notice step and the largest length step that apply to a booking. The model uses them two ways: it undoes them on past stays to get back to a raw nightly rate, and applies them to the bookings it simulates. These are the shared steps; a listing with its own steps (below) uses those instead.</div>
${discBlock('airbnb', s.discounts.airbnb, 'Airbnb', '')}
${discBlock('direct', s.discounts.direct, 'Direct bookings (your own site)', 'Not used until bookings come through your own site.')}
<h4 class="be-set-h" id="be-listing-discounts">Discounts, per Airbnb listing</h4>
<div class="settings-note" style="margin:0 0 4px;">Airbnb's settings differ by listing. "Top-rated guests" is the extra discount a listing gives guests with a good record, counted at the share of bookings you assume take it (see Ratings and Superhost below).</div>
${perListing}${orphans}`;
}

// Model v7's guest price, per Airbnb listing (keyed like the per-listing discounts: its Airbnb id, the digits before
// ".ics" in its calendar link, else its record id; the model re-keys them to record ids), and the elasticity prior.
const ROOM_TYPE_LABEL = { ensuite: 'En-suite', shared: 'Shared bathroom' };
const gpKeyOf = (l, stored) => { const ks = listingKeys(l); return ks.find((k) => stored[k] != null) || ks[ks.length - 1]; };
const gpBox = (key, field, value, { step = 1, width = 60, placeholder = '' } = {}) => `<input type="number" class="settings-input" data-gp-key="${escapeHtml(key)}" data-gp-field="${field}" value="${value == null ? '' : escapeHtml(String(value))}" step="${step}" min="0" style="width:${width}px;" placeholder="${escapeHtml(placeholder)}">`;
// A listing named here links back to its row in Settings -> Airbnb listings.
const listingLinkHtml = (l) => `<span class="inline-goto-link" data-goto-tab="settings" data-goto-target="${escapeHtml(`[data-airbnb-listing-id="${l.id}"][data-airbnb-listing-field="label"]`)}" title="Open this listing in Airbnb listings">${escapeHtml(listingLabel(l))}</span>`;
function guestPriceHtml(s) {
const listings = data.airbnbListings || [];
const g = s.guestPrice || {};
const types = g.roomTypes || {}; const fees = g.cleaningFees || {};
const rows = listings.map((l) => {
const tk = gpKeyOf(l, types); const fk = gpKeyOf(l, fees);
const t = types[tk]; const f = fees[fk] || {};
const m = /(\d{6,})\.ics/i.exec(String(l.icsUrl || ''));
return `<tr><td>${listingLinkHtml(l)}<div class="settings-note" style="margin:0;">${m ? `Airbnb ${escapeHtml(m[1])}` : 'no Airbnb calendar link'}</div></td>
<td><select class="settings-input" data-gp-key="${escapeHtml(tk)}" data-gp-field="roomType">${t === 'ensuite' || t === 'shared' ? '' : '<option value="" selected>Not set (taken as en-suite)</option>'}${Object.entries(ROOM_TYPE_LABEL).map(([v, lab]) => `<option value="${v}"${t === v ? ' selected' : ''}>${lab}</option>`).join('')}</select></td>
<td>£${gpBox(fk, 'perStay', f.perStay, { placeholder: 'not set' })}</td>
<td>£${gpBox(fk, 'shortStay', f.shortStay, { placeholder: 'none' })}</td>
<td>${gpBox(fk, 'shortStayMaxNights', f.shortStayMaxNights, { width: 50 })} nights</td></tr>`;
}).join('');
const e = s.elasticityPrior || {};
const eBox = (path, v, w = 72, step = 0.1) => numBox(`elasticityPrior.${path}`, v, { step, width: w, min: path === 'ensuite' || path === 'shared' ? -10 : 0 });
return `<h4 class="be-set-h" id="be-guest-price">Guest price (model v7)</h4>
<div class="settings-note" style="margin:0 0 4px;">Guests respond to the all-in price: the nightly rate after discounts plus the cleaning fee spread over the nights. These are the LISTED Airbnb cleaning fees; the model scales them to the money you actually receive, using what your stays paid. The room type sets how price-sensitive guests are.</div>
${listings.length ? `<div style="overflow-x:auto;"><table class="limits-table be-guest-price"><thead><tr><th>Listing</th><th>Room type</th><th title="The cleaning fee Airbnb shows guests on a normal stay. Not set: the room's received cleaning income is used as it is, with no short-stay fee">Cleaning fee per stay</th><th title="Airbnb's lower cleaning fee for short stays. Blank = none">Short-stay cleaning fee</th><th title="Stays of this many nights or fewer pay the short-stay fee">Short stay is up to</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="settings-note" style="margin:0;">No Airbnb listings yet.</div>'}
<div class="be-set-label" style="margin:8px 0 2px;font-size:12px;" id="be-elasticity-prior">Price sensitivity to the all-in price</div>
<div class="settings-note" style="margin:0 0 4px;">Unsourced starting figures, to be replaced by fits from the price ledger once it has history. Negative: dearer means fewer bookings (-1.8 means 10% dearer gets about 16% fewer).</div>
${row('By room type', `En-suite ${eBox('ensuite', e.ensuite)} Shared bathroom ${eBox('shared', e.shared)}`)}
<div class="settings-note" style="margin:4px 0 2px;">Multiplier on it by month of stay (below 1 = less sensitive, as in peak season).</div>
<div class="be-lead-grid">${MONTH_SHORT.map((mn, i) => `<label>${mn}${eBox(`season.${i}`, (e.season || [])[i], 60)}</label>`).join('')}</div>
${row('Short notice', `booked within ${eBox('shortNoticeDays', e.shortNoticeDays, 50, 1)} days of arrival ×${eBox('shortNoticeMult', e.shortNoticeMult)}`)}`;
}

// ---- Channels and long lets ---------------------------------------------------------------------------------------
function channels() {
data.prefs.lettingChannels = normaliseChannels(data.prefs.lettingChannels);
return data.prefs.lettingChannels;
}

const isDirect = (c) => c.group !== 'platform';
// Re-link channels to the providers registry after a name/group change or a new row, then redraw the table.
function relinkChannels() { linkProviders(data); const box = document.getElementById('ch-box'); if (box) { box.innerHTML = channelsHtml(); bindLogoFallbacks(box); } }
function channelsHtml() {
const cb = (id, field, on, title) => `<input type="checkbox" data-ch="${escapeHtml(id)}" data-ch-field="${field}"${on ? ' checked' : ''} title="${escapeHtml(title)}">`;
return `<h4 class="be-set-h" id="letting-channels">Channels</h4>
<div class="settings-note" style="margin:0 0 4px;">Where a stay came from. Pick one on each stay. "Counts as demand" is whether its bookings respond to your listed price (word of mouth and long lets do not). "Long let" makes a stay on that channel a long let by default. A built-in channel can be switched off but not removed.</div>
<table class="limits-table be-channels"><thead><tr><th>Channel</th><th>Group</th><th title="Percent of a booking this channel takes. Left at 0 until you enter your own figure.">Fee %</th><th>Counts as demand</th><th>Long let</th><th>Active</th><th></th></tr></thead><tbody>${channels().map((c) => `<tr data-ch-row="${escapeHtml(c.id)}">
<td><span style="display:inline-flex;align-items:center;gap:6px;">${channelBadgeHtml(c)}<input type="text" class="settings-input" data-ch="${escapeHtml(c.id)}" data-ch-field="name" value="${escapeHtml(c.name)}" style="width:150px;" title="${isDirect(c) ? 'Shares the Direct provider' : 'Provider: renaming it in Settings -> Finances -> Providers renames this too'}"></span></td>
<td><select class="settings-input" data-ch="${escapeHtml(c.id)}" data-ch-field="group">${CHANNEL_GROUPS.map((g) => `<option value="${g}"${c.group === g ? ' selected' : ''}>${CHANNEL_GROUP_LABEL[g]}</option>`).join('')}</select></td>
<td><input type="number" class="settings-input" data-ch="${escapeHtml(c.id)}" data-ch-field="feePct" value="${escapeHtml(String(c.feePct))}" min="0" step="0.1" style="width:60px;"></td>
<td style="text-align:center;">${cb(c.id, 'countsAsDemand', c.countsAsDemand, 'Its bookings count as market demand')}</td>
<td style="text-align:center;">${cb(c.id, 'longLetDefault', c.longLetDefault, 'A stay on this channel defaults to a long let')}</td>
<td style="text-align:center;">${cb(c.id, 'active', c.active, 'Offered when picking a channel for a stay')}</td>
<td>${BUILTIN_CHANNEL_IDS.includes(c.id) ? '' : `<span class="del-x" data-ch-del="${escapeHtml(c.id)}" title="Remove this channel">&times;</span>`}</td></tr>`).join('')}</tbody></table>
<button class="sync-btn sm inline" type="button" id="ch-add" style="margin-top:4px;">Add a channel</button>
<div class="sync-status" id="ch-status"></div>`;
}

const money2 = (n) => `£${Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const guestOf = (e) => String(e.guest || e.note || '').trim();
let llGuest = '';
let llOff = new Set();
let llMsg = '';

// Merge a run of income entries into one long let. The entries are only linked to the new stay, never edited.
function longLetHtml() {
const cands = longLetCandidates(data);
const groups = new Map();
cands.forEach((e) => { const k = guestOf(e).toLowerCase(); if (k) { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); } });
const multi = [...groups.entries()].filter(([, rows]) => rows.length >= 2);
if (!multi.some(([k]) => k === llGuest.toLowerCase())) llGuest = multi.length ? multi[0][0] : '';
const listings = data.airbnbListings || [];
const made = (data.airbnbReservations || []).filter((r) => r.letType === 'long' && (r.paymentIds || []).length);
let body = '';
if (!multi.length) body = '<div class="settings-note" style="margin:0;">No guest has two or more unlinked income entries with a start date and nights.</div>';
else {
const rows = groups.get(llGuest).slice().sort((a, b) => ledgerRowSpan(a).start.localeCompare(ledgerRowSpan(b).start));
const picked = rows.filter((e) => !llOff.has(e.id));
const plan = picked.length >= 2 ? planLongLet(data, picked.map((e) => e.id)) : { ok: false, error: 'Pick at least two payments.' };
body = `<div class="sync-row" style="align-items:center;"><select id="ll-guest" class="settings-input">${multi.map(([k, rs]) => `<option value="${escapeHtml(k)}"${k === llGuest ? ' selected' : ''}>${escapeHtml(guestOf(rs[0]))} (${rs.length} entries)</option>`).join('')}</select></div>
<div class="be-ll-rows">${rows.map((e) => { const sp = ledgerRowSpan(e); const l = listings.find((x) => x.id === e.listingId); return `<label class="be-set-row" style="display:flex;gap:6px;align-items:center;"><input type="checkbox" data-ll-row="${escapeHtml(e.id)}"${llOff.has(e.id) ? '' : ' checked'}> ${escapeHtml(sp.start)} &rarr; ${escapeHtml(sp.end)} &middot; ${sp.nights}n &middot; ${money2(e.gross)} &middot; ${escapeHtml(l ? (l.label || l.prefix || 'Listing') : 'no listing')}</label>`; }).join('')}</div>
${plan.ok ? `<div class="settings-note" style="margin:4px 0;">${picked.length} payments, ${escapeHtml(plan.start)} &rarr; ${escapeHtml(plan.end)}, ${plan.nights} nights, ${money2(plan.total)}. Occupancy is unchanged: the same nights, drawn once.</div>
<div class="sync-row" style="align-items:center;flex-wrap:wrap;"><label>Listing <select id="ll-listing" class="settings-input">${listings.map((l) => `<option value="${escapeHtml(l.id)}"${l.id === plan.listingId ? ' selected' : ''}>${escapeHtml(l.label || l.prefix || 'Listing')}</option>`).join('')}</select></label>
<label>Signed <input type="date" id="ll-booked" class="settings-input" value="${escapeHtml(plan.bookedOn)}" title="The day the contract was signed (the booking date)"></label>
<label>Channel <select id="ll-channel" class="settings-input">${channels().filter((c) => c.active).map((c) => `<option value="${escapeHtml(c.id)}"${c.id === 'wordofmouth' ? ' selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}</select></label>
<button class="sync-btn sm inline" type="button" id="ll-merge">Merge into one long let</button></div>` : `<div class="settings-note" style="margin:4px 0;">${escapeHtml(plan.error)}</div>`}`;
}
return `<h4 class="be-set-h" id="long-lets">Long lets</h4>
<div class="settings-note" style="margin:0 0 4px;">A long let is one stay with a signing date, a start and an end, paid by a schedule of income entries. Merging links the entries you tick to a single stay; the entries themselves (amounts, owners, dates) do not change, and the same nights stay blocked on the occupancy chart.</div>
${body}
${llMsg ? `<div class="sync-status">${llMsg}</div>` : ''}
${made.length ? `<div class="settings-note" style="margin:8px 0 2px;">Long lets already made</div>${made.map((r) => `<div class="be-set-row"><span class="stay-link" data-open-stay="${escapeHtml(r.id)}" title="Open this stay">${escapeHtml(r.guestName || 'Long let')} &middot; ${escapeHtml(r.checkin)} &rarr; ${escapeHtml(r.checkout)} &middot; ${r.paymentIds.length} payments &middot; ${escapeHtml(channelName(channels(), r.channel))}</span> ${(() => { const adj = adjoiningPayments(data, r); return adj.length ? `<button class="sync-btn sm inline" type="button" data-ll-extend="${escapeHtml(r.id)}" title="Same guest, starting the day this let ends (or ending the day it starts): add to this let. The income entries are untouched.">Add ${adj.length} adjoining payment${adj.length === 1 ? '' : 's'}</button> ` : ''; })()}<button class="sync-btn sm inline" type="button" data-ll-split="${escapeHtml(r.id)}" title="Delete this stay and show its payments as separate stays again. The income entries are untouched.">Split back</button></div>`).join('')}` : ''}`;
}
function renderChannelLogos() { bindLogoFallbacks(document.getElementById('ch-box')); }
function renderLongLet() { const el = document.getElementById('ll-merge-box'); if (el) el.innerHTML = longLetHtml(); import('./airbnb.js').then((m) => m.bindStayChips()).catch(() => {}); }

// ---- Long-let offer check ------------------------------------------------------------------------------------------
// The form: kept in module state so a re-render of the whole section (every number box does one) doesn't lose it.
const llc = { roomKey: '', from: '', to: '', rent: '', channelId: '', bills: '0', clean: true, busy: false, result: null, error: '' };
function llcDefaults() {
const rooms = evaluatorRooms();
if (!rooms.some((r) => r.key === llc.roomKey)) llc.roomKey = rooms.length ? rooms[0].key : '';
if (!llc.from) { llc.from = dateStrAdd(todayStr(), 14); llc.to = dateStrAdd(llc.from, 90); }
const chs = channels().filter((c) => c.active);
if (!chs.some((c) => c.id === llc.channelId)) llc.channelId = (chs.find((c) => c.longLetDefault) || chs[0] || {}).id || '';
}
const llcVerdict = { take: 'Take the long let', marginal: 'Too close to call on money', decline: 'Keep it short-let' };
function llcResultHtml() {
if (llc.error) return `<div class="sync-status">${escapeHtml(llc.error)}</div>`;
const r = llc.result;
if (!r) return '';
if (r.error && !r.longLet) return `<div class="sync-status">${escapeHtml(r.error)}</div>`;
const sl = r.shortLet;
const gbp = (v) => `${v < 0 ? '-' : ''}£${Math.abs(Math.round(v)).toLocaleString('en-GB')}`;
const far = llc.from > dateStrAdd(todayStr(), 45) ? `<div class="settings-note llc-caveat">This starts more than 45 days ahead. The model has only been checked against real outcomes over 90-day windows, so the short-let figure this far out is less reliable.</div>` : '';
if (!sl) return `<div class="sync-status">${escapeHtml(r.error || '')}</div>${far}`;
const rows = [
['Long let, net', `<b>${gbp(r.longLet.net)}</b> <span class="settings-note" style="margin:0;">${gbp(r.longLet.gross)} rent, less ${gbp(r.longLet.fee)} fee, ${gbp(r.longLet.bills)} bills, ${gbp(r.longLet.cleaning)} clean</span>`],
['Short let, expected', `<b>${gbp(sl.median)}</b> <span class="settings-note" style="margin:0;">range ${gbp(sl.low)} to ${gbp(sl.high)} &middot; about ${Math.round(sl.nightsBooked)} of ${r.nights} nights booked (${Math.round(sl.occupancy * 100)}%)</span>`],
['Break-even rent', r.breakEvenMonthlyRent == null ? 'n/a' : `<b>${gbp(r.breakEvenMonthlyRent)}</b> a month`],
];
return `<div class="llc-result"><div class="llc-verdict ${escapeHtml(r.verdict)}">${escapeHtml(llcVerdict[r.verdict] || r.verdict)}</div>${rows.map(([k, v]) => `<div class="be-set-row"><span class="be-set-label">${k}</span><span>${v}</span></div>`).join('')}${far}
<details class="llc-why"><summary>How this was worked out</summary>${(r.reasons || []).map((x) => `<div class="settings-note" style="margin:2px 0;">${escapeHtml(x)}</div>`).join('')}<div class="settings-note" style="margin:6px 0 2px;">Assumptions</div>${(r.assumptions || []).map((x) => `<div class="settings-note" style="margin:2px 0;">${escapeHtml(x)}</div>`).join('')}</details></div>`;
}
function longLetCheckHtml() {
llcDefaults();
const rooms = evaluatorRooms();
const chs = channels().filter((c) => c.active);
if (!rooms.length) return `<h4 class="be-set-h" id="long-let-check">Long-let offer check</h4><div class="settings-note" style="margin:0;">No guest rooms set up yet.</div>`;
return `<h4 class="be-set-h" id="long-let-check">Long-let offer check</h4>
<div class="settings-note" style="margin:0 0 4px;">Someone offers a monthly rent for a room over a period. This sets what the rent nets against what the model expects the same room to earn as short lets over the same nights. The fee comes from <span class="inline-goto-link" data-goto-tab="settings" data-goto-target="#letting-channels">Channels</span> above.</div>
<div class="sync-row llc-form">
<label>Room <select class="settings-input" data-llc="roomKey">${rooms.map((r) => `<option value="${escapeHtml(r.key)}"${r.key === llc.roomKey ? ' selected' : ''}>${escapeHtml(r.label)}</option>`).join('')}</select></label>
<label>From <input type="date" class="settings-input" data-llc="from" value="${escapeHtml(llc.from)}"></label>
<label>To <input type="date" class="settings-input" data-llc="to" value="${escapeHtml(llc.to)}" title="The move-out day: its night is not charged"></label>
<label>Rent &pound; a month <input type="number" class="settings-input" data-llc="rent" value="${escapeHtml(String(llc.rent))}" min="0" step="10" style="width:84px;"></label>
<label>Channel <select class="settings-input" data-llc="channelId">${chs.map((c) => `<option value="${escapeHtml(c.id)}"${c.id === llc.channelId ? ' selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}</select></label>
<label>Bills &pound; a month <input type="number" class="settings-input" data-llc="bills" value="${escapeHtml(String(llc.bills))}" min="0" step="10" style="width:84px;"></label>
<label class="llc-check"><input type="checkbox" data-llc="clean"${llc.clean ? ' checked' : ''}> Clean at the end</label>
<button class="sync-btn sm inline" type="button" id="llc-run"${llc.busy ? ' disabled' : ''}>${llc.busy ? 'Checking…' : 'Check'}</button>
</div>
<div id="llc-out">${llc.busy ? '<div class="settings-note" style="margin:4px 0;">Simulating the short-let side, this can take a few seconds…</div>' : llcResultHtml()}</div>`;
}
function renderLongLetCheck() { const el = document.getElementById('llc-box'); if (el) el.innerHTML = longLetCheckHtml(); }
async function runLongLetCheck() {
if (llc.busy) return;
if (!llc.from || !llc.to || llc.to <= llc.from) { llc.result = null; llc.error = 'Pick a start date and an end date after it.'; renderLongLetCheck(); return; }
if (!(Number(llc.rent) > 0)) { llc.result = null; llc.error = 'Enter the monthly rent offered.'; renderLongLetCheck(); return; }
llc.busy = true; llc.error = ''; llc.result = null; renderLongLetCheck();
await new Promise((res) => setTimeout(res, 50)); // let the busy state paint before the simulation blocks the thread
try {
const m = await import('./longletcheck.js');
llc.result = m.checkLongLet({ roomKey: llc.roomKey, from: llc.from, to: llc.to, monthlyRent: Number(llc.rent), channelId: llc.channelId, billsPerMonth: Number(llc.bills) || 0, cleanAtEnd: llc.clean, runs: 800 });
} catch (err) { console.error('Long-let check failed:', err); llc.error = `The check failed: ${err.message || err}`; }
llc.busy = false; renderLongLetCheck();
}

// Which listings are yours: checkboxes, with "auto" (ownListingIds null) shown as the model's own guess, ticked as it would be.
async function renderOwnListings() {
const el = document.getElementById('be-own-listings');
if (!el) return;
const listings = data.airbnbListings || [];
if (!listings.length) { el.innerHTML = '<div class="settings-note" style="margin:0;">No Airbnb listings yet.</div>'; return; }
try {
const { buildContext } = await import('./bookingmodel.js');
const own = buildContext().ownListings || {};
const s = settings();
const auto = !Array.isArray(s.ownListingIds);
el.innerHTML = `<div class="be-set-label" style="margin:6px 0 2px;font-size:12px;">Which listings are yours</div>
<div class="settings-note" style="margin:0 0 2px;">${auto ? 'Auto: worked out from each listing\'s owner (none, or called Phil). Tick or untick one to set the list yourself.' : 'Set by hand.'} The Superhost date above applies to these.</div>
${listings.map((l) => `<label class="be-set-row" style="display:flex;gap:6px;align-items:center;"><input type="checkbox" data-own-id="${escapeHtml(l.id)}"${own[l.id] ? ' checked' : ''}> ${escapeHtml(listingLabel(l))}</label>`).join('')}
${auto ? '' : '<button class="sync-btn sm inline" type="button" id="be-own-auto">Use auto</button>'}`;
} catch (err) { console.error('Own listings failed:', err); el.innerHTML = `<div class="settings-note" style="margin:0;">Couldn't work them out: ${escapeHtml(err.message || String(err))}</div>`; }
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
<div id="ch-box">${channelsHtml()}</div>
<div id="ll-merge-box">${longLetHtml()}</div>
<div id="llc-box">${longLetCheckHtml()}</div>
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
${row('Typical stay', `${numBox('stayMedian', s.stayMedian, { width: 50, placeholder: 'learn' })} nights (the median)`, 'Blank: the model learns stay lengths from your requests and stays, so a few month-long stays pull its typical stay up. Set 1 to 7 to pin the median (4 means half the stays it draws are 4 nights or fewer); the long stays stay in the mix, just rarer.')}
${row('Hidden 1-night demand', `${numBox('oneNightDemandPct', s.oneNightDemandPct ?? 10, { width: 50 })}% extra requests, as 1-night stays, if the minimum stay is lowered to 1`, 'A minimum of 2+ nights means Airbnb never shows you 1-night requests, so your own history cannot say how many there are. A guess until you try it. Used when the booking model tests allowing 1-night stays.')}
<h4 class="be-set-h">Discounts and price</h4>
${discountsHtml(s)}
${row('Gap discount', `${numBox('gapDiscountPct', s.gapDiscountPct, { width: 50 })}% on gaps of ${numBox('gapMaxNights', s.gapMaxNights, { width: 46 })} nights or fewer`)}
${row('Price sensitivity (v6 level)', numBox('elasticity', s.elasticity, { step: 0.1, width: 56 }), 'The older model\'s single figure (1.5: 10% dearer, about 15% fewer bookings). The live model (v7) uses it only to keep the demand level at today\'s discounts where the older model put it; how demand moves when a price changes comes from the guest-price sensitivity below.')}
${row('An enquiry counts as', `${numBox('enquiryWeight', s.enquiryWeight, { step: 0.05, width: 56 })} of a request`, 'Enquiries are often guests shopping around.')}
${guestPriceHtml(s)}
<h4 class="be-set-h" id="be-ratings">Ratings and Superhost</h4>
${row('New-listing discount', `${numBox('newListingDiscountPct', s.newListingDiscountPct, { width: 56, step: 0.5 })}% off`, 'What a new listing takes off for bookings made before its third review. Undone on those past stays to get back to the raw rate.')}
${row('Superhost since', `<input type="date" class="settings-input" data-be="superhostFrom" value="${escapeHtml(s.superhostFrom || '')}">`, 'The date your own listings gained Superhost. Clear it if they never did.')}
${row('Top-rated guests', `${numBox('topRatedGuestSharePct', s.topRatedGuestSharePct, { width: 56 })}% of bookings`, 'The share of bookings assumed to come from guests who get a listing\'s top-rated-guest discount. A guess: nothing on record says which guests did.')}
<div id="be-own-listings"></div>
<button class="sync-btn sm inline" type="button" id="be-reset" style="margin-top:8px;">Reset to starting assumptions</button>`;
renderEstimatedRates();
renderOwnListings();
renderChannelLogos();
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
const chIn = e.target.closest('[data-ch]');
if (chIn) {
const c = channels().find((x) => x.id === chIn.dataset.ch);
const f = chIn.dataset.chField;
if (!c) return;
if (f === 'name') { if (!chIn.value.trim()) { chIn.value = c.name; return; } c.name = chIn.value.trim(); }
else if (f === 'group') c.group = CHANNEL_GROUPS.includes(chIn.value) ? chIn.value : c.group;
else if (f === 'feePct') { const v = Number(chIn.value); if (!(v >= 0)) { chIn.value = c.feePct; return; } c.feePct = v; }
else c[f] = chIn.checked;
queueSave(); if (f === 'name' || f === 'group') relinkChannels(); renderLongLet(); import('./airbnb.js').then((m) => m.renderAirbnb && m.renderAirbnb()).catch(() => {}); return;
}
const llcIn = e.target.closest('[data-llc]');
if (llcIn) { const f = llcIn.dataset.llc; llc[f] = llcIn.type === 'checkbox' ? llcIn.checked : llcIn.value; return; }
const ownIn = e.target.closest('[data-own-id]');
if (ownIn) {
(async () => {
// Read the auto guess first: anything awaited can re-save the prefs object, so settings() is fetched after it.
let auto = null;
if (!Array.isArray(settings().ownListingIds)) { const { buildContext } = await import('./bookingmodel.js'); const own = buildContext().ownListings || {}; auto = (data.airbnbListings || []).filter((l) => own[l.id]).map((l) => l.id); }
const s = settings();
if (!Array.isArray(s.ownListingIds)) s.ownListingIds = auto || [];
const id = ownIn.dataset.ownId;
s.ownListingIds = ownIn.checked ? [...new Set([...s.ownListingIds, id])] : s.ownListingIds.filter((x) => x !== id);
queueSave(); renderOwnListings();
})();
return;
}
if (e.target.id === 'll-guest') { llGuest = e.target.value; llOff = new Set(); llMsg = ''; renderLongLet(); return; }
if (e.target.dataset.llRow) { if (e.target.checked) llOff.delete(e.target.dataset.llRow); else llOff.add(e.target.dataset.llRow); renderLongLet(); return; }
const gpIn = e.target.closest('[data-gp-key]');
if (gpIn) {
const g = settings().guestPrice;
const key = gpIn.dataset.gpKey; const f = gpIn.dataset.gpField;
if (f === 'roomType') {
if (gpIn.value === 'ensuite' || gpIn.value === 'shared') g.roomTypes[key] = gpIn.value; else delete g.roomTypes[key];
} else {
const raw = gpIn.value.trim();
const v = raw === '' ? null : Number(raw);
// The per-stay fee is required once set (blank puts the box back); a blank short-stay fee means none.
if ((v == null && f === 'perStay') || (v != null && !(Number.isFinite(v) && v >= 0))) { renderBookingEvaluatorSettings(); return; }
const fee = { ...(g.cleaningFees[key] || {}) };
if (f === 'shortStayMaxNights') fee[f] = v == null ? 0 : Math.round(v);
else fee[f] = v;
g.cleaningFees[key] = fee;
}
queueSave(); return;
}
const input = e.target.closest('[data-be]');
if (!input) return;
const path = input.dataset.be;
let value;
if (input.type === 'checkbox') value = input.checked;
else if (input.type === 'date') value = input.value;
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
if (e.target.closest('#ch-add')) {
const list = channels();
list.push({ id: newChannelId(list, 'New channel'), name: 'New channel', group: 'platform', feePct: 0, countsAsDemand: false, longLetDefault: false, active: true, providerId: '' });
queueSave(); relinkChannels(); return;
}
const chDel = e.target.closest('[data-ch-del]');
if (chDel) {
const id = chDel.dataset.chDel;
const used = (data.airbnbReservations || []).filter((r) => r.channel === id).length;
if (BUILTIN_CHANNEL_IDS.includes(id)) return;
if (used) { document.getElementById('ch-status').textContent = `${used} stay${used === 1 ? ' uses' : 's use'} this channel, so it can only be switched off, not removed.`; return; }
data.prefs.lettingChannels = channels().filter((c) => c.id !== id);
queueSave(); relinkChannels(); return;
}
if (e.target.closest('#llc-run')) { runLongLetCheck(); return; }
if (e.target.closest('#be-own-auto')) { settings().ownListingIds = null; queueSave(); renderOwnListings(); return; }
if (e.target.closest('#ll-merge')) {
const rows = longLetCandidates(data).filter((x) => guestOf(x).toLowerCase() === llGuest.toLowerCase() && !llOff.has(x.id));
const picked = rows.map((x) => x.id);
const guestName = rows.length ? guestOf(rows[0]) : '';
const r = createLongLet(data, { paymentIds: picked, listingId: document.getElementById('ll-listing').value, bookedOn: document.getElementById('ll-booked').value, channel: document.getElementById('ll-channel').value, guestName }, blankAirbnbReservation);
if (r.error) { llMsg = escapeHtml(r.error); } else {
llMsg = `Merged ${r.stay.paymentIds.length} payments into one long let, <span class="stay-link" data-open-stay="${escapeHtml(r.stay.id)}">open the stay</span>.`;
llOff = new Set(); queueSave();
import('./airbnb.js').then((m) => m.renderAirbnb && m.renderAirbnb()).catch(() => {});
import('./letting.js').then((m) => m.renderLetting && m.renderLetting()).catch(() => {});
}
renderLongLet(); return;
}
const extend = e.target.closest('[data-ll-extend]');
if (extend) {
const stay = (data.airbnbReservations || []).find((x) => x.id === extend.dataset.llExtend);
const before = stay ? `${stay.checkin} → ${stay.checkout}` : '';
const r = extendLongLet(data, extend.dataset.llExtend, adjoiningPayments(data, stay));
if (r.error) { llMsg = escapeHtml(r.error); } else {
llMsg = `<span class="stay-link" data-open-stay="${escapeHtml(r.stay.id)}">${escapeHtml(r.stay.guestName || 'Long let')}</span> now runs ${escapeHtml(r.stay.checkin)} → ${escapeHtml(r.stay.checkout)} (${r.plan.nights} nights, ${r.stay.paymentIds.length} payments; was ${escapeHtml(before)}).`;
queueSave();
import('./airbnb.js').then((m) => m.renderAirbnb && m.renderAirbnb()).catch(() => {});
import('./letting.js').then((m) => m.renderLetting && m.renderLetting()).catch(() => {});
}
renderLongLet(); return;
}
const split = e.target.closest('[data-ll-split]');
if (split) {
const r = (data.airbnbReservations || []).find((x) => x.id === split.dataset.llSplit);
if (!r || !confirm('Delete this long-let stay and show its payments as separate stays again? The income entries are not changed.')) return;
data.airbnbReservations = data.airbnbReservations.filter((x) => x.id !== r.id);
llMsg = ''; queueSave(); renderLongLet();
import('./airbnb.js').then((m) => m.renderAirbnb && m.renderAirbnb()).catch(() => {});
return;
}
const scopeOf = (path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), settings().discounts);
const addStep = e.target.closest('[data-be-disc-add]');
if (addStep) {
const parts = addStep.dataset.beDiscAdd.split('.'); const kind = parts.pop();
const sc = scopeOf(parts.join('.'));
if (!sc) return;
if (!Array.isArray(sc[kind])) sc[kind] = [];
sc[kind].push(kind === 'shortNotice' ? { days: 7, pct: 5 } : { nights: 7, pct: 10 });
queueSave(); renderBookingEvaluatorSettings(); return;
}
const delStep = e.target.closest('[data-be-disc-del]');
if (delStep) {
const parts = delStep.dataset.beDiscDel.split('.'); const idx = parts.pop(); const kind = parts.pop();
const sc = scopeOf(parts.join('.'));
if (!sc || !Array.isArray(sc[kind])) return;
sc[kind].splice(Number(idx), 1);
queueSave(); renderBookingEvaluatorSettings(); return;
}
const lstNew = e.target.closest('[data-be-lst-new]');
if (lstNew) {
settings().discounts.listings[lstNew.dataset.beLstNew] = { shortNotice: [], length: [], topRatedPct: 0 };
queueSave(); renderBookingEvaluatorSettings(); return;
}
const lstDel = e.target.closest('[data-be-lst-del]');
if (lstDel) {
delete settings().discounts.listings[lstDel.dataset.beLstDel];
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
