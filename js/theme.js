// Light / dark / follow-the-device. The choice is per device (localStorage),
// not synced: a phone at night and a PC in daylight want different answers.
// The tiny inline script in index.html's <head> applies it before first paint;
// this module wires the header toggle and keeps <meta name="theme-color"> in
// step so the browser/status bar matches.
const KEY = 'dashboard-theme';
const ORDER = ['auto', 'light', 'dark'];
const LABEL = { auto: 'Theme: auto', light: 'Theme: light', dark: 'Theme: dark' };
const BAR = { light: '#FAF9F5', dark: '#161512' };

function stored() {
try { const v = localStorage.getItem(KEY); return ORDER.includes(v) ? v : 'auto'; } catch (e) { return 'auto'; }
}

function effective(mode) {
if (mode !== 'auto') return mode;
return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function apply(mode) {
const root = document.documentElement;
if (mode === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', mode);
const meta = document.querySelector('meta[name="theme-color"]');
if (meta) meta.setAttribute('content', BAR[effective(mode)]);
const btn = document.getElementById('theme-toggle');
if (btn) {
btn.textContent = LABEL[mode];
btn.title = 'Cycles auto (follows this device) → light → dark. Saved on this device only.';
}
}

function initTheme() {
apply(stored());
const btn = document.getElementById('theme-toggle');
if (btn) btn.addEventListener('click', () => {
const next = ORDER[(ORDER.indexOf(stored()) + 1) % ORDER.length];
try { localStorage.setItem(KEY, next); } catch (e) { /* private window: still applies for this page */ }
apply(next);
});
// "Auto" has to follow the device if it flips at sunset while the app is open.
if (window.matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => apply(stored()));
}

export { initTheme };
