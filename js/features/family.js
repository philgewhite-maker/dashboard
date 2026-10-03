// The Family tab: the three kids (Lewis, Zara, Charlotte) as the point
// of the view, not an exclusion filter -- they already exist as
// `isFamily: true` connections purely so Dating's own pipeline and
// Overview filter them OUT (state.js's own comment on isFamily). This
// is where they're the reason the tab exists instead.
//
// Editing happens HERE, not via a link to the Dating tab -- confirmed
// live that the Dating tab literally cannot show one: renderConnections()
// builds its entire list from `data.connections.filter(c => !c.isFamily)`
// unconditionally, with none of the "always reveal the person you
// navigated to" bypass expandConnection() already has for an archived/
// faded match. That's not a bug worth patching into Dating's own
// pipeline-shaped UI (stage, reach-out threshold, priority-as-romantic-
// interest -- none of it means anything for a 7-year-old); a kid's own
// card belongs here, scoped to the one thing this tab actually needs
// from it: a date of birth, since Books' "next to read" can't tell one
// child's age from another's without it.
//
// Deliberately thin beyond the strip + Books for now: a full person-
// centric view across tasks/travel/media/Airbnb is real future work,
// not built out here as empty placeholder sections that would look
// broken rather than deliberately deferred.
import { data, queueSave, currentAge, blankConnection } from '../state.js';
import { escapeHtml, avatarHtml, hydratePhotoBackgrounds } from '../utils.js';
import { initBooks, renderBooks } from './books.js';

function kidCardHtml(c) {
const age = currentAge(c);
return `<div class="mail-row" data-family-kid-row="${c.id}">
${avatarHtml(c.photoId, c.name, 'sm')}
<span class="mail-subject">${escapeHtml(c.name)}</span>
${age ? `<span class="settings-note" style="margin:0;">${age.value} yrs</span>` : `<span class="settings-note" style="margin:0;">No date of birth set</span>`}
<button type="button" class="sync-btn sm book-inline-btn" data-family-edit="${c.id}">Edit</button>
</div>`;
}

function openKidDialog(id) {
const existing = id ? data.connections.find((c) => c.id === id) : null;
const dialog = document.createElement('div');
dialog.className = 'mail-view-backdrop';
dialog.innerHTML = `<div class="mail-view-card" style="max-width:360px;">
<div class="mail-view-subject">${existing ? 'Edit family member' : 'Add a family member'}</div>
<label style="font-size:12px;display:block;margin-bottom:6px;">Name<input type="text" autocomplete="off" class="tag-add-input" data-kid-field="name" value="${escapeHtml(existing?.name || '')}" style="width:100%;display:block;"></label>
<label style="font-size:12px;display:block;margin-bottom:6px;">Date of birth <span class="settings-note" style="display:inline;margin:0;">(what "next to read" matches age against)</span><input type="date" class="tag-add-input" data-kid-field="dob" value="${escapeHtml(existing?.dob || '')}" style="width:100%;display:block;"></label>
<div class="mail-view-actions">
<button class="sync-btn sm" type="button" data-kid-cancel>Cancel</button>
<button class="add-btn" type="button" data-kid-save>${existing ? 'Save' : 'Add'}</button>
</div>
</div>`;
document.body.appendChild(dialog);
const close = () => dialog.remove();
dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
dialog.querySelector('[data-kid-cancel]').addEventListener('click', close);
dialog.querySelector('[data-kid-save]').addEventListener('click', () => {
const name = dialog.querySelector('[data-kid-field="name"]').value.trim();
const dob = dialog.querySelector('[data-kid-field="dob"]').value.trim();
if (!name) return;
if (existing) {
existing.name = name;
existing.dob = dob;
} else {
data.connections.push(blankConnection({ name, dob, isFamily: true }));
}
queueSave();
renderFamily();
close();
});
}

function kidsStripHtml() {
const kids = data.connections.filter((c) => c.isFamily);
return (kids.length ? kids.map(kidCardHtml).join('') : '<div class="empty">No family connections yet — add one below.</div>')
+ '<div class="sync-row" style="margin-top:6px;"><button class="sync-btn sm" type="button" id="family-add-kid-btn">+ Add a family member</button></div>';
}

function renderFamily() {
const strip = document.getElementById('family-kids-strip');
if (strip) {
strip.innerHTML = kidsStripHtml();
hydratePhotoBackgrounds(strip);
strip.querySelectorAll('[data-family-edit]').forEach((btn) => {
btn.addEventListener('click', () => openKidDialog(btn.dataset.familyEdit));
});
const addBtn = document.getElementById('family-add-kid-btn');
if (addBtn) addBtn.addEventListener('click', () => openKidDialog(null));
}
renderBooks();
}

function initFamily() {
initBooks();
renderFamily();
}

export { initFamily, renderFamily };
