// Manual connections CSV import -- turns offline dating history (a
// spreadsheet kept before this app existed, or anything hand-compiled the
// same shape) into real connection records. Column layout confirmed
// against a real sample ("Manual connections upload.csv"), header row
// verbatim:
//   Name,City,Language,Nationality,Connected,Tags,Sex,Stage,Milestones,
//   Notes,Date Locations,Date Events,Stars
// Almost every column already has a direct home in the existing data
// model -- see rowToConnFields()'s own comment for the exact mapping.
//
// classify -> review -> apply, same shape as tinderimport.js's own
// pipeline, just far lighter: there's no per-field conflict UI here at
// all, because an "overlap" row hands off entirely to connections.js's
// own mergeConnectionInto() (fill-gaps + array-union + notes-append,
// already used by the Compare/duplicate-merge screen) rather than
// re-inventing field-by-field reconciliation for a second import path.
import { data, queueSave, blankConnection } from '../state.js';
import { escapeHtml, splitCsvLine, hydratePhotoBackgrounds, avatarHtml } from '../utils.js';
import { CONN_STAGES, matchCandidates, mergeConnectionInto, connectionPickerHtml, bindConnPickers, renderConnections } from './connections.js';

function splitList(s) {
return String(s || '').split(',').map((v) => v.trim()).filter(Boolean);
}

// One row per non-blank line past the header -- matched by column NAME
// (case-insensitive), not position, so a re-ordered or partially-trimmed
// export still parses correctly rather than silently misaligning.
function parseManualCsv(text) {
const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
if (!lines.length) return [];
const header = splitCsvLine(lines[0]).map((h) => h.trim());
const col = (label) => header.findIndex((h) => h.toLowerCase() === label.toLowerCase());
const idx = {
name: col('Name'), city: col('City'), language: col('Language'), nationality: col('Nationality'),
connected: col('Connected'), tags: col('Tags'), sex: col('Sex'), stage: col('Stage'),
milestones: col('Milestones'), notes: col('Notes'), dateLocations: col('Date Locations'),
dateEvents: col('Date Events'), stars: col('Stars'),
};
return lines.slice(1).map((line) => {
const cells = splitCsvLine(line);
const get = (i) => (i >= 0 && i < cells.length ? String(cells[i] || '').trim() : '');
return {
name: get(idx.name), city: get(idx.city), language: get(idx.language), nationality: get(idx.nationality),
connected: get(idx.connected), tags: get(idx.tags), sex: get(idx.sex), stage: get(idx.stage),
milestones: get(idx.milestones), notes: get(idx.notes), dateLocations: get(idx.dateLocations),
dateEvents: get(idx.dateEvents), stars: get(idx.stars),
};
}).filter((r) => r.name); // a row with no name at all has nothing to import or match against
}

// City/Language/Nationality/Tags/Sex/Milestones/Date locations/Date
// events all map straight onto existing TAG_FIELDS entries (state.js) --
// location/languages/nationality/tags/sexTags/milestones/dateLocations/
// dateEvents. Stars -> the existing 1-5 priority rating. Connected (a
// bare year) -> matchedOn, same field Tinder's own "Matched on" writes,
// stored as Jan 1 of that year since that's all a year alone can give.
// Stage is matched case-insensitively against CONN_STAGES and left unset
// -- never guessed -- if it doesn't recognise one; the caller surfaces
// that as a warning rather than silently dropping or defaulting it.
function rowToConnFields(row) {
const fields = {
name: row.name,
location: splitList(row.city),
languages: splitList(row.language),
nationality: splitList(row.nationality),
tags: splitList(row.tags),
sexTags: splitList(row.sex),
milestones: splitList(row.milestones),
dateLocations: splitList(row.dateLocations),
dateEvents: splitList(row.dateEvents),
notes: row.notes,
};
let stageWarning = '';
const stageRaw = row.stage.trim();
if (stageRaw) {
const stageMatch = CONN_STAGES.find((s) => s.toLowerCase() === stageRaw.toLowerCase());
if (stageMatch) fields.stage = stageMatch; else stageWarning = stageRaw;
}
const yearMatch = row.connected.trim().match(/^(\d{4})$/);
if (yearMatch) fields.matchedOn = `${yearMatch[1]}-01-01`;
const starsNum = parseInt(row.stars, 10);
if (Number.isFinite(starsNum) && starsNum >= 1 && starsNum <= 5) fields.priority = starsNum;
return { fields, stageWarning };
}

// matchCandidates() (connections.js) per row, limit 3 -- same shape
// tinderimport.js's own buildPending() pre-selection uses. Only an
// 'exact' or 'shortened name' hit auto-selects a merge target; anything
// looser (an edit-distance guess) is left for the review list's own
// picker to confirm or reject by hand, same "don't silently guess
// between look-alikes" rule buildPending() follows for Tinder.
function classifyManualRows(rows) {
return rows.map((row) => {
const { fields, stageWarning } = rowToConnFields(row);
const candidates = matchCandidates(row.name, 3);
const top = candidates[0];
const confident = top && (top.why === 'exact' || top.why === 'shortened name');
return { row, fields, stageWarning, candidates, chosenId: confident ? top.conn.id : '' };
});
}

let manualRows = []; // classified rows currently on the review screen, cleared once applied
// Outlives the rows it refers to -- a submit that clears the review list
// also wipes out the status span that would have held the confirmation
// message, same reasoning tinderimport.js's own bulkSubmitMessage follows.
let manualImportMessage = '';

function matchWhyLabel(why) {
if (why === 'exact') return 'exact name match';
if (why === 'shortened name') return 'similar (shortened) name';
return why; // "N letters different" is already readable as-is
}

// One row per CSV entry, built from the exact same visual pattern the
// screenshot-import review already uses for "who is this?" decisions
// (candidateRowHtml/.pending-new/.pending-options/.pending-option/
// .decision-pick, connections.js) rather than a bespoke layout -- a top
// candidate is a plain radio (name + why it matched), "Different existing
// connection…" reveals the full connectionPickerHtml search only when
// picked, and everything stacks full-width instead of squeezing a picker
// onto the same line as the name (confirmed live: that squeezed layout
// forced the whole list into horizontal scroll on a normal-width screen).
function manualRowHtml(r, i) {
const confident = !!r.chosenId;
return `<div class="candidate-row ambiguous">
<div class="pending-new">
${avatarHtml(null, r.row.name, 'md')}
<div class="pending-new-info">
<div>${escapeHtml(r.row.name)}${r.candidates.length ? ` <span class="candidate-tag">${r.candidates.length} possible match${r.candidates.length === 1 ? '' : 'es'}</span>` : ''}</div>
${r.stageWarning ? `<div style="font-size:11px;color:var(--muted);">Unrecognised Stage "${escapeHtml(r.stageWarning)}" &mdash; not set, everything else on this row still imports.</div>` : ''}
</div>
</div>
<div class="pending-options">
${r.candidates.map((m) => `<label class="pending-option">
<input type="radio" name="manual-decision-${i}" value="merge:${escapeHtml(m.conn.id)}" data-manual-decision="${i}"${m.conn.id === r.chosenId ? ' checked' : ''}>
${avatarHtml(m.conn.photoId, m.conn.name, 'sm')}
<span class="pending-option-info"><strong>${escapeHtml(m.conn.name)}</strong><span class="compare-caption">${escapeHtml(matchWhyLabel(m.why))}</span></span>
</label>`).join('')}
<label class="pending-option">
<input type="radio" name="manual-decision-${i}" value="pick" data-manual-decision="${i}">
<span class="pending-option-info">Different existing connection&hellip;</span>
</label>
<div class="decision-pick" data-manual-pick="${i}" hidden>${connectionPickerHtml(`manual-import-pick-${i}`, 'Choose&hellip;')}</div>
<label class="pending-option">
<input type="radio" name="manual-decision-${i}" value="new" data-manual-decision="${i}"${confident ? '' : ' checked'}>
<span class="pending-option-info">Create new connection</span>
</label>
</div>
</div>`;
}

function renderManualImport() {
const el = document.getElementById('manual-import-review');
if (!el) return;
if (!manualRows.length) {
el.innerHTML = manualImportMessage ? `<div class="settings-note" style="margin:6px 0;">${escapeHtml(manualImportMessage)}</div>` : '';
return;
}
const newCount = manualRows.filter((r) => !r.chosenId).length;
const mergeCount = manualRows.length - newCount;
el.innerHTML = `<div class="album-card" style="margin-bottom:10px;">
<div class="album-caption"><strong>${manualRows.length} row${manualRows.length === 1 ? '' : 's'}</strong> parsed &mdash; ${newCount} new, ${mergeCount} will merge into an existing connection. Check each match below before importing.</div>
${manualRows.map((r, i) => manualRowHtml(r, i)).join('')}
<div class="sync-row" style="margin-top:8px;">
<button class="add-btn" type="button" id="manual-import-apply">Import ${manualRows.length} row${manualRows.length === 1 ? '' : 's'} (${newCount} new, ${mergeCount} merged)</button>
<button class="sync-btn" type="button" id="manual-import-cancel">Cancel</button>
</div>
</div>`;
bindConnPickers();
hydratePhotoBackgrounds(el);

// Reveals "Different existing connection…"'s own picker only while its
// row's radio group is the one set to 'pick' -- every other radio in
// that same row (a top-candidate merge, or "Create new") hides it again.
// Mirrors the identical toggle the screenshot-import review already uses
// for its own [data-decision]/[data-pending-pick] pair. Bound once on
// `el` itself (which survives every innerHTML rewrite above), not
// re-added per render -- re-adding here would stack up a fresh listener
// on every render (upload, cancel, re-upload...) since `el` never changes.
if (!el.dataset.manualChangeBound) {
el.dataset.manualChangeBound = '1';
el.addEventListener('change', (e) => {
const radio = e.target.closest('input[type=radio][data-manual-decision]');
if (!radio) return;
const picker = el.querySelector(`[data-manual-pick="${radio.dataset.manualDecision}"]`);
if (picker) picker.hidden = radio.value !== 'pick';
});
}

const applyBtn = document.getElementById('manual-import-apply');
if (applyBtn) applyBtn.addEventListener('click', () => {
let created = 0, merged = 0;
manualRows.forEach((r, i) => {
const decision = el.querySelector(`input[name="manual-decision-${i}"]:checked`)?.value || 'new';
const targetId = decision === 'pick' ? (document.getElementById(`manual-import-pick-${i}`)?.value || '')
: decision.startsWith('merge:') ? decision.slice(6) : '';
const target = targetId ? data.connections.find((c) => c.id === targetId) : null;
if (target) { mergeConnectionInto(target, blankConnection(r.fields)); merged++; return; }
data.connections.push(blankConnection(r.fields));
created++;
});
queueSave();
renderConnections();
import('./overview.js').then((m) => m.renderOverview());
manualRows = [];
manualImportMessage = `Imported ${created + merged} row${created + merged === 1 ? '' : 's'} (${created} new, ${merged} merged).`;
renderManualImport();
});
const cancelBtn = document.getElementById('manual-import-cancel');
if (cancelBtn) cancelBtn.addEventListener('click', () => { manualRows = []; manualImportMessage = ''; renderManualImport(); });
}

function initManualImport() {
const fileInput = document.getElementById('manual-import-file');
if (!fileInput) return; // panel not in this build's DOM
fileInput.addEventListener('change', () => {
const file = fileInput.files[0];
if (!file) return;
const reader = new FileReader();
reader.onload = () => {
const rows = parseManualCsv(String(reader.result || ''));
manualRows = classifyManualRows(rows);
renderManualImport();
fileInput.value = ''; // lets the same filename be re-picked after a Cancel
};
reader.readAsText(file);
});
}

export { initManualImport, parseManualCsv, rowToConnFields, classifyManualRows };
