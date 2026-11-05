// AI run log, client side. Every Claude call (js/ai.js callAnthropic) hands
// its request and response here; the screen that used the answer can later
// add what you did with it (kept, edited, discarded) and a rating. Runs go to
// server/ai-runs.php, separate from the synced document (too big for it), so
// a flow can be scored and its saved inputs replayed on a newer model.
//
// Never in the way of the AI call itself: logRun() only queues, and the
// queue is flushed in the background. If the server file isn't uploaded yet,
// or the device is offline, entries wait in IndexedDB (capped) and go out
// later. The prompt/response/outcome are sealed with the sync key when sync
// encryption is on, so the host then only holds ciphertext.
import { kvGet, kvSet } from './db.js';
import { getLocalSettings } from './state.js';

const QUEUE_KEY = 'airuns-queue';
const FILES_KEY = 'airuns-files'; // sha256 -> uploaded file id, so one image is uploaded once
const MAX_QUEUE = 150;
const FLUSH_DELAY_MS = 4000;
const BATCH = 10;

let flushTimer = null;
let flushing = false;
let lastStatus = { state: 'idle', detail: '' }; // 'idle' | 'ok' | 'not-set-up' | 'error'

function newRunId() {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function endpoint() {
  const { getConfig } = await import('./sync/selfhost.js');
  const { url, secret } = await getConfig();
  if (!url || !secret || !/\/sync\.php(\?.*)?$/.test(url)) return null;
  return { url: url.replace(/\/sync\.php(\?.*)?$/, '/ai-runs.php'), secret };
}

async function seal(value) {
  try {
    const c = await import('./synccrypto.js');
    return (await c.isEncrypted()) ? await c.encryptDocument(value) : { plain: value };
  } catch (e) {
    return { plain: value };
  }
}

async function unseal(payload) {
  if (!payload) return null;
  if (payload.plain !== undefined) return payload.plain;
  const c = await import('./synccrypto.js');
  return c.decryptDocument(payload);
}

async function loggingEnabled(flow) {
  const s = await getLocalSettings();
  if (s.aiRunLogging === false) return false;
  return !(Array.isArray(s.aiRunLoggingOff) && s.aiRunLoggingOff.includes(flow));
}

async function readQueue() {
  try { return (await kvGet(QUEUE_KEY)) || []; } catch (e) { return []; }
}
async function writeQueue(q) {
  try { await kvSet(QUEUE_KEY, q.slice(-MAX_QUEUE)); } catch (e) { /* storage full or blocked: the run is lost, the call is not */ }
}
async function enqueue(item) {
  const q = await readQueue();
  q.push(item);
  await writeQueue(q);
  scheduleFlush();
}

function scheduleFlush(delay = FLUSH_DELAY_MS) {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => { flush().catch(() => {}); }, delay);
}

async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Image and PDF blocks become references to an uploaded file instead of
// megabytes of base64 inside every run.
async function externaliseContent(content) {
  const fileIds = [];
  const out = [];
  let files = null;
  for (const block of content || []) {
    const data = block && block.source && block.source.type === 'base64' ? block.source.data : null;
    if (!data) { out.push(block); continue; }
    try {
      const bytes = base64ToBytes(data);
      const hash = await sha256Hex(bytes);
      if (!files) files = (await kvGet(FILES_KEY)) || {};
      let id = files[hash];
      if (!id) {
        const { uploadAttachment } = await import('./files.js');
        const name = `ai-run-${hash.slice(0, 12)}.${block.type === 'document' ? 'pdf' : 'img'}`;
        const meta = await uploadAttachment(new File([bytes], name, { type: block.source.media_type || 'application/octet-stream' }));
        id = meta.id;
        files[hash] = id;
        await kvSet(FILES_KEY, files);
      }
      fileIds.push(id);
      out.push({ type: block.type, source: { type: 'file-ref', fileId: id, media_type: block.source.media_type, sha256: hash } });
    } catch (e) {
      // Not uploaded (attachments not set up, offline): keep the hash so the
      // run still says what it was given, just not replayable.
      out.push({ type: block.type, source: { type: 'missing', media_type: block.source.media_type } });
    }
  }
  return { content: out, fileIds };
}

// Called by callAnthropic after every call, success or failure.
// `run` = {id, flow, model, effort, maxTokens, tools, content, responseText,
// parsed, stopReason, usage, ms, error}
function logRun(run) {
  (async () => {
    if (!(await loggingEnabled(run.flow))) return;
    const { content, fileIds } = await externaliseContent(run.content);
    const payload = await seal({
      request: { content, maxTokens: run.maxTokens, effort: run.effort || '', tools: run.tools || null },
      responseText: run.responseText ?? null,
      parsed: run.parsed ?? null,
      stopReason: run.stopReason || '',
      truncated: !!run.truncated,
    });
    await enqueue({
      kind: 'log',
      run: {
        id: run.id, at: new Date().toISOString(), flow: run.flow, model: run.model,
        build: (document.getElementById('build-stamp') || {}).textContent || '',
        tools: !!(run.tools && run.tools.length), tokensIn: run.usage?.input_tokens || 0, tokensOut: run.usage?.output_tokens || 0,
        ms: Math.round(run.ms || 0), error: run.error || null, fileIds, payload,
      },
    });
  })().catch((e) => console.warn('AI run log: could not queue a run', e));
}

// What you did with a suggestion. `suggested` and `final` are plain objects of
// the same fields; the outcome is "kept" when nothing changed, else "edited"
// with the field-level changes. Pass final = null for "discarded".
function recordOutcome(runId, suggested, final, extra = {}) {
  if (!runId) return;
  (async () => {
    let outcome = 'discarded';
    const changes = [];
    if (final) {
      Object.keys({ ...(suggested || {}), ...final }).forEach((k) => {
        const a = normalise(suggested ? suggested[k] : undefined);
        const b = normalise(final[k]);
        if (a !== b) changes.push({ field: k, from: suggested ? suggested[k] ?? null : null, to: final[k] ?? null });
      });
      outcome = changes.length ? 'edited' : 'kept';
    }
    await enqueue({ kind: 'outcome', id: runId, outcome, payload: await seal({ suggested: suggested || null, final: final || null, changes, ...extra }) });
  })().catch((e) => console.warn('AI run log: could not queue an outcome', e));
}

function normalise(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v.trim().replace(/\s+/g, ' ');
  return JSON.stringify(v);
}

async function rateRun(runId, rating, note = '') {
  await enqueue({ kind: 'rate', id: runId, rating, payload: rating ? await seal({ note }) : null });
  return flush();
}

async function flush() {
  if (flushing) return lastStatus;
  flushing = true;
  try {
    const ep = await endpoint();
    if (!ep) { lastStatus = { state: 'not-set-up', detail: 'Sync is not set up on this device.' }; return lastStatus; }
    let q = await readQueue();
    while (q.length) {
      const head = q[0];
      if (head.kind === 'log') {
        const batch = [];
        while (q.length && q[0].kind === 'log' && batch.length < BATCH) batch.push(q.shift().run);
        const res = await post(ep, 'log', { runs: batch });
        if (res.deletedFileIds && res.deletedFileIds.length) deleteFiles(res.deletedFileIds);
      } else {
        const item = q.shift();
        await post(ep, item.kind, item.kind === 'outcome'
          ? { id: item.id, outcome: item.outcome, payload: item.payload }
          : { id: item.id, rating: item.rating, payload: item.payload });
      }
      await writeQueue(q);
    }
    lastStatus = { state: 'ok', detail: '' };
  } catch (e) {
    lastStatus = e.status === 404
      ? { state: 'not-set-up', detail: 'server/ai-runs.php is not on the web host yet.' }
      : { state: 'error', detail: e.message || String(e) };
  } finally {
    flushing = false;
  }
  return lastStatus;
}

async function deleteFiles(ids) {
  try {
    const { deleteAttachment } = await import('./files.js');
    for (const id of ids) { try { await deleteAttachment(id); } catch (e) { /* already gone */ } }
  } catch (e) { /* attachments not set up */ }
}

async function post(ep, action, body) {
  const res = await fetch(`${ep.url}?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sync-Secret': ep.secret },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = new Error(`AI run log: HTTP ${res.status}`);
    err.status = res.status;
    try { err.message = (await res.json()).error || err.message; } catch (e) { /* not JSON */ }
    throw err;
  }
  return res.json();
}

async function get(query) {
  const ep = await endpoint();
  if (!ep) { const e = new Error('Sync is not set up on this device.'); e.status = 0; throw e; }
  const res = await fetch(`${ep.url}?${query}`, { headers: { 'X-Sync-Secret': ep.secret } });
  if (!res.ok) {
    const err = new Error(res.status === 404 ? 'server/ai-runs.php is not on the web host yet.' : `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function listRuns(filters = {}) {
  const p = new URLSearchParams({ list: '1', ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) });
  return get(p.toString());
}
async function runStats() { return get('stats=1'); }
async function getRun(id) {
  const r = await get(`get=${encodeURIComponent(id)}`);
  return {
    ...r.run,
    payload: await unseal(r.run.payload),
    outcomeDetail: await unseal(r.outcomePayload),
    rateDetail: await unseal(r.ratePayload),
  };
}

async function queuedCount() { return (await readQueue()).length; }
function status() { return lastStatus; }

// Flush whatever an earlier session left behind.
function initAiRuns() { scheduleFlush(8000); }

export { newRunId, logRun, recordOutcome, rateRun, flush, listRuns, runStats, getRun, queuedCount, status, initAiRuns };
