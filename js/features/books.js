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

// One entry per distinct `series` value; a blank series is its own
// group of one, same as a standalone book really is one.
function bookGroups() {
const groups = new Map();
data.books.forEach((b) => {
const key = b.series.trim() || `__standalone__${b.id}`;
if (!groups.has(key)) groups.set(key, { series: b.series.trim(), items: [] });
groups.get(key).items.push(b);
});
return [...groups.values()].map((g) => {
const items = [...g.items].sort((a, b) => orderNum(a) - orderNum(b) || a.title.localeCompare(b.title));
const next = items.find((b) => !b.read);
return { ...g, items, next, allRead: !next };
}).sort((a, b) => (a.series || a.items[0].title).localeCompare(b.series || b.items[0].title));
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
renderBooks();
setTimeout(() => {
const row = document.querySelector(`[data-book-row="${id}"]`);
const details = row?.closest('details');
if (details) details.open = true;
scrollAndFlash(`[data-book-row="${id}"]`);
}, 60);
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
});
document.getElementById('books-csv-cancel').addEventListener('click', () => { csvRows = []; renderCsvReview(); });
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

// ---- Manual add / lookup ------------------------------------------------
//
// Two tiers: searchTitle('book', q) is free, keyless and instant (Open
// Library), and gives title/author/year/cover/ISBN -- but carries no
// series, series order or reading age at all, which is what
// resolveBookDetails (ai.js, a real web search) fills in. Run
// AUTOMATICALLY once a title (and ideally author) is confirmed -- by
// picking a candidate, or by leaving the title field having typed one
// by hand -- rather than waiting on a manual "look up" click: the next
// step was obvious, so it's taken, the same way runAutoPriceCheck
// (shopping.js) prices a shopping capture without being asked. A button
// stays only as an explicit retry.
function openAddBookDialog() {
const dialog = document.createElement('div');
dialog.className = 'mail-view-backdrop';
dialog.innerHTML = `<div class="mail-view-card" style="max-width:440px;">
<div class="mail-view-subject">Add a book</div>
<div class="capture-row" style="margin-bottom:8px;">
<input type="text" autocomplete="off" class="tag-add-input" data-book-search placeholder="Type a title&hellip;" style="flex:1;">
<button class="sync-btn sm" type="button" data-book-lookup>Look up</button>
</div>
<div data-book-candidates></div>
<label style="font-size:12px;display:block;margin-bottom:6px;">Title<input type="text" autocomplete="off" class="tag-add-input" data-book-new="title" style="width:100%;display:block;"></label>
<label style="font-size:12px;display:block;margin-bottom:6px;">Author<input type="text" autocomplete="off" class="tag-add-input" data-book-new="author" style="width:100%;display:block;"></label>
<div class="account-field-row">
<label>Series<input type="text" autocomplete="off" class="tag-add-input" data-book-new="series"></label>
<label>Order<input type="text" autocomplete="off" class="tag-add-input" data-book-new="seriesOrder" style="width:60px;"></label>
</div>
<div class="account-field-row">
<label>Min age<input type="text" autocomplete="off" class="tag-add-input" data-book-new="minAge" style="width:60px;"></label>
<label>Max age<input type="text" autocomplete="off" class="tag-add-input" data-book-new="maxAge" style="width:60px;"></label>
</div>
<div class="sync-row" style="margin:0 0 8px;">
<button class="sync-btn sm" type="button" data-book-fill-ai>&#10024; Look up series &amp; age again</button>
<span class="sync-status" data-book-fill-status></span>
</div>
<div style="margin:8px 0;">Who has it?${connectionPickerHtml('book-new-holder', "Nobody yet — it's at your home")}</div>
<label style="font-size:12px;display:block;margin:0 0 8px;">Notes<textarea rows="2" data-book-new="notes" style="width:100%;"></textarea></label>
<div class="mail-view-actions">
<button class="sync-btn sm" type="button" data-book-new-cancel>Cancel</button>
<button class="add-btn" type="button" data-book-new-save>Add</button>
</div>
</div>`;
document.body.appendChild(dialog);
bindConnPickers();
const close = () => dialog.remove();
dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
dialog.querySelector('[data-book-new-cancel]').addEventListener('click', close);

let picked = { imageUrl: '', externalIds: {}, link: '' };
let aiFillDone = false; // so leaving/re-entering the title field doesn't re-fire once an answer's already in
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
dialog.querySelector('[data-book-lookup]').addEventListener('click', runLookup);
dialog.querySelector('[data-book-search]').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runLookup(); } });
// Typed by hand rather than looked up -- the title field losing focus
// is the "I've finished typing this" signal, same idea as the blur-
// driven lookups elsewhere in this app, so the AI fill still runs
// without a dedicated button press.
dialog.querySelector('[data-book-new="title"]').addEventListener('blur', () => runAiFill());

dialog.querySelector('[data-book-fill-ai]').addEventListener('click', () => { aiFillDone = false; runAiFill(); });

dialog.querySelector('[data-book-new-save]').addEventListener('click', () => {
if (!val('title')) return;
const book = blankBookItem({
title: val('title'), author: val('author'), series: val('series'), seriesOrder: val('seriesOrder'),
minAge: val('minAge'), maxAge: val('maxAge'), notes: val('notes'),
holderId: dialog.querySelector('#book-new-holder')?.value || '',
imageUrl: picked.imageUrl, externalIds: picked.externalIds, link: picked.link,
});
data.books.push(book);
queueSave();
renderBooks();
close();
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
// The obvious next step (series/age) again taken automatically rather
// than left for a second visit to Family.
if (!book.series) enrichMissingDetails([book], null);
return book;
}

// ---- Table ----------------------------------------------------------------

function starsHtml(book) {
return [1, 2, 3, 4, 5].map((n) => `<svg class="star priority-star ${book.score && n <= book.score ? 'filled' : ''}" data-book-score="${book.id}" data-star="${n}" viewBox="0 0 20 20" fill="currentColor"><path d="M10 1l2.6 5.9 6.4.6-4.8 4.3 1.4 6.2L10 14.9 4.4 18l1.4-6.2L1 7.5l6.4-.6z"/></svg>`).join('');
}

function bookRowHtml(book) {
const art = book.imageUrl
? `<img class="media-art" src="${escapeHtml(book.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
: '';
const holder = book.holderId ? data.connections.find((c) => c.id === book.holderId) : null;
return `<div class="mail-row" data-book-row="${book.id}">
${art}
<span class="mail-subject">${book.link ? `<a href="${escapeHtml(affiliateLink(book.link))}" target="_blank" rel="noopener">${escapeHtml(book.title)}</a>` : escapeHtml(book.title)}</span>
${book.seriesOrder ? `<span class="task-context">#${escapeHtml(book.seriesOrder)}</span>` : ''}
${(book.minAge || book.maxAge) ? `<span class="settings-note" style="margin:0;">${escapeHtml(book.minAge || '?')}&ndash;${escapeHtml(book.maxAge || '?')} yrs</span>` : ''}
<label style="display:flex;align-items:center;gap:4px;font-size:12px;"><input type="checkbox" data-book-read="${book.id}" ${book.read ? 'checked' : ''}> Read</label>
<span class="book-stars">${starsHtml(book)}</span>
${holder ? connectionChipHtml(holder) : `<span class="settings-note" style="margin:0;">at your home</span>`}
<button type="button" class="sync-btn sm" data-book-holder="${book.id}">Give&hellip;</button>
${book.fromMediaId ? `<span class="settings-note book-from-media" data-book-from-media="${escapeHtml(book.fromMediaId)}" style="margin:0;cursor:pointer;">from Media</span>` : ''}
<span class="del-x" data-book-remove="${book.id}" title="Delete this book">&times;</span>
</div>`;
}

function groupHtml(g) {
const nextLabel = g.allRead ? 'All read' : g.next.title;
return `<details class="book-group">
<summary class="book-group-summary">
${g.series ? `<span class="mail-subject">${escapeHtml(g.series)}</span><span class="settings-note" style="margin:0;">next: ${escapeHtml(nextLabel)}</span>` : `<span class="mail-subject">${escapeHtml(g.items[0].title)}</span>`}
<span class="task-context">${g.items.length} held</span>
${g.series ? `<button type="button" class="sync-btn sm" data-book-find-rest="${escapeHtml(g.series)}" data-book-find-author="${escapeHtml(g.items[0].author)}">Find the rest&hellip;</button>` : ''}
</summary>
<div class="book-group-items">${g.items.map(bookRowHtml).join('')}</div>
</details>`;
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

function renderBooks() {
const el = document.getElementById('books-list');
if (!el) return;
renderNextToRead();

const groups = bookGroups();
el.innerHTML = groups.length ? groups.map(groupHtml).join('') : '<div class="empty">Nothing on the shelf yet — upload a CSV or add one by hand above.</div>';
hydratePhotoBackgrounds(el);
bindConnectionChips(el);

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
el.querySelectorAll('[data-book-find-rest]').forEach((btn) => {
btn.addEventListener('click', (e) => {
e.preventDefault(); // this sits inside a <summary> -- without this the click also toggles the <details> open/closed
findRestOfSeries(btn.dataset.bookFindRest, btn.dataset.bookFindAuthor);
});
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
if (addBtn) addBtn.addEventListener('click', () => openAddBookDialog());
const fileInput = document.getElementById('books-csv-input');
if (fileInput) fileInput.addEventListener('change', (e) => {
const file = e.target.files[0];
if (file) handleCsvFile(file);
e.target.value = '';
});
renderBooks();
}

export { initBooks, renderBooks, bookChipHtml, bindBookChips, revealBookItem, addBookFromMediaItem };
