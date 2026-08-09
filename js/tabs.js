function switchTab(tab) {
document.querySelectorAll('[data-tab]').forEach((el) => {
el.style.display = el.dataset.tab === tab ? 'block' : 'none';
});
document.querySelectorAll('[data-tab-btn]').forEach((btn) => {
btn.classList.toggle('active', btn.dataset.tabBtn === tab);
});
}

export { switchTab };
