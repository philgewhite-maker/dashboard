// The shared "Provider" picker used by Vouchers, Loyalty balances and
// Subscriptions: a datalist of every provider already in use (plus the
// known brands), free text allowed, and whatever is typed is folded onto
// ONE canonical name -- "BA" and "British Airways eVoucher" both become
// "British Airways" (brandLogos.js's alias table), and a name typed with
// different capitalisation reuses the spelling already saved. The part
// left over after the brand ("eVoucher", "Executive Club") is the
// "what of", kept in its own field so one provider can hold Avios, an
// eVoucher and a Companion Voucher side by side.
import { data } from './state.js';
import { BRAND_LOGOS, splitProvider } from './brandLogos.js';
import { escapeHtml } from './utils.js';

const WHAT_SUGGESTIONS = ['Avios', 'eVoucher', 'Companion Voucher', 'Points', 'Miles', 'Cashback', 'Gift card'];

function allProviderNames() {
const seen = new Map();
const add = (n) => { const t = String(n || '').trim(); if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t); };
BRAND_LOGOS.forEach((e) => add(e.names[0]));
(data.vouchers || []).forEach((v) => add(v.provider));
(data.loyaltyPrograms || []).forEach((p) => add(p.provider));
(data.subscriptions || []).forEach((s) => add(s.provider));
return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

function allWhatValues() {
const seen = new Map();
const add = (n) => { const t = String(n || '').trim(); if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t); };
WHAT_SUGGESTIONS.forEach(add);
(data.vouchers || []).forEach((v) => add(v.what));
(data.loyaltyPrograms || []).forEach((p) => add(p.what));
return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

// Typed text -> { provider, logoUrl, what }. `what` is only the part
// peeled off the end of a recognised brand ("British Airways eVoucher"
// -> "eVoucher"); empty when the text was just the provider.
function resolveProvider(text) {
const t = String(text || '').trim();
if (!t) return { provider: '', logoUrl: '', what: '' };
const hit = splitProvider(t);
if (hit) return hit;
const existing = allProviderNames().find((n) => n.toLowerCase() === t.toLowerCase());
// A brand-new name typed all in lower case gets capitalised once, so
// "netflix" and "Netflix" never end up as two providers.
const tidy = t === t.toLowerCase() ? t.replace(/(^|\s)(\S)/g, (m, sp, c) => sp + c.toUpperCase()) : t;
return { provider: existing || tidy, logoUrl: '', what: '' };
}

function providerDatalistHtml() {
return `<datalist id="taglist-provider">${allProviderNames().map((n) => `<option value="${escapeHtml(n)}">`).join('')}</datalist>`
+ `<datalist id="taglist-what">${allWhatValues().map((n) => `<option value="${escapeHtml(n)}">`).join('')}</datalist>`;
}

// One shared pair of datalists for every panel -- index.html's static
// forms point at these ids, and each render keeps them current.
function refreshProviderDatalists() {
let host = document.getElementById('provider-datalists');
if (!host) { host = document.createElement('div'); host.id = 'provider-datalists'; host.hidden = true; document.body.appendChild(host); }
host.innerHTML = providerDatalistHtml();
}

export { resolveProvider, allProviderNames, allWhatValues, refreshProviderDatalists };
