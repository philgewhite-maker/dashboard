import { data, queueSave, mailSearchLabel, blankMailDismissal, blankMailRule } from '../state.js';
import { escapeHtml, affiliateLink, unfoldIcsLines, parseIcsProperty, icsDateTime, dateStrAdd, MISSING_KEY_LINK_HTML } from '../utils.js';
import { canAttemptGoogleAction, hasCalendarWrite } from '../sync/googleauth.js';
import { fetchMailSearches, getMessageDetail, fetchMessageAttachmentBytes } from '../googlemail.js';
import { captureTask, taskChipHtml, bindTaskChips } from './tasks.js';
import { legTargetPickerHtml, bindLegTargetPicker, readLegTargetPicker, applyLegExtraction, tripChipHtml, bindTripChips, gapsFor } from './travel.js';
import { connectionPickerHtml, bindConnPickers } from './connections.js';
import { MAIL_ACTIONS } from './mailActions.js';
import { runOutcomeOnMessage, processMailRules } from './mailRules.js';
import { CAPTURE_OUTCOMES, outcomeLabelWithCost, matchCaptureRule } from './captureOutcomes.js';

// "Tamara White" <tamara.anna.white@gmail.com> -> "Tamara White"; falls
// back to the raw email if there's no display name on the header.
function displayName(fromHeader) {
const match = fromHeader.match(/^"?([^"<]+?)"?\s*<[^>]+>$/);
return (match ? match[1] : fromHeader).trim();
}

function formatDate(dateStr) {
const d = new Date(dateStr);
if (isNaN(d)) return '';
return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// A task already captured from this email, if there is one. Compared on the
// message link, which is stable across devices — the button state then
// follows the synced data rather than what this browser happens to remember.
function existingTaskFor(m) {
return data.tasks.find((t) => t.source && t.source.kind === 'mail' && t.source.url === m.link && t.bucket !== 'done');
}

// Same source-url matching as existingTaskFor, for the other two
// committing actions -- applyLegExtraction (travel.js) already stores
// `source` on the leg it creates, same shape/reasoning.
function existingTripLegFor(m) {
for (const trip of data.trips) {
const leg = trip.legs.find((l) => l.source && l.source.kind === 'mail' && l.source.url === m.link);
if (leg) return { trip, leg };
}
return null;
}
function existingDateEventFor(m) {
return data.plannerActivities.find((a) => a.source && a.source.kind === 'mail' && a.source.url === m.link);
}
// A message explicitly binned (see the ✕ dismiss button in messageRowHtml)
// without ever becoming a task/trip-leg/date-event -- keyed by url, same
// identity every existingXFor above already matches on.
function existingDismissalFor(m) {
return data.mailDismissed.find((d) => d.url === m.link);
}
// A "zxc D"/"zxc L" subject marker (processMailMarkers below) already
// queued a reviewable draft for this message -- data.captureDrafts,
// state.js -- but hasn't been confirmed yet. Same url-matching identity
// as every other existingXFor here, just on the draft's own `source`
// rather than a finished record's.
function existingDraftFor(m) {
return data.captureDrafts.find((d) => d.source && d.source.kind === 'mail' && d.source.url === m.link);
}

// 'dismissed' beats 'drafted' beats 'processed' beats 'open' -- a
// dismissal is the most deliberate, most recent signal if more than one
// somehow applies. Drives both the collapsed "already processed" bucket
// and (separately) which messages disappear from Mail entirely in
// sectionHtml/renderMail below -- not any individual action button's own
// state, which stays per-action regardless (a message already turned
// into a trip leg still shows a live "+ task" if you also want one).
function messageStatus(m) {
if (existingDismissalFor(m)) return 'dismissed';
if (existingDraftFor(m)) return 'drafted';
if (existingTaskFor(m) || existingTripLegFor(m) || existingDateEventFor(m)) return 'processed';
return 'open';
}

// Shared shape for every "✨ Use AI" button (aiTask, improveTask -- dateEvent
// now runs its own ICS-first waterfall, see extractDateEventFromIcs below)
// -- read the full email body, run the named ai.js export on it, report a
// MissingKeyError distinctly (same message every other AI-assisted flow in
// this file already uses) instead of a raw error dump, as a REAL link to
// where the key actually gets entered rather than dead "...in Settings"
// text -- which is why this takes the status element itself, not just a
// plain-text `say`, one of the two paths needs innerHTML. Returns null on
// any failure, having already reported it. Also hands back the raw
// attachment metadata getMessageDetail found (cheap -- no bytes fetched
// yet), for a caller that wants to offer grabEmailAttachments below.
async function runAiExtraction(extractFnName, id, subject, from, status) {
const say = (msg) => { if (status) status.textContent = msg; };
say('Reading the email…');
try {
const [aiMod, detail] = await Promise.all([import('../ai.js'), getMessageDetail(id)]);
say('Pulling out the details…');
const result = await aiMod[extractFnName](subject, from, detail.bodyText);
return { result, attachments: detail.attachments };
} catch (err) {
console.error('Mail AI extraction failed:', err);
if (err?.name === 'MissingKeyError') { if (status) status.innerHTML = `Add an Anthropic API key in ${MISSING_KEY_LINK_HTML} to use AI here.`; }
else say(`Couldn't read that: ${err.message || err}`);
return null;
}
}

// A real image (skipping tiny tracking-pixel/logo images) or a PDF -- the
// two shapes a boarding pass, e-ticket or QR code realistically arrives as.
// No actual QR decoding (would need a vendored library and still couldn't
// help with a QR embedded inside a PDF) -- "attached image/PDF on an email
// you're turning into a task/leg/event" is a good enough proxy, confirmed
// as the wanted trade-off over precision.
const TICKET_ATTACHMENT_MIN_IMAGE_BYTES = 2048;
function looksLikeTicketAttachment(part) {
const isPdf = part.mimeType === 'application/pdf' || /\.pdf$/i.test(part.filename || '');
const isRealImage = (part.mimeType || '').startsWith('image/') && (part.size || 0) > TICKET_ATTACHMENT_MIN_IMAGE_BYTES;
return isPdf || isRealImage;
}

// Fetches and uploads every attachment in `candidates` that passes the
// heuristic above, via files.js's existing uploadAttachment -- the same
// synced-attachment mechanism tasks/trip legs already show a file in.
// Returns the uploaded metadata (same {id, name, type, size} shape
// blankTask.attachments/blankTripLeg.attachments/blankPlannerActivity.
// attachments all already expect) for the caller to push in. Never throws
// -- an optional enrichment on top of the real capture, so a missing files
// server (FilesNotConfiguredError) or one failed upload just means fewer
// (or zero) attachments come back, not a blocked capture.
//
// `attachmentHints` (filenames, from the AI extraction's own per-event
// field -- see extractDateEventFromEmail in ai.js) narrows the ticket-
// shaped candidates down to just the ones the email body said belong to
// THIS event, for a multi-event email with several tickets attached.
// Falls back to every ticket-shaped candidate when hints are empty or
// none of them actually matched a real attachment -- an unmatched hint
// (a typo, a filename the model paraphrased) should still leave today's
// "attach everything" behaviour intact rather than silently attaching
// nothing.
async function grabEmailAttachments(id, candidates, attachmentHints = []) {
let picks = (candidates || []).filter(looksLikeTicketAttachment);
if (attachmentHints && attachmentHints.length) {
const hinted = picks.filter((p) => attachmentHints.some((h) => h && p.filename && p.filename.toLowerCase() === h.toLowerCase()));
if (hinted.length) picks = hinted;
}
if (!picks.length) return [];
const { uploadAttachment } = await import('../files.js');
const out = [];
for (const part of picks) {
try {
const bytes = await fetchMessageAttachmentBytes(id, part.attachmentId);
const file = new File([bytes], part.filename || 'attachment', { type: part.mimeType || 'application/octet-stream' });
out.push(await uploadAttachment(file));
} catch (err) {
if (err?.name === 'FilesNotConfiguredError') break; // nothing else will succeed either
console.error('Attachment grab failed:', err);
}
}
return out;
}

// RFC5545 backslash-escapes commas/semicolons/newlines within a property
// value (a LOCATION with a comma-separated address is the common case) --
// confirmed live against the Abandoman venue ("Underbelly Boulevard, 6
// Walker's Ct...") coming through with literal backslashes without this.
function unescapeIcsValue(value) {
return String(value || '').replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
}

// Deterministic half of dateEvent's "🪄 Extract details" waterfall -- a
// calendar invite most booking confirmations attach already has the date,
// time and venue structured, so this is tried before ever spending an AI
// call (see the data-mail-date-event-extract handler below). Reuses the
// same RFC5545 line-unfolding/property-splitting travel.js's Airbnb sync
// depends on (js/utils.js), just reading a different set of properties --
// a real calendar invite, not a date-only reservation block.
//
// Returns an array, one entry per VEVENT -- a real invite for an order
// covering several separate things (e.g. two different gigs' tickets
// bought together) repeats each VEVENT once per ticket, same UID every
// time, so this dedupes by UID rather than just keeping the first block
// found. A single-event invite still comes back as a one-item array, so
// every caller handles one shape.
function extractDateEventFromIcs(icsText) {
const lines = unfoldIcsLines(icsText);
let current = null;
const events = [];
const seenUids = new Set();
lines.forEach((line) => {
if (line === 'BEGIN:VEVENT') { current = {}; return; }
if (line === 'END:VEVENT') {
if (current) {
const uid = current.uid || '';
if (!uid || !seenUids.has(uid)) {
if (uid) seenUids.add(uid);
events.push(current);
}
}
current = null;
return;
}
if (!current) return;
const prop = parseIcsProperty(line);
if (!prop) return;
if (prop.name === 'UID') current.uid = prop.value.trim();
else if (prop.name === 'SUMMARY') current.title = unescapeIcsValue(prop.value).trim();
else if (prop.name === 'LOCATION') current.location = unescapeIcsValue(prop.value).trim();
else if (prop.name === 'DESCRIPTION') current.notes = unescapeIcsValue(prop.value).trim();
else if (prop.name === 'URL') current.link = prop.value.trim();
else if (prop.name === 'DTSTART') current.start = icsDateTime(prop.value);
else if (prop.name === 'DTEND') current.end = icsDateTime(prop.value);
});
return events.map((event) => ({
title: event.title || '', date: event.start?.date || '', eventTime: event.start?.time || '',
endTime: event.end?.time || '', location: event.location || '', notes: event.notes || '', link: event.link || '',
}));
}

// The quality gate for one extractDateEventFromIcs result -- title and a
// start date are the two things the old subject-line default couldn't
// give you; venue/time/link are worth keeping but not worth an AI
// fallback over if they're missing.
function icsDateEventIsGoodEnough(result) {
return !!(result && result.title && result.date);
}

// One checked-by-default row in the dateEvent picker's multi-event review
// list (data-mail-date-event-list above) -- same .pending-option shape
// manualimport.js/books.js's own review screens already use, just a
// checkbox instead of a radio since more than one can be ticked at once.
// The whole extraction result rides along as a JSON blob in the hidden
// input's value, the same "stash it on the element, the Add handler reads
// it back" convention the single-event path already uses on the Add
// button's own dataset.
function dateEventRowHtml(ev) {
const when = ev.date ? `${ev.date}${ev.eventTime ? ` ${ev.eventTime}` : ''}` : 'no date found';
return `<label class="pending-option">
<input type="checkbox" checked data-mail-date-event-row-check>
<input type="hidden" data-mail-date-event-row-data value='${escapeHtml(JSON.stringify(ev))}'>
<span class="pending-option-info"><strong>${escapeHtml(ev.title || 'Untitled')}</strong><span class="compare-caption">${escapeHtml(when)}</span></span>
</label>`;
}

// The clickable control for one action on one message — a plain button for
// 'task' (its own always-live ✓-already-captured swap, unchanged from
// before this file had topics at all), a toggle for anything picker-kind
// (tripLeg, dateEvent) that reveals actionPickerHtml's matching container.
// Used identically whether this action is one of the topic's preferred 1-3
// or sitting in the "Other actions" list — same control, different place.
function actionTriggerHtml(actionId, m) {
if (actionId === 'task') {
const existing = existingTaskFor(m);
// Tasks are synced, so a task made on the desktop must be recognised
// when the same mail is re-read on the phone. Matching on the source
// URL rather than on anything session-local is what makes that work.
if (existing) {
// "Improve" is deliberately NOT a MAIL_ACTIONS entry -- it only ever
// makes sense once a task already exists for this message, so it
// rides along with the ✓ state here rather than being a 4th
// catalog entry that would need its own preferred/other placement.
return `<button class="mini-task-btn done" type="button" data-goto-task="${escapeHtml(existing.id)}" title="Already captured — go to it">✓ task</button>
<button class="mini-task-btn" type="button" title="Read the email and propose a better title/notes/due for this task" data-mail-action-toggle="improveTask:${escapeHtml(m.id)}">✨ Improve</button>`;
}
return `<button class="mini-task-btn" type="button" title="${escapeHtml(MAIL_ACTIONS.task.title)}"
data-mail-task="${escapeHtml(m.id)}"
data-mail-subject="${escapeHtml(m.subject)}"
data-mail-from="${escapeHtml(displayName(m.from))}"
data-mail-url="${escapeHtml(m.link)}">+ task</button>`;
}
const action = MAIL_ACTIONS[actionId];
if (!action) return '';
return `<button class="mini-task-btn" type="button" title="${escapeHtml(action.title)}" data-mail-action-toggle="${actionId}:${escapeHtml(m.id)}">${escapeHtml(action.label)}</button>`;
}

// A "✨ Use AI" button shared by every AI-assisted picker below -- same
// subject/from dataset trip-leg's own extract button already carries, so
// the click handler can read the email without needing the original `m`.
function useAiButtonHtml(fillAttr, m) {
return `<button class="mini-task-btn" type="button" ${fillAttr}="${escapeHtml(m.id)}"
data-mail-subject="${escapeHtml(m.subject)}" data-mail-from="${escapeHtml(displayName(m.from))}">✨ Use AI</button>`;
}

// The revealed panel for one picker-kind action on one message — always
// rendered (hidden) regardless of whether this action is preferred for the
// row's topic, since it can also be reached from "Other actions".
// `improveTask` is the one exception rendered outside MAIL_ACTIONS
// entirely (see actionTriggerHtml's 'task' branch) -- included here too
// since messageRowHtml appends it the same way.
function actionPickerHtml(actionId, m) {
if (actionId === 'tripLeg') {
return `<div class="mail-action-picker" data-mail-action-picker="tripLeg:${escapeHtml(m.id)}" hidden>
${legTargetPickerHtml(m.id)}
<button class="todo-add-btn" type="button" data-mail-trip-extract="${escapeHtml(m.id)}"
data-mail-subject="${escapeHtml(m.subject)}" data-mail-from="${escapeHtml(displayName(m.from))}" data-mail-url="${escapeHtml(m.link)}">&#10024; Read email &amp; add</button>
<span class="sync-status" data-mail-trip-status="${escapeHtml(m.id)}"></span>
</div>`;
}
if (actionId === 'dateEvent') {
return `<div class="mail-action-picker" data-mail-action-picker="dateEvent:${escapeHtml(m.id)}" hidden>
${connectionPickerHtml(`mail-date-event-conn-${m.id}`, 'Link a connection (optional)…')}
<input type="text" class="settings-input" data-mail-date-event-title="${escapeHtml(m.id)}" value="${escapeHtml(m.subject)}" placeholder="Idea title">
<button class="mini-task-btn" type="button" data-mail-date-event-extract="${escapeHtml(m.id)}"
data-mail-subject="${escapeHtml(m.subject)}" data-mail-from="${escapeHtml(displayName(m.from))}"
title="Try the calendar invite first, then read the email if there isn't one">&#129497; Extract details</button>
<div class="pending-options" data-mail-date-event-list="${escapeHtml(m.id)}" hidden></div>
<button class="todo-add-btn" type="button" data-mail-date-event-add="${escapeHtml(m.id)}" data-mail-snippet="${escapeHtml(m.snippet || '')}" data-mail-url="${escapeHtml(m.link)}">Add idea</button>
<span class="sync-status" data-mail-date-event-status="${escapeHtml(m.id)}"></span>
</div>`;
}
if (actionId === 'aiTask') {
// Prefilled with the SAME deterministic default plain "+ task"
// produces -- "Use AI" is what replaces it, not the starting point.
return `<div class="mail-action-picker" data-mail-action-picker="aiTask:${escapeHtml(m.id)}" hidden>
<input type="text" class="settings-input" data-mail-ai-task-title="${escapeHtml(m.id)}" value="${escapeHtml(`Reply: ${m.subject}`)}" placeholder="Task title">
<textarea class="settings-input" data-mail-ai-task-notes="${escapeHtml(m.id)}" rows="2" placeholder="Notes">${escapeHtml(`From ${displayName(m.from)}`)}</textarea>
<input type="date" class="settings-input" data-mail-ai-task-due="${escapeHtml(m.id)}">
${useAiButtonHtml('data-mail-ai-task-fill', m)}
<button class="todo-add-btn" type="button" data-mail-ai-task-add="${escapeHtml(m.id)}" data-mail-url="${escapeHtml(m.link)}">Add task</button>
<span class="sync-status" data-mail-ai-task-status="${escapeHtml(m.id)}"></span>
</div>`;
}
if (actionId === 'complex') {
// For the rare email where the one-click actions above guess wrong --
// an order covering more than one separate thing, something easy to
// miscategorise. (a)/(b) are free text, appended to whichever target's
// OWN existing extraction function as guidance (ai.js's
// guidanceInstruction, shared identically by all three) -- this dialog
// doesn't reimplement extraction, it just chooses which existing one
// to call and hands it the hint. The per-target extras below
// (connection picker / trip-target picker) are the SAME ones dateEvent/
// tripLeg's own pickers already use, just swapped by the target select
// rather than living in three separate dialogs.
return `<div class="mail-action-picker" data-mail-action-picker="complex:${escapeHtml(m.id)}" hidden>
<textarea class="settings-input" data-mail-complex-what="${escapeHtml(m.id)}" rows="2" placeholder="What is this email actually? e.g. &quot;An order confirmation covering 2 separate concerts&quot;"></textarea>
<textarea class="settings-input" data-mail-complex-outcome="${escapeHtml(m.id)}" rows="2" placeholder="What do you want out of it? e.g. &quot;2 date events, each with its own 2 tickets attached&quot;"></textarea>
<select class="settings-input" data-mail-complex-target="${escapeHtml(m.id)}">
<option value="dateEvent">Date event(s)</option>
<option value="tripLeg">Trip leg</option>
<option value="task">Task</option>
</select>
<div data-mail-complex-dateevent="${escapeHtml(m.id)}">${connectionPickerHtml(`mail-complex-conn-${m.id}`, 'Link a connection (optional)…')}</div>
<div data-mail-complex-tripleg="${escapeHtml(m.id)}" hidden>${legTargetPickerHtml(`mail-complex-leg-${m.id}`)}</div>
<button class="todo-add-btn" type="button" data-mail-complex-submit="${escapeHtml(m.id)}"
data-mail-subject="${escapeHtml(m.subject)}" data-mail-from="${escapeHtml(displayName(m.from))}" data-mail-url="${escapeHtml(m.link)}">&#129497; Extract &amp; create</button>
<span class="sync-status" data-mail-complex-status="${escapeHtml(m.id)}"></span>
</div>`;
}
if (actionId === 'checkCalendar') {
return `<div class="mail-action-picker" data-mail-action-picker="checkCalendar:${escapeHtml(m.id)}" hidden>
<select class="settings-input" data-mail-check-cal="${escapeHtml(m.id)}"><option value="">Loading your calendars…</option></select>
<button class="todo-add-btn" type="button" data-mail-check-cal-submit="${escapeHtml(m.id)}">&#128197; Check/update calendar</button>
<span class="sync-status" data-mail-check-cal-status="${escapeHtml(m.id)}"></span>
</div>`;
}
if (actionId === 'addRule') {
// Defaults to THIS message's own from/subject verbatim -- untouched,
// the rule only matches an identical sender+subject pair again (a
// recurring digest); loosening either field to a shorter substring is
// a deliberate edit, not the starting point. Blank from/blank subject
// both filter nothing on that field (see mailRules.js's matchMailRule).
const outcomeOptions = Object.keys(CAPTURE_OUTCOMES).map((k) => `<option value="${k}">${escapeHtml(outcomeLabelWithCost(CAPTURE_OUTCOMES[k]))}</option>`).join('');
return `<div class="mail-action-picker" data-mail-action-picker="addRule:${escapeHtml(m.id)}" hidden>
<input type="text" class="settings-input" data-mail-rule-label="${escapeHtml(m.id)}" value="${escapeHtml(m.subject)}" placeholder="Rule label">
<input type="text" class="settings-input" data-mail-rule-from="${escapeHtml(m.id)}" value="${escapeHtml(m.from)}" placeholder="From contains…">
<input type="text" class="settings-input" data-mail-rule-subject="${escapeHtml(m.id)}" value="${escapeHtml(m.subject)}" placeholder="Subject contains…">
<select class="settings-input" data-mail-rule-outcome="${escapeHtml(m.id)}">${outcomeOptions}</select>
<button class="todo-add-btn" type="button" data-mail-rule-create="${escapeHtml(m.id)}">+ Create &amp; run</button>
<span class="sync-status" data-mail-rule-status="${escapeHtml(m.id)}"></span>
</div>`;
}
if (actionId === 'improveTask') {
const existing = existingTaskFor(m);
if (!existing) return ''; // only ever offered alongside an already-captured task
return `<div class="mail-action-picker" data-mail-action-picker="improveTask:${escapeHtml(m.id)}" hidden>
<input type="text" class="settings-input" data-mail-improve-task-title="${escapeHtml(m.id)}" value="${escapeHtml(existing.title)}" placeholder="Task title">
<textarea class="settings-input" data-mail-improve-task-notes="${escapeHtml(m.id)}" rows="2" placeholder="Notes">${escapeHtml(existing.notes)}</textarea>
<input type="date" class="settings-input" data-mail-improve-task-due="${escapeHtml(m.id)}" value="${escapeHtml(existing.due || '')}">
${useAiButtonHtml('data-mail-improve-task-fill', m)}
<button class="todo-add-btn" type="button" data-mail-improve-task-apply="${escapeHtml(m.id)}" data-mail-improve-task-id="${escapeHtml(existing.id)}">Apply</button>
<span class="sync-status" data-mail-improve-task-status="${escapeHtml(m.id)}"></span>
</div>`;
}
return '';
}

// `topic`, when given, supplies up to 3 preferred action ids (in configured
// order); everything else registered in MAIL_ACTIONS still shows, under
// "Other actions" — a booking email can always be taken as a plain task
// even when Task isn't Travel's own preferred pick. `topic` is null for a
// message from a search with no topic assigned, which shows every action
// under "Other actions" (nothing preferred) rather than guessing.
function messageRowHtml(m, topic) {
// A "zxc D"/"zxc L" subject marker already queued a draft for this exact
// message (processMailMarkers) -- offering the normal action buttons
// too would risk a second, duplicate record once both are confirmed, so
// this swaps them for a single link to the pending review instead, same
// "don't offer to create a second one" reasoning existingTaskFor's own
// "✓ task" swap already follows.
const pendingDraft = existingDraftFor(m);
const actionsHtml = pendingDraft
? `<span class="mail-draft-pending" data-mail-goto-draft="${escapeHtml(pendingDraft.id)}" title="A marker already queued this for review">&#128221; Awaiting review</span>`
: (() => {
const preferredIds = ((topic && topic.preferredActionIds) || []).filter((id) => MAIL_ACTIONS[id]).slice(0, 3);
const otherIds = Object.keys(MAIL_ACTIONS).filter((id) => !preferredIds.includes(id));
const otherHtml = otherIds.length
? `<span class="mail-other-actions">
<button class="mini-task-btn" type="button" data-mail-other-toggle="${escapeHtml(m.id)}">&#8943; Other actions</button>
<span class="mail-other-menu" data-mail-other-menu="${escapeHtml(m.id)}" hidden>${otherIds.map((id) => actionTriggerHtml(id, m)).join('')}</span>
</span>`
: '';
return `${preferredIds.map((id) => actionTriggerHtml(id, m)).join('')}${otherHtml}`;
})();
const pickersHtml = pendingDraft ? '' : Object.keys(MAIL_ACTIONS)
.filter((id) => MAIL_ACTIONS[id].kind === 'picker')
.map((id) => actionPickerHtml(id, m)).join('')
+ (existingTaskFor(m) ? actionPickerHtml('improveTask', m) : '');
// Opens the message in the app rather than linking to Gmail: its web UI
// ignores both ids the API gives us, so every such link landed on the
// inbox (see mailviewer.js). The Gmail link survives as a small "↗" for
// replying, where the inbox is at least the right account.
return `<div class="mail-row">
<span class="mail-link" role="button" tabindex="0" data-mail-open="${escapeHtml(m.id)}" data-mail-open-subject="${escapeHtml(m.subject)}" style="cursor:pointer;">
<span class="mail-from">${escapeHtml(displayName(m.from))}</span>
<span class="mail-subject">${escapeHtml(m.subject)}</span>
<span class="mail-date">${escapeHtml(formatDate(m.date))}</span>
</span>
<a class="mini-task-btn" href="${escapeHtml(affiliateLink(m.link))}" target="_blank" rel="noopener" title="Open Gmail (to reply)">&#8599;</a>
${actionsHtml}
<button class="mail-dismiss-btn" type="button" title="Dismiss — not turning this into anything, just stop showing it"
data-mail-dismiss="${escapeHtml(m.id)}" data-mail-url="${escapeHtml(m.link)}" data-mail-subject="${escapeHtml(m.subject)}" data-mail-from="${escapeHtml(displayName(m.from))}">&times;</button>
</div>
${pickersHtml}`;
}

// A digest row for a subject that appeared more than once (some senders
// blast the identical subject repeatedly) -- one row + count instead of N
// near-identical ones. `group` is every message sharing this subject,
// already date-sorted (sectionHtml sorts before grouping), so group[0] is
// the most recent. `visibleGroup` (open + processed, never dismissed --
// nothing dismissed is ever individually re-shown here) expands under a
// "Show all" toggle using the SAME messageRowHtml every other row uses,
// so each one keeps its own full, independent set of action/dismiss
// controls -- consolidation is purely a display grouping, never a
// shortcut that acts on more than one message at once.
function consolidatedRowHtml(group, byStatus, topic) {
const latest = group[0];
const parts = [];
if (byStatus.open.length) parts.push(`${byStatus.open.length} open`);
if (byStatus.drafted.length) parts.push(`${byStatus.drafted.length} awaiting review`);
if (byStatus.processed.length) parts.push(`${byStatus.processed.length} actioned`);
if (byStatus.dismissed.length) parts.push(`${byStatus.dismissed.length} binned`);
const visibleGroup = [...byStatus.open, ...byStatus.drafted, ...byStatus.processed];
const expanded = expandedGroups.has(latest.id);
const toggleHtml = visibleGroup.length
? `<button class="mini-task-btn" type="button" data-mail-group-toggle="${escapeHtml(latest.id)}">${expanded ? 'Hide' : 'Show'} all</button>`
: '';
// Bins every still-visible message in this group in one click -- the
// literal ask: duplicate blasts of the identical subject are noise as a
// GROUP, not one dismiss at a time. Uses the same dismiss mechanism each
// row's own × already does (blankMailDismissal by url), just looped.
const memberPayload = escapeHtml(JSON.stringify(visibleGroup.map((m) => ({ url: m.link, subject: m.subject, from: displayName(m.from) }))));
const dismissAllHtml = visibleGroup.length > 1
? `<button class="mini-task-btn" type="button" data-mail-group-dismiss-all="${escapeHtml(latest.id)}" data-mail-group-members="${memberPayload}" title="Bin every message in this group">Bin all ${visibleGroup.length}</button>`
: '';
const detailHtml = visibleGroup.length
? `<div class="mail-group-detail" data-mail-group-detail="${escapeHtml(latest.id)}"${expanded ? '' : ' hidden'}>${visibleGroup.map((m) => messageRowHtml(m, topic)).join('')}</div>`
: '';
return `<div class="mail-row mail-row-group">
<span class="mail-from">${escapeHtml(displayName(latest.from))}</span>
<span class="mail-subject">${escapeHtml(latest.subject)} <span class="mail-group-count">&times;${group.length}</span></span>
<span class="mail-group-breakdown">${escapeHtml(parts.join(' · '))}</span>
${toggleHtml}${dismissAllHtml}
</div>
${detailHtml}`;
}

// `limit` is how many ACTIONABLE (open) messages this heading should show
// before the rest -- a processed or dismissed one never counts against
// it. A dismissed message is never rendered anywhere in Mail at all (see
// Settings' "Mail bin" for that); a processed one lands in the collapsed
// "already processed" details regardless of how many there are. Same
// subject appearing more than once collapses to one row (consolidatedRowHtml)
// wherever it lands -- the open/closed split happens first, by group, so
// a group with even one open message still surfaces in the visible list.
// Returns {html, openCount} -- openCount lets renderMail total up "N
// shown" by actual open MESSAGE count, not by row (a consolidated row is
// one row representing several).
function sectionHtml(title, messages, topic, limit) {
if (messages.length === 0) return { html: '', openCount: 0 };

const groups = new Map(); // subject -> messages[], insertion order == messages' own date-desc order
messages.forEach((m) => {
const key = m.subject || '';
if (!groups.has(key)) groups.set(key, []);
groups.get(key).push(m);
});

const openRows = []; // [{html, openCount}], budget-capped below
const closedRows = []; // fully-closed groups/singles, always all shown (collapsed)
for (const group of groups.values()) {
const byStatus = { open: [], drafted: [], processed: [], dismissed: [] };
group.forEach((m) => byStatus[messageStatus(m)].push(m));
if (byStatus.open.length) {
openRows.push({
html: group.length === 1 ? messageRowHtml(group[0], topic) : consolidatedRowHtml(group, byStatus, topic),
openCount: byStatus.open.length,
});
continue;
}
// No open messages left in this subject -- fully closed. A dismissed-
// only subject (nothing processed OR drafted either) has nothing left
// worth a summary line at all; skip it entirely rather than cluttering
// "already processed" with something that was actually binned.
if (!byStatus.processed.length && !byStatus.drafted.length) continue;
closedRows.push(group.length === 1 ? messageRowHtml(group[0], topic) : consolidatedRowHtml(group, byStatus, topic));
}

let budget = limit || Infinity;
const shownOpenHtml = [];
let shownOpenCount = 0;
for (const row of openRows) {
if (budget <= 0) break;
shownOpenHtml.push(row.html);
shownOpenCount += row.openCount;
budget -= row.openCount;
}

if (!shownOpenHtml.length && !closedRows.length) return { html: '', openCount: 0 };
const actionableHtml = shownOpenHtml.length ? `<div class="mail-section">${shownOpenHtml.join('')}</div>` : '';
// A native <details> -- no custom hidden-attribute toggle needed, the
// browser already handles its own open/collapsed state.
const processedHtml = closedRows.length
? `<details class="mail-processed"><summary>&#10003; ${closedRows.length} already processed</summary><div class="mail-section">${closedRows.join('')}</div></details>`
: '';
return { html: `<div class="overview-group"><h3>${escapeHtml(title)}</h3>${actionableHtml}${processedHtml}</div>`, openCount: shownOpenCount };
}

// A section heading says what the row searched for and, when it's limited to
// a window, how far back — otherwise "From: x (3)" is ambiguous about
// whether that's all of them or just the recent ones.
function sectionTitle(search) {
const label = mailSearchLabel(search);
const days = Math.max(0, Number(search.maxDays) || 0);
return days > 0 ? `${label} — last ${days} day${days === 1 ? '' : 's'}` : label;
}

// A "zxc" + trigger letter anywhere in the subject (e.g. "zxc D") --
// space between the prefix and the letter on purpose, so ONE Mail search
// for the bare word "zxc" catches every marker at once (Gmail's own
// subject: search matches whole tokens, not substrings inside a longer
// word -- "zxcD" glued together would each be a different word to
// Gmail's tokenizer, defeating a single catch-all search). Case-
// insensitive on the letter itself since a phone keyboard capitalizes
// unpredictably; matchCaptureRule below still gets it uppercased,
// matching imageMarker/urlSuffix's own always-uppercase trigger.
const EMAIL_SUBJECT_MARKER = /\bzxc\s+([A-Za-z])\b/i;

// Runs once per "Refresh mail" -- every OPEN message (skips anything
// already actioned/dismissed/drafted, so a marker is only ever acted on
// once) gets checked for a subject marker and, if one matches a
// configured rule (data.prefs.captureRules, Settings' "Capture markers
// & suffixes"), processed right away: a `commitMode:'direct'` outcome
// (Task/Reading/Supermarket) is created immediately, same as the
// existing image-marker/URL-suffix paths already do; a `commitMode:
// 'draft'` outcome (Event/Trip leg -- captureOutcomes.js) has its
// extraction run now but lands in the Smart Capture drafts queue
// (data.captureDrafts) for review, never created outright -- the actual
// AI/ICS work happens here so the draft card has something real to show,
// but nothing is written until you confirm it. One bad message's
// failure is logged and skipped, never blocks the rest.
// Deliberately top-level (a sibling of renderMail/initMail, NOT nested
// inside either) -- initMail's sync handler calls this directly, a
// separate scope from renderMail's own self-rebinding body.
async function processMailMarkers(sections) {
let direct = 0;
let drafted = 0;
for (const { messages } of sections) {
for (const m of messages) {
if (messageStatus(m) !== 'open') continue;
const match = EMAIL_SUBJECT_MARKER.exec(m.subject || '');
if (!match) continue;
const rule = matchCaptureRule(data, 'emailSubject', match[1].toUpperCase());
if (!rule) continue;
try {
const result = await runOutcomeOnMessage(rule.outcome, m);
if (result === 'draft') drafted++; else if (result === 'direct') direct++;
} catch (err) {
console.error(`Mail marker "${rule.trigger}" failed for "${m.subject}":`, err);
}
}
}
if (direct || drafted) queueSave();
const parts = [];
if (direct) parts.push(`${direct} auto-processed`);
if (drafted) parts.push(`${drafted} queued for review`);
return parts.join(', ');
}

function renderMail(sections) {
const list = document.getElementById('mail-list');

// A topic-assigned search merges into one shared heading per topic
// (dropping its own "last N days" sub-label -- a heading combining
// several searches with different maxDays can't summarise that in one
// number). Its actionable cap is the SUM of every search feeding that
// topic's own configured limit -- each search still gets to contribute
// up to what it was set up for. A search with NO topic renders exactly
// as it always has, one heading per search with its own sectionTitle --
// so a panel with no topics configured yet looks completely unchanged.
const byTopic = new Map(); // topicId -> { messages: [], limit: 0 }
const untopicked = [];
sections.forEach((s) => {
if (s.search.topicId) {
if (!byTopic.has(s.search.topicId)) byTopic.set(s.search.topicId, { messages: [], limit: 0 });
const bucket = byTopic.get(s.search.topicId);
bucket.messages.push(...s.messages);
bucket.limit += s.limit;
} else {
untopicked.push(s);
}
});
const topicSections = data.mailTopics
.filter((t) => byTopic.has(t.id))
.map((t) => {
const { messages, limit } = byTopic.get(t.id);
return sectionHtml(t.label || 'Untitled topic', messages.sort((a, b) => new Date(b.date) - new Date(a.date)), t, limit);
});
const untopickedSections = untopicked.map((s) => sectionHtml(sectionTitle(s.search), s.messages, null, s.limit));

const rendered = [...topicSections, ...untopickedSections].filter((r) => r.html);
const html = rendered.map((r) => r.html).join('');
list.innerHTML = html || (data.mailSearches.length === 0
? '<div class="empty">No mail searches set up — add some in <span class="inline-goto-link" data-goto-tab="settings" data-goto-target="#mail-searches-block">Settings</span>.</div>'
: '<div class="empty">Nothing matched your mail searches.</div>');

// Counted from the actual openCount each section computed, not by
// querying the DOM for .mail-row -- a consolidated row is one row
// representing several open messages, which a DOM count would undercount.
const shown = rendered.reduce((n, r) => n + r.openCount, 0);
document.getElementById('mail-count').textContent = `${shown} shown`;

list.querySelectorAll('[data-mail-group-toggle]').forEach((btn) => {
btn.addEventListener('click', (e) => {
e.preventDefault();
const id = btn.dataset.mailGroupToggle;
if (expandedGroups.has(id)) expandedGroups.delete(id); else expandedGroups.add(id);
// Full re-render rather than just flipping `hidden` in place -- state
// now lives in expandedGroups, so this stays correct even though a
// dismiss inside the group re-renders the whole list anyway.
renderMail(lastSections);
});
});

// Both dismiss paths funnel through here -- a single row's × and the
// group's own "Bin all" -- so a message is only ever binned once
// (dismissedFor's url match already guards a re-run) and both save/render
// exactly the same way.
function dismissMessage({ url, subject, from }) {
if (!data.mailDismissed.some((d) => d.url === url)) {
data.mailDismissed.push(blankMailDismissal({ url, subject, from }));
}
}

list.querySelectorAll('[data-mail-open]').forEach((row) => {
const open = async () => {
const { openMessage } = await import('./mailviewer.js');
openMessage(row.dataset.mailOpen, { subject: row.dataset.mailOpenSubject });
};
row.addEventListener('click', open);
// It behaves like a button, so it answers to a keyboard like one.
row.addEventListener('keydown', (e) => {
if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
});
});

list.querySelectorAll('[data-mail-dismiss]').forEach((btn) => {
btn.addEventListener('click', (e) => {
e.preventDefault();
dismissMessage({ url: btn.dataset.mailUrl, subject: btn.dataset.mailSubject, from: btn.dataset.mailFrom });
queueSave();
// Re-render from the same fetched data rather than re-fetching Gmail
// -- dismissing is purely a local view change, nothing new to pull.
renderMail(lastSections);
});
});

list.querySelectorAll('[data-mail-group-dismiss-all]').forEach((btn) => {
btn.addEventListener('click', (e) => {
e.preventDefault();
let members = [];
try { members = JSON.parse(btn.dataset.mailGroupMembers || '[]'); } catch (err) { /* stashed value always valid JSON */ }
members.forEach(dismissMessage);
queueSave();
// The group itself is gone now (everything in it just got binned) --
// no detail left to stay expanded for.
expandedGroups.delete(btn.dataset.mailGroupDismissAll);
renderMail(lastSections);
});
});

list.querySelectorAll('[data-goto-task]').forEach((btn) => {
btn.addEventListener('click', async (e) => {
e.preventDefault();
const [{ switchTab }, tasks] = await Promise.all([import('../tabs.js'), import('./tasks.js')]);
switchTab('tasks');
tasks.revealTask(btn.dataset.gotoTask);
});
});

list.querySelectorAll('[data-mail-goto-draft]').forEach((el) => {
el.addEventListener('click', async () => {
const [{ switchTab }, voicecapture] = await Promise.all([import('../tabs.js'), import('./voicecapture.js')]);
switchTab('tasks');
voicecapture.revealCaptureDraft(el.dataset.mailGotoDraft);
});
});

list.querySelectorAll('[data-mail-task]').forEach((btn) => {
btn.addEventListener('click', (e) => {
e.preventDefault();
captureTask({
title: `Reply: ${btn.dataset.mailSubject}`,
notes: `From ${btn.dataset.mailFrom}`,
source: { kind: 'mail', label: btn.dataset.mailSubject, url: btn.dataset.mailUrl },
});
btn.textContent = '✓ captured';
btn.disabled = true;
});
});

list.querySelectorAll('[data-mail-other-toggle]').forEach((btn) => {
btn.addEventListener('click', (e) => {
e.preventDefault();
const menu = list.querySelector(`[data-mail-other-menu="${CSS.escape(btn.dataset.mailOtherToggle)}"]`);
if (menu) menu.hidden = !menu.hidden;
});
});

list.querySelectorAll('[data-mail-action-toggle]').forEach((btn) => {
btn.addEventListener('click', (e) => {
e.preventDefault();
const [actionId, id] = btn.dataset.mailActionToggle.split(':');
const picker = list.querySelector(`[data-mail-action-picker="${CSS.escape(actionId)}:${CSS.escape(id)}"]`);
if (!picker) return;
picker.hidden = !picker.hidden;
if (!picker.hidden && actionId === 'tripLeg') bindLegTargetPicker(picker, id);
if (!picker.hidden && actionId === 'complex') bindLegTargetPicker(picker, `mail-complex-leg-${id}`);
if (!picker.hidden && actionId === 'checkCalendar') {
const select = picker.querySelector(`[data-mail-check-cal="${CSS.escape(id)}"]`);
if (select && !select.dataset.loaded) {
select.dataset.loaded = '1';
// Checked for a real sign-in FIRST -- canAttemptGoogleAction never
// itself prompts, but calling listCalendars() straight away when
// signed out pops a real Google sign-in window the instant this
// picker opens, with no click of the user's own aimed at Google at
// all (confirmed live on the same pattern in planner.js).
canAttemptGoogleAction().then((signedIn) => {
if (!signedIn) { select.innerHTML = '<option value="">Sign in to Google at the top of Overview first</option>'; return; }
return import('../googlecalendar.js').then(({ listCalendars }) => listCalendars()).then((cals) => {
select.innerHTML = cals.length ? cals.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.summary)}</option>`).join('') : '<option value="">No calendars found</option>';
});
}).catch(() => { select.innerHTML = '<option value="">Couldn\'t load calendars</option>'; });
}
}
});
});

list.querySelectorAll('[data-mail-rule-create]').forEach((btn) => {
btn.addEventListener('click', async (e) => {
e.preventDefault();
const id = btn.dataset.mailRuleCreate;
const status = list.querySelector(`[data-mail-rule-status="${CSS.escape(id)}"]`);
const say = (msg) => { if (status) status.textContent = msg; };
const m = lastSections.flatMap((s) => s.messages).find((mm) => mm.id === id);
if (!m) { say("Couldn't find that message — try refreshing."); return; }
const from = (list.querySelector(`[data-mail-rule-from="${CSS.escape(id)}"]`)?.value || '').trim();
const subject = (list.querySelector(`[data-mail-rule-subject="${CSS.escape(id)}"]`)?.value || '').trim();
if (!from && !subject) { say('Set at least a sender or subject to match on.'); return; }
const label = (list.querySelector(`[data-mail-rule-label="${CSS.escape(id)}"]`)?.value || '').trim() || m.subject;
const outcome = list.querySelector(`[data-mail-rule-outcome="${CSS.escape(id)}"]`)?.value || 'task';
btn.disabled = true;
say('Saving rule and running it on this email…');
data.mailRules.push(blankMailRule({ label, from, subject, outcome }));
queueSave();
try {
const result = await runOutcomeOnMessage(outcome, m);
renderMail(lastSections);
// Picker is gone after the re-render above (a fresh, collapsed one),
// so the status note from here on would have nowhere to land --
// nothing further to say that the row's own new state doesn't
// already show (✓ task, a drafted card, etc).
if (result == null) console.error(`Mail rule saved, but outcome "${outcome}" no longer exists.`);
} catch (err) {
say(`Rule saved, but running it on this email failed: ${err.message || err}`);
console.error('Mail rule run failed:', err);
btn.disabled = false;
}
});
});

list.querySelectorAll('[data-mail-complex-target]').forEach((sel) => {
sel.addEventListener('change', () => {
const id = sel.dataset.mailComplexTarget;
const dateEventExtra = list.querySelector(`[data-mail-complex-dateevent="${CSS.escape(id)}"]`);
const tripLegExtra = list.querySelector(`[data-mail-complex-tripleg="${CSS.escape(id)}"]`);
if (dateEventExtra) dateEventExtra.hidden = sel.value !== 'dateEvent';
if (tripLegExtra) tripLegExtra.hidden = sel.value !== 'tripLeg';
});
});

list.querySelectorAll('[data-mail-complex-submit]').forEach((btn) => {
btn.addEventListener('click', async (e) => {
e.preventDefault();
const id = btn.dataset.mailComplexSubmit;
const status = list.querySelector(`[data-mail-complex-status="${CSS.escape(id)}"]`);
const say = (msg) => { if (status) status.textContent = msg; };
const what = (list.querySelector(`[data-mail-complex-what="${CSS.escape(id)}"]`)?.value || '').trim();
const outcome = (list.querySelector(`[data-mail-complex-outcome="${CSS.escape(id)}"]`)?.value || '').trim();
const guidance = [what && `This email is: ${what}.`, outcome && `What I want out of it: ${outcome}.`].filter(Boolean).join(' ');
const target = list.querySelector(`[data-mail-complex-target="${CSS.escape(id)}"]`)?.value || 'dateEvent';
btn.disabled = true;
say('Reading the email…');
try {
const [aiMod, { bodyText, icsText, attachments }] = await Promise.all([import('../ai.js'), getMessageDetail(id)]);
if (target === 'task') {
say('Pulling out the details…');
const result = await aiMod.extractTaskFromEmail(btn.dataset.mailSubject, btn.dataset.mailFrom, bodyText, guidance);
const task = captureTask({
title: result.title || btn.dataset.mailSubject, notes: result.notes || '', due: result.due || '', link: result.link || '',
source: { kind: 'mail', label: result.title || btn.dataset.mailSubject, url: btn.dataset.mailUrl },
});
bindTaskChips();
say('');
if (status) status.innerHTML = `Added ${taskChipHtml(task)}.`;
const grabbed = await grabEmailAttachments(id, attachments);
if (grabbed.length) {
task.attachments.push(...grabbed);
queueSave();
if (status) status.innerHTML = `Added ${taskChipHtml(task)} (+ ${grabbed.length} attachment${grabbed.length === 1 ? '' : 's'}).`;
(await import('./tasks.js')).renderTasks();
}
} else if (target === 'tripLeg') {
say('Pulling out the details…');
const extraction = await aiMod.extractTripLegFromEmail(btn.dataset.mailSubject, btn.dataset.mailFrom, bodyText, guidance);
if (!extraction.kind && Object.keys(extraction.fields).length === 0) {
say("Didn't recognise this as travel logistics — try a different target, or add more in the guidance fields above.");
btn.disabled = false;
return;
}
const picker = list.querySelector(`[data-mail-action-picker="complex:${CSS.escape(id)}"]`);
const picked = readLegTargetPicker(picker, `mail-complex-leg-${id}`);
const { trip, leg, filled } = await applyLegExtraction({
...picked, extraction, source: { kind: 'mail', label: btn.dataset.mailSubject, url: btn.dataset.mailUrl },
});
bindTripChips();
const grabbed = await grabEmailAttachments(id, attachments);
if (grabbed.length) { leg.attachments.push(...grabbed); queueSave(); }
if (status) {
const gaps = gapsFor(leg);
const completeness = gaps.length === 0 ? 'nothing required is missing' : `${gaps.length} required field${gaps.length === 1 ? '' : 's'} still missing`;
const attachNote = grabbed.length ? ` (+ ${grabbed.length} attachment${grabbed.length === 1 ? '' : 's'})` : '';
status.innerHTML = `Added ${filled} detail${filled === 1 ? '' : 's'} to ${tripChipHtml(trip)} — ${leg.kind} (${completeness})${attachNote}.`;
}
} else {
const icsEvents = icsText ? extractDateEventFromIcs(icsText).filter(icsDateEventIsGoodEnough) : [];
let results = icsEvents;
let source = 'calendar invite';
if (!results.length) {
say('No usable calendar invite — reading the email…');
const { events } = await aiMod.extractDateEventFromEmail(btn.dataset.mailSubject, btn.dataset.mailFrom, bodyText, guidance);
results = events.length ? events : [{ title: btn.dataset.mailSubject, notes: '', date: '', location: '', eventTime: '', endTime: '', link: '', attachmentHints: [] }];
source = 'email';
}
const connectionId = document.getElementById(`mail-complex-conn-${id}`)?.value || '';
const planner = await import('./planner.js');
const activities = planner.createDateEventsFromExtractions(results, {
connectionId, source: { kind: 'mail', label: btn.dataset.mailSubject, url: btn.dataset.mailUrl },
});
planner.bindPlannerActivityChips();
const chipsHtml = activities.map((a) => planner.plannerActivityChipHtml(a)).join(', ');
if (status) status.innerHTML = `Added ${chipsHtml} via the ${source}.`;
let grabbedTotal = 0;
for (let i = 0; i < activities.length; i++) {
const grabbed = await grabEmailAttachments(id, attachments, results[i]?.attachmentHints || []);
if (grabbed.length) { activities[i].attachments.push(...grabbed); grabbedTotal += grabbed.length; }
}
if (grabbedTotal) {
queueSave();
if (status) status.innerHTML = `Added ${chipsHtml} via the ${source} (+ ${grabbedTotal} attachment${grabbedTotal === 1 ? '' : 's'} total).`;
planner.renderPlanner();
}
}
} catch (err) {
console.error('Complex capture failed:', err);
if (err?.name === 'MissingKeyError') { if (status) status.innerHTML = `Add an Anthropic API key in ${MISSING_KEY_LINK_HTML} to use AI here.`; }
else say(`Couldn't read that: ${err.message || err}`);
btn.disabled = false;
return;
}
btn.disabled = false;
});
});

list.querySelectorAll('[data-mail-check-cal-submit]').forEach((btn) => {
btn.addEventListener('click', async (e) => {
e.preventDefault();
const id = btn.dataset.mailCheckCalSubmit;
const status = list.querySelector(`[data-mail-check-cal-status="${CSS.escape(id)}"]`);
const say = (msg) => { if (status) status.textContent = msg; };
if (!(await canAttemptGoogleAction())) { say('Sign in to Google at the top of Overview first.'); return; }
if (!hasCalendarWrite()) { if (status) status.innerHTML = 'Turn on "Allow creating events in Google Calendar" in <span class="inline-goto-link" data-goto-tab="settings" data-goto-target="#calendar-write-toggle">Settings</span>, then sign out and back in.'; return; }
const calendarId = list.querySelector(`[data-mail-check-cal="${CSS.escape(id)}"]`)?.value || '';
if (!calendarId) { say('Pick a calendar first.'); return; }
btn.disabled = true;
say('Reading the email…');
try {
const { icsText } = await getMessageDetail(id);
if (!icsText) { say('No calendar invite found on this email.'); btn.disabled = false; return; }
const events = extractDateEventFromIcs(icsText).filter(icsDateEventIsGoodEnough);
if (!events.length) { say('Found a calendar invite, but could not read a usable title/date from it.'); btn.disabled = false; return; }
say('Checking your calendar…');
const { findEvents, createEvent } = await import('../googlecalendar.js');
const notes = [];
for (const ev of events) {
// +/-1 day window around the event's own date, same generous-but-
// bounded search Airbnb's own dedup uses around a reservation's dates.
const candidates = await findEvents(calendarId, {
timeMin: `${dateStrAdd(ev.date, -1)}T00:00:00Z`, timeMax: `${dateStrAdd(ev.date, 2)}T00:00:00Z`, q: ev.title,
});
if (candidates.length === 1) {
notes.push(`Matched an existing "${candidates[0].summary}" — left as-is.`);
} else if (candidates.length > 1) {
notes.push(`${candidates.length} existing events near ${ev.date} already match "${ev.title}" — too ambiguous to adopt automatically.`);
} else {
await createEvent(calendarId, {
title: ev.title, description: [ev.location, ev.notes].filter(Boolean).join(' — '),
date: ev.date, startTime: ev.eventTime || '', endTime: ev.endTime || '',
});
notes.push(`Pushed "${ev.title}" (${ev.date}).`);
}
}
say(notes.join(' '));
} catch (err) {
console.error('Calendar check failed:', err);
say(`Couldn't check the calendar: ${err.message || err}`);
}
btn.disabled = false;
});
});

list.querySelectorAll('[data-mail-date-event-extract]').forEach((btn) => {
btn.addEventListener('click', async (e) => {
e.preventDefault();
const id = btn.dataset.mailDateEventExtract;
const status = list.querySelector(`[data-mail-date-event-status="${CSS.escape(id)}"]`);
const listEl = list.querySelector(`[data-mail-date-event-list="${CSS.escape(id)}"]`);
const say = (msg) => { if (status) status.textContent = msg; };
btn.disabled = true;
say('Reading the email…');
let results = [];
let source = '';
let attachments = [];
try {
const { bodyText, icsText, attachments: found } = await getMessageDetail(id);
attachments = found;
const icsEvents = icsText ? extractDateEventFromIcs(icsText).filter(icsDateEventIsGoodEnough) : [];
if (icsEvents.length) {
results = icsEvents;
source = 'calendar invite';
} else {
say('No usable calendar invite — reading the email…');
const aiMod = await import('../ai.js');
say('Pulling out the details…');
const { events } = await aiMod.extractDateEventFromEmail(btn.dataset.mailSubject, btn.dataset.mailFrom, bodyText);
results = events.length ? events : [{ title: '', notes: '', date: '', location: '', eventTime: '', endTime: '', link: '', attachmentHints: [] }];
source = 'email';
}
} catch (err) {
console.error('Date-event extraction failed:', err);
if (err?.name === 'MissingKeyError') { if (status) status.innerHTML = `Add an Anthropic API key in ${MISSING_KEY_LINK_HTML} to use AI here.`; }
else say(`Couldn't read that: ${err.message || err}`);
btn.disabled = false;
return;
}
btn.disabled = false;
const titleInput = list.querySelector(`[data-mail-date-event-title="${CSS.escape(id)}"]`);
const addBtn = list.querySelector(`[data-mail-date-event-add="${CSS.escape(id)}"]`);
if (results.length > 1) {
// More than one separate thing in this email (e.g. two gigs' tickets
// bought together) -- review-and-tick instead of the single title/date
// pair, same shape manualimport.js/books.js's own review lists use.
if (listEl) {
listEl.innerHTML = results.map(dateEventRowHtml).join('');
listEl.hidden = false;
listEl.dataset.mailDateEventAttachments = JSON.stringify(attachments || []);
}
const dateCount = results.filter((r) => r.date).length;
say(`Found ${results.length} separate things via the ${source} (${dateCount} with a date) — tick which to add.`);
return;
}
if (listEl) { listEl.hidden = true; listEl.innerHTML = ''; }
const result = results[0];
if (titleInput && result.title) titleInput.value = result.title;
// Stashed on the Add button itself rather than hidden inputs -- the
// same place its deterministic default (data-mail-snippet) already
// lives, and the only thing that reads any of these is the Add handler
// below.
if (addBtn) {
addBtn.dataset.mailSnippet = result.notes || '';
addBtn.dataset.mailDateEventDate = result.date || '';
addBtn.dataset.mailDateEventLocation = result.location || '';
addBtn.dataset.mailDateEventTime = result.eventTime || '';
addBtn.dataset.mailDateEventEndTime = result.endTime || '';
addBtn.dataset.mailLink = result.link || '';
addBtn.dataset.mailAttachments = JSON.stringify(attachments || []);
}
say(result.date ? `Found a date via the ${source}: ${result.date}.` : `No specific date found via the ${source} — will stay an undated idea.`);
});
});

list.querySelectorAll('[data-mail-date-event-add]').forEach((btn) => {
btn.addEventListener('click', async (e) => {
e.preventDefault();
const id = btn.dataset.mailDateEventAdd;
const titleInput = list.querySelector(`[data-mail-date-event-title="${CSS.escape(id)}"]`);
const status = list.querySelector(`[data-mail-date-event-status="${CSS.escape(id)}"]`);
const listEl = list.querySelector(`[data-mail-date-event-list="${CSS.escape(id)}"]`);
const say = (msg) => { if (status) status.textContent = msg; };
const connectionId = document.getElementById(`mail-date-event-conn-${id}`)?.value || '';
const planner = await import('./planner.js');
const tickedChecks = listEl && !listEl.hidden ? [...listEl.querySelectorAll('[data-mail-date-event-row-check]:checked')] : [];
if (tickedChecks.length) {
// The multi-event path: one or more ticked rows from the review list
// above, each carrying its own full extraction result (including its
// own attachmentHints) in its sibling hidden input.
const results = tickedChecks.map((check) => {
const dataInput = check.closest('label')?.querySelector('[data-mail-date-event-row-data]');
try { return JSON.parse(dataInput?.value || '{}'); } catch (err) { return {}; }
});
const title = (titleInput?.value || '').trim() || 'Untitled';
const activities = planner.createDateEventsFromExtractions(results, {
connectionId, source: { kind: 'mail', label: title, url: btn.dataset.mailUrl },
});
planner.bindPlannerActivityChips();
const chipsHtml = activities.map((a) => planner.plannerActivityChipHtml(a)).join(', ');
if (status) status.innerHTML = `Added ${chipsHtml}.`;
btn.disabled = true;
let candidates = [];
try { candidates = JSON.parse(listEl.dataset.mailDateEventAttachments || '[]'); } catch (err) { /* stashed value always valid JSON */ }
let grabbedTotal = 0;
for (let i = 0; i < activities.length; i++) {
const grabbed = await grabEmailAttachments(id, candidates, results[i]?.attachmentHints || []);
if (grabbed.length) { activities[i].attachments.push(...grabbed); grabbedTotal += grabbed.length; }
}
if (grabbedTotal) {
queueSave();
if (status) status.innerHTML = `Added ${chipsHtml} (+ ${grabbedTotal} attachment${grabbedTotal === 1 ? '' : 's'} total).`;
planner.renderPlanner();
}
return;
}
const title = (titleInput?.value || '').trim();
if (!title) { say('Give the idea a title first.'); return; }
// Only ever set by a successful "🪄 Extract details" run above -- absent
// (the deterministic default never sets it) means stay an undated pool
// idea, same as today.
const date = btn.dataset.mailDateEventDate;
const activity = planner.createDateEventFromExtraction({
title, notes: btn.dataset.mailSnippet || '', date,
location: btn.dataset.mailDateEventLocation || '',
eventTime: btn.dataset.mailDateEventTime || '',
endTime: btn.dataset.mailDateEventEndTime || '',
link: btn.dataset.mailLink || '',
}, { connectionId, source: { kind: 'mail', label: title, url: btn.dataset.mailUrl } });
planner.bindPlannerActivityChips();
const dateNote = date ? `, placed on ${date}` : ' to Planner’s Activities pool';
if (status) status.innerHTML = `Added ${planner.plannerActivityChipHtml(activity)}${dateNote}.`;
btn.disabled = true;
// createDateEventFromExtraction already re-renders Planner itself --
// without that, a tab already open on Planner (or switched to right
// after, no reload) wouldn't show the new idea until something else
// triggered a re-render, same cross-tab-refresh convention
// captureTask() callers elsewhere already follow for Connections/
// Overview.
// A ticket/QR image or PDF, if the email had one -- best effort, after
// (never blocking) the idea itself already existing.
let candidates = [];
try { candidates = JSON.parse(btn.dataset.mailAttachments || '[]'); } catch (err) { /* stashed value always valid JSON */ }
const grabbed = await grabEmailAttachments(id, candidates);
if (grabbed.length) {
activity.attachments.push(...grabbed);
queueSave();
if (status) status.innerHTML = `Added ${planner.plannerActivityChipHtml(activity)}${dateNote} (+ ${grabbed.length} attachment${grabbed.length === 1 ? '' : 's'}).`;
planner.renderPlanner();
}
});
});

list.querySelectorAll('[data-mail-ai-task-fill]').forEach((btn) => {
btn.addEventListener('click', async (e) => {
e.preventDefault();
const id = btn.dataset.mailAiTaskFill;
const status = list.querySelector(`[data-mail-ai-task-status="${CSS.escape(id)}"]`);
const say = (msg) => { if (status) status.textContent = msg; };
btn.disabled = true;
const extraction = await runAiExtraction('extractTaskFromEmail', id, btn.dataset.mailSubject, btn.dataset.mailFrom, status);
btn.disabled = false;
if (!extraction) return;
const { result, attachments } = extraction;
const titleInput = list.querySelector(`[data-mail-ai-task-title="${CSS.escape(id)}"]`);
const notesInput = list.querySelector(`[data-mail-ai-task-notes="${CSS.escape(id)}"]`);
const dueInput = list.querySelector(`[data-mail-ai-task-due="${CSS.escape(id)}"]`);
const addBtn = list.querySelector(`[data-mail-ai-task-add="${CSS.escape(id)}"]`);
if (titleInput && result.title) titleInput.value = result.title;
if (notesInput && result.notes) notesInput.value = result.notes;
if (dueInput) dueInput.value = result.due || '';
// Stashed on the Add button, same place dateEvent's own extraction
// result keeps its date -- only the commit handler below reads it.
// Attachment metadata only (no bytes fetched yet) -- grabEmailAttachments
// does the real fetch+upload, but only once you actually commit.
if (addBtn) {
addBtn.dataset.mailLink = result.link || '';
addBtn.dataset.mailAttachments = JSON.stringify(attachments || []);
}
say('Filled in — review, then Add task.');
});
});

list.querySelectorAll('[data-mail-ai-task-add]').forEach((btn) => {
btn.addEventListener('click', async (e) => {
e.preventDefault();
const id = btn.dataset.mailAiTaskAdd;
const title = (list.querySelector(`[data-mail-ai-task-title="${CSS.escape(id)}"]`)?.value || '').trim();
const notes = list.querySelector(`[data-mail-ai-task-notes="${CSS.escape(id)}"]`)?.value || '';
const due = list.querySelector(`[data-mail-ai-task-due="${CSS.escape(id)}"]`)?.value || '';
const status = list.querySelector(`[data-mail-ai-task-status="${CSS.escape(id)}"]`);
const say = (msg) => { if (status) status.textContent = msg; };
if (!title) { say('Give the task a title first.'); return; }
const task = captureTask({ title, notes, due, link: btn.dataset.mailLink || '', source: { kind: 'mail', label: title, url: btn.dataset.mailUrl } });
bindTaskChips();
if (status) status.innerHTML = `Added ${taskChipHtml(task)}.`;
btn.disabled = true;
// Ticket/QR image or PDF, if the email had one -- a best-effort add-on,
// so it runs after (never blocking) the task itself already existing.
let candidates = [];
try { candidates = JSON.parse(btn.dataset.mailAttachments || '[]'); } catch (err) { /* stashed value always valid JSON */ }
const grabbed = await grabEmailAttachments(id, candidates);
if (grabbed.length) {
task.attachments.push(...grabbed);
queueSave();
if (status) status.innerHTML = `Added ${taskChipHtml(task)} (+ ${grabbed.length} attachment${grabbed.length === 1 ? '' : 's'}).`;
(await import('./tasks.js')).renderTasks();
}
});
});

list.querySelectorAll('[data-mail-improve-task-fill]').forEach((btn) => {
btn.addEventListener('click', async (e) => {
e.preventDefault();
const id = btn.dataset.mailImproveTaskFill;
const status = list.querySelector(`[data-mail-improve-task-status="${CSS.escape(id)}"]`);
const say = (msg) => { if (status) status.textContent = msg; };
btn.disabled = true;
const extraction = await runAiExtraction('extractTaskFromEmail', id, btn.dataset.mailSubject, btn.dataset.mailFrom, status);
btn.disabled = false;
if (!extraction) return;
const { result } = extraction;
const titleInput = list.querySelector(`[data-mail-improve-task-title="${CSS.escape(id)}"]`);
const notesInput = list.querySelector(`[data-mail-improve-task-notes="${CSS.escape(id)}"]`);
const dueInput = list.querySelector(`[data-mail-improve-task-due="${CSS.escape(id)}"]`);
const applyBtn = list.querySelector(`[data-mail-improve-task-apply="${CSS.escape(id)}"]`);
if (titleInput && result.title) titleInput.value = result.title;
if (notesInput && result.notes) notesInput.value = result.notes;
if (dueInput && result.due) dueInput.value = result.due;
if (applyBtn && result.link) applyBtn.dataset.mailLink = result.link;
say('Filled in — review, then Apply.');
});
});

list.querySelectorAll('[data-mail-improve-task-apply]').forEach((btn) => {
btn.addEventListener('click', async (e) => {
e.preventDefault();
const id = btn.dataset.mailImproveTaskApply;
const taskId = btn.dataset.mailImproveTaskId;
const status = list.querySelector(`[data-mail-improve-task-status="${CSS.escape(id)}"]`);
const say = (msg) => { if (status) status.textContent = msg; };
const task = data.tasks.find((t) => t.id === taskId);
if (!task) { say('That task no longer exists.'); return; }
const title = (list.querySelector(`[data-mail-improve-task-title="${CSS.escape(id)}"]`)?.value || '').trim();
if (!title) { say('Give the task a title first.'); return; }
task.title = title;
task.notes = list.querySelector(`[data-mail-improve-task-notes="${CSS.escape(id)}"]`)?.value || '';
task.due = list.querySelector(`[data-mail-improve-task-due="${CSS.escape(id)}"]`)?.value || '';
// Never clobbers a reference link the task already has with a blank --
// only ever fills one in if AI actually found one.
if (btn.dataset.mailLink) task.link = btn.dataset.mailLink;
queueSave();
bindTaskChips();
if (status) status.innerHTML = `Updated ${taskChipHtml(task)}.`;
btn.disabled = true;
(await import('./tasks.js')).renderTasks();
});
});

list.querySelectorAll('[data-mail-trip-extract]').forEach((btn) => {
btn.addEventListener('click', async (e) => {
e.preventDefault();
const id = btn.dataset.mailTripExtract;
const picker = list.querySelector(`[data-mail-action-picker="tripLeg:${CSS.escape(id)}"]`);
const status = list.querySelector(`[data-mail-trip-status="${CSS.escape(id)}"]`);
if (!picker) return;
const say = (msg) => { if (status) status.textContent = msg; };
btn.disabled = true;
say('Reading the email…');
try {
const [{ extractTripLegFromEmail }, detail] = await Promise.all([import('../ai.js'), getMessageDetail(id)]);
say('Pulling out the details…');
const extraction = await extractTripLegFromEmail(btn.dataset.mailSubject, btn.dataset.mailFrom, detail.bodyText);
if (!extraction.kind && Object.keys(extraction.fields).length === 0) {
say("Didn't recognise this as travel logistics.");
return;
}
const picked = readLegTargetPicker(picker, id);
const { trip, leg, filled } = await applyLegExtraction({
...picked,
extraction,
source: { kind: 'mail', label: btn.dataset.mailSubject, url: btn.dataset.mailUrl },
});
// A boarding pass/e-ticket QR or PDF, if the email had one -- best
// effort, never blocks the leg itself already existing.
const grabbed = await grabEmailAttachments(id, detail.attachments);
if (grabbed.length) { leg.attachments.push(...grabbed); queueSave(); }
// "Added 6 fields" on its own means nothing -- 6 out of how many, and
// were any of the missing ones actually required? gapsFor (travel.js,
// the SAME check the trip's own gap-review UI uses) answers that
// directly instead of leaving the reader to guess. Always link the
// trip itself (tripChipHtml/bindTripChips, travel.js) rather than
// naming it in plain text -- dashboard/CLAUDE.md's own record-
// reference standard, which extends to messages like this one, not
// just card/list/diagram surfaces.
if (status) {
const gaps = gapsFor(leg);
const completeness = gaps.length === 0 ? 'nothing required is missing' : `${gaps.length} required field${gaps.length === 1 ? '' : 's'} still missing`;
const attachNote = grabbed.length ? ` (+ ${grabbed.length} attachment${grabbed.length === 1 ? '' : 's'})` : '';
status.innerHTML = `Added ${filled} detail${filled === 1 ? '' : 's'} to ${tripChipHtml(trip)} — ${leg.kind} (${completeness})${attachNote}.`;
}
} catch (err) {
console.error('Trip email extraction failed:', err);
if (err?.name === 'MissingKeyError') { if (status) status.innerHTML = `Add an Anthropic API key in ${MISSING_KEY_LINK_HTML} to read trip details from email.`; }
else say(`Couldn't read that: ${err.message || err}`);
} finally {
btn.disabled = false;
}
});
});
}

// The last fetched result, kept purely so a dismiss (a local view change,
// nothing new from Gmail) can re-render without a full refetch.
let lastSections = [];

// Which consolidated groups (consolidatedRowHtml, keyed by the group's
// `latest.id`) are expanded -- every dismiss/action re-renders the whole
// list (see lastSections above), so without this a group's "Show all"
// silently re-collapsed on every single click inside it, confirmed
// especially painful when dismissing several duplicates in a row one at a
// time. Same persisted-across-render Set pattern as tasks.js's
// expandedTasks / travel.js's expandedLegs.
const expandedGroups = new Set();

function initMail() {
bindConnPickers(); // Mail can render (and its "+ date event" picker with it) before Dating/Planner ever do
bindTripChips(); // for the trip-leg success message's chip link, see the data-mail-trip-extract handler
bindTaskChips(); // for the +task/AI-task/Improve-task success messages' chip links
const btn = document.getElementById('sync-mail-btn');
const status = document.getElementById('mail-sync-status');
btn.addEventListener('click', async () => {
if (!(await canAttemptGoogleAction())) {
status.textContent = 'Sign in to Google at the top of Overview first.';
return;
}
btn.disabled = true;
status.textContent = 'Loading…';
try {
lastSections = await fetchMailSearches(data.mailSearches, data.prefs.mailResultCount);
const markerNote = await processMailMarkers(lastSections);
const ruleNote = await processMailRules(lastSections, messageStatus);
renderMail(lastSections);
const note = [markerNote, ruleNote].filter(Boolean).join(', ');
status.textContent = `Updated ${new Date().toLocaleTimeString()}.${note ? ` (${note})` : ''}`;
} catch (err) {
status.textContent = `Couldn't load mail: ${err.message || err}`;
console.error('Mail refresh failed:', err);
} finally {
btn.disabled = false;
}
});
}

export { initMail, extractDateEventFromIcs, icsDateEventIsGoodEnough, grabEmailAttachments };
