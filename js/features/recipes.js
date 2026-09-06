// Menu tab: recipes imported from a photo, a PDF, or a web page, rated on
// the same configurable-star mechanism as Connections (a distinct category
// list — Taste/Health/Prep by default — not the same list, just the same
// idea), with an occasional nudge to actually cook one of them.
import { data, queueSave, DEFAULT_RECIPE_RATING_CATEGORIES, slugifyField, averageRating, getLocalSettings, setLocalSetting } from '../state.js';
import { photoDelete, photoGet, photoUrl } from '../db.js';
import { escapeHtml, uid, todayStr, resizeImageToBlob, openLightbox } from '../utils.js';
import { MissingKeyError, extractRecipeFromImage, extractRecipeFromPdf, extractRecipeFromHtml } from '../ai.js';
import { storePhoto, uploadAttachment, deleteAttachment, openAttachment, formatBytes } from '../files.js';
import { getConfig } from '../sync/selfhost.js';

// ---- web import: structured data first, AI as a fallback ----
//
// Most recipe sites embed a schema.org Recipe as JSON-LD specifically for
// search-engine rich snippets — which makes it present in the raw
// server-rendered HTML even on otherwise JS-heavy sites, since it's there
// for SEO, not for the page's own rendering. Reading it directly is free
// and more reliable than asking a model to parse arbitrary page markup, so
// it's tried first; the AI path only runs when no such data is found.
function extractJsonLdRecipe(html) {
const scripts = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
for (const m of scripts) {
let parsed;
try { parsed = JSON.parse(m[1]); } catch (e) { continue; }
const nodes = Array.isArray(parsed) ? parsed : (parsed['@graph'] || [parsed]);
for (const node of nodes) {
if (!node || typeof node !== 'object') continue;
const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
if (!types.includes('Recipe')) continue;
const ingredients = Array.isArray(node.recipeIngredient) ? node.recipeIngredient.map(String) : [];
let instructions = [];
if (Array.isArray(node.recipeInstructions)) {
instructions = node.recipeInstructions.map((step) => {
if (typeof step === 'string') return step;
if (step && typeof step === 'object') return step.text || step.name || '';
return '';
}).filter(Boolean);
} else if (typeof node.recipeInstructions === 'string') {
instructions = node.recipeInstructions.split(/\n+/).map((s) => s.trim()).filter(Boolean);
}
if (ingredients.length === 0 && instructions.length === 0) continue;
return { name: String(node.name || ''), ingredients, instructions, notes: '' };
}
}
return null;
}

async function recipeFetchEndpoint() {
const { url, secret, configured } = await getConfig();
if (!configured) throw new Error('Live sync needs to be set up first (Settings) before importing from a web page.');
const endpoint = url.replace(/sync\.php(?=$|\?)/, 'recipe-fetch.php');
if (endpoint === url) throw new Error(`Couldn't work out the recipe-fetch URL from "${url}" — it should end in sync.php.`);
return { endpoint, secret };
}

async function fetchRecipeHtml(pageUrl) {
const { endpoint, secret } = await recipeFetchEndpoint();
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 20000);
let res;
try {
res = await fetch(`${endpoint}?url=${encodeURIComponent(pageUrl)}`, { headers: { 'X-Sync-Secret': secret }, signal: controller.signal });
} catch (err) {
if (err.name === 'AbortError') throw new Error('The recipe site took too long to respond.');
throw new Error(`Couldn't reach the recipe-fetch server: ${err.message}`);
} finally {
clearTimeout(timer);
}
if (!res.ok) {
let detail = `HTTP ${res.status}`;
try { detail = (await res.json()).error || detail; } catch (e) { /* not JSON */ }
throw new Error(detail);
}
return res.text();
}

async function importFromUrl(pageUrl) {
const html = await fetchRecipeHtml(pageUrl);
const structured = extractJsonLdRecipe(html);
if (structured) return { ...structured, sourceKind: 'web structured data' };
const ai = await extractRecipeFromHtml(html, pageUrl);
return { ...ai, sourceKind: 'web (AI-read)' };
}

// ---- capture + review ----

// {name, ingredients, instructions, notes, sourceKind, sourceUrl, sourceFile}
// -- sourceFile (the raw File, photo/PDF imports only) is held here in
// memory just long enough to upload once Save is actually clicked; nothing
// is stored until the user confirms the extracted text, same as the text
// fields themselves are only committed on save.
let pending = null;

function renderReview() {
const el = document.getElementById('recipe-review');
if (!el) return;
if (!pending) { el.innerHTML = ''; return; }
el.innerHTML = `<div class="settings-block" style="margin-top:10px;">
<div class="settings-note" style="margin:0 0 8px;">Read from ${escapeHtml(pending.sourceKind)} — check it over, then save.</div>
<label class="full">Name<input type="text" autocomplete="off" id="recipe-review-name" value="${escapeHtml(pending.name)}"></label>
<label class="full">Ingredients (one per line)<textarea rows="6" id="recipe-review-ingredients">${escapeHtml(pending.ingredients.join('\n'))}</textarea></label>
<label class="full">Instructions (one step per line)<textarea rows="8" id="recipe-review-instructions">${escapeHtml(pending.instructions.join('\n'))}</textarea></label>
<label class="full">Notes<textarea rows="2" id="recipe-review-notes">${escapeHtml(pending.notes || '')}</textarea></label>
<div class="sync-row" style="margin-top:8px;">
<button class="add-btn" type="button" id="recipe-review-save">Save recipe</button>
<button class="sync-btn" type="button" id="recipe-review-discard">Discard</button>
</div>
</div>`;
document.getElementById('recipe-review-save').addEventListener('click', saveReview);
document.getElementById('recipe-review-discard').addEventListener('click', () => { pending = null; renderReview(); });
}

async function saveReview() {
const name = document.getElementById('recipe-review-name').value.trim();
if (!name) return;
const saveBtn = document.getElementById('recipe-review-save');
saveBtn.disabled = true;
// The original the recipe was read FROM -- kept alongside the extracted
// text, not instead of it, so a garbled ingredient can be checked
// against the real thing later. A web import already had its own url
// (pending.sourceUrl); a photo/PDF import only had the file transiently,
// for the AI read -- storePhoto/uploadAttachment are the same paths a
// recipe's own dish photos and a task's attachments already go through.
const source = { kind: pending.sourceKind, url: pending.sourceUrl || '', photoId: '', attachment: null };
if (pending.sourceFile && pending.sourceKind === 'a photo') {
setStatus('Saving the original photo…');
try { source.photoId = await storePhoto(pending.sourceFile); } catch (err) { console.error('Keeping the source photo failed:', err); }
} else if (pending.sourceFile && pending.sourceKind === 'a PDF') {
setStatus('Saving the original PDF…');
try { source.attachment = await uploadAttachment(pending.sourceFile); } catch (err) { console.error("Keeping the source PDF failed:", err); }
}
const recipe = {
id: uid(), name,
ingredients: document.getElementById('recipe-review-ingredients').value.split('\n').map((s) => s.trim()).filter(Boolean),
instructions: document.getElementById('recipe-review-instructions').value.split('\n').map((s) => s.trim()).filter(Boolean),
notes: document.getElementById('recipe-review-notes').value.trim(),
source,
photoId: null, photoIds: [], photoAlbums: [], ratings: {}, tags: [],
createdAt: new Date().toISOString(), lastMade: '',
};
data.recipes.push(recipe);
pending = null;
renderReview();
renderRecipes();
renderRecipeOverview();
queueSave();
setStatus('');
}

function setStatus(msg) {
const el = document.getElementById('recipe-import-status');
if (el) el.textContent = msg;
}

function initCapture() {
const photoInput = document.getElementById('recipe-photo-input');
const pdfInput = document.getElementById('recipe-pdf-input');
const urlInput = document.getElementById('recipe-url-input');
const urlBtn = document.getElementById('recipe-url-btn');
const manualBtn = document.getElementById('recipe-manual-btn');
if (!photoInput) return;

photoInput.addEventListener('change', async (e) => {
const file = e.target.files[0];
e.target.value = '';
if (!file) return;
setStatus('Reading the photo…');
try {
const extract = await extractRecipeFromImage(file);
pending = { ...extract, sourceKind: 'a photo', sourceFile: file };
renderReview();
setStatus('');
} catch (err) {
setStatus(err instanceof MissingKeyError ? 'Add an Anthropic API key in Settings first.' : `Couldn't read that: ${err.message || err}`);
}
});

pdfInput.addEventListener('change', async (e) => {
const file = e.target.files[0];
e.target.value = '';
if (!file) return;
setStatus('Reading the PDF…');
try {
const extract = await extractRecipeFromPdf(file);
pending = { ...extract, sourceKind: 'a PDF', sourceFile: file };
renderReview();
setStatus('');
} catch (err) {
setStatus(err instanceof MissingKeyError ? 'Add an Anthropic API key in Settings first.' : `Couldn't read that: ${err.message || err}`);
}
});

urlBtn.addEventListener('click', async () => {
const url = urlInput.value.trim();
if (!url) return;
setStatus('Fetching the page…');
try {
const extract = await importFromUrl(url);
pending = { ...extract, sourceUrl: url };
renderReview();
setStatus('');
urlInput.value = '';
} catch (err) {
setStatus(err instanceof MissingKeyError ? 'Add an Anthropic API key in Settings first.' : `Couldn't import that: ${err.message || err}`);
}
});

// No file, no URL -- a recipe typed (or pasted) straight in, e.g. a
// family recipe with no real "source" at all. Reuses the exact same
// review form every other capture path lands on rather than a separate
// blank-entry UI, since that form is already a plain editable draft.
manualBtn.addEventListener('click', () => {
pending = { name: '', ingredients: [], instructions: [], notes: '', sourceKind: 'typed in manually' };
renderReview();
});
}

// ---- rating stars (own render + handler, same look as Connections' but
// deliberately not sharing code — a different entity, a different category
// list, bound to its own container so there's no risk of the two colliding) ----

function recipeRatingStars(label, field, recipeId, value) {
const stars = [1, 2, 3, 4, 5].map((n) => `<svg class="star rate-star ${n <= value ? 'filled' : ''}" data-recipe-rate="${recipeId}" data-recipe-rate-cat="${field}" data-recipe-rate-star="${n}" viewBox="0 0 20 20" fill="currentColor"><path d="M10 1l2.6 5.9 6.4.6-4.8 4.3 1.4 6.2L10 14.9 4.4 18l1.4-6.2L1 7.5l6.4-.6z"/></svg>`).join('');
return `<div class="rating-row"><span class="rating-label">${escapeHtml(label)}</span><div class="stars">${stars}</div></div>`;
}

// ---- list + cook mode ----

let expandedRecipe = null; // id, or null
let cookingRecipe = null; // id, or null
let activeTagFilter = null; // a tag string, or null for "All"
// 'made' | 'notmade' | null -- derived from lastMade rather than a stored
// field of its own (same reasoning Connections Overview's own "Photos"/
// "Contact match" dimensions are computed, not stored): it can never drift
// out of sync with the one real fact (when a recipe was last made), and a
// recipe already has nothing that actually means "not made yet" beyond an
// empty lastMade.
let activeMadeFilter = null;
let recipeOverviewCollapsed = true;

// A handful of common categories to suggest right away (a course, a main
// ingredient, a cooking style, an occasion, a dietary status...) --
// ordinary starting points, not a fixed enum or fixed groups; typing
// anything else just adds it as its own new tag, same as any of these.
// The dietary ones (Gluten/Dairy/FODMAP) read as three-way choices per
// recipe (a dish is Gluten OR Gluten-free OR Gluten-subs, not several at
// once) but nothing here actually enforces that -- tags stay the same
// open, multi-value, no-exclusivity shape as everything else (Meat +
// Curry + Christmas all on one recipe is exactly the point), so getting
// a dietary tag right or wrong is on whoever tags the recipe, same as
// any other tag. Recipes already reuses this open-ended tag shape
// rather than a fixed category picker, same as Connections' own City/
// Interests tags.
const SUGGESTED_RECIPE_TAGS = [
'Meat', 'Fish', 'One-pot', 'Curry', 'Fruit', 'Christmas',
'Starter', 'Main', 'Dessert', 'Snack', 'Drink',
'Gluten-free', 'Gluten', 'Gluten-subs',
'Low-FODMAP', 'Reduced-FODMAP', 'High-FODMAP',
'Dairy-free', 'Dairy', 'Dairy-subs',
];

async function initRecipeOverviewPrefs() {
const settings = await getLocalSettings();
recipeOverviewCollapsed = settings.recipeOverviewPanelCollapsed !== false;
}

// Mirrors Connections Overview's own shape (collapsible panel, clickable
// chips that filter the list below) but deliberately without its full
// drill-down/faceting machinery -- two small dimensions here (Made, Tags)
// don't need a general per-dimension-collapse, bulk-assign, multi-facet
// system built for Connections' much larger, richer set of dimensions.
function renderRecipeOverview() {
const el = document.getElementById('recipe-overview-content');
if (!el) return;
const toggleHtml = `<button class="overview-panel-toggle" type="button" id="recipe-overview-toggle">${recipeOverviewCollapsed ? '▸ Show recipes overview' : '▾ Hide recipes overview'}</button>`;
if (recipeOverviewCollapsed) {
el.innerHTML = toggleHtml;
document.getElementById('recipe-overview-toggle').addEventListener('click', () => {
recipeOverviewCollapsed = false;
setLocalSetting('recipeOverviewPanelCollapsed', false);
renderRecipeOverview();
});
return;
}
const madeCount = data.recipes.filter((r) => r.lastMade).length;
const notMadeCount = data.recipes.length - madeCount;
const madeChips = [
{ key: 'made', label: 'Made', count: madeCount },
{ key: 'notmade', label: 'Not made yet', count: notMadeCount },
].filter((c) => c.count).map((c) => `<button class="overview-chip${activeMadeFilter === c.key ? ' active' : ''}" type="button" data-recipe-overview-made="${c.key}">${escapeHtml(c.label)} (${c.count})</button>`).join('');

const tagCounts = {};
data.recipes.forEach((r) => (r.tags || []).forEach((t) => { tagCounts[t] = (tagCounts[t] || 0) + 1; }));
const tagKeys = Object.keys(tagCounts).sort((a, b) => tagCounts[b] - tagCounts[a] || a.localeCompare(b));
const tagChips = tagKeys.map((t) => `<button class="overview-chip${activeTagFilter === t ? ' active' : ''}" type="button" data-recipe-overview-tag="${escapeHtml(t)}">${escapeHtml(t)} (${tagCounts[t]})</button>`).join('');

el.innerHTML = `${toggleHtml}
${madeChips ? `<div class="overview-group"><span class="field-label">Made</span><div class="overview-chips">${madeChips}</div></div>` : ''}
${tagChips ? `<div class="overview-group"><span class="field-label">Tags</span><div class="overview-chips">${tagChips}</div></div>` : ''}
${!madeChips && !tagChips ? '<div class="settings-note" style="margin-top:8px;">Add a few recipes (and some tags) to see them grouped here.</div>' : ''}`;

document.getElementById('recipe-overview-toggle').addEventListener('click', () => {
recipeOverviewCollapsed = true;
setLocalSetting('recipeOverviewPanelCollapsed', true);
renderRecipeOverview();
});
el.querySelectorAll('[data-recipe-overview-made]').forEach((btn) => {
btn.addEventListener('click', () => {
const key = btn.dataset.recipeOverviewMade;
activeMadeFilter = activeMadeFilter === key ? null : key;
renderRecipeOverview();
renderRecipes();
});
});
el.querySelectorAll('[data-recipe-overview-tag]').forEach((btn) => {
btn.addEventListener('click', () => {
const key = btn.dataset.recipeOverviewTag;
activeTagFilter = activeTagFilter === key ? null : key;
renderRecipeOverview();
renderRecipes();
});
});
}

function recipeCardHtml(r) {
const avg = averageRating(r, data.recipeRatingCategories);
const open = expandedRecipe === r.id;
return `<div class="recipe-card">
<div class="recipe-row">
${r.photoId ? `<span class="thumb-img" data-photo-bg="${escapeHtml(r.photoId)}"></span>` : '<span class="thumb-img recipe-noimg"></span>'}
<div class="recipe-id">
<span class="recipe-name" data-recipe-expand="${r.id}">${escapeHtml(r.name)}</span>
${avg ? `<span class="rating-average">avg ${avg.value.toFixed(1)} (${avg.count} rated)</span>` : ''}
${r.lastMade ? `<span class="recipe-lastmade">made ${escapeHtml(new Date(r.lastMade).toLocaleDateString('en-GB'))}</span>` : '<span class="recipe-lastmade">never made</span>'}
</div>
<button class="add-btn" type="button" data-recipe-cook="${r.id}">Cook</button>
</div>
${open ? recipeDetailHtml(r) : ''}
</div>`;
}

// The actual photo/PDF/page the recipe was read FROM, kept alongside the
// extracted text (see saveReview) so a garbled ingredient can be checked
// against the original later -- distinct from r.photoIds (the Photo
// section above, photos OF the finished dish). Nothing to show for a
// manually typed-in recipe, which has none of the three.
function recipeSourceHtml(r) {
const source = r.source || {};
if (!source.url && !source.photoId && !source.attachment) return '';
const parts = [];
if (source.url) parts.push(`<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener" style="font-size:12px;color:var(--rose);">Open original page &#8599;</a>`);
if (source.photoId) parts.push(`<span class="thumb-img" data-view-photo="${escapeHtml(source.photoId)}" data-photo-bg="${escapeHtml(source.photoId)}" style="width:52px;height:52px;border-radius:8px;cursor:pointer;flex:0 0 auto;"></span>`);
if (source.attachment) parts.push(`<span class="inline-goto-link" data-recipe-source-pdf="${r.id}">Open original PDF (${escapeHtml(formatBytes(source.attachment.size))})</span>`);
return `<div class="field-block full">
<span class="field-label">Original source${source.kind ? ` — from ${escapeHtml(source.kind)}` : ''}</span>
<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">${parts.join('')}</div>
</div>`;
}

// Same shape as connections.js's own tagChips (chips + a datalist-backed
// add input + button) -- not the same function, since it's tied to a
// connId and connections.js's own field-based binding, but the identical
// visual/interaction pattern rather than a new one invented for recipes.
function recipeTagsHtml(r) {
const known = new Set([...SUGGESTED_RECIPE_TAGS, ...data.recipes.flatMap((x) => x.tags || [])]);
const chips = (r.tags || []).map((t, i) => `<span class="tag-chip">${escapeHtml(t)}<span class="tag-x" data-recipe-tag-remove="${r.id}" data-tag-idx="${i}">&times;</span></span>`).join('');
const options = [...known].sort((a, b) => a.localeCompare(b)).map((t) => `<option value="${escapeHtml(t)}"></option>`).join('');
return `<div class="field-block full">
<span class="field-label">Tags</span>
<div class="tag-editor">
${chips}
<input type="text" autocomplete="off" class="tag-add-input" placeholder="+ add (e.g. Curry, Christmas)" list="recipe-taglist-${r.id}" data-recipe-tag-add="${r.id}">
<button type="button" class="todo-add-btn" data-recipe-tag-add-btn="${r.id}" style="padding:3px 8px;">+</button>
</div>
<datalist id="recipe-taglist-${r.id}">${options}</datalist>
</div>`;
}

function recipeDetailHtml(r) {
// Photo comes right after Name now, not buried below Ratings -- it's a
// direct upload (resizeImageToBlob + storePhoto, same as a task's own
// photo gallery), completely independent of the Google Photos album
// link further down. A .field-block, not a <label>, since it wraps a
// row of thumbnails and an add tile rather than one control -- a
// <label> here would forward its click to the first thing inside it
// (same reasoning connections.js's own Photos row already documents).
return `<div class="recipe-detail details-grid">
<label class="full">Name<input type="text" autocomplete="off" data-recipe-field="name" data-recipe-id="${r.id}" value="${escapeHtml(r.name)}"></label>
<div class="field-block full">
<span class="field-label">Photo</span>
<div class="task-photos">
${r.photoIds.map((id, i) => `<div class="gallery-thumb"><span class="thumb-img" data-photo-bg="${escapeHtml(id)}"></span><span class="tag-x" data-recipe-photo-remove="${r.id}" data-photo-idx="${i}">&times;</span></div>`).join('')}
<label class="gallery-add" for="recipe-photo-add-${r.id}">+</label>
<input type="file" id="recipe-photo-add-${r.id}" accept="image/*" multiple style="display:none;" data-recipe-photo-add="${r.id}">
</div>
</div>
${recipeTagsHtml(r)}
<label class="full">Ingredients (one per line)<textarea rows="6" data-recipe-field="ingredients" data-recipe-id="${r.id}">${escapeHtml(r.ingredients.join('\n'))}</textarea></label>
<label class="full">Instructions (one step per line)<textarea rows="8" data-recipe-field="instructions" data-recipe-id="${r.id}">${escapeHtml(r.instructions.join('\n'))}</textarea></label>
<label class="full">Notes<textarea rows="2" data-recipe-field="notes" data-recipe-id="${r.id}">${escapeHtml(r.notes || '')}</textarea></label>
<label class="full">Google Photos album <span class="settings-note">Optional — for a bigger set (the occasion it was made for, several attempts...), not needed just for a quick single photo above</span>
<input type="text" autocomplete="off" placeholder="https://photos.google.com/album/…" data-recipe-album="${r.id}" value="${escapeHtml((r.photoAlbums[0] || {}).url || '')}"></label>
${(r.photoAlbums[0] || {}).url ? `<div class="full"><a href="${escapeHtml(r.photoAlbums[0].url)}" target="_blank" rel="noopener" style="font-size:12px;color:var(--rose);">Open album &#8599;</a></div>` : ''}
${recipeSourceHtml(r)}
<div class="field-block full">
<span class="field-label">Ratings</span>
<div class="ratings-block">${data.recipeRatingCategories.map(({ field, label }) => recipeRatingStars(label, field, r.id, (r.ratings && r.ratings[field]) || 0)).join('')}</div>
</div>
<div class="sync-row full" style="margin-top:8px;">
<button class="sync-btn" type="button" data-recipe-made="${r.id}">Mark made today</button>
<span class="del-x" data-recipe-del="${r.id}" title="Delete recipe">&times; Delete</span>
</div>
</div>`;
}

function ingredientsHtml(r) {
return r.ingredients.map((i) => `<li>${escapeHtml(i)}</li>`).join('') || '<li class="empty">No ingredients recorded.</li>';
}
function instructionsHtml(r) {
return r.instructions.map((s) => `<li>${escapeHtml(s)}</li>`).join('') || '<li class="empty">No steps recorded.</li>';
}

function cookModeHtml(r) {
return `<div class="cook-overlay" id="cook-overlay">
<div class="cook-sheet">
<div class="cook-head">
<h2>${escapeHtml(r.name)}</h2>
<button class="sync-btn" type="button" id="cook-close">Close</button>
</div>
<div class="cook-body">
<div class="cook-ingredients"><h3>Ingredients</h3><ul>${ingredientsHtml(r)}</ul></div>
<div class="cook-instructions"><h3>Method</h3><ol>${instructionsHtml(r)}</ol></div>
${r.notes ? `<div class="cook-notes">${escapeHtml(r.notes)}</div>` : ''}
</div>
<div class="cook-foot">
<button class="add-btn" type="button" id="cook-made-btn">Made it today</button>
</div>
</div>
</div>`;
}

function renderCookOverlay() {
let host = document.getElementById('cook-host');
if (!host) return;
if (!cookingRecipe) { host.innerHTML = ''; return; }
const r = data.recipes.find((x) => x.id === cookingRecipe);
if (!r) { cookingRecipe = null; host.innerHTML = ''; return; }
host.innerHTML = cookModeHtml(r);
document.getElementById('cook-close').addEventListener('click', () => { cookingRecipe = null; renderCookOverlay(); });
document.getElementById('cook-made-btn').addEventListener('click', () => {
r.lastMade = new Date().toISOString();
cookingRecipe = null;
renderCookOverlay();
renderRecipes();
renderRecipeOverview();
queueSave();
});
}

// "Prompt me to make some of the dishes sometimes" — favours whatever's
// gone longest without being made (never-made counts as longest), with a
// slight nudge towards higher-rated dishes so a mediocre recipe made once
// years ago doesn't dominate forever. Re-picked on every render rather than
// cached, so it never goes stale relative to what's actually in the list.
function suggestionHtml() {
if (data.recipes.length === 0) return '';
const scored = data.recipes.map((r) => {
const daysSince = r.lastMade ? (Date.now() - new Date(r.lastMade).getTime()) / 86400000 : 9999;
const avg = averageRating(r, data.recipeRatingCategories);
return { r, score: daysSince + (avg ? avg.value * 10 : 0) };
}).sort((a, b) => b.score - a.score);
const pick = scored[0].r;
return `<div class="settings-note" style="margin:0 0 10px;">Haven't made <strong>${escapeHtml(pick.name)}</strong> in a while — worth another go? <button class="sync-btn sm" type="button" data-recipe-cook="${pick.id}" style="width:auto;display:inline-block;">Cook it</button></div>`;
}

function recipesMatchingFilters() {
return data.recipes.filter((r) => {
if (activeMadeFilter === 'made' && !r.lastMade) return false;
if (activeMadeFilter === 'notmade' && r.lastMade) return false;
if (activeTagFilter && !(r.tags || []).includes(activeTagFilter)) return false;
return true;
});
}

function renderRecipes() {
const el = document.getElementById('recipe-list');
if (!el) return;
const filtered = recipesMatchingFilters();
const count = document.getElementById('recipe-count');
if (count) {
count.textContent = !data.recipes.length ? ''
: filtered.length === data.recipes.length ? `${data.recipes.length} recipe${data.recipes.length === 1 ? '' : 's'}`
: `${filtered.length} of ${data.recipes.length}`;
}
el.innerHTML = suggestionHtml()
+ (data.recipes.length === 0
? '<div class="empty">No recipes yet — import one above.</div>'
: filtered.length === 0
? '<div class="empty">Nothing matches this filter.</div>'
: [...filtered].sort((a, b) => a.name.localeCompare(b.name)).map(recipeCardHtml).join(''));

import('../utils.js').then((u) => u.hydratePhotoBackgrounds(el));

el.querySelectorAll('[data-recipe-expand]').forEach((span) => {
span.addEventListener('click', () => {
const id = span.dataset.recipeExpand;
expandedRecipe = expandedRecipe === id ? null : id;
renderRecipes();
});
});
el.querySelectorAll('[data-recipe-cook]').forEach((btn) => {
btn.addEventListener('click', () => { cookingRecipe = btn.dataset.recipeCook; renderCookOverlay(); });
});
el.querySelectorAll('[data-recipe-field]').forEach((input) => {
input.addEventListener('change', () => {
const r = data.recipes.find((x) => x.id === input.dataset.recipeId);
if (!r) return;
const field = input.dataset.recipeField;
if (field === 'ingredients' || field === 'instructions') {
r[field] = input.value.split('\n').map((s) => s.trim()).filter(Boolean);
} else {
r[field] = input.value;
}
if (field === 'name') renderRecipes();
queueSave();
});
});
el.querySelectorAll('[data-recipe-album]').forEach((input) => {
input.addEventListener('change', () => {
const r = data.recipes.find((x) => x.id === input.dataset.recipeAlbum);
if (!r) return;
const url = input.value.trim();
r.photoAlbums = url ? [{ url, cover: '', title: r.name }] : [];
queueSave();
});
});
el.querySelectorAll('[data-recipe-tag-remove]').forEach((x) => {
x.addEventListener('click', () => {
const r = data.recipes.find((rec) => rec.id === x.dataset.recipeTagRemove);
if (!r) return;
r.tags.splice(parseInt(x.dataset.tagIdx, 10), 1);
renderRecipes();
renderRecipeOverview();
queueSave();
});
});
// Reuses the spelling already in use elsewhere (across EVERY recipe, not
// just this one) so typing "curry" when "Curry" already exists on another
// recipe doesn't create a second tag that groups separately in Overview
// -- same reasoning connections.js's own commitTagAdd already documents.
const commitRecipeTagAdd = (recipeId, inputEl) => {
const raw = inputEl.value.trim().replace(/,$/, '').trim();
if (!raw) return;
const r = data.recipes.find((x) => x.id === recipeId);
if (!r) return;
if (!Array.isArray(r.tags)) r.tags = [];
const allKnown = data.recipes.flatMap((x) => x.tags || []);
const canonical = allKnown.find((v) => v.toLowerCase() === raw.toLowerCase()) || raw;
if (r.tags.some((v) => String(v).trim().toLowerCase() === canonical.toLowerCase())) { inputEl.value = ''; return; }
r.tags.push(canonical);
renderRecipes();
renderRecipeOverview();
queueSave();
};
el.querySelectorAll('[data-recipe-tag-add]').forEach((input) => {
input.addEventListener('keydown', (e) => {
if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commitRecipeTagAdd(input.dataset.recipeTagAdd, input); }
});
});
el.querySelectorAll('[data-recipe-tag-add-btn]').forEach((btn) => {
btn.addEventListener('click', () => {
const input = el.querySelector(`[data-recipe-tag-add="${btn.dataset.recipeTagAddBtn}"]`);
if (input) commitRecipeTagAdd(btn.dataset.recipeTagAddBtn, input);
});
});
el.querySelectorAll('[data-view-photo]').forEach((el2) => {
el2.addEventListener('click', async () => {
const url = await photoUrl(el2.dataset.viewPhoto);
if (url) openLightbox(url);
});
});
el.querySelectorAll('[data-recipe-source-pdf]').forEach((el2) => {
el2.addEventListener('click', () => {
const r = data.recipes.find((x) => x.id === el2.dataset.recipeSourcePdf);
if (r && r.source && r.source.attachment) openAttachment(r.source.attachment).catch((err) => alert(err.message || String(err)));
});
});
el.querySelectorAll('[data-recipe-rate]').forEach((star) => {
star.addEventListener('click', () => {
const r = data.recipes.find((x) => x.id === star.dataset.recipeRate);
if (!r) return;
if (!r.ratings) r.ratings = {};
r.ratings[star.dataset.recipeRateCat] = parseInt(star.dataset.recipeRateStar, 10);
renderRecipes();
queueSave();
});
});
el.querySelectorAll('[data-recipe-made]').forEach((btn) => {
btn.addEventListener('click', () => {
const r = data.recipes.find((x) => x.id === btn.dataset.recipeMade);
if (!r) return;
r.lastMade = new Date().toISOString();
renderRecipes();
renderRecipeOverview();
queueSave();
});
});
el.querySelectorAll('[data-recipe-del]').forEach((x) => {
x.addEventListener('click', async () => {
const r = data.recipes.find((rec) => rec.id === x.dataset.recipeDel);
if (!r) return;
if (!confirm(`Delete "${r.name}"? This can't be undone.`)) return;
for (const pid of r.photoIds) await photoDelete(pid).catch(() => {});
const source = r.source || {};
if (source.photoId) await photoDelete(source.photoId).catch(() => {});
if (source.attachment) await deleteAttachment(source.attachment.id).catch(() => {});
data.recipes = data.recipes.filter((rec) => rec.id !== r.id);
renderRecipes();
renderRecipeOverview();
queueSave();
});
});
el.querySelectorAll('[data-recipe-photo-add]').forEach((input) => {
input.addEventListener('change', async (e) => {
const r = data.recipes.find((x) => x.id === input.dataset.recipePhotoAdd);
const files = Array.from(e.target.files);
e.target.value = '';
if (!r) return;
const failures = [];
for (const file of files.slice(0, 6 - r.photoIds.length)) {
try {
const blob = await resizeImageToBlob(file, 1200, 0.85);
const id = await storePhoto(blob);
r.photoIds.push(id);
if (!r.photoId) r.photoId = id;
} catch (err) { failures.push(err.message || String(err)); }
}
if (failures.length) alert(failures.join('\n\n'));
renderRecipes();
queueSave();
});
});
el.querySelectorAll('[data-recipe-photo-remove]').forEach((x) => {
x.addEventListener('click', async () => {
const r = data.recipes.find((rec) => rec.id === x.dataset.recipePhotoRemove);
if (!r) return;
const [removed] = r.photoIds.splice(parseInt(x.dataset.photoIdx, 10), 1);
if (r.photoId === removed) r.photoId = r.photoIds[0] || null;
if (removed) await photoDelete(removed).catch(() => {});
renderRecipes();
queueSave();
});
});
}

// ---- Settings: recipe rating categories (mirrors Connections' editor,
// against the separate recipeRatingCategories list) ----

function initRecipeRatingCategoriesSettings() {
const el = document.getElementById('recipe-rating-categories-list');
if (!el) return;
function render() {
const taken = new Set(data.recipeRatingCategories.map((c) => c.field));
el.innerHTML = data.recipeRatingCategories.map((c) => `<span class="tag-chip">${escapeHtml(c.label)}<span class="tag-x" data-del-recipe-cat="${escapeHtml(c.field)}">&times;</span></span>`).join('')
+ '<input type="text" autocomplete="off" class="tag-add-input" id="new-recipe-cat-input" placeholder="+ add rating">';
el.querySelectorAll('[data-del-recipe-cat]').forEach((x) => {
x.addEventListener('click', () => {
const field = x.dataset.delRecipeCat;
const cat = data.recipeRatingCategories.find((c) => c.field === field);
if (!cat) return;
const ratedCount = data.recipes.filter((r) => r.ratings && r.ratings[field]).length;
const warning = ratedCount
? `Remove "${cat.label}"? ${ratedCount} recipe${ratedCount === 1 ? '' : 's'} ${ratedCount === 1 ? 'has' : 'have'} a rating under it — lost, not just hidden.`
: `Remove "${cat.label}"? Nothing has been rated under it yet.`;
if (!confirm(warning)) return;
data.recipeRatingCategories = data.recipeRatingCategories.filter((c) => c.field !== field);
data.recipes.forEach((r) => { if (r.ratings) delete r.ratings[field]; });
render();
renderRecipes();
queueSave();
});
});
const input = el.querySelector('#new-recipe-cat-input');
input.addEventListener('keydown', (e) => {
if (e.key !== 'Enter') return;
e.preventDefault();
const label = input.value.trim();
if (!label || data.recipeRatingCategories.some((c) => c.label.toLowerCase() === label.toLowerCase())) { input.value = ''; return; }
data.recipeRatingCategories.push({ field: slugifyField(label, taken), label });
render();
renderRecipes();
queueSave();
});
}
render();
}

async function initRecipes() {
initCapture();
initRecipeRatingCategoriesSettings();
renderReview();
renderRecipes();
await initRecipeOverviewPrefs();
renderRecipeOverview();
}

export { initRecipes };
