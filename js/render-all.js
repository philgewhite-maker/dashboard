import { renderHabits } from './features/habits.js';
import { renderGoals } from './features/goals.js';
import { renderJobs } from './features/jobs.js';
import { renderConnections } from './features/connections.js';
import { renderCalendars } from './features/calendars.js';
import { renderVouchers } from './features/vouchers.js';
import { renderSubscriptions } from './features/subscriptions.js';
import { renderDealExpiries } from './features/dealexpiries.js';
import { renderBusinessIdeas } from './features/ideas.js';
import { renderEnhancementIdeas } from './features/enhancements.js';
import { renderOverview } from './features/overview.js';
import { renderTasks } from './features/tasks.js';
import { renderCaptureInbox } from './features/captureinbox.js';
import { renderHealthDaily } from './features/health.js';
import { renderNudges } from './features/nudges.js';
import { renderTagCleanup } from './features/tagcleanup.js';

function renderAll() {
renderHabits();
renderGoals();
renderJobs();
renderConnections();
renderCalendars();
renderVouchers();
renderSubscriptions();
renderDealExpiries();
renderBusinessIdeas();
renderEnhancementIdeas();
renderTasks();
renderCaptureInbox();
renderHealthDaily();
renderOverview();
renderNudges();
renderTagCleanup();
}

export { renderAll };
