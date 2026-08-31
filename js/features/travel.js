// Trips: logistics (flights, car hire, accommodation, transfers) enriched
// from emails or screenshots, people involved, and an offline itinerary
// export. Deliberately built ON TOP of the existing GTD system rather than
// as a separate concept -- a trip IS a `bucket:'project'` task (captureTask,
// tasks.js) plus this module's own richer detail, the same split
// notionplan.js already uses for a project task ↔ its Notion page. The
// detail has to live here rather than in Notion because the itinerary
// export has to work fully offline.
import { data, queueSave, blankTrip, blankTripLeg, LEG_KINDS, LEG_FIELD_DEFS, LEG_SOFT_FIELDS, LEG_FIELD_LABELS, LEG_STATUSES, LEG_STATUS_LABELS } from '../state.js';
import { escapeHtml, uid, dateStrAdd, hydratePhotoBackgrounds } from '../utils.js';
import { deleteAttachment, formatBytes, openAttachment } from '../files.js';

function tripById(id) { return data.trips.find((t) => t.id === id); }
function legById(tripId, legId) {
const trip = tripById(tripId);
return trip ? trip.legs.find((l) => l.id === legId) : null;
}

// Every field LEG_FIELD_DEFS says this kind needs, still blank, and not
// explicitly waved off as not applicable -- the literal "prompt to fill in
// or confirm n/a" from the request, checkable per leg rather than an inert
// "some things might be missing".
function gapsFor(leg) {
const defs = LEG_FIELD_DEFS[leg.kind] || [];
return defs.filter((f) => !LEG_SOFT_FIELDS.has(f) && !String(leg.fields[f] || '').trim() && leg.gapStatus[f] !== 'confirmed-na');
}
// A trip with zero legs isn't "complete", it's just empty -- there's
// nothing yet for a gap to have been resolved against.
function tripIsComplete(trip) {
return trip.legs.length > 0 && trip.legs.every((l) => gapsFor(l).length === 0);
}
function tripGapCount(trip) {
return trip.legs.reduce((n, l) => n + gapsFor(l).length, 0);
}

// The task exists so a trip's open logistics show up in the normal Tasks
// workflow (and so notionplan.js's existing "draft a plan" button is free
// on it) -- captureTask already handles the render/save side of creating one.
async function createTrip({ title, destinations = [], people = [] }) {
const { captureTask } = await import('./tasks.js');
const trip = blankTrip({ title, destinations, people });
const task = captureTask({ title: `Trip: ${title}`, bucket: 'project', source: { kind: 'trip', label: title, url: '' } });
trip.taskId = task.id;
data.trips.push(trip);
queueSave();
renderTravel();
return trip;
}

function addLeg(tripId, kind, source = null) {
const trip = tripById(tripId);
if (!trip) return null;
const leg = blankTripLeg({ kind: LEG_KINDS.includes(kind) ? kind : 'other', source });
trip.legs.push(leg);
queueSave();
return leg;
}

// A real value always wins over a stale "doesn't apply" from earlier --
// e.g. an email confirms the seat number after you'd already shrugged past
// it as N/A.
function updateLegField(tripId, legId, field, value) {
const leg = legById(tripId, legId);
if (!leg) return;
const v = String(value || '').trim();
if (v) { leg.fields[field] = v; delete leg.gapStatus[field]; }
else delete leg.fields[field];
queueSave();
}
function confirmGapNA(tripId, legId, field) {
const leg = legById(tripId, legId);
if (!leg) return;
leg.gapStatus[field] = 'confirmed-na';
queueSave();
}
function reopenGap(tripId, legId, field) {
const leg = legById(tripId, legId);
if (!leg) return;
delete leg.gapStatus[field];
queueSave();
}
function setLegStatus(tripId, legId, status) {
const leg = legById(tripId, legId);
if (!leg || !LEG_STATUSES.includes(status)) return;
leg.bookingStatus = status;
queueSave();
}
function updateLegNotes(tripId, legId, value) {
const leg = legById(tripId, legId);
if (!leg) return;
leg.notes = String(value || '');
queueSave();
}

// A leg-level "seat" can't represent more than one traveller -- this is the
// real per-passenger detail (seat, baggage) a multi-person booking actually
// needs, one row per person on that specific leg.
function addPassenger(tripId, legId, { name, seat = '', baggage = '' }) {
const leg = legById(tripId, legId);
const n = String(name || '').trim();
if (!leg || !n) return;
leg.passengers.push({ id: uid(), name: n, seat: String(seat || '').trim(), baggage: String(baggage || '').trim() });
queueSave();
}
function removePassenger(tripId, legId, passengerId) {
const leg = legById(tripId, legId);
if (!leg) return;
leg.passengers = leg.passengers.filter((p) => p.id !== passengerId);
queueSave();
}
function updatePassengerField(tripId, legId, passengerId, field, value) {
const leg = legById(tripId, legId);
const p = leg?.passengers.find((x) => x.id === passengerId);
if (!p || !['name', 'seat', 'baggage'].includes(field)) return;
p[field] = String(value || '').trim();
queueSave();
}

async function deleteLeg(tripId, legId) {
const trip = tripById(tripId);
const leg = trip && trip.legs.find((l) => l.id === legId);
if (!trip || !leg) return;
for (const att of leg.attachments) {
try { await deleteAttachment(att.id); } catch (err) { console.error('Could not delete a trip leg attachment:', err); }
}
trip.legs = trip.legs.filter((l) => l.id !== legId);
queueSave();
}

// The project task exists solely to represent this trip in the Tasks
// workflow, so it (and any subtasks under it) goes with the trip -- same
// "the record and its skeleton task are one unit" reasoning as everywhere
// else a source-linked task tracks something that can itself be deleted.
async function deleteTrip(tripId) {
const trip = tripById(tripId);
if (!trip) return;
for (const leg of trip.legs) {
for (const att of leg.attachments) {
try { await deleteAttachment(att.id); } catch (err) { console.error('Could not delete a trip leg attachment:', err); }
}
}
if (trip.taskId) data.tasks = data.tasks.filter((t) => t.id !== trip.taskId && t.parentId !== trip.taskId);
data.trips = data.trips.filter((t) => t.id !== tripId);
queueSave();
}

function addPerson(tripId, { name, relation = 'other', connectionId = null }) {
const trip = tripById(tripId);
const n = String(name || '').trim();
if (!trip || !n) return;
trip.people.push({ id: uid(), name: n, relation, connectionId: connectionId || null });
queueSave();
}
function removePerson(tripId, personId) {
const trip = tripById(tripId);
if (!trip) return;
trip.people = trip.people.filter((p) => p.id !== personId);
queueSave();
}

// Only ever WRITES a field the extraction actually found -- same principle
// wellness.js's band interpolation follows for numbers: state what's real,
// never invent a value to fill a gap. `kind` is allowed to reclassify a
// leg still sitting at 'other' once real content reveals what it actually
// is (a boarding pass parsed onto a leg that was created blank).
function enrichLegFromExtraction(tripId, legId, extraction) {
const leg = legById(tripId, legId);
if (!leg) return { filled: 0 };
if (extraction.kind && LEG_KINDS.includes(extraction.kind) && leg.kind === 'other') leg.kind = extraction.kind;
let filled = 0;
Object.entries(extraction.fields || {}).forEach(([k, v]) => {
const val = String(v || '').trim();
if (!val || !(LEG_FIELD_DEFS[leg.kind] || []).includes(k)) return;
leg.fields[k] = val;
delete leg.gapStatus[k];
filled++;
});
// Matched by name (case-insensitive) so re-reading the same confirmation,
// or a follow-up email that only updates a seat, refines the same
// passenger rather than duplicating them.
(extraction.passengers || []).forEach((p) => {
const name = String(p.name || '').trim();
if (!name) return;
const existing = leg.passengers.find((x) => x.name.trim().toLowerCase() === name.toLowerCase());
if (existing) {
if (p.seat) existing.seat = p.seat;
if (p.baggage) existing.baggage = p.baggage;
} else {
leg.passengers.push({ id: uid(), name, seat: p.seat || '', baggage: p.baggage || '' });
}
filled++;
});
if (!leg.label && extraction.label) leg.label = String(extraction.label).trim();
// A confirmation document was just successfully read, so the booking is
// no longer merely planned -- never downgrades a status the user already
// set by hand (there's no path from 'confirmed' back to anything lower
// here in the first place, since this only ever moves forward).
if (filled > 0 && leg.bookingStatus !== 'confirmed') leg.bookingStatus = 'confirmed';
queueSave();
return { filled };
}

function tripOptionsHtml() {
return [...data.trips]
.sort((a, b) => a.title.localeCompare(b.title))
.map((t) => `<option value="${t.id}">${escapeHtml(t.title)}${t.destinations.length ? ' — ' + escapeHtml(t.destinations.join(', ')) : ''}</option>`)
.join('');
}

// The one place both enrichment paths (mail.js's "+ trip leg", Capture
// Inbox's "Extract into a trip leg") land once a target's picked --
// creates the trip first if the picker's "+ New trip" option was chosen,
// then a leg, then merges. Kept here rather than duplicated in each caller.
async function applyLegExtraction({ tripId, newTripTitle, kind, extraction, source }) {
let trip = tripId === '__new__' ? null : tripById(tripId);
if (tripId === '__new__') {
const title = (newTripTitle || '').trim() || extraction.suggestedTripTitle || 'New trip';
trip = await createTrip({ title });
}
if (!trip) throw new Error('Pick a trip first.');
const resolvedKind = (extraction.kind && LEG_KINDS.includes(extraction.kind)) ? extraction.kind : (kind || 'other');
const leg = addLeg(trip.id, resolvedKind, source);
const { filled } = enrichLegFromExtraction(trip.id, leg.id, extraction);
renderTravel();
return { trip, leg, filled };
}

// Reused by both mail.js and captureinbox.js so the "pick a target trip"
// UI exists in exactly one place. Framed as two explicit buttons rather
// than a single dropdown with a "+ New trip" option buried in it, per the
// user's own suggestion -- and with exactly one trip open, "Existing trip"
// auto-routes straight to it with nothing left to pick (see setMode below),
// so the common case (one trip in flight) is a single click, not a lookup.
function legTargetPickerHtml(prefix) {
const hasTrips = data.trips.length > 0;
return `<div class="leg-target-picker" data-leg-target-picker="${prefix}">
<div class="leg-target-mode-row">
<button type="button" class="leg-target-mode-btn" data-leg-target-mode-btn="${prefix}" data-mode="existing"${hasTrips ? '' : ' disabled title="No trips yet"'}>Existing trip</button>
<button type="button" class="leg-target-mode-btn" data-leg-target-mode-btn="${prefix}" data-mode="new">New trip</button>
</div>
<select data-leg-target-trip="${prefix}">${tripOptionsHtml()}</select>
<span class="settings-note" data-leg-target-single="${prefix}" hidden></span>
<input type="text" class="tag-add-input" data-leg-target-title="${prefix}" placeholder="Trip name" hidden>
<select data-leg-target-kind="${prefix}">
${LEG_KINDS.map((k) => `<option value="${k}">${escapeHtml(LEG_KIND_LABELS[k])}</option>`).join('')}
</select>
</div>`;
}
function bindLegTargetPicker(root, prefix) {
const container = root.querySelector(`[data-leg-target-picker="${prefix}"]`);
const modeBtns = root.querySelectorAll(`[data-leg-target-mode-btn="${prefix}"]`);
const tripSel = root.querySelector(`[data-leg-target-trip="${prefix}"]`);
const singleNote = root.querySelector(`[data-leg-target-single="${prefix}"]`);
const titleInput = root.querySelector(`[data-leg-target-title="${prefix}"]`);
if (!container || !tripSel || !titleInput) return;

function setMode(mode) {
container.dataset.mode = mode;
modeBtns.forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
if (mode === 'new') {
tripSel.hidden = true;
singleNote.hidden = true;
titleInput.hidden = false;
} else if (data.trips.length === 1) {
// Only one trip open -- nothing to choose, so skip the dropdown
// entirely and just say where this is going.
tripSel.hidden = true;
tripSel.value = data.trips[0].id;
singleNote.hidden = false;
singleNote.textContent = `→ ${data.trips[0].title}`;
titleInput.hidden = true;
} else {
tripSel.hidden = false;
singleNote.hidden = true;
titleInput.hidden = true;
}
}

modeBtns.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
setMode(data.trips.length > 0 ? 'existing' : 'new');
}
function readLegTargetPicker(root, prefix) {
const container = root.querySelector(`[data-leg-target-picker="${prefix}"]`);
const mode = container?.dataset.mode || (data.trips.length > 0 ? 'existing' : 'new');
const tripSel = root.querySelector(`[data-leg-target-trip="${prefix}"]`);
return {
tripId: mode === 'new' ? '__new__' : (tripSel?.value || '__new__'),
newTripTitle: root.querySelector(`[data-leg-target-title="${prefix}"]`)?.value || '',
kind: root.querySelector(`[data-leg-target-kind="${prefix}"]`)?.value || 'other',
};
}

const LEG_KIND_LABELS = { flight: 'Flight', car_hire: 'Car hire', accommodation: 'Accommodation', transfer: 'Transfer', other: 'Other' };
const RELATION_LABELS = { self: 'Me', partner: 'Date / partner', child: 'Child', other: 'Other' };

function personChipHtml(tripId, p) {
return `<span class="tag-chip">${escapeHtml(p.name)}${p.relation !== 'other' ? ` (${escapeHtml(RELATION_LABELS[p.relation] || p.relation)})` : ''}<span class="tag-x" data-trip-remove-person="${tripId}" data-person-id="${p.id}">&times;</span></span>`;
}

// The "+ person" picker's own extra row -- deliberately NOT
// connectionPickerNewRowHtml() from connections.js, which creates a real
// dating connection. A trip companion who isn't already a connection
// (family, a friend, a colleague) shouldn't become one just for being
// added here; picking this row reveals a plain name field instead (see
// the picker mount's 'change' handler in bindTravel).
function personPickerFreetextRowHtml() {
return `<button type="button" class="conn-picker-row" data-conn-picker-value="__freetext__" data-conn-picker-search="someone else">
<span class="avatar sm conn-picker-plus">+</span>
<span class="conn-picker-row-info"><strong>Someone else&hellip;</strong></span>
</button>`;
}

function legFieldRowHtml(trip, leg, field) {
const value = leg.fields[field] || '';
const label = LEG_FIELD_LABELS[field] || field;
const isNA = leg.gapStatus[field] === 'confirmed-na';
const soft = LEG_SOFT_FIELDS.has(field);
if (isNA) {
return `<div class="field-block"><span class="field-label">${escapeHtml(label)}</span>
<span class="settings-note" style="display:flex;align-items:center;gap:6px;">N/A <span class="tag-x" data-leg-reopen-gap="${leg.id}" data-trip-id="${trip.id}" data-field="${field}" title="This does have a value after all">&times;</span></span></div>`;
}
const isOpenGap = !soft && !String(value).trim();
return `<div class="field-block"><span class="field-label">${escapeHtml(label)}${isOpenGap ? ' ⚠' : ''}</span>
<div style="display:flex;gap:4px;">
<input type="text" data-leg-field="${field}" data-leg-id="${leg.id}" data-trip-id="${trip.id}" value="${escapeHtml(value)}" placeholder="${isOpenGap ? 'Still needed' : soft ? 'If known' : ''}">
${isOpenGap ? `<button class="todo-add-btn" type="button" data-leg-confirm-na="${leg.id}" data-trip-id="${trip.id}" data-field="${field}" title="Doesn't apply to this leg">N/A</button>` : ''}
</div></div>`;
}

function passengerRowHtml(tripId, leg, p) {
return `<div class="attach-row" data-passenger-row="${p.id}">
<input type="text" data-passenger-field="name" data-passenger-id="${p.id}" data-leg-id="${leg.id}" data-trip-id="${tripId}" value="${escapeHtml(p.name)}" placeholder="Name" style="flex:1;min-width:100px;">
<input type="text" data-passenger-field="seat" data-passenger-id="${p.id}" data-leg-id="${leg.id}" data-trip-id="${tripId}" value="${escapeHtml(p.seat)}" placeholder="Seat" style="width:56px;">
<input type="text" data-passenger-field="baggage" data-passenger-id="${p.id}" data-leg-id="${leg.id}" data-trip-id="${tripId}" value="${escapeHtml(p.baggage)}" placeholder="Baggage" style="flex:2;min-width:140px;">
<span class="tag-x" data-passenger-remove="${p.id}" data-leg-id="${leg.id}" data-trip-id="${tripId}" title="Remove this passenger">&times;</span>
</div>`;
}

function legCardHtml(trip, leg) {
const defs = LEG_FIELD_DEFS[leg.kind] || [];
const gaps = gapsFor(leg);
const sourceLabel = leg.source?.kind === 'mail' ? `Parsed from an email${leg.source.label ? `: ${leg.source.label}` : ''}`
: leg.source?.kind === 'screenshot' ? 'Parsed from a screenshot' : 'Entered manually';
const sourceHtml = leg.source?.url
? `<a href="${escapeHtml(leg.source.url)}" target="_blank" rel="noopener">${escapeHtml(sourceLabel)}</a>`
: escapeHtml(sourceLabel);
return `<div class="alloc-card" data-leg-card="${leg.id}" style="margin-top:8px;">
<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
<select data-leg-kind="${leg.id}" data-trip-id="${trip.id}">
${LEG_KINDS.map((k) => `<option value="${k}"${k === leg.kind ? ' selected' : ''}>${escapeHtml(LEG_KIND_LABELS[k])}</option>`).join('')}
</select>
<input type="text" data-leg-label="${leg.id}" data-trip-id="${trip.id}" value="${escapeHtml(leg.label)}" placeholder="${escapeHtml(LEG_KIND_LABELS[leg.kind])}" style="flex:1;min-width:120px;">
<select data-leg-status="${leg.id}" data-trip-id="${trip.id}">
${LEG_STATUSES.map((s) => `<option value="${s}"${s === leg.bookingStatus ? ' selected' : ''}>${escapeHtml(LEG_STATUS_LABELS[s])}</option>`).join('')}
</select>
<span class="del-x" data-leg-delete="${leg.id}" data-trip-id="${trip.id}" title="Delete this leg">&times;</span>
</div>
<div class="details-grid" style="background:var(--slate-bg);">
${defs.map((f) => legFieldRowHtml(trip, leg, f)).join('')}
</div>
<div style="margin-top:8px;">
<span class="field-label">Passengers</span>
<div style="display:flex;flex-direction:column;gap:4px;margin-top:4px;">
${leg.passengers.map((p) => passengerRowHtml(trip.id, leg, p)).join('')}
</div>
<div class="attach-row">
<input type="text" class="tag-add-input" data-passenger-add-name="${leg.id}" data-trip-id="${trip.id}" placeholder="+ passenger name">
<input type="text" class="tag-add-input" data-passenger-add-seat="${leg.id}" placeholder="Seat" style="width:56px;">
<input type="text" class="tag-add-input" data-passenger-add-baggage="${leg.id}" placeholder="Baggage">
<button class="todo-add-btn" type="button" data-passenger-add="${leg.id}" data-trip-id="${trip.id}">Add</button>
</div>
</div>
${leg.attachments.length ? `<div style="margin-top:6px;">${leg.attachments.map((a) => `<div class="attach-row"><button class="attach-name" type="button" data-leg-attach-open="${leg.id}" data-trip-id="${trip.id}" data-attach-id="${escapeHtml(a.id)}">${escapeHtml(a.name || 'file')}</button><span class="attach-size">${escapeHtml(formatBytes(a.size))}</span></div>`).join('')}</div>` : ''}
<textarea data-leg-notes="${leg.id}" data-trip-id="${trip.id}" placeholder="Notes" style="width:100%;margin-top:8px;min-height:44px;">${escapeHtml(leg.notes)}</textarea>
<div class="settings-note" style="margin-top:4px;">${sourceHtml}${gaps.length ? ` · ${gaps.length} still needed` : ' · complete'}</div>
</div>`;
}

// Same shape as connections.js's tagChips() (City field) minus the
// flag-rule color lookup, which is a connections-only concept -- a trip's
// destinations are plain text, no per-value coloring.
function destinationChipsHtml(trip) {
return trip.destinations.map((d, i) => `<span class="tag-chip">${escapeHtml(d)}<span class="tag-x" data-trip-dest-remove="${trip.id}" data-trip-dest-idx="${i}">&times;</span></span>`).join('')
+ `<input type="text" autocomplete="off" class="tag-add-input" placeholder="+ destination" data-trip-dest-add="${trip.id}">`
+ `<button type="button" class="todo-add-btn" data-trip-dest-add-btn="${trip.id}" style="padding:3px 8px;">+</button>`;
}

function tripCardHtml(trip) {
const gapCount = tripGapCount(trip);
const complete = tripIsComplete(trip);
return `<div class="alloc-card" data-trip-card="${trip.id}">
<div class="alloc-title" style="display:flex;align-items:center;gap:8px;">
<input type="text" data-trip-title="${trip.id}" value="${escapeHtml(trip.title)}" placeholder="Trip title" style="flex:1;font-weight:700;">
<span class="del-x" data-trip-delete="${trip.id}" title="Delete this trip">&times;</span>
</div>
<div class="tag-editor" style="margin-top:4px;">${destinationChipsHtml(trip)}</div>
<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;">
<input type="date" data-trip-start="${trip.id}" value="${escapeHtml(trip.startDate)}">
<input type="date" data-trip-end="${trip.id}" value="${escapeHtml(trip.endDate)}" min="${escapeHtml(trip.startDate)}">
</div>
<div style="display:flex;flex-wrap:wrap;gap:5px;align-items:center;margin-top:8px;">
${trip.people.map((p) => personChipHtml(trip.id, p)).join('')}
<span data-trip-person-picker-mount="${trip.id}"></span>
<input type="text" class="tag-add-input" data-trip-person-freetext="${trip.id}" placeholder="Name" hidden>
<select data-trip-person-relation="${trip.id}">${Object.entries(RELATION_LABELS).map(([k, v]) => `<option value="${k}">${escapeHtml(v)}</option>`).join('')}</select>
<button class="todo-add-btn" type="button" data-trip-add-person="${trip.id}">Add</button>
</div>
<div class="settings-note" style="margin-top:6px;">${trip.legs.length === 0 ? 'No legs yet.' : complete ? 'Itinerary complete.' : `${gapCount} thing${gapCount === 1 ? '' : 's'} still need confirming.`}</div>
${trip.legs.map((l) => legCardHtml(trip, l)).join('')}
<div class="alloc-controls" style="margin-top:8px;">
<select data-trip-add-leg-kind="${trip.id}">${LEG_KINDS.map((k) => `<option value="${k}">${escapeHtml(LEG_KIND_LABELS[k])}</option>`).join('')}</select>
<button class="todo-add-btn" type="button" data-trip-add-leg="${trip.id}">+ Add leg</button>
<button class="todo-add-btn" type="button" data-trip-download="${trip.id}">Download itinerary</button>
</div>
<span class="sync-status" data-trip-status="${trip.id}"></span>
</div>`;
}

function renderTravel() {
const el = document.getElementById('travel-list');
if (!el) return;
const countEl = document.getElementById('travel-count');
if (countEl) countEl.textContent = data.trips.length ? `${data.trips.length} trip${data.trips.length === 1 ? '' : 's'}` : '';
const sorted = [...data.trips].sort((a, b) => (a.startDate || '9999').localeCompare(b.startDate || '9999') || a.createdAt.localeCompare(b.createdAt));
el.innerHTML = sorted.length ? sorted.map(tripCardHtml).join('') : '<div class="empty">No trips yet. Add one below, or turn a "city-break" nudge or a booking email into one.</div>';
bindTravel(el);
// The "+ person" picker's row list needs the live Dating module, kept as
// a dynamic import so this module never has to load connections.js (and
// everything it pulls in) up front for a tab most sessions won't touch --
// same reasoning and same mount-then-fill shape captureinbox.js's own
// connection picker already uses.
if (el.querySelector('[data-trip-person-picker-mount]')) {
import('./connections.js').then(({ connectionPickerHtml, bindConnPickers }) => {
bindConnPickers();
el.querySelectorAll('[data-trip-person-picker-mount]').forEach((mount) => {
const tripId = mount.dataset.tripPersonPickerMount;
mount.innerHTML = connectionPickerHtml(`trip-person-picker-${tripId}`, 'Pick a connection&hellip;', personPickerFreetextRowHtml());
});
hydratePhotoBackgrounds(el);
});
}
}

function bindTravel(root) {
root.querySelectorAll('[data-trip-title]').forEach((input) => {
input.addEventListener('change', () => { const t = tripById(input.dataset.tripTitle); if (t) { t.title = input.value.trim(); queueSave(); renderTravel(); } });
});
root.querySelectorAll('[data-trip-dest-remove]').forEach((el) => {
el.addEventListener('click', () => {
const t = tripById(el.dataset.tripDestRemove);
if (!t) return;
t.destinations.splice(parseInt(el.dataset.tripDestIdx, 10), 1);
queueSave();
renderTravel();
});
});
const commitDestAdd = (tripId, inputEl) => {
const t = tripById(tripId);
const raw = inputEl.value.trim().replace(/,$/, '').trim();
if (!t || !raw) return;
if (!t.destinations.some((d) => d.toLowerCase() === raw.toLowerCase())) t.destinations.push(raw);
queueSave();
renderTravel();
};
root.querySelectorAll('[data-trip-dest-add]').forEach((input) => {
input.addEventListener('keydown', (e) => {
if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commitDestAdd(input.dataset.tripDestAdd, input); }
});
});
root.querySelectorAll('[data-trip-dest-add-btn]').forEach((btn) => {
btn.addEventListener('click', () => {
const input = root.querySelector(`[data-trip-dest-add="${btn.dataset.tripDestAddBtn}"]`);
if (input) commitDestAdd(btn.dataset.tripDestAddBtn, input);
});
});
root.querySelectorAll('[data-trip-start]').forEach((input) => {
input.addEventListener('change', () => {
const t = tripById(input.dataset.tripStart);
if (!t) return;
t.startDate = input.value;
const endInput = input.closest('[data-trip-card]')?.querySelector('[data-trip-end]');
if (endInput) {
endInput.min = input.value; // stops picking an end date before the trip starts, whether or not it's blank
// Only when the end date hasn't been set yet -- a start-date correction
// on an already-dated trip shouldn't clobber an end date the user
// already chose. showPicker() (where supported) opens the end-date
// calendar straight to the value just filled in, so "opens from that
// date" and "defaults to start+2" are the same one fix.
if (input.value && !endInput.value) {
endInput.value = dateStrAdd(input.value, 2);
t.endDate = endInput.value;
try { endInput.showPicker?.(); } catch (e) { /* unsupported browser -- the filled-in default still stands */ }
}
}
queueSave();
});
});
root.querySelectorAll('[data-trip-end]').forEach((input) => {
input.addEventListener('change', () => { const t = tripById(input.dataset.tripEnd); if (t) { t.endDate = input.value; queueSave(); } });
});
root.querySelectorAll('[data-trip-delete]').forEach((btn) => {
btn.addEventListener('click', async () => {
const t = tripById(btn.dataset.tripDelete);
if (!t) return;
if (!confirm(`Delete "${t.title || 'this trip'}"? This also removes its linked task.`)) return;
await deleteTrip(t.id);
renderTravel();
});
});
// Bound to the stable mount span, not the hidden input inside it -- the
// picker's markup lands asynchronously (see renderTravel's dynamic import
// above), so the input doesn't exist yet at bind time here. 'change'
// bubbles up from it once it does, same pattern captureinbox.js's own
// connection picker already uses.
root.querySelectorAll('[data-trip-person-picker-mount]').forEach((mount) => {
const tripId = mount.dataset.tripPersonPickerMount;
mount.addEventListener('change', () => {
const picker = document.getElementById(`trip-person-picker-${tripId}`);
const freeInput = root.querySelector(`[data-trip-person-freetext="${tripId}"]`);
if (freeInput) freeInput.hidden = !picker || picker.value !== '__freetext__';
});
});
root.querySelectorAll('[data-trip-add-person]').forEach((btn) => {
btn.addEventListener('click', () => {
const tripId = btn.dataset.tripAddPerson;
const relSel = root.querySelector(`[data-trip-person-relation="${tripId}"]`);
const picker = document.getElementById(`trip-person-picker-${tripId}`);
const freeInput = root.querySelector(`[data-trip-person-freetext="${tripId}"]`);
const pickerValue = picker ? picker.value : '';
if (pickerValue === '__freetext__') {
if (!freeInput || !freeInput.value.trim()) return;
addPerson(tripId, { name: freeInput.value, relation: relSel?.value || 'other' });
} else if (pickerValue) {
const conn = data.connections.find((c) => c.id === pickerValue);
if (!conn) return;
addPerson(tripId, { name: conn.name, relation: relSel?.value || 'other', connectionId: conn.id });
} else {
return;
}
renderTravel();
});
});
root.querySelectorAll('[data-trip-remove-person]').forEach((x) => {
x.addEventListener('click', () => { removePerson(x.dataset.tripRemovePerson, x.dataset.personId); renderTravel(); });
});
root.querySelectorAll('[data-trip-add-leg]').forEach((btn) => {
btn.addEventListener('click', () => {
const tripId = btn.dataset.tripAddLeg;
const kindSel = root.querySelector(`[data-trip-add-leg-kind="${tripId}"]`);
addLeg(tripId, kindSel?.value || 'other');
renderTravel();
});
});
root.querySelectorAll('[data-leg-kind]').forEach((sel) => {
sel.addEventListener('change', () => {
const leg = legById(sel.dataset.tripId, sel.dataset.legKind);
if (leg) { leg.kind = sel.value; queueSave(); renderTravel(); }
});
});
root.querySelectorAll('[data-leg-label]').forEach((input) => {
input.addEventListener('change', () => {
const leg = legById(input.dataset.tripId, input.dataset.legLabel);
if (leg) { leg.label = input.value.trim(); queueSave(); }
});
});
root.querySelectorAll('[data-leg-delete]').forEach((x) => {
x.addEventListener('click', async () => { await deleteLeg(x.dataset.tripId, x.dataset.legDelete); renderTravel(); });
});
root.querySelectorAll('[data-leg-status]').forEach((sel) => {
sel.addEventListener('change', () => { setLegStatus(sel.dataset.tripId, sel.dataset.legStatus, sel.value); });
});
root.querySelectorAll('[data-leg-notes]').forEach((ta) => {
ta.addEventListener('change', () => { updateLegNotes(ta.dataset.tripId, ta.dataset.legNotes, ta.value); });
});
root.querySelectorAll('[data-passenger-field]').forEach((input) => {
input.addEventListener('change', () => {
updatePassengerField(input.dataset.tripId, input.dataset.legId, input.dataset.passengerId, input.dataset.passengerField, input.value);
renderTravel();
});
});
root.querySelectorAll('[data-passenger-remove]').forEach((x) => {
x.addEventListener('click', () => { removePassenger(x.dataset.tripId, x.dataset.legId, x.dataset.passengerRemove); renderTravel(); });
});
root.querySelectorAll('[data-passenger-add]').forEach((btn) => {
btn.addEventListener('click', () => {
const legId = btn.dataset.passengerAdd;
const tripId = btn.dataset.tripId;
const nameInput = root.querySelector(`[data-passenger-add-name="${legId}"]`);
const seatInput = root.querySelector(`[data-passenger-add-seat="${legId}"]`);
const baggageInput = root.querySelector(`[data-passenger-add-baggage="${legId}"]`);
if (!nameInput || !nameInput.value.trim()) return;
addPassenger(tripId, legId, { name: nameInput.value, seat: seatInput?.value, baggage: baggageInput?.value });
renderTravel();
});
});
root.querySelectorAll('[data-leg-field]').forEach((input) => {
input.addEventListener('change', () => { updateLegField(input.dataset.tripId, input.dataset.legId, input.dataset.legField, input.value); renderTravel(); });
});
root.querySelectorAll('[data-leg-confirm-na]').forEach((btn) => {
btn.addEventListener('click', () => { confirmGapNA(btn.dataset.tripId, btn.dataset.legConfirmNa, btn.dataset.field); renderTravel(); });
});
root.querySelectorAll('[data-leg-reopen-gap]').forEach((x) => {
x.addEventListener('click', () => { reopenGap(x.dataset.tripId, x.dataset.legReopenGap, x.dataset.field); renderTravel(); });
});
root.querySelectorAll('[data-leg-attach-open]').forEach((btn) => {
btn.addEventListener('click', () => {
const leg = legById(btn.dataset.tripId, btn.dataset.legAttachOpen);
const att = leg?.attachments.find((a) => a.id === btn.dataset.attachId);
if (att) openAttachment(att).catch((err) => console.error("Couldn't open that attachment:", err));
});
});
root.querySelectorAll('[data-trip-download]').forEach((btn) => {
btn.addEventListener('click', async () => {
const trip = tripById(btn.dataset.tripDownload);
if (!trip) return;
const status = root.querySelector(`[data-trip-status="${trip.id}"]`);
const gapCount = tripGapCount(trip);
if (gapCount > 0 && !confirm(`${gapCount} thing${gapCount === 1 ? '' : 's'} still unconfirmed — download anyway? They'll be flagged in the file.`)) return;
const html = generateItineraryHtml(trip);
const blob = new Blob([html], { type: 'text/html' });
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url;
a.download = `itinerary-${(trip.title || 'trip').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.html`;
document.body.appendChild(a);
a.click();
a.remove();
setTimeout(() => URL.revokeObjectURL(url), 60000);
if (status) status.textContent = 'Downloaded.';
});
});
}

function initTravel() {
const btn = document.getElementById('travel-new-trip-btn');
const titleInput = document.getElementById('travel-new-trip-title');
const destInput = document.getElementById('travel-new-trip-destination');
if (!btn || !titleInput) return;
btn.addEventListener('click', async () => {
const title = titleInput.value.trim();
if (!title) return;
const destValue = (destInput?.value || '').trim();
await createTrip({ title, destinations: destValue ? [destValue] : [] });
titleInput.value = '';
if (destInput) destInput.value = '';
});
}

function revealTrip(id) {
renderTravel();
setTimeout(() => {
const el = document.querySelector(`[data-trip-card="${id}"]`);
if (el) {
el.scrollIntoView({ behavior: 'smooth', block: 'center' });
el.classList.add('flash-new');
setTimeout(() => el.classList.remove('flash-new'), 1800);
}
}, 60);
}

// The literal offline itinerary: one self-contained HTML file, no external
// requests, so it opens exactly the same on a phone in airplane mode as it
// does right after downloading. Open gaps are printed in the file itself
// (not omitted) — that IS the "prompt me" from the request, in the one
// place that still matters once you're standing in an airport with no
// signal and can't see the app's own gap warnings.
function generateItineraryHtml(trip) {
const fmt = (s) => s ? escapeHtml(s) : '';
const legSortKey = (l) => l.fields.departTime || l.fields.checkIn || l.fields.pickupTime || l.fields.when || '';
const sortedLegs = [...trip.legs].sort((a, b) => legSortKey(a).localeCompare(legSortKey(b)));
const legHtml = sortedLegs.map((l) => {
const defs = LEG_FIELD_DEFS[l.kind] || [];
const rows = defs.map((f) => {
const val = l.fields[f];
const na = l.gapStatus[f] === 'confirmed-na';
if (val) return `<tr><th>${fmt(LEG_FIELD_LABELS[f] || f)}</th><td>${fmt(val)}</td></tr>`;
if (na) return `<tr><th>${fmt(LEG_FIELD_LABELS[f] || f)}</th><td class="muted">n/a</td></tr>`;
if (LEG_SOFT_FIELDS.has(f)) return '';
return `<tr><th>${fmt(LEG_FIELD_LABELS[f] || f)}</th><td class="gap">⚠ not yet confirmed</td></tr>`;
}).join('');
const passengerRows = l.passengers.map((p) => `<tr><th>${fmt(p.name)}</th><td>${[p.seat, p.baggage].filter(Boolean).map(fmt).join(' — ') || '—'}</td></tr>`).join('');
return `<section class="leg">
<h2>${fmt(l.label) || fmt(LEG_KIND_LABELS[l.kind])} <span class="status">${fmt(LEG_STATUS_LABELS[l.bookingStatus] || l.bookingStatus)}</span></h2>
<table>${rows}</table>
${passengerRows ? `<h3>Passengers</h3><table>${passengerRows}</table>` : ''}
${l.notes ? `<p class="notes">${fmt(l.notes)}</p>` : ''}
</section>`;
}).join('');
const peopleHtml = trip.people.length ? `<ul>${trip.people.map((p) => `<li>${fmt(p.name)}${p.relation !== 'other' ? ` — ${fmt(RELATION_LABELS[p.relation] || p.relation)}` : ''}</li>`).join('')}</ul>` : '<p class="muted">No one listed.</p>';
const gapCount = tripGapCount(trip);
return `<!doctype html><html><head><meta charset="utf-8"><title>${fmt(trip.title) || 'Itinerary'}</title>
<style>
body{font-family:Georgia,'Times New Roman',serif;max-width:720px;margin:2rem auto;padding:0 1.2rem;color:#1a1a1a;background:#fdfaf3;}
h1{font-size:1.8rem;margin-bottom:.2rem;}
.sub{color:#666;font-family:Arial,sans-serif;font-size:.9rem;margin-bottom:1.5rem;}
.warn{background:#fff3d6;border:1px solid #e0a800;padding:.6rem 1rem;border-radius:6px;font-family:Arial,sans-serif;font-size:.9rem;margin-bottom:1.5rem;}
h2{font-family:Arial,sans-serif;font-size:1.05rem;border-bottom:1px solid #ccc;padding-bottom:.3rem;margin-top:2rem;}
h2 .status{font-size:.7rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#7a7a7a;border:1px solid #ccc;border-radius:4px;padding:1px 6px;margin-left:.5rem;vertical-align:middle;}
h3{font-family:Arial,sans-serif;font-size:.85rem;color:#666;margin:1rem 0 .3rem;}
table{width:100%;border-collapse:collapse;font-family:Arial,sans-serif;font-size:.92rem;}
th{text-align:left;color:#666;font-weight:600;padding:.3rem .6rem .3rem 0;width:38%;vertical-align:top;}
td{padding:.3rem 0;}
td.gap{color:#a35b00;font-weight:600;}
td.muted{color:#999;}
.muted{color:#999;}
p.notes{font-family:Arial,sans-serif;font-size:.88rem;color:#444;white-space:pre-wrap;margin:.6rem 0 0;}
@media print{body{background:#fff;}}
</style></head><body>
<h1>${fmt(trip.title) || 'Trip'}${trip.destinations.length ? ` — ${fmt(trip.destinations.join(', '))}` : ''}</h1>
<div class="sub">${trip.startDate ? fmt(trip.startDate) : ''}${trip.startDate && trip.endDate ? ' to ' : ''}${trip.endDate ? fmt(trip.endDate) : ''}</div>
${gapCount > 0 ? `<div class="warn">⚠ ${gapCount} thing${gapCount === 1 ? '' : 's'} below still ${gapCount === 1 ? 'needs' : 'need'} confirming.</div>` : ''}
<h2>People</h2>
${peopleHtml}
${legHtml || '<p class="muted">No logistics added yet.</p>'}
<p class="sub" style="margin-top:2rem;">Generated ${fmt(new Date().toISOString().slice(0, 10))} — offline copy, may be out of date if anything changed since.</p>
</body></html>`;
}

export {
createTrip, addLeg, updateLegField, confirmGapNA, reopenGap, deleteLeg, deleteTrip,
setLegStatus, updateLegNotes, addPassenger, removePassenger, updatePassengerField,
addPerson, removePerson, gapsFor, tripIsComplete, tripGapCount, enrichLegFromExtraction,
applyLegExtraction, tripOptionsHtml, legTargetPickerHtml, bindLegTargetPicker, readLegTargetPicker,
generateItineraryHtml, renderTravel, initTravel, revealTrip, tripById, legById,
};
