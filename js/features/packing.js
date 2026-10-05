// Modular packing lists, one per trip. A reusable module LIBRARY
// (data.packingModules -- built-in modules seeded once, plus any custom
// ones the user adds) generates a trip's own editable checklist, keyed
// off facts the trip already carries: who's coming (trip.people's own
// relation field), the trip's length, which leg kinds it has (car hire),
// and an accommodation leg's own stayType. See the plan this was built
// from for the full design reasoning -- the short version: generation is
// additive and non-destructive (see generatePackingItems below), nothing
// the user has already checked, edited or deleted gets silently undone.
import {
data, queueSave, blankPackingListItem, packingDurationTier,
} from '../state.js';
import { escapeHtml, uid } from '../utils.js';
import { captureTask, taskChipHtml, bindTaskChips } from './tasks.js';
import { bookChipHtml, bindBookChips } from './books.js';
import { RELATION_LABELS, LEG_KIND_LABELS } from './travel.js';

function tripById(id) { return data.trips.find((t) => t.id === id); }
function moduleById(id) { return data.packingModules.find((m) => m.id === id); }

// ---- Generation ------------------------------------------------------

function tripDurationDays(trip) {
if (!trip.startDate) return null; // unknown -- callers fall back to the 'weekend' tier
const end = trip.endDate || trip.startDate;
const days = Math.round((new Date(end) - new Date(trip.startDate)) / 86400000) + 1;
return Number.isFinite(days) && days > 0 ? days : null;
}

function applicableModules(trip) {
return data.packingModules.filter((m) => {
const t = m.trigger || {};
if (t.type === 'always') return true;
if (t.type === 'relation') return trip.people.some((p) => p.relation === t.value);
if (t.type === 'legKind') return trip.legs.some((l) => l.kind === t.value);
if (t.type === 'stayType') {
const keywords = String(t.value || '').split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
return trip.legs.some((l) => l.kind === 'accommodation'
&& keywords.some((kw) => (l.fields.stayType || '').toLowerCase().includes(kw)));
}
return trip.packing.moduleState[m.id] === true; // 'manual'
});
}

function itemQtyForTrip(libItem, trip) {
if (!libItem.qtyByTier) return libItem.qty;
const days = tripDurationDays(trip);
const tier = packingDurationTier(days === null ? 1 : days);
const raw = libItem.qtyByTier[tier];
return raw === null || raw === undefined ? (days || 1) : raw; // null = match the day count 1:1
}

// Additive merge, never destructive: adds items a newly-applicable
// module brings that aren't already present and weren't deliberately
// removed; never touches an existing item's checked/qty/link state, and
// never deletes an item whose module has since stopped applying (you may
// have already packed it).
function generatePackingItems(trip) {
const existingSourceIds = new Set(trip.packing.items.map((i) => i.sourceItemId).filter(Boolean));
const removedIds = new Set(trip.packing.removedSourceItemIds);
for (const mod of applicableModules(trip)) {
for (const libItem of mod.items) {
if (existingSourceIds.has(libItem.id) || removedIds.has(libItem.id)) continue;
const qty = itemQtyForTrip(libItem, trip);
if (!qty) continue; // e.g. the laundry-day note is 0 outside the extended tier
trip.packing.items.push(blankPackingListItem({ moduleId: mod.id, sourceItemId: libItem.id, label: libItem.label, qty }));
}
}
trip.packing.generatedAt = new Date().toISOString();
queueSave();
}

function packingSummary(trip) {
const total = trip.packing.items.length;
const checked = trip.packing.items.filter((i) => i.checked).length;
return { checked, total };
}

// ---- Per-trip item edits ----------------------------------------------

function addCustomPackingItem(trip, label, qty) {
const clean = String(label || '').trim();
if (!clean) return;
trip.packing.items.push(blankPackingListItem({ label: clean, qty: Math.max(1, Number(qty) || 1), custom: true }));
queueSave();
}
function togglePackingItemChecked(trip, itemId) {
const item = trip.packing.items.find((i) => i.id === itemId);
if (!item) return;
item.checked = !item.checked;
queueSave();
}
function updatePackingItemQty(trip, itemId, qty) {
const item = trip.packing.items.find((i) => i.id === itemId);
if (!item) return;
item.qty = Math.max(0, Number(qty) || 0);
queueSave();
}
function removePackingItem(trip, itemId) {
const item = trip.packing.items.find((i) => i.id === itemId);
if (!item) return;
// A generated item is suppressed permanently (same "deletion sticks"
// instinct as the ticker's seeded letting tile) -- a custom item has no
// sourceItemId, so it's just gone, nothing to suppress.
if (item.sourceItemId) trip.packing.removedSourceItemIds.push(item.sourceItemId);
trip.packing.items = trip.packing.items.filter((i) => i.id !== itemId);
queueSave();
}
function toggleManualModule(trip, moduleId) {
trip.packing.moduleState[moduleId] = !trip.packing.moduleState[moduleId];
queueSave();
}
function linkPackingItemToTask(trip, itemId, { shopping = false } = {}) {
const item = trip.packing.items.find((i) => i.id === itemId);
if (!item) return;
const title = prompt(shopping ? 'Buy what?' : 'Task title?', item.label);
if (!title || !title.trim()) return;
const task = captureTask({ title: title.trim(), contexts: shopping ? ['Supermarket'] : [], bucket: 'next' });
item.linkedTaskId = task.id;
queueSave();
}
function linkPackingItemToBook(trip, itemId) {
const item = trip.packing.items.find((i) => i.id === itemId);
if (!item) return;
const q = prompt('Book title (or part of it)?', item.label);
if (!q || !q.trim()) return;
const needle = q.trim().toLowerCase();
const book = data.books.find((b) => b.title.toLowerCase().includes(needle));
if (!book) { alert(`No book on the shelf matches "${q.trim()}".`); return; }
item.linkedBookId = book.id;
queueSave();
}
function unlinkPackingItem(trip, itemId) {
const item = trip.packing.items.find((i) => i.id === itemId);
if (!item) return;
item.linkedTaskId = '';
item.linkedBookId = '';
queueSave();
}

// ---- Per-trip rendering -------------------------------------------------

function packingItemRowHtml(trip, item) {
let linkHtml = '';
if (item.linkedTaskId) {
const task = data.tasks.find((t) => t.id === item.linkedTaskId);
linkHtml = task ? taskChipHtml(task, `<span class="tag-x" data-packing-unlink="${trip.id}" data-item-id="${item.id}" title="Unlink">&times;</span>`) : '';
} else if (item.linkedBookId) {
const book = data.books.find((b) => b.id === item.linkedBookId);
linkHtml = book ? bookChipHtml(book, `<span class="tag-x" data-packing-unlink="${trip.id}" data-item-id="${item.id}" title="Unlink">&times;</span>`) : '';
}
// An unlinked item shows no per-row link controls -- that was three
// buttons on every single row. Linking instead happens through the one
// shared item+kind picker below the list (linkRowHtml).
return `<div class="todo-item ${item.checked ? 'done' : ''}" data-packing-item-row="${item.id}">
<input type="checkbox" ${item.checked ? 'checked' : ''} data-packing-item-toggle="${trip.id}" data-item-id="${item.id}">
<span>${escapeHtml(item.label)}</span>
<input type="number" min="0" class="tag-add-input" style="width:46px;" value="${item.qty}" data-packing-item-qty="${trip.id}" data-item-id="${item.id}">
${linkHtml}
<span class="tag-x" data-packing-item-remove="${trip.id}" data-item-id="${item.id}" title="Remove">&times;</span>
</div>`;
}

function manualModuleTogglesHtml(trip) {
const manual = data.packingModules.filter((m) => (m.trigger || {}).type === 'manual');
if (!manual.length) return '';
return `<div class="tag-editor" style="margin:6px 0;">${manual.map((m) => `<span class="pick-chip${trip.packing.moduleState[m.id] ? ' active' : ''}" data-packing-module-toggle="${trip.id}" data-module-id="${m.id}">${escapeHtml(m.name)}</span>`).join('')}</div>`;
}

function packingGroupsHtml(trip) {
const groups = new Map(); // group label -> items[]
trip.packing.items.forEach((item) => {
const mod = item.moduleId ? moduleById(item.moduleId) : null;
const label = mod ? (mod.group || mod.name) : 'Custom';
if (!groups.has(label)) groups.set(label, []);
groups.get(label).push(item);
});
if (!groups.size) return '';
return [...groups.entries()].map(([label, items]) => `
<div class="packing-group-head">${escapeHtml(label)}</div>
<div class="todo-list">${items.map((item) => packingItemRowHtml(trip, item)).join('')}</div>`).join('');
}

// One shared row to link ANY item to a Task/Shopping task/Book, instead
// of three buttons repeated on every single row. Only items without a
// link yet are offered -- relink by unlinking first (the chip's own x).
function linkRowHtml(trip) {
const unlinked = trip.packing.items.filter((i) => !i.linkedTaskId && !i.linkedBookId);
if (!unlinked.length) return '';
return `<div class="sync-row" style="margin-top:8px;">
<select data-packing-link-item="${trip.id}">
<option value="">Link an item&hellip;</option>
${unlinked.map((i) => `<option value="${i.id}">${escapeHtml(i.label)}</option>`).join('')}
</select>
<select data-packing-link-kind="${trip.id}">
<option value="task">to a Task</option>
<option value="shopping">to Shopping</option>
<option value="book">to a Book</option>
</select>
<button class="sync-btn sm" type="button" data-packing-link-go="${trip.id}">Link</button>
</div>`;
}

// Nothing is generated for a trip until this button is pressed -- a brand
// new trip has no packing list at all, by design (the point this got
// pushed back on: a list is wanted once things are actually booked, not
// the moment a trip exists). The same button doubles as the top-up
// action afterward, since generatePackingItems is already a safe
// additive merge either way -- only its label changes.
function packingSectionHtml(trip) {
const hasItems = trip.packing.items.length > 0;
const { checked, total } = packingSummary(trip);
return `<div class="packing-section" data-packing-section="${trip.id}" style="margin-top:12px;">
<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;">
<h3 style="margin:0;font-size:14px;">Packing${hasItems ? ` <span class="settings-note" style="display:inline;">${checked} of ${total} packed</span>` : ''}</h3>
<button class="todo-add-btn" type="button" data-packing-generate="${trip.id}">${hasItems ? 'Refresh' : 'Generate packing list'}</button>
</div>
${manualModuleTogglesHtml(trip)}
${hasItems ? `<details data-packing-details>
<summary class="settings-note" style="cursor:pointer;">Show packing list</summary>
${packingGroupsHtml(trip)}
<div class="attach-row" style="margin-top:6px;">
<input type="text" class="tag-add-input" data-packing-add-input="${trip.id}" placeholder="+ custom item">
<input type="number" min="1" class="tag-add-input" style="width:46px;" value="1" data-packing-add-qty="${trip.id}">
<button class="todo-add-btn" type="button" data-packing-add-btn="${trip.id}">Add</button>
</div>
${linkRowHtml(trip)}
</details>` : ''}
${!trip.startDate ? '<div class="settings-note" style="margin-top:4px;">Add trip dates above for an accurate packing list.</div>' : ''}
</div>`;
}

// Collapsed by default (a plain <details> with no `open` attribute) --
// but a rerender triggered from something the user did INSIDE the open
// list (checking an item, editing a qty...) would otherwise snap it shut
// on every click, since outerHTML replacement throws away the live DOM
// state. Reads the current open/closed state first and restores it,
// unless forceOpen asks to show the result of an explicit action (the
// Generate/Refresh button) regardless of what it was before.
function rerenderPacking(trip, { forceOpen = false } = {}) {
const el = document.querySelector(`[data-packing-section="${trip.id}"]`);
if (!el) return;
const wasOpen = forceOpen || !!el.querySelector('[data-packing-details]')?.open;
el.outerHTML = packingSectionHtml(trip);
const fresh = document.querySelector(`[data-packing-section="${trip.id}"]`);
const details = fresh?.querySelector('[data-packing-details]');
if (details && wasOpen) details.open = true;
bindPackingSection(fresh);
}

function bindPackingSection(section) {
if (!section) return;
const tripId = section.dataset.packingSection;
const trip = tripById(tripId);
if (!trip) return;
section.querySelector('[data-packing-generate]')?.addEventListener('click', () => { generatePackingItems(trip); rerenderPacking(trip, { forceOpen: true }); });
// Toggling a module just records the choice -- it does NOT regenerate on
// its own, so picking Beach before ever generating doesn't quietly
// create a list you never asked for. The next Generate/Refresh click
// picks up whatever's toggled on at that point.
section.querySelectorAll('[data-packing-module-toggle]').forEach((chip) => {
chip.addEventListener('click', () => { toggleManualModule(trip, chip.dataset.moduleId); rerenderPacking(trip); });
});
section.querySelectorAll('[data-packing-item-toggle]').forEach((cb) => {
cb.addEventListener('change', () => { togglePackingItemChecked(trip, cb.dataset.itemId); rerenderPacking(trip); });
});
section.querySelectorAll('[data-packing-item-qty]').forEach((input) => {
input.addEventListener('change', () => { updatePackingItemQty(trip, input.dataset.itemId, input.value); rerenderPacking(trip); });
});
section.querySelectorAll('[data-packing-item-remove]').forEach((x) => {
x.addEventListener('click', () => { removePackingItem(trip, x.dataset.itemId); rerenderPacking(trip); });
});
section.querySelector('[data-packing-link-go]')?.addEventListener('click', () => {
const itemSel = section.querySelector('[data-packing-link-item]');
const kindSel = section.querySelector('[data-packing-link-kind]');
const itemId = itemSel?.value;
if (!itemId) return;
const kind = kindSel?.value;
if (kind === 'book') linkPackingItemToBook(trip, itemId);
else linkPackingItemToTask(trip, itemId, { shopping: kind === 'shopping' });
rerenderPacking(trip);
});
section.querySelectorAll('[data-packing-unlink]').forEach((x) => {
x.addEventListener('click', () => { unlinkPackingItem(trip, x.dataset.itemId); rerenderPacking(trip); });
});
const addBtn = section.querySelector('[data-packing-add-btn]');
const addInput = section.querySelector('[data-packing-add-input]');
const addQty = section.querySelector('[data-packing-add-qty]');
const commitAdd = () => {
if (!addInput || !addInput.value.trim()) return;
addCustomPackingItem(trip, addInput.value, addQty ? addQty.value : 1);
rerenderPacking(trip);
};
addBtn?.addEventListener('click', commitAdd);
addInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitAdd(); } });
}

function bindPacking(root) {
bindTaskChips();
bindBookChips();
root.querySelectorAll('[data-packing-section]').forEach(bindPackingSection);
}

// ---- Settings: the module library editor --------------------------------

const TRIGGER_TYPE_LABELS = { always: 'Always included', relation: "Who's coming", legKind: 'Trip has this leg type', stayType: 'Accommodation stay type', manual: 'Manual (toggle per trip)' };
const TRIGGER_RELATION_OPTIONS = ['partner', 'child', 'other'];

function packingLibraryItemChipHtml(moduleId, item) {
const qtyLabel = item.qtyByTier ? `${item.qtyByTier.week ?? ''} (scales with trip length)` : String(item.qty);
return `<span class="tag-chip">${escapeHtml(item.label)} &times;${escapeHtml(qtyLabel)}<span class="tag-x" data-packing-lib-item-remove="${moduleId}" data-item-id="${item.id}">&times;</span></span>`;
}

function triggerValueControlHtml(m) {
const t = m.trigger || {};
if (t.type === 'relation') {
return `<select data-packing-module-trigger-value="${m.id}">${TRIGGER_RELATION_OPTIONS.map((v) => `<option value="${v}"${v === t.value ? ' selected' : ''}>${escapeHtml(RELATION_LABELS[v] || v)}</option>`).join('')}</select>`;
}
if (t.type === 'legKind') {
return `<select data-packing-module-trigger-value="${m.id}">${Object.keys(LEG_KIND_LABELS).map((k) => `<option value="${k}"${k === t.value ? ' selected' : ''}>${escapeHtml(LEG_KIND_LABELS[k])}</option>`).join('')}</select>`;
}
if (t.type === 'stayType') {
return `<input type="text" class="settings-input" style="max-width:180px;" value="${escapeHtml(t.value)}" placeholder="keyword(s), comma separated" data-packing-module-trigger-value="${m.id}">`;
}
return '';
}

function packingModuleRowHtml(m) {
return `<div class="settings-block" data-packing-module-row="${m.id}" style="margin-bottom:10px;">
<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
<input type="text" class="settings-input" style="max-width:150px;" value="${escapeHtml(m.name)}" placeholder="Module name" data-packing-module-name="${m.id}">
<input type="text" class="settings-input" style="max-width:130px;" value="${escapeHtml(m.group)}" placeholder="Section heading" data-packing-module-group="${m.id}">
<select data-packing-module-trigger-type="${m.id}">${Object.entries(TRIGGER_TYPE_LABELS).map(([k, v]) => `<option value="${k}"${k === (m.trigger || {}).type ? ' selected' : ''}>${escapeHtml(v)}</option>`).join('')}</select>
${triggerValueControlHtml(m)}
<span class="tag-x" data-packing-module-remove="${m.id}" title="Delete this module${m.builtIn ? ' (it will not come back)' : ''}">&times;</span>
</div>
<div class="tag-editor" style="margin-top:6px;">${m.items.map((i) => packingLibraryItemChipHtml(m.id, i)).join('')}</div>
<div class="sync-row" style="margin-top:6px;">
<input type="text" class="tag-add-input" placeholder="Item name" data-packing-lib-item-label="${m.id}">
<input type="number" min="1" class="tag-add-input" style="width:60px;" placeholder="Qty" value="1" data-packing-lib-item-qty="${m.id}">
<button class="sync-btn sm" type="button" data-packing-lib-item-add="${m.id}">Add item</button>
</div>
</div>`;
}

function renderPackingModules() {
const el = document.getElementById('packing-modules');
if (!el) return;
el.innerHTML = data.packingModules.map(packingModuleRowHtml).join('');
el.querySelectorAll('[data-packing-module-name]').forEach((input) => {
input.addEventListener('change', () => { const m = moduleById(input.dataset.packingModuleName); if (m) { m.name = input.value.trim(); queueSave(); } });
});
el.querySelectorAll('[data-packing-module-group]').forEach((input) => {
input.addEventListener('change', () => { const m = moduleById(input.dataset.packingModuleGroup); if (m) { m.group = input.value.trim(); queueSave(); } });
});
el.querySelectorAll('[data-packing-module-trigger-type]').forEach((select) => {
select.addEventListener('change', () => {
const m = moduleById(select.dataset.packingModuleTriggerType);
if (!m) return;
m.trigger = { type: select.value, value: select.value === 'relation' ? 'partner' : select.value === 'legKind' ? 'flight' : '' };
queueSave();
renderPackingModules();
});
});
el.querySelectorAll('[data-packing-module-trigger-value]').forEach((ctrl) => {
ctrl.addEventListener('change', () => { const m = moduleById(ctrl.dataset.packingModuleTriggerValue); if (m) { m.trigger.value = ctrl.value; queueSave(); } });
});
el.querySelectorAll('[data-packing-module-remove]').forEach((x) => {
x.addEventListener('click', () => {
data.packingModules = data.packingModules.filter((m) => m.id !== x.dataset.packingModuleRemove);
queueSave();
renderPackingModules();
});
});
el.querySelectorAll('[data-packing-lib-item-remove]').forEach((x) => {
x.addEventListener('click', () => {
const m = moduleById(x.dataset.packingLibItemRemove);
if (!m) return;
m.items = m.items.filter((i) => i.id !== x.dataset.itemId);
queueSave();
renderPackingModules();
});
});
el.querySelectorAll('[data-packing-lib-item-add]').forEach((btn) => {
btn.addEventListener('click', () => {
const m = moduleById(btn.dataset.packingLibItemAdd);
if (!m) return;
const labelInput = el.querySelector(`[data-packing-lib-item-label="${m.id}"]`);
const qtyInput = el.querySelector(`[data-packing-lib-item-qty="${m.id}"]`);
const label = labelInput.value.trim();
if (!label) return;
m.items.push({ id: uid(), label, qty: Math.max(1, Number(qtyInput.value) || 1), qtyByTier: null });
queueSave();
renderPackingModules();
});
});
}

function addPackingModule() {
data.packingModules.push({ id: uid(), name: 'New module', group: 'Custom', builtIn: false, trigger: { type: 'manual', value: '' }, items: [] });
queueSave();
renderPackingModules();
}

function bindPackingModules() {
const addBtn = document.getElementById('packing-module-add-btn');
if (addBtn && !addBtn.dataset.bound) {
addBtn.dataset.bound = '1';
addBtn.addEventListener('click', addPackingModule);
}
}

export {
packingSectionHtml, bindPacking, generatePackingItems, packingSummary,
renderPackingModules, bindPackingModules,
};
