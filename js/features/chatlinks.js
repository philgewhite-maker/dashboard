// Where a person's live chat is, as links: Tinder web, WhatsApp (wa.me),
// Telegram (t.me). Shared by the Today queue and the connection card's
// chat history box. Only function-level use of connections.js, so the
// import cycle with it is harmless.
import { escapeHtml } from '../utils.js';
import { CONN_STAGES } from './connections.js';

// Moved to Telegram -> Telegram. Moved to WhatsApp, or any stage after it up
// to Dating (calls, meetings, dating), -> WhatsApp when there is a usable
// number. Everything earlier (or no number) stays on Tinder.
function liveChat(c) {
if (c.stage === 'Moved to Telegram') return 'Telegram';
if (c.stage === 'Moved to WhatsApp') return 'WhatsApp';
const i = CONN_STAGES.indexOf(c.stage);
if (i > CONN_STAGES.indexOf('Moved to WhatsApp') && i <= CONN_STAGES.indexOf('Dating') && waDigits(c.phone)) return 'WhatsApp';
return 'Tinder';
}

function waDigits(phone) {
const raw = String(phone || '').trim();
if (!raw || !(raw.startsWith('+') || raw.startsWith('00'))) return '';
const d = raw.replace(/\D/g, '').replace(/^00/, '');
return d.length >= 8 ? d : '';
}

// Every link this person has, keyed by platform.
function chatOptions(c) {
const tinderRows = (c.identities || []).filter((r) => r.platform === 'Tinder' && r.matchId);
const tinderId = tinderRows.length ? tinderRows[tinderRows.length - 1].matchId : c.tinderMatchId;
const wa = waDigits(c.phone);
const tgRows = (c.identities || []).filter((r) => r.platform === 'Telegram' && r.handle);
const tg = tgRows.length ? String(tgRows[tgRows.length - 1].handle).replace(/^@/, '') : '';
return {
Tinder: tinderId ? { url: `https://tinder.com/app/messages/${encodeURIComponent(tinderId)}`, label: 'Tinder' } : null,
WhatsApp: wa ? { url: `https://wa.me/${wa}`, label: 'WhatsApp' } : null,
Telegram: tg ? { url: `https://t.me/${encodeURIComponent(tg)}`, label: 'Telegram' } : null,
};
}

// The page that opens this person's live chat, or a reason there isn't one.
function chatTarget(c) {
const want = liveChat(c);
const options = chatOptions(c);
const hit = options[want] || options.Tinder || options.WhatsApp || options.Telegram;
if (hit) return { ...hit, why: '' };
if (want === 'WhatsApp' && c.phone) return { url: '', label: '', why: 'phone needs a +country code' };
return { url: '', label: '', why: 'no Tinder id or number on file' };
}

function linkHtml(o, primary) {
return `<a class="overview-chip dq-chat" href="${escapeHtml(o.url)}" target="_blank" rel="noopener noreferrer" title="Opens the ${escapeHtml(o.label)} chat in a new tab (you need to be signed in)"${primary ? ' style="font-weight:600;"' : ''}>${escapeHtml(o.label)} chat &#8599;</a>`;
}

// One row of every available chat link, the live one first and bold, for the
// connection card. Empty string when there is nothing to open.
function chatLinksRowHtml(c) {
const options = chatOptions(c);
const live = chatTarget(c).label;
const order = [live, 'Tinder', 'WhatsApp', 'Telegram'].filter((p, i, a) => p && a.indexOf(p) === i);
const links = order.filter((p) => options[p]).map((p) => linkHtml(options[p], p === live));
if (!links.length) return '';
return `<div class="chat-links" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:6px 0 0;"><span class="settings-note" style="margin:0;">Continue the chat:</span>${links.join('')}</div>`;
}

export { liveChat, waDigits, chatOptions, chatTarget, chatLinksRowHtml, linkHtml };
