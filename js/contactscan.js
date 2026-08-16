// Finds phone numbers and social-media handles inside free text pulled from
// a dating profile or chat — the same shapes turn up in a bio, a prompt
// answer, or a chat message, on Tinder today and presumably Bumble/Hinge
// later, so this is deliberately generic: feed it any block of text, get
// back what it found, and the caller decides what to do with it. Findings
// are only ever a starting point for a human to confirm — same rule as
// chat-message attribution elsewhere in this app, since a false-positive
// number or handle is a much smaller mistake than one applied unreviewed.

// UK mobile shapes: 07xxx xxxxxx, +44 7xxx xxxxxx, 0044 7xxx xxxxxx — with
// or without spaces/dashes between the groups. Written by hand rather than
// relying on the general pattern below for the one country a bare local
// "07..." number (no +44, no country code visible at all) needs to match.
const UK_PHONE_RE = /(?:\+44\s?7\d{3}|0044\s?7\d{3}|\b07\d{3})[\s-]?\d{3}[\s-]?\d{3}\b/g;
// Everyone else: a leading "+" is specific enough to a real phone number
// (confirmed live: missed "+380962515141", a Ukrainian mobile, since only
// UK shapes were ever recognised) that a loose digit-count check covers
// it, rather than hand-listing every country's own grouping the way the
// UK pattern above does for just one. 8-15 digits is the real-world range
// for a country code plus subscriber number (E.164's own upper bound).
const INTL_PHONE_RE = /\+\d[\d\s-]{6,19}\d/g;

function findPhoneNumbers(text) {
const seen = new Set();
const out = [];
const str = String(text || '');
for (const m of [...str.matchAll(UK_PHONE_RE), ...str.matchAll(INTL_PHONE_RE)]) {
const digits = m[0].replace(/\D/g, '');
if (digits.length < 8 || digits.length > 15) continue;
if (seen.has(digits)) continue;
seen.add(digits);
out.push(m[0].trim());
}
return out;
}

// A platform named explicitly ("insta: janedoe", "snap @jane.doe") is a
// much stronger signal than a bare @handle — it says which app, not just
// that something handle-shaped is there — so it's tried first and wins
// when the same handle also shows up bare elsewhere in the same text.
const PLATFORM_WORDS = {
insta: 'Instagram', instagram: 'Instagram', ig: 'Instagram',
snap: 'Snapchat', snapchat: 'Snapchat',
whatsapp: 'WhatsApp', wa: 'WhatsApp',
telegram: 'Telegram', tg: 'Telegram',
twitter: 'Twitter/X', x: 'Twitter/X',
tiktok: 'TikTok',
};
// Requires a real separator (":" or "@") right after the platform word, not
// just any following word — "insta: janedoe" and "ig @janedoe" should
// match, but "my ig is great" shouldn't grab "is" as someone's handle.
const PLATFORM_RE = new RegExp(`\\b(${Object.keys(PLATFORM_WORDS).join('|')})\\b\\s*[:@]\\s*([a-zA-Z0-9_.]{2,30})`, 'gi');

// A bare @handle with no platform named — still worth surfacing, just with
// no platform guess attached. The lookbehind stops this matching the tail
// of an email address ("jane@gmail.com" has a word character right before
// the @; a real handle mention almost never does).
const BARE_HANDLE_RE = /(?<![\w.])@([a-zA-Z0-9_.]{2,30})\b/g;

function findHandles(text) {
const str = String(text || '');
const seen = new Set();
const out = [];
for (const m of str.matchAll(PLATFORM_RE)) {
const handle = m[2];
const key = handle.toLowerCase();
if (seen.has(key)) continue;
seen.add(key);
out.push({ platform: PLATFORM_WORDS[m[1].toLowerCase()], handle });
}
for (const m of str.matchAll(BARE_HANDLE_RE)) {
const handle = m[1];
const key = handle.toLowerCase();
if (seen.has(key)) continue;
seen.add(key);
out.push({ platform: null, handle });
}
return out;
}

// One readable line for a tag chip: "janedoe123 (Instagram)" or, with no
// platform guessed, just "janedoe123".
function formatHandle(h) {
return h.platform ? `${h.handle} (${h.platform})` : h.handle;
}

export { findPhoneNumbers, findHandles, formatHandle };
