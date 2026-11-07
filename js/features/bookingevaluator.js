// "Should I accept this booking?": the booking evaluator's workbench, in the Letting panel
// (Finances). Feed it a request (or press Evaluate on one in the Airbnb panel's requests list,
// or on an unconfirmed stay) and it shows the verdict, every factor's contribution to accept
// and reject, the chance each night gets booked either way, the assumptions behind it (each
// with its source, editable for this evaluation), what would change the answer, and a few
// simulated futures written out. The engine is js/features/bookingmodel.js.
import { data, queueSave, blankBookingRequest } from '../state.js';
import { escapeHtml, todayStr, scrollAndFlash } from '../utils.js';
import { evaluatorRooms } from './bookingsettings.js';

const state = { prefill: null, result: null, ctx: null, overrides: {}, busy: false, expanded: new Set() };
const money = (v) => `${v < 0 ? '−' : ''}£${Math.abs(Math.round(v)).toLocaleString('en-GB')}`;
const signed = (v) => `${v >= 0 ? '+' : '−'}£${Math.abs(Math.round(v)).toLocaleString('en-GB')}`;
const nice = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const short = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

function listingOptions() {
const rooms = evaluatorRooms();
const ids = new Set(rooms.flatMap((r) => r.listingIds));
return (data.airbnbListings || []).filter((l) => ids.has(l.id));
}

function sectionHtml() {
return `<div class="letting-chart-wrap" id="booking-evaluator">
<div class="panel-head" style="margin:18px 0 6px;"><h2 style="font-size:13px;">Should I accept this booking?</h2>
<span class="inline-goto-link panel-settings-link" data-goto-tab="settings" data-goto-target="#booking-evaluator-settings" title="Booking evaluator settings">&#9881;</span></div>
<div class="settings-note" style="margin:0 0 6px;">Weighs accepting a request against keeping its dates open, over the nights around it. Press Evaluate on a request in the <span class="inline-goto-link" data-goto-tab="overview" data-goto-target="#booking-requests">Airbnb panel</span>, or enter one here.</div>
<div class="sync-row be-form" style="align-items:flex-end;">
<label class="be-field">Listing<select id="be-listing" class="settings-input"></select></label>
<label class="be-field">Check-in<input type="date" id="be-checkin" class="settings-input"></label>
<label class="be-field">Check-out<input type="date" id="be-checkout" class="settings-input"></label>
<label class="be-field">Payout £<input type="number" id="be-payout" class="settings-input" min="0" step="1" style="width:90px;"></label>
<label class="be-field">Channel<select id="be-platform" class="settings-input"><option value="airbnb">Airbnb</option><option value="other">Direct</option></select></label>
<label class="be-field">Reviews<input type="number" id="be-reviews" class="settings-input" min="0" step="1" style="width:70px;" placeholder="?"></label>
<label class="be-field">Rating<input type="number" id="be-rating" class="settings-input" min="0" max="5" step="0.1" style="width:70px;" placeholder="optional"></label>
<button class="sync-btn sm inline" type="button" id="be-run">Evaluate</button>
<span class="sync-status" id="be-status"></span>
</div>
<div id="be-result"></div>
</div>`;
}

function fillListingSelect() {
const sel = document.getElementById('be-listing');
if (!sel) return;
const cur = sel.value;
sel.innerHTML = listingOptions().map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.label || 'Listing')}</option>`).join('');
if (cur) sel.value = cur;
}

// An enquiry has no payout in its email: estimate one from the latest request on the same
// listing (its payout against its nightly rate × nights covers Airbnb's fee and any cleaning fee).
function estimatePayout(listingId, checkin, checkout, nightlyRate) {
const nights = Math.round((new Date(`${checkout}T00:00:00`) - new Date(`${checkin}T00:00:00`)) / 86400000);
const latest = (data.bookingRequests || []).filter((q) => q.listingId === listingId && q.payout > 0 && q.nightlyRate > 0).sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)))[0];
const rate = nightlyRate || (latest && latest.nightlyRate);
if (!rate || nights <= 0) return null;
const ratio = latest ? latest.payout / (latest.nightlyRate * Math.max(1, Math.round((new Date(`${latest.checkout}T00:00:00`) - new Date(`${latest.checkin}T00:00:00`)) / 86400000))) : 0.97;
return Math.round(rate * nights * ratio);
}

// Opens the workbench on a logged request/enquiry (`requestId`) or a stay (`reservationId`).
async function openEvaluator({ requestId = '', reservationId = '' } = {}) {
const q = requestId ? (data.bookingRequests || []).find((x) => x.id === requestId) : null;
const r = reservationId ? (data.airbnbReservations || []).find((x) => x.id === reservationId) : null;
const src = q || r;
if (!src) return;
const payout = q ? (q.payout ?? estimatePayout(q.listingId, q.checkin, q.checkout, q.nightlyRate)) : (r.income ?? estimatePayout(r.listingId, r.checkin, r.checkout, null));
state.prefill = { requestId: q ? q.id : '', reservationId: q ? (q.reservationId || '') : r.id, estimated: q ? q.payout == null : r.income == null };
state.overrides = {};
const { switchTab } = await import('../tabs.js');
switchTab('finances');
fillListingSelect();
document.getElementById('be-listing').value = src.listingId;
document.getElementById('be-checkin').value = src.checkin;
document.getElementById('be-checkout').value = src.checkout;
document.getElementById('be-payout').value = payout == null ? '' : payout;
document.getElementById('be-platform').value = src.platform === 'other' ? 'other' : 'airbnb';
document.getElementById('be-reviews').value = q && q.guestReviews != null ? q.guestReviews : '';
document.getElementById('be-rating').value = q && q.guestRating != null ? q.guestRating : '';
requestAnimationFrame(() => scrollAndFlash('#booking-evaluator'));
run();
}

function readForm() {
const v = (id) => document.getElementById(id).value;
return {
listingId: v('be-listing'), checkin: v('be-checkin'), checkout: v('be-checkout'),
payout: v('be-payout') === '' ? null : Number(v('be-payout')), platform: v('be-platform'),
guestReviews: v('be-reviews') === '' ? null : Number(v('be-reviews')),
guestRating: v('be-rating') === '' ? null : Number(v('be-rating')),
reservationId: state.prefill ? state.prefill.reservationId : '',
};
}

async function run() {
if (state.busy) return;
const status = document.getElementById('be-status');
const req = readForm();
state.busy = true;
if (status) status.textContent = 'Working it out…';
await new Promise((r) => setTimeout(r, 20)); // let the status paint before the simulation runs
try {
const model = await import('./bookingmodel.js');
const ctx = model.buildContext({ overrides: buildOverrides() });
const result = model.evaluate(req, ctx);
state.ctx = ctx; state.result = result; state.req = req;
if (status) status.textContent = result.error ? '' : `${result.runs.toLocaleString('en-GB')} simulated futures.`;
renderResult();
} catch (err) {
console.error('Booking evaluation failed:', err);
if (status) status.textContent = `Failed: ${err.message || err}`;
} finally { state.busy = false; }
}

// The assumptions panel's what-ifs, as engine overrides.
function buildOverrides() {
const o = state.overrides;
const scale = {};
if (o.demand) scale.demand = o.demand;
if (o.lead) scale.lead = o.lead;
if (o.cancel) scale.cancel = o.cancel;
if (o.ownUse != null) scale.ownUse = o.ownUse;
const settings = {};
if (o.elasticity != null) settings.elasticity = o.elasticity;
return { scale, settings };
}

const PARTS = [
{ k: 'request', label: 'This request, allowing for cancellation' },
{ k: 'before', label: 'New bookings before it, same room' },
{ k: 'inside', label: 'New bookings on its nights' },
{ k: 'after', label: 'New bookings after it, same room' },
{ k: 'other', label: 'New bookings in other rooms' },
{ k: 'existing', label: 'Bookings already made' },
{ k: 'clean', label: 'Cleaning', minus: true },
{ k: 'hassle', label: 'Changeover hassle', minus: true },
{ k: 'ownUse', label: 'Empty nights, worth to you' },
];

function verdictHtml(r) {
const room = escapeHtml(r.room.label);
const win = `${short(r.window.start)} – ${short(r.window.end)}`;
const lines = [];
const rec = r.recommendation === 'COUNTER' ? `COUNTER at ${money(Math.ceil(r.breakEven / 5) * 5)}` : r.recommendation === 'EITHER' ? 'CLOSE CALL' : r.recommendation;
lines.push(`<div class="be-rec ${escapeHtml(r.recommendation.toLowerCase())}">Recommendation: <strong>${escapeHtml(rec)}</strong></div>`);
lines.push(`Accepting moves the expected value of the free stretch (${escapeHtml(win)}, ${r.window.nights} nights between the bookings either side${r.window.capped.before || r.window.capped.after ? ', limited to 4 weeks around the request' : ''}) in ${room} and the other rooms from <strong>${money(r.reject.mean)}</strong> to <strong>${money(r.accept.mean)}</strong>.`);
lines.push(r.diff >= 0
? `It beats rejecting by <strong>${money(r.diff)}</strong>; rejecting does better in ${Math.round(r.pRejectBetter * 100)}% of the simulated futures.`
: `It falls short of rejecting by <strong>${money(-r.diff)}</strong>; rejecting does better in ${Math.round(r.pRejectBetter * 100)}% of the simulated futures.`);
if (r.ownUseNights.length) lines.push(`It takes ${r.ownUseNights.map((n) => escapeHtml(nice(n.date))).join(' and ')} in ${room}, worth ${money(r.ownUseNights.reduce((a, n) => a + n.value, 0))} to you empty.`);
if (r.breakEven != null) lines.push(r.breakEven > r.request.payout ? `Break-even payout: <strong>${money(r.breakEven)}</strong> (asked ${money(r.request.payout)}). From there accepting beats rejecting.` : `Break-even payout: ${money(r.breakEven)}, below the ${money(r.request.payout)} on offer.`);
const targets = Object.values(data.prefs.lettingChartTargets || {}).reduce((a, t) => a + (Number(t && t.normal) || 0), 0);
const income = (side) => side.parts.request + side.parts.before + side.parts.inside + side.parts.after + side.parts.other + r.existingIncome;
lines.push(`Expected income in that stretch: ${money(income(r.accept))} if accepted, ${money(income(r.reject))} if not${targets ? ` (your monthly targets add up to ${money(targets)})` : ''}.`);
if (state.prefill && state.prefill.estimated) lines.push('<span class="settings-note" style="margin:0;">The payout is an estimate from your nightly rate: this enquiry\'s email has none. Change it above and Evaluate again.</span>');
return `<div class="be-verdict">${lines.map((l) => `<div>${l}</div>`).join('')}</div>`;
}

// The Accept/Reject table. Each row opens to the pieces it is made of: the request's payout and
// what cancellation takes off it, the bookings expected before / on / after its nights (by
// whether it goes ahead or is cancelled), the bookings already made, cleaning, changeovers and
// what the empty nights are worth to you. A row's pieces add up to the figure on the row.
function tableHtml(r) {
const A = r.accept.parts; const J = r.reject.parts; const S = r.accept.scen; const c = r.cancel; const k = r.costs;
const pctTxt = (p) => `${Math.round(p * 100)}%`;
const num = (v) => (Math.abs(v) >= 10 ? Math.round(v) : Math.round(v * 10) / 10);
// A detail line: label, accept amount, reject amount (null = nothing to show), and a note.
const line = (label, a, j, { note = '', info = false } = {}) => ({ label, a, j, note, info });
const sign = (p, v) => (p.minus ? -v : v);

// Bookings expected in a stretch of the room, with their counts, nights and typical rate.
const bookingLines = (cat, name) => {
const out = [];
const avg = (parts) => (parts[`d_${cat}`] > 0 ? parts[cat] / parts[`d_${cat}`] : 0);
const describe = (parts) => (parts[`n_${cat}`] > 0.05 ? `${num(parts[`n_${cat}`])} booking${Math.abs(parts[`n_${cat}`] - 1) < 0.05 ? '' : 's'}, ${num(parts[`d_${cat}`])} nights at about ${money(avg(parts))}/night` : 'none expected');
out.push(line(`If you reject: ${describe(J)}`, null, J[cat]));
if (cat === 'other') { out.push(line(`Accept or reject: ${describe(A)}`, A[cat], null, { note: 'the same either way' })); return out; }
out.push(line(`If you accept and it goes ahead (${pctTxt(c.wNone)}): ${describe(S.none)}`, c.wNone * S.none[cat], null));
if (S.late) out.push(line(`If cancelled late (${pctTxt(c.wLate)}): ${describe(S.late)}`, c.wLate * S.late[cat], null, { note: 'the nights reopen with little time left to re-sell' }));
if (S.early) out.push(line(`If cancelled early (${pctTxt(c.wEarly)}): ${describe(S.early)}`, c.wEarly * S.early[cat], null, { note: 'the nights reopen with time to re-sell' }));
return out;
};

const w = r.request.weighted;
const detail = {
request: [
line(`The booking: ${money(r.request.payout)}${r.request.guestFactor !== 1 ? ` × ${r.request.guestFactor} (${r.request.guestWhy})` : ''}${r.request.channelFactor !== 1 ? ` × ${r.request.channelFactor} (direct)` : ''}`, w, 0),
...(c.wLate > 0 ? [line(`Cancelled late (${pctTxt(c.wLate)}): only ${pctTxt(c.latePay)} is paid`, -w * c.wLate * (1 - c.latePay), 0)] : []),
...(c.wEarly > 0 ? [line(`Cancelled early (${pctTxt(c.wEarly)}): nothing is paid`, -w * c.wEarly, 0)] : []),
line(`Nights re-sold after a cancellation: ${money(A.inside)} (counted in "New bookings on its nights", not added here)`, null, null, { info: true }),
],
before: bookingLines('before'),
inside: bookingLines('inside'),
after: bookingLines('after'),
other: bookingLines('other'),
existing: r.existingList.length
? r.existingList.map((x) => line(`${x.guest ? String(x.guest).split(/[ ,]/)[0] : 'Booked'} · ${x.room} · ${short(x.checkin)} – ${short(x.checkout)}${x.income && Math.abs(x.income - x.inWindow) > 1 ? ` (${money(x.income)} in all, ${money(x.inWindow)} falls in the stretch)` : ''}`, x.inWindow, x.inWindow))
: [line('No other bookings fall in the stretch', 0, 0)],
clean: [
line(`First room cleaned on a changeover day: ${num(A.cleanFirstN)} days (if you accept) vs ${num(J.cleanFirstN)} (reject) × ${money(k.firstClean)}`, -A.cleanFirstN * k.firstClean, -J.cleanFirstN * k.firstClean),
line(`Each extra room the same day: ${num(A.cleanExtraN)} vs ${num(J.cleanExtraN)} × ${money(k.extraClean)}`, -A.cleanExtraN * k.extraClean, -J.cleanExtraN * k.extraClean),
],
hassle: [
line(`Mon–Fri changeover days: ${num(A.hassleWdN)} vs ${num(J.hassleWdN)} × ${money(k.hassleWd)}`, -A.hassleWdN * k.hassleWd, -J.hassleWdN * k.hassleWd),
line(`Sat–Sun changeover days: ${num(A.hassleWeN)} vs ${num(J.hassleWeN)} × ${money(k.hassleWe)}`, -A.hassleWeN * k.hassleWe, -J.hassleWeN * k.hassleWe),
],
ownUse: [
line(`Sun–Thu nights with a room empty: ${num(A.ownWdN)} vs ${num(J.ownWdN)}`, A.ownWd, J.ownWd, { note: `about ${money(A.ownWdN ? A.ownWd / A.ownWdN : J.ownWdN ? J.ownWd / J.ownWdN : 0)} a night` }),
line(`Fri–Sat nights with a room empty: ${num(A.ownWeN)} vs ${num(J.ownWeN)}`, A.ownWe, J.ownWe, { note: `about ${money(A.ownWeN ? A.ownWe / A.ownWeN : J.ownWeN ? J.ownWe / J.ownWeN : 0)} a night` }),
line(`A second room empty the same night (${Math.round(k.secondPct * 100)}% of its value): ${num(A.ownSecondN)} vs ${num(J.ownSecondN)} room-nights`, A.ownSecond, J.ownSecond),
],
};

const rows = PARTS.map((p) => {
const a = p.k === 'existing' ? r.existingIncome : A[p.k];
const j = p.k === 'existing' ? r.existingIncome : J[p.k];
const sa = sign(p, a); const sj = sign(p, j);
const d = sa - sj;
const open = state.expanded.has(p.k);
const diffCell = (v) => `<td class="num ${Math.abs(v) < 0.5 ? 'be-zero' : v > 0 ? 'be-pos' : 'be-neg'}">${Math.abs(v) < 0.5 ? '–' : signed(v)}</td>`;
const head = `<tr class="be-main" data-be-row="${p.k}" title="Show what this is made of"><td><span class="be-caret">${open ? '&#9662;' : '&#9656;'}</span>${escapeHtml(p.label)}</td><td class="num">${money(sa)}</td><td class="num">${money(sj)}</td>${diffCell(d)}</tr>`;
const subs = (detail[p.k] || []).map((l) => {
if (l.info) return `<tr class="be-sub be-info" data-be-sub="${p.k}"${open ? '' : ' hidden'}><td colspan="4">${escapeHtml(l.label)}</td></tr>`;
const la = l.a == null ? null : l.a; const lj = l.j == null ? null : l.j;
const dd = (la ?? 0) - (lj ?? 0);
return `<tr class="be-sub" data-be-sub="${p.k}"${open ? '' : ' hidden'}><td>${escapeHtml(l.label)}${l.note ? ` <span class="settings-note" style="margin:0;">· ${escapeHtml(l.note)}</span>` : ''}</td><td class="num">${la == null ? '' : money(la)}</td><td class="num">${lj == null ? '' : money(lj)}</td><td class="num ${Math.abs(dd) < 0.5 ? 'be-zero' : dd > 0 ? 'be-pos' : 'be-neg'}">${la == null && lj == null ? '' : Math.abs(dd) < 0.5 ? '–' : signed(dd)}</td></tr>`;
}).join('');
return head + subs;
}).join('');
const cancelNote = `Cancellation: ${pctTxt(c.wNone)} it goes ahead, ${pctTxt(c.wLate)} cancelled late (${pctTxt(c.latePay)} paid, nights reopen with little time left)${c.earlyPossible ? `, ${pctTxt(c.wEarly)} cancelled early (nothing paid, nights reopen)` : ''}. Click a row to see what it is made of.`;
return `<div style="overflow-x:auto;"><table class="limits-table be-table"><thead><tr><th></th><th class="num">Accept</th><th class="num">Reject</th><th class="num">Difference</th></tr></thead><tbody>${rows}
<tr class="be-total"><td>Total</td><td class="num">${money(r.accept.mean)}</td><td class="num">${money(r.reject.mean)}</td><td class="num ${r.diff >= 0 ? 'be-pos' : 'be-neg'}">${signed(r.diff)}</td></tr>
<tr><td class="settings-note" style="margin:0;">Range (1 in 10 futures below / above)</td><td class="num settings-note">${money(r.accept.p10)}–${money(r.accept.p90)}</td><td class="num settings-note">${money(r.reject.p10)}–${money(r.reject.p90)}</td><td></td></tr>
</tbody></table></div>
<div class="settings-note" style="margin:4px 0 0;">${cancelNote}</div>`;
}


function stripHtml(r) {
const cells = r.nights.map((n) => {
const day = new Date(`${n.date}T00:00:00`);
let cls = n.existing ? 'taken' : n.request ? 'req' : '';
let title; let bars;
if (n.existing) { title = `${nice(n.date)}: already booked`; bars = '<span class="be-bar full"></span>'; }
else if (!n.inBlock) { cls += ' out'; title = `${nice(n.date)}: not affected by this decision (${n.projected ? 'booked in the projected scenario' : 'empty in the projected scenario'})`; bars = n.projected ? '<span class="be-bar proj"></span>' : ''; }
else { title = `${nice(n.date)}: booked in ${Math.round(n.accept * 100)}% of futures if you accept${n.request ? ' (this request, allowing for cancellation)' : ''}, ${Math.round(n.reject * 100)}% if you reject`; bars = `<span class="be-bar a" style="height:${Math.round(n.accept * 100)}%"></span><span class="be-bar r" style="height:${Math.round(n.reject * 100)}%"></span>`; }
return `<div class="be-night ${cls}${n.weekend ? ' wknd' : ''}" title="${escapeHtml(title)}">
<div class="be-bars">${bars}</div>
<div class="be-day">${day.getDate()}</div><div class="be-wd">${'SMTWTFS'[day.getDay()]}</div></div>`;
}).join('');
const nb = r.neighbours;
const stayChip = state.stayChipHtml;
const edge = (id) => { const s = id && (data.airbnbReservations || []).find((x) => x.id === id); return s && stayChip ? stayChip(s) : '<span class="settings-note" style="margin:0;">none in view</span>'; };
return `<div class="be-strip-head settings-note" style="margin:10px 0 4px;">Chance each night in ${escapeHtml(r.room.label)} is booked: <span class="be-key a"></span> if you accept, <span class="be-key r"></span> if you reject, <span class="be-key full"></span> already booked, <span class="be-key proj"></span> beyond the bookings either side (not affected by the decision: one projected scenario); the request's nights are outlined. Booking before: ${edge(nb.before)}. Booking after: ${edge(nb.after)}.</div>
<div class="be-strip">${cells}</div>`;
}
function assumptionsHtml(r) {
const o = state.overrides;
const whatIf = {
demand: `<label class="be-whatif">Demand <select data-be-whatif="demand">${[0.6, 0.8, 1, 1.2, 1.5].map((v) => `<option value="${v}"${(o.demand || 1) === v ? ' selected' : ''}>${v === 1 ? 'as calibrated' : `${v > 1 ? '+' : ''}${Math.round((v - 1) * 100)}%`}</option>`).join('')}</select></label>`,
lead: `<label class="be-whatif">Lead time <select data-be-whatif="lead">${[0.5, 0.75, 1, 1.5, 2].map((v) => `<option value="${v}"${(o.lead || 1) === v ? ' selected' : ''}>${v === 1 ? 'as is' : `×${v}`}</option>`).join('')}</select></label>`,
cancel: `<label class="be-whatif">Cancellations <select data-be-whatif="cancel">${[0.5, 1, 2, 3].map((v) => `<option value="${v}"${(o.cancel || 1) === v ? ' selected' : ''}>${v === 1 ? 'as is' : `×${v}`}</option>`).join('')}</select></label>`,
elasticity: `<label class="be-whatif">Sensitivity <input type="number" step="0.1" min="0" data-be-whatif="elasticity" value="${escapeHtml(String(o.elasticity ?? state.ctx.s.elasticity))}" style="width:56px;"></label>`,
ownUse: `<label class="be-whatif">Own use <select data-be-whatif="ownUse">${[0, 0.5, 1, 1.5, 2].map((v) => `<option value="${v}"${(o.ownUse ?? 1) === v ? ' selected' : ''}>${v === 1 ? 'as set' : `×${v}`}</option>`).join('')}</select></label>`,
};
const rows = r.assumptions.map((a) => `<tr><td>${escapeHtml(a.label)}</td><td>${escapeHtml(a.value)}</td><td class="settings-note" style="margin:0;">${escapeHtml(a.source)}</td><td>${a.editable ? whatIf[a.editable] : ''}</td></tr>`).join('');
const changed = Object.keys(o).length;
return `<details class="settings-subgroup" id="be-assumptions"${changed ? ' open' : ''}><summary>Assumptions${changed ? ' (what-if applied)' : ''}</summary>
<div style="overflow-x:auto;"><table class="limits-table be-table"><thead><tr><th>Figure</th><th>Value</th><th>Where it comes from</th><th>What if</th></tr></thead><tbody>${rows}</tbody></table></div>
<div class="sync-row" style="margin-top:6px;">${changed ? '<button class="sync-btn sm inline" type="button" id="be-whatif-reset">Back to calibrated</button>' : ''}
<span class="settings-note" style="margin:0;">What-ifs apply to this evaluation only. Defaults are in <span class="inline-goto-link" data-goto-tab="settings" data-goto-target="#booking-evaluator-settings">Settings</span>. The simulated host takes any request that fits, so rejecting is slightly undervalued.</span></div>
</details>`;
}

// Three simulated futures drawn as timeline rows (the occupancy chart's style), one pair per
// future: what happens if you reject, and if you accept. Each bar is a booking with its
// amount; each row ends with a total of everything drawn in it and the model's net figure for
// the free stretch (every room, after cleaning, hassle and what empty nights are worth to you).
// Only the shaded free stretch is simulated per future; the nights beyond the bookings either
// side are one projected scenario, drawn identically in every row.
function examplesHtml(r) {
const dayMs = 86400000;
const t0 = new Date(`${r.display.start}T00:00:00Z`).getTime();
const N = r.display.nights;
const idx = (d) => Math.round((new Date(`${d}T00:00:00Z`).getTime() - t0) / dayMs);
const pctOf = (i) => `${(Math.max(0, Math.min(N, i)) / N) * 100}%`;
const bar = (b, cls, label, title) => {
const a = idx(b.checkin); const z = idx(b.checkout);
if (z <= 0 || a >= N) return '';
const clipL = a < 0; const clipR = z > N;
return `<span class="be-bk ${cls}${clipL ? ' clip-l' : ''}${clipR ? ' clip-r' : ''}" style="left:${pctOf(a)};width:${(Math.min(N, z) - Math.max(0, a)) / N * 100}%;" title="${escapeHtml(title)}">${escapeHtml(label)}</span>`;
};
// One overlay behind every row, so the weekend bands run unbroken from the top row to the
// bottom one, with the simulated free stretch tinted.
const weekends = [];
for (let i = 0; i < N; i++) { const wd = new Date(t0 + i * dayMs).getUTCDay(); if (wd === 5 || wd === 6) weekends.push(i); }
const wk = weekends.map((i) => `<span class="be-wk" style="left:${pctOf(i)};width:${100 / N}%;"></span>`).join('');
const bs = idx(r.window.start); const be = idx(r.window.end);
const blk = `<span class="be-blk" style="left:${pctOf(bs)};width:${(Math.min(N, be) - Math.max(0, bs)) / N * 100}%;" title="The free stretch: the only dates that can come out differently if you accept or reject"></span>`;
const head = Array.from({ length: N }, (_, i) => { const d = new Date(t0 + i * dayMs); const day = d.getUTCDate(); const show = day === 1 || i === 0 || day % 2 === 1; return `<span class="be-hd" style="left:${pctOf(i)};width:${100 / N}%;">${show ? (day === 1 || i === 0 ? `${day} ${d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })}` : day) : ''}</span>`; }).join('');
const existing = r.existingStays.map((x) => bar(x, 'existing', `${x.guest ? String(x.guest).split(/[ ,]/)[0] : 'Booked'}${x.amount ? ` ${money(x.amount)}` : ''}`, `${x.guest || 'Booked'}: ${short(x.checkin)} – ${short(x.checkout)}${x.amount ? `, ${money(x.amount)}` : ''} (already booked)`)).join('');
const projected = r.projected.map((b) => bar(b, 'proj', `${b.nights}n ${money(b.amount)}`, `Projected booking ${short(b.checkin)} – ${short(b.checkout)}: ${b.nights} night${b.nights === 1 ? '' : 's'} at about ${money(b.perNight)}/night = ${money(b.amount)}. One possible scenario for dates this decision doesn't touch; the same in every future.`)).join('');
const projectedSum = r.projected.reduce((a, b) => a + b.amount, 0);
const reqBar = bar(r.request, 'request', `Request ${money(r.request.payout)}`, `This request: ${short(r.request.checkin)} – ${short(r.request.checkout)}, ${money(r.request.payout)} (if it goes ahead)`);
const row = (label, bookings, withRequest, net) => {
const sum = r.existingStays.reduce((a, x) => a + (x.amount || 0), 0) + projectedSum + bookings.reduce((a, b) => a + b.amount, 0) + (withRequest ? r.request.payout : 0);
const bars = bookings.map((b) => bar(b, `new${b.discounted ? ' disc' : ''}`, `${b.nights}n ${money(b.amount)}`, `New booking ${short(b.checkin)} – ${short(b.checkout)}: ${b.nights} night${b.nights === 1 ? '' : 's'} at about ${money(b.perNight)}/night = ${money(b.amount)}${b.discounted ? ' (after a discount)' : ''}; arrived ${short(b.arrived)}`)).join('');
return `<div class="be-ex-row"><span class="be-ex-label ${label === 'Accept' ? 'acc' : 'rej'}">${escapeHtml(label)}</span><div class="be-ex-track">${existing}${projected}${withRequest ? reqBar : ''}${bars}</div><span class="be-ex-total" title="Everything drawn in this row (already booked, projected, new and the request), then the model's net figure for the free stretch">${money(sum)}<small>net ${money(net)}</small></span></div>`;
};
const futures = r.examples.map((e, i) => `<div class="be-ex-future"><div class="be-ex-name">Future ${i + 1}</div>
${row('Reject', e.reject, false, e.total.reject)}
${row('Accept', e.accept, true, e.total.accept)}</div>`).join('');
const key = (cls, text) => `<span class="be-sw ${cls}"></span>${text}`;
return `<details class="settings-subgroup" open><summary>Three of the simulated futures</summary>
<div class="settings-note be-ex-key" style="margin:4px 0 6px;">${escapeHtml(r.room.label)}. ${key('existing', 'Already booked')} ${key('new', 'New booking in this future')} ${key('disc', 'New, after a discount')} ${key('request', 'This request, if it goes ahead')} ${key('proj', 'Projected: not affected by the decision, same in every future')} ${key('wk', 'Fri and Sat')} ${key('blk', 'The free stretch that is simulated')}. The figure at the end of a row adds up everything drawn in it; "net" is the free stretch across every room after cleaning, hassle and what empty nights are worth to you. The model averages ${r.runs.toLocaleString('en-GB')} futures like these.</div>
<div class="be-ex-wrap"><div class="be-ex-chart"><div class="be-ex-overlay">${blk}${wk}</div><div class="be-ex-row be-ex-axis"><span class="be-ex-label"></span><div class="be-ex-track be-ex-head">${head}</div><span class="be-ex-total"></span></div>${futures}</div></div>
</details>`;
}

function logHtml() {
const q = state.prefill && state.prefill.requestId ? (data.bookingRequests || []).find((x) => x.id === state.prefill.requestId) : null;
const saved = q && q.evaluation ? `Saved ${escapeHtml(String(q.evaluation.at).slice(0, 10))} (${escapeHtml(q.evaluation.recommendation)}).` : '';
return `<div class="sync-row" style="margin-top:8px;align-items:center;">
<button class="sync-btn sm inline" type="button" id="be-sensitivity">What would change the answer?</button>
<button class="sync-btn sm inline" type="button" id="be-save">${q ? 'Save this verdict on the request' : 'Save to the request log'}</button>
<button class="sync-btn sm inline" type="button" data-be-decide="accepted">I accepted it</button>
<button class="sync-btn sm inline" type="button" data-be-decide="declined">I declined it</button>
<span class="sync-status" id="be-save-status">${saved}</span>
</div>
<div id="be-sens"></div>`;
}

function renderResult() {
const el = document.getElementById('be-result');
if (!el) return;
const r = state.result;
if (!r) { el.innerHTML = ''; return; }
if (r.error) { el.innerHTML = `<div class="settings-note" style="margin:6px 0;">${escapeHtml(r.error)}</div>`; return; }
el.innerHTML = verdictHtml(r) + tableHtml(r) + stripHtml(r) + assumptionsHtml(r) + examplesHtml(r) + logHtml();
}

// Saves the verdict on the logged request it came from, or adds a request record for one
// typed in by hand. `decision` (optional) records what you did.
function saveToLog(decision = '') {
const r = state.result;
if (!r || r.error) return null;
const req = state.req;
// Everything the monthly review (js/features/modelreview.js) needs to check this estimate against what
// happened: the free stretch it covered, both scenarios' money by part, the chance each night was
// expected to be booked either way, the cancellation odds, and the assumptions it was made under.
const block = r.nights.filter((n) => n.inBlock);
const partsOf = (p) => ({ request: Math.round(p.request), before: Math.round(p.before), inside: Math.round(p.inside), after: Math.round(p.after), other: Math.round(p.other), clean: Math.round(p.clean), hassle: Math.round(p.hassle), ownUse: Math.round(p.ownUse) });
const evaluation = {
at: new Date().toISOString(), accept: Math.round(r.accept.mean), reject: Math.round(r.reject.mean), diff: Math.round(r.diff), breakEven: r.breakEven == null ? null : Math.round(r.breakEven), recommendation: r.recommendation, payout: req.payout, modelVersion: r.modelVersion,
roomKey: r.room.key, listingId: req.listingId, checkin: req.checkin, checkout: req.checkout, platform: req.platform || 'airbnb', guestReviews: req.guestReviews,
weighted: Math.round(r.request.weighted), runs: r.runs,
block: { from: r.window.start, to: r.window.end, capped: r.window.capped },
acceptParts: partsOf(r.accept.parts), rejectParts: partsOf(r.reject.parts), existingIncome: Math.round(r.existingIncome),
nightAccept: block.map((n) => Math.round(n.accept * 100) / 100), nightReject: block.map((n) => Math.round(n.reject * 100) / 100),
cancel: { rate: Math.round(r.cancel.rate * 1000) / 1000, wNone: Math.round(r.cancel.wNone * 1000) / 1000, wLate: Math.round(r.cancel.wLate * 1000) / 1000, wEarly: Math.round(r.cancel.wEarly * 1000) / 1000, latePay: r.cancel.latePay },
assumptions: r.assumptionsSnap || null,
};
let q = state.prefill && state.prefill.requestId ? (data.bookingRequests || []).find((x) => x.id === state.prefill.requestId) : null;
if (!q) {
q = blankBookingRequest({ kind: 'request', listingId: req.listingId, checkin: req.checkin, checkout: req.checkout, payout: req.payout, platform: req.platform, guestReviews: req.guestReviews, guestRating: req.guestRating, receivedAt: new Date().toISOString(), reservationId: req.reservationId || '' });
data.bookingRequests.push(q);
state.prefill = { requestId: q.id, reservationId: q.reservationId, estimated: false };
}
q.evaluation = evaluation;
if (req.guestRating != null) q.guestRating = req.guestRating;
if (decision) { q.decision = decision; q.decidedOn = todayStr(); }
queueSave();
return q;
}

let bound = false;
async function initBookingEvaluator() {
const anchor = document.getElementById('letting-occupancy-section') || document.getElementById('letting-panel');
if (!anchor || document.getElementById('booking-evaluator')) return;
anchor.insertAdjacentHTML(anchor.id === 'letting-panel' ? 'beforeend' : 'afterend', sectionHtml());
fillListingSelect();
const { stayChipHtml, bindStayChips } = await import('./airbnb.js');
state.stayChipHtml = stayChipHtml;
bindStayChips();
if (bound) return;
bound = true;
const root = document.getElementById('booking-evaluator');
root.addEventListener('focusin', (e) => { if (e.target.id === 'be-listing') fillListingSelect(); });
root.addEventListener('click', async (e) => {
const main = e.target.closest('[data-be-row]');
if (main) {
const k = main.dataset.beRow;
const open = !state.expanded.has(k);
if (open) state.expanded.add(k); else state.expanded.delete(k);
root.querySelectorAll(`[data-be-sub="${k}"]`).forEach((tr) => { tr.hidden = !open; });
const caret = main.querySelector('.be-caret'); if (caret) caret.innerHTML = open ? '&#9662;' : '&#9656;';
return;
}
if (e.target.closest('#be-run')) { state.overrides = {}; run(); return; }
if (e.target.closest('#be-whatif-reset')) { state.overrides = {}; run(); return; }
if (e.target.closest('#be-save')) { saveToLog(); renderResult(); const s = document.getElementById('be-save-status'); if (s) s.textContent = 'Saved on the request log.'; return; }
const decide = e.target.closest('[data-be-decide]');
if (decide) { saveToLog(decide.dataset.beDecide); renderResult(); const s = document.getElementById('be-save-status'); if (s) s.textContent = `Recorded as ${decide.dataset.beDecide}.`; return; }
if (e.target.closest('#be-sensitivity')) {
const out = document.getElementById('be-sens');
out.innerHTML = '<div class="settings-note" style="margin:6px 0;">Re-running with each assumption moved…</div>';
await new Promise((r) => setTimeout(r, 20));
const model = await import('./bookingmodel.js');
const rows = await model.sensitivity(state.req, state.ctx, state.result, { onProgress: (t) => { out.innerHTML = `<div class="settings-note" style="margin:6px 0;">Re-running with each assumption moved: ${escapeHtml(t)}</div>`; } });
const flips = rows.filter((x) => x.flips);
out.innerHTML = `<div class="settings-note" style="margin:6px 0 2px;">${flips.length ? `${flips.length} change${flips.length === 1 ? '' : 's'} would flip the recommendation.` : 'None of these changes flips the recommendation.'}</div>
<table class="limits-table be-table"><thead><tr><th>If…</th><th class="num">Accept beats reject by</th><th>Recommendation</th></tr></thead><tbody>${rows.map((x) => `<tr${x.flips ? ' class="be-flip"' : ''}><td>${escapeHtml(x.label)}</td><td class="num">${x.error ? '' : signed(x.diff)}</td><td>${escapeHtml(x.error || x.recommendation)}${x.flips ? ' ⚠' : ''}</td></tr>`).join('')}</tbody></table>`;
}
});
root.addEventListener('change', (e) => {
const w = e.target.closest('[data-be-whatif]');
if (!w) return;
const v = Number(w.value);
if (!Number.isFinite(v)) return;
state.overrides[w.dataset.beWhatif] = v;
run();
});
}

export { initBookingEvaluator, openEvaluator };
