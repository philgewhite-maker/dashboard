// Invite management for the public bank-switch advisor, moved here from that
// app's own Admin tab so nothing admin-shaped is visible on the public page.
// The admin secret is held only in this browser's local settings (never
// synced) and sent as X-Admin-Secret straight to the advisor's server.
import { getLocalSettings, setLocalSetting } from '../state.js';
import { escapeHtml } from '../utils.js';

const API = 'https://georgewhiteeuropean.co.uk/switchadvisor.php';
const PUBLIC_PAGE = 'https://philgewhite-maker.github.io/dashboard/public-switchadvisor/';

async function adminCall(action, secret, body) {
const res = await fetch(`${API}?action=${action}`, {
method: body ? 'POST' : 'GET',
headers: { 'X-Admin-Secret': secret, ...(body ? { 'Content-Type': 'application/json' } : {}) },
body: body ? JSON.stringify(body) : undefined,
});
const json = await res.json().catch(() => ({}));
if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
return json;
}

function inviteRowHtml(inv) {
const bits = [`Created ${escapeHtml((inv.createdAt || '').slice(0, 10))}`];
if (inv.lastRedeemedAt) bits.push(`last used ${escapeHtml(inv.lastRedeemedAt.slice(0, 10))}`);
if (inv.redeemed) bits.push(`${inv.accountCount} account${inv.accountCount === 1 ? '' : 's'} added`);
return `<div class="settings-note" style="margin:0 0 6px;"><strong>${escapeHtml(inv.label)}</strong> — ${inv.redeemed ? 'redeemed' : 'not used yet'} · ${bits.join(' · ')}</div>`;
}

export async function initSwitchAdvisorAdmin() {
const secretInput = document.getElementById('sa-admin-secret');
const labelInput = document.getElementById('sa-admin-label');
const createBtn = document.getElementById('sa-admin-create');
const result = document.getElementById('sa-admin-result');
const list = document.getElementById('sa-admin-list');
if (!secretInput || !createBtn) return;

const settings = await getLocalSettings();
secretInput.value = settings.switchAdvisorAdminSecret || '';
let saveTimer = null;
secretInput.addEventListener('input', () => {
clearTimeout(saveTimer);
saveTimer = setTimeout(() => setLocalSetting('switchAdvisorAdminSecret', secretInput.value.trim()), 400);
});

async function refresh() {
const secret = secretInput.value.trim();
if (!secret) { list.innerHTML = '<div class="settings-note">Enter the admin secret above to see invites.</div>'; return; }
try {
const { invites } = await adminCall('invite-list', secret);
list.innerHTML = invites.length ? invites.map(inviteRowHtml).join('') : '<div class="settings-note">No invites created yet.</div>';
} catch (err) {
list.innerHTML = `<div class="settings-note">Couldn't load invites: ${escapeHtml(err.message)}</div>`;
}
}

createBtn.addEventListener('click', async () => {
const label = labelInput.value.trim();
if (!label) { result.textContent = 'Give the invite a name first.'; return; }
try {
const { token } = await adminCall('invite-create', secretInput.value.trim(), { label });
const url = `${PUBLIC_PAGE}?invite=${token}`;
result.innerHTML = `Invite link for <strong>${escapeHtml(label)}</strong> (click to select, then copy): <code class="sa-invite-url" style="user-select:all;word-break:break-all;">${escapeHtml(url)}</code>`;
labelInput.value = '';
refresh();
} catch (err) {
result.textContent = `Couldn't create invite: ${err.message}`;
}
});

// Load the list when the panel is first opened, not on every page load.
const item = document.getElementById('sa-admin-item');
item?.addEventListener('toggle', () => { if (item.open) refresh(); }, { once: true });
}
