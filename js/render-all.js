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

// The panels added later run before their init function on the very first paint; one that is not ready yet must not stop the rest.
function safely(fn) { try { fn(); } catch (err) { console.error(`renderAll: ${fn.name || "a panel"} failed:`, err); } }

function renderAll() {
renderHabits();
renderGoals();
renderJobs();
renderConnections();
renderPendingImports();
renderCalendars();
renderAirbnb();
renderAirbnbKeys();
renderVouchers();
renderSubscriptions();
renderFinanceAccounts();
renderSwitchOffers();
renderYearlyPerks();
renderBusinessIdeas();
renderEnhancementIdeas();
renderTasks();
renderCaptureInbox();
renderAgentInbox();
renderReadingList();
renderMedia();
renderFamily();
renderCaptureDrafts();
renderHealthDaily();
renderRenphoDaily();
renderWellnessDaily();
renderTravel();
renderMarriottAvailability();
renderLoyaltyBalances();
renderApOrders();
renderPlanner();
renderOverview();
renderNudges();
renderTagCleanup();
renderTelegramFamily();
safely(renderLetting);
safely(renderLoans);
safely(renderTicker);
safely(renderLeave);
safely(renderBooks);
safely(renderSchoolCalendar);
safely(refreshShopping);
}

export { renderAll };
