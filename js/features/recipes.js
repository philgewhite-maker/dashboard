// Menu tab: recipes imported from a photo, a PDF, or a web page, rated on
// the same configurable-star mechanism as Connections (a distinct category
// list — Taste/Health/Prep by default — not the same list, just the same
// idea), with an occasional nudge to actually cook one of them.
import { data, queueSave, DEFAULT_RECIPE_RATING_CATEGORIES, slugifyField, averageRating, getLocalSettings, setLocalSetting } from '../state.js';
import { photoDelete, photoGet, photoUrl } from '../db.js';
import { escapeHtml, uid, todayStr, resizeImageToBlob, openLightbox, pickChipHtml, scrollAndFlash } from '../utils.js';
import { MissingKeyError, extractRecipeFromImage, extractRecipeFromPdf, extractRecipeFromHtml, parseIngredients, assessIngredient, ALLERGEN_LIST, DIETARY_FLAGS, FODMAP_COMPONENTS, FODMAP_THRESHOLDS_G, OLIGO_CATEGORIES, fodmapLevelFromGrams, regenerateRecipeVariant } from '../ai.js';
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
ingredientData: [], ingredientsParsedAt: '', ingredientsSignature: '', variantOf: '',
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
// Per-recipe, per-ingredient-line "what if" override -- UI-only/in-memory
// (not persisted, same as the toggle this replaced): recipeId -> Map of
// ingredientData index -> one of:
//   { mode: 'sub', subName }   -- use a listed substitute's own reference entry
//   { mode: 'reduced', qty, basis } -- use LESS of the same ingredient
//                                 (qty is PER-PORTION, in the line's own
//                                 unit) -- the third strategy from
//                                 feedback: some problem ingredients
//                                 don't need swapping out, just cutting
//                                 down (Monash's own "cut the chickpeas
//                                 by 18g/portion" case). `basis` ('line'
//                                 or 'recipe') records which "reach low"
//                                 target the qty came from -- this
//                                 ingredient's own concentration alone,
//                                 or the amount that keeps the WHOLE
//                                 recipe's stacked total under low
//                                 (FODMAP grams are additive across every
//                                 ingredient, so a line that's low on its
//                                 own can still leave the recipe total
//                                 moderate/high) -- purely cosmetic
//                                 (which dropdown option shows selected);
//                                 the qty itself is what actually matters.
//   { mode: 'dropped' }        -- leave it out of the analysis entirely
// No entry for a line means "as written". This is exactly what makes
// exploring these free -- every mode is pure arithmetic over already-
// cached numbers (computeRecipeDiet) once the relevant reference entry
// exists; only picking a not-yet-assessed substitute costs a real AI call.
const lineOverrides = new Map();
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
return `<div class="recipe-card" data-recipe-row="${r.id}">
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

// Set only on a recipe created via "Save as a new recipe with these
// changes" (see regenerateVariant) -- links back to the recipe it was
// adapted FROM, per the record-reference convention (click -> expand +
// scroll the source card into view). Nothing shown for an ordinary
// recipe, or if the source has since been deleted (a dead reference
// isn't worth showing at all).
function recipeVariantSourceHtml(r) {
if (!r.variantOf) return '';
const source = data.recipes.find((x) => x.id === r.variantOf);
if (!source) return '';
return `<div class="field-block full">
<span class="field-label">Adapted from</span>
<span class="inline-goto-link" data-recipe-goto="${source.id}">${escapeHtml(source.name)}</span>
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

// Strips common prep/size adjectives so "chopped onion", "onion (diced)",
// and "large onion" all resolve to the same reference entry as plain
// "onion" -- confirmed live pain point: an ingredient this common
// shouldn't trigger a fresh AI call almost every time just because two
// recipes' AI-parsed name differed by a leading adjective. Only touches
// matching -- the entry itself still stores and displays whatever name it
// was first created under.
const NAME_FILLER_WORDS = ['chopped', 'diced', 'sliced', 'minced', 'crushed', 'grated', 'peeled', 'fresh', 'dried', 'ground', 'finely', 'roughly', 'large', 'medium', 'small', 'ripe', 'raw', 'cooked'];
function canonicalIngredientName(name) {
let n = String(name || '').trim().toLowerCase().replace(/[(),]/g, ' ');
NAME_FILLER_WORDS.forEach((w) => { n = n.replace(new RegExp(`\\b${w}\\b`, 'g'), ' '); });
return n.replace(/\s+/g, ' ').trim();
}

// Alias key format shared with mergeIngredientEntries/data.ingredientAliases.
function aliasKeyOf(name, form) {
return `${canonicalIngredientName(name)}|${String(form || '').trim().toLowerCase()}`;
}

function findReferenceEntry(name, form) {
// A user-merged name ("eggplant" -> the "aubergine" entry) resolves
// straight to its target, bypassing normal name matching entirely --
// this is what makes two genuinely different spellings/varieties share
// one entry (and one AI assessment) going forward, not just filler-word
// variants of the same literal name. Falls through to normal matching
// if the target was since deleted (a dangling alias, rather than crash
// or silently resolve to nothing).
const aliasTargetId = data.ingredientAliases[aliasKeyOf(name, form)];
if (aliasTargetId) {
const target = data.ingredientReference.find((e) => e.id === aliasTargetId);
if (target) return target;
}
const n = canonicalIngredientName(name);
const f = String(form || '').trim().toLowerCase();
return data.ingredientReference.find((e) => canonicalIngredientName(e.name) === n && (e.form || '').toLowerCase() === f);
}

// A handful of ingredients that are always FODMAP/allergen/macro-
// negligible regardless of recipe -- a static fact, not worth an AI call.
// Confirmed live pain point: "particularly stupid to ask for water or
// salt to be assessed". Deliberately narrow (no herbs/spices here -- those
// genuinely vary, per the earlier paprika case) and skipped entirely when
// a form is stated ("smoked salt", say) since that's a real signal it's
// worth an actual look, not assumed generic.
const TRIVIAL_INGREDIENTS = {
water: { unit: 'ml' }, salt: { salt: 100 }, 'table salt': { salt: 100 }, 'sea salt': { salt: 100 },
ice: { unit: 'ml' }, 'ice cubes': { unit: 'ml' },
'black pepper': {}, pepper: {}, 'ground black pepper': {}, 'white pepper': {},
'bicarbonate of soda': {}, 'baking soda': {},
};
function trivialReferenceEntry(name, form) {
if (form) return null;
const spec = TRIVIAL_INGREDIENTS[canonicalIngredientName(name)];
if (!spec) return null;
return {
unitBasis: { quantity: 100, unit: spec.unit || 'g' },
unitWeights: {},
nutrition: { calories: 0, protein: 0, carbs: 0, sugars: 0, fat: 0, saturates: 0, fibre: 0, salt: spec.salt || 0 },
oligoCategory: 'veg_fruit',
fodmapGrams: { fructans: 0, gos: 0, lactose: 0, excessFructose: 0, polyols: 0 },
allergens: [], dietaryFlags: [], subs: [],
};
}

async function runParseIngredients(r) {
const parsed = await parseIngredients(r.ingredients);
r.ingredientData = parsed;
r.ingredientsParsedAt = new Date().toISOString();
r.ingredientsSignature = ingredientsSignatureOf(r.ingredients);
}

// True when an ingredient either has no reference entry at all, or has
// one that predates dietaryFlags and/or unitWeights and was never
// actually asked about them (state.js's migration marks these
// dietaryFlagsStale/unitWeightsStale rather than guessing -- an empty
// array/object is ambiguous on its own, "genuinely none" and "never
// checked" look identical). Shared by every call site that decides
// whether ensureReferenceEntry has real work to do, so a stale entry is
// never silently skipped as if it were already complete.
function needsAssessment(name, form) {
const e = findReferenceEntry(name, form);
if (!e) return true;
// A userEdited entry is never auto-refreshed, full stop -- whichever
// field(s) are stale on it stay that way until corrected by hand (both
// the Save form and the unit-weight/substitute editors already clear
// their own staleness the moment they're actually used -- see those
// handlers), the same guarantee the FODMAP/nutrition figures already
// have.
if (e.userEdited) return false;
return !!e.dietaryFlagsStale || !!e.unitWeightsStale;
}

// The one AI-calling step in the whole diet-analysis path besides the
// parse itself -- and only for ingredients (or a chosen substitute) that
// need it (see needsAssessment) and aren't one of the static
// TRIVIAL_INGREDIENTS above. Every OTHER recipe sharing that same
// (name, form) reuses the entry this creates; nothing here is ever
// re-requested just because a DIFFERENT recipe happens to also contain
// flour.
async function ensureReferenceEntry(name, form) {
const existing = findReferenceEntry(name, form);
if (existing && (existing.userEdited || (!existing.dietaryFlagsStale && !existing.unitWeightsStale))) return;
const trivial = trivialReferenceEntry(name, form);
const assessed = trivial || await assessIngredient(name, form);
if (existing) {
// A stale-flagged entry already has real (possibly user-corrected)
// macro/FODMAP/allergen data -- this refresh exists ONLY to fill in
// whichever field(s) are actually flagged stale, so that's ALL it
// touches. A full overwrite here would silently undo a manual
// correction the same way a careless re-assessment of the FODMAP
// figures would.
if (existing.dietaryFlagsStale) {
existing.dietaryFlags = assessed.dietaryFlags;
existing.dietaryAssessedAt = new Date().toISOString();
delete existing.dietaryFlagsStale;
}
if (existing.unitWeightsStale) {
existing.unitWeights = assessed.unitWeights;
existing.unitWeightsAssessedAt = new Date().toISOString();
delete existing.unitWeightsStale;
}
return;
}
data.ingredientReference.push({
id: uid(), name, form,
...assessed,
subs: assessed.subs.map((s) => ({ id: uid(), ...s })),
aiFilledAt: trivial ? '' : new Date().toISOString(),
dietaryAssessedAt: new Date().toISOString(),
unitWeightsAssessedAt: new Date().toISOString(),
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
const key = `${canonicalIngredientName(line.name)}|${line.form.toLowerCase()}`;
if (seen.has(key) || !needsAssessment(line.name, line.form)) return;
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

// Turns the current lineOverrides state for a recipe into plain-English
// instructions an AI rewrite can follow -- one sentence per overridden
// line, in the exact three shapes the "what if" control offers (sub/
// reduced/dropped). Empty array means nothing's been changed yet, which
// is also what gates whether "Save as a new recipe" even appears
// (regenerateVariant below) -- there's nothing to regenerate FROM until
// at least one override exists.
function describeLineOverrides(r) {
const overrides = lineOverrides.get(r.id);
if (!overrides || !overrides.size) return [];
const out = [];
r.ingredientData.forEach((line, i) => {
const override = overrides.get(i);
if (!override || !line.name) return;
if (override.mode === 'dropped') {
out.push(`Omit "${line.name}"${line.form ? ` (${line.form})` : ''} entirely.`);
} else if (override.mode === 'sub') {
out.push(`Replace "${line.name}"${line.form ? ` (${line.form})` : ''} with "${override.subName}", keeping a similar quantity/preparation unless the substitute is naturally measured differently.`);
} else if (override.mode === 'reduced' && override.qty != null) {
const wholeQty = r.servings ? override.qty * r.servings : override.qty;
const round = (n) => (n < 10 ? Math.round(n * 100) / 100 : Math.round(n * 10) / 10);
out.push(`Reduce "${line.name}"${line.form ? ` (${line.form})` : ''} from ${line.quantity}${line.unit} to about ${round(wholeQty)}${line.unit} in total (the recipe still serves ${r.servings || 'the same number of people'}).`);
}
});
return out;
}

// "${base} (adjusted)", de-duplicated against every existing recipe name
// -- same reasoning connections.js's own tag-canonicalisation avoids
// accidental near-duplicates, just for a recipe title instead of a tag.
function uniqueVariantName(baseName) {
const base = `${baseName} (adjusted)`;
if (!data.recipes.some((x) => x.name === base)) return base;
let n = 2;
while (data.recipes.some((x) => x.name === `${base} ${n}`)) n += 1;
return `${base} ${n}`;
}

// "Make it like this" -- the one AI call that turns a recipe's session-
// only "what if" exploration (lineOverrides: substitute/reduce/drop,
// never persisted -- see the Map's own comment) into something actually
// cookable. Saved as a NEW recipe (variantOf pointing back at this one)
// rather than overwriting the original -- the original stays exactly as
// it was, still cookable as written, and its own diet analysis/overrides
// are untouched; the variant starts with a completely fresh
// ingredientData/diet state of its own (its ingredient TEXT genuinely
// changed, so re-parsing and re-analysing from scratch is correct, not
// just convenient).
async function regenerateVariant(recipeId) {
const r = data.recipes.find((x) => x.id === recipeId);
if (!r) return;
const changes = describeLineOverrides(r);
if (!changes.length) return;
busyIngredientAction.set(r.id, 'Rewriting the recipe with these changes…');
renderRecipes();
let newVariantId = null;
try {
const { ingredients, instructions } = await regenerateRecipeVariant(r.ingredients, r.instructions, changes);
const variant = {
id: uid(), name: uniqueVariantName(r.name),
ingredients, instructions,
notes: [r.notes, `Adapted from "${r.name}":`, ...changes.map((c) => `- ${c}`)].filter(Boolean).join('\n'),
source: { kind: `adapted from "${r.name}"`, url: '', photoId: '', attachment: null },
photoId: null, photoIds: [], photoAlbums: [], ratings: {}, tags: [...(r.tags || [])],
createdAt: new Date().toISOString(), lastMade: '',
// Course carries over (unrelated to which ingredients changed);
// the three ingredient-content-specific pickers reset -- copying
// the OLD recipe's status here would risk claiming something (e.g.
// "Gluten-free") the actual rewritten ingredients haven't earned.
course: r.course, glutenStatus: '', dairyStatus: '', fodmapLevel: '', servings: r.servings,
ingredientData: [], ingredientsParsedAt: '', ingredientsSignature: '',
variantOf: r.id,
};
data.recipes.push(variant);
expandedRecipe = variant.id;
newVariantId = variant.id;
} catch (err) {
setStatus(err instanceof MissingKeyError ? 'Add an Anthropic API key in Settings first.' : `Couldn't regenerate that: ${err.message || err}`);
} finally {
busyIngredientAction.delete(r.id);
}
renderRecipes();
renderRecipeOverview();
queueSave();
// Alphabetically sorted, so a new recipe can land anywhere in a long
// list -- scrolled + flashed into view the same way any other in-app
// cross-reference lands on its target, so it's never just silently
// added somewhere off-screen. Only once busyIngredientAction is
// actually cleared and this render has landed, hence AFTER the block
// above, not inside the try.
if (newVariantId) setTimeout(() => scrollAndFlash(`[data-recipe-row="${newVariantId}"]`), 0);
}

const MACRO_FIELDS = ['calories', 'protein', 'carbs', 'sugars', 'fat', 'saturates', 'fibre', 'salt'];

// How many grams ONE of `unit` weighs, for THIS entry specifically --
// grams are grams universally (not a conversion, a tautology), so "g"
// always resolves to 1 with no lookup needed; every other unit only
// resolves when the entry's own AI-assessed unitWeights actually says
// so (never guessed -- an ingredient with no known weight for a unit
// simply can't be bridged through it). Confirmed live pain point: "1
// medium onion" parsed against an entry assessed per "100g" had no way
// to reconcile the two at all before this existed.
function gramsEquivalentPerOne(entry, unit) {
const u = String(unit || '').trim().toLowerCase();
if (!u) return null;
if (u === 'g') return 1;
const w = entry.unitWeights && entry.unitWeights[u];
return (typeof w === 'number' && w > 0) ? w : null;
}

// How many entry.unitBasis.unit's ONE `lineUnit` is worth -- 1 when the
// two are literally the same unit (the exact-match case, needing no
// weight data of any kind); otherwise bridged through grams via
// gramsEquivalentPerOne on BOTH sides (the entry's own unitBasis unit
// might itself be a countable/spoon unit, not necessarily "g"); null
// when genuinely unresolvable, which callers must treat as unresolved
// (never guessed) -- see resolveLineEntry's unitMismatch/unitRatio.
function unitConversionRatio(entry, lineUnit) {
const lu = String(lineUnit || '').trim().toLowerCase();
const bu = String(entry.unitBasis.unit || '').trim().toLowerCase();
if (!lu || !bu) return null;
if (lu === bu) return 1;
const lineGramsPerOne = gramsEquivalentPerOne(entry, lu);
const basisGramsPerOne = gramsEquivalentPerOne(entry, bu);
if (lineGramsPerOne != null && basisGramsPerOne != null) return lineGramsPerOne / basisGramsPerOne;
return null;
}

// The bounds ([lowMax, highMin], in grams of the actual carbohydrate) a
// given component/category is judged against -- same fallback order
// fodmapLevelFromGrams (ai.js) uses internally, exposed here too since the
// "cut by Xg to reach a lower rating" suggestion (recipeIngredientAnalysisHtml)
// needs the raw numbers, not just the derived level.
function fodmapBoundsFor(component, category) {
const table = FODMAP_THRESHOLDS_G[component];
if (!table) return null;
return table.any || table[category] || table.veg_fruit;
}

// fodmapLevelFromGrams uses a STRICT "<" against the threshold -- a
// target landed exactly ON the boundary (the naive division) still comes
// back as the higher level, not the lower one it was meant to reach.
// Confirmed live: 42.000042g of chickpeas (float division artefact, not
// even the boundary exactly) still read "moderate". A small margin below
// the threshold, imperceptible against any real quantity, keeps every
// suggested target actually landing where it claims to.
const THRESHOLD_SAFETY_MARGIN = 0.99;

// Same suggested-target math as the "cut by Xg/portion" note
// (recipeIngredientAnalysisHtml) -- the SMALLEST per-portion quantity,
// IN THE LINE'S OWN UNIT, that would bring every one of this entry's
// flagged components under its own "low" cutoff, so switching a line to
// "Use less…" starts from a genuinely useful default rather than an
// arbitrary or unchanged one. `unitRatio` (from resolveLineEntry) is
// what expresses the target back in the line's own unit rather than the
// entry's unitBasis unit, when the two differ -- pass 1 for an exact-
// match line. null when the entry has no FODMAP content at all to cut
// down.
function suggestedLowQtyPerPortion(entry, unitRatio) {
let minQty = null;
FODMAP_COMPONENTS.forEach((k) => {
const gramsPerUnit = ((entry.fodmapGrams[k] || 0) / (entry.unitBasis.quantity || 1)) * unitRatio;
if (gramsPerUnit <= 0) return;
const category = (k === 'fructans' || k === 'gos') ? entry.oligoCategory : 'any';
const bounds = fodmapBoundsFor(k, category);
const targetQty = (bounds[0] * THRESHOLD_SAFETY_MARGIN) / gramsPerUnit;
if (minQty == null || targetQty < minQty) minQty = targetQty;
});
return minQty;
}

// The "reach low" target above judges this ingredient in ISOLATION --
// but FODMAP grams are additive across the WHOLE recipe (computeRecipeDiet),
// so a line that's individually "low" can still leave the recipe's own
// total moderate/high once every other ingredient's contribution is
// stacked on top -- confirmed live: "doesn't target recipe level low
// levels (stacking)". This targets the recipe TOTAL instead: how much of
// THIS line, added to everything ELSE already in the recipe (at their
// own current overrides), keeps each component's combined total under
// its own "low" cutoff. Returns null when the entry has no FODMAP
// content at all; a target of 0 for a component means even NONE of this
// ingredient would help -- the other ingredients alone already exceed
// that cutoff, and no amount of THIS one can fix that.
function suggestedLowQtyPerPortionForRecipeTotal(r, i, entry) {
const diet = computeRecipeDiet(r);
if (!diet) return null;
const line = r.ingredientData[i];
const resolved = resolveLineEntry(r, line, i);
const thisPortionQty = resolved ? resolved.portionQty : null;
const unitRatio = resolved ? resolved.unitRatio : 1;
let minQty = null;
FODMAP_COMPONENTS.forEach((k) => {
const gramsPerUnit = ((entry.fodmapGrams[k] || 0) / (entry.unitBasis.quantity || 1)) * unitRatio;
if (gramsPerUnit <= 0) return;
const thisContribution = thisPortionQty != null ? thisPortionQty * gramsPerUnit : 0;
const othersTotal = Math.max(0, (diet.fodmapGrams[k] || 0) - thisContribution);
const category = (k === 'fructans' || k === 'gos') ? entry.oligoCategory : 'any';
const bounds = fodmapBoundsFor(k, category);
const headroom = (bounds[0] * THRESHOLD_SAFETY_MARGIN) - othersTotal;
const targetQty = headroom > 0 ? headroom / gramsPerUnit : 0;
if (minQty == null || targetQty < minQty) minQty = targetQty;
});
return minQty;
}

// Resolves one ingredient line to the reference entry (and effective
// quantity) it should actually be judged against, taking the line's
// current lineOverrides entry (if any) into account -- the ONE place
// that decision is made, shared by computeRecipeDiet (the totals) and
// the per-line analysis UI (recipeIngredientAnalysisHtml), so the two
// can never disagree about which entry/quantity a line is using.
// Returns null only when the line's OWN ingredient has no reference
// entry yet (nothing to resolve); a 'sub' override whose substitute
// isn't assessed yet silently falls back to the original entry (the
// override control only ever sets that mode once the substitute's
// entry exists -- see the data-line-override-mode handler below).
function resolveLineEntry(r, line, i) {
const originalEntry = findReferenceEntry(line.name, line.form);
if (!originalEntry) return null;
let entry = originalEntry;
const override = (lineOverrides.get(r.id) || new Map()).get(i);
const dropped = !!(override && override.mode === 'dropped');
let subName = '';
if (override && override.mode === 'sub' && override.subName) {
const subEntry = findReferenceEntry(override.subName, '');
if (subEntry) { entry = subEntry; subName = override.subName; }
}
// portionQty is what FODMAP thresholds are judged against (a per-
// PORTION question); wholeQty is what the macro totals scale by
// (those stay whole-recipe, divided only for the per-serving display).
// A 'reduced' override is expressed directly as a per-portion figure
// (the natural unit for "cut it down by Xg/portion") and back-derived
// into a whole-recipe equivalent for the macro side, rather than the
// other way round.
let portionQty = r.servings && line.quantity != null ? line.quantity / r.servings : line.quantity;
let wholeQty = line.quantity;
if (dropped) { portionQty = 0; wholeQty = 0; }
else if (override && override.mode === 'reduced' && override.qty != null) {
portionQty = override.qty;
wholeQty = r.servings ? override.qty * r.servings : override.qty;
}
// `originalEntry` is exposed alongside the (possibly substituted)
// `entry` specifically so the override <select>'s own option list can
// always be built from the ingredient AS WRITTEN's substitutes, not
// whatever entry currently happens to be in effect -- real bug, caught
// live: once a substitute was active, `entry` became the SUBSTITUTE's
// own entry, so the options list was rebuilt from the SUBSTITUTE's own
// subs (a different list entirely), meaning the active substitute never
// matched any option, no option got `selected`, and the browser fell
// back to showing "Use as written" as selected BY DEFAULT even though
// the override was still very much active -- which meant clicking "Use
// as written" again fired no `change` event at all (as far as the
// browser was concerned, nothing changed), so it could never be used to
// undo a substitution.
//
// unitRatio: how many entry.unitBasis.unit's ONE of the LINE's own unit
// ("large", "tsp"...) is worth -- everywhere else in this file scales by
// `qty * unitRatio / entry.unitBasis.quantity` rather than the NAIVE
// `qty / entry.unitBasis.quantity` this used to be, which silently
// assumed the two were already the same unit. Two independent AI calls
// (the ingredient parser and the ingredient assessor) choose their own
// units with no coordination at all, so nothing ever guaranteed that --
// a real, confirmed gap: "white onion" parsed as "1 large" against a
// reference entry assessed per "100g" used to silently divide 1 by 100
// as if they were the same unit, producing a number with no real
// meaning. unitConversionRatio bridges the two through the entry's own
// AI-assessed unitWeights (e.g. "1 medium onion ≈ 110g") when a
// conversion is actually known; unitMismatch (ratio === null) means NO
// bridge exists, and every caller must treat the line as UNRESOLVED --
// never guess a cross-unit conversion that was never actually supplied
// -- see computeRecipeDiet and recipeIngredientAnalysisHtml.
const unitRatio = unitConversionRatio(entry, line.unit);
const unitMismatch = !!line.unit && !!entry.unitBasis.unit && unitRatio == null;
return { entry, originalEntry, dropped, portionQty, wholeQty, subName, unitMismatch, unitRatio };
}

const MIXED_OLIGO_CATEGORY = 'veg_fruit'; // conservative default when a recipe's fructans/GOS come from more than one category -- see computeRecipeDiet
// A genuinely mixed-category recipe (say, real onion AND real wheat both
// contributing meaningful fructans) has no single correct table to sum
// against, hence the conservative MIXED_OLIGO_CATEGORY fallback -- but a
// TRACE contribution from a second category (every other ingredient
// reading <0.01g, rounding-error-level) shouldn't be enough to drag the
// whole recipe onto the stricter table when it's really a one-ingredient
// question. Confirmed live: chickpeas alone drove the total, every other
// GOS source was <0.01g/"None", yet the mere presence of a second
// category flipped the recipe to the narrower veg_fruit window. This
// threshold says the dominant category's own table still applies as
// long as it accounts for at least this share of the total.
const OLIGO_CATEGORY_DOMINANCE_THRESHOLD = 0.95;

// Pure arithmetic over already-cached reference entries -- no AI call,
// safe to re-run on every render. Returns null (not partial numbers) if
// any line can't be resolved yet, so the UI can tell "fully analysed"
// from "still missing something" without silently under-reporting.
//
// FODMAP is summed as real grams of each carbohydrate (fructans, GOS,
// lactose, excess fructose, polyols) across every line -- genuinely
// additive chemistry, unlike the old flat low/moderate/high rollup
// (which just took the single worst-rated ingredient regardless of how
// little of it was actually used). The final per-component LEVEL is only
// derived once, after the sum, against the fixed published thresholds.
function computeRecipeDiet(r) {
const totals = {}; MACRO_FIELDS.forEach((k) => { totals[k] = 0; });
const fodmapGrams = {}; FODMAP_COMPONENTS.forEach((k) => { fodmapGrams[k] = 0; });
// oligoCategory only matters for fructans/GOS -- tracked per component,
// not just once, since a recipe could have fructans-only from a grain
// and GOS-only from a vegetable at the same time. Grams are tracked PER
// CATEGORY (not just which categories appear at all), so a dominant
// ingredient's own correct table still applies even when trace amounts
// from a differently-categorised ingredient are also present -- see
// OLIGO_CATEGORY_DOMINANCE_THRESHOLD below. Only a genuine mix (no
// single category accounting for the bulk of the total) falls back to
// the conservative MIXED_OLIGO_CATEGORY default, so a single-ingredient
// recipe never disagrees with its own per-line breakdown the way a
// blanket default would (confirmed live: 0.43g GOS from tinned
// chickpeas alone read "moderate" per-line under grain_legume_nut but
// "high" at rollup under a blanket veg_fruit default -- the same grams,
// two different verdicts).
const oligoCatGrams = { fructans: {}, gos: {} };
const allergens = new Set();
const dietaryFlags = new Set();
// Lines that couldn't be scaled at all -- their unit doesn't match
// their (possibly substituted) reference entry's unitBasis, so macros/
// FODMAP are withheld for THAT line specifically (never guess a cross-
// unit conversion -- see resolveLineEntry's own comment) rather than
// blocking the whole recipe's totals over one ingredient's parsing
// hiccup. recipeDietHtml surfaces this list so the totals below are
// never silently incomplete -- what's excluded, and why, is always
// visible right next to them.
const unmatchedLines = [];
let resolvedCount = 0;
for (let i = 0; i < r.ingredientData.length; i += 1) {
const line = r.ingredientData[i];
if (!line.name) { resolvedCount += 1; continue; } // a blank/unparseable line contributes nothing, isn't a gap
const resolved = resolveLineEntry(r, line, i);
if (!resolved) return null; // not analysed yet -- caller shows "Analyse ingredients" instead
resolvedCount += 1;
const { entry, dropped, portionQty, wholeQty, unitMismatch, unitRatio } = resolved;
if (dropped) continue; // excluded from every total, including allergens -- "drop it" means drop it
// Allergen/dietary-flag presence is boolean, not quantity-scaled -- a
// trace of gluten doesn't stop being gluten just because THIS line's
// unit couldn't be scaled, so these are recorded regardless of
// unitMismatch, unlike the quantity-dependent totals just below.
(entry.allergens || []).forEach((a) => allergens.add(a));
(entry.dietaryFlags || []).forEach((f) => dietaryFlags.add(f));
if (unitMismatch) { unmatchedLines.push({ line, entry }); continue; }
if (wholeQty != null) {
const scale = (wholeQty * unitRatio) / (entry.unitBasis.quantity || 1);
MACRO_FIELDS.forEach((k) => { totals[k] += (entry.nutrition[k] || 0) * scale; });
}
if (portionQty != null) {
const portionScale = (portionQty * unitRatio) / (entry.unitBasis.quantity || 1);
FODMAP_COMPONENTS.forEach((k) => {
const grams = (entry.fodmapGrams[k] || 0) * portionScale;
fodmapGrams[k] += grams;
if ((k === 'fructans' || k === 'gos') && grams > 0) {
oligoCatGrams[k][entry.oligoCategory] = (oligoCatGrams[k][entry.oligoCategory] || 0) + grams;
}
});
}
}
if (resolvedCount < r.ingredientData.length) return null;
const fodmap = {};
FODMAP_COMPONENTS.forEach((k) => {
let category = MIXED_OLIGO_CATEGORY;
if (k === 'fructans' || k === 'gos') {
const byCat = Object.entries(oligoCatGrams[k]);
if (byCat.length <= 1) {
// Zero or one category contributed at all -- the simple case,
// no dominance question to ask.
category = byCat.length === 1 ? byCat[0][0] : MIXED_OLIGO_CATEGORY;
} else {
const [dominantCat, dominantGrams] = byCat.reduce((a, b) => (b[1] > a[1] ? b : a));
category = (dominantGrams / fodmapGrams[k]) >= OLIGO_CATEGORY_DOMINANCE_THRESHOLD ? dominantCat : MIXED_OLIGO_CATEGORY;
}
}
fodmap[k] = fodmapLevelFromGrams(k, fodmapGrams[k], category);
});
return { totals, fodmapGrams, fodmap, allergens: [...allergens], dietaryFlags: [...dietaryFlags], unmatchedLines };
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

// `grams`, when given, is a {component: totalGrams} map shown alongside
// each level -- the actual figure the level was derived from, not just
// the bucket it landed in. Red/amber/green (fodmap-chip's level-* classes),
// not the app's usual pink -- a flat "active" highlight read no
// differently for "low" than for "high", which defeats the point of a
// severity indicator (per feedback).
function fodmapRowHtml(fodmap, grams) {
return FODMAP_COMPONENTS.map((k) => {
const g = grams ? grams[k] : null;
const gText = g != null ? ` (${g < 0.01 ? '<0.01' : g.toFixed(2)}g)` : '';
return `<span class="fodmap-chip level-${escapeHtml(fodmap[k])}" title="${escapeHtml(k)}">${escapeHtml(k)}: ${escapeHtml(fodmap[k])}${gText}</span>`;
}).join(' ');
}

// A reference entry's OWN levels, derived from its fodmapGrams + its own
// oligoCategory -- used for the ingredient-reference panel's read view,
// which (unlike a recipe line) has no quantity to scale by, just the
// entry exactly as assessed per its own unitBasis.
function entryFodmapLevels(e) {
const levels = {};
FODMAP_COMPONENTS.forEach((k) => {
const category = (k === 'fructans' || k === 'gos') ? e.oligoCategory : 'any';
levels[k] = fodmapLevelFromGrams(k, e.fodmapGrams[k] || 0, category);
});
return levels;
}

// Shared by the Allergens and Dietary flags rollups (same shape: a fixed
// checklist, present ones highlighted) -- `list` is ALLERGEN_LIST or
// DIETARY_FLAGS, `present` the subset actually found in this recipe.
function flagListHtml(list, present) {
return list.map((a) => `<span class="pick-chip${present.includes(a) ? ' active' : ''}">${escapeHtml(a)}</span>`).join(' ');
}

// Per-ingredient-line breakdown -- FODMAP (with the recipe-level rollup's
// own reasoning: a rollup alone can't say WHICH ingredient, or whether
// it's near the amount actually used), plus the allergens/dietary flags
// THIS line contributes (the recipe-level rollup lists them but not their
// source -- confirmed live pain point: "where is Cereals containing
// gluten coming from... I don't see it per component" -- an ingredient
// contributing an allergen at all is reason enough to show it here even
// when its FODMAP levels are all fine), and -- inline, not a separate
// block -- the "what if" control for this line: swap in a substitute,
// use less of it, or drop it, live-recomputing every total above.
function recipeIngredientAnalysisHtml(r) {
const rows = r.ingredientData.map((line, i) => {
if (!line.name) return '';
const resolved = resolveLineEntry(r, line, i);
if (!resolved) return '';
const { entry, originalEntry, dropped, portionQty, subName, unitMismatch, unitRatio } = resolved;
const override = (lineOverrides.get(r.id) || new Map()).get(i);
let label = `${escapeHtml(line.name)}${line.form ? ` (${escapeHtml(line.form)})` : ''}`;
if (subName) label += ` &rarr; using substitute: <strong>${escapeHtml(subName)}</strong>`;
// FODMAP is a per-PORTION question ("is a serving of this low/high"),
// not a per-batch one -- 250g of flour across a whole traybake reads
// very differently once it's divided by however many portions that
// traybake actually makes. line.quantity is the WHOLE-RECIPE amount
// as written, so the AS-WRITTEN per-portion figure is shown alongside
// whatever the current override actually resolves to, when they differ.
const asWrittenWhole = line.quantity != null ? `${line.quantity}${escapeHtml(line.unit)}` : null;
const asWrittenPortion = asWrittenWhole && r.servings ? line.quantity / r.servings : (line.quantity != null ? line.quantity : null);
let used;
if (dropped) {
used = 'excluded from this analysis';
} else if (!asWrittenWhole) {
used = escapeHtml(line.notes || 'amount not specified');
} else if (!r.servings) {
used = `${asWrittenWhole} across the whole recipe — set Servings above for a per-portion figure`;
} else if (override && override.mode === 'reduced') {
used = `${portionQty.toFixed(1)}${escapeHtml(line.unit)}/portion (cut down from ${asWrittenPortion.toFixed(1)}${escapeHtml(line.unit)} as written)`;
} else {
used = `${asWrittenPortion.toFixed(1)}${escapeHtml(line.unit)} per portion (${asWrittenWhole} across all ${r.servings})`;
}
const lineAllergens = dropped ? [] : (entry.allergens || []);
const lineDietaryFlags = dropped ? [] : (entry.dietaryFlags || []);
const flagsNote = (lineAllergens.length || lineDietaryFlags.length)
? `<div class="settings-note">${[
lineAllergens.length ? `Allergens: ${lineAllergens.map(escapeHtml).join(', ')}` : '',
lineDietaryFlags.length ? `Also: ${lineDietaryFlags.map(escapeHtml).join(', ')}` : '',
].filter(Boolean).join(' · ')}</div>`
: '';
let chips = '';
let worstLevel = 'none';
let noQtyNote = '';
if (!dropped && unitMismatch) {
// Genuinely can't compute a figure here at all -- unlike "no quantity
// given" below (nothing to scale BY), this line HAS a quantity, just
// in a unit ("large", say) that doesn't match the reference entry's
// own basis ("g") -- silently falling back to the reference amount
// the way the no-quantity case does would show a number that has
// nothing to do with what's actually in this dish. Real gap caught
// live: "white onion — 0.3large per portion... gos: low" was this
// exact bug, dividing 0.3 BY 100 as if "large" and "g" were the same
// unit -- a number that means nothing, not a conservative estimate.
noQtyNote = `This line is parsed as "${line.unit}", but its reference entry is per "${entry.unitBasis.unit}" — these can't be converted automatically, so no figure is shown (and it's excluded from the totals above). Fix the parsed unit above, pick a substitute assessed in a compatible unit, or edit the entry's own basis in Ingredient Reference.`;
} else if (!dropped) {
// A line with no stated quantity (an "optional" ingredient, or a vague
// "to taste") still has FODMAP content worth knowing about -- confirmed
// live gap: an ingredient like this showed its allergens (a boolean
// presence, needing no quantity) but silently showed NO FODMAP chips
// at all, since the scaled figure had nothing to scale BY. Falls back
// to the entry's own reference amount (scale 1) rather than omitting
// entirely, clearly flagged as unscaled since it isn't this line's
// real amount.
const hasQty = portionQty != null && entry.unitBasis.quantity > 0;
// unitRatio is guaranteed non-null here -- this whole branch only runs
// when !unitMismatch (the unitMismatch case above returns before this
// point), so either the units matched exactly (ratio 1) or a real
// bridge was found via unitWeights.
const scale = hasQty ? (portionQty * unitRatio) / entry.unitBasis.quantity : 1;
if (!hasQty) noQtyNote = `No quantity given for this line — shown at the reference amount (${entry.unitBasis.quantity}${entry.unitBasis.unit}), not scaled to what's actually used here.`;
// The actual grams of each carbohydrate THIS PORTION contributes --
// concentration (entry.fodmapGrams, per its own unitBasis) scaled by
// how much of the ingredient this portion actually uses. Sound at
// ANY quantity, unlike trying to interpolate a pre-assigned category
// down (the old approach): this is the same real chemistry the
// recipe-level total (computeRecipeDiet) sums across ingredients.
chips = FODMAP_COMPONENTS.map((k) => {
const grams = (entry.fodmapGrams[k] || 0) * scale;
const category = (k === 'fructans' || k === 'gos') ? entry.oligoCategory : 'any';
const level = fodmapLevelFromGrams(k, grams, category);
// Tracks the worst level actually reached, INCLUDING 'low' -- a real
// bug caught live: this used to only ever record 'moderate'/'high',
// so an ingredient rated 'low' across the board (white onion, at a
// small enough portion) never made needsOverride true below, hiding
// its substitute/reduce/drop control even though it's a genuinely
// FODMAP-relevant ingredient worth being able to act on.
if (level === 'high') worstLevel = 'high';
else if (level === 'moderate' && worstLevel !== 'high') worstLevel = 'moderate';
else if (level === 'low' && worstLevel === 'none') worstLevel = 'low';
// "Cut by Xg/portion to reach a lower rating" -- given this
// ingredient's own concentration (grams of the compound per unit of
// the ingredient, held constant), solve for how much LESS of it
// would land the contribution just under the next threshold down.
// Only offered with a REAL portion quantity to cut down from.
let cutNote = '';
if (hasQty && (level === 'moderate' || level === 'high') && entry.fodmapGrams[k] > 0) {
const bounds = fodmapBoundsFor(k, category);
const thresholdGrams = (level === 'high' ? bounds[1] : bounds[0]) * THRESHOLD_SAFETY_MARGIN;
// Grams of the compound per 1 LINE unit (not per 1 unitBasis unit) --
// factoring in unitRatio here is what keeps targetQty/cutQty directly
// comparable to portionQty, which is always in the line's own unit.
const gramsPerUnit = (entry.fodmapGrams[k] / entry.unitBasis.quantity) * unitRatio;
const targetQty = thresholdGrams / gramsPerUnit;
const cutQty = portionQty - targetQty;
if (cutQty > 0.01) {
const nextLevel = level === 'high' ? 'moderate' : 'low';
cutNote = ` — cut by about ${cutQty < 1 ? cutQty.toFixed(2) : cutQty.toFixed(1)}${escapeHtml(line.unit)}/portion to reach ${nextLevel}`;
}
}
return `<span class="fodmap-chip level-${level}" title="${escapeHtml(k)}">${escapeHtml(k)}: ${escapeHtml(level)} (${grams < 0.01 ? '<0.01' : grams.toFixed(2)}g)${cutNote}</span>`;
}).join(' ');
}
// The override control only earns its place on a line that actually
// NEEDS one -- a FODMAP component above 'none', an allergen, or a
// dietary flag -- per feedback ("for each medium or high scoring
// fodmap, or allergen..."), broadened to include 'low' once the
// worstLevel tracking bug above was found: a 'low' rating is still a
// real, actionable FODMAP fact about the ingredient, not nothing.
// `!!override` covers the dropped/reduced/sub cases directly (once a
// line has an override at all, its control must stay visible so it can
// be changed back) -- the other three conditions are what make the
// control appear in the FIRST place, before any override exists.
const needsOverride = worstLevel !== 'none' || lineAllergens.length || lineDietaryFlags.length || unitMismatch || !!override;
let overrideHtml = '';
if (needsOverride) {
// A "reduced" override can come from either "less of just this
// ingredient" or "less, accounting for what everything ELSE in the
// recipe already contributes" (see suggestedLowQtyPerPortion vs.
// suggestedLowQtyPerPortionForRecipeTotal) -- override.basis records
// which one was picked, purely so the right option stays highlighted;
// both set the same {mode:'reduced', qty} shape computeRecipeDiet reads.
const mode = override ? (override.mode === 'sub' ? `sub:${override.subName}` : override.mode === 'reduced' ? `reduced-${override.basis || 'line'}` : override.mode) : 'original';
// Built from the ORIGINAL ingredient's own subs, not the currently-
// effective `entry` -- once a substitute is active, `entry` IS that
// substitute, and its own subs are a different list entirely (see
// resolveLineEntry's comment on `originalEntry`). Using the original
// list here is what keeps the active substitute actually matchable as
// `selected` below, rather than silently falling back to "Use as
// written" the moment a swap is made.
const options = [`<option value="original"${mode === 'original' ? ' selected' : ''}>Use as written</option>`]
.concat((originalEntry.subs || []).map((s) => `<option value="sub:${escapeHtml(s.name)}"${mode === `sub:${s.name}` ? ' selected' : ''}>Substitute: ${escapeHtml(s.name)}${s.note ? ` (${escapeHtml(s.note)})` : ''}</option>`))
// "Use less" needs a real, correctly-scaled quantity to suggest a
// target FROM -- meaningless on a unit-mismatched line (there's no
// valid scale to compute against), so it's left out entirely rather
// than offering a control that can't actually do its job.
.concat(unitMismatch ? [] : [
`<option value="reduced-line"${mode === 'reduced-line' ? ' selected' : ''}>Use less (this ingredient to low)…</option>`,
`<option value="reduced-recipe"${mode === 'reduced-recipe' ? ' selected' : ''}>Use less (whole recipe to low)…</option>`,
])
.concat([`<option value="dropped"${mode === 'dropped' ? ' selected' : ''}>Drop from analysis</option>`]).join('');
overrideHtml = `<div style="margin-top:4px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
<select data-line-override-mode="${i}" data-line-recipe="${r.id}" style="font-size:12px;">${options}</select>
${override && override.mode === 'reduced' ? `<input type="number" step="any" min="0" data-line-override-qty="${i}" data-line-recipe="${r.id}" value="${override.qty}" style="width:70px;font-size:12px;"> ${escapeHtml(line.unit)}/portion` : ''}
</div>`;
}
return `<div style="padding:4px 0;border-top:1px solid var(--line);${dropped ? 'opacity:.55;' : ''}">
<div style="font-size:12px;">${label} — ${used}</div>
${flagsNote}
${chips ? `<div>${chips}</div>` : ''}
${noQtyNote ? `<div class="settings-note">${escapeHtml(noQtyNote)}</div>` : ''}
${overrideHtml}
</div>`;
}).join('');
if (!rows) return '';
return `<div class="field-block" style="margin-top:6px;">
<span class="field-label">Ingredients — FODMAP, allergens, and substitute/reduce options</span>
<div class="settings-note">Grams of the actual carbohydrate this PORTION contributes, compared against fixed published thresholds -- genuinely valid at any quantity, and additive with the other ingredients (the totals above are the real sum, not a worst-case guess). Edit the entry in Ingredient Reference if the underlying concentration looks wrong.</div>
${rows}
</div>`;
}

// Nothing rendered at all until "Analyse ingredients" has been run once
// AND every line resolves -- the load-bearing requirement that a recipe
// nobody's touched this feature on looks exactly like it always did.
// True when some ingredient on this recipe has a reference entry that
// EXISTS but predates dietary-flag and/or unit-weight checks (see
// state.js's migration) -- distinct from "no entry at all"
// (recipeIngredientsStatusHtml/the "Analyse ingredients" link below
// handle that case). Needed because once every line resolves to SOME
// entry, computeRecipeDiet stops returning null and that link
// disappears entirely -- with nothing left prompting a re-check, a
// stale entry would otherwise never get filled in (confirmed live:
// chorizo's Pork/Meat/Animal-product flags stayed blank forever with no
// way to trigger a refresh -- unit weights have the exact same gap).
function recipeHasStaleReference(r) {
return r.ingredientData.some((line) => {
if (!line.name) return false;
const entry = findReferenceEntry(line.name, line.form);
// A userEdited entry's own stale flags (if any lingered from before
// it was ever corrected) can no longer be cleared by "refresh" --
// needsAssessment/ensureReferenceEntry now both skip a userEdited
// entry outright -- so there's no point offering a link that would
// silently do nothing; the actual fix is editing the entry directly.
return entry && !entry.userEdited && (entry.dietaryFlagsStale || entry.unitWeightsStale);
});
}

function recipeDietHtml(r) {
if (busyIngredientAction.has(r.id)) return ''; // recipeIngredientsStatusHtml already shows the busy indicator, right above this
if (!r.ingredientsParsedAt) return '';
const diet = computeRecipeDiet(r);
if (!diet) return `<div class="full"><span class="inline-goto-link" data-recipe-analyse="${r.id}">Analyse ingredients</span></div>`;
const changes = describeLineOverrides(r);
const per = r.servings ? r.servings : null;
const row = (label, key, unit) => `<div style="display:flex;justify-content:space-between;font-size:12px;padding:2px 0;"><span>${escapeHtml(label)}</span><span>${diet.totals[key].toFixed(1)}${unit}${per ? ` (${(diet.totals[key] / per).toFixed(1)}${unit}/serving)` : ''}</span></div>`;
return `<div class="full">
<button class="overview-panel-toggle" type="button" data-recipe-diet-toggle="${r.id}">${expandedDiet.has(r.id) ? '▾ Hide diet analysis' : '▸ Show diet analysis'}</button>
${expandedDiet.has(r.id) ? `${recipeHasStaleReference(r) ? `<div class="settings-note" style="margin-top:6px;">Some ingredients predate dietary-flag checks (kosher/halal/vegetarian/vegan) and/or known unit weights ("medium onion" = how many grams) — <span class="inline-goto-link" data-recipe-analyse="${r.id}">refresh</span> to fill them in.</div>` : ''}
${diet.unmatchedLines.length ? `<div class="settings-note" style="margin-top:6px;">Totals below EXCLUDE ${diet.unmatchedLines.length} ingredient${diet.unmatchedLines.length === 1 ? '' : 's'} whose parsed unit doesn't match its reference entry's own basis (never guessed automatically): ${diet.unmatchedLines.map(({ line, entry }) => `${escapeHtml(line.name)} ("${escapeHtml(line.unit)}" vs "${escapeHtml(entry.unitBasis.unit)}")`).join(', ')}. See the ingredient list below to fix the parsed unit, or edit the entry's basis in Ingredient Reference.</div>` : ''}
<div class="field-block" style="margin-top:6px;">
<span class="field-label">FODMAP (per component) — summed across ingredients${per ? `, per portion (${per})` : ' -- set Servings above for a true per-portion figure; this is the whole-recipe total'}</span>
<div>${fodmapRowHtml(diet.fodmap, diet.fodmapGrams)}</div>
</div>
<div class="field-block" style="margin-top:6px;">
<span class="field-label">Allergens</span>
<div>${flagListHtml(ALLERGEN_LIST, diet.allergens)}</div>
</div>
<div class="field-block" style="margin-top:6px;">
<span class="field-label">Also worth knowing <span class="settings-note">kosher/halal/vegetarian/vegan-relevant facts, assessed the same way as allergens</span></span>
<div>${flagListHtml(DIETARY_FLAGS, diet.dietaryFlags)}</div>
</div>
${recipeIngredientAnalysisHtml(r)}
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
${changes.length ? `<div class="field-block full" style="margin-top:6px;">
<span class="field-label">Make it like this</span>
<div class="settings-note">The substitute/reduce/drop choices above are exploration only -- nothing is saved to this recipe until you do this:</div>
<div class="settings-note">${changes.map(escapeHtml).join('<br>')}</div>
<button class="add-btn" type="button" data-recipe-regenerate="${r.id}" style="margin-top:6px;">Save as a new recipe with these changes</button>
</div>` : ''}
<div class="settings-note" style="margin-top:6px;">AI estimate from the ingredient reference table — not a verified nutritional or medical analysis; correct an entry below directly if it looks wrong.</div>` : ''}
</div>`;
}

// ---- shared ingredient reference panel -- collapsed by default, absent
// entirely (the whole index.html section hidden, see renderIngredientReference)
// until the first ingredient is ever analysed ----
let editingReferenceId = null;
// The entry currently showing its "Merge into…" picker (see
// ingredientRefRowHtml/mergeIngredientEntries) -- null when none is.
let mergingReferenceId = null;

function ingredientRefEditHtml(e) {
const macroInput = (label, key) => `<label>${escapeHtml(label)}<input type="number" step="any" data-ref-nutrition="${key}" value="${e.nutrition[key]}"></label>`;
// Grams of the actual FODMAP carbohydrate (fructans, GOS, lactose, excess
// fructose, polyols) per the unit basis above -- NOT a low/moderate/high
// category any more (see js/ai.js's FODMAP_THRESHOLDS_G/fodmapLevelFromGrams);
// the level shown elsewhere is always DERIVED from this figure against
// fixed published thresholds, never set directly.
const fodmapInput = (key) => `<label>${escapeHtml(key)} (g)<input type="number" step="any" min="0" data-ref-fodmap="${key}" value="${e.fodmapGrams[key]}"></label>`;
return `<div class="idea-row" data-ingredient-ref-row="${e.id}">
<div class="idea-top"><span class="idea-title">Editing: ${escapeHtml(e.name)}${e.form ? ` (${escapeHtml(e.form)})` : ''}</span>
<span class="idea-date">per ${e.unitBasis.quantity}${escapeHtml(e.unitBasis.unit)}</span></div>
<div class="tinder-fields" style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
${macroInput('Calories', 'calories')}${macroInput('Protein (g)', 'protein')}
${macroInput('Carbs (g)', 'carbs')}${macroInput('— sugars (g)', 'sugars')}
${macroInput('Fat (g)', 'fat')}${macroInput('— saturates (g)', 'saturates')}
${macroInput('Fibre (g)', 'fibre')}${macroInput('Salt (g)', 'salt')}
</div>
<label class="full">Fructan/GOS table <span class="settings-note">which published threshold window this ingredient's fructans/GOS are judged against</span>
<select data-ref-oligo>${OLIGO_CATEGORIES.map((c) => `<option value="${c}" ${e.oligoCategory === c ? 'selected' : ''}>${c === 'grain_legume_nut' ? 'Grain / legume / nut (wider window)' : 'Vegetable / fruit (narrower window)'}</option>`).join('')}</select>
</label>
<div class="tinder-fields" style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
${FODMAP_COMPONENTS.map(fodmapInput).join('')}
</div>
<div class="settings-note">Grams of the actual carbohydrate per ${e.unitBasis.quantity}${escapeHtml(e.unitBasis.unit)} -- e.g. tinned chickpeas typically hold less GOS than dried/cooked, since some leaches into the tinning liquid.</div>
<label class="full">Allergens present<div class="tag-editor">${ALLERGEN_LIST.map((a) => `<span class="pick-chip${e.allergens.includes(a) ? ' active' : ''}" data-ref-allergen="${escapeHtml(a)}">${escapeHtml(a)}</span>`).join('')}</div></label>
<label class="full">Also worth knowing <span class="settings-note">kosher/halal/vegetarian/vegan-relevant facts, checked the same way as allergens</span>
<div class="tag-editor">${DIETARY_FLAGS.map((a) => `<span class="pick-chip${e.dietaryFlags.includes(a) ? ' active' : ''}" data-ref-dietary="${escapeHtml(a)}">${escapeHtml(a)}</span>`).join('')}</div></label>
<label class="full">Substitutes <span class="settings-note">what a recipe's per-line "Substitute:" option offers -- add one if AI didn't find any</span>
<div class="tag-editor">
${e.subs.map((s, si) => `<span class="tag-chip">${escapeHtml(s.name)}${s.note ? ` — ${escapeHtml(s.note)}` : ''}<span class="tag-x" data-ingredient-ref-sub-remove="${e.id}" data-sub-idx="${si}">&times;</span></span>`).join('')}
<input type="text" autocomplete="off" class="tag-add-input" placeholder="substitute name" data-ingredient-ref-sub-name="${e.id}" style="width:130px;">
<input type="text" autocomplete="off" class="tag-add-input" placeholder="note (optional)" data-ingredient-ref-sub-note="${e.id}" style="width:160px;">
<button type="button" class="todo-add-btn" data-ingredient-ref-sub-add="${e.id}" style="padding:3px 8px;">+</button>
</div></label>
<label class="full">Other units <span class="settings-note">how many grams ONE of another unit weighs -- e.g. "medium" = 110 for a medium onion, "tsp" = 5 for a tsp of this -- lets a recipe parsed in a different unit than "per ${e.unitBasis.quantity}${escapeHtml(e.unitBasis.unit)}" above still be scaled correctly instead of excluded as a unit mismatch</span>
<div class="tag-editor">
${Object.keys(e.unitWeights).sort().map((u) => `<span class="tag-chip">${escapeHtml(u)} = ${e.unitWeights[u]}g<span class="tag-x" data-ingredient-ref-unitweight-remove="${e.id}" data-unit="${escapeHtml(u)}">&times;</span></span>`).join('')}
<input type="text" autocomplete="off" class="tag-add-input" placeholder="unit (e.g. medium)" data-ingredient-ref-unitweight-name="${e.id}" style="width:110px;">
<input type="number" step="any" min="0" autocomplete="off" class="tag-add-input" placeholder="grams" data-ingredient-ref-unitweight-grams="${e.id}" style="width:80px;">
<button type="button" class="todo-add-btn" data-ingredient-ref-unitweight-add="${e.id}" style="padding:3px 8px;">+</button>
</div></label>
<div class="idea-actions">
<button class="add-btn" type="button" data-ingredient-ref-save="${e.id}">Save</button>
<span class="inline-goto-link" data-ingredient-ref-cancel="1">Cancel</span>
</div>
</div>`;
}

// Folds `sourceId` into `targetId`: every future lookup of the source
// entry's own (name, form) resolves straight to the target instead (see
// findReferenceEntry's alias check), and the source entry itself is
// removed -- it's now redundant, since nothing will ever match it
// directly again. Deliberately doesn't try to combine the two entries'
// own data (subs, unitWeights, nutrition...) -- keeping ONLY the
// target's figures is the simplest rule to actually predict, and the
// confirm dialog says so explicitly before it happens. Never automatic
// (see state.js's own comment on data.ingredientAliases) -- always one
// person's own explicit choice between two entries they picked.
function mergeIngredientEntries(sourceId, targetId) {
const source = data.ingredientReference.find((e) => e.id === sourceId);
const target = data.ingredientReference.find((e) => e.id === targetId);
if (!source || !target || source.id === target.id) return;
if (!confirm(`Merge "${source.name}" into "${target.name}"? Every recipe using "${source.name}" will use "${target.name}"'s figures from now on -- "${source.name}"'s own entry (and anything different about it) will be removed.`)) return;
data.ingredientAliases[aliasKeyOf(source.name, source.form)] = target.id;
data.ingredientReference = data.ingredientReference.filter((e) => e.id !== sourceId);
mergingReferenceId = null;
renderIngredientReference();
renderRecipes();
queueSave();
}

function ingredientRefRowHtml(e) {
if (editingReferenceId === e.id) return ingredientRefEditHtml(e);
const unitWeightKeys = Object.keys(e.unitWeights);
const mergePicker = mergingReferenceId === e.id ? `<div style="margin-top:4px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
<select data-ingredient-ref-merge-target="${e.id}" style="font-size:12px;">
<option value="">Merge into…</option>
${[...data.ingredientReference].filter((o) => o.id !== e.id).sort((a, b) => a.name.localeCompare(b.name)).map((o) => `<option value="${o.id}">${escapeHtml(o.name)}${o.form ? ` (${escapeHtml(o.form)})` : ''}</option>`).join('')}
</select>
<span class="inline-goto-link" data-ingredient-ref-merge-cancel="1">Cancel</span>
</div>` : '';
return `<div class="idea-row" data-ingredient-ref-row="${e.id}">
<div class="idea-top"><span class="idea-title">${escapeHtml(e.name)}${e.form ? ` (${escapeHtml(e.form)})` : ''}</span>
<span class="idea-date">per ${e.unitBasis.quantity}${escapeHtml(e.unitBasis.unit)}${e.userEdited ? ' · edited' : ''}</span></div>
<div class="settings-note">Cal ${e.nutrition.calories} · Protein ${e.nutrition.protein}g · Carbs ${e.nutrition.carbs}g · Fat ${e.nutrition.fat}g · Fibre ${e.nutrition.fibre}g · Salt ${e.nutrition.salt}g</div>
<div>${fodmapRowHtml(entryFodmapLevels(e), e.fodmapGrams)}</div>
${e.allergens.length ? `<div class="settings-note">Allergens: ${e.allergens.map(escapeHtml).join(', ')}</div>` : ''}
${e.dietaryFlags.length ? `<div class="settings-note">Also: ${e.dietaryFlags.map(escapeHtml).join(', ')}</div>` : ''}
${e.subs.length ? `<div class="settings-note">Substitutes: ${e.subs.map((s) => `${escapeHtml(s.name)}${s.note ? ` (${escapeHtml(s.note)})` : ''}`).join('; ')}</div>` : ''}
${unitWeightKeys.length ? `<div class="settings-note">Also scales for: ${unitWeightKeys.sort().map((u) => `${escapeHtml(u)} (${e.unitWeights[u]}g)`).join(', ')}</div>` : ''}
<div class="idea-actions">
<span class="inline-goto-link" data-ingredient-ref-edit="${e.id}">Edit</span>
<span class="inline-goto-link" data-ingredient-ref-merge="${e.id}">Merge into…</span>
<span class="del-x" style="opacity:1;" data-ingredient-ref-del="${e.id}">&times;</span>
</div>
${mergePicker}
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
// Merged names -- the alias itself no longer has its own row (it was
// removed by the merge), so this is the only place it's visible at all
// afterward, and the only way to undo one (deleting the alias just
// means that name gets a completely fresh AI assessment next time it's
// used, same as any other never-seen ingredient).
const aliasKeys = Object.keys(data.ingredientAliases);
const aliasesHtml = aliasKeys.length ? `<div class="field-block" style="margin-top:6px;">
<span class="field-label">Merged names</span>
${aliasKeys.map((key) => {
const targetId = data.ingredientAliases[key];
const target = data.ingredientReference.find((e) => e.id === targetId);
const aliasName = key.split('|')[0];
return `<div class="settings-note">${escapeHtml(aliasName)} &rarr; ${target ? escapeHtml(target.name) : '(deleted)'} <span class="inline-goto-link" data-ingredient-ref-unmerge="${escapeHtml(key)}">undo</span></div>`;
}).join('')}
</div>` : '';
el.innerHTML = referencePanelCollapsed ? toggleHtml
: `${toggleHtml}${aliasesHtml}<div style="margin-top:6px;">${[...data.ingredientReference].sort((a, b) => a.name.localeCompare(b.name)).map(ingredientRefRowHtml).join('')}</div>`;

document.getElementById('ingredient-reference-toggle').addEventListener('click', () => {
referencePanelCollapsed = !referencePanelCollapsed;
renderIngredientReference();
});
el.querySelectorAll('[data-ingredient-ref-unmerge]').forEach((x) => {
x.addEventListener('click', () => {
delete data.ingredientAliases[x.dataset.ingredientRefUnmerge];
renderIngredientReference();
renderRecipes();
queueSave();
});
});
el.querySelectorAll('[data-ingredient-ref-edit]').forEach((x) => {
x.addEventListener('click', () => { editingReferenceId = x.dataset.ingredientRefEdit; renderIngredientReference(); });
});
el.querySelectorAll('[data-ingredient-ref-cancel]').forEach((x) => {
x.addEventListener('click', () => { editingReferenceId = null; renderIngredientReference(); });
});
el.querySelectorAll('[data-ingredient-ref-merge]').forEach((x) => {
x.addEventListener('click', () => { mergingReferenceId = mergingReferenceId === x.dataset.ingredientRefMerge ? null : x.dataset.ingredientRefMerge; renderIngredientReference(); });
});
el.querySelectorAll('[data-ingredient-ref-merge-cancel]').forEach((x) => {
x.addEventListener('click', () => { mergingReferenceId = null; renderIngredientReference(); });
});
el.querySelectorAll('[data-ingredient-ref-merge-target]').forEach((select) => {
select.addEventListener('change', () => {
if (select.value) mergeIngredientEntries(select.dataset.ingredientRefMergeTarget, select.value);
});
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
el.querySelectorAll('[data-ref-dietary]').forEach((chip) => {
chip.addEventListener('click', () => chip.classList.toggle('active'));
});
// Substitutes commit immediately (add/remove), same as a recipe's own
// Tags editor -- unlike the macro/FODMAP/allergen fields above, which
// batch until Save, there's no natural "pending" state for a list where
// re-rendering after every change is exactly what confirms it worked.
// Doesn't set userEdited -- adding a substitute isn't correcting the
// AI's own nutrition/FODMAP assessment, so it shouldn't block a future
// re-assessment of THOSE figures the way an actual correction should.
el.querySelectorAll('[data-ingredient-ref-sub-remove]').forEach((x) => {
x.addEventListener('click', () => {
const e = data.ingredientReference.find((r2) => r2.id === x.dataset.ingredientRefSubRemove);
if (!e) return;
e.subs.splice(parseInt(x.dataset.subIdx, 10), 1);
renderIngredientReference();
renderRecipes();
queueSave();
});
});
el.querySelectorAll('[data-ingredient-ref-sub-add]').forEach((btn) => {
btn.addEventListener('click', () => {
const e = data.ingredientReference.find((r2) => r2.id === btn.dataset.ingredientRefSubAdd);
if (!e) return;
const row = btn.closest('[data-ingredient-ref-row]');
const nameInput = row.querySelector('[data-ingredient-ref-sub-name]');
const noteInput = row.querySelector('[data-ingredient-ref-sub-note]');
const name = nameInput.value.trim();
if (!name) return;
e.subs.push({ id: uid(), name, note: noteInput.value.trim() });
renderIngredientReference();
renderRecipes();
queueSave();
});
});
// Other-unit weights, same immediate-commit shape as Substitutes just
// above -- also doesn't set userEdited, for the same reason (adding a
// unit weight isn't correcting the nutrition/FODMAP figures).
el.querySelectorAll('[data-ingredient-ref-unitweight-remove]').forEach((x) => {
x.addEventListener('click', () => {
const e = data.ingredientReference.find((r2) => r2.id === x.dataset.ingredientRefUnitweightRemove);
if (!e) return;
delete e.unitWeights[x.dataset.unit];
// Touching this list by hand IS the real check unitWeightsStale
// exists to ensure happens -- same reasoning as the main Save
// handler clearing dietaryFlagsStale, so a later background refresh
// never silently re-adds back a unit the user deliberately removed.
delete e.unitWeightsStale;
e.unitWeightsAssessedAt = new Date().toISOString();
renderIngredientReference();
renderRecipes();
queueSave();
});
});
el.querySelectorAll('[data-ingredient-ref-unitweight-add]').forEach((btn) => {
btn.addEventListener('click', () => {
const e = data.ingredientReference.find((r2) => r2.id === btn.dataset.ingredientRefUnitweightAdd);
if (!e) return;
const row = btn.closest('[data-ingredient-ref-row]');
const nameInput = row.querySelector('[data-ingredient-ref-unitweight-name]');
const gramsInput = row.querySelector('[data-ingredient-ref-unitweight-grams]');
const unit = nameInput.value.trim().toLowerCase();
const grams = parseFloat(gramsInput.value);
if (!unit || !Number.isFinite(grams) || grams <= 0) return;
e.unitWeights[unit] = grams;
delete e.unitWeightsStale;
e.unitWeightsAssessedAt = new Date().toISOString();
renderIngredientReference();
renderRecipes();
queueSave();
});
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
row.querySelectorAll('[data-ref-fodmap]').forEach((input) => {
const v = parseFloat(input.value);
e.fodmapGrams[input.dataset.refFodmap] = Number.isFinite(v) && v >= 0 ? v : 0;
});
const oligoSelect = row.querySelector('[data-ref-oligo]');
if (oligoSelect) e.oligoCategory = OLIGO_CATEGORIES.includes(oligoSelect.value) ? oligoSelect.value : 'veg_fruit';
e.allergens = [...row.querySelectorAll('[data-ref-allergen].active')].map((chip) => chip.dataset.refAllergen);
e.dietaryFlags = [...row.querySelectorAll('[data-ref-dietary].active')].map((chip) => chip.dataset.refDietary);
// Saving this form IS the real check dietaryFlagsStale exists to
// ensure happens -- clearing it here (not just setting userEdited,
// which ensureReferenceEntry's merge-refresh now also respects as a
// belt-and-suspenders guard) is what stops a later "Analyse
// ingredients" elsewhere from silently re-running an AI check that
// would overwrite what was just manually confirmed. Real gap caught
// while building unitWeights: this line was missing entirely before,
// so a correction made here could still get quietly clobbered later.
delete e.dietaryFlagsStale;
e.dietaryAssessedAt = new Date().toISOString();
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
${recipeVariantSourceHtml(r)}
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
el.querySelectorAll('[data-recipe-regenerate]').forEach((btn) => {
btn.addEventListener('click', () => regenerateVariant(btn.dataset.recipeRegenerate));
});
// Record-reference convention: expand the source card and scroll+flash
// it into view, same shape as every other in-app cross-reference.
el.querySelectorAll('[data-recipe-goto]').forEach((link) => {
link.addEventListener('click', () => {
const id = link.dataset.recipeGoto;
activeMadeFilter = null;
activeTagFilter = null;
expandedRecipe = id;
renderRecipes();
renderRecipeOverview();
setTimeout(() => scrollAndFlash(`[data-recipe-row="${id}"]`), 0);
});
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
el.querySelectorAll('[data-line-override-mode]').forEach((select) => {
select.addEventListener('change', async () => {
const recipeId = select.dataset.lineRecipe;
const idx = parseInt(select.dataset.lineOverrideMode, 10);
const r = data.recipes.find((x) => x.id === recipeId);
if (!r) return;
if (!lineOverrides.has(recipeId)) lineOverrides.set(recipeId, new Map());
const map = lineOverrides.get(recipeId);
const val = select.value;
if (val === 'original') { map.delete(idx); renderRecipes(); return; }
if (val === 'dropped') { map.set(idx, { mode: 'dropped' }); renderRecipes(); return; }
if (val === 'reduced-line' || val === 'reduced-recipe') {
const line = r.ingredientData[idx];
// Resolved (not a raw findReferenceEntry lookup) so this picks up
// whatever entry is CURRENTLY effective for this line (e.g. mid-
// substitute) and its unitRatio, consistently with everything else
// that reads this line.
const resolved = line && resolveLineEntry(r, line, idx);
const entry = resolved && resolved.entry;
const asWrittenPortion = line && line.quantity != null ? (r.servings ? line.quantity / r.servings : line.quantity) : 0;
// Two different targets for "less" -- this ingredient's OWN
// concentration alone (suggestedLowQtyPerPortion) vs. accounting for
// what every OTHER ingredient in the recipe already contributes to
// the same components (suggestedLowQtyPerPortionForRecipeTotal).
// FODMAP grams stack across a recipe, so a line that's individually
// "low" can still leave the recipe TOTAL moderate/high -- confirmed
// live gap: "doesn't target recipe level low levels (stacking)".
const suggested = !entry || resolved.unitMismatch ? null
: val === 'reduced-line' ? suggestedLowQtyPerPortion(entry, resolved.unitRatio)
: suggestedLowQtyPerPortionForRecipeTotal(r, idx, entry);
// A default that's actually a reduction -- the smaller of the as-
// written amount and the suggested "reach low" target, so picking
// this from a line that's already fine doesn't paradoxically suggest
// using MORE of it.
const qty = suggested != null ? Math.min(suggested, asWrittenPortion) : asWrittenPortion;
map.set(idx, { mode: 'reduced', qty: Math.max(0, qty), basis: val === 'reduced-line' ? 'line' : 'recipe' });
renderRecipes();
return;
}
if (val.startsWith('sub:')) {
const subName = val.slice(4);
map.set(idx, { mode: 'sub', subName });
// Flipping to a substitute is pure arithmetic over cached figures
// (computeRecipeDiet) ONLY once the substitute has its OWN reference
// entry -- the first time a given substitute is picked, nothing has
// assessed IT yet (only the original ingredient gets assessed by
// "Analyse ingredients"). Same busy-indicator treatment as Parse/
// Analyse -- this is a real AI call the first time, not instant.
if (needsAssessment(subName, '')) {
busyIngredientAction.set(recipeId, `Assessing substitute: ${subName}…`);
renderRecipes();
try {
await ensureReferenceEntry(subName, '');
} catch (err) {
setStatus(err instanceof MissingKeyError ? 'Add an Anthropic API key in Settings first.' : `Couldn't assess that substitute: ${err.message || err}`);
map.delete(idx); // revert -- a selection left pointing at an unresolved substitute would look identical to a fixed bug
} finally {
busyIngredientAction.delete(recipeId);
}
renderIngredientReference();
queueSave();
}
renderRecipes();
}
});
});
el.querySelectorAll('[data-line-override-qty]').forEach((input) => {
input.addEventListener('change', () => {
const recipeId = input.dataset.lineRecipe;
const idx = parseInt(input.dataset.lineOverrideQty, 10);
if (!lineOverrides.has(recipeId)) lineOverrides.set(recipeId, new Map());
const map = lineOverrides.get(recipeId);
const v = parseFloat(input.value);
const prevBasis = (map.get(idx) || {}).basis; // preserve which "less" option is shown selected after a manual tweak
map.set(idx, { mode: 'reduced', qty: Number.isFinite(v) && v >= 0 ? v : 0, basis: prevBasis });
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
