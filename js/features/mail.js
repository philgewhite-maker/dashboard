import { data, mailSearchLabel } from '../state.js';
import { escapeHtml } from '../utils.js';
import { canAttemptGoogleAction } from '../sync/googleauth.js';
import { fetchMailSearches } from '../googlemail.js';
import { captureTask } from './tasks.js';

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
return `<div class="mail-row">
<a class="mail-link" href="${escapeHtml(m.link)}" target="_blank" rel="noopener">
<span class="mail-from">${escapeHtml(displayName(m.from))}</span>
<span class="mail-subject">${escapeHtml(m.subject)}</span>
<span class="mail-date">${escapeHtml(formatDate(m.date))}</span>
</a>
<button class="mini-task-btn" type="button" title="Capture as a task"
data-mail-task="${escapeHtml(m.id)}"
data-mail-subject="${escapeHtml(m.subject)}"
data-mail-from="${escapeHtml(displayName(m.from))}"
data-mail-url="${escapeHtml(m.link)}">+ task</button>
</div>`;
}

function sectionHtml(title, messages) {
if (messages.length === 0) return '';
return `<div class="overview-group"><h3>${escapeHtml(title)}</h3><div class="mail-section">${messages.map(messageRowHtml).join('')}</div></div>`;
}

// A section heading says what the row searched for and, when it's limited to
// a window, how far back — otherwise "From: x (3)" is ambiguous about
// whether that's all of them or just the recent ones.
function sectionTitle(search) {
const label = mailSearchLabel(search);
const days = Math.max(0, Number(search.maxDays) || 0);
return days > 0 ? `${label} — last ${days} day${days === 1 ? '' : 's'}` : label;
}

function renderMail(sections) {
const list = document.getElementById('mail-list');
const total = sections.reduce((n, s) => n + s.messages.length, 0);
document.getElementById('mail-count').textContent = `${total} shown`;
const html = sections.map((s) => sectionHtml(sectionTitle(s.search), s.messages)).filter(Boolean).join('');
list.innerHTML = html || (data.mailSearches.length === 0
? '<div class="empty">No mail searches set up — add some in Settings.</div>'
: '<div class="empty">Nothing matched your mail searches.</div>');

list.querySelectorAll('[data-mail-task]').forEach((btn) => {
btn.addEventListener('click', (e) => {
e.preventDefault();
captureTask({
title: `Reply: ${btn.dataset.mailSubject}`,
notes: `From ${btn.dataset.mailFrom}`,
source: { kind: 'mail', label: btn.dataset.mailSubject, url: btn.dataset.mailUrl },
});
btn.textContent = '✓ captured';
btn.disabled = true;
});
});
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
renderMail(await fetchMailSearches(data.mailSearches, data.prefs.mailResultCount));
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
