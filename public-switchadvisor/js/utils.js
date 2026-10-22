export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function money(n) {
  const v = Number(n) || 0;
  return `£${v.toLocaleString('en-GB', { maximumFractionDigits: 2 })}`;
}

export function uid() {
  return Math.random().toString(16).slice(2, 10);
}
