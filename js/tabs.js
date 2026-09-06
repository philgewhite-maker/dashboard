// The hash mirrors the current tab so a task's `link` field (already
// rendered as a clickable "Open reference" anchor) can point at a specific
// tab of the dashboard itself, not just external URLs — "go check Settings"
// becomes a real link instead of just words. replaceState rather than
// assigning location.hash directly, so switching tabs doesn't spam browser
// history with one entry per click.
function switchTab(tab) {
document.querySelectorAll('[data-tab]').forEach((el) => {
el.style.display = el.dataset.tab === tab ? 'block' : 'none';
});
document.querySelectorAll('[data-tab-btn]').forEach((btn) => {
btn.classList.toggle('active', btn.dataset.tabBtn === tab);
});
if (location.hash.slice(1) !== tab) history.replaceState(null, '', `#${tab}`);
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

export { switchTab };
