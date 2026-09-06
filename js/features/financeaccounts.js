// Bank accounts and credit cards kept open for their incentive -- a
// switch bonus, cashback, or a 0% balance-transfer deal. Replaces the
// old flat "Deal Expiries" panel (name/type/date/notes only, no account
// identity, no linkage between accounts) with a richer record per
// account, plus a visual "money flow" diagram of how funding/CASS links
// actually connect them -- the connectivity itself was the ask, not
// just capturing more fields.
import { data, queueSave, blankFinanceAccount } from '../state.js';
import { uid, escapeHtml, bindForm, daysUntil, scrollAndFlash } from '../utils.js';
import { matchBankLogo } from '../bankLogos.js';

const ACCOUNT_TYPES = ['Current account', 'Savings', 'Credit card', 'Mortgage', 'Loan', 'Other'];
// A genuine DECISION, not a fact derivable from other fields -- "closed"
// and "has a live deal" were proposed alongside this but deliberately
// aren't members of it, since both are already fully computed elsewhere
// (isClosed() below, dealBadgeHtml() from dealEndDate) and a manually-
// set stage for either would just go stale the moment the real field
// changes without this one being remembered too. Undecided is the
// neutral default -- shown as no chip at all (see accountCardHtml),
// same "nothing to say yet" reasoning every other conditional badge on
// this card already uses.
const ACCOUNT_STAGES = ['Undecided', 'To keep', 'CASS-ready'];
const ACCOUNT_STAGE_COLOUR = { 'To keep': 'green', 'CASS-ready': 'amber' };
// Same idea as airbnb.js's own AIRBNB_COLOURS -- a small, locally-declared
// fixed palette, since there's no free colour-picker anywhere else to
// reuse and accounts aren't the same colour space as Airbnb listings.
const ACCOUNT_COLOURS = ['blue', 'pink', 'sage', 'amber', 'slate', 'rose', 'teal', 'plum', 'red'];

// Mirrors connections.js's expandedConnections -- renderFinanceAccounts()
// rebuilds the whole list's innerHTML every time (e.g. after editing one
// field), so which <details> card is open has to be tracked outside the
// DOM, not read back from it.
const expandedAccounts = new Set();

function isClosed(a) {
return !!(a.closeDate && a.closeDate <= new Date().toISOString().slice(0, 10));
}

function accountLabel(a) {
return [a.bank, a.name].filter(Boolean).join(' — ') || 'Unnamed account';
}
function accountInitials(a) {
return (a.bank || a.name || '?').trim().slice(0, 2).toUpperCase();
}
// Prefers a pasted logo image (e.g. the provider's own Play Store
// listing icon, hotlinked -- never downloaded/stored locally, see
// blankFinanceAccount's own comment) over the coloured-initials
// fallback. `img[error]` doesn't bubble, so the fallback-reveal has to
// be bound per-image after insertion -- see bindLogoFallbacks() below,
// called after every render.
function accountBadgeHtml(a, sizeClass) {
const cls = `account-badge ${escapeHtml(a.colour)} ${sizeClass || ''}`;
const initials = escapeHtml(accountInitials(a));
if (a.logoUrl) {
return `<span class="${cls} account-badge-logo"><img src="${escapeHtml(a.logoUrl)}" alt="" data-badge-img="1"><span class="account-badge-fallback" data-badge-fallback hidden>${initials}</span></span>`;
}
return `<span class="${cls}">${initials}</span>`;
}
function bindLogoFallbacks(root) {
root?.querySelectorAll('img[data-badge-img]').forEach((img) => {
img.addEventListener('error', () => {
// closest() has to run BEFORE remove() -- once detached, the img has
// no parent left to walk up from and the lookup silently finds
// nothing, leaving the fallback stuck hidden behind a blank badge.
const badge = img.closest('.account-badge');
img.remove();
badge?.querySelector('[data-badge-fallback]')?.removeAttribute('hidden');
}, { once: true });
});
}

// Same expiry-badge classes vouchers.js/subscriptions.js/the old
// dealexpiries.js all already use -- no new CSS needed for this part.
// dealOngoing (a permanent cashback rate, a fee waiver with no end
// date) gets its own plain badge rather than staying silent -- before
// this, a deal with no dealEndDate showed NO badge at all, identical
// to an account with no deal recorded, which is exactly the ambiguity
// dealOngoing exists to remove.
function dealBadgeHtml(a) {
if (a.dealOngoing) return `<span class="expiry-badge">Deal: ongoing</span>`;
if (!a.dealEndDate) return '';
const dn = daysUntil(a.dealEndDate);
if (dn < 0) return `<span class="expiry-badge expired">Deal expired</span>`;
if (dn <= 60) return `<span class="expiry-badge soon">${dn === 0 ? 'Deal ends today' : `Deal: ${dn}d left`}</span>`;
return `<span class="expiry-badge">Deal: ${dn}d left</span>`;
}

function otherAccountOptionsHtml(excludeId, selectedId) {
return `<option value="">None</option>` + data.financeAccounts
.filter((a) => a.id !== excludeId)
.map((a) => `<option value="${escapeHtml(a.id)}" ${a.id === selectedId ? 'selected' : ''}>${escapeHtml(accountLabel(a))}</option>`)
.join('');
}

// The "Funded from" picker -- one dropdown mixing external-source
// presets (Salary/Airbnb/Side gig), a free-text "Other", and the
// existing tracked-account list, grouped under its own <optgroup> so
// "who else did I add" doesn't get visually confused with "what KIND
// of source is this" while still living in one control. Preset option
// values are the preset text itself (self-describing, no separate
// lookup needed on change -- see the dedicated select handler); real
// account ids come from otherAccountOptionsHtml, reused as-is.
function fundingSourceOptionsHtml(a) {
const presetOpts = FUNDING_SOURCE_PRESETS.map((p) => `<option value="${escapeHtml(p)}" ${!a.fundingFromAccountId && !a.fundingSourceOther && a.fundingSource === p ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('');
const otherOpt = `<option value="__other__" ${a.fundingSourceOther ? 'selected' : ''}>Other…</option>`;
const acctOpts = data.financeAccounts
.filter((x) => x.id !== a.id)
.map((x) => `<option value="${escapeHtml(x.id)}" ${a.fundingFromAccountId === x.id ? 'selected' : ''}>${escapeHtml(accountLabel(x))}</option>`)
.join('');
return `<option value="">None</option>${presetOpts}${otherOpt}<optgroup label="My accounts">${acctOpts}</optgroup>`;
}

// Every regular outgoing, not just Direct Debits -- standing orders,
// manual payments, card payments, anything recurring -- but Direct
// Debit is still the dominant/default case (deal criteria almost
// always name DDs specifically), so it stays the default `method` and
// the ONLY one counted on the flow-card summary (ddCountLabel below).
const OUTGOING_METHODS = ['Direct Debit', 'Standing Order', 'Manual payment', 'Card payment', 'Other'];
const outgoingMethod = (o) => o.method || 'Direct Debit'; // pre-method entries were always DDs
// A Manual payment is still a real, INTENDED recurring transfer -- just
// executed by hand instead of automatically -- so it joins DD/Standing
// Order everywhere those are treated as "reliable recurring outflow"
// (the surplus calc's out/pushedIn totals). Card payment/Other stay
// excluded from all of that: unlike these three, their amount isn't a
// fixed recurring figure by definition. The diagram is more permissive
// than this list (see flowEdges) -- it draws an edge for ANY method
// with toAccountId set, just doesn't count Card payment/Other toward
// the £ totals.
const REGULAR_OUTGOING_METHODS = ['Direct Debit', 'Standing Order', 'Manual payment'];
// 2-letter code shown on every diagram arrow (Ongoing view) so "what
// kind of payment is this" never has to be inferred from dash style
// alone. AC (below) is the separate code for a fundingFromAccountId
// pull -- not a method, so it isn't in this map.
const OUTGOING_METHOD_CODE = { 'Direct Debit': 'DD', 'Standing Order': 'SO', 'Manual payment': 'MP', 'Card payment': 'CP', 'Other': 'OT' };
const PULL_ACCOUNT_CODE = 'AC';
// External funding sources -- money genuinely from outside any tracked
// account. "Other" isn't listed here: it's handled as free text (see
// fundingSourceOther) with its own fixed 'OT' code below.
const FUNDING_SOURCE_PRESETS = ['Salary', 'Airbnb', 'Side gig'];
const FUNDING_SOURCE_CODE = { Salary: 'SA', Airbnb: 'AB', 'Side gig': 'SG' };
// Dash styles for the Ongoing view specifically -- per EDGE, not per
// MODE like the existing FLOW_DASH_BY_KIND (cass/balance-transfer),
// since Ongoing now needs several different line styles within the
// same single view (a mix of automated, manual and variable-income
// edges can all appear together).
const FUNDING_EDGE_DASH = { manual: 'stroke-dasharray="4 3"', variable: 'stroke-dasharray="1 3"' };

// deal-linked/transferrable reuses the exact idiom planner.js's own
// draft/firm distinction settled on: border style + font weight, no new
// visual language (planner.js:123-130 -- a wide text pill used to spell
// this out, confirmed live to crowd everything else off the row; the
// border/weight signal costs zero extra width). Blank/unclassified stays
// the plain default chip look.
const OUTGOING_STATUS_LABEL = { 'deal-linked': 'Deal-linked', transferrable: 'Transferrable' };
function outgoingStatusCycle(status) {
if (status === 'deal-linked') return 'transferrable';
if (status === 'transferrable') return '';
return 'deal-linked';
}
function outgoingsHtml(a) {
return (a.outgoings || []).map((o) => {
const toAccount = o.toAccountId ? data.financeAccounts.find((x) => x.id === o.toAccountId) : null;
const method = outgoingMethod(o);
const label = `${escapeHtml(o.beneficiary || (toAccount ? 'Transfer' : 'Unnamed'))}${o.amount !== '' && o.amount != null ? ` · £${escapeHtml(String(o.amount))}/mo` : ''}${method !== 'Direct Debit' ? ` (${escapeHtml(method)})` : ''}`;
const statusClass = o.status ? ` tag-chip-${o.status}` : '';
const statusTitle = o.status ? OUTGOING_STATUS_LABEL[o.status] : 'Not set';
// toAccountId means this actually pays another of YOUR OWN tracked
// accounts (e.g. a mortgage overpayment) -- shown as its own small
// clickable link (record-reference convention: any account referenced
// elsewhere links back to it), separate from the status-toggle text so
// the two clicks (cycle status vs. open that account) can't collide.
const toAccountLink = toAccount
? ` <span class="dd-to-account-link" data-open-account-ref="${escapeHtml(toAccount.id)}" title="Pays into ${escapeHtml(accountLabel(toAccount))} — leaves this account's own monthly surplus, and counts as funding coming IN on ${escapeHtml(accountLabel(toAccount))}'s own">&rarr; ${escapeHtml(accountLabel(toAccount))}</span>`
: '';
// The status-cycle click target is a SIBLING of the × remove button,
// not its wrapper -- clicking × would otherwise also bubble into a
// parent status-toggle and cycle the status on every removal.
return `<span class="tag-chip${statusClass}"><span class="dd-status-toggle" data-dd-status-cycle="${escapeHtml(a.id)}:${escapeHtml(o.id)}" title="${escapeHtml(statusTitle)} — click to change">${label}</span>${toAccountLink}<span class="tag-x" data-dd-remove="${escapeHtml(a.id)}:${escapeHtml(o.id)}">&times;</span></span>`;
}).join('');
}

// The flow-card's compact summary of an account's Direct Debits
// SPECIFICALLY -- "3 (1)" for 3 deal-linked, 1 transferrable -- even
// though the underlying list now holds any regular outgoing. Standing
// orders/card payments/etc. don't count toward this number at all (a
// deal's own conditions are almost always phrased in terms of DDs, not
// "any 2 regular payments"); the tooltip notes them separately so
// they're not simply invisible. Unclassified DDs aren't counted in
// either number (only visible via the full chip list).
function ddCountLabel(a) {
const all = a.outgoings || [];
const dds = all.filter((o) => outgoingMethod(o) === 'Direct Debit');
if (!dds.length) return null;
const linked = dds.filter((dd) => dd.status === 'deal-linked').length;
const transferrable = dds.filter((dd) => dd.status === 'transferrable').length;
const unclassified = dds.length - linked - transferrable;
const otherCount = all.length - dds.length;
const title = `${linked} deal-linked, ${transferrable} transferrable`
+ (unclassified ? `, ${unclassified} not yet set` : '')
+ ` (${dds.length} Direct Debit${dds.length === 1 ? '' : 's'} total)`
+ (otherCount ? ` + ${otherCount} other regular outgoing${otherCount === 1 ? '' : 's'}` : '');
return { text: `${linked} (${transferrable})`, title };
}

// Reverse of fundingFromAccountId -- every OTHER tracked account that
// names this one as its funding source. Same reverse-lookup shape as
// cassToAccount() below. Needed for accountMonthlySurplus: an account
// can be the SOURCE for several others (a household "hub" account
// funding five current accounts) and confirmed live as a real gap --
// none of that outflow was visible anywhere on the source account's
// OWN data (it only exists as fundingAmount/fundingFromAccountId on
// each RECIPIENT), so the source showed a wildly wrong positive
// surplus with the outflow simply invisible.
function accountsFundedBy(a) {
return data.financeAccounts.filter((x) => x.id !== a.id && x.fundingFromAccountId === a.id && x.fundingAmount !== '' && x.fundingAmount != null && isFinite(Number(x.fundingAmount)));
}

// Reverse of outgoings[].toAccountId -- every OTHER tracked account's
// Direct Debit/Standing Order that pushes money INTO this one. The
// "push" counterpart to accountsFundedBy's "pull" outflow above: a
// transfer can be recorded either way (the receiver naming its source
// via fundingFromAccountId, or the source holding the actual DD/
// Standing Order via toAccountId) -- both stay supported side by side,
// so this adds the push half without touching the pull logic at all.
// Neither double-counts the other: one is money arriving via another
// account's own outgoing, the other is money leaving via this account
// naming itself as someone else's pull source.
function accountsPushingInto(a) {
const result = [];
data.financeAccounts.forEach((x) => {
if (x.id === a.id) return;
(x.outgoings || []).forEach((o) => {
if (o.toAccountId !== a.id || !REGULAR_OUTGOING_METHODS.includes(outgoingMethod(o))) return;
if (o.amount === '' || o.amount == null || !isFinite(Number(o.amount))) return;
result.push({ from: x, amount: Number(o.amount) });
});
});
return result;
}

// £x funded in, minus what actually leaves the account: every
// REGULAR_OUTGOING_METHODS outgoing (INCLUDING ones paying into
// another of your own tracked accounts, e.g. a mortgage overpayment --
// it still leaves THIS account's own balance, whatever else it means
// at a household level; see outgoingsHtml's own comment on toAccountId)
// plus whatever this account itself sends on to fund other tracked
// accounts via the pull mechanism (accountsFundedBy, above). Funding in
// is the pull field (fundingAmount -- external, from outside any
// tracked account, or from one named the pull way) PLUS anything pushed
// in via another account's own REGULAR_OUTGOING_METHODS outgoing
// (accountsPushingInto). Card payment/Other stay excluded from the out
// side: unlike DD/Standing Order/Manual payment, their amount isn't a
// fixed recurring figure by definition, so folding them in would make
// the total look more precise than it really is. Returns null only when
// there's truly nothing on this account at all to compute from.
function accountMonthlySurplus(a) {
const externalIn = (a.fundingAmount !== '' && a.fundingAmount != null && isFinite(Number(a.fundingAmount))) ? Number(a.fundingAmount) : 0;
const pushedIn = accountsPushingInto(a);
const pushedInTotal = pushedIn.reduce((sum, p) => sum + p.amount, 0);
const fundingIn = externalIn + pushedInTotal;
const relevant = (a.outgoings || []).filter((o) => REGULAR_OUTGOING_METHODS.includes(outgoingMethod(o)));
let out = 0;
let unset = 0;
relevant.forEach((o) => {
if (o.amount === '' || o.amount == null || !isFinite(Number(o.amount))) { unset += 1; return; }
out += Number(o.amount);
});
if (fundingIn === 0 && out === 0 && relevant.length === 0) return null;
const fundedAccounts = accountsFundedBy(a);
const fundingOut = fundedAccounts.reduce((sum, x) => sum + Number(x.fundingAmount), 0);
const excludedOther = (a.outgoings || []).filter((o) => !REGULAR_OUTGOING_METHODS.includes(outgoingMethod(o))).length;
return { net: fundingIn - out - fundingOut, fundingIn, externalIn, externalSource: a.fundingSource, externalVariable: a.fundingVariable, pushedIn, pushedInTotal, out, unset, excludedOther, fundingOut, fundedAccounts };
}

function surplusSign(s) { return s.net < 0 ? '−' : '+'; }
function surplusAmountText(s) { return `${surplusSign(s)}£${Math.round(Math.abs(s.net)).toLocaleString('en-GB')}/mo`; }
// Shared between the card badge, the flow-diagram card, and the detail
// tooltip -- one place computing the breakdown sentence/phrase so the
// three surfaces can't drift out of sync with each other.
function surplusTitle(s) {
const inParts = [];
if (s.externalIn) inParts.push(`${s.externalVariable ? '~' : ''}£${s.externalIn.toLocaleString('en-GB')}${s.externalSource ? ` from ${s.externalSource}` : ' funding'}`);
if (s.pushedInTotal) inParts.push(`£${s.pushedInTotal.toLocaleString('en-GB')} from ${s.pushedIn.map((p) => accountLabel(p.from)).join(', ')}`);
let title = inParts.length ? inParts.join(' + ') : '£0 in';
if (s.out) title += ` − £${s.out.toLocaleString('en-GB')} Direct Debit/standing order`;
if (s.fundingOut) title += ` − £${s.fundingOut.toLocaleString('en-GB')} funding ${s.fundedAccounts.length} other account${s.fundedAccounts.length === 1 ? '' : 's'} (${s.fundedAccounts.map((x) => accountLabel(x)).join(', ')})`;
if (s.unset) title += `, ${s.unset} outgoing${s.unset === 1 ? '' : 's'} with no amount set (excluded)`;
if (s.excludedOther) title += `, excludes ${s.excludedOther} card payment/other outgoing${s.excludedOther === 1 ? '' : 's'}`;
return title;
}

// The account card's own compact "am I breaking even" badge --
// green/red the same way stageTag/issuesTag already use colour to make
// status scannable at a glance. isClosed is checked explicitly here
// (not left to accountMonthlySurplus alone) so a closed account that
// still has a stale fundingAmount lying around doesn't show a
// misleading badge.
function surplusTag(a) {
if (isClosed(a)) return '';
const s = accountMonthlySurplus(a);
if (!s) return '';
const cls = s.net < 0 ? 'tag-chip-red' : 'tag-chip-green';
return `<span class="tag-chip ${cls}" title="${escapeHtml(surplusTitle(s))}">${surplusAmountText(s)}</span>`;
}

// Same figure, same colour convention, for the money-flow diagram card
// -- put there because that's exactly where a "funds 5 other accounts"
// relationship is drawn as edges, so the source card is the natural
// place to see what that leaves it with.
function flowCardSurplusHtml(a) {
if (isClosed(a)) return '';
const s = accountMonthlySurplus(a);
if (!s) return '';
const cls = s.net < 0 ? 'negative' : 'positive';
return `<div class="flow-card-surplus ${cls}" title="${escapeHtml(surplusTitle(s))}">${surplusAmountText(s)}</div>`;
}

// The same figure as surplusTag, spelled out in full sentence form in
// the detail view -- the badge is for a glance, this is for actually
// checking the arithmetic. Builds its own sentence rather than reusing
// surplusTitle()'s comma-joined phrase -- full stops between clauses
// read better at this length than one long qualifier-laden clause.
function surplusDetailHtml(a) {
const s = accountMonthlySurplus(a);
if (!s) return '';
const suffix = s.net < 0 ? 'short' : 'left over';
const inParts = [];
if (s.externalIn) inParts.push(`${s.externalVariable ? '~' : ''}£${s.externalIn.toLocaleString('en-GB')}${s.externalSource ? ` from ${s.externalSource}` : ' funding'}`);
if (s.pushedInTotal) inParts.push(`£${s.pushedInTotal.toLocaleString('en-GB')} from ${s.pushedIn.map((p) => accountLabel(p.from)).join(', ')}`);
let text = `Net monthly: ${inParts.length ? inParts.join(' + ') : '£0 in'}`;
if (s.out) text += ` − £${s.out.toLocaleString('en-GB')} Direct Debit/standing order`;
if (s.fundingOut) text += ` − £${s.fundingOut.toLocaleString('en-GB')} funding ${s.fundedAccounts.length} other account${s.fundedAccounts.length === 1 ? '' : 's'} (${s.fundedAccounts.map((x) => accountLabel(x)).join(', ')})`;
text += ` = £${Math.round(Math.abs(s.net)).toLocaleString('en-GB')}/mo ${suffix}.`;
if (s.unset) text += ` ${s.unset} outgoing${s.unset === 1 ? '' : 's'} with no amount set aren't included.`;
if (s.excludedOther) text += ` Excludes ${s.excludedOther} card payment/other outgoing${s.excludedOther === 1 ? '' : 's'} (not a fixed monthly figure).`;
return `<div class="settings-note" style="margin:2px 0 0;">${escapeHtml(text)}</div>`;
}

// Same terse "day + month, year only if not this year" shape
// airbnb.js's own formatAirbnbDate uses for a compact date sitting
// inside a small UI element -- no shared date-formatting utility exists
// to import instead (every feature file that needs one has its own
// small local copy, confirmed by checking).
function formatShortDate(iso) {
if (!iso) return '';
const d = new Date(`${iso}T00:00:00`);
if (isNaN(d)) return iso;
const opts = { day: 'numeric', month: 'short' };
if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
return d.toLocaleDateString('en-GB', opts);
}

// A card's own equivalent of a CASS switch, but there can be several --
// each rendered as "£X from <account>" rather than a bare amount, since
// which OTHER account it came from is exactly the fact a bare list of
// amounts would lose.
function balanceTransfersHtml(a) {
return (a.balanceTransfers || []).map((bt) => {
const from = data.financeAccounts.find((x) => x.id === bt.fromAccountId);
const dateStr = formatShortDate(bt.date);
const label = `${bt.amount ? escapeHtml(bt.amount) : 'Amount not set'} from ${escapeHtml(from ? accountLabel(from) : 'a deleted account')}${dateStr ? ` · ${escapeHtml(dateStr)}` : ''}`;
return `<span class="tag-chip">${label}<span class="tag-x" data-bt-remove="${escapeHtml(a.id)}:${escapeHtml(bt.id)}">&times;</span></span>`;
}).join('');
}

// The account (if any) this one was CASS'd OUT to -- the reverse
// direction of cassFromAccountId, which only ever names the account
// switched FROM. Not stored anywhere itself; derived by scanning for
// whoever else's cassFromAccountId points back at this account, same
// as any other reverse-lookup in this app.
function cassToAccount(a) {
return data.financeAccounts.find((x) => x.cassFromAccountId === a.id);
}

// Deterministic, recomputed fresh every render -- same shape state.js's
// own suggestedQuestions() uses for a connection's "Needs attention"
// prompts, reused here rather than inventing a second convention.
// Closed accounts get their OWN short list, not the open-account checks
// below -- a closed account's missing sort code isn't worth flagging,
// but "closed with nothing explaining where it went" still is.
function accountIssues(a) {
if (isClosed(a)) {
return cassToAccount(a) ? [] : ['Closed, but no other account records a CASS switch from this one — actually CASS\'d away, or just closed outright?'];
}
const out = [];
if (!a.bank && !a.name) out.push('No bank or account name set yet.');
if (a.cassFromAccountId && !a.openDate) out.push('Came from a CASS switch but has no open date recorded.');
if (a.dealEndDate && !a.dealOngoing && daysUntil(a.dealEndDate) < 0 && a.stage !== 'CASS-ready') out.push('Deal ended — still open. Mark it CASS-ready, close it, or record a new deal?');
if (a.deal) {
if (!a.fundingAmount && !a.fundingFromAccountId) out.push('Has a deal but no funding transfer set up — is one needed to keep it?');
if (!(a.outgoings || []).some((o) => outgoingMethod(o) === 'Direct Debit')) out.push('Has a deal but no Direct Debits recorded — often a condition worth checking.');
if (!a.dealEndDate && !a.dealOngoing) out.push('Has a deal but no end date set — ongoing, or just not recorded yet?');
} else if (!a.purpose && !a.notes) {
out.push('No deal, purpose, or notes recorded — why is this kept open?');
}
if (!!a.fundingAmount !== !!(a.fundingFromAccountId || a.fundingSource)) out.push('Funding amount and source don\'t match — one is set without the other.');
const surplus = accountMonthlySurplus(a);
if (surplus) {
if (surplus.net < 0) out.push(`Outgoings (Direct Debit/standing order) exceed funding by £${Math.round(-surplus.net).toLocaleString('en-GB')}/mo — funding, DDs, or amounts may be out of date.`);
if (surplus.unset) out.push(`${surplus.unset} Direct Debit/standing order${surplus.unset === 1 ? ' has' : 's have'} no amount set — excluded from the monthly surplus check.`);
}
return out;
}

function accountCardHtml(a) {
let closedTag = '';
if (isClosed(a)) {
const to = cassToAccount(a);
const closedLabel = to ? `Closed — CASS to ${escapeHtml(to.bank || accountLabel(to))}` : 'Closed';
closedTag = `<span class="tag-chip" style="opacity:.7;">${closedLabel}</span>`;
}
// Only shown while open -- once closed, closedTag above is already the
// more informative, more terminal fact; a leftover "To keep" sitting
// next to "Closed" would just read as contradictory.
const stageColour = ACCOUNT_STAGE_COLOUR[a.stage];
const stageTag = (!isClosed(a) && stageColour) ? `<span class="tag-chip tag-chip-${stageColour}">${escapeHtml(a.stage)}</span>` : '';
const issues = accountIssues(a);
const issuesTag = issues.length ? `<span class="tag-chip tag-chip-amber" title="${escapeHtml(issues.join(' • '))}">⚠ ${issues.length}</span>` : '';
return `<details class="account-card" data-account-row="${escapeHtml(a.id)}" ${expandedAccounts.has(a.id) ? 'open' : ''}>
<summary class="account-summary">
${accountBadgeHtml(a, 'sm')}
<span class="account-summary-name">${escapeHtml(accountLabel(a))}</span>
<span class="tag-chip">${escapeHtml(a.accountType)}</span>
${stageTag}
${closedTag}
${dealBadgeHtml(a)}
${surplusTag(a)}
${issuesTag}
</summary>
<div class="account-detail">
${issues.length ? `<ul class="suggested-questions" title="Deterministic prompts, recomputed fresh each time">${issues.map((q) => `<li>${escapeHtml(q)}</li>`).join('')}</ul>` : ''}
<div class="account-field-row">
<label>Bank<input type="text" autocomplete="off" data-field="bank" data-account-id="${a.id}" value="${escapeHtml(a.bank)}" placeholder="e.g. Halifax"></label>
<label>Account name<input type="text" autocomplete="off" data-field="name" data-account-id="${a.id}" value="${escapeHtml(a.name)}" placeholder="e.g. Reward Current Account"></label>
<label>Type<select data-field="accountType" data-account-id="${a.id}">${ACCOUNT_TYPES.map((t) => `<option value="${t}" ${t === a.accountType ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
<label>Stage <span class="settings-note" style="display:inline;margin:0;">(a decision, not a fact — closed/deal-active are shown automatically from their own dates)</span><select data-field="stage" data-account-id="${a.id}">${ACCOUNT_STAGES.map((s) => `<option value="${s}" ${s === a.stage ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
</div>
<div class="account-field-row">
<label>Sort code<input type="text" autocomplete="off" data-field="sortCode" data-account-id="${a.id}" value="${escapeHtml(a.sortCode)}" placeholder="00-00-00"></label>
<label>Account number<input type="text" autocomplete="off" data-field="accountNumber" data-account-id="${a.id}" value="${escapeHtml(a.accountNumber)}" placeholder="12345678"></label>
</div>
<div class="account-field-row">
<label>Opened<input type="date" data-field="openDate" data-account-id="${a.id}" value="${escapeHtml(a.openDate)}"></label>
<label>Closed<input type="date" data-field="closeDate" data-account-id="${a.id}" value="${escapeHtml(a.closeDate)}"></label>
<label>CASS switch from<select data-field="cassFromAccountId" data-account-id="${a.id}">${otherAccountOptionsHtml(a.id, a.cassFromAccountId)}</select></label>
</div>
<div class="account-field-row">
<label>Deal / incentive<input type="text" autocomplete="off" data-field="deal" data-account-id="${a.id}" value="${escapeHtml(a.deal)}" placeholder="e.g. £200 switch bonus, 0% BT 30mo"></label>
<label>Deal ends<input type="date" data-field="dealEndDate" data-account-id="${a.id}" value="${escapeHtml(a.dealEndDate)}" ${a.dealOngoing ? 'disabled' : ''}></label>
<label><input type="checkbox" data-field="dealOngoing" data-account-id="${a.id}" ${a.dealOngoing ? 'checked' : ''}> Ongoing (no end date)</label>
</div>
<label class="account-field-full">Purpose<input type="text" autocomplete="off" data-field="purpose" data-account-id="${a.id}" value="${escapeHtml(a.purpose)}" placeholder="e.g. Switch bonus farming, Emergency fund"></label>
<div class="account-field-row">
<label>Monthly funding in (£)<input type="number" step="0.01" min="0" autocomplete="off" data-field="fundingAmount" data-account-id="${a.id}" value="${escapeHtml(a.fundingAmount)}" placeholder="e.g. 1000"></label>
<label><input type="checkbox" data-field="fundingVariable" data-account-id="${a.id}" ${a.fundingVariable ? 'checked' : ''}> Variable amount <span class="settings-note" style="display:inline;margin:0;">(a rough estimate, e.g. Airbnb bookings, not a fixed figure like a salary)</span></label>
<label>Funded from<select data-funding-source-select="${a.id}">${fundingSourceOptionsHtml(a)}</select></label>
${a.fundingSourceOther ? `<label>Source name<input type="text" autocomplete="off" data-field="fundingSource" data-account-id="${a.id}" value="${escapeHtml(a.fundingSource)}" placeholder="e.g. Freelance writing"></label>` : ''}
</div>
${surplusDetailHtml(a)}
<div class="account-field-full">
<label style="display:block;margin-bottom:4px;">Balance transfers <span class="settings-note" style="display:inline;margin:0;">(a card's own equivalent of a CASS switch — there can be several, over time)</span></label>
<div class="tag-editor">${balanceTransfersHtml(a)}</div>
<div class="sync-row" style="margin-top:6px;">
<select data-bt-from="${a.id}">${otherAccountOptionsHtml(a.id, '')}</select>
<input type="text" autocomplete="off" class="tag-add-input" placeholder="Amount, e.g. £2,000" data-bt-amount="${a.id}" style="max-width:140px;">
<input type="date" data-bt-date="${a.id}" title="When the transfer happened">
<button class="sync-btn sm" type="button" data-bt-add="${a.id}">Add</button>
</div>
</div>
<div class="account-field-full">
<label style="display:block;margin-bottom:4px;">Direct Debits &amp; other outgoings <span class="settings-note" style="display:inline;margin:0;">(DDs are often a condition of the deal; the flow-card count is DD-specific)</span></label>
<div class="tag-editor">${outgoingsHtml(a)}</div>
<div class="sync-row" style="margin-top:6px;">
<input type="text" autocomplete="off" class="tag-add-input" placeholder="Beneficiary, e.g. Netflix" data-dd-beneficiary="${a.id}" style="max-width:150px;">
<input type="number" step="0.01" min="0" autocomplete="off" class="tag-add-input" placeholder="£/mo, e.g. 9.99" data-dd-amount="${a.id}" style="max-width:120px;">
<select data-dd-method="${a.id}" title="How it's paid">${OUTGOING_METHODS.map((m) => `<option value="${m}">${m}</option>`).join('')}</select>
<select data-dd-to-account="${a.id}" title="Pays into one of your own accounts instead of a third party -- e.g. a mortgage overpayment, or a Standing Order funding another tracked account (shows in the Ongoing diagram either way)">${otherAccountOptionsHtml(a.id, '')}</select>
<button class="sync-btn sm" type="button" data-dd-add="${a.id}">Add</button>
</div>
</div>
<div class="account-field-row">
<label class="account-field-full">Logo URL <span class="settings-note" style="display:inline;margin:0;">(optional -- e.g. the bank's own Play Store listing icon)</span><input type="text" autocomplete="off" data-field="logoUrl" data-account-id="${a.id}" value="${escapeHtml(a.logoUrl)}" placeholder="https://play-lh.googleusercontent.com/…"></label>
</div>
<div class="account-field-full">
<label style="display:block;margin-bottom:4px;">Colour <span class="settings-note" style="display:inline;margin:0;">(the card's accent stripe, and the fallback badge if no logo)</span></label>
<div class="account-colour-picker">${ACCOUNT_COLOURS.map((c) => `<span class="account-colour-swatch ${c} ${c === a.colour ? 'account-colour-selected' : ''}" data-colour-pick="${a.id}:${c}" title="${c}"></span>`).join('')}</div>
</div>
<label class="account-field-full">Notes<textarea data-field="notes" data-account-id="${a.id}" rows="2" placeholder="Anything else worth remembering">${escapeHtml(a.notes)}</textarea></label>
<div class="sync-row" style="margin-top:8px;">
<span class="del-x" style="opacity:1;" data-del-account="${a.id}">&times; Delete account</span>
</div>
</div>
</details>`;
}

// ---- Money-flow diagram ---------------------------------------------------

// Which relationship the diagram currently shows -- Ongoing (funding),
// CASS, or Balance transfers, never more than one at once (see
// FLOW_MODES below). Module-level, not persisted -- resets to Ongoing
// on reload, the most-relevant-day-to-day default.
let flowMode = 'funding';
const FLOW_MODES = [
{ key: 'funding', label: 'Ongoing' },
{ key: 'cass', label: 'CASS' },
{ key: 'balance-transfer', label: 'Balance transfers' },
];
const FLOW_MODE_EMPTY = {
funding: 'Once you add a monthly funding transfer between accounts, they\'ll show here.',
cass: 'Once you record a CASS switch between accounts, they\'ll show here.',
'balance-transfer': 'Once you record a balance transfer between cards, they\'ll show here.',
};

// Only accounts that are a source or target of at least one edge of the
// CURRENT mode appear as nodes -- otherwise every unrelated account
// would clutter what's meant to be a focused "how does money actually
// move" view, not a second copy of the full roster.
//
// Closed-account visibility deliberately differs by mode: Ongoing
// (funding) hides closed accounts entirely -- a closed account has no
// ongoing payments to show, and its own edge (if any lingering data
// still has one) would be misleading. CASS and Balance transfers are
// both one-off HISTORICAL moves, not recurring ones, so closed accounts
// stay visible there -- the account you switched FROM, or transferred a
// balance out of, is very often exactly the one that's since been
// closed; hiding it would erase the point of showing that history at
// all.
// Estimated from character count rather than measured, which is fine
// at these label lengths ("£1,000/mo", "CASS · 12 Mar 2024"). Shared by
// drawFlowLines (sizes each label's own backing rect) and
// neededColumnGap (sizes the column gap itself) so the two can never
// disagree about how much room a label actually needs.
function labelBoxWidth(label) {
return Math.max(28, label.length * 6 + 8);
}

function flowEdges(mode) {
const closedOk = mode !== 'funding';
const byId = new Map(data.financeAccounts.map((a) => [a.id, a]));
const accountOk = (id) => { const a = byId.get(id); return !!a && (closedOk || !isClosed(a)); };
const edges = [];
if (mode === 'funding') {
data.financeAccounts.forEach((a) => {
if (!accountOk(a.id)) return;
// "Pull" -- the receiving account names a tracked account as its
// source. Coded 'AC' (account transfer) like every other edge kind
// now carries an explicit type, not just amount.
if (a.fundingFromAccountId && accountOk(a.fundingFromAccountId)) {
const amountLabel = (a.fundingAmount !== '' && a.fundingAmount != null) ? `£${a.fundingAmount}/mo` : 'transfer';
edges.push({ from: a.fundingFromAccountId, to: a.id, kind: 'funding', label: `${amountLabel} · ${PULL_ACCOUNT_CODE}` });
}
// "Push" -- any outgoing the SOURCE account holds that pays into
// another of the user's own tracked accounts (outgoings[].toAccountId,
// e.g. a mortgage overpayment, or a standing order funding a second
// account). ALL methods draw here now, each with its own 2-letter
// code (OUTGOING_METHOD_CODE) -- confirmed the diagram should show
// every type of money flow, not just DD/Standing Order. Only Manual
// payment gets the dashed line; this is purely about what's VISIBLE
// here, not what accountMonthlySurplus counts (that stays
// REGULAR_OUTGOING_METHODS -- Card payment/Other still aren't a fixed
// recurring figure, so still excluded from the £ totals even though
// they're drawn).
(a.outgoings || []).forEach((o) => {
if (!o.toAccountId || !accountOk(o.toAccountId)) return;
const method = outgoingMethod(o);
const amountLabel = (o.amount !== '' && o.amount != null) ? `£${o.amount}/mo` : 'transfer';
edges.push({ from: a.id, to: o.toAccountId, kind: 'funding', label: `${amountLabel} · ${OUTGOING_METHOD_CODE[method] || 'OT'}`, dash: method === 'Manual payment' ? FUNDING_EDGE_DASH.manual : '' });
});
// Outbound dot -- every outgoing that does NOT point at a tracked
// account (a real third party: utilities, Netflix, a manual rent
// transfer to someone not tracked) is otherwise invisible on this
// diagram entirely. Grouped into ONE summed arrow per account rather
// than a card per payee, which would turn "money leaves eventually"
// into diagram clutter unrelated to the actual question (does this
// account's money move between MY OWN accounts).
const offDiagram = (a.outgoings || []).filter((o) => !o.toAccountId);
if (offDiagram.length) {
let sum = 0;
let unset = 0;
const methodsUsed = new Set();
offDiagram.forEach((o) => {
methodsUsed.add(outgoingMethod(o));
if (o.amount === '' || o.amount == null || !isFinite(Number(o.amount))) { unset += 1; return; }
sum += Number(o.amount);
});
// Confirmed live: this used to show NO code at all -- a real
// inconsistency next to every other arrow now carrying one. When
// every off-diagram payment shares one method, show its code (and
// the manual-payment dash, same as a push edge would); when mixed,
// join the distinct codes rather than picking one arbitrarily or
// staying silent.
const codes = [...methodsUsed].map((m) => OUTGOING_METHOD_CODE[m] || 'OT');
const amountText = sum ? `£${Math.round(sum).toLocaleString('en-GB')}/mo` : 'amount not set';
const label = `${amountText} · ${codes.join('+')}`;
const dash = (methodsUsed.size === 1 && methodsUsed.has('Manual payment')) ? FUNDING_EDGE_DASH.manual : '';
const dotTitle = `${offDiagram.length} payment${offDiagram.length === 1 ? '' : 's'} outside your tracked accounts${unset ? ` (${unset} with no amount set)` : ''}`;
edges.push({ from: a.id, to: `dot-out-${a.id}`, kind: 'funding', label, dash, dotTitle });
}
// Inbound dot -- funding from a genuinely external source (Salary,
// Airbnb, a side gig, or free-text "Other"), i.e. fundingSource set
// rather than fundingFromAccountId. There's no tracked account to
// draw FROM, so this gets its own small per-account source dot
// instead. fundingVariable (Airbnb booking income vs a fixed salary)
// gets both a "~" on the amount and the dotted line style, not just
// the code letters, since the whole point is that this number is a
// rough estimate, not a hard figure.
if (a.fundingSource) {
const code = FUNDING_SOURCE_CODE[a.fundingSource] || 'OT';
const amountText = (a.fundingAmount !== '' && a.fundingAmount != null) ? `£${a.fundingAmount}/mo` : 'amount not set';
const label = `${a.fundingVariable ? '~' : ''}${amountText} · ${code}`;
edges.push({ from: `dot-in-${a.id}`, to: a.id, kind: 'funding', label, dash: a.fundingVariable ? FUNDING_EDGE_DASH.variable : '', dotTitle: a.fundingSource });
}
});
} else if (mode === 'cass') {
// Directional now (cassFromAccountId, not the old undirected-sounding
// cassLinkedAccountId) -- one edge per account that has it set, no
// pair-dedup needed since the field only ever points one way. No
// separate "CASS date" field exists to capture -- the switch date IS
// the FROM account's own closeDate (the old account you switched away
// from), so the label reads it straight off that account rather than
// asking for the same date twice.
data.financeAccounts.forEach((a) => {
if (a.cassFromAccountId && accountOk(a.cassFromAccountId) && accountOk(a.id)) {
const fromAccount = byId.get(a.cassFromAccountId);
const dateStr = formatShortDate(fromAccount?.closeDate);
edges.push({ from: a.cassFromAccountId, to: a.id, kind: 'cass', label: dateStr ? `CASS · ${dateStr}` : 'CASS' });
}
});
} else if (mode === 'balance-transfer') {
data.financeAccounts.forEach((a) => {
(a.balanceTransfers || []).forEach((bt) => {
if (bt.fromAccountId && accountOk(bt.fromAccountId) && accountOk(a.id)) {
const dateStr = formatShortDate(bt.date);
const label = [bt.amount || 'BT', dateStr].filter(Boolean).join(' · ');
edges.push({ from: bt.fromAccountId, to: a.id, kind: 'balance-transfer', label });
}
});
});
}
return edges;
}

// Layered left-to-right layout: an account with no incoming edge of the
// current mode (within the linked set) sits in column 0; anyone it
// funds/CASS'd/transferred a balance to sits one column to the right,
// and so on -- so money visibly flows left-to-right instead of a single
// row where 3+ lines into one account would have nowhere sane to go.
// `edges` is always a single kind (flowEdges(mode) only ever returns
// one), so no per-kind filtering is needed here -- every edge passed in
// counts. Cycles (two accounts funding each other) are defended against
// with a per-path visited set, which just stops the recursion rather
// than resolving them "correctly" -- not a shape the UI should
// encourage, just not allowed to hang on it.
function flowColumns(nodeIds, edges) {
const incoming = new Map();
edges.forEach((e) => {
if (!incoming.has(e.to)) incoming.set(e.to, []);
incoming.get(e.to).push(e.from);
});
const depthCache = new Map();
function depthOf(id, path) {
if (depthCache.has(id)) return depthCache.get(id);
if (path.has(id)) return 0;
const sources = incoming.get(id) || [];
if (!sources.length) { depthCache.set(id, 0); return 0; }
path.add(id);
const d = 1 + Math.max(...sources.map((s) => depthOf(s, path)));
path.delete(id);
depthCache.set(id, d);
return d;
}
const byDepth = new Map();
nodeIds.forEach((id) => {
const d = depthOf(id, new Set());
if (!byDepth.has(d)) byDepth.set(d, []);
byDepth.get(d).push(id);
});
const columns = [...byDepth.keys()].sort((x, y) => x - y).map((d) => byDepth.get(d));
return orderRowsToReduceCrossings(columns, edges);
}

// Which COLUMN a node lands in was never the problem -- source accounts
// left, whoever they fund/CASS'd/transferred to one column right. The
// actual mess (confirmed live: a CASS view with 8 accounts, dashed
// lines zigzagging across the entire diagram) was row order WITHIN each
// column being arbitrary insertion order, unrelated to which row its
// actual edge partner sat on. Standard barycenter heuristic for layered
// graph drawing: repeatedly re-sort each column by the average row
// position of the neighbours it's actually connected to in the
// adjacent column, alternating left-to-right (by predecessors) and
// right-to-left (by successors) passes until it settles. Not a true
// crossing-minimiser (that's NP-hard in general) -- a few passes of
// this converges to something close enough to read cleanly, which is
// all a diagram at this scale needs.
function orderRowsToReduceCrossings(columns, edges) {
if (columns.length < 2) return columns;
const incomingOf = new Map(), outgoingOf = new Map();
edges.forEach((e) => {
if (!incomingOf.has(e.to)) incomingOf.set(e.to, []);
incomingOf.get(e.to).push(e.from);
if (!outgoingOf.has(e.from)) outgoingOf.set(e.from, []);
outgoingOf.get(e.from).push(e.to);
});
let cols = columns.map((c) => [...c]);
function sweep(leftToRight) {
const range = leftToRight
? Array.from({ length: cols.length - 1 }, (_, i) => i + 1)
: Array.from({ length: cols.length - 1 }, (_, i) => cols.length - 2 - i);
range.forEach((i) => {
const neighbourCol = cols[leftToRight ? i - 1 : i + 1];
const neighbourPos = new Map(neighbourCol.map((id, pos) => [id, pos]));
const neighboursOf = leftToRight ? incomingOf : outgoingOf;
const currentPos = new Map(cols[i].map((id, pos) => [id, pos]));
const scored = cols[i].map((id) => {
const neighbours = (neighboursOf.get(id) || []).filter((n) => neighbourPos.has(n));
// No neighbour in the adjacent column on this pass (e.g. a source
// node has nothing to its left) -- keep its current relative
// position rather than collapsing everything untethered to the top.
const score = neighbours.length
? neighbours.reduce((sum, n) => sum + neighbourPos.get(n), 0) / neighbours.length
: currentPos.get(id);
return { id, score };
});
scored.sort((a, b) => a.score - b.score);
cols[i] = scored.map((s) => s.id);
});
}
for (let iter = 0; iter < 4; iter++) { sweep(true); sweep(false); }
return cols;
}

// Nodes are laid out by ordinary flexbox (columns of a flex row, each a
// flex column) -- normal document flow does the positioning, no pixel
// math for placement. This just measures where cards actually landed
// and draws SVG connectors between them. The part that actually solves
// "some accounts have 3+ funding lines": each node's OWN edges are
// distributed evenly along its relevant border (outgoing along the
// right edge, incoming along the left) instead of every line converging
// on one shared centre point -- a hub funding 4 accounts gets 4 spaced
// exit points, a target funded by 3 gets 3 spaced entry points, each
// computed independently per node. Applied uniformly to every edge kind
// now (not just funding) -- a card can just as easily receive several
// balance transfers, and treating every kind the same way here is both
// simpler and still correct. Only the line STYLE (solid/dashed/dotted,
// FLOW_DASH_BY_KIND below) and label vary by kind -- purely cosmetic,
// since a given view only ever shows one kind at a time (FLOW_MODES).
// Must match .flow-column's own CSS `gap` so a staggered run's rhythm
// looks identical to a column's ordinary card spacing.
const FLOW_COLUMN_GAP = 28;
// "Far fewer than in other columns", per the user's own wording -- not
// literally "less than the max" (a column with 4 next to one with 5
// isn't meaningfully sparse), a real fraction of it.
const SPARSE_HEIGHT_FRACTION = 0.5;

// Confirmed by a real screenshot: a column with just one or two cards
// (Krak, First Direct) next to a much busier one (5 accounts) was
// independently centred across the FULL diagram height -- flexbox
// align-items:center gives every column the SAME centre line, so a
// lone card just floats in a sea of blank space with a long line to
// reach its edge partner. Fix, run as a post-pass AFTER the columns
// are in the DOM (needs their real rendered heights): a maximal run of
// CONSECUTIVE sparse columns is staggered top-to-bottom as a group --
// column i (furthest from the dense column) highest, the next one
// below it, and so on -- rather than each independently centred on the
// same line. The whole staggered group is still centred together on
// the diagram's own midline (that's the point of using
// getBoundingClientRect for the actual heights, not a guess). A
// deliberate exception to keeping arrows exactly horizontal for this
// one case, per feedback -- a short edge ending up slightly diagonal
// matters less than a lone card wasting most of the diagram's height.
// Achieved with a `margin-top` DELTA on top of the existing centred
// position (not an absolute override) -- flexbox is still doing the
// real layout, this just nudges it.
function applySparseColumnStagger(container) {
const colEls = [...container.querySelectorAll('.flow-column')];
colEls.forEach((el) => { el.style.marginTop = ''; }); // always reset before recomputing -- a rebuilt diagram starts from a clean slate, never compounds a prior run's offsets
if (colEls.length < 2) return;
const heights = colEls.map((el) => el.getBoundingClientRect().height);
const maxHeight = Math.max(...heights);
let i = 0;
while (i < colEls.length) {
if (heights[i] >= maxHeight * SPARSE_HEIGHT_FRACTION) { i += 1; continue; }
let j = i;
while (j < colEls.length && heights[j] < maxHeight * SPARSE_HEIGHT_FRACTION) j += 1;
if (j - i > 1) {
const runHeights = heights.slice(i, j);
const combinedHeight = runHeights.reduce((s, h) => s + h, 0) + (j - i - 1) * FLOW_COLUMN_GAP;
const startY = (maxHeight - combinedHeight) / 2;
let cumulative = 0;
for (let k = i; k < j; k += 1) {
const desiredTop = startY + cumulative;
const defaultTop = (maxHeight - heights[k]) / 2; // where align-items:center already put it
colEls[k].style.marginTop = `${desiredTop - defaultTop}px`;
cumulative += heights[k] + FLOW_COLUMN_GAP;
}
}
i = j;
}
}

const FLOW_DASH_BY_KIND = { funding: '', cass: 'stroke-dasharray="5 3"', 'balance-transfer': 'stroke-dasharray="1.5 3"' };
function drawFlowLines(mode) {
const container = document.getElementById('account-flow-diagram');
if (!container) return;
const svg = container.querySelector('.flow-lines');
if (!svg) return;
const edges = flowEdges(mode);
const rect = container.getBoundingClientRect();
svg.setAttribute('width', String(rect.width));
svg.setAttribute('height', String(rect.height));
svg.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);

const rectOf = (id) => {
const el = container.querySelector(`[data-flow-node="${id}"]`);
if (!el) return null;
const r = el.getBoundingClientRect();
return { top: r.top - rect.top, left: r.left - rect.left, width: r.width, height: r.height };
};

const outEdges = new Map(), inEdges = new Map();
edges.forEach((e) => {
if (!outEdges.has(e.from)) outEdges.set(e.from, []);
outEdges.get(e.from).push(e);
if (!inEdges.has(e.to)) inEdges.set(e.to, []);
inEdges.get(e.to).push(e);
});
// Confirmed live: leaving each list in raw edge-array order (arbitrary,
// unrelated to where anything actually rendered) meant a node's exit/
// entry points didn't line up with its neighbours' actual row order --
// "top arrow to top card, 2nd arrow to 2nd card" wasn't happening even
// after orderRowsToReduceCrossings had already put the RIGHT rows next
// to each other, causing lines to visibly cross that didn't need to.
// Sorting each node's own edge list by the OTHER endpoint's actual
// rendered top position (not the barycenter's row-index estimate --
// the real pixel position, already measured for anchorPoint below)
// fixes that directly.
outEdges.forEach((list) => list.sort((x, y) => (rectOf(x.to)?.top ?? 0) - (rectOf(y.to)?.top ?? 0)));
inEdges.forEach((list) => list.sort((x, y) => (rectOf(x.from)?.top ?? 0) - (rectOf(y.from)?.top ?? 0)));
const anchorPoint = (id, edge, side) => {
const r = rectOf(id);
if (!r) return null;
const list = (side === 'out' ? outEdges : inEdges).get(id) || [];
const idx = list.indexOf(edge);
const y = r.top + ((idx + 1) / (list.length + 1)) * r.height;
return { x: side === 'out' ? r.left + r.width : r.left, y };
};

const defs = `<defs><marker id="flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--ink)"></path></marker></defs>`;
const parts = edges.map((e) => {
const p1 = anchorPoint(e.from, e, 'out');
const p2 = anchorPoint(e.to, e, 'in');
if (!p1 || !p2) return '';
const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
// A backing rect roughly sized to the label text so it doesn't render
// unreadably crossed by the line underneath it.
const labelW = labelBoxWidth(e.label);
// A gentle S-curve -- the horizontal control-point offset is what
// makes several lines fanning out of/into the same card edge read as
// distinct paths instead of a straight-line tangle. (Its true midpoint
// is exactly (mx, my): standard cubic-bezier symmetry when both
// control points share their endpoint's y and sit at the same x, so
// the label needs no separate curve-point math.)
const path = `M${p1.x},${p1.y} C${mx},${p1.y} ${mx},${p2.y} ${p2.x},${p2.y}`;
return `<path d="${path}" fill="none" stroke="var(--ink)" stroke-width="1.5" ${e.dash || FLOW_DASH_BY_KIND[e.kind] || ''} marker-end="url(#flow-arrow)"></path>
<rect x="${mx - labelW / 2}" y="${my - 8}" width="${labelW}" height="16" rx="4" fill="var(--paper)"></rect>
<text x="${mx}" y="${my + 4}" text-anchor="middle" font-size="10" font-family="'IBM Plex Mono', monospace" fill="var(--ink)">${escapeHtml(e.label)}</text>`;
}).join('');
svg.innerHTML = defs + parts;
}

// Stagger AND lines both need real, on-screen dimensions to compute
// correctly -- neither means anything against a hidden (0x0) tab.
// redrawFlowDiagram() re-runs both together, in the right order (the
// stagger changes card positions, which the lines then have to
// measure), so nothing calling for "the diagram needs recomputing" has
// to remember there are two passes, not one.
function redrawFlowDiagram() {
const flowMount = document.getElementById('accounts-flow-mount');
if (flowMount) applySparseColumnStagger(flowMount);
drawFlowLines(flowMode);
}
let resizeTimer = null;
function scheduleFlowRedraw() {
clearTimeout(resizeTimer);
resizeTimer = setTimeout(redrawFlowDiagram, 120);
}
// Confirmed live as a real bug, more than once (including in the
// user's own real data, not just this session's own testing): the
// FIRST render often happens while the Finances tab is still hidden
// behind another one (tabs are plain display:none toggles, not
// separate routes) -- every rect involved reads 0x0 at that point, so
// the stagger sees every column as equally (non-)sparse and applies no
// offset, and nothing ever re-ran it once the tab actually became
// visible. A plain `resize` listener (the only trigger this used to
// have) never fires just from SWITCHING tabs, only from the window
// itself changing size.
//
// A ResizeObserver on the mount element looked like the textbook fix
// (MDN documents exactly this "detect a hidden element becoming
// visible" use case) but confirmed live, with an instrumented
// ResizeObserver logging every callback: it never fired at all here,
// neither on the initial (hidden, 0x0) observe() nor on the later
// display:none -> block transition. Not chasing why further.
//
// A click listener on the Finances tab BUTTON specifically was the
// next attempt, and worked... for a click. Confirmed live it still
// missed the case where the app loads straight onto #finances from
// the URL hash (app.js's own initial hash handling calls switchTab()
// directly, never through a click) -- exactly the state this tab is
// usually left in after actually using it, so this was the common
// case, not an edge case. Fixed properly at the source instead:
// tabs.js's switchTab() now fires a 'tabshown' event on EVERY switch,
// however it was triggered, and this listens for the 'finances' one.
// Bound once at module load (not render time) -- document always
// exists, no DOM-readiness guard needed the way the old button-lookup
// version did.
document.addEventListener('tabshown', (e) => { if (e.detail.tab === 'finances') scheduleFlowRedraw(); });
window.addEventListener('resize', scheduleFlowRedraw);

// Masked like a real card face ("•••• 1234") -- a light, cosmetic touch,
// not a security measure (the full number is still one click away in
// the account's own detail form).
function maskedAccountNumber(a) {
const num = String(a.accountNumber || '').replace(/\s+/g, '');
return num ? `x${num.slice(-4)}` : '';
}

// Each node rendered as a debit/credit-card-shaped face -- logo (or the
// colour+initials fallback) top-left, account type + a short masked
// number stacked top-right like an issuer wordmark, bank+account name
// below -- instead of a bare badge+label chip, so the diagram carries
// enough of an account's own identity to be read at a glance, not just
// its position in the graph. Type and number share the top row (not
// separate lines) and surplus/DD share one stats row -- kept short
// deliberately: confirmed live the original stacked-everything layout
// made cards too tall once the surplus figure was added.
function flowCardHtml(a) {
const masked = maskedAccountNumber(a);
const dd = ddCountLabel(a);
const closed = isClosed(a);
// Same "Closed" / "Closed — CASS to X" wording the collapsed row's own
// tag already uses (cassToAccount()) -- one fact, shown consistently
// wherever the account appears, not a second copy of the logic.
const closedNote = closed ? (cassToAccount(a) ? `Closed — CASS to ${cassToAccount(a).bank || accountLabel(cassToAccount(a))}` : 'Closed') : '';
const surplus = flowCardSurplusHtml(a);
const ddLine = dd ? `<div class="flow-card-dd" title="${escapeHtml(dd.title)}">DD ${escapeHtml(dd.text)}</div>` : '';
const statsRow = (surplus || ddLine) ? `<div class="flow-card-stats">${surplus}${ddLine}</div>` : '';
return `<div class="flow-card ${escapeHtml(a.colour)}${closed ? ' flow-card-closed' : ''}" data-flow-node="${escapeHtml(a.id)}">
<div class="flow-card-top">
${accountBadgeHtml(a, 'lg')}
<div class="flow-card-top-right">
<span class="flow-card-type">${escapeHtml(a.accountType)}</span>
${masked ? `<span class="flow-card-number">${escapeHtml(masked)}</span>` : ''}
</div>
</div>
<div class="flow-card-name">${escapeHtml(accountLabel(a))}</div>
${closedNote ? `<div class="flow-card-closed-note">${escapeHtml(closedNote)}</div>` : ''}
${statsRow}
</div>`;
}

// A dot is deliberately NOT styled like a real account card -- it
// isn't one, and giving it card chrome would visually claim otherwise.
// Its own edge (always exactly one) carries everything worth showing;
// the dot itself is just an anchor point for the connector line plus a
// hover tooltip (dotTitle, set in flowEdges).
function flowDotHtml(id, edges) {
const edge = edges.find((e) => e.from === id || e.to === id);
return `<div class="flow-dot" data-flow-node="${escapeHtml(id)}" title="${escapeHtml(edge?.dotTitle || '')}"></div>`;
}

// .overview-chip/.overview-chip.active is the same "pick one of a few"
// pill pattern the Tasks filter and Overview's own dimension chips
// already use -- reused as-is rather than inventing a second toggle
// style.
function flowModeToggleHtml() {
return `<div class="flow-mode-toggle">${FLOW_MODES.map((m) => `<button type="button" class="overview-chip${m.key === flowMode ? ' active' : ''}" data-flow-mode="${m.key}">${escapeHtml(m.label)}</button>`).join('')}</div>`;
}

function flowDiagramHtml() {
const toggle = flowModeToggleHtml();
const edges = flowEdges(flowMode);
if (!edges.length) {
return `${toggle}<div class="settings-note" style="margin:8px 0 12px;">${FLOW_MODE_EMPTY[flowMode]}</div>`;
}
const nodeIds = new Set();
edges.forEach((e) => { nodeIds.add(e.from); nodeIds.add(e.to); });
const columns = flowColumns(nodeIds, edges);
const cardById = new Map(data.financeAccounts.map((a) => [a.id, a]));
// Sized to THIS view's own longest label, not a flat worst-case
// constant -- confirmed live that a fixed wide gap (originally added so
// a long dated CASS label wouldn't be painted over by the next card,
// see drawFlowLines/labelBoxWidth) looked absurdly sprawling for
// Ongoing's short "£X/mo" labels, which never carry a date at all.
// One uniform gap can't perfectly fit every column boundary when label
// lengths vary a lot within the same view (a mixed graph might have one
// short edge and one long one) -- kept simple rather than computing a
// separate gap per boundary, which flexbox's single `gap` can't express
// anyway.
const gap = Math.max(60, Math.max(...edges.map((e) => labelBoxWidth(e.label))) + 30);
return `${toggle}<div class="flow-diagram" id="account-flow-diagram">
<svg class="flow-lines"></svg>
<div class="flow-columns" style="gap:${gap}px;">${columns.map((col) => `<div class="flow-column">${col.map((id) => (id.startsWith('dot-') ? flowDotHtml(id, edges) : flowCardHtml(cardById.get(id)))).join('')}</div>`).join('')}</div>
</div>`;
}

// ---- Render + bind ---------------------------------------------------------

function renderFinanceAccounts() {
const list = document.getElementById('accounts-list');
const flowMount = document.getElementById('accounts-flow-mount');
const countEl = document.getElementById('accounts-count');
if (!list) return;
if (countEl) countEl.textContent = data.financeAccounts.length + (data.financeAccounts.length === 1 ? ' account' : ' accounts');
if (flowMount) {
flowMount.innerHTML = flowDiagramHtml();
bindLogoFallbacks(flowMount);
applySparseColumnStagger(flowMount);
// A flow card is a reference to the real account row below, same as
// every other record reference in this app links back to its record
// (CLAUDE.md's record-reference standards) -- easy to miss here since
// the diagram reads as its own self-contained view, but it's still
// just another place this account is shown, not a settled destination
// in its own right.
flowMount.querySelectorAll('.flow-card').forEach((card) => {
card.addEventListener('click', () => expandAccountRow(card.dataset.flowNode));
});
flowMount.querySelectorAll('[data-flow-mode]').forEach((btn) => {
btn.addEventListener('click', () => {
flowMode = btn.dataset.flowMode;
renderFinanceAccounts();
});
});
}
list.innerHTML = data.financeAccounts.length
? data.financeAccounts.map(accountCardHtml).join('')
: '<div class="empty">No accounts tracked yet. Add one below.</div>';
bindLogoFallbacks(list);

list.querySelectorAll('details.account-card').forEach((el) => {
el.addEventListener('toggle', () => {
const id = el.dataset.accountRow;
if (el.open) expandedAccounts.add(id); else expandedAccounts.delete(id);
});
});
list.querySelectorAll('[data-field][data-account-id]').forEach((el) => {
el.addEventListener('change', () => {
const a = data.financeAccounts.find((x) => x.id === el.dataset.accountId);
if (!a) return;
const field = el.dataset.field;
a[field] = el.type === 'checkbox' ? el.checked : el.value.trim();
// dealOngoing/dealEndDate are mutually exclusive -- a deal can't be
// both "ongoing, no end date" and have a specific end date at once,
// so setting either one clears the other.
if (field === 'dealOngoing' && a.dealOngoing) a.dealEndDate = '';
if (field === 'dealEndDate' && a.dealEndDate) a.dealOngoing = false;
queueSave();
renderFinanceAccounts();
});
});
// The "Funded from" select fans out to THREE different fields
// depending on what's picked (a tracked account, a preset source, or
// "Other"), so it can't use the generic one-field-in-one-field-out
// handler above -- every option clears the other two, keeping exactly
// one of fundingFromAccountId/fundingSource/fundingSourceOther live at
// once.
list.querySelectorAll('[data-funding-source-select]').forEach((sel) => {
sel.addEventListener('change', () => {
const a = data.financeAccounts.find((x) => x.id === sel.dataset.fundingSourceSelect);
if (!a) return;
const v = sel.value;
a.fundingFromAccountId = '';
a.fundingSource = '';
a.fundingSourceOther = false;
if (v === '__other__') a.fundingSourceOther = true;
else if (FUNDING_SOURCE_PRESETS.includes(v)) a.fundingSource = v;
else if (v) a.fundingFromAccountId = v;
queueSave();
renderFinanceAccounts();
});
});
// A dedicated `blur` handler on just the bank field, separate from the
// generic `change`-based save above -- `change` only fires when a
// field's value actually differs from what it was on focus, so simply
// re-confirming an already-correct bank name (nothing to "change") would
// never reach the change handler at all. `blur` fires every time the
// field is left regardless, which is exactly "retype the name (or just
// tab through it again) and it still tries to fill in a blank logo."
list.querySelectorAll('[data-field="bank"][data-account-id]').forEach((el) => {
el.addEventListener('blur', () => {
const a = data.financeAccounts.find((x) => x.id === el.dataset.accountId);
if (!a || a.logoUrl) return;
const match = matchBankLogo(el.value.trim() || a.bank);
if (!match) return;
a.logoUrl = match;
queueSave();
renderFinanceAccounts();
});
});
list.querySelectorAll('[data-dd-add]').forEach((btn) => {
btn.addEventListener('click', () => {
const id = btn.dataset.ddAdd;
const beneficiaryInput = list.querySelector(`[data-dd-beneficiary="${id}"]`);
const amountInput = list.querySelector(`[data-dd-amount="${id}"]`);
const methodSelect = list.querySelector(`[data-dd-method="${id}"]`);
const toAccountSelect = list.querySelector(`[data-dd-to-account="${id}"]`);
const beneficiary = beneficiaryInput.value.trim();
const toAccountId = toAccountSelect.value;
// A picked "pays into" account already identifies the outgoing on its
// own (accountLabel() falls back to it, see outgoingsHtml) -- only
// require typed text when there's no such link.
if (!beneficiary && !toAccountId) return;
const a = data.financeAccounts.find((x) => x.id === id);
if (!a) return;
if (!Array.isArray(a.outgoings)) a.outgoings = [];
a.outgoings.push({ id: uid(), beneficiary, amount: amountInput.value.trim(), status: '', method: methodSelect.value, toAccountId });
beneficiaryInput.value = '';
amountInput.value = '';
methodSelect.value = OUTGOING_METHODS[0];
toAccountSelect.value = '';
queueSave();
renderFinanceAccounts();
});
});
list.querySelectorAll('[data-dd-remove]').forEach((x) => {
x.addEventListener('click', () => {
const [id, ddId] = x.dataset.ddRemove.split(':');
const a = data.financeAccounts.find((acc) => acc.id === id);
if (!a) return;
a.outgoings = (a.outgoings || []).filter((o) => o.id !== ddId);
queueSave();
renderFinanceAccounts();
});
});
list.querySelectorAll('[data-dd-status-cycle]').forEach((el) => {
el.addEventListener('click', () => {
const [id, ddId] = el.dataset.ddStatusCycle.split(':');
const a = data.financeAccounts.find((acc) => acc.id === id);
const o = a && (a.outgoings || []).find((x) => x.id === ddId);
if (!o) return;
o.status = outgoingStatusCycle(o.status);
queueSave();
renderFinanceAccounts();
});
});
list.querySelectorAll('[data-open-account-ref]').forEach((el) => {
el.addEventListener('click', () => expandAccountRow(el.dataset.openAccountRef));
});
list.querySelectorAll('[data-bt-add]').forEach((btn) => {
btn.addEventListener('click', () => {
const id = btn.dataset.btAdd;
const fromSelect = list.querySelector(`[data-bt-from="${id}"]`);
const amountInput = list.querySelector(`[data-bt-amount="${id}"]`);
const dateInput = list.querySelector(`[data-bt-date="${id}"]`);
const fromAccountId = fromSelect.value;
if (!fromAccountId) return;
const a = data.financeAccounts.find((x) => x.id === id);
if (!a) return;
if (!Array.isArray(a.balanceTransfers)) a.balanceTransfers = [];
a.balanceTransfers.push({ id: uid(), fromAccountId, amount: amountInput.value.trim(), date: dateInput.value });
fromSelect.value = '';
amountInput.value = '';
dateInput.value = '';
queueSave();
renderFinanceAccounts();
});
});
list.querySelectorAll('[data-bt-remove]').forEach((x) => {
x.addEventListener('click', () => {
const [id, btId] = x.dataset.btRemove.split(':');
const a = data.financeAccounts.find((acc) => acc.id === id);
if (!a) return;
a.balanceTransfers = (a.balanceTransfers || []).filter((bt) => bt.id !== btId);
queueSave();
renderFinanceAccounts();
});
});
list.querySelectorAll('[data-colour-pick]').forEach((sw) => {
sw.addEventListener('click', () => {
const [id, colour] = sw.dataset.colourPick.split(':');
const a = data.financeAccounts.find((x) => x.id === id);
if (!a) return;
a.colour = colour;
queueSave();
renderFinanceAccounts();
});
});
list.querySelectorAll('[data-del-account]').forEach((x) => {
x.addEventListener('click', () => {
const id = x.dataset.delAccount;
data.financeAccounts = data.financeAccounts.filter((a) => a.id !== id);
// Same orphan-drop reasoning as the state.js migration guard --
// another account's link to this one is now dangling.
data.financeAccounts.forEach((a) => {
if (a.cassFromAccountId === id) a.cassFromAccountId = '';
if (a.fundingFromAccountId === id) a.fundingFromAccountId = '';
a.balanceTransfers = (a.balanceTransfers || []).filter((bt) => bt.fromAccountId !== id);
// An outgoing's toAccountId is optional enrichment, not the whole
// point of the entry (the beneficiary text stands alone) -- clear it
// back to an ordinary external-looking outgoing rather than dropping
// the entry, same reasoning as state.js's own orphan-cleanup guard.
(a.outgoings || []).forEach((o) => { if (o.toAccountId === id) o.toAccountId = ''; });
});
expandedAccounts.delete(id);
queueSave();
renderFinanceAccounts();
});
});

drawFlowLines(flowMode);
}

function initFinanceAccountForm() {
bindForm('account-form', () => {
const bankInput = document.getElementById('account-bank-input');
const nameInput = document.getElementById('account-name-input');
const bank = bankInput.value.trim();
const name = nameInput.value.trim();
if (!bank && !name) return;
data.financeAccounts.push(blankFinanceAccount({ bank, name, logoUrl: matchBankLogo(bank) || '' }));
bankInput.value = '';
nameInput.value = '';
renderFinanceAccounts();
queueSave();
});
}

// Nudge-driven reveal -- same shape as connections.js's expandConnection:
// mark it open, re-render, then scroll+flash the real row once it exists.
function expandAccountRow(id) {
expandedAccounts.add(id);
renderFinanceAccounts();
setTimeout(() => scrollAndFlash(`[data-account-row="${id}"]`), 50);
}

export { renderFinanceAccounts, initFinanceAccountForm, expandAccountRow, accountLabel, formatShortDate };
