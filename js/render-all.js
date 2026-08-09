import { renderHabits } from './features/habits.js';
import { renderGoals } from './features/goals.js';
import { renderJobs } from './features/jobs.js';
import { renderConnections } from './features/connections.js';
import { renderCalendars } from './features/calendars.js';
import { renderVouchers } from './features/vouchers.js';
import { renderBusinessIdeas } from './features/ideas.js';
import { renderOverview } from './features/overview.js';
import { renderNudges } from './features/nudges.js';

function renderAll() {
renderHabits();
renderGoals();
renderJobs();
renderConnections();
renderCalendars();
renderVouchers();
renderBusinessIdeas();
renderOverview();
renderNudges();
}

export { renderAll };
