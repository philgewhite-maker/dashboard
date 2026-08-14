// Menu tab: recipes imported from a photo, a PDF, or a web page, rated on
// the same configurable-star mechanism as Connections (a distinct category
// list — Taste/Health/Prep by default — not the same list, just the same
// idea), with an occasional nudge to actually cook one of them.
import { data, queueSave, DEFAULT_RECIPE_RATING_CATEGORIES, slugifyField, averageRating } from '../state.js';
import { photoDelete, photoGet } from '../db.js';
import { escapeHtml, uid, todayStr, resizeImageToBlob } from '../utils.js';
import { MissingKeyError, extractRecipeFromImage, extractRecipeFromPdf, extractRecipeFromHtml } from '../ai.js';
import { storePhoto } from '../files.js';
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

let pending = null; // {name, ingredients, instructions, notes, sourceKind, sourceUrl}

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

function saveReview() {
const name = document.getElementById('recipe-review-name').value.trim();
if (!name) return;
const recipe = {
id: uid(), name,
ingredients: document.getElementById('recipe-review-ingredients').value.split('\n').map((s) => s.trim()).filter(Boolean),
instructions: document.getElementById('recipe-review-instructions').value.split('\n').map((s) => s.trim()).filter(Boolean),
notes: document.getElementById('recipe-review-notes').value.trim(),
source: { kind: pending.sourceKind, url: pending.sourceUrl || '' },
photoId: null, photoIds: [], photoAlbums: [], ratings: {}, tags: [],
createdAt: new Date().toISOString(), lastMade: '',
};
data.recipes.push(recipe);
pending = null;
renderReview();
renderRecipes();
queueSave();
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
if (!photoInput) return;

photoInput.addEventListener('change', async (e) => {
const file = e.target.files[0];
e.target.value = '';
if (!file) return;
setStatus('Reading the photo…');
try {
const extract = await extractRecipeFromImage(file);
pending = { ...extract, sourceKind: 'a photo' };
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
pending = { ...extract, sourceKind: 'a PDF' };
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

function recipeCardHtml(r) {
const avg = averageRating(r, data.recipeRatingCategories);
const open = expandedRecipe === r.id;
return `<div class="recipe-card">
<div class="recipe-row">
${r.photoId ? `<span class="thumb-img" data-photo-id="${escapeHtml(r.photoId)}"></span>` : '<span class="thumb-img recipe-noimg"></span>'}
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

function recipeDetailHtml(r) {
return `<div class="recipe-detail">
<label class="full">Name<input type="text" autocomplete="off" data-recipe-field="name" data-recipe-id="${r.id}" value="${escapeHtml(r.name)}"></label>
<label class="full">Ingredients (one per line)<textarea rows="6" data-recipe-field="ingredients" data-recipe-id="${r.id}">${escapeHtml(r.ingredients.join('\n'))}</textarea></label>
<label class="full">Instructions (one step per line)<textarea rows="8" data-recipe-field="instructions" data-recipe-id="${r.id}">${escapeHtml(r.instructions.join('\n'))}</textarea></label>
<label class="full">Notes<textarea rows="2" data-recipe-field="notes" data-recipe-id="${r.id}">${escapeHtml(r.notes || '')}</textarea></label>
<label class="full">Google Photos album (paste a share link — of the finished dish, an occasion it was made for, whatever)
<input type="text" autocomplete="off" placeholder="https://photos.google.com/album/…" data-recipe-album="${r.id}" value="${escapeHtml((r.photoAlbums[0] || {}).url || '')}"></label>
${(r.photoAlbums[0] || {}).url ? `<div class="full"><a href="${escapeHtml(r.photoAlbums[0].url)}" target="_blank" rel="noopener" style="font-size:12px;color:var(--rose);">Open album &#8599;</a></div>` : ''}
<label class="full">Ratings<div class="ratings-block">${data.recipeRatingCategories.map(({ field, label }) => recipeRatingStars(label, field, r.id, (r.ratings && r.ratings[field]) || 0)).join('')}</div></label>
<div class="task-photos">
${r.photoIds.map((id, i) => `<div class="gallery-thumb"><span class="thumb-img" data-photo-id="${escapeHtml(id)}"></span><span class="tag-x" data-recipe-photo-remove="${r.id}" data-photo-idx="${i}">&times;</span></div>`).join('')}
<label class="gallery-add" for="recipe-photo-add-${r.id}">+</label>
<input type="file" id="recipe-photo-add-${r.id}" accept="image/*" multiple style="display:none;" data-recipe-photo-add="${r.id}">
</div>
<div class="sync-row" style="margin-top:8px;">
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

function renderRecipes() {
const el = document.getElementById('recipe-list');
if (!el) return;
const count = document.getElementById('recipe-count');
if (count) count.textContent = data.recipes.length ? `${data.recipes.length} recipe${data.recipes.length === 1 ? '' : 's'}` : '';
el.innerHTML = suggestionHtml()
+ (data.recipes.length === 0
? '<div class="empty">No recipes yet — import one above.</div>'
: [...data.recipes].sort((a, b) => a.name.localeCompare(b.name)).map(recipeCardHtml).join(''));

import('../utils.js').then((u) => u.hydratePhotos(el));

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
queueSave();
});
});
el.querySelectorAll('[data-recipe-del]').forEach((x) => {
x.addEventListener('click', async () => {
const r = data.recipes.find((rec) => rec.id === x.dataset.recipeDel);
if (!r) return;
if (!confirm(`Delete "${r.name}"? This can't be undone.`)) return;
for (const pid of r.photoIds) await photoDelete(pid).catch(() => {});
data.recipes = data.recipes.filter((rec) => rec.id !== r.id);
renderRecipes();
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

function initRecipes() {
initCapture();
initRecipeRatingCategoriesSettings();
renderReview();
renderRecipes();
}

export { initRecipes };
