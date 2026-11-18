// The hash mirrors the current tab so a task's `link` field (already
// rendered as a clickable "Open reference" anchor) can point at a specific
// tab of the dashboard itself, not just external URLs — "go check Settings"
// becomes a real link instead of just words. replaceState rather than
// assigning location.hash directly, so switching tabs doesn't spam browser
// history with one entry per click.
// Registered by app.js (render-all.js imports every feature, and features import
// this file, so importing it here would make a cycle). Draws a tab whose
// panels renderAll({onlyTab}) skipped at boot.
let tabRenderer = null;
function setTabRenderer(fn) { tabRenderer = fn; }

function switchTab(tab) {
document.querySelectorAll('[data-tab]').forEach((el) => {
el.style.display = el.dataset.tab === tab ? 'block' : 'none';
});
document.querySelectorAll('[data-tab-btn]').forEach((btn) => {
btn.classList.toggle('active', btn.dataset.tabBtn === tab);
});
// On a phone the tab bar is one sideways-scrolling row: bring the active tab into view (scrolls the bar only, not the page).
const activeBtn = document.querySelector('.tab-btn.active'), bar = activeBtn && activeBtn.closest('.tab-bar');
if (bar && bar.scrollWidth > bar.clientWidth) bar.scrollTo({ left: activeBtn.offsetLeft - (bar.clientWidth - activeBtn.offsetWidth) / 2, behavior: 'smooth' });
if (location.hash.slice(1) !== tab) history.replaceState(null, '', `#${tab}`);
// Synchronously, before tabshown and before this returns: callers such as the
// goto-link handler, a connection/trip/task chip (switchTab then expandConnection/
// revealTrip/revealTask then scrollAndFlash) look for a card inside this tab
// the moment switchTab returns, so it must already exist (PERF-PLAN C9, V3).
if (tabRenderer) { try { tabRenderer(tab); } catch (err) { console.error('switchTab: render failed for', tab, err); } }
// A tab becoming visible can matter to code whose own content only
// makes sense (or can even be measured at all) once it's actually on
// screen -- the Finance accounts diagram's layout being the confirmed
// case: a listener bound to one specific tab BUTTON's click missed the
// "app loaded straight onto #finances from the URL hash" path
// entirely, since app.js's own initial hash handling calls switchTab()
// directly, never through a click (same for nudges.js's goToTarget,
// which also calls this directly). One shared event covers every path
// that ever calls switchTab(), not just the button click.
document.dispatchEvent(new CustomEvent('tabshown', { detail: { tab } }));
}

export { switchTab, setTabRenderer };
