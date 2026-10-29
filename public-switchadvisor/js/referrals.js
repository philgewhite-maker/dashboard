import { getReferralInfo } from './api.js';
import { REFERRALS, isSetUp } from './config.js';
import { escapeHtml } from './utils.js';

function providerRowHtml(p) {
  const isPlaceholder = !isSetUp(p.url);
  return `<div class="referral-row">
    <div class="rec-head"><span class="rec-bank">${escapeHtml(p.name)}</span></div>
    <div class="rec-rationale">${escapeHtml(p.note)}</div>
    ${isPlaceholder
      ? '<div class="rec-rationale muted">Referral link not set up yet.</div>'
      : `<a class="rec-link" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">Open &rarr;</a>`}
  </div>`;
}

export async function renderReferrals() {
  const mount = document.getElementById('referrals-list');
  if (!mount) return;
  mount.innerHTML = Object.values(REFERRALS).map(providerRowHtml).join('');
  const krakNote = document.getElementById('krak-tiers-note');
  if (krakNote) {
    try {
      const { krakTiers, krakSalaryMin, krakTiersAsOf, krakTiersSource } = await getReferralInfo();
      if (krakTiers?.length) {
        const tiers = krakTiers.map((t) => `${t.name ? `${t.name} ` : ''}£${Number(t.minBalance).toLocaleString('en-GB')}+ → ${t.percent}%`).join(' · ');
        // Shows the source text as written (it says whether the figures
        // were read by hand or scraped, and from where) rather than
        // inferring a label from it -- the percentages are of each salary
        // PAYMENT, and the tier comes from your average balance.
        krakNote.textContent = `Krak Salary Match — a percentage of each salary payment${krakSalaryMin ? ` (needs £${Number(krakSalaryMin).toLocaleString('en-GB')}+ a month paid in)` : ''}, tier set by your average balance, as of ${krakTiersAsOf || 'unknown'}: ${tiers}. ${krakTiersSource || ''}`.trim();
      }
    } catch { /* non-essential context line */ }
  }
}
