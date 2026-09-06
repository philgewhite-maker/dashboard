// Menu tab: recipes imported from a photo, a PDF, or a web page, rated on
// the same configurable-star mechanism as Connections (a distinct category
// list — Taste/Health/Prep by default — not the same list, just the same
// idea), with an occasional nudge to actually cook one of them.
import { data, queueSave, DEFAULT_RECIPE_RATING_CATEGORIES, slugifyField, averageRating, getLocalSettings, setLocalSetting } from '../state.js';
import { photoDelete, photoGet, photoUrl } from '../db.js';
import { escapeHtml, uid, todayStr, resizeImageToBlob, openLightbox, pickChipHtml } from '../utils.js';
import { MissingKeyError, extractRecipeFromImage, extractRecipeFromPdf, extractRecipeFromHtml, parseIngredients, assessIngredient, ALLERGEN_LIST, FODMAP_COMPONENTS } from '../ai.js';
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
course: '', glutenStatus: '', dairyStatus: '', fodmapLevel: '', servings: null,
ingredientData: [], ingredientsParsedAt: '', ingredientsSignature: '',
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
// Ingredient-reference panel (see renderIngredientReference) -- same collapse-
// and-remember pattern as recipeOverviewCollapsed, one flag for the
// whole panel rather than per-entry.
let referencePanelCollapsed = true;
// Per-recipe, per-ingredient-line "use the substitute instead" toggle --
// UI-only/in-memory (not persisted): id -> Set of ingredientData indices
// currently showing their substitute's figures instead of their own.
// This is exactly what makes "toggle between the as-written and
// substituted version of a recipe" free -- flipping a toggle just
// re-sums already-cached numbers (computeRecipeDiet), no AI call.
const substituteToggles = new Map();
// recipeId -> a short "what's happening" string, shown IN PLACE of the
// Parse/Analyse link itself (not just the top status bar, which sits far
// from a card scrolled down the list and is easy to miss entirely --
// confirmed live: "is it dead or slow, or did I not actually click it").
// Every AI-calling action sets this before its first await and clears it
// in a finally, so a click always gets an immediate, visible reaction.
const busyIngredientAction = new Map();
function ingredientBusyHtml(r) {
const msg = busyIngredientAction.get(r.id);
return msg ? `<div class="full"><span class="settings-note">⏳ ${escapeHtml(msg)}</span></div>` : '';
}
let expandedDiet = new Set(); // recipe ids currently showing their diet section
// Recipe ids currently showing their parsed-ingredients table -- added to
// automatically right when a parse finishes (see runParseIngredients'
// callers), so a mis-parse is visible immediately, before it feeds into
// any totals; collapsible afterward once it's been checked over.
let expandedIngredientData = new Set();

// A handful of common categories to suggest right away (a main
// ingredient, a cooking style, an occasion...) -- ordinary starting
// points, not a fixed enum; typing anything else just adds it as its
// own new tag. Course and the three dietary statuses used to be in here
// too, but they're genuinely single-choice per recipe (a dish is Gluten
// OR Gluten-free OR Gluten-subs, not several at once) -- moved to their
// own dedicated pickers below (same shape as Connections' Drinking/
// Smoking) instead of living in this open, multi-value, no-exclusivity
// bag where nothing stopped all three landing on one recipe at once.
const SUGGESTED_RECIPE_TAGS = ['Meat', 'Fish', 'One-pot', 'Curry', 'Fruit', 'Christmas'];

// Fixed option sets for the four dedicated pickers just below -- unlike
// Drinking/Smoking's own knownScalarValues() (learned entirely from
// real data, starting empty), these start from a known, deliberate list
// since there's no existing data to learn from and the wording matters
// for consistency. pickChipHtml's own free-text "+add" still works
// underneath for a one-off value outside the set.
const COURSE_OPTIONS = ['Starter', 'Main', 'Dessert', 'Snack', 'Drink'];
const GLUTEN_OPTIONS = ['Gluten', 'Gluten-free', 'Gluten-subs'];
const DAIRY_OPTIONS = ['Dairy', 'Dairy-free', 'Dairy-subs'];
const FODMAP_OPTIONS = ['Low-FODMAP', 'Reduced-FODMAP', 'High-FODMAP'];

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

// Four single-select pickers, each its own field-block/heading -- same
// markup connections.js uses for Drinking/Smoking (a .tag-editor holding
// pickChipHtml's pills), just with a fixed option list passed straight
// in instead of knownScalarValues(). Deliberately separate from the
// general Tags editor below: single-choice, own heading, not mixed in
// with free multi-value tags (per feedback after v262 got this wrong).
function recipeCategoryPickersHtml(r) {
const picker = (label, field, options) => `<div class="field-block">
<span class="field-label">${escapeHtml(label)}</span>
<span class="tag-editor" data-recipe-pick="${r.id}">${pickChipHtml(field, r[field], options)}</span>
</div>`;
return picker('Course', 'course', COURSE_OPTIONS)
+ picker('Gluten', 'glutenStatus', GLUTEN_OPTIONS)
+ picker('Dairy', 'dairyStatus', DAIRY_OPTIONS)
+ picker('FODMAP', 'fodmapLevel', FODMAP_OPTIONS);
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

// ---- ingredient parsing, shared reference table, diet totals ----
//
// The free-text Ingredients textarea (recipeDetailHtml, further below)
// stays exactly as it is -- structure is DERIVED from it on demand,
// wholesale (never hand-edited), so a stable signature (just the raw
// joined text -- no need for anything fancier) is what tells "still
// fresh" from "edited since".
function ingredientsSignatureOf(ingredients) {
return (ingredients || []).join('\n');
}

function findReferenceEntry(name, form) {
const n = String(name || '').trim().toLowerCase();
const f = String(form || '').trim().toLowerCase();
return data.ingredientReference.find((e) => e.name.toLowerCase() === n && (e.form || '').toLowerCase() === f);
}

async function runParseIngredients(r) {
const parsed = await parseIngredients(r.ingredients);
r.ingredientData = parsed;
r.ingredientsParsedAt = new Date().toISOString();
r.ingredientsSignature = ingredientsSignatureOf(r.ingredients);
}

// The one AI-calling step in the whole diet-analysis path besides the
// parse itself -- and only for ingredients (or their toggled-in
// substitute) that don't already have a reference entry. Every OTHER
// recipe sharing that same (name, form) reuses the entry this creates;
// nothing here is ever re-requested just because a DIFFERENT recipe
// happens to also contain flour.
async function ensureReferenceEntry(name, form) {
if (findReferenceEntry(name, form)) return;
const assessed = await assessIngredient(name, form);
data.ingredientReference.push({
id: uid(), name, form,
...assessed,
subs: assessed.subs.map((s) => ({ id: uid(), ...s })),
aiFilledAt: new Date().toISOString(),
userEdited: false,
});
}

async function analyseIngredients(recipeId) {
const r = data.recipes.find((x) => x.id === recipeId);
if (!r) return;
// Set BEFORE the first await and render immediately -- a click needs a
// visible reaction right away, not whenever the eventual status text
// happens to reach the top status bar (which sits far from a card
// scrolled down the list, easy to miss entirely).
busyIngredientAction.set(r.id, 'Reading the ingredients…');
renderRecipes();
try {
if (!r.ingredientsParsedAt || r.ingredientsSignature !== ingredientsSignatureOf(r.ingredients)) {
await runParseIngredients(r);
expandedIngredientData.add(r.id);
}
const seen = new Set();
const toAssess = [];
r.ingredientData.forEach((line) => {
if (!line.name) return;
const key = `${line.name.toLowerCase()}|${line.form.toLowerCase()}`;
if (seen.has(key) || findReferenceEntry(line.name, line.form)) return;
seen.add(key);
toAssess.push(line);
});
for (let i = 0; i < toAssess.length; i += 1) {
busyIngredientAction.set(r.id, `Assessing ${toAssess[i].name}… (${i + 1}/${toAssess.length})`);
renderRecipes();
await ensureReferenceEntry(toAssess[i].name, toAssess[i].form);
}
} catch (err) {
setStatus(err instanceof MissingKeyError ? 'Add an Anthropic API key in Settings first.' : `Couldn't analyse that: ${err.message || err}`);
} finally {
busyIngredientAction.delete(r.id);
}
renderRecipes();
renderIngredientReference();
queueSave();
}

const FODMAP_RANK = { none: 0, low: 1, moderate: 2, high: 3 };
const MACRO_FIELDS = ['calories', 'protein', 'carbs', 'sugars', 'fat', 'saturates', 'fibre', 'salt'];

// Pure arithmetic over already-cached reference entries -- no AI call,
// safe to re-run on every render. Returns null (not partial numbers) if
// any line can't be resolved yet, so the UI can tell "fully analysed"
// from "still missing something" without silently under-reporting.
function computeRecipeDiet(r) {
const toggled = substituteToggles.get(r.id) || new Set();
const totals = {}; MACRO_FIELDS.forEach((k) => { totals[k] = 0; });
const fodmap = {}; FODMAP_COMPONENTS.forEach((k) => { fodmap[k] = 'none'; });
const allergens = new Set();
let resolvedCount = 0;
for (let i = 0; i < r.ingredientData.length; i += 1) {
const line = r.ingredientData[i];
if (!line.name) { resolvedCount += 1; continue; } // a blank/unparseable line contributes nothing, isn't a gap
let entry = findReferenceEntry(line.name, line.form);
if (!entry) return null; // not analysed yet -- caller shows "Analyse ingredients" instead
if (toggled.has(i) && entry.subs && entry.subs[0]) {
// v1: one toggle is on/off, not a picker among several subs -- uses
// the first listed substitute's own reference entry once it exists.
const subEntry = findReferenceEntry(entry.subs[0].name, '');
if (subEntry) entry = subEntry;
}
resolvedCount += 1;
if (line.quantity != null) {
const scale = line.quantity / (entry.unitBasis.quantity || 1);
MACRO_FIELDS.forEach((k) => { totals[k] += (entry.nutrition[k] || 0) * scale; });
FODMAP_COMPONENTS.forEach((k) => { if (FODMAP_RANK[entry.fodmap[k]] > FODMAP_RANK[fodmap[k]]) fodmap[k] = entry.fodmap[k]; });
}
(entry.allergens || []).forEach((a) => allergens.add(a));
}
if (resolvedCount < r.ingredientData.length) return null;
return { totals, fodmap, allergens: [...allergens] };
}

function recipeIngredientsStatusHtml(r) {
if (busyIngredientAction.has(r.id)) return ingredientBusyHtml(r);
if (!r.ingredientsParsedAt) return `<div class="full"><span class="inline-goto-link" data-recipe-parse="${r.id}">Parse ingredients</span></div>`;
if (r.ingredientsSignature !== ingredientsSignatureOf(r.ingredients)) return `<div class="full"><span class="inline-goto-link" data-recipe-parse="${r.id}">Ingredients changed since last parse — re-parse</span></div>`;
return '';
}

// The actual structured read-back of every ingredient line -- shown (and
// editable) so a mis-parse ("2 cloves garlic" read as quantity 2 unit
// "tsp", say) can be caught and fixed by hand BEFORE it ever feeds into
// a reference lookup or a summed total, rather than silently propagating.
// Editing a field here only touches ingredientData, never the free-text
// Ingredients textarea or its signature -- a manual correction isn't
// "stale" relative to the text it came from, it's a correction of how
// that text was read, and stays put across renders.
function recipeParsedIngredientsHtml(r) {
if (!r.ingredientsParsedAt) return '';
const open = expandedIngredientData.has(r.id);
const rows = r.ingredientData.map((line, i) => `
<div class="idea-row" style="padding:6px 0;">
<div class="tinder-fields" style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:6px;">
<input type="text" placeholder="name" data-ingdata-field="name" data-ingdata-recipe="${r.id}" data-ingdata-idx="${i}" value="${escapeHtml(line.name)}">
<input type="text" placeholder="form" data-ingdata-field="form" data-ingdata-recipe="${r.id}" data-ingdata-idx="${i}" value="${escapeHtml(line.form)}">
<input type="number" step="any" placeholder="qty" data-ingdata-field="quantity" data-ingdata-recipe="${r.id}" data-ingdata-idx="${i}" value="${line.quantity != null ? line.quantity : ''}">
<input type="text" placeholder="unit" data-ingdata-field="unit" data-ingdata-recipe="${r.id}" data-ingdata-idx="${i}" value="${escapeHtml(line.unit)}">
</div>
<div class="settings-note" style="margin-top:2px;">from: “${escapeHtml(r.ingredients[i] || '')}”${line.notes ? ` · ${escapeHtml(line.notes)}` : ''}</div>
</div>`).join('');
return `<div class="full">
<button class="overview-panel-toggle" type="button" data-recipe-ingdata-toggle="${r.id}">${open ? '▾ Hide parsed ingredients' : '▸ Show parsed ingredients'}</button>
${open ? `<div style="margin-top:4px;">
<div class="tinder-fields" style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:6px;"><span class="field-label">Name</span><span class="field-label">Form</span><span class="field-label">Qty</span><span class="field-label">Unit</span></div>
${rows || '<div class="empty">Nothing parsed.</div>'}
</div>` : ''}
</div>`;
}

// One row per parsed ingredient with a substitute on file -- the toggle
// IS the "view the substituted version" control; nothing to show for a
// line with no substitute, or before ingredients have been parsed at
// all (recipeIngredientsStatusHtml/recipeDietHtml below handle those).
function recipeSubstituteTogglesHtml(r) {
if (!r.ingredientsParsedAt) return '';
const toggled = substituteToggles.get(r.id) || new Set();
const rows = r.ingredientData.map((line, i) => {
if (!line.name) return '';
const entry = findReferenceEntry(line.name, line.form);
if (!entry || !entry.subs || !entry.subs.length) return '';
const sub = entry.subs[0];
const on = toggled.has(i);
return `<label class="settings-note" style="display:flex;align-items:center;gap:6px;margin:2px 0;">
<input type="checkbox" data-recipe-sub-toggle="${r.id}" data-sub-idx="${i}" ${on ? 'checked' : ''}>
${escapeHtml(line.name)}${line.form ? ` (${escapeHtml(line.form)})` : ''} &rarr; <strong>${escapeHtml(sub.name)}</strong>${sub.note ? ` — ${escapeHtml(sub.note)}` : ''}
</label>`;
}).join('');
if (!rows) return '';
return `<div class="field-block full"><span class="field-label">Substitutes on file</span>${rows}</div>`;
}

function fodmapRowHtml(fodmap) {
return FODMAP_COMPONENTS.map((k) => `<span class="pick-chip${fodmap[k] !== 'none' ? ' active' : ''}" title="${escapeHtml(k)}">${escapeHtml(k)}: ${escapeHtml(fodmap[k])}</span>`).join(' ');
}

function allergenListHtml(present) {
return ALLERGEN_LIST.map((a) => `<span class="pick-chip${present.includes(a) ? ' active' : ''}">${escapeHtml(a)}</span>`).join(' ');
}

// The recipe-level FODMAP row above this (fodmapRowHtml(diet.fodmap)) is
// a worst-case rollup -- the highest rating any single ingredient
// contributes, per component -- which says nothing about which
// ingredient that was, or whether it's rated at anywhere near the
// amount this recipe actually uses. Real FODMAP ratings are typically
// given for a SPECIFIC reference serving and don't scale down linearly
// with less of it (a real threshold effect, not something safe to
// approximate) -- so rather than pretend to divide it down, this shows
// each ingredient's rating exactly as assessed, next to how much this
// recipe actually calls for, so a look-wrong rating (or a scaling
// mismatch worth a manual override) is something to actually check
// against, not a black box.
function recipeFodmapByLineHtml(r) {
const toggled = substituteToggles.get(r.id) || new Set();
const rows = r.ingredientData.map((line, i) => {
if (!line.name) return '';
let entry = findReferenceEntry(line.name, line.form);
if (!entry) return '';
let label = `${escapeHtml(line.name)}${line.form ? ` (${escapeHtml(line.form)})` : ''}`;
if (toggled.has(i) && entry.subs && entry.subs[0]) {
const subEntry = findReferenceEntry(entry.subs[0].name, '');
if (subEntry) { entry = subEntry; label += ` &rarr; using substitute: ${escapeHtml(subEntry.name)}`; }
}
// FODMAP is a per-PORTION question ("is a serving of this low/high"),
// not a per-batch one -- 250g of flour across a whole traybake reads
// very differently once it's divided by however many portions that
// traybake actually makes. line.quantity is the WHOLE-RECIPE amount (as
// written -- "250g wheat flour" is for the batch, not one portion), so
// showing that alone next to a per-portion-shaped rating invites exactly
// the wrong comparison. Divided by r.servings when it's set; flagged
// explicitly (not silently left as the whole-batch figure) when it
// isn't, since that ambiguity is itself worth surfacing rather than
// guessing past.
const whole = line.quantity != null ? `${line.quantity}${escapeHtml(line.unit)}` : null;
const perPortion = whole && r.servings ? `${(line.quantity / r.servings).toFixed(1)}${escapeHtml(line.unit)}` : null;
const used = !whole ? escapeHtml(line.notes || 'amount not specified')
: perPortion ? `${perPortion} per portion (${whole} across all ${r.servings})`
: `${whole} across the whole recipe — set Servings above for a per-portion figure`;
return `<div style="padding:4px 0;border-top:1px solid var(--line);">
<div style="font-size:12px;">${label} — ${used}, rated per ${entry.unitBasis.quantity}${escapeHtml(entry.unitBasis.unit)}</div>
<div>${fodmapRowHtml(entry.fodmap)}</div>
</div>`;
}).join('');
if (!rows) return '';
return `<div class="field-block" style="margin-top:6px;">
<span class="field-label">FODMAP by ingredient</span>
<div class="settings-note">Each rated at its own reference amount (below) -- compare against the PER-PORTION figure, not the whole-recipe one; a rating isn't linearly divisible by amount, but a portion using much less than the reference amount is a real reason to expect better than the rating shown. Edit the entry in Ingredient Reference if it looks wrong even at the right amount.</div>
${rows}
</div>`;
}

// Nothing rendered at all until "Analyse ingredients" has been run once
// AND every line resolves -- the load-bearing requirement that a recipe
// nobody's touched this feature on looks exactly like it always did.
function recipeDietHtml(r) {
if (busyIngredientAction.has(r.id)) return ''; // recipeIngredientsStatusHtml already shows the busy indicator, right above this
if (!r.ingredientsParsedAt) return '';
const diet = computeRecipeDiet(r);
if (!diet) return `<div class="full"><span class="inline-goto-link" data-recipe-analyse="${r.id}">Analyse ingredients</span></div>`;
const per = r.servings ? r.servings : null;
const row = (label, key, unit) => `<div style="display:flex;justify-content:space-between;font-size:12px;padding:2px 0;"><span>${escapeHtml(label)}</span><span>${diet.totals[key].toFixed(1)}${unit}${per ? ` (${(diet.totals[key] / per).toFixed(1)}${unit}/serving)` : ''}</span></div>`;
return `<div class="full">
<button class="overview-panel-toggle" type="button" data-recipe-diet-toggle="${r.id}">${expandedDiet.has(r.id) ? '▾ Hide diet analysis' : '▸ Show diet analysis'}</button>
${expandedDiet.has(r.id) ? `<div class="field-block" style="margin-top:6px;">
<span class="field-label">FODMAP (per component) — worst case across ingredients</span>
<div>${fodmapRowHtml(diet.fodmap)}</div>
</div>
${recipeFodmapByLineHtml(r)}
<div class="field-block" style="margin-top:6px;">
<span class="field-label">Allergens</span>
<div>${allergenListHtml(diet.allergens)}</div>
</div>
<div class="field-block" style="margin-top:6px;">
<span class="field-label">Macros${per ? ` — total, and per serving (${per})` : ' — recipe total'}</span>
${row('Calories', 'calories', ' kcal')}
${row('Protein', 'protein', 'g')}
${row('Carbs', 'carbs', 'g')}
${row('— of which sugars', 'sugars', 'g')}
${row('Fat', 'fat', 'g')}
${row('— of which saturates', 'saturates', 'g')}
${row('Fibre', 'fibre', 'g')}
${row('Salt', 'salt', 'g')}
</div>
<div class="settings-note" style="margin-top:6px;">AI estimate from the ingredient reference table — not a verified nutritional or medical analysis; correct an entry below directly if it looks wrong.</div>
${recipeSubstituteTogglesHtml(r)}` : ''}
</div>`;
}

// ---- shared ingredient reference panel -- collapsed by default, absent
// entirely (the whole index.html section hidden, see renderIngredientReference)
// until the first ingredient is ever analysed ----
let editingReferenceId = null;

function ingredientRefEditHtml(e) {
const macroInput = (label, key) => `<label>${escapeHtml(label)}<input type="number" step="any" data-ref-nutrition="${key}" value="${e.nutrition[key]}"></label>`;
const fodmapSelect = (key) => `<label>${escapeHtml(key)}<select data-ref-fodmap="${key}">${['none', 'low', 'moderate', 'high'].map((lvl) => `<option value="${lvl}" ${e.fodmap[key] === lvl ? 'selected' : ''}>${lvl}</option>`).join('')}</select></label>`;
return `<div class="idea-row" data-ingredient-ref-row="${e.id}">
<div class="idea-top"><span class="idea-title">Editing: ${escapeHtml(e.name)}${e.form ? ` (${escapeHtml(e.form)})` : ''}</span></div>
<div class="tinder-fields" style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
${macroInput('Calories', 'calories')}${macroInput('Protein (g)', 'protein')}
${macroInput('Carbs (g)', 'carbs')}${macroInput('— sugars (g)', 'sugars')}
${macroInput('Fat (g)', 'fat')}${macroInput('— saturates (g)', 'saturates')}
${macroInput('Fibre (g)', 'fibre')}${macroInput('Salt (g)', 'salt')}
${FODMAP_COMPONENTS.map(fodmapSelect).join('')}
</div>
<label class="full">Allergens present<div class="tag-editor">${ALLERGEN_LIST.map((a) => `<span class="pick-chip${e.allergens.includes(a) ? ' active' : ''}" data-ref-allergen="${escapeHtml(a)}">${escapeHtml(a)}</span>`).join('')}</div></label>
<div class="idea-actions">
<button class="add-btn" type="button" data-ingredient-ref-save="${e.id}">Save</button>
<span class="inline-goto-link" data-ingredient-ref-cancel="1">Cancel</span>
</div>
</div>`;
}

function ingredientRefRowHtml(e) {
if (editingReferenceId === e.id) return ingredientRefEditHtml(e);
return `<div class="idea-row" data-ingredient-ref-row="${e.id}">
<div class="idea-top"><span class="idea-title">${escapeHtml(e.name)}${e.form ? ` (${escapeHtml(e.form)})` : ''}</span>
<span class="idea-date">per ${e.unitBasis.quantity}${escapeHtml(e.unitBasis.unit)}${e.userEdited ? ' · edited' : ''}</span></div>
<div class="settings-note">Cal ${e.nutrition.calories} · Protein ${e.nutrition.protein}g · Carbs ${e.nutrition.carbs}g · Fat ${e.nutrition.fat}g · Fibre ${e.nutrition.fibre}g · Salt ${e.nutrition.salt}g</div>
<div>${fodmapRowHtml(e.fodmap)}</div>
${e.allergens.length ? `<div class="settings-note">Allergens: ${e.allergens.map(escapeHtml).join(', ')}</div>` : ''}
${e.subs.length ? `<div class="settings-note">Substitutes: ${e.subs.map((s) => `${escapeHtml(s.name)}${s.note ? ` (${escapeHtml(s.note)})` : ''}`).join('; ')}</div>` : ''}
<div class="idea-actions">
<span class="inline-goto-link" data-ingredient-ref-edit="${e.id}">Edit</span>
<span class="del-x" style="opacity:1;" data-ingredient-ref-del="${e.id}">&times;</span>
</div>
</div>`;
}

function renderIngredientReference() {
const section = document.getElementById('ingredient-reference-panel');
const el = document.getElementById('ingredient-reference-content');
if (!el || !section) return;
// Absent entirely, not just collapsed, until there's actually something
// in it -- an empty panel header floating over nothing is exactly the
// "looks awful when unused" case this whole feature is built to avoid.
section.hidden = data.ingredientReference.length === 0;
if (!data.ingredientReference.length) { el.innerHTML = ''; return; }
const toggleHtml = `<button class="overview-panel-toggle" type="button" id="ingredient-reference-toggle">${referencePanelCollapsed ? '▸ Show ingredient reference' : '▾ Hide ingredient reference'}</button>`;
el.innerHTML = referencePanelCollapsed ? toggleHtml
: `${toggleHtml}<div style="margin-top:6px;">${[...data.ingredientReference].sort((a, b) => a.name.localeCompare(b.name)).map(ingredientRefRowHtml).join('')}</div>`;

document.getElementById('ingredient-reference-toggle').addEventListener('click', () => {
referencePanelCollapsed = !referencePanelCollapsed;
renderIngredientReference();
});
el.querySelectorAll('[data-ingredient-ref-edit]').forEach((x) => {
x.addEventListener('click', () => { editingReferenceId = x.dataset.ingredientRefEdit; renderIngredientReference(); });
});
el.querySelectorAll('[data-ingredient-ref-cancel]').forEach((x) => {
x.addEventListener('click', () => { editingReferenceId = null; renderIngredientReference(); });
});
el.querySelectorAll('[data-ingredient-ref-del]').forEach((x) => {
x.addEventListener('click', () => {
const e = data.ingredientReference.find((r2) => r2.id === x.dataset.ingredientRefDel);
if (!e || !confirm(`Remove the reference entry for "${e.name}"? The next analysis that needs it will re-ask AI.`)) return;
data.ingredientReference = data.ingredientReference.filter((r2) => r2.id !== e.id);
renderIngredientReference();
renderRecipes();
queueSave();
});
});
el.querySelectorAll('[data-ref-allergen]').forEach((chip) => {
chip.addEventListener('click', () => chip.classList.toggle('active'));
});
el.querySelectorAll('[data-ingredient-ref-save]').forEach((btn) => {
btn.addEventListener('click', () => {
const e = data.ingredientReference.find((r2) => r2.id === btn.dataset.ingredientRefSave);
if (!e) return;
const row = btn.closest('[data-ingredient-ref-row]');
row.querySelectorAll('[data-ref-nutrition]').forEach((input) => {
const v = parseFloat(input.value);
e.nutrition[input.dataset.refNutrition] = Number.isFinite(v) ? v : 0;
});
row.querySelectorAll('[data-ref-fodmap]').forEach((select) => { e.fodmap[select.dataset.refFodmap] = select.value; });
e.allergens = [...row.querySelectorAll('[data-ref-allergen].active')].map((chip) => chip.dataset.refAllergen);
// The whole reason this field exists (the tinned-vs-dried-chickpeas
// case): once a person corrects an entry, a later "Analyse ingredients"
// on some other recipe must never silently overwrite it again.
e.userEdited = true;
editingReferenceId = null;
renderIngredientReference();
renderRecipes();
queueSave();
});
});
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
<label class="full">Servings <span class="settings-note">Optional — turns a diet analysis total into a per-portion figure</span><input type="number" min="1" step="1" autocomplete="off" data-recipe-field="servings" data-recipe-id="${r.id}" value="${r.servings != null ? escapeHtml(String(r.servings)) : ''}"></label>
<div class="field-block full">
<span class="field-label">Photo</span>
<div class="task-photos">
${r.photoIds.map((id, i) => `<div class="gallery-thumb"><span class="thumb-img" data-photo-bg="${escapeHtml(id)}"></span><span class="tag-x" data-recipe-photo-remove="${r.id}" data-photo-idx="${i}">&times;</span></div>`).join('')}
<label class="gallery-add" for="recipe-photo-add-${r.id}">+</label>
<input type="file" id="recipe-photo-add-${r.id}" accept="image/*" multiple style="display:none;" data-recipe-photo-add="${r.id}">
</div>
</div>
${recipeCategoryPickersHtml(r)}
${recipeTagsHtml(r)}
<label class="full">Ingredients (one per line)<textarea rows="6" data-recipe-field="ingredients" data-recipe-id="${r.id}">${escapeHtml(r.ingredients.join('\n'))}</textarea></label>
${recipeIngredientsStatusHtml(r)}
${recipeParsedIngredientsHtml(r)}
${recipeDietHtml(r)}
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
} else if (field === 'servings') {
const n = parseInt(input.value, 10);
r.servings = Number.isFinite(n) && n > 0 ? n : null;
} else {
r[field] = input.value;
}
// Re-renders the whole list for either -- servings feeds directly into
// the per-serving figures in the (possibly already-open) diet section,
// same as name needing a full re-render for the card title elsewhere.
if (field === 'name' || field === 'servings') renderRecipes();
queueSave();
});
});
// Same toggle-off-on-repeat-click behaviour as Drinking/Smoking's own
// [data-pick-conn] binding in connections.js -- clicking the already-
// active pill clears the field rather than staying stuck on it.
el.querySelectorAll('[data-recipe-pick] [data-pick-value]').forEach((pill) => {
pill.addEventListener('click', () => {
const r = data.recipes.find((x) => x.id === pill.closest('[data-recipe-pick]').dataset.recipePick);
if (!r) return;
const field = pill.dataset.pickField;
r[field] = r[field] === pill.dataset.pickValue ? '' : pill.dataset.pickValue;
renderRecipes();
queueSave();
});
});
el.querySelectorAll('[data-recipe-pick] [data-pick-add]').forEach((input) => {
input.addEventListener('change', () => {
const value = input.value.trim();
if (!value) return;
const r = data.recipes.find((x) => x.id === input.closest('[data-recipe-pick]').dataset.recipePick);
if (!r) return;
r[input.dataset.pickAdd] = value;
renderRecipes();
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
el.querySelectorAll('[data-recipe-parse]').forEach((link) => {
link.addEventListener('click', async () => {
const r = data.recipes.find((x) => x.id === link.dataset.recipeParse);
if (!r) return;
busyIngredientAction.set(r.id, 'Reading the ingredients…');
renderRecipes();
try {
await runParseIngredients(r);
// Opens automatically right when a fresh parse lands, so a mis-parse
// is visible immediately rather than needing a second click to reveal
// it -- exactly the "I need to see the parsed ingredients... before it
// feeds into more analysis" ask this was built for.
expandedIngredientData.add(r.id);
} catch (err) {
setStatus(err instanceof MissingKeyError ? 'Add an Anthropic API key in Settings first.' : `Couldn't parse that: ${err.message || err}`);
} finally {
busyIngredientAction.delete(r.id);
}
renderRecipes();
queueSave();
});
});
el.querySelectorAll('[data-recipe-analyse]').forEach((link) => {
link.addEventListener('click', () => analyseIngredients(link.dataset.recipeAnalyse));
});
el.querySelectorAll('[data-recipe-diet-toggle]').forEach((btn) => {
btn.addEventListener('click', () => {
const id = btn.dataset.recipeDietToggle;
if (expandedDiet.has(id)) expandedDiet.delete(id); else expandedDiet.add(id);
renderRecipes();
});
});
el.querySelectorAll('[data-recipe-ingdata-toggle]').forEach((btn) => {
btn.addEventListener('click', () => {
const id = btn.dataset.recipeIngdataToggle;
if (expandedIngredientData.has(id)) expandedIngredientData.delete(id); else expandedIngredientData.add(id);
renderRecipes();
});
});
el.querySelectorAll('[data-ingdata-field]').forEach((input) => {
input.addEventListener('change', () => {
const r = data.recipes.find((x) => x.id === input.dataset.ingdataRecipe);
if (!r) return;
const line = r.ingredientData[parseInt(input.dataset.ingdataIdx, 10)];
if (!line) return;
const field = input.dataset.ingdataField;
if (field === 'quantity') {
const v = parseFloat(input.value);
line.quantity = Number.isFinite(v) ? v : null;
} else {
line[field] = input.value.trim();
}
// A hand-fix here only corrects how a line was READ, not the line
// itself -- deliberately doesn't touch r.ingredients or
// r.ingredientsSignature, so this never shows as "stale" relative to
// the free text it came from.
renderRecipes();
queueSave();
});
});
el.querySelectorAll('[data-recipe-sub-toggle]').forEach((cb) => {
cb.addEventListener('change', () => {
const id = cb.dataset.recipeSubToggle;
const idx = parseInt(cb.dataset.subIdx, 10);
if (!substituteToggles.has(id)) substituteToggles.set(id, new Set());
const set = substituteToggles.get(id);
if (cb.checked) set.add(idx); else set.delete(idx);
// Only the diet section's own numbers need to change here -- flipping
// a toggle is pure arithmetic over cached figures (computeRecipeDiet),
// never an AI call, so this can safely re-render immediately.
renderRecipes();
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
renderIngredientReference();
await initRecipeOverviewPrefs();
renderRecipeOverview();
}

export { initRecipes };
