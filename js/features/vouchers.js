import { data, queueSave } from '../state.js';
import { uid, escapeHtml, bindForm, daysUntil, scrollAndFlash } from '../utils.js';
import { pendingVoucherReviews, setLabelKind, markVoucherLinked, markVoucherSkipped } from './loyaltybalances.js';

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
if (reading.expiryDate) parts.push(`expires ${reading.expiryDate}`);
if (reading.reference) parts.push(`ref ${reading.reference}`);
return parts.join(' — ');
}

function voucherReviewRowHtml(item) {
const { reading, program, kind } = item;
const rid = reading.id;
const groupName = `voucher-review-${rid}`;
const header = `<div class="pending-new-info"><div><strong>${escapeHtml(program.name)}</strong> — ${escapeHtml(readingSummaryText(reading))}</div>`;
if (kind === undefined) {
return `<div class="candidate-row" data-review-id="${escapeHtml(rid)}">
${header}<div style="font-size:11px;color:var(--muted);">New kind of reading — is this a running balance, or a voucher/credit event?</div></div>
<div class="pending-options">
<label class="pending-option"><input type="radio" name="${groupName}" value="balance" data-review-classify="${escapeHtml(rid)}"><span class="pending-option-info">Running balance (points, miles, tier status…)</span></label>
<label class="pending-option"><input type="radio" name="${groupName}" value="voucher" data-review-classify="${escapeHtml(rid)}"><span class="pending-option-info">Voucher / credit event</span></label>
</div>
</div>`;
}
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
<div class="sync-row" style="margin-top:6px;">
<button type="button" class="sync-btn sm inline" data-review-confirm="${escapeHtml(rid)}">Confirm</button>
</div>
</div>`;
}

function applyVoucherLink(reading, program, decision, pickedId) {
if (decision === 'skip') { markVoucherSkipped(reading.id); return; }
const targetId = decision === 'pick' ? pickedId : decision.startsWith('update:') ? decision.slice(7) : '';
if (targetId) {
const voucher = data.vouchers.find((v) => v.id === targetId);
if (!voucher) return;
const value = readingValueText(reading);
if (value) voucher.value = value;
if (reading.expiryDate) voucher.expiry = reading.expiryDate;
if (reading.reference && !voucher.reference) voucher.reference = reading.reference;
const note = `Updated from ${program.name} scan (${reading.date}): ${readingSummaryText(reading)}.`;
voucher.notes = voucher.notes ? `${voucher.notes} | ${note}` : note;
voucher.sourceLoyaltyReadingIds = [...(voucher.sourceLoyaltyReadingIds || []), reading.id];
markVoucherLinked(reading.id, voucher.id);
return;
}
// decision === 'new'
const voucher = { id: uid(), name: `${program.name} — ${reading.label}`, type: 'Voucher', value: readingValueText(reading), expiry: reading.expiryDate || '', notes: `From ${program.name} scan, ${reading.date}.`, reference: reading.reference || '', sourceLoyaltyReadingIds: [reading.id] };
data.vouchers.push(voucher);
markVoucherLinked(reading.id, voucher.id);
}

function renderVoucherReview() {
const mount = document.getElementById('voucher-review-section');
if (!mount) return;
const items = pendingVoucherReviews();
if (!items.length) { mount.innerHTML = ''; return; }
mount.innerHTML = `<div class="album-card" style="margin-bottom:10px;">
<div class="album-caption"><strong>${items.length} reading${items.length === 1 ? '' : 's'}</strong> from loyalty scans need${items.length === 1 ? 's' : ''} a quick decision.</div>
${items.map(voucherReviewRowHtml).join('')}
</div>`;

mount.querySelectorAll('[data-review-classify]').forEach((el) => {
el.addEventListener('change', () => {
const item = items.find((x) => x.reading.id === el.dataset.reviewClassify);
if (!item || !el.checked) return;
setLabelKind(item.reading.programId, item.reading.label, el.value);
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
const item = items.find((x) => x.reading.id === rid);
if (!item) return;
const decision = mount.querySelector(`input[name="voucher-review-${rid}"]:checked`)?.value || 'new';
const pickedId = decision === 'pick' ? (mount.querySelector(`[data-review-pick-select="${rid}"]`)?.value || '') : '';
if (decision === 'pick' && !pickedId) return; // nothing chosen yet -- Confirm does nothing until it is
applyVoucherLink(item.reading, item.program, decision, pickedId);
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
