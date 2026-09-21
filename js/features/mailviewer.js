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
//
// Attached images are a different matter and are NOT blocked: their bytes
// come from Google, not from the sender's server, so showing one calls
// nobody and reports nothing. That distinction is the whole point here --
// a boarding pass's QR code arrives as an inline attachment, and blocking
// it bought no privacy while making the one thing you opened the mail for
// invisible.
import { escapeHtml } from '../utils.js';
import { formatBytes } from '../files.js';

let dialog = null;
// Fetched attachment bytes for the message currently open, keyed by
// attachmentId. Cleared on close: these are whole images held in memory,
// and the next message's ids won't collide with them anyway.
let attachmentCache = new Map();
let objectUrls = [];

// Fetched up front so inline images can be put back where they belong
// without a tap. Capped because the fetch is per-attachment and a mail
// can carry a dozen full-resolution photos -- past these limits the file
// is still listed and still one tap away, it just isn't pre-loaded.
const AUTO_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const AUTO_IMAGE_MAX_COUNT = 6;

function close() {
if (dialog) { dialog.remove(); dialog = null; }
objectUrls.forEach((u) => URL.revokeObjectURL(u));
objectUrls = [];
attachmentCache = new Map();
document.removeEventListener('keydown', onKey);
}

function onKey(e) {
if (e.key === 'Escape') close();
}

function isImage(part) {
return (part.mimeType || '').startsWith('image/');
}

async function attachmentBytes(messageId, part) {
if (attachmentCache.has(part.attachmentId)) return attachmentCache.get(part.attachmentId);
const { fetchMessageAttachmentBytes } = await import('../googlemail.js');
const bytes = await fetchMessageAttachmentBytes(messageId, part.attachmentId);
attachmentCache.set(part.attachmentId, bytes);
return bytes;
}

function bytesToDataUrl(bytes, mimeType) {
let binary = '';
// Chunked: String.fromCharCode.apply with a multi-hundred-thousand
// element spread blows the argument limit on a real photo.
for (let i = 0; i < bytes.length; i += 0x8000) {
binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
}
return `data:${mimeType || 'application/octet-stream'};base64,${btoa(binary)}`;
}

function objectUrlFor(bytes, mimeType) {
const url = URL.createObjectURL(new Blob([bytes], { type: mimeType || 'application/octet-stream' }));
objectUrls.push(url);
return url;
}

// Puts each `<img src="cid:...">` back together with the attachment it
// points at, as a data: URL. It has to be data: rather than the blob:
// URLs used elsewhere in this file: the frame is srcdoc-sandboxed without
// allow-same-origin, so it has an opaque origin and can't read a blob URL
// minted by this document. A data: URL carries the bytes itself and
// doesn't care whose origin is reading it.
function resolveCids(html, inlineMap) {
if (!inlineMap || !inlineMap.size) return html;
return html.replace(/(<img\b[^>]*?\bsrc\s*=\s*)(["'])cid:([^"']+)\2/gi, (whole, pre, quote, cid) => {
const url = inlineMap.get(decodeURIComponent(cid).trim().toLowerCase());
return url ? `${pre}${quote}${url}${quote}` : whole;
});
}

// Everything that could reach out of the frame or phone home. The sandbox
// attribute already blocks scripts; this is about what renders and what
// silently loads. `srcdoc` with no allow-same-origin means the frame has
// an opaque origin, so even if something slipped through it can't touch
// the app's storage or DOM.
function prepareHtml(html, { showImages, inlineMap } = {}) {
let out = String(html || '');
out = out.replace(/<script[\s\S]*?<\/script>/gi, '');
out = out.replace(/<link\b[^>]*>/gi, '');
out = out.replace(/ on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
// Before the blocking pass below, so an inlined attachment survives it.
out = resolveCids(out, inlineMap);
if (!showImages) {
// Removed outright rather than left src-less: an <img> with no source
// renders as a broken-image icon and its alt text, which is noisier
// than the picture would have been. "Load images" re-renders from the
// original HTML, so nothing is lost by dropping them here.
//
// Anything already carrying its own bytes (the data: URLs resolveCids
// just wrote, or one the sender inlined) stays: there's no request to
// make, so there's nothing to block.
out = out.replace(/<img\b[^>]*>/gi, (tag) => (/src\s*=\s*["']?data:/i.test(tag) ? tag : ''));
out = out.replace(/background(-image)?\s*:\s*url\((?!['"]?data:)[^)]*\)/gi, '');
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

function bodyFrameHtml(detail, showImages, inlineMap) {
if (detail.bodyHtml) {
return `<iframe class="mail-view-frame" sandbox="allow-popups allow-popups-to-escape-sandbox"
srcdoc="${escapeHtml(prepareHtml(detail.bodyHtml, { showImages, inlineMap }))}"></iframe>`;
}
return `<pre class="mail-view-text">${escapeHtml(detail.bodyText || '(no body)')}</pre>`;
}

// An attached image shown in the card rather than the frame. The frame is
// a fixed height holding someone else's layout; a QR code you're about to
// hold up at a gate wants to be as large and as square-on as the screen
// allows, which is easier to guarantee out here.
function attachmentPreviewHtml(shown) {
if (!shown.length) return '';
return `<div class="mail-view-previews">${shown.map((s) => `<figure class="mail-view-preview">
<img src="${escapeHtml(s.url)}" alt="${escapeHtml(s.part.filename || 'Attached image')}">
<figcaption class="settings-note">${escapeHtml(s.part.filename || 'Attached image')}</figcaption>
</figure>`).join('')}</div>`;
}

function attachmentListHtml(state) {
const { attachments, previews } = state;
if (!attachments.length) return '';
const shown = new Set(previews.map((p) => p.part.attachmentId));
return `<div class="mail-view-atts">${attachments.map((a, i) => {
const already = shown.has(a.attachmentId);
const icon = already ? '✓' : (isImage(a) ? '🖼' : '📎');
return `<button class="mini-task-btn" type="button" data-mail-att="${i}"${already ? ' disabled' : ''}>${icon} ${escapeHtml(a.filename || 'attachment')}${a.size ? ` · ${escapeHtml(formatBytes(a.size))}` : ''}</button>`;
}).join('')}</div>`;
}

function render(state) {
const { detail, showImages, inlineMap, previews } = state;
dialog.innerHTML = `<div class="mail-view-card">
<div class="mail-view-head">
<div>
<div class="mail-view-subject">${escapeHtml(detail.subject || '(no subject)')}</div>
<div class="settings-note" style="margin:2px 0 0;">${escapeHtml(detail.from || '')}${detail.date ? ` · ${escapeHtml(detail.date)}` : ''}</div>
</div>
<span class="del-x" style="opacity:1;" data-mail-view-close title="Close">&times;</span>
</div>
${attachmentListHtml(state)}
${attachmentPreviewHtml(previews)}
${bodyFrameHtml(detail, showImages, inlineMap)}
<div class="mail-view-actions">
${detail.bodyHtml && !showImages ? '<button class="mini-task-btn" type="button" data-mail-view-images>Load remote images</button>' : ''}
<button class="mini-task-btn" type="button" data-mail-view-close>Close</button>
</div>
</div>`;
dialog.querySelectorAll('[data-mail-view-close]').forEach((b) => b.addEventListener('click', close));
const imagesBtn = dialog.querySelector('[data-mail-view-images]');
if (imagesBtn) imagesBtn.addEventListener('click', () => { state.showImages = true; render(state); });
dialog.querySelectorAll('[data-mail-att]').forEach((btn) => {
btn.addEventListener('click', () => openAttachment(state, Number(btn.dataset.mailAtt), btn));
});
}

// One attachment, on demand: an image joins the previews above the body,
// anything else is saved. Saving rather than opening in a tab because a
// blob: URL opened by window.open is what popup blockers exist to stop,
// and a downloaded PDF lands somewhere the phone's own viewer can open it.
async function openAttachment(state, index, btn) {
const part = state.attachments[index];
if (!part) return;
if (state.previews.some((p) => p.part.attachmentId === part.attachmentId)) return; // already on screen
const original = btn.textContent;
btn.textContent = 'Loading…';
btn.disabled = true;
try {
const bytes = await attachmentBytes(state.messageId, part);
if (!dialog) return;
const url = objectUrlFor(bytes, part.mimeType);
if (isImage(part)) {
state.previews.push({ part, url });
render(state);
return;
}
const a = document.createElement('a');
a.href = url;
a.download = part.filename || 'attachment';
document.body.appendChild(a);
a.click();
a.remove();
} catch (err) {
console.error('Attachment fetch failed:', err);
if (btn.isConnected) btn.textContent = "Couldn't load that";
return;
}
if (btn.isConnected) { btn.textContent = original; btn.disabled = false; }
}

// Pre-loads the small image attachments so the pictures that cost nothing
// to show are simply there: ones the body references by Content-ID go
// back inline where the sender put them, and any that nothing references
// (the case that prompted this -- a QR code listed as a file and nowhere
// else) get their own preview. Best-effort throughout: a failed fetch
// leaves the file listed and tappable, which is where it started.
async function loadInlineImages(state) {
const picks = state.attachments
.filter((a) => isImage(a) && (a.size || 0) <= AUTO_IMAGE_MAX_BYTES)
.slice(0, AUTO_IMAGE_MAX_COUNT);
if (!picks.length) return;
const referenced = new Set();
const html = state.detail.bodyHtml || '';
for (const part of picks) {
try {
const bytes = await attachmentBytes(state.messageId, part);
if (!dialog) return;
if (part.contentId && html.includes(part.contentId)) {
state.inlineMap.set(part.contentId.toLowerCase(), bytesToDataUrl(bytes, part.mimeType));
referenced.add(part.attachmentId);
} else {
state.previews.push({ part, url: objectUrlFor(bytes, part.mimeType) });
}
} catch (err) {
console.error('Inline image fetch failed:', err);
}
}
if (dialog && (state.inlineMap.size || state.previews.length)) render(state);
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
showDetail({ id, ...detail });
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
const state = {
messageId: detail.id || '',
detail,
showImages: false,
inlineMap: new Map(),
previews: [],
attachments: (detail.attachments || []).filter((a) => a.filename || isImage(a)),
};
render(state);
loadInlineImages(state);
return state;
}

export { openMessage, showDetail, prepareHtml };
