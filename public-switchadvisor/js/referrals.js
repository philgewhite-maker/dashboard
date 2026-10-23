import { getReferralInfo } from './api.js';
import { escapeHtml } from './utils.js';

// Same provider-table idea as the dashboard's own affiliateLink()
// (js/utils.js) -- a provider -> referral-link table, so adding a 4th
// provider later is one line here, not new code. Fill in your own
// referral codes/links below; left as placeholders until then.
const PROVIDERS = [
  { label: 'TopCashback', url: 'https://www.topcashback.co.uk/ref/PUT-YOUR-CODE-HERE', note: 'Cashback on everyday spending — sign up free.' },
  { label: 'Quidco', url: 'https://www.quidco.com/raf/PUT-YOUR-CODE-HERE', note: 'Another cashback network — worth comparing a specific offer against TopCashback before clicking either.' },
  { label: 'Kraken (crypto exchange)', url: 'https://kraken.com/r/PUT-YOUR-CODE-HERE', note: 'Not a bank-switch bonus — see the Kraken row in Recommendations for the actual reward estimate.' },
];

function providerRowHtml(p) {
  const isPlaceholder = p.url.includes('PUT-YOUR-CODE-HERE');
  return `<div class="referral-row">
    <div class="rec-head"><span class="rec-bank">${escapeHtml(p.label)}</span></div>
    <div class="rec-rationale">${escapeHtml(p.note)}</div>
    ${isPlaceholder
      ? '<div class="rec-rationale muted">Referral link not set up yet.</div>'
      : `<a class="rec-link" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">Open &rarr;</a>`}
  </div>`;
}

export async function renderReferrals() {
  const mount = document.getElementById('referrals-list');
  if (!mount) return;
  mount.innerHTML = PROVIDERS.map(providerRowHtml).join('');
  const krakNote = document.getElementById('krak-tiers-note');
  if (krakNote) {
    try {
      const { krakTiers, krakTiersAsOf, krakTiersSource } = await getReferralInfo();
      if (krakTiers?.length) {
        const tiers = krakTiers.map((t) => `£${Number(t.minBalance).toLocaleString('en-GB')}+ → ${t.percent}%`).join(' · ');
        // Never state these as flat fact -- krakTiersSource says whether
        // a real scrape has ever confirmed them (starts "scraped ...") or
        // they're still what was typed in at build time ("Seeded from
        // your own figures...", the plan's own explicit caveat).
        const unverified = !krakTiersSource || !krakTiersSource.toLowerCase().startsWith('scraped');
        krakNote.textContent = `Kraken's tiers (as of ${krakTiersAsOf || 'unknown'}): ${tiers}`
          + (unverified ? ' — not yet confirmed by a real scrape of Kraken\'s own terms page; treat as a starting estimate.' : ' — confirmed by the last scrape.');
      }
    } catch { /* non-essential context line */ }
  }
}
