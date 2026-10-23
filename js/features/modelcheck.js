// Monthly check: which models has this app actually been paying for, what
// does Anthropic offer right now, and is there a newer model in the same
// family for anything that cost real money. Feeds the ticker's "Models"
// tile and the panel under Settings -> API usage.
//
// Deliberately report-only: it never changes a model constant. Moving a
// feature to a newer model changes its behaviour as well as its cost
// (effort levels get recalibrated, token budgets that were tuned live stop
// meaning what their comments say), so the decision stays with you.
//
// "Upgrade" means a higher version in the SAME family (sonnet -> sonnet,
// haiku -> haiku). Never across families -- Opus/Sonnet/Haiku are
// different price tiers, not versions of each other -- and the finding
// says whether the RATE changed rather than implying a saving: Sonnet 5 ->
// 5.5 is the same $2/$10 rate card, and any saving there is fewer tokens
// per task, which only shows up in the calls/tokens-per-call figures below.
import { data, queueSave, getLocalSettings } from '../state.js';
import { summarizeUsage, currentMonthKey, priceFor } from '../ai.js';
import { escapeHtml } from '../utils.js';

const MODELS_URL = 'https://api.anthropic.com/v1/models';
// One row of usage (a feature on a model) has to have cost at least this
// much in a single month to be worth flagging -- below it the saving from
// moving is smaller than the effort of re-checking the feature.
const FLAG_MIN_COST = 1;

// claude-<family>-<major>[-<minor>][-<yyyymmdd>] -- e.g. claude-sonnet-5,
// claude-sonnet-5-5, claude-haiku-4-5-20251001. Anything that doesn't fit
// (older naming, Mythos which is limited-availability) parses to null and
// is simply never suggested or upgraded, rather than guessed at.
const MODEL_ID = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;

function parseModelId(id) {
const m = MODEL_ID.exec(String(id || ''));
if (!m) return null;
const major = Number(m[2]);
const minor = m[3] ? Number(m[3]) : 0;
return { family: m[1], major, minor, rank: major * 100 + minor };
}

// The newest same-family model above `model`, or null. At equal rank an
// undated alias beats a dated snapshot (the shorter id).
function upgradeFor(model, availableIds) {
const cur = parseModelId(model);
if (!cur) return null;
let best = null;
for (const id of availableIds) {
const p = parseModelId(id);
if (!p || p.family !== cur.family || p.rank <= cur.rank) continue;
if (!best || p.rank > best.p.rank || (p.rank === best.p.rank && id.length < best.id.length)) best = { id, p };
}
return best ? best.id : null;
}

// Rate card only -- says nothing about tokens per task, which is where a
// "newer, same price" model actually saves money. Worded to not imply it.
function comparePrices(from, to) {
const a = priceFor(from);
const b = priceFor(to);
if (!a || !b) return { kind: 'unknown', text: `no price on file for ${!b ? to : from}` };
const fmt = (p) => `$${p.input}/$${p.output}`;
if (a.input === b.input && a.output === b.output) return { kind: 'same', text: `same rate, ${fmt(b)} per MTok` };
if (b.input <= a.input && b.output <= a.output) return { kind: 'cheaper', text: `lower rate, ${fmt(a)} → ${fmt(b)} per MTok` };
if (b.input >= a.input && b.output >= a.output) return { kind: 'pricier', text: `higher rate, ${fmt(a)} → ${fmt(b)} per MTok` };
return { kind: 'mixed', text: `mixed rates, ${fmt(a)} → ${fmt(b)} per MTok` };
}

function previousMonthKey(monthKey) {
const [y, m] = monthKey.split('-').map(Number);
const d = new Date(Date.UTC(y, m - 2, 1));
return d.toISOString().slice(0, 7);
}

// Every model this key can call, via the Models API (CORS-open, same
// direct-from-browser header the Messages calls already send). Null when
// there's no key -- the check just stays quiet, same as every other
// feature that needs one.
async function fetchAvailableModels() {
const settings = await getLocalSettings();
const apiKey = (settings.anthropicApiKey || '').trim();
if (!apiKey) return null;
const ids = [];
let afterId = '';
for (let page = 0; page < 5; page++) {
const res = await fetch(`${MODELS_URL}?limit=1000${afterId ? `&after_id=${encodeURIComponent(afterId)}` : ''}`, {
headers: {
'x-api-key': apiKey,
'anthropic-version': '2023-06-01',
'anthropic-dangerous-direct-browser-access': 'true',
},
});
if (!res.ok) throw new Error(`Models API error ${res.status}`);
const body = await res.json();
(body.data || []).forEach((m) => { if (m && m.id) ids.push(m.id); });
if (!body.has_more || !body.last_id) break;
afterId = body.last_id;
}
return ids;
}

// Pure so it can be tested without a network or a usage log: rows are
// summarizeUsage()'s output for one month each.
function buildFindings(rowsByMonth, availableIds) {
const found = new Map();
for (const [month, rows] of Object.entries(rowsByMonth)) {
for (const r of rows) {
if (r.cost === null || r.cost < FLAG_MIN_COST) continue;
const upgrade = upgradeFor(r.model, availableIds);
if (!upgrade) continue;
// Already moved: the same feature also has usage on the upgrade (or
// newer) this month, so what's left on the old model is history, not a
// feature still configured to it.
const upRank = parseModelId(upgrade).rank;
const moved = rows.some((o) => o.purpose === r.purpose && o.model !== r.model
&& (() => { const p = parseModelId(o.model); return p && p.family === parseModelId(r.model).family && p.rank >= upRank; })());
if (moved) continue;
const key = `${r.purpose}|${r.model}`;
const prev = found.get(key);
if (prev && prev.cost >= r.cost) continue;
found.set(key, {
key, purpose: r.purpose, model: r.model, month, cost: r.cost,
calls: r.calls, outPerCall: r.calls ? Math.round(r.output / r.calls) : 0,
upgrade, price: comparePrices(r.model, upgrade),
});
}
}
return [...found.values()].sort((a, b) => b.cost - a.cost);
}

// Not before this day of the month: on the 1st the new month's usage log
// is empty, so a check then would be judging last month alone. From
// mid-month it sees last month complete plus a real slice of this one.
const CHECK_FROM_DAY = 15;

// Gated to once a month on its own (scheduled.js fires this at ordinary
// app-open cadence; almost every call returns null immediately). `force`
// is the Check-now button and skips both gates.
async function runModelCheck({ force = false } = {}) {
const month = currentMonthKey();
const prev = data.modelCheck;
if (!force) {
if (new Date().getUTCDate() < CHECK_FROM_DAY) return null;
if (prev && prev.checkedMonth === month) return null;
}
let available;
try {
available = await fetchAvailableModels();
} catch (err) {
console.error('Model check failed:', err);
return { ok: false, detail: err.message || String(err) };
}
if (!available) return null;
const settings = await getLocalSettings();
const months = [previousMonthKey(month), month];
const rowsByMonth = {};
for (const m of months) rowsByMonth[m] = summarizeUsage(settings.apiUsage, m).rows;
data.modelCheck = {
checkedAt: new Date().toISOString(),
checkedMonth: month,
flagMinCost: FLAG_MIN_COST,
available,
findings: buildFindings(rowsByMonth, available),
dismissed: (prev && prev.dismissed) || [],
};
queueSave();
renderModelCheck();
import('./ticker.js').then((m) => m.renderTicker());
return { ok: true, count: data.modelCheck.findings.length };
}

// Models used in the usage log that have no price on file: their cost
// shows as a dash and silently drops out of every total, which is how a
// stale or missing table goes unnoticed.
async function unpricedUsedModels() {
const settings = await getLocalSettings();
const seen = new Set();
for (const m of [previousMonthKey(currentMonthKey()), currentMonthKey()]) {
summarizeUsage(settings.apiUsage, m).rows.forEach((r) => { if (r.cost === null) seen.add(r.model); });
}
return [...seen];
}

async function renderModelCheck() {
const el = document.getElementById('model-check-panel');
if (!el) return;
const mc = data.modelCheck;
const unpriced = await unpricedUsedModels();
const dismissed = new Set((mc && mc.dismissed) || []);
const live = ((mc && mc.findings) || []).filter((f) => !dismissed.has(f.key));
const status = mc
? `Last checked ${escapeHtml(mc.checkedAt.slice(0, 10))} against ${mc.available.length} available models. Flags anything that cost $${mc.flagMinCost}+ in a month and has a newer model in the same family.`
: `Not checked yet. Runs once a month from the ${CHECK_FROM_DAY}th, or press Check now (needs an API key).`;
const rows = live.map((f) => `<div class="model-check-row">
<div><strong>${escapeHtml(f.purpose)}</strong> &mdash; ${escapeHtml(f.model)} &rarr; <strong>${escapeHtml(f.upgrade)}</strong></div>
<div class="settings-note" style="margin:2px 0 0;">$${f.cost.toFixed(2)} in ${escapeHtml(f.month)} &middot; ${f.calls.toLocaleString()} calls, ~${f.outPerCall.toLocaleString()} output tokens per call &middot; ${escapeHtml(f.price.text)}.
<button class="sync-btn sm inline" type="button" data-model-dismiss="${escapeHtml(f.key)}">Dismiss</button></div>
</div>`).join('');
el.innerHTML = `<div class="sync-row">
<span class="settings-note" style="margin:0;font-weight:500;">Model upgrades</span>
<button class="sync-btn sm inline" id="model-check-btn" type="button">Check now</button>
<span class="sync-status" id="model-check-status"></span>
</div>
<div class="settings-note" style="margin:4px 0;">${status}</div>
${rows || (mc ? '<div class="settings-note" style="margin:4px 0;">Nothing over the threshold has a newer model available.</div>' : '')}
${live.length ? '<div class="settings-note" style="margin:6px 0 0;">Rates only: a newer model can still use fewer tokens per task (Anthropic says Sonnet 5.5 does). After switching, compare calls and tokens per call here next month. Dismiss a row if that feature has already been moved &mdash; this reads usage history, which still includes calls made before the switch.</div>' : ''}
${unpriced.length ? `<div class="settings-note" style="margin:6px 0 0;">No price on file for ${unpriced.map(escapeHtml).join(', ')}, so those calls show as a dash and are left out of the totals above. Add them to the price table in js/ai.js.</div>` : ''}`;
el.querySelector('#model-check-btn').addEventListener('click', async (e) => {
const btn = e.currentTarget;
const statusEl = el.querySelector('#model-check-status');
btn.disabled = true;
statusEl.textContent = 'Checking…';
const result = await runModelCheck({ force: true });
if (result === null) {
// A real link, not prose naming a section (CLAUDE.md's plain-location rule).
statusEl.innerHTML = 'Add your <span class="inline-goto-link" data-goto-tab="settings" data-goto-target="#anthropic-key-input">API key</span> first.';
btn.disabled = false;
return;
}
if (!result.ok) { statusEl.textContent = `Couldn't check: ${result.detail}`; btn.disabled = false; return; }
// runModelCheck re-rendered the panel, replacing this button.
});
el.querySelectorAll('[data-model-dismiss]').forEach((b) => b.addEventListener('click', () => {
if (!data.modelCheck) return;
const key = b.dataset.modelDismiss;
if (!data.modelCheck.dismissed.includes(key)) data.modelCheck.dismissed.push(key);
queueSave();
renderModelCheck();
import('./ticker.js').then((m) => m.renderTicker());
}));
}

export { runModelCheck, renderModelCheck, parseModelId, upgradeFor, comparePrices, buildFindings, FLAG_MIN_COST };
