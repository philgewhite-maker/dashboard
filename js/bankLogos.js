// A pre-fetched set of real UK bank/card provider app icons, sourced
// from each provider's own Google Play Store listing (the same
// play-lh.googleusercontent.com CDN, the same technique the user's own
// example URL used) -- gathered 2026-09-05 by visiting each app's own
// detail page and reading its `img[itemprop="image"][alt="Icon image"]`
// element directly. NOT the wide (416x235) thumbnail Play's own search-
// results GRID shows -- confirmed live that grid thumbnail is a
// different, non-square promotional image on a different id, not the
// app's actual icon.
//
// Every URL keeps the EXACT size suffix (`=w240-h480-rw`) it was
// actually captured at, live-verified to load -- confirmed the hard way:
// Google's image CDN does NOT reliably serve every id at an arbitrary
// re-requested size ("=s96-rw" 404'd for some ids that loaded fine at
// their own captured suffix, Halifax's among them), so this is NOT a
// safe thing to normalise after the fact. The actual pixels returned
// are square (240x240) regardless of the misleading w/h params, and
// .account-badge-logo's object-fit:cover crops any of these into
// whatever badge size/shape is asked for anyway. Hotlinked, same as any
// account's own manually pasted logoUrl -- never downloaded or
// re-hosted here, see blankFinanceAccount's own comment in state.js.
//
// `names` is every alias worth matching a typed bank name against
// (official name, common short form, the parent group where accounts
// are commonly opened under a sub-brand). Add more providers/aliases
// here as they come up -- this is a starting set of the most common UK
// current-account/credit-card providers, not exhaustive. If you add
// one, verify the URL actually loads before committing it (see this
// file's own history for why -- a search-RESULTS-grid thumbnail is a
// different, non-square promo image, not the real icon; always read
// `img[itemprop="image"][alt="Icon image"]` from the app's own detail
// page, and load-test the exact URL before trusting it).
function iconUrl(id) {
return `https://play-lh.googleusercontent.com/${id}=w240-h480-rw`;
}

const BANK_LOGOS = [
{ names: ['Barclays'], logoUrl: iconUrl('W-tmZQEPmkceQQLFbjV6AL7s9meevYskj26HT4uzLRGJdDKWkqx1SzSAciCWDU3qHAUWytiMpZr5vB4AfhQs') },
{ names: ['Barclaycard'], logoUrl: iconUrl('VZ7jgbWXwn4l-G_NPMl9N5orM9KSP5OGazQ7B5JNdOLPg8FEbo-bgtCJgsl5E3x0zWUYXrcy-IR_tUIs0iqH') },
{ names: ['HSBC'], logoUrl: iconUrl('5Pa7F69DH7QIik_uHscujDVY1zg-sWnp5WbXpMYa2ar7nHs7S2h4J2qNstCIyhA9-s_RuJ5Lz6z1wgMmWJgA') },
{ names: ['Lloyds', 'Lloyds Bank'], logoUrl: iconUrl('UYjNbnqTRrjm0lUEutey90OJ24fbBmKE1BDoPwj0QZJbJ0NCzx_jyzHR7apU0PxDBApdp0rcX2hUZQ4eBnFy') },
{ names: ['NatWest'], logoUrl: iconUrl('9BG1TPRAA2cDGj6AiQmS6KKTMS9CmEBIOSe00YBwvG8Bds9nNYFKmGSv2KoDLRRNpHOK0Vvb4TZ3Pa5C8TF_p6o') },
{ names: ['Halifax'], logoUrl: iconUrl('hhSvzpC-_u125JCTCOCAMvSKzrDkTXW9bRHf-8QIlKzZ4XOHlbQaNsSgsqpbGqhM5xw4qpjqwwfL4lea-mITNQ') },
{ names: ['Santander'], logoUrl: iconUrl('JvcfMNe-C2CVR6HFPdfum24b9M4hi4tyJdT8FdaC0NlS4DtJwez1sOxxmwqwM2SUORrjar-Wux22BTpc_4ULnA') },
{ names: ['Nationwide', 'Nationwide Building Society'], logoUrl: iconUrl('At-aQ-Nn1QqVJOjZIO6P7F1_-cl6eeVkcFVYDkXRWvZN-n0gVX7UND7_midpsN7Q8_SI-mxZNcf_l0Z-z1H1Wg') },
{ names: ['TSB'], logoUrl: iconUrl('1BSYgkiGDjvr-s-tC8U0vMiQKnI2D8mwfj7AgVPWuU10Z8raIKoRNngcPC4pOr1YotHYCDgmyrPy4xRyGd01Qj4') },
{ names: ['Monzo'], logoUrl: iconUrl('2S7rGRzx4bBnN0M1vGHIDBGI8SnSg2G_dShvpNjsDqdffWrGd99icCDXCnM1EVF-vy43gFjKjimZWGQ741UT_A') },
{ names: ['Starling', 'Starling Bank'], logoUrl: iconUrl('kydNWOPnfzQxOJziuvSeGtugGh2FfKhIoHJsmsN2-FMv5jLH1U2IYLwQT2VGqvngu5uWIonLcrHvcFTAbkZs') },
{ names: ['Chase', 'Chase UK'], logoUrl: iconUrl('dwRr8hNT8qcKTRsBLL8XkYcJ38tkpGwO2d8japj8fZklJ8Mr6jRkkTcLT_cgaXexlZElblTeRdNfZPHAt98bkg') },
{ names: ['Revolut'], logoUrl: iconUrl('LVmCH4DeBgO8Gyp69sApakf-KSy5Xf9ytV-NUmZnB2ZUKuIS0ee6cSACkalsLKuoQ1MorU7-0wW1xKZ6FUlS') },
{ names: ['Metro Bank'], logoUrl: iconUrl('hO-2uOaYvAIBAe4dRzQWHD8D4vyws9KTmoGyI5dl5n6b1011ph2hwtM022GDD0qtzL_GaEd_G_zqlKoggEeT') },
{ names: ['Co-operative Bank', 'Co-op Bank', 'Cooperative Bank'], logoUrl: iconUrl('9g8_7LfcbYV5X8iMfSiHa4cVHGgvXPEMilyNi0qVCJ4uSIToU6H2sxIdQ4PF3asHvsYYm62xO8N0u7iWgzo_WA') },
{ names: ['Virgin Money'], logoUrl: iconUrl('jXyjBHNIb_T3tfQbLik0tX6PtNzM3DugGA2L8C6TbG-ea9jz18qni7EXu7dhWItILHdYokKgO0DAwwyQ7mYexiI') },
{ names: ['Tesco Bank', 'Tesco'], logoUrl: iconUrl('_IwjzrsE0GBbjSajiEZlg0baZD8FtIrDGFivHE4qVyT6vjbxqzkKscix0pSos3JrJly_97zVeNyyLGgg_TSPsA') },
{ names: ['RBS', 'Royal Bank of Scotland'], logoUrl: iconUrl('rIyRwFvNGXDtrGT41MufCMgFd78zwVcKrhnUXIHZZjEHLe-h3lkXHWbw3eTh0ZtkRqWRnTRH_YzKptiuqo04_hA') },
{ names: ['Bank of Scotland', 'BOS'], logoUrl: iconUrl('srOLmoTWYkTmMVBiRsGwxrl3UTqeWH1M0HlZ4Vcod4XgfJiI6rsh62BB92STMe0pW13eS7IkiYAWLLrv6Df5') },
{ names: ['Capital One'], logoUrl: iconUrl('PdwILhu3K2yU9L3eVmswmnGb7IE6OVaW4fX9JYTlS2_b0Lyp8gSmPDf4X4nxRz55o5M1ShlHpFEt8a5W30WGWBo') },
{ names: ['M&S Bank', 'M&S', 'Marks and Spencer'], logoUrl: iconUrl('-Sx2_3SAnm-_Y0Wjjlg_Yt_zwvmC8-5a29oxKROoSGGAwObXcsxAzajRLpmZu74dJcDycVr-i9-Y89zOdS5kFw') },
{ names: ['First Direct', 'first direct'], logoUrl: iconUrl('M2ceGMTdV8bFmcZ_DgCFPutx1cQSUravIYUs5ZiXIomwjp01AB6EFYzaAXRLLX6vR3lgrFxaqgdm8oQyK6tdlYA') },
{ names: ['American Express', 'Amex'], logoUrl: iconUrl('xXfspeItmkuQFnlvuTDQ-92-Xa8HulueztKPhCqsRDEatFt3JbQuzj8yoTL9D1tpoFsKeFYYN8TtYu3oDQ4') },
];

// Exact match (case-insensitive) first, then a partial/substring match
// either direction -- same shape as googlecalendar.js's own
// resolveCalendarId(), so "Halifax" matches the "Halifax" entry exactly
// and "Halifax Reward Current Account" (the account's own name, not
// its bank field, if someone typed it there instead) still matches via
// the substring fallback.
function matchBankLogo(bankName) {
const q = String(bankName || '').trim().toLowerCase();
if (!q) return null;
const exact = BANK_LOGOS.find((entry) => entry.names.some((n) => n.toLowerCase() === q));
if (exact) return exact.logoUrl;
const partial = BANK_LOGOS.find((entry) => entry.names.some((n) => q.includes(n.toLowerCase()) || n.toLowerCase().includes(q)));
return partial ? partial.logoUrl : null;
}

export { BANK_LOGOS, matchBankLogo };
