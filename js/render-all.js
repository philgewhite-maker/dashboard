import { renderHabits } from './features/habits.js';
import { renderGoals } from './features/goals.js';
import { renderJobs } from './features/jobs.js';
import { renderConnections, renderPendingImports } from './features/connections.js';
import { renderCalendars } from './features/calendars.js';
import { renderVouchers } from './features/vouchers.js';
import { renderSubscriptions } from './features/subscriptions.js';
import { renderDealExpiries } from './features/dealexpiries.js';
import { renderBusinessIdeas } from './features/ideas.js';
import { renderEnhancementIdeas } from './features/enhancements.js';
import { renderOverview } from './features/overview.js';
import { renderTasks } from './features/tasks.js';
import { renderCaptureInbox } from './features/captureinbox.js';
// renderHealthDaily() (below) already triggers a chart refresh itself, same
// as renderRenphoDaily()/renderWellnessDaily() do -- see health.js's own
// comment on why, so there's no separate renderHealthChart() call needed
// here.
import { renderHealthDaily } from './features/health.js';
import { renderRenphoDaily } from './features/renpho.js';
import { renderWellnessDaily } from './features/wellness.js';
import { renderTravel } from './features/travel.js';
import { renderPlanner } from './features/planner.js';
import { renderNudges } from './features/nudges.js';
import { renderTagCleanup } from './features/tagcleanup.js';

function renderAll() {
renderHabits();
renderGoals();
renderJobs();
renderConnections();
renderPendingImports();
renderCalendars();
renderVouchers();
renderSubscriptions();
renderDealExpiries();
renderBusinessIdeas();
renderEnhancementIdeas();
renderTasks();
renderCaptureInbox();
renderHealthDaily();
renderRenphoDaily();
renderWellnessDaily();
renderTravel();
renderPlanner();
renderOverview();
renderNudges();
renderTagCleanup();
}

export { renderAll };
