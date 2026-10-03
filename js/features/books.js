// Physical books on the Family tab's shelf. Mostly bought for Charlotte
// (7, lives away) but shared across the three kids -- the real question
// this exists to answer is "what's read, what fits her age right now,
// what should I pack for the next visit" without walking over to the
// shelf and looking.
//
// Read?/Score are GLOBAL, not per child -- one shared status, not three,
// confirmed with the user when this was planned. "Who has it?" reuses
// blankInventoryItem's own holderId meaning exactly (shopping.js's AP
// inventory): blank is "at your home", set is "given permanently to
// that connection" -- same question, same answer shape.
import { data, queueSave, blankBookItem, currentAge } from '../state.js';
import { escapeHtml, affiliateLink, scrollAndFlash, hydratePhotoBackgrounds, splitCsvLine, todayStr, MISSING_KEY_LINK_HTML } from '../utils.js';
import { connectionChipHtml, bindConnectionChips, connectionPickerHtml, bindConnPickers, setConnPickerValue } from './connections.js';
import { searchTitle } from '../catalogue.js';
import { MissingKeyError, resolveBookDetails, resolveSeriesBooks } from '../ai.js';

let nextForChild = ''; // connection id chosen in the "Next 3 to read" picker, '' = none picked yet

function familyKids() {
return data.connections.filter((c) => c.isFamily);
}

// ---- Series grouping -------------------------------------------------

function orderNum(b) {
const n = parseInt(b.seriesOrder, 10);
return Number.isFinite(n) ? n : Infinity; // no order -> sorts last within its series
}

// Table-level sort/filter state, independent of each other -- 'next 3
// to read' below has its own separate, unrelated ranking and doesn't
// read any of this.
let sortMode = 'series'; // 'series' | 'age' | 'author'
let readFilter = 'all'; // 'all' | 'unread' | 'read'
let inFlightOnly = false; // series with some, but not all, entries read
// Which series (by name) currently show their "rest of series" list --
// a plain Set rather than native <details>/<summary>, since the toggle
// control needed to sit INSIDE the same flex column as the title (so it
// fits within the cover image's height instead of adding a row below
// it), and a <summary> can't be relocated like that without fighting
// its own built-in click/toggle semantics (already confirmed live once,
// see the stopPropagation history below).
let expandedSeries = new Set();

// One entry per distinct `series` value; a blank series is its own
// group of one, same as a standalone book really is one. Sorted by the
// NEXT unread book's own age/author when sorting by those -- same
// reasoning the summary row shows the next book's details rather than
// the series' own first entry: that's the book the sort is actually
// meant to surface.
function bookGroups() {
const groups = new Map();
data.books.forEach((b) => {
const key = b.series.trim() || `__standalone__${b.id}`;
if (!groups.has(key)) groups.set(key, { series: b.series.trim(), items: [] });
groups.get(key).items.push(b);
});
const built = [...groups.values()].map((g) => {
const items = [...g.items].sort((a, b) => orderNum(a) - orderNum(b) || a.title.localeCompare(b.title));
const next = items.find((b) => !b.read);
return { ...g, items, next, allRead: !next };
});
const byName = (a, b) => (a.series || a.items[0].title).localeCompare(b.series || b.items[0].title);
if (sortMode === 'age') {
const ageVal = (g) => { const b = g.allRead ? g.items[0] : g.next; const v = b.minAge !== '' ? Number(b.minAge) : NaN; return Number.isFinite(v) ? v : Infinity; };
return built.sort((a, b) => ageVal(a) - ageVal(b) || byName(a, b));
}
if (sortMode === 'author') {
const authorVal = (g) => ((g.allRead ? g.items[0] : g.next).author || '').trim();
return built.sort((a, b) => authorVal(a).localeCompare(authorVal(b)) || byName(a, b));
}
return built.sort(byName);
}

// Filtered/sorted view actually shown in the table -- kept separate
// from bookGroups() itself so "held"/"next" always reflect the real,
// unfiltered shelf (see groupHtml's own reasoning) while readFilter only
// changes which detail ROWS are visible inside a kept group, and
// inFlightOnly drops whole groups. Both read off the true, unfiltered
// grouping first -- "in-flight" inherently needs to see both read and
// unread entries in the same group to tell a started series from a
// finished or untouched one, which filtering rows first would hide.
function visibleGroups() {
let groups = bookGroups();
if (inFlightOnly) groups = groups.filter((g) => g.series && !g.allRead && g.items.some((b) => b.read));
if (readFilter !== 'all') {
groups = groups
.map((g) => ({ ...g, items: g.items.filter((b) => (readFilter === 'read' ? b.read : !b.read)) }))
.filter((g) => g.items.length);
}
return groups;
}

// ---- "Next 3 to read" -------------------------------------------------

// Age fit: either bound may be blank, meaning no constraint on that
// side. No age on file for the child at all -> nothing is excluded on
// age grounds, since there's no number to compare against.
function ageFits(book, age) {
if (age == null) return true;
const min = book.minAge === '' ? -Infinity : Number(book.minAge);
const max = book.maxAge === '' ? Infinity : Number(book.maxAge);
return age >= min && age <= max;
}

// Per series, only the lowest-order UNREAD book counts -- a continued
// series surfaces one candidate, not every remaining entry at once.
// Standalone unread books each count individually. Ranked: a series
// already started (something in it already read) before a brand new
// one, then standalone, alphabetical as the tiebreak -- simple and
// exactly what it looks like, not dressed up as more than it is.
function nextToRead(age, limit = 3) {
const candidates = [];
bookGroups().forEach((g) => {
if (!g.next) return; // nothing unread left in this group
const started = g.series && g.items.some((b) => b.read);
if (!ageFits(g.next, age)) return;
candidates.push({ book: g.next, started: !!started, standalone: !g.series });
});
candidates.sort((a, b) => {
if (a.started !== b.started) return a.started ? -1 : 1;
if (a.standalone !== b.standalone) return a.standalone ? 1 : -1;
return a.book.title.localeCompare(b.book.title);
});
return candidates.slice(0, limit).map((c) => c.book);
}

// ---- Record-reference pattern (CLAUDE.md) ------------------------------

function bookChipHtml(book, extraHtml = '') {
const art = book.imageUrl ? `<img class="media-art" src="${escapeHtml(book.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" style="width:18px;height:18px;border-radius:3px;">` : '';
return `<span class="task-chip" data-open-book="${escapeHtml(book.id)}">${art}${escapeHtml(book.title)}</span>${extraHtml}`;
}

let bookChipsBound = false;
function bindBookChips() {
if (bookChipsBound) return;
bookChipsBound = true;
document.addEventListener('click', async (e) => {
const chip = e.target.closest('[data-open-book]');
if (!chip) return;
const { switchTab } = await import('../tabs.js');
switchTab('family');
revealBookItem(chip.dataset.openBook);
});
}

function revealBookItem(id) {
const book = data.books.find((b) => b.id === id);
if (!book) return;
// Only the group's own representative book renders unconditionally --
// anything else in its series only exists in the DOM once that
// series' "rest of series" list is expanded (expandedSeries below).
if (book.series) expandedSeries.add(book.series.trim());
renderBooks();
setTimeout(() => scrollAndFlash(`[data-book-row="${id}"]`), 60);
}

// ---- CSV import ---------------------------------------------------------

const CSV_COLUMNS = ['Title', 'Author', 'Series', 'Series Order', 'Min Reading Age', 'Max Reading Age'];

function parseBooksCsv(text) {
const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
if (!lines.length) return [];
const header = splitCsvLine(lines[0]).map((h) => h.trim());
const col = (label) => header.findIndex((h) => h.toLowerCase() === label.toLowerCase());
const idx = Object.fromEntries(CSV_COLUMNS.map((c) => [c, col(c)]));
return lines.slice(1).map((line) => {
const cells = splitCsvLine(line);
const get = (i) => (i >= 0 && i < cells.length ? String(cells[i] || '').trim() : '');
return {
title: get(idx.Title), author: get(idx.Author), series: get(idx.Series),
seriesOrder: get(idx['Series Order']), minAge: get(idx['Min Reading Age']), maxAge: get(idx['Max Reading Age']),
};
}).filter((r) => r.title); // a row with no title has nothing to import
}

function isDuplicateBook(title, author) {
const t = title.trim().toLowerCase();
const a = author.trim().toLowerCase();
return data.books.some((b) => b.title.trim().toLowerCase() === t && b.author.trim().toLowerCase() === a);
}

let csvRows = []; // {row, dup} classified rows on the review screen, cleared once applied

function renderCsvReview() {
const el = document.getElementById('books-csv-review');
if (!el) return;
if (!csvRows.length) { el.innerHTML = ''; return; }
const dupCount = csvRows.filter((r) => r.dup).length;
el.innerHTML = `<div class="album-card" style="margin-bottom:10px;">
<div class="album-caption"><strong>${csvRows.length} row${csvRows.length === 1 ? '' : 's'}</strong> parsed &mdash; ${dupCount} look${dupCount === 1 ? 's' : ''} already on the shelf (same title + author) and ${dupCount === 1 ? 'is' : 'are'} skipped by default.</div>
${csvRows.map((r, i) => `<label class="pending-option" style="display:flex;">
<input type="checkbox" data-csv-row="${i}" ${r.dup ? '' : 'checked'}>
<span class="pending-option-info"><strong>${escapeHtml(r.row.title)}</strong>${r.row.author ? ` &mdash; ${escapeHtml(r.row.author)}` : ''}${r.dup ? ' <span class="candidate-tag">already on the shelf</span>' : ''}</span>
</label>`).join('')}
<div class="sync-row" style="margin-top:8px;">
<button class="add-btn" type="button" id="books-csv-apply">Add ticked rows</button>
<button class="sync-btn" type="button" id="books-csv-cancel">Cancel</button>
</div>
</div>`;
document.getElementById('books-csv-apply').addEventListener('click', () => {
const added = [];
csvRows.forEach((r, i) => {
if (!document.querySelector(`[data-csv-row="${i}"]`).checked) return;
const book = blankBookItem({
title: r.row.title, author: r.row.author, series: r.row.series,
seriesOrder: r.row.seriesOrder, minAge: r.row.minAge, maxAge: r.row.maxAge,
});
data.books.push(book);
added.push(book);
});
queueSave();
csvRows = [];
renderCsvReview();
renderBooks();
const status = document.getElementById('books-csv-status');
const addedMsg = `Added ${added.length} book${added.length === 1 ? '' : 's'}.`;
if (status) status.textContent = addedMsg;
// Series/age aren't in the CSV columns for every row, and going and
// looking each one up by hand afterwards is exactly the kind of
// second manual step this shouldn't need -- so any added row still
// missing them gets looked up automatically, same as media.js fills
// artwork in after an item already exists rather than delaying it.
enrichMissingDetails(added.filter((b) => !b.series && !b.minAge && !b.maxAge), status, addedMsg);
enrichMissingCovers(added);
});
document.getElementById('books-csv-cancel').addEventListener('click', () => { csvRows = []; renderCsvReview(); });
}

// No catalogue link found for this book -- same "no better link exists,
// construct a search URL" fallback Overview's own weather link already
// uses (a plain Google search for the city). A title that LOOKS like a
// link (see the .mail-subject hover-colour fix above) should actually
// go somewhere rather than just stop looking like one; Google Books is
// closer to the mark than a bare web search for an actual book.
function bookSearchFallbackLink(book) {
const q = [book.title, book.author].filter(Boolean).join(' ');
return `https://www.google.com/search?tbm=bks&q=${encodeURIComponent(q)}`;
}

// A cover (and a real link) for anything added without them -- CSV
// import never had either in the first place (confirmed live as a real
// gap: every CSV-imported book showed no thumbnail and no working
// title link, since only the manual-add lookup and a Media flow-in ever
// filled imageUrl/link). Open Library's title search is free and
// keyless, so this runs unconditionally and mostly silently, same as
// media.js's own fillArtwork -- a cover is decoration, worth having
// automatically, not worth a status line of its own or a dependency on
// an Anthropic key the series/age lookup needs. The link always ends up
// set, even on a lookup failure or a miss -- falling back to a search
// link rather than leaving the title dead.
async function enrichMissingCovers(books) {
for (const book of books) {
if (book.imageUrl && book.link) continue;
const live = data.books.find((b) => b.id === book.id);
if (!live) continue;
try {
const candidates = await searchTitle('book', `${book.title} ${book.author}`.trim());
const hit = candidates[0];
if (hit) {
if (!live.imageUrl && hit.imageUrl) live.imageUrl = hit.imageUrl;
if (!live.link && hit.link) live.link = hit.link;
if (!Object.keys(live.externalIds || {}).length && hit.externalIds) live.externalIds = hit.externalIds;
}
} catch (err) {
console.error('Cover lookup failed:', err);
}
if (!live.link) live.link = bookSearchFallbackLink(live);
queueSave();
renderBooks();
}
}

// Runs resolveBookDetails for each book in turn (sequential, not
// parallel -- this is several real API calls, no reason to fire them
// all at once) and saves/re-renders as each answer lands, so partial
// progress is never lost if the tab closes partway through a big
// upload.
async function enrichMissingDetails(books, statusEl, doneMessage = '') {
for (let i = 0; i < books.length; i++) {
const book = books[i];
if (statusEl) statusEl.textContent = `Looking up series & age (${i + 1} of ${books.length})…`;
try {
const details = await resolveBookDetails(book.title, book.author);
const live = data.books.find((b) => b.id === book.id);
if (!live) continue; // removed while the lookup was in flight
if (details.series) live.series = details.series;
if (details.seriesOrder) live.seriesOrder = details.seriesOrder;
if (details.minAge) live.minAge = details.minAge;
if (details.maxAge) live.maxAge = details.maxAge;
queueSave();
renderBooks();
} catch (err) {
// A MissingKeyError on the first book means every remaining one
// will fail identically -- stop asking rather than retry N times
// for nothing, same reasoning page.colourVariants' own agent-down
// check follows.
if (err instanceof MissingKeyError) break;
console.error('Book detail lookup failed, left blank:', err);
}
}
// Restores whatever this status line was showing before enrichment
// took it over (e.g. "Added 12 books.") rather than leaving it blank
// -- confirmed live as a real bug: the confirmation message was
// getting silently wiped the moment background enrichment finished.
if (statusEl) statusEl.textContent = doneMessage;
}

async function handleCsvFile(file) {
const status = document.getElementById('books-csv-status');
if (status) status.textContent = 'Reading…';
try {
const text = await file.text();
const rows = parseBooksCsv(text);
if (!rows.length) { if (status) status.textContent = `No rows found — the header row needs: ${CSV_COLUMNS.join(', ')}.`; return; }
csvRows = rows.map((row) => ({ row, dup: isDuplicateBook(row.title, row.author) }));
if (status) status.textContent = '';
renderCsvReview();
} catch (err) {
if (status) status.textContent = `Couldn't read that file: ${err.message || err}`;
}
}

// ---- Manual add / lookup / edit ------------------------------------------
//
// One dialog for both add and edit: `existingBook` present means edit
// (fields pre-filled, Save updates in place, title/lookup row hidden --
// re-identifying which book this is doesn't make sense once it already
// exists); absent means add (blank fields, the lookup row shown). Every
// field the row itself can show is editable here, including Genres and
// Format, which had a place in the data model but no UI at all until
// now -- a real gap, not a deferred feature.
//
// Two lookup tiers when adding: searchTitle('book', q) is free, keyless
// and instant (Open Library), and gives title/author/year/cover/ISBN --
// but carries no series, series order or reading age at all, which is
// what resolveBookDetails (ai.js, a real web search) fills in. Run
// AUTOMATICALLY once a title (and ideally author) is confirmed -- by
// picking a candidate, or by leaving the title field having typed one
// by hand -- rather than waiting on a manual "look up" click: the next
// step was obvious, so it's taken, the same way runAutoPriceCheck
// (shopping.js) prices a shopping capture without being asked. A button
// stays only as an explicit retry.
function openBookDialog(existingBook) {
const b = existingBook || {};
const dialog = document.createElement('div');
dialog.className = 'mail-view-backdrop';
dialog.innerHTML = `<div class="mail-view-card" style="max-width:440px;">
<div class="mail-view-subject">${existingBook ? 'Edit book' : 'Add a book'}</div>
${existingBook ? '' : `<div class="capture-row" style="margin-bottom:8px;">
<input type="text" autocomplete="off" class="tag-add-input" data-book-search placeholder="Type a title&hellip;" style="flex:1;">
<button class="sync-btn sm book-inline-btn" type="button" data-book-lookup>Look up</button>
</div>
<div data-book-candidates></div>`}
<label style="font-size:12px;display:block;margin-bottom:6px;">Title<input type="text" autocomplete="off" class="tag-add-input" data-book-new="title" value="${escapeHtml(b.title || '')}" style="width:100%;display:block;"></label>
<label style="font-size:12px;display:block;margin-bottom:6px;">Author<input type="text" autocomplete="off" class="tag-add-input" data-book-new="author" value="${escapeHtml(b.author || '')}" style="width:100%;display:block;"></label>
<div class="account-field-row">
<label>Series<input type="text" autocomplete="off" class="tag-add-input" data-book-new="series" value="${escapeHtml(b.series || '')}"></label>
<label>Order<input type="text" autocomplete="off" class="tag-add-input" data-book-new="seriesOrder" value="${escapeHtml(b.seriesOrder || '')}" style="width:60px;"></label>
</div>
<div class="account-field-row">
<label>Min age<input type="text" autocomplete="off" class="tag-add-input" data-book-new="minAge" value="${escapeHtml(b.minAge || '')}" style="width:60px;"></label>
<label>Max age<input type="text" autocomplete="off" class="tag-add-input" data-book-new="maxAge" value="${escapeHtml(b.maxAge || '')}" style="width:60px;"></label>
</div>
<div class="account-field-row">
<label>Genres <span class="settings-note" style="display:inline;margin:0;">(comma separated)</span><input type="text" autocomplete="off" class="tag-add-input" data-book-new="genres" value="${escapeHtml((b.genres || []).join(', '))}"></label>
<label>Format<input type="text" autocomplete="off" class="tag-add-input" data-book-new="format" value="${escapeHtml(b.format || '')}" placeholder="Paperback" style="width:100px;"></label>
</div>
<div class="sync-row" style="margin:0 0 8px;">
<button class="sync-btn sm book-inline-btn" type="button" data-book-fill-ai>&#10024; Look up series &amp; age${existingBook ? '' : ' again'}</button>
<span class="sync-status" data-book-fill-status></span>
</div>
<div style="margin:8px 0;">Who has it?${connectionPickerHtml('book-new-holder', "Nobody yet — it's at your home")}</div>
<label style="font-size:12px;display:block;margin:0 0 8px;">Notes<textarea rows="2" data-book-new="notes" style="width:100%;">${escapeHtml(b.notes || '')}</textarea></label>
<div class="mail-view-actions">
<button class="sync-btn sm" type="button" data-book-new-cancel>Cancel</button>
<button class="add-btn" type="button" data-book-new-save>${existingBook ? 'Save' : 'Add'}</button>
</div>
</div>`;
document.body.appendChild(dialog);
bindConnPickers();
if (b.holderId) setConnPickerValue('book-new-holder', b.holderId);
const close = () => dialog.remove();
dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
dialog.querySelector('[data-book-new-cancel]').addEventListener('click', close);

let picked = { imageUrl: b.imageUrl || '', externalIds: b.externalIds || {}, link: b.link || '' };
// Pre-filled fields on an edit shouldn't trigger an unasked-for
// re-lookup the moment the title field is merely clicked into and out
// of -- only a genuinely NEW title typed while editing should.
let aiFillDone = !!existingBook;
const val = (n) => dialog.querySelector(`[data-book-new="${n}"]`).value.trim();
const setVal = (n, v) => { if (v) dialog.querySelector(`[data-book-new="${n}"]`).value = v; };
const status = dialog.querySelector('[data-book-fill-status]');

const runAiFill = async () => {
const title = val('title');
if (!title || aiFillDone) return;
aiFillDone = true;
status.textContent = 'Looking up series & age…';
try {
const details = await resolveBookDetails(title, val('author'));
setVal('series', details.series); setVal('seriesOrder', details.seriesOrder);
setVal('minAge', details.minAge); setVal('maxAge', details.maxAge);
status.textContent = (details.series || details.minAge) ? 'Filled in — check before saving.' : "Couldn't find series or age details for this one.";
} catch (err) {
status.textContent = err instanceof MissingKeyError ? `Add an Anthropic API key in ${MISSING_KEY_LINK_HTML} first.` : (err.message || String(err));
}
};

const runLookup = async () => {
const q = dialog.querySelector('[data-book-search]').value.trim();
if (!q) return;
const host = dialog.querySelector('[data-book-candidates]');
host.innerHTML = '<div class="settings-note">Looking up&hellip;</div>';
try {
const candidates = await searchTitle('book', q);
if (!candidates.length) { host.innerHTML = '<div class="settings-note">No matches — fill in by hand below.</div>'; setVal('title', q); runAiFill(); return; }
host.innerHTML = candidates.map((c, i) => `<div class="mail-row" data-book-pick="${i}" style="cursor:pointer;">
${c.imageUrl ? `<img class="media-art" src="${escapeHtml(c.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
<span class="mail-subject">${escapeHtml(c.title)}${c.year ? ` (${escapeHtml(c.year)})` : ''}</span>
${c.creator ? `<span class="settings-note" style="margin:0;">${escapeHtml(c.creator)}</span>` : ''}
</div>`).join('');
host.querySelectorAll('[data-book-pick]').forEach((row) => {
row.addEventListener('click', () => {
const c = candidates[Number(row.dataset.bookPick)];
setVal('title', c.title); setVal('author', c.creator);
picked = { imageUrl: c.imageUrl || '', externalIds: c.externalIds || {}, link: c.link || '' };
host.innerHTML = '';
// Title AND author are both known with confidence now -- the
// obvious next step (series/age) is taken immediately rather
// than waiting on a second click.
runAiFill();
});
});
} catch (err) {
host.innerHTML = `<div class="settings-note">${err instanceof MissingKeyError ? `Add an Anthropic API key in ${MISSING_KEY_LINK_HTML} first.` : escapeHtml(err.message || String(err))}</div>`;
}
};
const lookupBtn = dialog.querySelector('[data-book-lookup]');
if (lookupBtn) {
lookupBtn.addEventListener('click', runLookup);
dialog.querySelector('[data-book-search]').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runLookup(); } });
}
// Typed by hand rather than looked up -- the title field losing focus
// is the "I've finished typing this" signal, same idea as the blur-
// driven lookups elsewhere in this app, so the AI fill still runs
// without a dedicated button press.
dialog.querySelector('[data-book-new="title"]').addEventListener('blur', () => runAiFill());

dialog.querySelector('[data-book-fill-ai]').addEventListener('click', () => { aiFillDone = false; runAiFill(); });

dialog.querySelector('[data-book-new-save]').addEventListener('click', () => {
if (!val('title')) return;
const fields = {
title: val('title'), author: val('author'), series: val('series'), seriesOrder: val('seriesOrder'),
minAge: val('minAge'), maxAge: val('maxAge'), notes: val('notes'),
genres: val('genres').split(',').map((s) => s.trim()).filter(Boolean), format: val('format'),
holderId: dialog.querySelector('#book-new-holder')?.value || '',
imageUrl: picked.imageUrl, externalIds: picked.externalIds, link: picked.link,
};
if (existingBook) {
Object.assign(existingBook, fields);
queueSave();
renderBooks();
close();
return;
}
const book = blankBookItem(fields);
data.books.push(book);
queueSave();
renderBooks();
close();
// Typed by hand with no candidate ever picked -- the same gap CSV
// import had until it was caught, so the fix applies here too.
if (!book.imageUrl) enrichMissingCovers([book]);
// A series is now known -- offering to find the rest of it is the
// same "you added one, here's the rest of the range" step shopping's
// AP colour search already offers, not a second thing to remember to
// go looking for.
if (book.series) findRestOfSeries(book.series, book.author);
});
}

// ---- "Find the rest of this series" --------------------------------------
//
// Same shape as shopping.js's "Find other colours": you've added one
// item from a range, this finds what else is in it and lets you pick
// which to add -- except there's no retailer listing to scrape for a
// book series, so ai.js's resolveSeriesBooks asks instead. Age range is
// copied from the book that triggered this rather than looked up again
// per title -- a series is almost always one age band, and that keeps
// this to one API call instead of one per book found.
let seriesFindRows = []; // {title, seriesOrder, dup}
let seriesFindFor = null; // {series, author, minAge, maxAge}

function renderSeriesFind() {
const el = document.getElementById('books-series-find');
if (!el) return;
if (!seriesFindRows.length) { el.innerHTML = ''; return; }
const newCount = seriesFindRows.filter((r) => !r.dup).length;
el.innerHTML = `<div class="album-card" style="margin-bottom:10px;">
<div class="album-caption">Rest of <strong>${escapeHtml(seriesFindFor.series)}</strong>: ${seriesFindRows.length} found, ${newCount} not already on the shelf.</div>
${seriesFindRows.map((r, i) => `<label class="pending-option" style="display:flex;">
<input type="checkbox" data-series-row="${i}" ${r.dup ? 'disabled' : 'checked'}>
<span class="pending-option-info">${r.seriesOrder ? `#${escapeHtml(r.seriesOrder)} ` : ''}${escapeHtml(r.title)}${r.dup ? ' <span class="candidate-tag">already have it</span>' : ''}</span>
</label>`).join('')}
<div class="sync-row" style="margin-top:8px;">
<button class="add-btn" type="button" id="books-series-apply">Add ticked</button>
<button class="sync-btn" type="button" id="books-series-cancel">Not now</button>
</div>
</div>`;
document.getElementById('books-series-apply').addEventListener('click', () => {
let added = 0;
seriesFindRows.forEach((r, i) => {
if (r.dup || !document.querySelector(`[data-series-row="${i}"]`).checked) return;
data.books.push(blankBookItem({
title: r.title, author: seriesFindFor.author, series: seriesFindFor.series, seriesOrder: r.seriesOrder,
minAge: seriesFindFor.minAge, maxAge: seriesFindFor.maxAge,
}));
added++;
});
queueSave();
seriesFindRows = [];
renderSeriesFind();
renderBooks();
});
document.getElementById('books-series-cancel').addEventListener('click', () => { seriesFindRows = []; renderSeriesFind(); });
}

async function findRestOfSeries(series, author) {
const el = document.getElementById('books-series-find');
if (el) el.innerHTML = `<div class="settings-note">Looking up the rest of "${escapeHtml(series)}"…</div>`;
const have = data.books.filter((b) => b.series.trim().toLowerCase() === series.trim().toLowerCase());
const seed = have[0] || {};
try {
const found = await resolveSeriesBooks(series, author);
const haveTitles = new Set(have.map((b) => b.title.trim().toLowerCase()));
seriesFindFor = { series, author, minAge: seed.minAge || '', maxAge: seed.maxAge || '' };
seriesFindRows = found.map((f) => ({ ...f, dup: haveTitles.has(f.title.trim().toLowerCase()) }));
if (!seriesFindRows.length && el) { el.innerHTML = `<div class="settings-note">Couldn't find a reliable list for "${escapeHtml(series)}".</div>`; return; }
renderSeriesFind();
} catch (err) {
if (el) el.innerHTML = `<div class="settings-note">${err instanceof MissingKeyError ? `Add an Anthropic API key in ${MISSING_KEY_LINK_HTML} first.` : escapeHtml(err.message || String(err))}</div>`;
}
}

// ---- Media -> Books flow-in ---------------------------------------------
//
// Same want -> owned carry-across shape shopping.js's offerToRecordOwned
// already uses for AP wants: title/creator/imageUrl/externalIds/link
// cross over, fromMediaId records where it came from, and the Media item
// itself is left alone -- marking it done is a separate, deliberate step.
function addBookFromMediaItem(item) {
const book = blankBookItem({
title: item.title, author: item.creator, imageUrl: item.imageUrl,
externalIds: item.externalIds, link: item.link, fromMediaId: item.id,
});
data.books.push(book);
queueSave();
renderBooks();
// The obvious next step (series/age, and a cover if the Media want
// never had one either) again taken automatically rather than left
// for a second visit to Family.
if (!book.series) enrichMissingDetails([book], null);
if (!book.imageUrl) enrichMissingCovers([book]);
return book;
}

// ---- Table ----------------------------------------------------------------

function starsHtml(book) {
return [1, 2, 3, 4, 5].map((n) => `<svg class="star priority-star ${book.score && n <= book.score ? 'filled' : ''}" data-book-score="${book.id}" data-star="${n}" viewBox="0 0 20 20" fill="currentColor"><path d="M10 1l2.6 5.9 6.4.6-4.8 4.3 1.4 6.2L10 14.9 4.4 18l1.4-6.2L1 7.5l6.4-.6z"/></svg>`).join('');
}

// `subRowHtml`, when given, renders as a second line stacked under the
// title -- used only for a series' representative row (the "Part of X
// series" control). Without it, everything (title plus every field)
// stays one single flex-wrapped line, same as always. Either way the
// cover slot is always reserved at the same width, real image or not --
// confirmed live as a second real alignment bug: a book with no cover
// had its title start flush against the row's left edge, out of step
// with every row that had one.
function bookRowHtml(book, subRowHtml = '') {
const art = book.imageUrl
? `<img class="media-art" src="${escapeHtml(book.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
: '<span class="media-art-placeholder" aria-hidden="true"></span>';
const holder = book.holderId ? data.connections.find((c) => c.id === book.holderId) : null;
const byline = [book.author, book.format].filter(Boolean).join(' · ');
const mainLine = `
<span class="mail-subject">${book.link ? `<a href="${escapeHtml(affiliateLink(book.link))}" target="_blank" rel="noopener">${escapeHtml(book.title)}</a>` : escapeHtml(book.title)}</span>
${byline ? `<span class="settings-note" style="margin:0;">${escapeHtml(byline)}</span>` : ''}
${(book.genres || []).map((g) => `<span class="tag-chip">${escapeHtml(g)}</span>`).join('')}
${(book.minAge || book.maxAge) ? `<span class="settings-note" style="margin:0;">${escapeHtml(book.minAge || '?')}&ndash;${escapeHtml(book.maxAge || '?')} yrs</span>` : ''}
<label style="display:flex;align-items:center;gap:4px;font-size:12px;"><input type="checkbox" data-book-read="${book.id}" ${book.read ? 'checked' : ''}> Read</label>
<span class="book-stars">${starsHtml(book)}</span>
${holder ? connectionChipHtml(holder) : `<span class="settings-note" style="margin:0;">at your home</span>`}
<button type="button" class="sync-btn sm book-inline-btn" data-book-holder="${book.id}">Give&hellip;</button>
<button type="button" class="sync-btn sm book-inline-btn" data-book-edit="${book.id}">Edit</button>
${book.fromMediaId ? `<span class="settings-note book-from-media" data-book-from-media="${escapeHtml(book.fromMediaId)}" style="margin:0;cursor:pointer;">from Media</span>` : ''}
<span class="del-x" data-book-remove="${book.id}" title="Delete this book">&times;</span>`;
if (!subRowHtml) return `<div class="mail-row" data-book-row="${book.id}">${art}${mainLine}</div>`;
return `<div class="mail-row book-row-stacked" data-book-row="${book.id}">
${art}
<div class="book-row-stack">
<div class="book-row-line">${mainLine}</div>
${subRowHtml}
</div>
</div>`;
}

function groupHtml(g) {
// A standalone book is never really a "group" -- bookGroups() keys a
// blank series uniquely per book, so it's always exactly one item.
// Splitting one row into a collapsed summary plus a detail row behind
// a click hid everything (author, age, read/score/holder) for no
// reason -- a plain row shows it all at once, same as a series' own
// detail rows already do, so there's nothing left to collapse.
if (!g.series) return bookRowHtml(g.items[0]);
// The book row itself is ALWAYS the next (or, once finished, first)
// book's own full row, rendered exactly like a standalone row -- same
// left edge, same image, same right-aligned author/age. The series-only
// bits -- which series, its order, how many held, find the rest -- live
// on a second line stacked under the title (bookRowHtml's subRowHtml),
// inside the SAME flex item as the title rather than a block-level
// sibling after the whole row -- confirmed live that the sibling
// version added its own full row of extra height below the cover image
// instead of fitting inside it. The order number lives ONLY in that
// line now ("#1 in X series") -- a separate "#1" chip up on the title
// line duplicated it for a series book and was dead noise (sometimes
// literally "#N/A") on one with no series at all, so it's gone from the
// row itself entirely. Author/age on the row still come off the actual
// book shown, not the series as a label, since those can shift across a
// long run (a co-writer joins,
// the target age climbs).
const rep = g.allRead ? g.items[0] : g.next;
const rest = g.items.filter((b) => b.id !== rep.id);
const open = expandedSeries.has(g.series);
// A real order ("1", "2"...) reads as "#1 in X series"; a CSV import
// that used a literal "N/A" for an unordered entry (Oxford Reading
// Tree's own levels, say) is exactly as uninformative as having none at
// all, so it's treated the same as blank -- "In X series" -- rather
// than printed verbatim as "#N/A".
const hasOrder = rep.seriesOrder && !/^n\/?a$/i.test(rep.seriesOrder.trim());
const seriesLabel = `${hasOrder ? `#${escapeHtml(rep.seriesOrder)} in` : 'In'} <strong>${escapeHtml(g.series)}</strong> series`;
const toggle = rest.length
? `<button type="button" class="book-group-toggle${open ? ' open' : ''}" data-book-group-toggle="${escapeHtml(g.series)}">
<span class="book-group-chevron" aria-hidden="true">&#9656;</span>
<span class="settings-note book-group-label" style="margin:0;">${seriesLabel}</span>
<span class="task-context">${g.items.length} held</span>
</button>`
// Nothing else owned from this series yet -- still worth offering
// "Find the rest", but there's nothing to expand TO, so no chevron
// or click behaviour, just the plain label.
: `<span class="book-group-toggle static">
<span class="settings-note book-group-label" style="margin:0;">${seriesLabel}</span>
<span class="task-context">${g.items.length} held</span>
</span>`;
const subRowHtml = `<div class="book-group-subrow">${toggle}<button type="button" class="sync-btn sm book-inline-btn" data-book-find-rest="${escapeHtml(g.series)}" data-book-find-author="${escapeHtml(g.items[0].author)}">Find the rest&hellip;</button></div>`;
const itemsHtml = (rest.length && open) ? `<div class="book-group-items">${rest.map((b) => bookRowHtml(b)).join('')}</div>` : '';
return `<div class="book-group">${bookRowHtml(rep, subRowHtml)}${itemsHtml}</div>`;
}

async function renderNextToRead() {
const kids = familyKids();
const pickerEl = document.getElementById('books-next-picker');
const nextEl = document.getElementById('books-next-list');
if (!kids.length) {
if (pickerEl) pickerEl.innerHTML = '';
if (nextEl) nextEl.innerHTML = '';
return;
}
if (!nextForChild) nextForChild = kids[0].id;
if (pickerEl) {
pickerEl.innerHTML = kids.map((c) => `<button type="button" class="overview-chip${c.id === nextForChild ? ' active' : ''}" data-books-next-for="${c.id}">${escapeHtml(c.name)}</button>`).join('');
pickerEl.querySelectorAll('[data-books-next-for]').forEach((btn) => {
btn.addEventListener('click', () => { nextForChild = btn.dataset.booksNextFor; renderNextToRead(); });
});
}
if (nextEl) {
const conn = kids.find((c) => c.id === nextForChild);
const age = conn ? currentAge(conn)?.value ?? null : null;
const picks = nextToRead(age);
nextEl.innerHTML = picks.length
? picks.map((b) => `<div class="mail-row">${bookChipHtml(b)}${(b.minAge || b.maxAge) ? `<span class="settings-note" style="margin:0;">${escapeHtml(b.minAge || '?')}&ndash;${escapeHtml(b.maxAge || '?')} yrs</span>` : ''}</div>`).join('')
: '<div class="settings-note">Nothing unread fits that age range right now.</div>';
bindBookChips();
}
}

function booksControlsHtml() {
if (!data.books.length) return '';
const sortChip = (v, label) => `<button type="button" class="overview-chip${sortMode === v ? ' active' : ''}" data-books-sort="${v}">${label}</button>`;
const readChip = (v, label) => `<button type="button" class="overview-chip${readFilter === v ? ' active' : ''}" data-books-read-filter="${v}">${label}</button>`;
return `<div class="overview-chips" style="margin-bottom:8px;">
<span class="settings-note" style="margin:0;">Sort:</span>
${sortChip('series', 'Series')}${sortChip('age', 'Min age')}${sortChip('author', 'Author')}
<span class="settings-note" style="margin:0 0 0 8px;">Show:</span>
${readChip('all', 'All')}${readChip('unread', 'Unread')}${readChip('read', 'Read')}
<button type="button" class="overview-chip${inFlightOnly ? ' active' : ''}" data-books-in-flight="1">In-flight series only</button>
</div>`;
}

function renderBooks() {
const el = document.getElementById('books-list');
if (!el) return;
renderNextToRead();

const controls = document.getElementById('books-controls');
if (controls) {
controls.innerHTML = booksControlsHtml();
controls.querySelectorAll('[data-books-sort]').forEach((b) => b.addEventListener('click', () => { sortMode = b.dataset.booksSort; renderBooks(); }));
controls.querySelectorAll('[data-books-read-filter]').forEach((b) => b.addEventListener('click', () => { readFilter = b.dataset.booksReadFilter; renderBooks(); }));
const inFlightBtn = controls.querySelector('[data-books-in-flight]');
if (inFlightBtn) inFlightBtn.addEventListener('click', () => { inFlightOnly = !inFlightOnly; renderBooks(); });
}

const groups = visibleGroups();
el.innerHTML = groups.length
? groups.map(groupHtml).join('')
: `<div class="empty">${data.books.length ? 'Nothing matches that filter.' : 'Nothing on the shelf yet — upload a CSV or add one by hand above.'}</div>`;
hydratePhotoBackgrounds(el);
bindConnectionChips(el);

// A plain button with its own click handler, not a native <details>/
// <summary> -- deliberately, after an earlier version built on summary
// ran into real trouble twice (preventDefault from a delegated summary
// listener cancelled a nested checkbox's own tick; summary's own box
// model couldn't be relocated to sit inside the cover image's height).
// expandedSeries persists across renders so a tick or an edit elsewhere
// in the row doesn't collapse it back.
el.querySelectorAll('[data-book-group-toggle]').forEach((btn) => {
btn.addEventListener('click', () => {
const key = btn.dataset.bookGroupToggle;
if (expandedSeries.has(key)) expandedSeries.delete(key); else expandedSeries.add(key);
renderBooks();
});
});

el.querySelectorAll('[data-book-read]').forEach((cb) => {
cb.addEventListener('change', () => {
const book = data.books.find((b) => b.id === cb.dataset.bookRead);
if (!book) return;
book.read = cb.checked;
book.readAt = cb.checked ? todayStr() : '';
queueSave();
renderBooks();
});
});
el.querySelectorAll('[data-book-score]').forEach((star) => {
star.addEventListener('click', () => {
const book = data.books.find((b) => b.id === star.dataset.bookScore);
if (!book) return;
book.score = parseInt(star.dataset.star, 10);
queueSave();
renderBooks();
});
});
el.querySelectorAll('[data-book-remove]').forEach((x) => {
x.addEventListener('click', () => {
data.books = data.books.filter((b) => b.id !== x.dataset.bookRemove);
queueSave();
renderBooks();
});
});
el.querySelectorAll('[data-book-holder]').forEach((btn) => {
btn.addEventListener('click', () => openHolderDialog(btn.dataset.bookHolder));
});
el.querySelectorAll('[data-book-edit]').forEach((btn) => {
btn.addEventListener('click', () => {
const book = data.books.find((b) => b.id === btn.dataset.bookEdit);
if (book) openBookDialog(book);
});
});
el.querySelectorAll('[data-book-find-rest]').forEach((btn) => {
btn.addEventListener('click', () => findRestOfSeries(btn.dataset.bookFindRest, btn.dataset.bookFindAuthor));
});
// The record-reference rule applies to a field that names ANOTHER
// record too, not just a row in a list -- fromMediaId is exactly that,
// so it leads back to the real Media want rather than sitting as inert
// text. Dynamic import: media.js already reaches back into this file
// for the reverse direction (addBookFromMediaItem), and a static
// import each way would be a real circular dependency.
el.querySelectorAll('[data-book-from-media]').forEach((span) => {
span.addEventListener('click', async () => {
const [{ switchTab }, media] = await Promise.all([import('../tabs.js'), import('./media.js')]);
switchTab('media');
media.revealMediaItem(span.dataset.bookFromMedia);
});
});
}

function openHolderDialog(bookId) {
const book = data.books.find((b) => b.id === bookId);
if (!book) return;
const dialog = document.createElement('div');
dialog.className = 'mail-view-backdrop';
dialog.innerHTML = `<div class="mail-view-card" style="max-width:360px;">
<div class="mail-view-subject">Who has "${escapeHtml(book.title)}"?</div>
<div style="margin:8px 0;">${connectionPickerHtml('book-holder-pick', "Nobody — it's at your home")}</div>
<div class="mail-view-actions">
<button class="sync-btn sm" type="button" data-holder-cancel>Cancel</button>
<button class="add-btn" type="button" data-holder-save>Save</button>
</div>
</div>`;
document.body.appendChild(dialog);
bindConnPickers();
if (book.holderId) setConnPickerValue('book-holder-pick', book.holderId);
const close = () => dialog.remove();
dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
dialog.querySelector('[data-holder-cancel]').addEventListener('click', close);
dialog.querySelector('[data-holder-save]').addEventListener('click', () => {
book.holderId = document.getElementById('book-holder-pick')?.value || '';
queueSave();
renderBooks();
close();
});
}

function initBooks() {
bindBookChips();
const addBtn = document.getElementById('books-add-btn');
if (addBtn) addBtn.addEventListener('click', () => openBookDialog());
// A one-time catch-up for books already on the shelf before covers were
// ever fetched for CSV rows -- the gap enrichMissingCovers above now
// closes for anything added from here on, but doesn't reach back to fix
// what's already there without being asked.
const coversBtn = document.getElementById('books-find-covers-btn');
if (coversBtn) coversBtn.addEventListener('click', async () => {
coversBtn.disabled = true;
const status = document.getElementById('books-csv-status');
const missing = data.books.filter((b) => !b.imageUrl || !b.link);
if (status) status.textContent = `Looking up covers & links for ${missing.length} book${missing.length === 1 ? '' : 's'}…`;
await enrichMissingCovers(missing);
if (status) status.textContent = `Done — ${missing.filter((b) => data.books.find((x) => x.id === b.id)?.imageUrl).length} of ${missing.length} found a cover.`;
coversBtn.disabled = false;
});
const fileInput = document.getElementById('books-csv-input');
if (fileInput) fileInput.addEventListener('change', (e) => {
const file = e.target.files[0];
if (file) handleCsvFile(file);
e.target.value = '';
});
renderBooks();
}

export { initBooks, renderBooks, bookChipHtml, bindBookChips, revealBookItem, addBookFromMediaItem };
