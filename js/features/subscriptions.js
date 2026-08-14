import { data, queueSave } from '../state.js';
import { uid, escapeHtml, bindForm, daysUntil } from '../utils.js';

const FREQUENCIES = ['Monthly', 'Yearly', 'Weekly', 'Other'];

function renderSubscriptions() {
const list = document.getElementById('subscriptions-list');
document.getElementById('subscriptions-count').textContent = data.subscriptions.length + (data.subscriptions.length === 1 ? ' subscription' : ' subscriptions');
if (data.subscriptions.length === 0) {
list.innerHTML = '<div class="empty">Nothing tracked yet. Add one below.</div>';
return;
}
const sorted = [...data.subscriptions].sort((a, b) => {
const da = a.nextRenewal ? daysUntil(a.nextRenewal) : Infinity;
const db = b.nextRenewal ? daysUntil(b.nextRenewal) : Infinity;
return da - db;
});

list.innerHTML = sorted.map((s) => {
let badgeHtml = '';
if (s.nextRenewal) {
const dn = daysUntil(s.nextRenewal);
if (dn < 0) {
badgeHtml = `<span class="expiry-badge expired">Update due</span>`;
} else if (dn <= 7) {
badgeHtml = `<span class="expiry-badge soon">${dn === 0 ? 'Renews today' : dn + 'd left'}</span>`;
} else {
badgeHtml = `<span class="expiry-badge">${dn}d left</span>`;
}
}
return `<div class="voucher-row" data-subscription-row="${s.id}">
<div class="voucher-id">
<input type="text" autocomplete="off" class="voucher-edit voucher-name-edit" data-field="name" data-sub-id="${s.id}" value="${escapeHtml(s.name)}">
<div class="voucher-meta">
<select class="voucher-edit voucher-type-edit" data-field="frequency" data-sub-id="${s.id}">
${FREQUENCIES.map((f) => `<option value="${f}" ${f === s.frequency ? 'selected' : ''}>${f}</option>`).join('')}
</select>
<input type="text" autocomplete="off" class="voucher-edit voucher-value-edit" data-field="cost" data-sub-id="${s.id}" value="${escapeHtml(s.cost || '')}" placeholder="Cost">
</div>
</div>
<input type="text" autocomplete="off" class="voucher-edit voucher-notes-edit" data-field="notes" data-sub-id="${s.id}" value="${escapeHtml(s.notes || '')}" placeholder="Notes">
<div class="voucher-expiry">
<input type="date" class="voucher-edit expiry-date-edit" data-field="nextRenewal" data-sub-id="${s.id}" value="${escapeHtml(s.nextRenewal || '')}">
${badgeHtml}
</div>
<div class="voucher-actions">
<span class="del-x" style="opacity:1;" data-del-subscription="${s.id}">&times;</span>
</div>
</div>`;
}).join('');

list.querySelectorAll('[data-field][data-sub-id]').forEach((el) => {
el.addEventListener('change', () => {
const s = data.subscriptions.find((x) => x.id === el.dataset.subId);
if (!s) return;
s[el.dataset.field] = el.value.trim();
renderSubscriptions();
queueSave();
});
});
list.querySelectorAll('[data-del-subscription]').forEach((el) => {
el.addEventListener('click', () => {
data.subscriptions = data.subscriptions.filter((x) => x.id !== el.dataset.delSubscription);
renderSubscriptions();
queueSave();
});
});
}

function initSubscriptionForm() {
bindForm('subscription-form', () => {
const nameInput = document.getElementById('subscription-name-input');
const frequencyInput = document.getElementById('subscription-frequency-input');
const costInput = document.getElementById('subscription-cost-input');
const renewalInput = document.getElementById('subscription-renewal-input');
const notesInput = document.getElementById('subscription-notes-input');
const name = nameInput.value.trim();
if (!name) return;
data.subscriptions.push({
id: uid(),
name,
frequency: frequencyInput.value,
cost: costInput.value.trim(),
nextRenewal: renewalInput.value,
notes: notesInput.value.trim(),
});
nameInput.value = '';
costInput.value = '';
renewalInput.value = '';
notesInput.value = '';
renderSubscriptions();
queueSave();
});
}

export { renderSubscriptions, initSubscriptionForm };
