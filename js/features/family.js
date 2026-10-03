// The Family tab: the three kids (Lewis, Zara, Charlotte) as the point
// of the view, not an exclusion filter -- they already exist as
// `isFamily: true` connections purely so Dating's own pipeline and
// Overview filter them OUT (state.js's own comment on isFamily). This
// is where they're the reason the tab exists instead.
//
// Deliberately thin beyond the strip + Books for now: a full person-
// centric view across tasks/travel/media/Airbnb is real future work,
// not built out here as empty placeholder sections that would look
// broken rather than deliberately deferred.
import { data, currentAge } from '../state.js';
import { escapeHtml } from '../utils.js';
import { connectionChipHtml, bindConnectionChips } from './connections.js';
import { initBooks, renderBooks } from './books.js';

function kidsStripHtml() {
const kids = data.connections.filter((c) => c.isFamily);
if (!kids.length) return '<div class="empty">No family connections yet — add one in Connections and tick "Family" on their card.</div>';
return `<div class="family-kids-strip">${kids.map((c) => {
const age = currentAge(c);
const ageLabel = age ? ` <span class="settings-note" style="margin:0;">(${age.value})</span>` : '';
return connectionChipHtml(c, ageLabel);
}).join('')}</div>`;
}

function renderFamily() {
const strip = document.getElementById('family-kids-strip');
if (strip) {
strip.innerHTML = kidsStripHtml();
bindConnectionChips(strip);
}
renderBooks();
}

function initFamily() {
initBooks();
renderFamily();
}

export { initFamily, renderFamily };
