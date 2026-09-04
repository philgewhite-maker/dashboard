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
import { escapeHtml, splitCsvLine, hydratePhotoBackgrounds } from '../utils.js';
import { CONN_STAGES, matchCandidates, mergeConnectionInto, connectionPickerHtml, bindConnPickers, setConnPickerValue, renderConnections } from './connections.js';

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
<div class="album-caption"><strong>${manualRows.length} row${manualRows.length === 1 ? '' : 's'}</strong> parsed &mdash; ${newCount} new, ${mergeCount} will merge into an existing connection. Check each match below (search to pick a different one, or clear it to create new instead) before importing.</div>
<div class="tinder-bulk-list">
${manualRows.map((r, i) => `<div class="tinder-bulk-row">
<div class="tinder-bulk-row-top">
<span class="tinder-bulk-info"><strong>${escapeHtml(r.row.name)}</strong>
${r.stageWarning ? `<br><span class="tinder-field-note">Unrecognised Stage "${escapeHtml(r.stageWarning)}" &mdash; not set, everything else on this row still imports.</span>` : ''}
</span>
${connectionPickerHtml(`manual-import-pick-${i}`, '&mdash; create new &mdash;', '')}
</div>
</div>`).join('')}
</div>
<div class="sync-row" style="margin-top:8px;">
<button class="add-btn" type="button" id="manual-import-apply">Import ${manualRows.length} row${manualRows.length === 1 ? '' : 's'} (${newCount} new, ${mergeCount} merged)</button>
<button class="sync-btn" type="button" id="manual-import-cancel">Cancel</button>
</div>
</div>`;
bindConnPickers();
manualRows.forEach((r, i) => { if (r.chosenId) setConnPickerValue(`manual-import-pick-${i}`, r.chosenId); });
hydratePhotoBackgrounds(el);

const applyBtn = document.getElementById('manual-import-apply');
if (applyBtn) applyBtn.addEventListener('click', () => {
let created = 0, merged = 0;
manualRows.forEach((r, i) => {
// The picker's own hidden input is read live rather than trusting
// r.chosenId -- it's the one place a manual override (search-picked
// a different connection, or cleared it back to "create new") after
// the auto-match actually lands.
const pickedId = document.getElementById(`manual-import-pick-${i}`)?.value || '';
if (pickedId) {
const target = data.connections.find((c) => c.id === pickedId);
if (target) { mergeConnectionInto(target, blankConnection(r.fields)); merged++; return; }
}
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
