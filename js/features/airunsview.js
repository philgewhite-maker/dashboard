// Settings -> API usage -> "AI runs": what every AI flow has been asked and
// answered (js/airuns.js, server/ai-runs.php), how often you kept, edited or
// discarded its suggestion, and a place to rate a run. Loaded on demand so
// opening Settings never costs a request.
import { data, getLocalSettings, setLocalSetting } from '../state.js';
import { escapeHtml } from '../utils.js';
import { runStats, listRuns, getRun, rateRun, flush, queuedCount, status as logStatus } from '../airuns.js';
import { taskChipHtml, bindTaskChips } from './tasks.js';

let openFlow = '';

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '–');
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

async function headerHtml() {
  const s = await getLocalSettings();
  const queued = await queuedCount();
  const st = logStatus();
  const note = st.state === 'not-set-up' ? ` ${escapeHtml(st.detail)}` : st.state === 'error' ? ` Last send failed: ${escapeHtml(st.detail)}` : '';
  return `<div class="sync-row" style="align-items:flex-start;flex-wrap:wrap;gap:8px;">
<label class="settings-note" style="margin:0;"><input type="checkbox" id="airuns-logging"${s.aiRunLogging === false ? '' : ' checked'}> Log AI runs on this device</label>
<button class="sync-btn sm inline" type="button" id="airuns-load">Load AI runs</button>
<span class="settings-note" style="margin:0;" id="airuns-queue">${queued ? `${queued} waiting to send.` : ''}${note}</span>
</div>
<p class="settings-note">Each AI call's request and answer are kept on your web host (encrypted when sync encryption is on) so a flow can be rated and replayed on a newer model. Kept for 12 months; the newest 50 per flow, and anything you rated or edited, are kept for good.</p>
<div id="airuns-body"></div>`;
}

async function renderAiRunsPanel() {
  let host = document.getElementById('ai-runs-panel');
  if (!host) {
    const anchor = document.getElementById('model-check-panel');
    if (!anchor) return;
    host = document.createElement('div');
    host.id = 'ai-runs-panel';
    host.style.marginTop = '14px';
    anchor.after(host);
  }
  host.innerHTML = await headerHtml();
}

function statsTableHtml(flows, off) {
  // One row per flow, summed over models; the per-model split is in the flow view.
  const byFlow = new Map();
  flows.forEach((f) => {
    const t = byFlow.get(f.flow) || { flow: f.flow, runs: 0, kept: 0, edited: 0, discarded: 0, up: 0, down: 0, errors: 0, lastAt: '', models: new Set() };
    ['runs', 'kept', 'edited', 'discarded', 'up', 'down', 'errors'].forEach((k) => { t[k] += f[k]; });
    if (f.lastAt > t.lastAt) t.lastAt = f.lastAt;
    t.models.add(f.model);
    byFlow.set(f.flow, t);
  });
  const rows = [...byFlow.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  if (!rows.length) return '<div class="empty">No AI runs logged yet. They appear here after the next AI action.</div>';
  return `<div style="overflow-x:auto;"><table class="airuns-table">
<thead><tr><th>Flow</th><th>Runs</th><th title="Of runs with an outcome">Kept</th><th>Edited</th><th>Discarded</th><th>&#128077;</th><th>&#128078;</th><th>Errors</th><th>Last</th><th>Log</th></tr></thead>
<tbody>${rows.map((r) => {
    const decided = r.kept + r.edited + r.discarded;
    return `<tr>
<td><span class="airuns-link" data-airuns-flow="${escapeHtml(r.flow)}">${escapeHtml(r.flow)}</span></td>
<td class="num">${r.runs}</td><td class="num">${pct(r.kept, decided)}</td><td class="num">${pct(r.edited, decided)}</td><td class="num">${pct(r.discarded, decided)}</td>
<td class="num">${r.up || ''}</td><td class="num">${r.down || ''}</td><td class="num">${r.errors || ''}</td>
<td>${escapeHtml(when(r.lastAt))}</td>
<td><input type="checkbox" data-airuns-flow-log="${escapeHtml(r.flow)}"${off.includes(r.flow) ? '' : ' checked'} title="Log this flow"></td>
</tr>`;
  }).join('')}</tbody></table></div>`;
}

async function loadStats() {
  const body = document.getElementById('airuns-body');
  if (!body) return;
  body.innerHTML = '<span class="settings-note">Loading…</span>';
  await flush();
  try {
    const { flows } = await runStats();
    const s = await getLocalSettings();
    body.innerHTML = statsTableHtml(flows, Array.isArray(s.aiRunLoggingOff) ? s.aiRunLoggingOff : [])
      + '<div id="airuns-flow"></div>';
    if (openFlow) loadFlow(openFlow);
  } catch (e) {
    body.innerHTML = `<span class="settings-note">${escapeHtml(e.message || String(e))}</span>`;
  }
  const q = document.getElementById('airuns-queue');
  if (q) { const n = await queuedCount(); q.textContent = n ? `${n} waiting to send.` : ''; }
}

const outcomeLabel = { kept: 'kept as suggested', edited: 'edited before saving', discarded: 'discarded' };

async function loadFlow(flow) {
  openFlow = flow;
  const el = document.getElementById('airuns-flow');
  if (!el) return;
  el.innerHTML = '<span class="settings-note">Loading…</span>';
  try {
    const { runs, more } = await listRuns({ flow, limit: 30 });
    el.innerHTML = `<h4 style="margin:14px 0 6px;">${escapeHtml(flow)}</h4>
${runs.map((r) => `<div class="airuns-run" data-airuns-run-row="${escapeHtml(r.id)}">
<span>${escapeHtml(when(r.at))}</span> <span class="settings-note" style="margin:0;">${escapeHtml(r.model)}${r.tools ? ' · web search' : ''}</span>
<span class="settings-note" style="margin:0;">${r.error ? `failed: ${escapeHtml(r.error)}` : escapeHtml(outcomeLabel[r.outcome] || 'no outcome recorded')}</span>
${r.rating === 1 ? '&#128077;' : r.rating === -1 ? '&#128078;' : ''}
<button class="sync-btn sm inline" type="button" data-airuns-open="${escapeHtml(r.id)}">Open</button>
<div data-airuns-detail="${escapeHtml(r.id)}"></div>
</div>`).join('') || '<div class="empty">No runs.</div>'}
${more ? '<p class="settings-note">Showing the newest 30.</p>' : ''}`;
  } catch (e) {
    el.innerHTML = `<span class="settings-note">${escapeHtml(e.message || String(e))}</span>`;
  }
}

function requestText(payload) {
  const content = (payload && payload.request && payload.request.content) || [];
  return content.map((b) => (b.type === 'text' ? b.text : `[${b.type}${b.source && b.source.fileId ? ` file ${b.source.fileId}` : ''}]`)).join('\n\n');
}

// Records a run's outcome points at (a task so far) link back to the real record.
function outcomeRecordsHtml(detail) {
  if (!detail || !detail.taskId) return '';
  const task = data.tasks.find((t) => t.id === detail.taskId);
  return task ? `<div>Saved as ${taskChipHtml(task)}</div>` : '<div class="settings-note">The task it saved has since been deleted.</div>';
}

async function openRun(id) {
  const el = document.querySelector(`[data-airuns-detail="${CSS.escape(id)}"]`);
  if (!el) return;
  if (el.innerHTML) { el.innerHTML = ''; return; }
  el.innerHTML = '<span class="settings-note">Loading…</span>';
  try {
    const r = await getRun(id);
    const p = r.payload || {};
    const changes = (r.outcomeDetail && r.outcomeDetail.changes) || [];
    el.innerHTML = `<div class="airuns-detail">
${outcomeRecordsHtml(r.outcomeDetail)}
${changes.length ? `<div class="settings-note">You changed: ${changes.map((c) => `<b>${escapeHtml(c.field)}</b> “${escapeHtml(String(c.from ?? ''))}” → “${escapeHtml(String(c.to ?? ''))}”`).join('; ')}</div>` : ''}
<details><summary>Request</summary><pre class="airuns-pre">${escapeHtml(requestText(p))}</pre></details>
<details open><summary>Answer</summary><pre class="airuns-pre">${escapeHtml(p.responseText || '(none)')}</pre></details>
<div class="sync-row" style="align-items:flex-start;gap:6px;margin-top:6px;">
<button class="sync-btn sm inline" type="button" data-airuns-rate="${escapeHtml(id)}" data-rating="1"${r.rating === 1 ? ' aria-pressed="true"' : ''}>&#128077; Good</button>
<button class="sync-btn sm inline" type="button" data-airuns-rate="${escapeHtml(id)}" data-rating="-1"${r.rating === -1 ? ' aria-pressed="true"' : ''}>&#128078; Poor</button>
<input type="text" class="settings-input" data-airuns-note="${escapeHtml(id)}" placeholder="What was wrong or right (optional)" value="${escapeHtml((r.rateDetail && r.rateDetail.note) || '')}" style="flex:1;min-width:160px;">
</div>
</div>`;
    bindTaskChips();
  } catch (e) {
    el.innerHTML = `<span class="settings-note">${escapeHtml(e.message || String(e))}</span>`;
  }
}

function initAiRunsView() {
  renderAiRunsPanel();
  document.addEventListener('click', async (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.id === 'airuns-load') { loadStats(); return; }
    const flow = t.closest('[data-airuns-flow]');
    if (flow) { loadFlow(flow.dataset.airunsFlow); return; }
    const open = t.closest('[data-airuns-open]');
    if (open) { openRun(open.dataset.airunsOpen); return; }
    const rate = t.closest('[data-airuns-rate]');
    if (rate) {
      const id = rate.dataset.airunsRate;
      const note = document.querySelector(`[data-airuns-note="${CSS.escape(id)}"]`)?.value || '';
      rate.disabled = true;
      await rateRun(id, Number(rate.dataset.rating), note);
      rate.disabled = false;
      document.querySelectorAll(`[data-airuns-rate="${CSS.escape(id)}"]`).forEach((b) => b.setAttribute('aria-pressed', String(b === rate)));
    }
  });
  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement)) return;
    if (t.id === 'airuns-logging') { await setLocalSetting('aiRunLogging', t.checked); return; }
    if (t.dataset.airunsFlowLog) {
      const s = await getLocalSettings();
      const off = new Set(Array.isArray(s.aiRunLoggingOff) ? s.aiRunLoggingOff : []);
      if (t.checked) off.delete(t.dataset.airunsFlowLog); else off.add(t.dataset.airunsFlowLog);
      await setLocalSetting('aiRunLoggingOff', [...off]);
    }
  });
}

export { initAiRunsView, renderAiRunsPanel };
