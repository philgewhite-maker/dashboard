// Turns plain-text pointers ("on the Travel tab", "in the Mail panel", "see Settings",
// "Settings → Health data") into real links, wherever they appear -- static markup, a
// status line a feature builds later, the Guide. One phrase table here instead of
// remembering to hand-write a link in every sentence. The click is handled by the
// same document-wide listener as every other `.inline-goto-link` (app.js).

const TABS = {
  overview: 'overview', tasks: 'tasks', 'job hunt': 'jobhunt', contacts: 'dating', connections: 'dating',
  finances: 'finances', shopping: 'shopping', menu: 'menu', business: 'business', health: 'health',
  travel: 'travel', planner: 'planner', media: 'media', family: 'family', settings: 'settings', guide: 'guide',
};
// A named panel -> where it lives. Longest phrases first so they win over a bare tab name.
const PANELS = [
  { re: /\bLetting income panel\b/g, tab: 'finances', target: '#letting-panel' },
  { re: /\bLoyalty balances panel\b/g, tab: 'finances', target: '#loyalty-balances-panel' },
  { re: /\bVouchers(?: (?:&|and) Credits)? panel\b/g, tab: 'finances', target: '#vouchers-panel' },
  { re: /\bAirbnb panel\b/g, tab: 'overview', target: '#airbnb-panel' },
  { re: /\bMail panel\b/g, tab: 'overview', target: '#mail-panel' },
  { re: /\bConnections panel\b/g, tab: 'dating', target: '#connections-panel' },
  { re: /\bCapture Inbox\b/g, tab: 'tasks', target: '#capture-inbox-panel' },
];
const TAB_RE = new RegExp(`\\b(${Object.keys(TABS).map((k) => k.replace(/ /g, '\\s')).join('|')}) tab\\b`, 'gi');
const SETTINGS_ARROW_RE = /\bSettings\s*(?:→|›|>)\s*/g;
const SETTINGS_BARE_RE = /(?<=\b(?:in|see|See|from|via|to|under|open|Open|check|Check|visit|and|at|On|on) )Settings\b(?!\s*(?:→|›|>|tab\b))/g;

const SKIP = 'a,button,summary,label,select,option,textarea,input,script,style,pre,code,canvas,svg,h1,h2,h3,nav,[data-goto-tab],.inline-goto-link,[contenteditable],[data-no-autolink],.mail-body,.mail-view-body';

let settingsTitles = null;
// The titles of Settings' sections (and their groups), for "Settings → Health data".
function sectionTitles() {
  if (settingsTitles) return settingsTitles;
  settingsTitles = [...document.querySelectorAll('#settings-panel summary')]
    .map((s) => ({ title: s.textContent.replace(/\s+/g, ' ').trim(), el: s.closest('details') }))
    .filter((t) => t.title && t.el)
    .sort((a, b) => b.title.length - a.title.length);
  return settingsTitles;
}

function idFor(details) {
  if (!details.id) details.id = `settings-sec-${Math.random().toString(36).slice(2, 8)}`;
  return `#${details.id}`;
}

function matchesIn(text, node) {
  const hits = [];
  const add = (start, end, tab, target) => hits.push({ start, end, tab, target });
  PANELS.forEach((p) => { p.re.lastIndex = 0; let m; while ((m = p.re.exec(text))) add(m.index, m.index + m[0].length, p.tab, p.target); });
  TAB_RE.lastIndex = 0;
  let m;
  while ((m = TAB_RE.exec(text))) add(m.index, m.index + m[0].length, TABS[m[1].toLowerCase().replace(/\s+/g, ' ')], '');
  SETTINGS_ARROW_RE.lastIndex = 0;
  while ((m = SETTINGS_ARROW_RE.exec(text))) {
    const after = text.slice(m.index + m[0].length).toLowerCase();
    const sec = sectionTitles().find((t) => after.startsWith(t.title.toLowerCase()));
    if (sec) add(m.index, m.index + m[0].length + sec.title.length, 'settings', idFor(sec.el));
    else add(m.index, m.index + 8, 'settings', '');
  }
  SETTINGS_BARE_RE.lastIndex = 0;
  while ((m = SETTINGS_BARE_RE.exec(text))) add(m.index, m.index + m[0].length, 'settings', '');
  // Longest hit wins where two overlap; drop links that would point at where the reader already is.
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept = [];
  hits.forEach((h) => {
    if (kept.length && h.start < kept[kept.length - 1].end) return;
    const dest = h.target ? document.querySelector(h.target) : null;
    if (dest ? dest.contains(node) : node.parentElement.closest(`[data-tab="${h.tab}"]`)) return;
    kept.push(h);
  });
  return kept;
}

function linkNode(node) {
  const el = node.parentElement;
  if (!el || el.closest(SKIP)) return;
  const text = node.nodeValue;
  if (!text || text.length < 8) return;
  const hits = matchesIn(text, node);
  if (!hits.length) return;
  const frag = document.createDocumentFragment();
  let at = 0;
  hits.forEach((h) => {
    if (h.start > at) frag.append(text.slice(at, h.start));
    const span = document.createElement('span');
    span.className = 'inline-goto-link';
    span.setAttribute('role', 'link');
    span.tabIndex = 0;
    span.dataset.gotoTab = h.tab;
    if (h.target) span.dataset.gotoTarget = h.target;
    span.textContent = text.slice(h.start, h.end);
    frag.append(span);
    at = h.end;
  });
  if (at < text.length) frag.append(text.slice(at));
  node.replaceWith(frag);
}

function walk(root) {
  if (root.nodeType === Node.TEXT_NODE) { linkNode(root); return; }
  if (root.nodeType !== Node.ELEMENT_NODE || root.closest(SKIP)) return;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement && !n.parentElement.closest(SKIP) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  const nodes = [];
  while (w.nextNode()) nodes.push(w.currentNode);
  nodes.forEach(linkNode);
}

function initAutoLink() {
  walk(document.body);
  const pending = new Set();
  let timer = null;
  new MutationObserver((records) => {
    records.forEach((r) => r.addedNodes.forEach((n) => { if (n.isConnected) pending.add(n); }));
    if (!pending.size || timer) return;
    timer = setTimeout(() => {
      timer = null;
      const batch = [...pending];
      pending.clear();
      batch.forEach((n) => { if (n.isConnected) walk(n); });
    }, 60);
  }).observe(document.body, { childList: true, subtree: true });
  // Keyboard: the links are focusable spans, so Enter/Space should follow them like a click.
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('.inline-goto-link[data-goto-tab]')) { e.preventDefault(); e.target.click(); }
  });
}

export { initAutoLink };
