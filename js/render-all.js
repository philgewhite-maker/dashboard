import { bumpViewGen } from './viewstamp.js';
import { renderHabits } from './features/habits.js';
import { renderGoals } from './features/goals.js';
import { renderJobs } from './features/jobs.js';
import { renderConnections, renderPendingImports } from './features/connections.js';
import { renderCalendars } from './features/calendars.js';
import { renderAirbnb, renderAirbnbKeys } from './features/airbnb.js';
import { renderVouchers } from './features/vouchers.js';
import { renderSubscriptions } from './features/subscriptions.js';
import { renderFinanceAccounts } from './features/financeaccounts.js';
import { renderSwitchOffers } from './features/switchoffers.js';
import { renderYearlyPerks } from './features/yearlyperks.js';
import { renderBusinessIdeas } from './features/ideas.js';
import { renderEnhancementIdeas } from './features/enhancements.js';
import { renderOverview } from './features/overview.js';
import { renderTasks } from './features/tasks.js';
import { renderCaptureInbox } from './features/captureinbox.js';
import { renderAgentInbox } from './features/agentinbox.js';
import { renderReadingList } from './features/readinglist.js';
import { renderMedia } from './features/media.js';
import { renderFamily } from './features/family.js';
import { renderCaptureDrafts } from './features/voicecapture.js';
// renderHealthDaily() (below) already triggers a chart refresh itself, same
// as renderRenphoDaily()/renderWellnessDaily() do -- see health.js's own
// comment on why, so there's no separate renderHealthChart() call needed
// here.
import { renderHealthDaily } from './features/health.js';
import { renderRenphoDaily } from './features/renpho.js';
import { renderWellnessDaily } from './features/wellness.js';
import { renderTravel } from './features/travel.js';
import { renderMarriottAvailability } from './features/marriottavailability.js';
import { renderLoyaltyBalances } from './features/loyaltybalances.js';
import { renderApOrders } from './features/aporders.js';
import { renderPlanner } from './features/planner.js';
import { renderNudges } from './features/nudges.js';
import { renderTagCleanup } from './features/tagcleanup.js';
import { renderTelegramFamily } from './features/telegramfamily.js';
// These used to be missing from renderAll(), so a remote sync left them
// showing the old data until a reload.
import { renderLetting } from './features/letting.js';
import { renderLoans } from './features/loans.js';
import { renderTicker } from './features/ticker.js';
import { renderLeave } from './features/leave.js';
import { renderBooks } from './features/books.js';
import { renderSchoolCalendar } from './features/schoolcalendar.js';
import { refreshShopping } from './features/shopping.js';
import { renderDayQueue } from './features/dayqueue.js';

// Every renderer with the tab (data-tab) its panel lives on, in the original
// renderAll() order (some read what an earlier one drew, e.g. Overview after
// Connections). tab null = lives outside every tab (the ticker strip), so it is
// always drawn. Verified against index.html: each panel's closest [data-tab].
const RENDERERS = [
  [renderHabits, 'overview'],
  [renderGoals, 'overview'],
  [renderJobs, 'jobhunt'],
  [renderConnections, 'dating'],
  [renderDayQueue, 'dating'],
  [renderPendingImports, 'dating'],
  [renderCalendars, 'overview'],
  [renderAirbnb, 'overview'],
  [renderAirbnbKeys, 'overview'],
  [renderVouchers, 'finances'],
  [renderSubscriptions, 'finances'],
  [renderFinanceAccounts, 'finances'],
  [renderSwitchOffers, 'finances'],
  [renderYearlyPerks, 'finances'],
  [renderBusinessIdeas, 'business'],
  [renderEnhancementIdeas, 'settings'],
  [renderTasks, 'tasks'],
  [renderCaptureInbox, 'tasks'],
  [renderAgentInbox, 'tasks'],
  [renderReadingList, 'media'],
  [renderMedia, 'media'],
  [renderFamily, 'family'],
  [renderCaptureDrafts, 'tasks'],
  [renderHealthDaily, 'health'],
  [renderRenphoDaily, 'health'],
  [renderWellnessDaily, 'health'],
  [renderTravel, 'travel'],
  [renderMarriottAvailability, 'travel'],
  [renderLoyaltyBalances, 'finances'],
  [renderApOrders, 'shopping'],
  [renderPlanner, 'planner'],
  [renderOverview, 'dating'],
  [renderNudges, 'overview'],
  [renderTagCleanup, 'settings'],
  [renderTelegramFamily, 'settings'],
  [renderLetting, 'finances'],
  [renderLoans, 'finances'],
  [renderTicker, null],
  [renderLeave, 'travel'],
  [renderBooks, 'family'],
  [renderSchoolCalendar, 'family'],
  [refreshShopping, 'shopping'],
];

// Tabs whose renderers have not run since the data last changed. A tab leaves
// this set when it is opened (renderTab, called synchronously by switchTab
// BEFORE tabshown is dispatched, so a goto link / record chip that switches tab
// and then expands or scrolls to a card always finds it already drawn).
const staleTabs = new Set();
const TAB_NAMES = [...new Set(RENDERERS.map((r) => r[1]).filter(Boolean))];

// A panel that is not ready yet must not stop the rest.
function safely(fn) { try { fn(); } catch (err) { console.error(`renderAll: ${fn.name || "a panel"} failed:`, err); } }

// renderAll()                 draws every panel (remote adopt fallbacks, import, settings).
// renderAll({ onlyTab: 'x' }) draws tab x's panels plus the always-visible ones and marks every
//                             other tab stale; onlyTab null/'' draws only the always-visible ones
//                             (boot: the first switchTab draws the opened tab right after).
function renderAll(opts) {
bumpViewGen(); // js/viewstamp.js: whole-app redraw (import, adopt fallback) -> skip-on-show charts must redraw
const lazy = !!opts && Object.prototype.hasOwnProperty.call(opts, 'onlyTab');
const only = lazy ? opts.onlyTab : null;
RENDERERS.forEach(([fn, tab]) => {
if (lazy && tab && tab !== only) return;
if (lazy) safely(fn); else fn();
});
staleTabs.clear();
if (lazy) TAB_NAMES.forEach((t) => { if (t !== only) staleTabs.add(t); });
}

// Draws a tab that renderAll({onlyTab}) skipped. No-op for a tab that is current.
function renderTab(tab) {
if (!staleTabs.delete(tab)) return;
RENDERERS.forEach(([fn, t]) => { if (t === tab) safely(fn); });
}

// After boot, draw the still-stale tabs one per idle slot, so the first visit to a heavy tab (Contacts took 2.4 s on the
// owner's data, Settings 1.1 s, Finances 0.6 s, measured 16 Nov 2026) usually finds it already drawn, without putting
// that cost back into startup. A tab drawn by switchTab first is simply skipped (renderTab is a no-op once current).
function prewarmStaleTabs({ delayMs = 4000 } = {}) {
const idle = (fn) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 10000 }) : setTimeout(fn, 200));
const next = () => {
const tab = TAB_NAMES.find((t) => staleTabs.has(t));
if (!tab) return;
idle(() => { renderTab(tab); next(); });
};
setTimeout(next, delayMs);
}

export { renderAll, renderTab, prewarmStaleTabs };
