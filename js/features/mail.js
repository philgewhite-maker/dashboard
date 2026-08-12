import { data } from '../state.js';
import { escapeHtml } from '../utils.js';
import { canAttemptGoogleAction } from '../sync/googleauth.js';
import { fetchMailSummary } from '../googlemail.js';

// "Tamara White" <tamara.anna.white@gmail.com> -> "Tamara White"; falls
// back to the raw email if there's no display name on the header.
function displayName(fromHeader) {
const match = fromHeader.match(/^"?([^"<]+?)"?\s*<[^>]+>$/);
return (match ? match[1] : fromHeader).trim();
}

function formatDate(dateStr) {
const d = new Date(dateStr);
if (isNaN(d)) return '';
return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function messageRowHtml(m) {
return `<a class="mail-row" href="${escapeHtml(m.link)}" target="_blank" rel="noopener">
<span class="mail-from">${escapeHtml(displayName(m.from))}</span>
<span class="mail-subject">${escapeHtml(m.subject)}</span>
<span class="mail-date">${escapeHtml(formatDate(m.date))}</span>
</a>`;
}

function sectionHtml(title, messages) {
if (messages.length === 0) return '';
return `<div class="overview-group"><h3>${escapeHtml(title)}</h3><div class="mail-section">${messages.map(messageRowHtml).join('')}</div></div>`;
}

function renderMail(result) {
const list = document.getElementById('mail-list');
document.getElementById('mail-count').textContent = `${result.starred.length + result.fromTracked.length} shown`;
const days = Math.max(1, Number(data.prefs.mailSenderDays) || 1);
const html = [
sectionHtml('Starred', result.starred),
sectionHtml(`From tracked senders (last ${days} day${days === 1 ? '' : 's'})`, result.fromTracked),
].filter(Boolean).join('');
list.innerHTML = html || `<div class="empty">Nothing to show — no starred mail, and nothing from your tracked senders in the last ${days} day${days === 1 ? '' : 's'}.</div>`;
}

function initMail() {
const btn = document.getElementById('sync-mail-btn');
const status = document.getElementById('mail-sync-status');
btn.addEventListener('click', async () => {
if (!(await canAttemptGoogleAction())) {
status.textContent = 'Sign in to Google at the top of Overview first.';
return;
}
btn.disabled = true;
status.textContent = 'Loading…';
try {
const result = await fetchMailSummary(data.prefs);
renderMail(result);
status.textContent = `Updated ${new Date().toLocaleTimeString()}.`;
} catch (err) {
status.textContent = `Couldn't load mail: ${err.message || err}`;
console.error('Mail refresh failed:', err);
} finally {
btn.disabled = false;
}
});
}

export { initMail };
