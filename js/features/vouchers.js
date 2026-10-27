import { data, queueSave, blankVoucher } from '../state.js';
import { escapeHtml, bindForm, daysUntil, scrollAndFlash, logoBadgeHtml, bindLogoFallbacks } from '../utils.js';
import { pendingClassifications, pendingVoucherLinks, setLabelKind, markVoucherLinked, markVoucherSkipped } from './loyaltybalances.js';
import { matchBrandLogo } from '../brandLogos.js';

const VOUCHER_TYPES = ['Voucher', 'Credit', 'Cheque', 'Refund', 'Other'];

// Starter suggestions for the provider datalist, unioned at render time
// with every provider value already saved across data.vouchers (and
// every loyalty program's own name) -- same "seed list UNION values
// already typed" convention as connections.js's existingTagValues()/
// MILESTONE_SUGGESTIONS, so a one-off typed provider becomes a future
// suggestion rather than needing to be retyped identically forever.
const PROVIDER_SUGGESTIONS = ['British Airways', 'Marriott Bonvoy', 'Virgin Atlantic', 'Tesco', 'Boots', 'Hertz', 'Sixt', 'Miles & More', 'Airbnb', 'Mastercard'];
function existingProviderValues() {
const seen = new Map();
PROVIDER_SUGGESTIONS.forEach((n) => seen.set(n.toLowerCase(), n));
data.loyaltyPrograms.forEach((p) => { if (p.name) seen.set(p.name.toLowerCase(), p.name); });
data.vouchers.forEach((v) => { if (v.provider) seen.set(v.provider.toLowerCase(), v.provider); });
return [...seen.values()].sort((a, b) => a.localeCompare(b));
}
function providerDatalistHtml() {
return `<datalist id="taglist-voucher-provider">${existingProviderValues().map((n) => `<option value="${escapeHtml(n)}">`).join('')}</datalist>`;
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
return v.expiry ? daysUntil(v.expiry) : Infinity;
}

function voucherRowHtml(v) {
let badgeHtml = '';
if (v.expiry) {
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
return `<div class="voucher-row" data-voucher-row="${v.id}">
<div class="voucher-id" style="display:flex;gap:8px;align-items:flex-start;">
${logoBadgeHtml(v.logoUrl, vInitials, 'plum')}
<div style="flex:1 1 auto;min-width:0;">
<input type="text" autocomplete="off" class="voucher-edit voucher-name-edit" data-field="name" data-voucher-id="${v.id}" value="${escapeHtml(v.name)}">
<div class="voucher-meta">
<select class="voucher-edit voucher-type-edit" data-field="type" data-voucher-id="${v.id}">
${VOUCHER_TYPES.map((t) => `<option value="${t}" ${t === v.type ? 'selected' : ''}>${t}</option>`).join('')}
</select>
<input type="text" autocomplete="off" class="voucher-edit voucher-value-edit" data-field="value" data-voucher-id="${v.id}" value="${escapeHtml(v.value || '')}" placeholder="Value">
</div>
</div>
</div>
<input type="text" autocomplete="off" class="voucher-edit voucher-notes-edit" data-field="notes" data-voucher-id="${v.id}" value="${escapeHtml(v.notes || '')}" placeholder="Notes">
<input type="text" autocomplete="off" class="voucher-edit voucher-provider-edit" list="taglist-voucher-provider" data-field="provider" data-provider-blur="${v.id}" data-voucher-id="${v.id}" value="${escapeHtml(v.provider || '')}" placeholder="Provider (optional)" title="Who the voucher is from -- matched against a real logo when it's a known brand (British Airways, Airbnb, Mastercard...).">
<input type="text" autocomplete="off" class="voucher-edit voucher-reference-edit" data-field="reference" data-voucher-id="${v.id}" value="${escapeHtml(v.reference || '')}" placeholder="Reference (optional)" title="A voucher/booking reference, if it has one -- the loyalty-scan review matches on this to offer a confident 'Update' instead of risking a merge with an unrelated voucher.">
<div class="voucher-expiry">
<input type="date" class="voucher-edit expiry-date-edit" data-field="expiry" data-voucher-id="${v.id}" value="${escapeHtml(v.expiry || '')}">
${badgeHtml}
</div>
<div class="voucher-actions">
${(v.sourceLoyaltyReadingIds || []).length ? `<span class="tag-chip" data-open-loyalty-reading="${v.sourceLoyaltyReadingIds[v.sourceLoyaltyReadingIds.length - 1]}" title="Created or updated from a loyalty scan reading -- click to see it">from loyalty scan</span>` : ''}
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

function renderVouchers() {
renderVoucherReview();
const list = document.getElementById('vouchers-list');
document.getElementById('vouchers-count').textContent = data.vouchers.length + (data.vouchers.length === 1 ? ' item' : ' items');
if (data.vouchers.length === 0) {
list.innerHTML = '<div class="empty">Nothing tracked yet. Add one below.</div>' + providerDatalistHtml();
return;
}
list.innerHTML = groupedVouchersHtml(data.vouchers) + providerDatalistHtml();

list.querySelectorAll('[data-field][data-voucher-id]').forEach((el) => {
el.addEventListener('change', () => {
const v = data.vouchers.find((x) => x.id === el.dataset.voucherId);
if (!v) return;
v[el.dataset.field] = el.value.trim();
renderVouchers();
queueSave();
});
});
// Auto-fills a logo the moment a typed provider matches a known brand
// -- `blur`, not `change`, so retyping an already-correct provider
// still re-triggers the fill-in (same reasoning as financeaccounts.js's
// identical bank-logo blur handler), and only while logoUrl is still
// empty so a manually-set one is never silently overwritten.
list.querySelectorAll('[data-provider-blur]').forEach((el) => {
el.addEventListener('blur', () => {
const v = data.vouchers.find((x) => x.id === el.dataset.providerBlur);
if (!v || v.logoUrl) return;
const match = matchBrandLogo(el.value.trim() || v.provider);
if (match) { v.logoUrl = match; queueSave(); renderVouchers(); }
});
});
list.querySelectorAll('[data-del-voucher]').forEach((el) => {
el.addEventListener('click', () => {
const doomed = data.vouchers.find((x) => x.id === el.dataset.delVoucher);
if (!confirm(`Delete ${doomed && doomed.name ? `"${doomed.name}"` : 'this voucher'}?`)) return;
data.vouchers = data.vouchers.filter((x) => x.id !== el.dataset.delVoucher);
renderVouchers();
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

function readingValueText(reading) {
if (reading.balance == null) return /used/i.test(reading.label) ? 'Used' : '';
return `${reading.unit === '£' ? '£' : ''}${reading.balance.toLocaleString('en-GB')}${reading.unit && reading.unit !== '£' ? ' ' + reading.unit : ''}`;
}

function readingSummaryText(reading) {
const parts = [reading.detail ? `${reading.label}: ${reading.detail}` : reading.label];
const value = readingValueText(reading);
if (value) parts.push(value);
parts.push(`on ${reading.date}`);
if (reading.expiryDate) parts.push(`expires ${reading.expiryDate}`);
if (reading.reference) parts.push(`ref ${reading.reference}`);
return parts.join(' — ');
}

// A name worth showing in the Vouchers list -- "Quidco: Agent
// Provocateur" reads far better than "Quidco: Cashback confirmed"
// repeated identically for every single retailer.
function voucherNameFor(program, reading) {
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
const value = readingValueText(reading);
if (value) voucher.value = value;
if (reading.expiryDate) voucher.expiry = reading.expiryDate;
if (reading.reference && !voucher.reference) voucher.reference = reading.reference;
// Backfills provider/logo onto a voucher that predates this field (or
// was added by hand with neither set) -- the real program name is an
// exact match, never a guess, so it's always worth filling in for
// free the moment a reading actually links to this voucher.
if (!voucher.provider) voucher.provider = program.name;
if (!voucher.logoUrl) voucher.logoUrl = matchBrandLogo(program.name) || '';
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
const voucher = blankVoucher({ name: voucherNameFor(program, reading), value: readingValueText(reading), expiry: reading.expiryDate || '', notes: `From ${program.name} scan, ${reading.date}.`, reference: reading.reference || '', sourceLoyaltyReadingIds: [reading.id], provider: program.name, logoUrl: matchBrandLogo(program.name) || '' });
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
const voucher = blankVoucher({ name: voucherNameFor(program, reading), provider: program.name, logoUrl: matchBrandLogo(program.name) || '' });
data.vouchers.push(voucher);
targetId = voucher.id;
}
allReadings.forEach((r) => applyUpdateToVoucher(r, program, targetId));
}

function renderVoucherReview() {
const mount = document.getElementById('voucher-review-section');
if (!mount) return;
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
const expiryInput = document.getElementById('voucher-expiry-input');
const notesInput = document.getElementById('voucher-notes-input');
const providerInput = document.getElementById('voucher-provider-input');
const name = nameInput.value.trim();
if (!name) return;
const provider = (providerInput?.value || '').trim();
data.vouchers.push(blankVoucher({
name,
type: typeInput.value,
value: valueInput.value.trim(),
expiry: expiryInput.value,
notes: notesInput.value.trim(),
provider,
logoUrl: provider ? (matchBrandLogo(provider) || '') : '',
}));
nameInput.value = '';
valueInput.value = '';
expiryInput.value = '';
notesInput.value = '';
if (providerInput) providerInput.value = '';
renderVouchers();
queueSave();
});
bindVoucherChips();
}

export { renderVouchers, initVoucherForm, voucherChipHtml, bindVoucherChips };
