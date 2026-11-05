// Settings -> Finances -> Providers: the one registry of companies named on
// vouchers, loyalty programs, subscriptions and bank accounts (data.providers,
// linked by providerId; see js/migrations.js linkProviders). Rename changes
// the name everywhere it is used; merge moves every record onto another
// provider and keeps the old name as an alias, so typing it again resolves.
import { data, queueSave } from '../state.js';
import { escapeHtml, logoBadgeHtml, bindLogoFallbacks } from '../utils.js';
import { linkProviders, PROVIDER_FIELDS } from '../migrations.js';
import { voucherChipHtml, bindVoucherChips } from './vouchers.js';

const KIND_LABEL = { vouchers: ['voucher', 'vouchers'], loyaltyPrograms: ['loyalty program', 'loyalty programs'], subscriptions: ['subscription', 'subscriptions'], financeAccounts: ['bank account', 'bank accounts'] };
// Where each kind of record lives, for the "used by" links.
const KIND_GOTO = { loyaltyPrograms: ['finances', '#loyalty-balances-panel'] };

function usesOf(p) {
  const out = {};
  PROVIDER_FIELDS.forEach(([list]) => { out[list] = (data[list] || []).filter((r) => r.providerId === p.id); });
  return out;
}

function initials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
}

function usedByHtml(uses) {
  const parts = [];
  if (uses.vouchers.length) parts.push(uses.vouchers.map((v) => voucherChipHtml(v)).join(' '));
  // A subscription or account links to its own row; a loyalty program to its panel.
  ['subscriptions', 'financeAccounts'].forEach((list) => uses[list].forEach((r) => {
    const label = list === 'financeAccounts' ? [r.bank, r.name].filter(Boolean).join(' ') : r.name;
    parts.push(`<span class="airuns-link" data-provider-open="${list}:${escapeHtml(r.id)}" title="Open this ${KIND_LABEL[list][0]}">${escapeHtml(label || KIND_LABEL[list][0])}</span>`);
  }));
  if (uses.loyaltyPrograms.length) {
    const [tab, target] = KIND_GOTO.loyaltyPrograms;
    parts.push(uses.loyaltyPrograms.map((r) => `<span class="inline-goto-link" data-goto-tab="${tab}" data-goto-target="${target}">${escapeHtml(r.name)}</span>`).join(' '));
  }
  return parts.length ? parts.join(' · ') : '<span class="settings-note" style="margin:0;">Not used by anything</span>';
}

function renderProvidersSettings() {
  const host = document.getElementById('providers-settings');
  if (!host) return;
  if (linkProviders(data).created) queueSave();
  const providers = [...(data.providers || [])].sort((a, b) => a.name.localeCompare(b.name));
  if (!providers.length) { host.innerHTML = '<div class="empty">No providers yet. They appear as you name one on a voucher, program, subscription or account.</div>'; return; }
  host.innerHTML = providers.map((p) => {
    const uses = usesOf(p);
    const total = Object.values(uses).reduce((n, l) => n + l.length, 0);
    const others = providers.filter((x) => x.id !== p.id);
    return `<div class="provider-row" data-provider-row="${escapeHtml(p.id)}">
<div class="sync-row" style="align-items:flex-start;flex-wrap:wrap;gap:6px;">
${logoBadgeHtml(p.logoUrl, initials(p.name), 'plum')}
<input type="text" autocomplete="off" class="settings-input" data-provider-field="name" data-provider-id="${escapeHtml(p.id)}" value="${escapeHtml(p.name)}" style="max-width:200px;" title="Rename: changes it on everything that uses it">
<input type="text" autocomplete="off" class="settings-input" data-provider-field="logoUrl" data-provider-id="${escapeHtml(p.id)}" value="${escapeHtml(p.logoUrl || '')}" placeholder="Logo URL (optional)" style="flex:1;min-width:160px;">
<select class="settings-input" data-provider-merge="${escapeHtml(p.id)}" style="max-width:200px;" title="Move everything onto another provider">
<option value="">Merge into…</option>
${others.map((o) => `<option value="${escapeHtml(o.id)}">${escapeHtml(o.name)}</option>`).join('')}
</select>
${total ? '' : `<button class="sync-btn sm inline" type="button" data-provider-remove="${escapeHtml(p.id)}">Remove</button>`}
</div>
<div class="provider-uses">${usedByHtml(uses)}${(p.aliases || []).length ? ` <span class="settings-note" style="margin:0;">Also known as: ${p.aliases.map(escapeHtml).join(', ')}</span>` : ''}</div>
</div>`;
  }).join('');
  bindLogoFallbacks(host);
  bindVoucherChips();
}

// Rewrites the displayed name on every record linked to the provider.
function rewriteLinked(providerId, name) {
  PROVIDER_FIELDS.forEach(([list, field]) => (data[list] || []).forEach((r) => {
    if (r.providerId === providerId) r[field] = name;
  }));
}

function rerenderUsers() {
  import('./vouchers.js').then((m) => m.renderVouchers && m.renderVouchers()).catch(() => {});
  import('./subscriptions.js').then((m) => m.renderSubscriptions && m.renderSubscriptions()).catch(() => {});
  import('./loyaltybalances.js').then((m) => m.renderLoyaltyBalances && m.renderLoyaltyBalances()).catch(() => {});
  import('./financeaccounts.js').then((m) => m.renderFinanceAccounts && m.renderFinanceAccounts()).catch(() => {});
}

function initProvidersSettings() {
  renderProvidersSettings();
  document.getElementById('providers-settings-item')?.addEventListener('toggle', (e) => { if (e.target.open) renderProvidersSettings(); });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (t.dataset.providerField) {
      const p = (data.providers || []).find((x) => x.id === t.dataset.providerId);
      if (!p) return;
      const value = t.value.trim();
      if (t.dataset.providerField === 'name') {
        if (!value || value === p.name) { t.value = p.name; return; }
        // The old name stays as an alias, so a scan or a typed entry using it
        // still lands on this provider.
        if (!(p.aliases || []).includes(p.name)) p.aliases = [...(p.aliases || []), p.name];
        p.aliases = p.aliases.filter((a) => a !== value);
        p.name = value;
        rewriteLinked(p.id, value);
      } else p.logoUrl = value;
      queueSave();
      renderProvidersSettings();
      rerenderUsers();
      return;
    }
    if (t.dataset.providerMerge && t instanceof HTMLSelectElement && t.value) {
      const from = (data.providers || []).find((x) => x.id === t.dataset.providerMerge);
      const into = (data.providers || []).find((x) => x.id === t.value);
      if (!from || !into) return;
      if (!confirm(`Merge "${from.name}" into "${into.name}"? Everything using ${from.name} will use ${into.name}.`)) { t.value = ''; return; }
      PROVIDER_FIELDS.forEach(([list, field]) => (data[list] || []).forEach((r) => {
        if (r.providerId === from.id) { r.providerId = into.id; r[field] = into.name; }
      }));
      into.aliases = [...new Set([...(into.aliases || []), from.name, ...(from.aliases || [])])].filter((a) => a !== into.name);
      if (!into.logoUrl && from.logoUrl) into.logoUrl = from.logoUrl;
      data.providers = data.providers.filter((x) => x.id !== from.id);
      queueSave();
      renderProvidersSettings();
      rerenderUsers();
    }
  });
  document.addEventListener('click', (e) => {
    const open = e.target instanceof Element ? e.target.closest('[data-provider-open]') : null;
    if (!open) return;
    const [list, id] = open.dataset.providerOpen.split(':');
    import('../tabs.js').then(({ switchTab }) => {
      switchTab('finances');
      if (list === 'subscriptions') import('./subscriptions.js').then((m) => m.revealSubscription(id));
      else import('./financeaccounts.js').then((m) => m.expandAccountRow(id));
    });
  });
  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-provider-remove]') : null;
    if (!btn) return;
    data.providers = (data.providers || []).filter((x) => x.id !== btn.dataset.providerRemove);
    queueSave();
    renderProvidersSettings();
  });
}

export { initProvidersSettings, renderProvidersSettings };
