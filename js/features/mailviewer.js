// Reading one email, in the app.
//
// Gmail's web UI can't be deep-linked any more: its own URLs use a
// permalink id (FMfcg...) that the API never returns, and the two hex ids
// it does return -- thread and message -- are both ignored in a URL, so
// every attempt landed on the inbox. Confirmed by testing each in a
// plain browser tab, not just inside the app. Since we already hold
// gmail.readonly and already fetch the whole message for the AI
// extractions, showing it here is both more reliable and fewer taps than
// bouncing out to Gmail ever was.
//
// The message body is somebody else's HTML, so it goes in a SANDBOXED
// iframe: no scripts, no forms, no navigating the app away. Remote
// images are stripped by default too -- in a mail that's a tracking
// pixel telling the sender you opened it -- with a button to load them
// when you actually want the pictures.
import { escapeHtml } from '../utils.js';
import { formatBytes } from '../files.js';

let dialog = null;

function close() {
if (dialog) { dialog.remove(); dialog = null; }
document.removeEventListener('keydown', onKey);
}

function onKey(e) {
if (e.key === 'Escape') close();
}

// Everything that could reach out of the frame or phone home. The sandbox
// attribute already blocks scripts; this is about what renders and what
// silently loads. `srcdoc` with no allow-same-origin means the frame has
// an opaque origin, so even if something slipped through it can't touch
// the app's storage or DOM.
function prepareHtml(html, { showImages }) {
let out = String(html || '');
out = out.replace(/<script[\s\S]*?<\/script>/gi, '');
out = out.replace(/<link\b[^>]*>/gi, '');
out = out.replace(/ on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
if (!showImages) {
// Removed outright rather than left src-less: an <img> with no source
// renders as a broken-image icon and its alt text, which is noisier
// than the picture would have been. "Load images" re-renders from the
// original HTML, so nothing is lost by dropping them here.
out = out.replace(/<img\b[^>]*>/gi, '');
out = out.replace(/background(-image)?\s*:\s*url\([^)]*\)/gi, '');
}
return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">
<style>
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;line-height:1.5;color:#1c1b19;margin:0;padding:12px;word-break:break-word;}
img{max-width:100%;height:auto;}
table{max-width:100%;}
a{color:#7A4E6E;}
</style></head><body>${out}</body></html>`;
}

function bodyFrameHtml(detail, showImages) {
if (detail.bodyHtml) {
return `<iframe class="mail-view-frame" sandbox="allow-popups allow-popups-to-escape-sandbox"
srcdoc="${escapeHtml(prepareHtml(detail.bodyHtml, { showImages }))}"></iframe>`;
}
return `<pre class="mail-view-text">${escapeHtml(detail.bodyText || '(no body)')}</pre>`;
}

function render(id, detail, showImages) {
const attachments = (detail.attachments || []).filter((a) => a.filename);
dialog.innerHTML = `<div class="mail-view-card">
<div class="mail-view-head">
<div>
<div class="mail-view-subject">${escapeHtml(detail.subject || '(no subject)')}</div>
<div class="settings-note" style="margin:2px 0 0;">${escapeHtml(detail.from || '')}${detail.date ? ` · ${escapeHtml(detail.date)}` : ''}</div>
</div>
<span class="del-x" style="opacity:1;" data-mail-view-close title="Close">&times;</span>
</div>
${attachments.length ? `<div class="settings-note" style="margin:0 0 6px;">${attachments.length} attachment${attachments.length === 1 ? '' : 's'}: ${attachments.map((a) => `${escapeHtml(a.filename)} (${escapeHtml(formatBytes(a.size))})`).join(', ')}</div>` : ''}
${bodyFrameHtml(detail, showImages)}
<div class="mail-view-actions">
${detail.bodyHtml && !showImages ? '<button class="mini-task-btn" type="button" data-mail-view-images>Load images</button>' : ''}
<button class="mini-task-btn" type="button" data-mail-view-close>Close</button>
</div>
</div>`;
dialog.querySelectorAll('[data-mail-view-close]').forEach((b) => b.addEventListener('click', close));
const imagesBtn = dialog.querySelector('[data-mail-view-images]');
if (imagesBtn) imagesBtn.addEventListener('click', () => render(id, detail, true));
}

async function openMessage(id, { subject } = {}) {
close();
dialog = document.createElement('div');
dialog.className = 'mail-view-backdrop';
dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
dialog.innerHTML = `<div class="mail-view-card"><div class="mail-view-subject">${escapeHtml(subject || 'Loading…')}</div><div class="settings-note">Fetching the message…</div></div>`;
document.body.appendChild(dialog);
document.addEventListener('keydown', onKey);
try {
const { getMessageDetail } = await import('../googlemail.js');
const detail = await getMessageDetail(id);
if (!dialog) return; // closed while it was loading
showDetail(detail);
} catch (err) {
console.error('Could not open that message:', err);
if (dialog) {
dialog.innerHTML = `<div class="mail-view-card"><div class="mail-view-subject">Couldn't open that</div>
<div class="settings-note">${escapeHtml(err.message || String(err))}</div>
<div class="mail-view-actions"><button class="mini-task-btn" type="button" data-mail-view-close>Close</button></div></div>`;
dialog.querySelector('[data-mail-view-close]').addEventListener('click', close);
}
}
}

// Rendering split from fetching: the fetch needs a real Google sign-in,
// while the interesting part -- what of the sender's HTML survives into
// the frame -- is worth checking without one.
function showDetail(detail) {
if (!dialog) {
dialog = document.createElement('div');
dialog.className = 'mail-view-backdrop';
dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
document.body.appendChild(dialog);
document.addEventListener('keydown', onKey);
}
render(detail.id || '', detail, false);
}

export { openMessage, showDetail, prepareHtml };
