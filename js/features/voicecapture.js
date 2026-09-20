// Capture via a typed one-shot instruction or live in-app voice, both
// landing in the same persisted review queue (data.captureDrafts,
// state.js) a shared audio clip's transcription also lands in (see
// captureinbox.js's Phase 2 'audio' branch) -- one mechanism for all
// three entry points, per captureOutcomes.js's own long-deferred
// `commitMode: 'draft'` note: a compound instruction (a Trip, a
// Connection, several Planner entries) is a bigger blast radius than
// today's single-field capture outcomes, so it gets a review step before
// anything is actually created, every time, not just for voice.
//
// parseCaptureIntent (ai.js) turns free text into an ordered list of
// steps from a fixed, closed vocabulary; runCaptureSteps below is the
// only thing that ever executes one, and it does so by calling this
// app's EXISTING record-creation functions (captureTask, createTrip,
// createBlankConnection, placeEntry, addActivityToDay) -- never writing
// into data.* directly itself.
import { data, queueSave, blankCaptureDraft } from '../state.js';
import { escapeHtml, scrollAndFlash, dateStrAdd, todayStr, MISSING_KEY_LINK_HTML } from '../utils.js';

// ---- Executing a confirmed draft's steps ---------------------------------

// Inclusive day-by-day list from `start` to `end`. Guarded against a
// runaway loop -- these dates come from an AI's own JSON output, not a
// trusted internal source, so a malformed pair (end before start, or
// nonsense strings `dateStrAdd` can't parse into anything sane) fails
// closed rather than looping for a very long time.
function dateRange(start, end) {
const dates = [];
let d = start;
let guard = 0;
while (d && end && d <= end && guard < 370) {
dates.push(d);
d = dateStrAdd(d, 1);
guard++;
}
return dates;
}

// Resolves which trip a step means: a real existing id (from the list
// parseCaptureIntent was given), OR "__new__" -- which means "whatever
// trip a preceding 'trip' step in this SAME run just created" if there
// is one (ctx.lastTripId), falling back to actually creating one from
// newTripTitle only if nothing was created yet. This is what lets "create
// new TRIP to Mallorca... and add Vora Bora to it" resolve "it" to the
// trip the very first step just made, rather than creating a second one.
async function resolveTrip(step, ctx) {
const { tripById, createTrip } = await import('./travel.js');
if (step.tripId && step.tripId !== '__new__') {
const trip = tripById(step.tripId);
if (trip) return trip;
}
if (ctx.lastTripId) {
const trip = tripById(ctx.lastTripId);
if (trip) return trip;
}
const trip = await createTrip({ title: (step.newTripTitle || '').trim() || 'New trip' });
ctx.lastTripId = trip.id;
return trip;
}

async function runStep(step, ctx) {
switch (step.type) {
case 'task': {
const { captureTask } = await import('./tasks.js');
return captureTask({ title: step.title || 'Captured item', notes: step.notes || '', due: step.due || '' });
}
case 'reading': {
const { addToReadingList } = await import('./readinglist.js');
return addToReadingList({ title: step.title || step.url || 'Untitled', url: step.url || '', notes: step.notes || '' });
}
case 'media': {
const { addMediaItem } = await import('./media.js');
return addMediaItem({
kind: step.kind || 'other', title: step.title || step.url || 'Untitled',
creator: step.creator || '', year: step.year || '', link: step.url || '', notes: step.notes || '',
});
}
case 'trip': {
const { createTrip } = await import('./travel.js');
const trip = await createTrip({ title: step.title || 'New trip', destinations: step.destinations || [] });
// createTrip doesn't take dates as params -- set them directly on
// the record it returns, same as every other caller of it does.
if (step.startDate) trip.startDate = step.startDate;
if (step.endDate) trip.endDate = step.endDate;
queueSave();
ctx.lastTripId = trip.id;
return trip;
}
case 'tripActivity': {
const trip = await resolveTrip(step, ctx);
const { addActivityToDay } = await import('./planner.js');
addActivityToDay(step.date || trip.startDate || todayStr(), trip.id, step.title || 'Activity');
return trip;
}
case 'connection': {
const { createBlankConnection } = await import('./connections.js');
const conn = createBlankConnection(step.name || 'Unnamed');
ctx.lastConnectionId = conn.id;
return conn;
}
case 'placeConnection': {
const trip = await resolveTrip(step, ctx);
if (!ctx.lastConnectionId) throw new Error('No connection to place — a "connection" step has to come first.');
const start = step.startDate || trip.startDate;
const end = step.endDate || start;
const days = dateRange(start, end);
if (!days.length) throw new Error('No usable date range to place them on.');
const { placeEntry } = await import('./planner.js');
days.forEach((date) => placeEntry('connection', ctx.lastConnectionId, date, trip.id));
return trip;
}
// Built by captureOutcomes.js's `dateEvent` outcome (buildStep) --
// extraction already ran when the draft was queued (Mail's "zxc D"
// subject marker, processMailMarkers), this just turns the resolved
// result into a real record, same helper mail.js's own manual "Add
// idea" button uses.
case 'dateEvent': {
const { createDateEventFromExtraction } = await import('./planner.js');
return createDateEventFromExtraction(step, { source: { kind: 'mail', label: step.mailSubject, url: step.mailUrl } });
}
// Built by captureOutcomes.js's `tripLeg` outcome (buildStep) -- same
// applyLegExtraction (travel.js) mail.js's own manual "Read email &
// add" button already calls, just triggered from a confirmed draft
// instead of a click.
case 'tripLeg': {
const { applyLegExtraction } = await import('./travel.js');
const { trip } = await applyLegExtraction({
tripId: step.tripId, newTripTitle: step.newTripTitle, kind: step.extraction.kind,
extraction: step.extraction, source: { kind: 'mail', label: step.mailSubject, url: step.mailUrl },
});
return trip;
}
default:
throw new Error(`Unrecognised step type "${step.type}".`);
}
}

// Walks the steps in order, carrying ctx (lastTripId/lastConnectionId)
// forward between them so a later step can refer to what an earlier one
// in the SAME run just created. A step's own failure doesn't stop the
// ones after it -- a partial success (the trip got created, placing the
// connection failed) is still worth keeping, and the caller can see
// exactly which step failed and why.
async function runCaptureSteps(steps) {
const ctx = {};
const results = [];
for (const step of steps) {
try {
const record = await runStep(step, ctx);
results.push({ step, record });
} catch (err) {
console.error('Capture step failed:', step, err);
results.push({ step, error: err.message || String(err) });
}
}
return results;
}

// ---- Draft review UI ------------------------------------------------------

function stepSummary(step) {
switch (step.type) {
case 'task': return `Task: ${step.title || '(untitled)'}${step.due ? ` — due ${step.due}` : ''}`;
case 'reading': return `Reading list: ${step.title || step.url || '(untitled)'}`;
case 'media': return `Watch/listen: ${step.title || step.url || '(untitled)'}${step.creator ? ` — ${step.creator}` : ''}`;
case 'trip': return `New trip "${step.title || '(untitled)'}"${step.startDate ? `, ${step.startDate} to ${step.endDate || step.startDate}` : ''}`;
case 'tripActivity': return `Add "${step.title || '(untitled)'}" to ${step.tripId === '__new__' ? (step.newTripTitle || 'the new trip') : 'the trip'}${step.date ? ` on ${step.date}` : ''}`;
case 'connection': return `New contact: ${step.name || '(unnamed)'}`;
case 'placeConnection': return `Place them in ${step.tripId === '__new__' ? (step.newTripTitle || 'the new trip') : 'the trip'}, ${step.startDate || '?'} to ${step.endDate || step.startDate || '?'}`;
case 'dateEvent': return `Event: ${step.title || '(untitled)'}${step.date ? ` on ${step.date}` : ' — no date found, stays undated'}${step.location ? ` at ${step.location}` : ''}`;
case 'tripLeg': return `Trip leg (${step.extraction?.kind || 'other'}) → ${step.tripId === '__new__' ? `new trip "${step.newTripTitle || 'New trip'}"` : 'the trip'}`;
default: return `Unrecognised: ${step.type}`;
}
}

function draftCardHtml(d) {
return `<div class="alloc-card" data-draft-card="${d.id}">
<div class="task-source">${escapeHtml(d.rawText)}</div>
${d.steps.map((s) => `<div class="settings-note" style="margin:2px 0;">${escapeHtml(stepSummary(s))}</div>`).join('')}
<div class="alloc-controls">
<button class="todo-add-btn" type="button" data-draft-confirm="${d.id}">Confirm</button>
<button class="del-x" type="button" data-draft-discard="${d.id}">Discard</button>
</div>
<span class="sync-status" data-draft-status="${d.id}"></span>
</div>`;
}

function renderCaptureDrafts() {
const el = document.getElementById('capture-drafts-list');
if (!el) return; // tab not in this build's DOM
const countEl = document.getElementById('capture-drafts-count');
if (countEl) countEl.textContent = data.captureDrafts.length ? String(data.captureDrafts.length) : '';
el.innerHTML = data.captureDrafts.length
? data.captureDrafts.map(draftCardHtml).join('')
: '<div class="empty">Nothing waiting — type or speak an instruction above, or share a voice clip.</div>';
bindCaptureDrafts(el);
}

function bindCaptureDrafts(root) {
root.querySelectorAll('[data-draft-confirm]').forEach((btn) => {
btn.addEventListener('click', async () => {
const draft = data.captureDrafts.find((d) => d.id === btn.dataset.draftConfirm);
if (!draft) return;
const status = root.querySelector(`[data-draft-status="${draft.id}"]`);
btn.disabled = true;
if (status) status.textContent = 'Working…';
const results = await runCaptureSteps(draft.steps);
data.captureDrafts = data.captureDrafts.filter((d) => d.id !== draft.id);
queueSave();
renderCaptureDrafts();
const banner = document.getElementById('capture-drafts-status');
if (banner) {
banner.textContent = results.map((r) => (r.error ? `✗ ${stepSummary(r.step)}: ${r.error}` : `✓ ${stepSummary(r.step)}`)).join(' ');
}
});
});
root.querySelectorAll('[data-draft-discard]').forEach((btn) => {
btn.addEventListener('click', () => {
data.captureDrafts = data.captureDrafts.filter((d) => d.id !== btn.dataset.draftDiscard);
queueSave();
renderCaptureDrafts();
});
});
}

// The one place a draft is ever created -- called by the quick-capture
// input, the mic button, and captureinbox.js's shared-audio-clip branch,
// so every entry point produces the exact same reviewable shape.
async function createCaptureDraft(rawText, source) {
const text = String(rawText || '').trim();
if (!text) return null;
const { parseCaptureIntent } = await import('../ai.js');
const { steps } = await parseCaptureIntent(text);
const draft = blankCaptureDraft({ rawText: text, steps, source: source || null });
data.captureDrafts.unshift(draft);
queueSave();
renderCaptureDrafts();
setTimeout(() => scrollAndFlash(`[data-draft-card="${draft.id}"]`), 60);
return draft;
}

function revealCaptureDraft(id) {
renderCaptureDrafts();
setTimeout(() => scrollAndFlash(`[data-draft-card="${id}"]`), 60);
}

// ---- Entry points: typed prompt + live in-app mic --------------------------

// SpeechRecognition transcribes the mic live -- no MediaRecorder, no audio
// file, no AI call involved on this path at all; it just fills the same
// text input the typed prompt uses, then runs through the identical
// createCaptureDraft call. Feature-detected: silently hides the mic
// button rather than erroring where the API doesn't exist (desktop
// Safari/Firefox, mainly -- this app's real usage is Android Chrome).
// `micBtn` is the element itself, not an id -- reused as-is by
// shopping.js for its own mic button (a different id), rather than this
// function only ever knowing about the Smart capture panel's one.
function initMicCapture(micBtn, input, status, submit) {
if (!micBtn) return;
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SpeechRecognition) { micBtn.hidden = true; return; }

let recognizing = false;
let recognition = null;
micBtn.addEventListener('click', () => {
if (recognizing) { recognition.stop(); return; }
recognition = new SpeechRecognition();
recognition.lang = navigator.language || 'en-US';
recognition.interimResults = true;
recognition.continuous = false;
let finalText = '';
recognition.onresult = (e) => {
let interim = '';
for (let i = e.resultIndex; i < e.results.length; i++) {
const r = e.results[i];
if (r.isFinal) finalText += r[0].transcript;
else interim += r[0].transcript;
}
input.value = (finalText + interim).trim();
};
recognition.onerror = (e) => { if (status) status.textContent = `Mic error: ${e.error}`; };
recognition.onend = () => {
recognizing = false;
micBtn.classList.remove('recording');
micBtn.textContent = '🎙';
// Hands-free: stopping the recording (silence, or a manual tap) is
// the "submit" gesture for voice, same as Enter is for typing --
// the whole point of voice capture is not needing to look at or
// touch the screen again after speaking.
if (input.value.trim()) submit();
};
recognition.start();
recognizing = true;
micBtn.classList.add('recording');
micBtn.textContent = '⏹';
});
}

// Shares the ONE capture box with tasks.js rather than owning a second
// one. Two boxes both labelled "Capture", differing only in which code
// path ran, exposed an implementation detail: from the typing end it's
// the same act, so Enter still makes a task instantly and for free,
// while this button (and the mic) read the same text as an instruction.
// Same "free path by default, AI on a deliberate tap" convention as
// Resolve title.
function initQuickCapture() {
const input = document.getElementById('capture-input');
const btn = document.getElementById('quick-capture-btn');
const status = document.getElementById('quick-capture-status');
if (!input || !btn) return;
const submit = async () => {
const text = input.value.trim();
if (!text) return;
btn.disabled = true;
if (status) status.textContent = 'Thinking…';
try {
await createCaptureDraft(text, { kind: 'quickcapture', label: 'Typed', url: '' });
input.value = '';
if (status) status.textContent = '';
} catch (err) {
console.error('Quick capture failed:', err);
if (status) {
if (err?.name === 'MissingKeyError') status.innerHTML = `Add an Anthropic API key in ${MISSING_KEY_LINK_HTML} first.`;
else status.textContent = `Couldn't parse that: ${err.message || err}`;
}
} finally {
btn.disabled = false;
}
};
btn.addEventListener('click', submit);
// Deliberately no Enter binding: Enter is tasks.js's free instant
// capture on this same box. Binding it here too would fire both, and
// spend an AI call on every ordinary task typed.
initMicCapture(document.getElementById('quick-capture-mic-btn'), input, status, submit);
}

function initVoiceCapture() {
renderCaptureDrafts();
initQuickCapture();
}

export { initVoiceCapture, renderCaptureDrafts, createCaptureDraft, revealCaptureDraft, runCaptureSteps, initMicCapture };
