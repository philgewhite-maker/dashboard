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
import { onDataChange, baselineDataSignatures } from './state.js';
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
{ id: 'nudges', keys: ['tasks', 'vouchers', 'trips', 'financeAccounts', 'calendars', 'habits', 'goals', 'airbnbReservations'], panels: ['#nudges-panel'], render: renderNudges, onTabShow: true },
{ id: 'agent-inbox', keys: ['agentInbox'], panels: ['#agent-inbox-panel'], render: renderAgentInbox },
{ id: 'capture-inbox', keys: ['captureInbox'], panels: ['#capture-inbox-panel'], render: renderCaptureInbox },
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
// The ticker rewrites its whole strip (restarting the marquee), so it is debounced hard.
{ id: 'ticker', keys: ['lettingLedger', 'financeAccounts', 'trips', 'tasks', 'ticker'], panels: ['#ticker'], render: renderTicker, heavy: true, debounce: 4000, always: true },
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
try { rule.render(); } catch (err) { console.error(`render-bus: "${id}" failed to re-render:`, err); }
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

function initRenderBus() {
baselineDataSignatures();
onDataChange(onChanged);
// Opening a tab redraws whatever was waiting for it.
document.addEventListener('tabshown', () => {
dirty.forEach((rule) => { rule.justShown = true; });
schedule(60);
});
// Focus leaving an input is the moment a deferred panel can safely redraw.
document.addEventListener('focusout', () => { if (dirty.size) setTimeout(flush, 0); });
}

export { initRenderBus };
