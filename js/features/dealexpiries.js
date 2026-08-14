import { data, queueSave } from '../state.js';
import { uid, escapeHtml, bindForm, daysUntil } from '../utils.js';

const DEAL_TYPES = ['Mortgage', 'Credit card', 'Loan', 'Insurance', 'Other'];

function renderDealExpiries() {
const list = document.getElementById('deals-list');
document.getElementById('deals-count').textContent = data.dealExpiries.length + (data.dealExpiries.length === 1 ? ' deal' : ' deals');
if (data.dealExpiries.length === 0) {
list.innerHTML = '<div class="empty">Nothing tracked yet. Add one below.</div>';
return;
}
const sorted = [...data.dealExpiries].sort((a, b) => {
const da = a.expiry ? daysUntil(a.expiry) : Infinity;
const db = b.expiry ? daysUntil(b.expiry) : Infinity;
return da - db;
});

list.innerHTML = sorted.map((d) => {
let badgeHtml = '';
if (d.expiry) {
const dn = daysUntil(d.expiry);
if (dn < 0) {
badgeHtml = `<span class="expiry-badge expired">Expired</span>`;
} else if (dn <= 60) {
badgeHtml = `<span class="expiry-badge soon">${dn === 0 ? 'Expires today' : dn + 'd left'}</span>`;
} else {
badgeHtml = `<span class="expiry-badge">${dn}d left</span>`;
}
}
return `<div class="voucher-row" data-deal-row="${d.id}">
<div class="voucher-id">
<input type="text" autocomplete="off" class="voucher-edit voucher-name-edit" data-field="name" data-deal-id="${d.id}" value="${escapeHtml(d.name)}">
<div class="voucher-meta">
<select class="voucher-edit voucher-type-edit" data-field="type" data-deal-id="${d.id}">
${DEAL_TYPES.map((t) => `<option value="${t}" ${t === d.type ? 'selected' : ''}>${t}</option>`).join('')}
</select>
</div>
</div>
<input type="text" autocomplete="off" class="voucher-edit voucher-notes-edit" data-field="notes" data-deal-id="${d.id}" value="${escapeHtml(d.notes || '')}" placeholder="Notes">
<div class="voucher-expiry">
<input type="date" class="voucher-edit expiry-date-edit" data-field="expiry" data-deal-id="${d.id}" value="${escapeHtml(d.expiry || '')}">
${badgeHtml}
</div>
<div class="voucher-actions">
<span class="del-x" style="opacity:1;" data-del-deal="${d.id}">&times;</span>
</div>
</div>`;
}).join('');

list.querySelectorAll('[data-field][data-deal-id]').forEach((el) => {
el.addEventListener('change', () => {
const d = data.dealExpiries.find((x) => x.id === el.dataset.dealId);
if (!d) return;
d[el.dataset.field] = el.value.trim();
renderDealExpiries();
queueSave();
});
});
list.querySelectorAll('[data-del-deal]').forEach((el) => {
el.addEventListener('click', () => {
data.dealExpiries = data.dealExpiries.filter((x) => x.id !== el.dataset.delDeal);
renderDealExpiries();
queueSave();
});
});
}

function initDealForm() {
bindForm('deal-form', () => {
const nameInput = document.getElementById('deal-name-input');
const typeInput = document.getElementById('deal-type-input');
const expiryInput = document.getElementById('deal-expiry-input');
const notesInput = document.getElementById('deal-notes-input');
const name = nameInput.value.trim();
if (!name) return;
data.dealExpiries.push({
id: uid(),
name,
type: typeInput.value,
expiry: expiryInput.value,
notes: notesInput.value.trim(),
});
nameInput.value = '';
expiryInput.value = '';
notesInput.value = '';
renderDealExpiries();
queueSave();
});
}

export { renderDealExpiries, initDealForm };
