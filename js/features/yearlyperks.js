// Yearly payments a bank makes for keeping and using an account -- today only
// Nationwide's "Fairer Share" (about £100, announced with its May results and
// paid in June, never guaranteed). The bank-switch advisor's shared cache
// carries the definition (`annualPerks`, hand-kept there); this turns it into
// dated reminders for a Nationwide account you actually hold.
//
// The reminders are ordinary tasks under one project, tagged
// source.kind === 'yearly perk'. Each starts hidden (bringForward) and wakes
// on the day it matters, so the Tasks tab only ever shows what is live. The
// ticker derives its "Perk" tile from the same tasks (ticker.js,
// yearlyPerkItems): present while any reminder is awake, gone when they are
// ticked off -- the same way the CASS tile follows a bonus still being
// "Working on".
import { data, queueSave } from '../state.js';
import { escapeHtml, todayStr } from '../utils.js';
import { captureTask, revealTask } from './tasks.js';
import { accountLabel, expandAccountRow } from './financeaccounts.js';

export const PERK_TASK_KIND = 'yearly perk';
const FAIRER_SHARE = 'nationwide-fairer-share';

function perkById(id) { return (data.annualPerks || []).find((p) => p.id === id) || null; }

// Nationwide itself; Virgin Money shares its banking group but missed the 2026 round.
function isFairerShareBank(bank) { return /nationwide/i.test(bank || '') && !/virgin/i.test(bank || ''); }

function openNationwideAccounts() {
const today = todayStr();
return (data.financeAccounts || []).filter((a) => isFairerShareBank(a.bank) && !(a.closeDate && a.closeDate <= today));
}

// The next window that hasn't finished, as ISO dates.
function windowFor(perk) {
const today = todayStr();
let y = Number(today.slice(0, 4));
const pad = (n) => String(n).padStart(2, '0');
const lastDay = (yr, m) => new Date(yr, m, 0).getDate();
const endMonth = perk.windowEndMonth || 3;
let end = `${y}-${pad(endMonth)}-${lastDay(y, endMonth)}`;
if (today > end) { y += 1; end = `${y}-${pad(endMonth)}-${lastDay(y, endMonth)}`; }
return { year: y, start: `${y}-${pad(perk.windowStartMonth || 1)}-01`, end, pad, lastDay };
}

function state() {
if (!data.prefs.yearlyPerkTasks || typeof data.prefs.yearlyPerkTasks !== 'object') data.prefs.yearlyPerkTasks = {};
return data.prefs.yearlyPerkTasks;
}

function createReminders(perk, account) {
const w = windowFor(perk);
const label = accountLabel(account);
const money = `£${Number(perk.amount || 100).toLocaleString('en-GB')}`;
const source = { kind: PERK_TASK_KIND, label: perk.name, url: perk.url || '', amount: perk.amount || 100 };
const parent = captureTask({
title: `${perk.name} ${w.year} (${money}, not guaranteed)`,
notes: `${perk.note || ''}\nAccount: ${label}. Reminders below wake on the day they matter.`.trim(),
source, due: w.end, bucket: 'project',
});
const when = (y, m, d) => `${y}-${w.pad(m)}-${w.pad(d)}`;
const y = w.year;
const steps = [
[when(y, 1, 1), when(y, 1, 31), `Fairer Share: use the ${label} account this month — £500+ in from another bank and two payments out, or 10+ payments out (card, Direct Debit, transfer; not transfers to other Nationwide accounts). It needs two of January–March.`],
[when(y, 2, 1), when(y, 2, w.lastDay(y, 2)), `Fairer Share: second month — do the same again on ${label}, unless the switch itself completed in this window.`],
[when(y, 3, 1), when(y, 3, 31), `Fairer Share: put £${perk.savingsMin || 100}+ into a Nationwide savings account for March (the Flex Regular Saver is the usual one), and keep ${label} open until 31 March.`],
[when(y, 4, 1), when(y, 4, 30), `Fairer Share: the window has closed — ${label} can be switched away or closed now if you want to. The payment is decided with Nationwide's May results.`],
[when(y, 6, 10), when(y, 6, 30), `Check whether the ${money} Fairer Share arrived (it usually lands in June, if Nationwide repeats it). Taxable as savings interest.`],
];
const ids = [parent.id];
for (const [bringForward, due, title] of steps) {
const t = captureTask({ title, source, due, bucket: 'next', parentId: parent.id });
t.bringForward = bringForward > todayStr() ? bringForward : '';
ids.push(t.id);
}
state()[perk.id] = { year: w.year, parentId: parent.id };
queueSave();
return parent;
}

function rowHtml(perk, accounts) {
const w = windowFor(perk);
const made = state()[perk.id];
const live = made && made.year === w.year && data.tasks.some((t) => t.id === made.parentId);
const account = accounts[0];
return `<div class="switch-offer-row">
<div class="switch-offer-head">
<span class="switch-offer-bank">${escapeHtml(perk.name)}</span>
<span class="tag-chip">about £${escapeHtml(String(perk.amount || 100))} a year, not guaranteed</span>
${live
? `<span class="dd-to-account-link" data-open-task-ref="${escapeHtml(made.parentId)}">&rarr; View reminders</span>`
: `<button class="sync-btn inline" type="button" data-perk-reminders="${escapeHtml(perk.id)}">Create reminders</button>`}
</div>
<div class="switch-offer-reasoning">Keep ${escapeHtml(accountLabel(account))} open to 31 March ${w.year}, use it in two of January–March, and have £${escapeHtml(String(perk.savingsMin || 100))}+ in a Nationwide savings account in March. Dated reminders wake on the day each matters, and a tile shows in the ticker while any is due.</div>
<span class="dd-to-account-link" data-open-account-ref="${escapeHtml(account.id)}">&rarr; ${escapeHtml(accountLabel(account))}</span>
</div>`;
}

export function renderYearlyPerks() {
const list = document.getElementById('yearly-perks-list');
if (!list) return;
const perk = perkById(FAIRER_SHARE);
const accounts = openNationwideAccounts();
if (!perk || !accounts.length) { list.innerHTML = ''; return; }
list.innerHTML = rowHtml(perk, accounts);
list.querySelectorAll('[data-perk-reminders]').forEach((btn) => {
btn.addEventListener('click', () => {
createReminders(perk, accounts[0]);
renderYearlyPerks();
});
});
list.querySelectorAll('[data-open-account-ref]').forEach((el) => {
el.addEventListener('click', () => expandAccountRow(el.dataset.openAccountRef));
});
list.querySelectorAll('[data-open-task-ref]').forEach((el) => {
el.addEventListener('click', async () => {
const { switchTab } = await import('../tabs.js');
switchTab('tasks');
revealTask(el.dataset.openTaskRef);
});
});
}
