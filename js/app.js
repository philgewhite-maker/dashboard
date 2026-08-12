import { loadData, setSaveStatusHandler, setExternalUpdateHandler, flushSave } from './state.js';
import { renderAll } from './render-all.js';
import { switchTab } from './tabs.js';
import { initHabitForm } from './features/habits.js';
import { initGoalForm } from './features/goals.js';
import { initJobForm } from './features/jobs.js';
import { initConnectionForm, initSensitiveFields } from './features/connections.js';
import { initOverviewPrefs } from './features/overview.js';
import { initCalendarForm, initCalendarSync, initCalendarListLoader } from './features/calendars.js';
import { initVoucherForm } from './features/vouchers.js';
import { initSubscriptionForm } from './features/subscriptions.js';
import { initDealForm } from './features/dealexpiries.js';
import { initIdeaForm } from './features/ideas.js';
import { initEnhancementForm } from './features/enhancements.js';
import { initNudges } from './features/nudges.js';
import { initSettings } from './features/settings.js';
import { initGoogleAccount } from './features/googleaccount.js';
import { initMail } from './features/mail.js';
import { initAutoSync } from './sync/autosync.js';

function initTabs() {
document.querySelectorAll('[data-tab-btn]').forEach((btn) => {
btn.addEventListener('click', () => switchTab(btn.dataset.tabBtn));
});
switchTab('overview');
}

function initSaveNote() {
const note = document.getElementById('save-note');
setSaveStatusHandler((status) => {
if (!note) return;
if (status === 'ok') note.textContent = 'Changes save automatically on this device';
else if (status === 'conflict') note.textContent = 'Reloaded newer data found on disk — your last change here may not have been saved. Check it and redo it if needed.';
else note.textContent = "Couldn't save — your browser may be low on storage or in private mode";
});
setExternalUpdateHandler(() => renderAll());
}

// A debounced save can lose its last ~250ms of edits if the tab is closed,
// refreshed, or backgrounded before the timer fires — the pending
// setTimeout is simply cancelled when the page tears down. visibilitychange
// (tab hidden, app switched, phone locked) and pagehide (navigation, tab
// close) cover the ways that happens; flushing on both is what actually
// closes the gap, not just a shorter debounce.
function initSaveFlush() {
document.addEventListener('visibilitychange', () => {
if (document.visibilityState === 'hidden') flushSave();
});
window.addEventListener('pagehide', () => { flushSave(); });
}

function registerServiceWorker() {
if ('serviceWorker' in navigator) {
window.addEventListener('load', () => {
navigator.serviceWorker.register('./sw.js').catch(() => { /* offline support is best-effort */ });
});
}
}

async function main() {
document.getElementById('today-date').textContent = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

initSaveNote();
initSaveFlush();
await loadData();
// Both read device-local display preferences that renderAll() depends on
// (which tag fields are visible, which overview sections are folded), so
// they have to land before the first paint or it renders once wrong.
await Promise.all([initSensitiveFields(), initOverviewPrefs()]);
renderAll();

initTabs();
initGoogleAccount();
initMail();
initHabitForm();
initGoalForm();
initJobForm();
initConnectionForm();
initCalendarForm();
initCalendarSync();
initCalendarListLoader();
initVoucherForm();
initSubscriptionForm();
initDealForm();
initIdeaForm();
initEnhancementForm();
initNudges();
await initSettings();
registerServiceWorker();
// Last, and deliberately not awaited: it does network I/O, and nothing else
// on the page should wait on a slow or unreachable server to become usable.
initAutoSync();
}

main();
