// A pre-fetched set of real travel/retail/payment brand app icons,
// sourced from each provider's own Google Play Store listing -- same
// exact technique and the same play-lh.googleusercontent.com CDN as
// bankLogos.js (BANK_LOGOS), kept as a SEPARATE file rather than
// merged into that one: different curation domain (loyalty/voucher
// providers, not banks), and bankLogos.js's own exports are already
// shipped/imported elsewhere -- no reason to touch them.
//
// Gathered 2026-10-18 the same way bankLogos.js documents: visited
// each app's own Play Store detail page and read its
// `img[itemprop="image"][alt="Icon image"]` element directly (NOT the
// wide search-results-grid thumbnail, which is a different, non-square
// promotional image), then verified every URL here actually returns a
// real image (200, image/webp) before committing it.
//
// Mastercard has no single flagship consumer app -- it's a card
// network, not an app publisher -- so this one is sourced from
// "Mastercard Digital Concierge" (com.mastercard.digitalconcierge),
// the closest officially-published app carrying the plain circles
// mark; its icon also bakes in the word "concierge" under the mark,
// which .account-badge-logo's object-fit:cover may or may not crop out
// depending on badge size -- flagged here rather than silently assumed
// fine.
function iconUrl(id) {
return `https://play-lh.googleusercontent.com/${id}=w240-h480-rw`;
}

const BRAND_LOGOS = [
{ names: ['British Airways', 'British Airways Executive Club', 'BA'], logoUrl: iconUrl('3pgRRA6P2XXcmqaTiNBVi1Znc176FOr09rZChTdsqcQw-Qy9YDh0heJOUQeg5ri2yoGrbNFoGaZz6Daoc04WkQ') },
{ names: ['Marriott Bonvoy', 'Marriott'], logoUrl: iconUrl('BXC7DufPjS1Oc7x7TDY3QyHfrkq-MQpSUHyuCsb1_PhY2aju4OAyZtmdPWJXoCTIQr-3t06y-jTGH4WcbYJvYQ') },
{ names: ['Virgin Atlantic', 'Virgin Flying Club', 'Virgin'], logoUrl: iconUrl('Zp4MS0HwivSwovGY6Lyv9i0xpbLcz-7xI6ZOLu8AFasats_GXF5KI_x3K6tjFZfWp_lraePif-qLZIXEZrFC') },
{ names: ['Tesco', 'Tesco Clubcard'], logoUrl: iconUrl('UJiliy4e4STktLsmct2a3hjXA4O1Swl5h0RVSOUoXLnGw6tNA3FNM1V1TKVhTOod9ZmDYixSe_iRFuryHCsrAg') },
{ names: ['Boots', 'Boots Advantage Card'], logoUrl: iconUrl('iG3tJfDkPrtDrcFEC4_vvdWimfHIaSLqjf-ll--33LzGt0_0Vi6M9s2UqSa5NYSEyv0m7Sp2oZwBeDoz7Tkq') },
{ names: ['Hertz', 'Hertz Gold Plus Rewards'], logoUrl: iconUrl('QC8Af5GvLRvfBYc-XHkN6S6DJC_w7W8GgVN6elZMY8USWLFGcViNe37C7NgiQI5aBE8T2B-tiG_ocdNHIhn4') },
{ names: ['Sixt', 'SIXT ONE'], logoUrl: iconUrl('dirhuxbXhFds-2TQEw51a2M66bDwtP_DdshPFk8yjNHYIy_AJF5oN3pZkG4kgF08wW2qRpucdWZAHg5cL9Mqmw') },
{ names: ['Miles & More', 'Miles and More'], logoUrl: iconUrl('xxOFyyrIEh4SFSidEekBEGkUYyCqL0lFnzryRib1BtXFO1ntNg4F_PLdySnCOk2X08-SY3vR8JEZWaLhPbnQ') },
{ names: ['Airbnb'], logoUrl: iconUrl('PDPmzZUDSmFa33PmzoZ_OWLeIbj23UtGFE9fXVEVjfuyMGvPygT-v9N7bFsJwc8PojCmw72i8Xn45qHElm8b') },
{ names: ['Mastercard'], logoUrl: iconUrl('hXzjxehVU5aOtGvIvcwVOgUsqQv16U0vIVJRhIz4HUtBcn1-Lu229OXmmSVdRv6Y3taFWj4CBD5lhSeovmnXdA') },
{ names: ['Quidco'], logoUrl: iconUrl('7qUaKxz8H2MfUs0ytJVXFtgfkcaxf4FCu1_dJj1dTadJ6avFF6hUcB5LMP4Myeq5NQ3ybvyGf4WBsND8mlTZDw') },
{ names: ['TopCashback'], logoUrl: iconUrl('svaX1_2RqipFdQdY5kuvXxFAN9-ijDULI6sSZpNRISqyZQ68g788kjXSeZC91WllbyycUt3FJ7qOgS-47x0zHw') },
];

// Exact match (case-insensitive) first, then a partial/substring match
// either direction -- identical shape to bankLogos.js's matchBankLogo()
// and googlecalendar.js's resolveCalendarId(), so "Marriott" matches
// "Marriott Bonvoy" via the substring fallback and a program's own full
// name still matches its own alias exactly.
function matchBrandEntry(name) {
const q = String(name || '').trim().toLowerCase();
if (!q) return null;
const exact = BRAND_LOGOS.find((entry) => entry.names.some((n) => n.toLowerCase() === q));
if (exact) return exact;
const partial = BRAND_LOGOS.find((entry) => entry.names.some((n) => q.includes(n.toLowerCase()) || n.toLowerCase().includes(q)));
return partial || null;
}
function matchBrandLogo(name) {
return matchBrandEntry(name)?.logoUrl || null;
}

export { BRAND_LOGOS, matchBrandLogo, matchBrandEntry };
