import { data, queueSave } from '../state.js';
import { uid, escapeHtml, bindForm, daysUntil } from '../utils.js';

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
let dateHtml = '<span class="expiry-date">No renewal date set</span>';
if (s.nextRenewal) {
const dn = daysUntil(s.nextRenewal);
dateHtml = `<span class="expiry-date">${escapeHtml(s.nextRenewal)}</span>`;
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
<div class="voucher-name">${escapeHtml(s.name)}</div>
<div class="voucher-meta">
<span class="voucher-type">${escapeHtml(s.frequency)}</span>
${s.cost ? `<span class="voucher-value">${escapeHtml(s.cost)}</span>` : ''}
</div>
</div>
${s.notes ? `<span class="voucher-notes">${escapeHtml(s.notes)}</span>` : '<span class="voucher-notes"></span>'}
<div class="voucher-expiry">
${dateHtml}
${badgeHtml}
</div>
<div class="voucher-actions">
<span class="del-x" style="opacity:1;" data-del-subscription="${s.id}">&times;</span>
</div>
</div>`;
}).join('');

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
