import { data, queueSave } from '../state.js';
import { uid, escapeHtml, bindForm, daysUntil, scrollAndFlash } from '../utils.js';
import { pendingClassifications, pendingVoucherLinks, setLabelKind, markVoucherLinked, markVoucherSkipped } from './loyaltybalances.js';

const VOUCHER_TYPES = ['Voucher', 'Credit', 'Cheque', 'Refund', 'Other'];

// The canonical voucher reference -- this record type had none until
// now (dashboard/CLAUDE.md's own Record-reference standards table
// didn't cover vouchers at all). Mirrors tripChipHtml/bindTripChips
// (travel.js) exactly -- same delegated click pattern, same switchTab →
// reveal → scroll-and-flash shape, just a voucher glyph instead of a
// plane.
function voucherChipHtml(voucher, extraHtml = '') {
return `<span class="voucher-chip" data-open-voucher="${escapeHtml(voucher.id)}">&#127903; ${escapeHtml(voucher.name)}</span>${extraHtml}`;
}
function revealVoucher(id) {
import('../tabs.js').then(({ switchTab }) => {
switchTab('finances');
renderVouchers();
setTimeout(() => scrollAndFlash(`[data-voucher-row="${id}"]`), 60);
});
}
let voucherChipsBound = false;
function bindVoucherChips() {
if (voucherChipsBound) return;
voucherChipsBound = true;
document.addEventListener('click', (e) => {
const chip = e.target.closest('[data-open-voucher]');
if (!chip) return;
revealVoucher(chip.dataset.openVoucher);
});
}

// The reciprocal direction: a loyalty reading row (loyaltybalances.js)
// that linked to a voucher shows a chip back to it there; this reveals
// the READING from the voucher side. Doesn't import anything from
// loyaltybalances.js -- the Loyalty balances panel is already rendered
// as part of the normal Finance-tab wiring by the time this runs, same
// assumption revealTrip (travel.js) makes about its own tab's panels.
function revealLoyaltyReading(id) {
import('../tabs.js').then(({ switchTab }) => {
switchTab('finances');
setTimeout(() => scrollAndFlash(`[data-loyalty-reading="${id}"]`), 60);
});
}

function renderVouchers() {
renderVoucherReview();
const list = document.getElementById('vouchers-list');
document.getElementById('vouchers-count').textContent = data.vouchers.length + (data.vouchers.length === 1 ? ' item' : ' items');
if (data.vouchers.length === 0) {
list.innerHTML = '<div class="empty">Nothing tracked yet. Add one below.</div>';
return;
}
const sorted = [...data.vouchers].sort((a, b) => {
const da = a.expiry ? daysUntil(a.expiry) : Infinity;
const db = b.expiry ? daysUntil(b.expiry) : Infinity;
return da - db;
});

list.innerHTML = sorted.map((v) => {
let badgeHtml = '';
if (v.expiry) {
const dn = daysUntil(v.expiry);
if (dn < 0) {
badgeHtml = `<span class="expiry-badge expired">Expired</span>`;
} else if (dn <= 30) {
badgeHtml = `<span class="expiry-badge soon">${dn === 0 ? 'Expires today' : dn + 'd left'}</span>`;
} else {
badgeHtml = `<span class="expiry-badge">${dn}d left</span>`;
}
}
return `<div class="voucher-row" data-voucher-row="${v.id}">
<div class="voucher-id">
<input type="text" autocomplete="off" class="voucher-edit voucher-name-edit" data-field="name" data-voucher-id="${v.id}" value="${escapeHtml(v.name)}">
<div class="voucher-meta">
<select class="voucher-edit voucher-type-edit" data-field="type" data-voucher-id="${v.id}">
${VOUCHER_TYPES.map((t) => `<option value="${t}" ${t === v.type ? 'selected' : ''}>${t}</option>`).join('')}
</select>
<input type="text" autocomplete="off" class="voucher-edit voucher-value-edit" data-field="value" data-voucher-id="${v.id}" value="${escapeHtml(v.value || '')}" placeholder="Value">
</div>
</div>
<input type="text" autocomplete="off" class="voucher-edit voucher-notes-edit" data-field="notes" data-voucher-id="${v.id}" value="${escapeHtml(v.notes || '')}" placeholder="Notes">
<input type="text" autocomplete="off" class="voucher-edit voucher-reference-edit" data-field="reference" data-voucher-id="${v.id}" value="${escapeHtml(v.reference || '')}" placeholder="Reference (optional)" title="A voucher/booking reference, if it has one -- the loyalty-scan review matches on this to offer a confident 'Update' instead of risking a merge with an unrelated voucher.">
<div class="voucher-expiry">
<input type="date" class="voucher-edit expiry-date-edit" data-field="expiry" data-voucher-id="${v.id}" value="${escapeHtml(v.expiry || '')}">
${badgeHtml}
</div>
<div class="voucher-actions">
${(v.sourceLoyaltyReadingIds || []).length ? `<span class="tag-chip" data-open-loyalty-reading="${v.sourceLoyaltyReadingIds[v.sourceLoyaltyReadingIds.length - 1]}" title="Created or updated from a loyalty scan reading -- click to see it">from loyalty scan</span>` : ''}
<span class="del-x" style="opacity:1;" data-del-voucher="${v.id}">&times;</span>
</div>
</div>`;
}).join('');

list.querySelectorAll('[data-field][data-voucher-id]').forEach((el) => {
el.addEventListener('change', () => {
const v = data.vouchers.find((x) => x.id === el.dataset.voucherId);
if (!v) return;
v[el.dataset.field] = el.value.trim();
renderVouchers();
queueSave();
});
});
list.querySelectorAll('[data-del-voucher]').forEach((el) => {
el.addEventListener('click', () => {
data.vouchers = data.vouchers.filter((x) => x.id !== el.dataset.delVoucher);
renderVouchers();
queueSave();
});
});
list.querySelectorAll('[data-open-loyalty-reading]').forEach((el) => {
el.addEventListener('click', (e) => {
e.stopPropagation();
revealLoyaltyReading(el.dataset.openLoyaltyReading);
});
});
}

// ---- Review queue: loyalty-scan readings waiting on a human decision ----
// A reading lands here either because its (programId, label) pair has
// never been classified balance-vs-voucher at all, or because it's
// already classified 'voucher' and hasn't been linked to a voucher (or
// explicitly skipped) yet. This is a Vouchers-panel decision -- "is this
// a voucher" -- not a scanning one, so it lives here rather than on the
// Loyalty balances panel itself.
function matchVouchersForReading(reading, program) {
const byReference = reading.reference ? data.vouchers.filter((v) => v.reference && v.reference === reading.reference) : [];
const needle = (program?.name || '').toLowerCase();
const byNameOnly = needle ? data.vouchers.filter((v) => !byReference.includes(v) && v.name.toLowerCase().includes(needle)) : [];
return { byReference, byNameOnly };
}

function readingValueText(reading) {
if (reading.balance == null) return /used/i.test(reading.label) ? 'Used' : '';
return `${reading.unit === '£' ? '£' : ''}${reading.balance.toLocaleString('en-GB')}${reading.unit && reading.unit !== '£' ? ' ' + reading.unit : ''}`;
}

function readingSummaryText(reading) {
const parts = [reading.label];
const value = readingValueText(reading);
if (value) parts.push(value);
parts.push(`on ${reading.date}`);
if (reading.expiryDate) parts.push(`expires ${reading.expiryDate}`);
if (reading.reference) parts.push(`ref ${reading.reference}`);
return parts.join(' — ');
}

// One row per (programId, label) group needing a balance-vs-voucher
// decision -- see pendingClassifications() for why this is deduped
// rather than one row per historical reading. Shows up to 3 recent
// sample readings (with dates) for context.
function classifyRowHtml(group) {
const key = `${group.programId}|${group.label}`;
const groupName = `voucher-classify-${escapeHtml(key)}`;
const samplesHtml = group.samples.map((r) => `<div style="font-size:11px;color:var(--muted);">${escapeHtml(r.date)} — ${escapeHtml(readingValueText(r) || '—')}</div>`).join('');
const moreCount = group.total - group.samples.length;
const moreNote = moreCount > 0 ? `<div style="font-size:11px;color:var(--muted);">+ ${moreCount} earlier reading${moreCount === 1 ? '' : 's'}</div>` : '';
return `<div class="candidate-row" data-classify-key="${escapeHtml(key)}">
<div class="pending-new-info">
<div><strong>${escapeHtml(group.program.name)}</strong> — ${escapeHtml(group.label)}</div>
${samplesHtml}
${moreNote}
<div style="font-size:11px;color:var(--muted);margin-top:4px;">New kind of reading — is this a running balance, or a voucher/credit event?</div>
</div>
<div class="pending-options">
<label class="pending-option"><input type="radio" name="${groupName}" value="balance" data-classify-key-radio="${escapeHtml(key)}" data-classify-program="${escapeHtml(group.programId)}" data-classify-label="${escapeHtml(group.label)}"><span class="pending-option-info">Running balance (points, miles, tier status…)</span></label>
<label class="pending-option"><input type="radio" name="${groupName}" value="voucher" data-classify-key-radio="${escapeHtml(key)}" data-classify-program="${escapeHtml(group.programId)}" data-classify-label="${escapeHtml(group.label)}"><span class="pending-option-info">Voucher / credit event</span></label>
</div>
</div>`;
}

function voucherLinkRowHtml(item, siblings) {
const { reading, program } = item;
const rid = reading.id;
const groupName = `voucher-review-${rid}`;
const header = `<div class="pending-new-info"><div><strong>${escapeHtml(program.name)}</strong> — ${escapeHtml(readingSummaryText(reading))}</div>`;
const { byReference, byNameOnly } = matchVouchersForReading(reading, program);
const hasReferenceMatch = byReference.length > 0;
const matchOptions = [
...byReference.map((v) => `<label class="pending-option"><input type="radio" name="${groupName}" value="update:${v.id}" data-review-link="${escapeHtml(rid)}" checked><span class="pending-option-info">Update "${escapeHtml(v.name)}" (ref ${escapeHtml(v.reference)}, currently ${escapeHtml(v.value || '—')}${v.expiry ? `, expires ${escapeHtml(v.expiry)}` : ''})</span></label>`),
...byNameOnly.map((v) => `<label class="pending-option"><input type="radio" name="${groupName}" value="update:${v.id}" data-review-link="${escapeHtml(rid)}"><span class="pending-option-info">Update "${escapeHtml(v.name)}" — same name, but its reference (${escapeHtml(v.reference || 'none')}) differs from this reading's (${escapeHtml(reading.reference || 'none')}) — check before confirming</span></label>`),
].join('');
return `<div class="candidate-row ambiguous" data-review-id="${escapeHtml(rid)}">
${header}</div>
<div class="pending-options">
${matchOptions}
<label class="pending-option">
<input type="radio" name="${groupName}" value="pick" data-review-link="${escapeHtml(rid)}">
<span class="pending-option-info">Different existing voucher&hellip;</span>
</label>
<div class="decision-pick" data-review-pick="${escapeHtml(rid)}" hidden>
<select data-review-pick-select="${escapeHtml(rid)}">
<option value="">Choose&hellip;</option>
${data.vouchers.map((v) => `<option value="${escapeHtml(v.id)}">${escapeHtml(v.name)}</option>`).join('')}
</select>
</div>
<label class="pending-option">
<input type="radio" name="${groupName}" value="new" data-review-link="${escapeHtml(rid)}" ${hasReferenceMatch ? '' : 'checked'}>
<span class="pending-option-info">Add as new voucher</span>
</label>
<label class="pending-option">
<input type="radio" name="${groupName}" value="skip" data-review-link="${escapeHtml(rid)}">
<span class="pending-option-info">Not a voucher &mdash; skip this one</span>
</label>
</div>
${siblings.length ? `<label class="pending-option" style="margin-top:6px;">
<input type="checkbox" data-review-apply-all="${escapeHtml(rid)}" checked>
<span class="pending-option-info">Also apply this to the other ${siblings.length} unresolved "${escapeHtml(reading.label)}" reading${siblings.length === 1 ? '' : 's'} below &mdash; tick off if some of these are genuinely separate, not the same one reported again</span>
</label>` : ''}
<div class="sync-row" style="margin-top:6px;">
<button type="button" class="sync-btn sm inline" data-review-confirm="${escapeHtml(rid)}">Confirm</button>
</div>
</div>`;
}

// Resolves ONE voucher-shaped reading against an existing/new voucher
// -- the targeted voucher's value/expiry/reference/notes/source-id list
// all come from THIS reading. Used both for a single confirm and, once
// per sibling, for the "apply to all matching" bulk path below.
function applyUpdateToVoucher(reading, program, voucherId) {
const voucher = data.vouchers.find((v) => v.id === voucherId);
if (!voucher) return;
const value = readingValueText(reading);
if (value) voucher.value = value;
if (reading.expiryDate) voucher.expiry = reading.expiryDate;
if (reading.reference && !voucher.reference) voucher.reference = reading.reference;
const note = `Updated from ${program.name} scan (${reading.date}): ${readingSummaryText(reading)}.`;
voucher.notes = voucher.notes ? `${voucher.notes} | ${note}` : note;
voucher.sourceLoyaltyReadingIds = [...(voucher.sourceLoyaltyReadingIds || []), reading.id];
markVoucherLinked(reading.id, voucher.id);
}

function applyVoucherLink(reading, program, decision, pickedId) {
if (decision === 'skip') { markVoucherSkipped(reading.id); return; }
const targetId = decision === 'pick' ? pickedId : decision.startsWith('update:') ? decision.slice(7) : '';
if (targetId) { applyUpdateToVoucher(reading, program, targetId); return; }
// decision === 'new'
const voucher = { id: uid(), name: `${program.name} — ${reading.label}`, type: 'Voucher', value: readingValueText(reading), expiry: reading.expiryDate || '', notes: `From ${program.name} scan, ${reading.date}.`, reference: reading.reference || '', sourceLoyaltyReadingIds: [reading.id] };
data.vouchers.push(voucher);
markVoucherLinked(reading.id, voucher.id);
}

// "Apply to all": confirmed live as a real need -- Hertz's "free day
// earned" email gets re-sent for the SAME one day, repeatedly, not a
// fresh day each time, so a label with many pending siblings is more
// often one real thing reported many times than many real things. A
// 'new' decision still creates exactly ONE voucher (from the row that
// was actually confirmed); every sibling, including that row, is then
// folded into it via applyUpdateToVoucher, so N duplicate readings
// collapse into one voucher with an N-line history, not N vouchers.
function applyVoucherLinkToGroup(reading, program, decision, pickedId, allReadings) {
if (decision === 'skip') { allReadings.forEach((r) => markVoucherSkipped(r.id)); return; }
let targetId = decision === 'pick' ? pickedId : decision.startsWith('update:') ? decision.slice(7) : '';
if (!targetId) {
const voucher = { id: uid(), name: `${program.name} — ${reading.label}`, type: 'Voucher', value: '', expiry: '', notes: '', reference: '', sourceLoyaltyReadingIds: [] };
data.vouchers.push(voucher);
targetId = voucher.id;
}
allReadings.forEach((r) => applyUpdateToVoucher(r, program, targetId));
}

function renderVoucherReview() {
const mount = document.getElementById('voucher-review-section');
if (!mount) return;
const classifications = pendingClassifications();
const links = pendingVoucherLinks();
const total = classifications.length + links.length;
if (!total) { mount.innerHTML = ''; return; }
// Siblings: OTHER still-pending readings sharing this exact (program,
// label) pair, excluding the row's own reading -- feeds the "apply to
// all" checkbox/count on each row.
const siblingsFor = (item) => links.filter((x) => x.reading.id !== item.reading.id && x.reading.programId === item.reading.programId && x.reading.label === item.reading.label);
mount.innerHTML = `<div class="album-card" style="margin-bottom:10px;">
<div class="album-caption"><strong>${total} item${total === 1 ? '' : 's'}</strong> from loyalty scans need${total === 1 ? 's' : ''} a quick decision.</div>
${classifications.map(classifyRowHtml).join('')}
${links.map((item) => voucherLinkRowHtml(item, siblingsFor(item))).join('')}
</div>`;

mount.querySelectorAll('[data-classify-key-radio]').forEach((el) => {
el.addEventListener('change', () => {
if (!el.checked) return;
setLabelKind(el.dataset.classifyProgram, el.dataset.classifyLabel, el.value);
renderVoucherReview();
});
});
mount.querySelectorAll('[data-review-link]').forEach((el) => {
el.addEventListener('change', () => {
const picker = mount.querySelector(`[data-review-pick="${el.dataset.reviewLink}"]`);
if (picker) picker.hidden = el.value !== 'pick';
});
});
mount.querySelectorAll('[data-review-confirm]').forEach((el) => {
el.addEventListener('click', () => {
const rid = el.dataset.reviewConfirm;
const item = links.find((x) => x.reading.id === rid);
if (!item) return;
const decision = mount.querySelector(`input[name="voucher-review-${rid}"]:checked`)?.value || 'new';
const pickedId = decision === 'pick' ? (mount.querySelector(`[data-review-pick-select="${rid}"]`)?.value || '') : '';
if (decision === 'pick' && !pickedId) return; // nothing chosen yet -- Confirm does nothing until it is
const applyAll = mount.querySelector(`[data-review-apply-all="${rid}"]`)?.checked;
if (applyAll) {
// Oldest-first so the voucher's final value/expiry reflects the
// MOST RECENT reading (each pass in applyUpdateToVoucher overwrites
// the one before it) while the notes history still reads in order.
const group = [...siblingsFor(item), item].map((x) => x.reading).sort((a, b) => a.date.localeCompare(b.date));
applyVoucherLinkToGroup(item.reading, item.program, decision, pickedId, group);
} else {
applyVoucherLink(item.reading, item.program, decision, pickedId);
}
queueSave();
renderVouchers(); // re-renders the review section too (its own first line)
});
});
}

function initVoucherForm() {
bindForm('voucher-form', () => {
const nameInput = document.getElementById('voucher-name-input');
const typeInput = document.getElementById('voucher-type-input');
const valueInput = document.getElementById('voucher-value-input');
const expiryInput = document.getElementById('voucher-expiry-input');
const notesInput = document.getElementById('voucher-notes-input');
const name = nameInput.value.trim();
if (!name) return;
data.vouchers.push({
id: uid(),
name,
type: typeInput.value,
value: valueInput.value.trim(),
expiry: expiryInput.value,
notes: notesInput.value.trim(),
reference: '',
sourceLoyaltyReadingIds: [],
});
nameInput.value = '';
valueInput.value = '';
expiryInput.value = '';
notesInput.value = '';
renderVouchers();
queueSave();
});
bindVoucherChips();
}

export { renderVouchers, initVoucherForm, voucherChipHtml, bindVoucherChips };
