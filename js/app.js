import { loadData, setSaveStatusHandler, setExternalUpdateHandler, flushSave } from './state.js';
import { renderAll } from './render-all.js';
import { switchTab } from './tabs.js';
import { initHabitForm } from './features/habits.js';
import { initGoalForm } from './features/goals.js';
import { initJobForm } from './features/jobs.js';
import { initConnectionForm, initSensitiveFields, initRatingCategoriesSettings, initFlagRulesSettings, initHideArchivedFaded } from './features/connections.js';
import { initOverviewPrefs } from './features/overview.js';
import { initCalendarForm, initCalendarSync, initCalendarListLoader } from './features/calendars.js';
import { initVoucherForm } from './features/vouchers.js';
import { initSubscriptionForm } from './features/subscriptions.js';
import { initDealForm } from './features/dealexpiries.js';
import { initShopping } from './features/shopping.js';
import { initRecipes } from './features/recipes.js';
import { initIdeaForm } from './features/ideas.js';
import { initEnhancementForm } from './features/enhancements.js';
import { initTasks } from './features/tasks.js';
import { initGoogleTasksFeed } from './features/googletasksfeed.js';
import { initQuestions } from './features/questions.js';
import { initContacts } from './features/contacts.js';
import { initPhotoScan } from './features/photoscan.js';
import { initPhotoAlbums } from './features/photoalbums.js';
import { initTinderImport } from './features/tinderimport.js';
import { initDatingImport } from './features/manualimport.js';
import { initWhatsAppImport } from './features/whatsappimport.js';
import { initTelegramImport } from './features/telegramimport.js';
import { initPhotoSync } from './features/photosync.js';
import { initHealthSync, initHealthDaily, initHealthChart } from './features/health.js';
import { initAirbnbListingsForm, initAirbnbSync } from './features/airbnb.js';
import { initLocationFillIns } from './features/tagcleanup.js';
import { initPhotoQuality } from './features/photoquality.js';
import { initShareTarget } from './features/sharetarget.js';
import { initCaptureInbox } from './features/captureinbox.js';
import { initTravel } from './features/travel.js';
import { initPlanner } from './features/planner.js';
// Photos whose bytes aren't on this device are fetched from your own host.
// Registered rather than imported: the implementation reaches state.js, and
// state.js imports utils.js, so importing it back would be a cycle.
import { setPhotoFallback, scrollAndFlash } from './utils.js';
import { serverPhotoUrl } from './files.js';
// Imported for its side effect: it registers the Notion controls with
// tasks.js, which keeps that dependency pointing one way.
import './features/notionplan.js';
import { initNudges } from './features/nudges.js';
import { initSettings } from './features/settings.js';
import { initGoogleAccount } from './features/googleaccount.js';
import { initMail } from './features/mail.js';
import { initAutoSync } from './sync/autosync.js';

function initTabs() {
document.querySelectorAll('[data-tab-btn]').forEach((btn) => {
btn.addEventListener('click', () => switchTab(btn.dataset.tabBtn));
});
// A task's `link` (or any pasted URL) can point at #<tab> to open the app
// straight onto that tab — falls back to overview for a missing/unknown
// hash rather than landing on a blank tab bar with nothing shown. An
// optional #<tab>:<connId> suffix (used by "Save & open profile" in the
// Tinder importer, since this is a single-page app with no other way to
// give a connection its own real URL) also expands and scrolls to that
// connection once the tab's switched to.
const validTabs = new Set([...document.querySelectorAll('[data-tab-btn]')].map((b) => b.dataset.tabBtn));
const [fromHash, connId] = location.hash.slice(1).split(':');
switchTab(validTabs.has(fromHash) ? fromHash : 'overview');
if (connId) {
import('./features/connections.js').then((m) => {
m.expandConnection(connId);
setTimeout(() => scrollAndFlash(`[data-conn-row="${connId}"]`), 80);
});
}
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
if (!('serviceWorker' in navigator)) return;
// Called from deep inside main(), well after several awaited IndexedDB
// round-trips -- by then the page's own `load` event has almost always
// already fired (confirmed live: registrations were empty on a totally
// clean load, every time), and a listener attached after an event fires
// never receives it. Register immediately if the page is already done
// loading; only wait for `load` if it genuinely hasn't happened yet.
const register = () => navigator.serviceWorker.register('./sw.js').catch(() => { /* offline support is best-effort */ });
if (document.readyState === 'complete') register();
else window.addEventListener('load', register);
}

async function main() {
document.getElementById('today-date').textContent = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

initSaveNote();
initSaveFlush();
// Must be set before the first renderAll(), or that paint marks every
// server-held photo as missing.
setPhotoFallback(serverPhotoUrl);
await loadData();
// Both read device-local display preferences that renderAll() depends on
// (which tag fields are visible, which overview sections are folded), so
// they have to land before the first paint or it renders once wrong.
await Promise.all([initSensitiveFields(), initOverviewPrefs(), initHideArchivedFaded()]);
renderAll();

initTabs();
initGoogleAccount();
initMail();
initHabitForm();
initGoalForm();
initJobForm();
initConnectionForm();
initRatingCategoriesSettings();
initFlagRulesSettings();
initCalendarForm();
initCalendarSync();
initCalendarListLoader();
initVoucherForm();
initSubscriptionForm();
initDealForm();
initShopping();
initRecipes();
initIdeaForm();
initEnhancementForm();
initTasks();
initCaptureInbox();
initTravel();
initPlanner();
initGoogleTasksFeed();
initQuestions();
initContacts();
initPhotoScan();
initPhotoAlbums();
initTinderImport();
initWhatsAppImport();
initDatingImport();
initTelegramImport();
initPhotoSync();
initHealthSync();
initHealthDaily();
initHealthChart();
initAirbnbListingsForm();
initAirbnbSync();
initLocationFillIns();
initPhotoQuality();
initNudges();
await initSettings();
registerServiceWorker();
// After the panels are wired, so the captured task renders into a live UI.
// Not awaited — an upload of a shared file shouldn't hold up the page.
initShareTarget();
// Last, and deliberately not awaited: it does network I/O, and nothing else
// on the page should wait on a slow or unreachable server to become usable.
initAutoSync();
}

main();
