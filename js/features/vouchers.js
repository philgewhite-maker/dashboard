import { data, queueSave } from '../state.js';
import { uid, escapeHtml, bindForm, daysUntil } from '../utils.js';

const VOUCHER_TYPES = ['Voucher', 'Credit', 'Cheque', 'Refund', 'Other'];

function renderVouchers() {
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
});
nameInput.value = '';
valueInput.value = '';
expiryInput.value = '';
notesInput.value = '';
renderVouchers();
queueSave();
});
}

export { renderVouchers, initVoucherForm };
