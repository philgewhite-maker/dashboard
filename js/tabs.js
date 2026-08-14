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
}

export { switchTab };
