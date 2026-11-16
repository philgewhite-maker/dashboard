// Keeps every panel that shows a piece of data in step after it changes.
//
// state.js tells this module which top-level keys of `data` changed after
// each save. The table below says which panels show each key, so e.g.
// confirming a voucher reading in one panel redraws the Loyalty card that
// shows it too, instead of waiting for a reload. It re-renders only what a
// changed key actually feeds.
//
// Scheduling is the careful part, because re-drawing a panel while you are
// typing in it would eat your input:
//  - a panel you are typing in (focus inside an input/select/textarea) is
//    left alone and redrawn once focus leaves it;
//  - a panel on a hidden tab is redrawn straight away (it can't hold focus)
//    unless it is heavy, in which case it waits until you open that tab;
//  - heavy panels (connections, overview, nudges) and the ticker are
//    debounced, and the nudges are only redrawn when you open their tab
//    (their redraw re-shuffles and can make a paid AI call).
import { data, onDataChange, baselineDataSignatures } from './state.js';
import { renderAll } from './render-all.js';
import { renderHabits } from './features/habits.js';
import { renderGoals } from './features/goals.js';
import { renderJobs } from './features/jobs.js';
import { renderPendingImports } from './features/connections.js';
import { renderYearlyPerks } from './features/yearlyperks.js';
import { renderBusinessIdeas } from './features/ideas.js';
import { renderEnhancementIdeas } from './features/enhancements.js';
import { renderReadingList } from './features/readinglist.js';
import { renderMedia } from './features/media.js';
import { renderHealthDaily } from './features/health.js';
import { renderRenphoDaily } from './features/renpho.js';
import { renderWellnessDaily } from './features/wellness.js';
import { renderMarriottAvailability } from './features/marriottavailability.js';
import { renderApOrders } from './features/aporders.js';
import { renderTagCleanup } from './features/tagcleanup.js';
import { renderTelegramFamily } from './features/telegramfamily.js';
import { renderBooks } from './features/books.js';
import { renderSchoolCalendar } from './features/schoolcalendar.js';
import { refreshShopping } from './features/shopping.js';
import { renderDayQueue } from './features/dayqueue.js';
import { renderVouchers } from './features/vouchers.js';
import { renderLoyaltyBalances } from './features/loyaltybalances.js';
import { renderTasks } from './features/tasks.js';
import { renderPlanner } from './features/planner.js';
import { renderNudges } from './features/nudges.js';
import { renderAgentInbox } from './features/agentinbox.js';
import { renderCaptureInbox } from './features/captureinbox.js';
import { renderCaptureDrafts } from './features/voicecapture.js';
import { renderAirbnb, renderAirbnbKeys } from './features/airbnb.js';
import { renderLetting } from './features/letting.js';
import { renderBookingRequests } from './features/bookingrequests.js';
import { renderLoans } from './features/loans.js';
import { renderLettingOccupancy } from './features/lettingoccupancy.js';
import { renderMailHistory } from './features/mailledger.js';
import { renderFinanceAccounts } from './features/financeaccounts.js';
import { renderSubscriptions } from './features/subscriptions.js';
import { renderSwitchOffers } from './features/switchoffers.js';
import { renderTravel } from './features/travel.js';
import { renderLeave } from './features/leave.js';
import { renderConnections } from './features/connections.js';
import { renderOverview } from './features/overview.js';
import { renderFamily } from './features/family.js';
import { renderCalendars } from './features/calendars.js';
import { renderTicker } from './features/ticker.js';

// keys: the `data` fields that feed this panel. panels: selectors used to
// find where it lives (focus + visibility checks). heavy: wait until its tab
// is opened / debounce. onTabShow: never redraw proactively, only when its
// tab is shown.
const RULES = [
{ id: 'vouchers', keys: ['vouchers', 'loyaltyBalances', 'loyaltyPrograms', 'loyaltyLabelKinds'], panels: ['#vouchers-panel'], render: renderVouchers },
{ id: 'loyalty', keys: ['vouchers', 'loyaltyBalances', 'loyaltyPrograms', 'loyaltyLabelKinds'], panels: ['#loyalty-balances-panel'], render: renderLoyaltyBalances },
{ id: 'tasks', keys: ['tasks', 'taskContexts', 'trips'], panels: ['#tasks-panel'], render: renderTasks },
{ id: 'planner', keys: ['tasks', 'trips', 'connections', 'plannerEntries', 'plannerActivities', 'plannerExtraDays', 'airbnbReservations', 'airbnbListings'], panels: ['#planner-panel'], render: renderPlanner, heavy: true },
{ id: 'nudges', keys: ['tasks', 'vouchers', 'trips', 'financeAccounts', 'calendars', 'habits', 'goals', 'airbnbReservations', 'agentInbox'], panels: ['#nudges-panel'], render: renderNudges, onTabShow: true },
{ id: 'agent-inbox', keys: ['agentInbox'], panels: ['#agent-inbox-panel'], render: renderAgentInbox },
{ id: 'capture-inbox', keys: ['captureInbox', 'pendingImports'], panels: ['#capture-inbox-panel'], render: renderCaptureInbox },
{ id: 'capture-drafts', keys: ['captureDrafts'], panels: ['#capture-drafts-panel'], render: renderCaptureDrafts },
{ id: 'airbnb', keys: ['airbnbListings', 'airbnbReservations', 'airbnbBlocks', 'airbnbCleanerEvents', 'airbnbCleanerBlocks', 'airbnbCleaners', 'lettingLedger'], panels: ['#airbnb-panel'], render: renderAirbnb },
{ id: 'booking-requests', keys: ['bookingRequests', 'airbnbReservations', 'airbnbListings'], panels: ['#booking-requests'], render: renderBookingRequests },
{ id: 'airbnb-keys', keys: ['airbnbKeys', 'airbnbKeyAssignments', 'airbnbReservations'], panels: ['#airbnb-panel'], render: renderAirbnbKeys },
{ id: 'letting', keys: ['lettingLedger', 'airbnbListings', 'airbnbReservations', 'loans'], panels: ['#letting-panel'], render: renderLetting },
{ id: 'occupancy', keys: ['airbnbReservations', 'airbnbListings', 'lettingLedger', 'bookingProjections'], panels: ['#letting-occupancy-section'], render: renderLettingOccupancy },
{ id: 'mail-history', keys: ['mailLedger', 'trips'], panels: ['#mail-history-block'], render: renderMailHistory },
{ id: 'loans', keys: ['lettingLedger', 'loans', 'airbnbListings'], panels: ['#loans-panel'], render: renderLoans },
{ id: 'finance-accounts', keys: ['financeAccounts', 'subscriptions'], panels: ['#accounts-panel'], render: renderFinanceAccounts },
{ id: 'subscriptions', keys: ['subscriptions', 'financeAccounts'], panels: ['#subscriptions-panel'], render: renderSubscriptions },
{ id: 'switch-offers', keys: ['financeAccounts', 'switchOffers'], panels: ['#switch-offers-panel'], render: renderSwitchOffers },
{ id: 'travel', keys: ['trips', 'tasks'], panels: ['#travel-panel'], render: renderTravel },
{ id: 'leave', keys: ['trips', 'leaveYears'], panels: ['#leave-panel'], render: renderLeave },
{ id: 'connections', keys: ['connections', 'trips', 'plannerEntries'], panels: ['#connections-panel'], render: renderConnections, heavy: true },
{ id: 'overview', keys: ['connections'], panels: ['#overview-panel'], render: renderOverview, heavy: true },
{ id: 'family', keys: ['connections', 'trips'], panels: ['#family-panel'], render: renderFamily },
{ id: 'calendars', keys: ['calendars'], panels: ['#calendars-panel'], render: renderCalendars },
// Panels that only renderAll() used to redraw (added for targeted remote redraws, PERF-PLAN C8).
{ id: 'habits', keys: ['habits'], panels: ['#habits-list'], render: renderHabits },
{ id: 'goals', keys: ['goals'], panels: ['#goals-list'], render: renderGoals },
{ id: 'jobs', keys: ['jobs'], panels: ['#jobs-list'], render: renderJobs },
{ id: 'pending-imports', keys: ['pendingImports', 'connections'], panels: ['#candidate-list'], render: () => renderPendingImports() },
{ id: 'yearly-perks', keys: ['annualPerks', 'financeAccounts', 'tasks'], panels: ['#yearly-perks-list'], render: renderYearlyPerks },
{ id: 'business-ideas', keys: ['businessIdeas', 'tasks'], panels: ['#ideas-list'], render: renderBusinessIdeas },
{ id: 'enhancement-ideas', keys: ['enhancementIdeas'], panels: ['#enhancements-list'], render: renderEnhancementIdeas },
{ id: 'reading-list', keys: ['readingList'], panels: ['#reading-list'], render: renderReadingList },
{ id: 'media', keys: ['mediaItems', 'subscriptions', 'books'], panels: ['#media-list'], render: renderMedia },
{ id: 'health-daily', keys: ['healthDaily', 'renphoDaily', 'wellnessDaily'], panels: ['#health-daily-body'], render: renderHealthDaily },
{ id: 'renpho-daily', keys: ['renphoDaily', 'healthDaily'], panels: ['#renpho-daily-body'], render: renderRenphoDaily },
{ id: 'wellness-daily', keys: ['wellnessDaily', 'healthDaily'], panels: ['#wellness-daily-body'], render: renderWellnessDaily },
{ id: 'marriott-availability', keys: ['marriottAvailability', 'loyaltyPrograms', 'loyaltyBalances'], panels: ['#mvc-availability-panel'], render: renderMarriottAvailability },
{ id: 'ap-orders', keys: ['apOrders', 'tasks'], panels: ['#ap-orders-list'], render: renderApOrders },
{ id: 'tag-cleanup', keys: ['connections', 'flagRules'], panels: ['#tag-cleanup'], render: renderTagCleanup, heavy: true },
{ id: 'telegram-family', keys: ['telegramThreads', 'telegramUnclaimed', 'connections', 'trips', 'tasks'], panels: ['#telegramfamily-body'], render: renderTelegramFamily },
{ id: 'books', keys: ['books', 'connections', 'mediaItems'], panels: ['#books-list'], render: renderBooks },
{ id: 'school-calendar', keys: ['schoolCalendarUpdates'], panels: ['#school-calendar-list'], render: renderSchoolCalendar },
{ id: 'shopping', keys: ['tasks', 'inventory', 'setCompletionFinds', 'cashbackTracked', 'ebayResaleEstimates', 'connections'], panels: ['#shopping-lists', '#inventory-list'], render: refreshShopping, heavy: true },
{ id: 'day-queue', keys: ['dayQueue', 'connections'], panels: ['#day-queue-content'], render: renderDayQueue, heavy: true },
// The ticker rewrites its whole strip (restarting the marquee), so it is debounced hard.
{ id: 'ticker', keys: ['lettingLedger', 'financeAccounts', 'trips', 'tasks', 'ticker', 'heatingReading', 'claudeSubscriptionUsage', 'modelCheck'], panels: ['#ticker'], render: renderTicker, heavy: true, debounce: 4000, always: true },
];

const dirty = new Map(); // rule id -> rule
let timer = null;
const recent = new Map(); // rule id -> timestamps, to break render -> save -> render loops

function panelsOf(rule) { return rule.panels.map((q) => document.querySelector(q)).filter(Boolean); }
function isVisible(el) { return !!(el && el.offsetParent !== null); }
function isEditing(panel) {
const a = document.activeElement;
return !!(a && panel.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName));
}
function tooBusy(rule) {
const now = Date.now();
const stamps = (recent.get(rule.id) || []).filter((t) => now - t < 2000);
recent.set(rule.id, stamps);
return stamps.length >= 3;
}

function flush() {
timer = null;
let waiting = false;
dirty.forEach((rule, id) => {
const panels = panelsOf(rule);
// No such panel in this page (the markup is optional): nothing to keep in step.
if (!panels.length) { dirty.delete(id); return; }
const visible = panels.some(isVisible);
if (rule.onTabShow) { if (visible && rule.justShown) { rule.justShown = false; } else return; }
else if (rule.heavy && !visible && !rule.always) return;
if (panels.some((p) => isVisible(p) && isEditing(p))) { waiting = true; return; }
if (tooBusy(rule)) { console.warn(`render-bus: "${id}" kept changing its own data; stopped re-rendering it for now.`); dirty.delete(id); return; }
dirty.delete(id);
recent.get(id).push(Date.now());
try { const r = rule.render(); if (r && r.catch) r.catch((err) => console.error(`render-bus: "${id}" failed to re-render:`, err)); } catch (err) { console.error(`render-bus: "${id}" failed to re-render:`, err); }
});
// Something is still being typed into: look again once focus moves (focusout below also retries).
if (waiting) schedule(600);
}

function schedule(ms) {
clearTimeout(timer);
timer = setTimeout(flush, ms);
}

function onChanged(changed) {
let longest = 120;
RULES.forEach((rule) => {
if (!rule.keys.some((k) => changed.has(k))) return;
dirty.set(rule.id, rule);
longest = Math.max(longest, rule.debounce || (rule.heavy ? 1200 : 120));
});
if (dirty.size) schedule(longest);
}

// Keys that hold no display data (schema/seeding flags, check timestamps, a
// cache nothing shows): a remote change to only these needs no redraw.
const NO_DISPLAY_KEYS = new Set(['schemaVersion', 'voucherProviderBackfilled', 'providersConsolidated', 'apOrdersLastCheckedAt', 'apRefundsLastCheckedAt', 'flagRulesSeeded', 'importStatus', 'proxyRefusals']);
const NON_RENDER = new Set(['tickerCache', 'airbnbSyncStatus', 'airbnbCleanerSyncStatus', 'siteHealth', 'scheduledRuns', 'calendarStatus', 'diagnostics']); // same list as state.js
const RULE_KEYS = new Set(RULES.flatMap((r) => r.keys));

// This module's own per-key picture of `data`, as of the last redraw it knows
// of. state.js's baseline can't be used for a remote pull: the adopt re-saves
// silently (no change set is reported), so the changed keys are found here.
// Kept current from the change events (only the keys they name are re-read);
// a key it missed just shows up as "changed" later, which only over-redraws.
let seen = null;
function sigOf(v) { try { return JSON.stringify(v); } catch (e) { return String(Math.random()); } }
function snapshot() {
const sig = {};
Object.keys(data).forEach((k) => { if (!NON_RENDER.has(k)) sig[k] = sigOf(data[k]); });
return sig;
}

// Called by autosync.js after a pull has replaced `data` (it used to call
// renderAll()). Redraws only the panels fed by the keys that changed; a
// changed key no rule covers, or no baseline yet, falls back to renderAll().
// Returns 'none' | 'targeted' | 'all' (for the console / tests).
function redrawAfterRemote() {
if (!seen) { renderAll(); return 'all'; }
const next = snapshot();
const changed = new Set();
Object.keys(next).forEach((k) => { if (next[k] !== seen[k]) changed.add(k); });
Object.keys(seen).forEach((k) => { if (!(k in next)) changed.add(k); });
seen = next;
if (!changed.size) return 'none';
const unknown = [...changed].filter((k) => !RULE_KEYS.has(k) && !NO_DISPLAY_KEYS.has(k));
if (unknown.length) {
console.info(`render-bus: remote change to ${unknown.join(', ')} has no rule; redrawing everything.`);
renderAll();
return 'all';
}
onChanged(changed);
return 'targeted';
}

function initRenderBus() {
baselineDataSignatures();
seen = snapshot();
onDataChange((changed) => {
changed.forEach((k) => { if (k in data) seen[k] = sigOf(data[k]); else delete seen[k]; });
});
onDataChange(onChanged);
// Opening a tab redraws whatever was waiting for it.
document.addEventListener('tabshown', () => {
dirty.forEach((rule) => { rule.justShown = true; });
schedule(60);
});
// Focus leaving an input is the moment a deferred panel can safely redraw.
document.addEventListener('focusout', () => { if (dirty.size) setTimeout(flush, 0); });
}

export { initRenderBus, redrawAfterRemote };
