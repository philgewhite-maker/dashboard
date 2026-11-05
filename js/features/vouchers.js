import { data, queueSave, blankVoucher } from '../state.js';
import { escapeHtml, bindForm, daysUntil, scrollAndFlash, logoBadgeHtml, bindLogoFallbacks } from '../utils.js';
import { renderLoyaltyBalances, pendingClassifications, pendingVoucherLinks, setLabelKind, markVoucherLinked, markVoucherSkipped, voucherWhatFor, VOUCHER_WHAT_BY_LABEL, CURRENCY_UNITS } from './loyaltybalances.js';
import { matchBrandLogo } from '../brandLogos.js';
import { resolveProvider, refreshProviderDatalists } from '../providers.js';
import { VOUCHER_UNITS } from '../migrations.js';

const VOUCHER_TYPES = ['Voucher', 'Credit', 'Cheque', 'Refund', 'Other'];

// A voucher's worth is a number and a unit, not free text. `value` is kept as
// the display text built from them, for anything that still reads it.
const UNIT_LABELS = { GBP: '£', EUR: '€', points: 'points', Avios: 'Avios', miles: 'miles', nights: 'nights', other: 'other' };
function voucherValueText(v) {
if (v.amount == null || v.amount === '') return v.unit ? '' : (v.value || '');
const n = Number(v.amount);
if (v.unit === 'GBP' || v.unit === 'EUR') return `${UNIT_LABELS[v.unit]}${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = n.toLocaleString('en-GB');
return v.unit && v.unit !== 'other' ? `${num} ${v.unit}` : num;
}
// A loyalty reading's own unit, as one of the voucher units.
const READING_UNIT_MAP = { '£': 'GBP', '€': 'EUR', Avios: 'Avios', points: 'points', 'status points': 'points', miles: 'miles' };
function unitFromReading(reading) {
if (!reading.unit) return '';
return READING_UNIT_MAP[reading.unit] || 'other';
}
function setAmountFromReading(voucher, reading) {
if (reading.balance == null) return;
voucher.amount = reading.balance;
voucher.unit = unitFromReading(reading);
voucher.value = voucherValueText(voucher);
}
function unitSelectHtml(selected, attrs) {
return `<select ${attrs}><option value=""${!selected ? ' selected' : ''}>Unit</option>${VOUCHER_UNITS.map((u) => `<option value="${u}"${u === selected ? ' selected' : ''}>${escapeHtml(UNIT_LABELS[u])}</option>`).join('')}</select>`;
}

// The canonical voucher reference -- this record type had none until
// now (dashboard/CLAUDE.md's own Record-reference standards table
// didn't cover vouchers at all). Mirrors tripChipHtml/bindTripChips
// (travel.js) exactly -- same delegated click pattern, same switchTab →
// reveal → scroll-and-flash shape, just a voucher glyph instead of a
// plane.
function voucherChipHtml(voucher, extraHtml = '') {
return `<span class="voucher-chip" data-open-voucher="${escapeHtml(voucher.id)}">&#127903; ${escapeHtml(voucher.name)}</span>${extraHtml}`;
}
function revealVoucher(id) {
import('../tabs.js').then(({ switchTab }) => {
switchTab('finances');
renderVouchers();
setTimeout(() => scrollAndFlash(`[data-voucher-row="${id}"]`), 60);
});
}
let voucherChipsBound = false;
function bindVoucherChips() {
if (voucherChipsBound) return;
voucherChipsBound = true;
document.addEventListener('click', (e) => {
const chip = e.target.closest('[data-open-voucher]');
if (!chip) return;
revealVoucher(chip.dataset.openVoucher);
});
}

// The reciprocal direction: a loyalty reading row (loyaltybalances.js)
// that linked to a voucher shows a chip back to it there; this reveals
// the READING from the voucher side. Doesn't import anything from
// loyaltybalances.js -- the Loyalty balances panel is already rendered
// as part of the normal Finance-tab wiring by the time this runs, same
// assumption revealTrip (travel.js) makes about its own tab's panels.
function revealLoyaltyReading(id) {
import('../tabs.js').then(({ switchTab }) => {
switchTab('finances');
setTimeout(() => scrollAndFlash(`[data-loyalty-reading="${id}"]`), 60);
});
}

// Ties expiry-urgency sorting (vouchers and, now, provider groups) to
// one definition -- blank expiry sorts last, same as "no date" always
// has throughout this app.
function expiryRank(v) {
if (v.used) return Number.MAX_VALUE; // spent ones sink below everything
return v.expiry ? daysUntil(v.expiry) : Infinity;
}

function voucherRowHtml(v) {
let badgeHtml = '';
if (v.used) {
badgeHtml = `<span class="expiry-badge">Used</span>`;
} else if (v.expiry) {
const dn = daysUntil(v.expiry);
if (dn < 0) {
badgeHtml = `<span class="expiry-badge expired">Expired</span>`;
} else if (dn <= 30) {
badgeHtml = `<span class="expiry-badge soon">${dn === 0 ? 'Expires today' : dn + 'd left'}</span>`;
} else {
badgeHtml = `<span class="expiry-badge">${dn}d left</span>`;
}
}
const vInitials = (v.provider || v.name || '?').trim().slice(0, 2).toUpperCase();
return `<div class="voucher-row${v.used ? " voucher-used" : ""}" data-voucher-row="${v.id}">
<div class="voucher-id" style="display:flex;gap:8px;align-items:flex-start;">
${logoBadgeHtml(v.logoUrl, vInitials, 'plum')}
<div style="flex:1 1 auto;min-width:0;">
<input type="text" autocomplete="off" class="voucher-edit voucher-name-edit" data-field="name" data-voucher-id="${v.id}" value="${escapeHtml(v.name)}">
<div class="voucher-meta">
<select class="voucher-edit voucher-type-edit" data-field="type" data-voucher-id="${v.id}">
${VOUCHER_TYPES.map((t) => `<option value="${t}" ${t === v.type ? 'selected' : ''}>${t}</option>`).join('')}
</select>
<input type="number" step="0.01" min="0" class="voucher-edit voucher-value-edit" data-field="amount" data-voucher-id="${v.id}" value="${v.amount ?? ''}" placeholder="${escapeHtml(v.amount == null && v.value ? v.value : 'Amount')}" title="${v.amount == null && v.value ? `Was typed as "${escapeHtml(v.value)}": enter the number and pick its unit` : 'How much it is worth'}" style="max-width:90px;">
${unitSelectHtml(v.unit || '', `class="voucher-edit voucher-unit-edit" data-field="unit" data-voucher-id="${v.id}" title="What the amount is in"`)}
</div>
</div>
</div>
<input type="text" autocomplete="off" class="voucher-edit voucher-notes-edit" data-field="notes" data-voucher-id="${v.id}" value="${escapeHtml(v.notes || '')}" placeholder="Notes">
<input type="text" autocomplete="off" class="voucher-edit voucher-provider-edit" list="taglist-provider" data-field="provider" data-provider-commit="${v.id}" data-voucher-id="${v.id}" value="${escapeHtml(v.provider || '')}" placeholder="Provider (optional)" title="Who the voucher is from. Pick one you already use or type a new one -- BA, British Airways and British Airways eVoucher all become the one name, with its logo.">
<input type="text" autocomplete="off" class="voucher-edit voucher-what-edit" list="taglist-what" data-field="what" data-voucher-id="${v.id}" value="${escapeHtml(v.what || '')}" placeholder="What of (Avios, eVoucher...)" title="What kind of thing it is under that provider -- Avios, an eVoucher, a Companion Voucher.">
<input type="text" autocomplete="off" class="voucher-edit voucher-reference-edit" data-field="reference" data-voucher-id="${v.id}" value="${escapeHtml(v.reference || '')}" placeholder="Reference (optional)" title="A voucher/booking reference, if it has one -- the loyalty-scan review matches on this to offer a confident 'Update' instead of risking a merge with an unrelated voucher.">
<div class="voucher-expiry">
<input type="date" class="voucher-edit expiry-date-edit" data-field="expiry" data-voucher-id="${v.id}" value="${escapeHtml(v.expiry || '')}">
${badgeHtml}
</div>
<div class="voucher-actions">
${(v.sourceLoyaltyReadingIds || []).length ? `<span class="tag-chip" data-open-loyalty-reading="${v.sourceLoyaltyReadingIds[v.sourceLoyaltyReadingIds.length - 1]}" title="Created or updated from a loyalty scan reading -- click to see it">from loyalty scan</span>` : ''}
<label class="settings-note" style="margin:0;display:inline-flex;align-items:center;gap:4px;cursor:pointer;" title="Tick once you have spent it or are finished with it"><input type="checkbox" data-voucher-used="${v.id}"${v.used ? " checked" : ""}> Used</label>
<span class="del-x" style="opacity:1;" data-del-voucher="${v.id}">&times;</span>
</div>
</div>`;
}

// Groups by provider so e.g. "British Airways" or "TopCashback" reads
// as one stripe with its vouchers nested inside, rather than scattered
// across the flat list -- reuses .account-card/.account-summary (the
// same wrapper financeaccounts.js's own accounts and loyaltybalances.js's
// own programs already use) rather than inventing a new grouped-list
// pattern. A voucher with no provider stays its own standalone row, not
// folded into a fake "no provider" group. Each group (and each
// standalone row) sorts into the SAME list by its own soonest expiry,
// so the whole list still reads most-urgent-first overall, just with
// same-provider vouchers clustered together instead of interleaved.
function groupedVouchersHtml(vouchers) {
const sorted = [...vouchers].sort((a, b) => expiryRank(a) - expiryRank(b));
const groups = new Map();
const blocks = [];
sorted.forEach((v) => {
const provider = (v.provider || '').trim();
if (!provider) { blocks.push({ soonest: expiryRank(v), html: voucherRowHtml(v) }); return; }
if (!groups.has(provider)) {
const block = { soonest: expiryRank(v), members: [v] };
groups.set(provider, block);
blocks.push(block);
} else {
groups.get(provider).members.push(v);
}
});
blocks.sort((a, b) => a.soonest - b.soonest);
return blocks.map((b) => {
if (b.html) return b.html; // standalone, no-provider row
const provider = b.members[0].provider.trim();
const logoUrl = b.members.find((v) => v.logoUrl)?.logoUrl || '';
const initials = provider.slice(0, 2).toUpperCase();
return `<div class="account-card voucher-group">
<div class="account-summary" style="cursor:default;">
${logoBadgeHtml(logoUrl, initials, 'plum')}
<strong>${escapeHtml(provider)}</strong>
<span class="settings-note" style="margin:0;">${b.members.length} voucher${b.members.length === 1 ? '' : 's'}</span>
</div>
${b.members.map(voucherRowHtml).join('')}
</div>`;
}).join('');
}

let usedFoldOpen = false; // whether the "Used" fold is open, kept across re-renders

function renderVouchers() {
renderVoucherReview();
const list = document.getElementById('vouchers-list');
const live = data.vouchers.filter((v) => !v.used);
const spent = data.vouchers.filter((v) => v.used);
document.getElementById('vouchers-count').textContent = `${live.length} ${live.length === 1 ? 'item' : 'items'}${spent.length ? ` · ${spent.length} used` : ''}`;
if (data.vouchers.length === 0) {
refreshProviderDatalists();
list.innerHTML = '<div class="empty">Nothing tracked yet. Add one below.</div>';
return;
}
refreshProviderDatalists();
// Used ones are history: folded away below the live list instead of greyed out among it.
list.innerHTML = (live.length ? groupedVouchersHtml(live) : '<div class="empty">Nothing active right now.</div>')
+ (spent.length ? `<details class="voucher-used-fold" style="margin-top:10px;"${usedFoldOpen ? ' open' : ''}><summary class="settings-note" style="cursor:pointer;">Used (${spent.length})</summary>${groupedVouchersHtml(spent)}</details>` : '');
const fold = list.querySelector('.voucher-used-fold');
if (fold) fold.addEventListener('toggle', () => { usedFoldOpen = fold.open; });

list.querySelectorAll('[data-field][data-voucher-id]').forEach((el) => {
el.addEventListener('change', () => {
const v = data.vouchers.find((x) => x.id === el.dataset.voucherId);
if (!v) return;
if (el.dataset.field === 'provider') {
// Folded onto the one canonical name (BA -> British Airways) with its
// logo; whatever was left over fills "what of" only if that is blank.
const r = resolveProvider(el.value);
v.provider = r.provider;
v.logoUrl = r.logoUrl || '';
if (r.what && !v.what) v.what = r.what;
} else if (el.dataset.field === 'amount') {
v.amount = el.value === '' ? null : Number(el.value);
v.value = voucherValueText(v);
} else if (el.dataset.field === 'unit') {
v.unit = el.value;
v.value = voucherValueText(v);
} else {
v[el.dataset.field] = el.value.trim();
}
renderVouchers();
queueSave();
});
});
list.querySelectorAll('[data-voucher-used]').forEach((cb) => {
cb.addEventListener('change', () => {
const v = data.vouchers.find((x) => x.id === cb.dataset.voucherUsed);
if (!v) return;
v.used = cb.checked;
renderVouchers();
queueSave();
});
});
list.querySelectorAll('[data-del-voucher]').forEach((el) => {
el.addEventListener('click', () => {
const doomed = data.vouchers.find((x) => x.id === el.dataset.delVoucher);
if (!confirm(`Delete ${doomed && doomed.name ? `"${doomed.name}"` : 'this voucher'}?`)) return;
data.vouchers = data.vouchers.filter((x) => x.id !== el.dataset.delVoucher);
// A loyalty reading that was confirmed into this voucher still said "linked"
// with a voucher id that no longer exists, so the scan never offered it
// again and the Loyalty card showed a chip to nothing. Put it back in the review queue.
const sources = new Set((doomed && doomed.sourceLoyaltyReadingIds) || []);
data.loyaltyBalances.forEach((b) => {
if (sources.has(b.id) && b.voucherLinkStatus === 'linked') b.voucherLinkStatus = '';
});
renderVouchers();
renderLoyaltyBalances();
queueSave();
});
});
list.querySelectorAll('[data-open-loyalty-reading]').forEach((el) => {
el.addEventListener('click', (e) => {
e.stopPropagation();
revealLoyaltyReading(el.dataset.openLoyaltyReading);
});
});
bindLogoFallbacks(list);
}

// ---- Review queue: loyalty-scan readings waiting on a human decision ----
// A reading lands here either because its (programId, label) pair has
// never been classified balance-vs-voucher at all, or because it's
// already classified 'voucher' and hasn't been linked to a voucher (or
// explicitly skipped) yet. This is a Vouchers-panel decision -- "is this
// a voucher" -- not a scanning one, so it lives here rather than on the
// Loyalty balances panel itself.
function matchVouchersForReading(reading, program) {
const byReference = reading.reference ? data.vouchers.filter((v) => v.reference && v.reference === reading.reference) : [];
const needle = (program?.name || '').toLowerCase();
const byNameOnly = needle ? data.vouchers.filter((v) => !byReference.includes(v) && v.name.toLowerCase().includes(needle)) : [];
return { byReference, byNameOnly };
}

// "eVoucher used": a notification that a voucher was spent. It has no value of its own, so it
// must mark the voucher used and never overwrite the amount it was issued for.
function isUsedEvent(reading) { return reading.balance == null && /\bused\b/i.test(reading.label); }

function readingValueText(reading) {
if (reading.balance == null) return /used/i.test(reading.label) ? 'Used' : '';
const money = CURRENCY_UNITS.has(reading.unit);
return `${money ? reading.unit : ''}${reading.balance.toLocaleString('en-GB', money ? { minimumFractionDigits: 2 } : undefined)}${reading.unit && !money ? ' ' + reading.unit : ''}`;
}

function readingSummaryText(reading) {
const parts = [reading.detail ? `${reading.label}: ${reading.detail}` : reading.label];
const value = readingValueText(reading);
if (value) parts.push(value);
parts.push(`on ${reading.date}`);
if (reading.expiryDate) parts.push(`expires ${reading.expiryDate}`);
if (reading.reference) parts.push(`ref ${reading.reference}`);
if (reading.note) parts.push(reading.note);
return parts.join(' — ');
}

// A name worth showing in the Vouchers list -- "Quidco: Agent
// Provocateur" reads far better than "Quidco: Cashback confirmed"
// repeated identically for every single retailer.
function voucherNameFor(program, reading) {
const what = VOUCHER_WHAT_BY_LABEL[reading.label];
if (what) return `${program.name} — ${what}${reading.detail ? ` (${reading.detail})` : ''}`;
return reading.detail ? `${program.name} — ${reading.detail}` : `${program.name} — ${reading.label}`;
}

// One row per (programId, label) group needing a balance-vs-voucher
// decision -- see pendingClassifications() for why this is deduped
// rather than one row per historical reading. Shows up to 3 recent
// sample readings (with dates) for context.
function classifyRowHtml(group) {
const key = `${group.programId}|${group.label}`;
const groupName = `voucher-classify-${escapeHtml(key)}`;
const samplesHtml = group.samples.map((r) => `<div style="font-size:11px;color:var(--muted);">${escapeHtml(r.date)} — ${escapeHtml(readingValueText(r) || '—')}</div>`).join('');
const moreCount = group.total - group.samples.length;
const moreNote = moreCount > 0 ? `<div style="font-size:11px;color:var(--muted);">+ ${moreCount} earlier reading${moreCount === 1 ? '' : 's'}</div>` : '';
return `<div class="candidate-row" data-classify-key="${escapeHtml(key)}">
<div class="pending-new-info">
<div><strong>${escapeHtml(group.program.name)}</strong> — ${escapeHtml(group.label)}</div>
${samplesHtml}
${moreNote}
<div style="font-size:11px;color:var(--muted);margin-top:4px;">New kind of reading — is this a running balance, or a voucher/credit event?</div>
</div>
<div class="pending-options">
<label class="pending-option"><input type="radio" name="${groupName}" value="balance" data-classify-key-radio="${escapeHtml(key)}" data-classify-program="${escapeHtml(group.programId)}" data-classify-label="${escapeHtml(group.label)}"><span class="pending-option-info">Running balance (points, miles, tier status…)</span></label>
<label class="pending-option"><input type="radio" name="${groupName}" value="voucher" data-classify-key-radio="${escapeHtml(key)}" data-classify-program="${escapeHtml(group.programId)}" data-classify-label="${escapeHtml(group.label)}"><span class="pending-option-info">Voucher / credit event</span></label>
</div>
</div>`;
}

function voucherLinkRowHtml(item, siblings) {
const { reading, program } = item;
const rid = reading.id;
const groupName = `voucher-review-${rid}`;
const header = `<div class="pending-new-info"><div><strong>${escapeHtml(program.name)}</strong> — ${escapeHtml(readingSummaryText(reading))}</div>`;
const { byReference, byNameOnly } = matchVouchersForReading(reading, program);
const hasReferenceMatch = byReference.length > 0;
const matchOptions = [
...byReference.map((v) => `<label class="pending-option"><input type="radio" name="${groupName}" value="update:${v.id}" data-review-link="${escapeHtml(rid)}" checked><span class="pending-option-info">Update "${escapeHtml(v.name)}" (ref ${escapeHtml(v.reference)}, currently ${escapeHtml(v.value || '—')}${v.expiry ? `, expires ${escapeHtml(v.expiry)}` : ''})</span></label>`),
...byNameOnly.map((v) => `<label class="pending-option"><input type="radio" name="${groupName}" value="update:${v.id}" data-review-link="${escapeHtml(rid)}"><span class="pending-option-info">Update "${escapeHtml(v.name)}" — same name, but its reference (${escapeHtml(v.reference || 'none')}) differs from this reading's (${escapeHtml(reading.reference || 'none')}) — check before confirming</span></label>`),
].join('');
return `<div class="candidate-row ambiguous" data-review-id="${escapeHtml(rid)}">
${header}</div>
<div class="pending-options">
${matchOptions}
<label class="pending-option">
<input type="radio" name="${groupName}" value="pick" data-review-link="${escapeHtml(rid)}">
<span class="pending-option-info">Different existing voucher&hellip;</span>
</label>
<div class="decision-pick" data-review-pick="${escapeHtml(rid)}" hidden>
<select data-review-pick-select="${escapeHtml(rid)}">
<option value="">Choose&hellip;</option>
${data.vouchers.map((v) => `<option value="${escapeHtml(v.id)}">${escapeHtml(v.name)}</option>`).join('')}
</select>
</div>
<label class="pending-option">
<input type="radio" name="${groupName}" value="new" data-review-link="${escapeHtml(rid)}" ${hasReferenceMatch ? '' : 'checked'}>
<span class="pending-option-info">Add as new voucher</span>
</label>
<label class="pending-option">
<input type="radio" name="${groupName}" value="skip" data-review-link="${escapeHtml(rid)}">
<span class="pending-option-info">Not a voucher &mdash; skip this one</span>
</label>
</div>
${siblings.length ? (() => {
// Same real value+unit across every sibling reads as "one thing
// reported again" (Hertz's free-day emails, which carry no amount
// at all) -- safe to default merging them on. ANY differing value
// (Quidco: a different retailer's cashback each time, confirmed
// live as a real case -- one single day produced 4 separate real
// amounts) means these are genuinely separate events, so the
// default flips to NOT merging them, rather than risking silently
// folding distinct money into one voucher.
const sameValue = siblings.every((s) => s.reading.balance === reading.balance && s.reading.unit === reading.unit);
return `<label class="pending-option" style="margin-top:6px;">
<input type="checkbox" data-review-apply-all="${escapeHtml(rid)}" ${sameValue ? 'checked' : ''}>
<span class="pending-option-info">Also apply this to the other ${siblings.length} unresolved "${escapeHtml(reading.label)}" reading${siblings.length === 1 ? '' : 's'} below ${sameValue ? '&mdash; tick off if some of these are genuinely separate, not the same one reported again' : '&mdash; these have DIFFERENT amounts, so this is probably wrong; only tick if they really are the same one reported again'}</span>
</label>`;
})() : ''}
<div class="sync-row" style="margin-top:6px;">
<button type="button" class="sync-btn sm inline" data-review-confirm="${escapeHtml(rid)}">Confirm</button>
</div>
</div>`;
}

// Resolves ONE voucher-shaped reading against an existing/new voucher
// -- the targeted voucher's value/expiry/reference/notes/source-id list
// all come from THIS reading. Used both for a single confirm and, once
// per sibling, for the "apply to all matching" bulk path below.
function applyUpdateToVoucher(reading, program, voucherId) {
const voucher = data.vouchers.find((v) => v.id === voucherId);
if (!voucher) return;
const usedEvent = isUsedEvent(reading);
if (!usedEvent) setAmountFromReading(voucher, reading);
if (usedEvent) voucher.used = true;
if (reading.expiryDate) voucher.expiry = reading.expiryDate;
if (reading.reference && !voucher.reference) voucher.reference = reading.reference;
// Backfills provider/logo onto a voucher that predates this field (or
// was added by hand with neither set) -- the real program name is an
// exact match, never a guess, so it's always worth filling in for
// free the moment a reading actually links to this voucher.
if (!voucher.provider) voucher.provider = program.provider || program.name;
if (!voucher.what) voucher.what = voucherWhatFor(program, reading);
if (!voucher.logoUrl) voucher.logoUrl = program.logoUrl || matchBrandLogo(voucher.provider) || '';
const note = `Updated from ${program.name} scan (${reading.date}): ${readingSummaryText(reading)}.`;
voucher.notes = voucher.notes ? `${voucher.notes} | ${note}` : note;
voucher.sourceLoyaltyReadingIds = [...(voucher.sourceLoyaltyReadingIds || []), reading.id];
markVoucherLinked(reading.id, voucher.id);
}

function applyVoucherLink(reading, program, decision, pickedId) {
if (decision === 'skip') { markVoucherSkipped(reading.id); return; }
const targetId = decision === 'pick' ? pickedId : decision.startsWith('update:') ? decision.slice(7) : '';
if (targetId) { applyUpdateToVoucher(reading, program, targetId); return; }
// decision === 'new' -- provider is the real program name (exact, no
// matching needed) and logoUrl comes free from it too, when seeded.
const voucher = blankVoucher({ name: voucherNameFor(program, reading), value: isUsedEvent(reading) ? '' : readingValueText(reading), used: isUsedEvent(reading), expiry: reading.expiryDate || '', notes: `From ${program.name} scan, ${reading.date}.${reading.note ? ` ${reading.note}` : ''}`, reference: reading.reference || '', sourceLoyaltyReadingIds: [reading.id], provider: program.provider || program.name, what: voucherWhatFor(program, reading), logoUrl: program.logoUrl || matchBrandLogo(program.provider || program.name) || '' });
if (!isUsedEvent(reading)) setAmountFromReading(voucher, reading);
data.vouchers.push(voucher);
markVoucherLinked(reading.id, voucher.id);
}

// "Apply to all": confirmed live as a real need -- Hertz's "free day
// earned" email gets re-sent for the SAME one day, repeatedly, not a
// fresh day each time, so a label with many pending siblings is more
// often one real thing reported many times than many real things. A
// 'new' decision still creates exactly ONE voucher (from the row that
// was actually confirmed); every sibling, including that row, is then
// folded into it via applyUpdateToVoucher, so N duplicate readings
// collapse into one voucher with an N-line history, not N vouchers.
function applyVoucherLinkToGroup(reading, program, decision, pickedId, allReadings) {
if (decision === 'skip') { allReadings.forEach((r) => markVoucherSkipped(r.id)); return; }
let targetId = decision === 'pick' ? pickedId : decision.startsWith('update:') ? decision.slice(7) : '';
if (!targetId) {
const voucher = blankVoucher({ name: voucherNameFor(program, reading), provider: program.provider || program.name, what: voucherWhatFor(program, reading), logoUrl: program.logoUrl || matchBrandLogo(program.provider || program.name) || '' });
data.vouchers.push(voucher);
targetId = voucher.id;
}
allReadings.forEach((r) => applyUpdateToVoucher(r, program, targetId));
}

// Tidies what earlier scans got wrong, then lets a "used" notification settle itself:
// - a voucher whose amount was overwritten with the word "Used" gets its amount back
//   from the reading that issued it, and is marked used;
// - an "eVoucher used" reading whose voucher number matches a voucher marks it used,
//   with no question asked.
function settleUsedVouchers() {
let changed = false;
data.vouchers.forEach((v) => {
if (v.value !== 'Used') return;
const issued = data.loyaltyBalances.filter((b) => b.reference && b.reference === v.reference && b.balance != null).sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0];
v.value = '';
if (issued) setAmountFromReading(v, issued);
v.used = true;
changed = true;
});
pendingVoucherLinks().forEach(({ reading, program }) => {
if (!isUsedEvent(reading) || !reading.reference) return;
const match = data.vouchers.find((v) => v.reference === reading.reference);
if (!match) return;
applyUpdateToVoucher(reading, program, match.id);
changed = true;
});
if (changed) queueSave();
}

function renderVoucherReview() {
const mount = document.getElementById('voucher-review-section');
if (!mount) return;
settleUsedVouchers();
const classifications = pendingClassifications();
const links = pendingVoucherLinks();
const total = classifications.length + links.length;
if (!total) { mount.innerHTML = ''; return; }
// Siblings: OTHER still-pending readings sharing this exact (program,
// label) pair, excluding the row's own reading -- feeds the "apply to
// all" checkbox/count on each row.
const siblingsFor = (item) => links.filter((x) => x.reading.id !== item.reading.id && x.reading.programId === item.reading.programId && x.reading.label === item.reading.label);
mount.innerHTML = `<div class="album-card" style="margin-bottom:10px;">
<div class="album-caption"><strong>${total} item${total === 1 ? '' : 's'}</strong> from loyalty scans need${total === 1 ? 's' : ''} a quick decision.</div>
${classifications.map(classifyRowHtml).join('')}
${links.map((item) => voucherLinkRowHtml(item, siblingsFor(item))).join('')}
</div>`;

mount.querySelectorAll('[data-classify-key-radio]').forEach((el) => {
el.addEventListener('change', () => {
if (!el.checked) return;
setLabelKind(el.dataset.classifyProgram, el.dataset.classifyLabel, el.value);
renderVoucherReview();
});
});
mount.querySelectorAll('[data-review-link]').forEach((el) => {
el.addEventListener('change', () => {
const picker = mount.querySelector(`[data-review-pick="${el.dataset.reviewLink}"]`);
if (picker) picker.hidden = el.value !== 'pick';
});
});
mount.querySelectorAll('[data-review-confirm]').forEach((el) => {
el.addEventListener('click', () => {
const rid = el.dataset.reviewConfirm;
const item = links.find((x) => x.reading.id === rid);
if (!item) return;
const decision = mount.querySelector(`input[name="voucher-review-${rid}"]:checked`)?.value || 'new';
const pickedId = decision === 'pick' ? (mount.querySelector(`[data-review-pick-select="${rid}"]`)?.value || '') : '';
if (decision === 'pick' && !pickedId) return; // nothing chosen yet -- Confirm does nothing until it is
const applyAll = mount.querySelector(`[data-review-apply-all="${rid}"]`)?.checked;
if (applyAll) {
// Oldest-first so the voucher's final value/expiry reflects the
// MOST RECENT reading (each pass in applyUpdateToVoucher overwrites
// the one before it) while the notes history still reads in order.
const group = [...siblingsFor(item), item].map((x) => x.reading).sort((a, b) => a.date.localeCompare(b.date));
applyVoucherLinkToGroup(item.reading, item.program, decision, pickedId, group);
} else {
applyVoucherLink(item.reading, item.program, decision, pickedId);
}
queueSave();
renderVouchers(); // re-renders the review section too (its own first line)
});
});
}

function initVoucherForm() {
bindForm('voucher-form', () => {
const nameInput = document.getElementById('voucher-name-input');
const typeInput = document.getElementById('voucher-type-input');
const valueInput = document.getElementById('voucher-value-input');
const unitInput = document.getElementById('voucher-unit-input');
const expiryInput = document.getElementById('voucher-expiry-input');
const notesInput = document.getElementById('voucher-notes-input');
const providerInput = document.getElementById('voucher-provider-input');
const name = nameInput.value.trim();
if (!name) return;
const resolved = resolveProvider(providerInput?.value || '');
const whatInput = document.getElementById('voucher-what-input');
const amount = valueInput.value.trim() === '' ? null : Number(valueInput.value);
const unit = unitInput ? unitInput.value : '';
data.vouchers.push(blankVoucher({
name,
type: typeInput.value,
amount: Number.isFinite(amount) ? amount : null,
unit,
value: voucherValueText({ amount: Number.isFinite(amount) ? amount : null, unit, value: '' }),
expiry: expiryInput.value,
notes: notesInput.value.trim(),
provider: resolved.provider,
what: (whatInput?.value || '').trim() || resolved.what,
logoUrl: resolved.logoUrl,
}));
if (whatInput) whatInput.value = '';
nameInput.value = '';
valueInput.value = '';
if (unitInput) unitInput.value = '';
expiryInput.value = '';
notesInput.value = '';
if (providerInput) providerInput.value = '';
renderVouchers();
queueSave();
});
bindVoucherChips();
}

export { renderVouchers, initVoucherForm, voucherChipHtml, bindVoucherChips };
