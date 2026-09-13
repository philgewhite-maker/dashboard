// The single "what can a capture become" registry. Every routing
// mechanism in the app -- shareUrlRules' host/path inference
// (sharetarget.js), the explicit imageMarker/urlSuffix captureRules
// below, and whatever gets added later (a Google Tasks list-name
// mapping, a voice-intent router) -- looks an outcome key up here rather
// than each keeping its own copy. Adding a new thing a capture can
// become is one more entry in this object; every existing rule editor
// (Settings' "Shared-link auto-routing" and "Capture markers &
// suffixes") lists whatever's registered automatically.
//
// `run(ctx)` throws on failure -- every caller already has a uniform
// "throws -> fall back to a plain task carrying the source and the
// error" contract (see sharetarget.js), so an outcome never needs its
// own bespoke failure path. `ctx` is the one normalised shape covering
// both a link capture and an image capture: {title, notes, url,
// photoIds, source, file}. An outcome only reads the fields it needs
// (recipe only looks at `url`; task/reading use most of the rest).
// `file` is optional and only ever set by captureinbox.js's own
// image-marker call (the raw File is still in scope there, before it's
// reduced to a stored photoId) -- for an outcome like `supermarket`
// that may need to run AI vision on the actual bytes, not just carry a
// reference to them.
//
// Every outcome here is `commitMode: 'direct'` -- it writes a real
// record immediately, same as captureTask() already does, because Task/
// Reading-list/Recipe are all cheap and reversible (or, for Recipe,
// already gated by its own in-memory review draft before Save). A
// richer future outcome (a Trip, a Job application) should be
// `commitMode: 'draft'` and write into a PERSISTED draft queue instead
// of committing outright -- not built yet; noted here so this shape
// doesn't need reworking when one arrives. See the Capture Waterfall
// doc's proposals #3/#4 for why voice in particular needs a persisted
// draft, not an in-memory one: the gap between capturing and reviewing
// can be hours, not seconds.
import { todayStr, dateStrAdd } from '../utils.js';

// Tinder's own share-profile link shape is
// go.tinder.com/<token>-<name> -- the trailing segment after the last
// "-" is the person's first name. Best-effort: any URL that doesn't
// parse or fit that shape just returns null, and the caller falls back
// to whatever else it has (the surrounding message text) rather than
// failing the capture.
function nameFromTinderShareUrl(url) {
  let u;
  try { u = new URL(url); } catch (e) { return null; }
  const slug = u.pathname.split('/').filter(Boolean).pop() || '';
  const name = slug.split('-').pop();
  return name && /[a-z]/i.test(name) ? name : null;
}

const CAPTURE_OUTCOMES = {
task: {
label: 'Task',
commitMode: 'direct',
successBanner: (host) => `Captured to your Inbox${host ? ` from ${host}` : ''}.`,
run: async (ctx) => {
const { captureTask } = await import('./tasks.js');
captureTask({
title: ctx.title || ctx.url || 'Captured item',
notes: ctx.notes || '',
link: ctx.url || '',
photoIds: ctx.photoIds || [],
source: ctx.source || null,
});
},
},
reading: {
label: 'Reading list',
commitMode: 'direct',
successBanner: (host) => `Added to your reading list${host ? ` from ${host}` : ''}.`,
run: async (ctx) => {
const { addToReadingList } = await import('./readinglist.js');
addToReadingList({
title: ctx.title || ctx.url || 'Untitled',
url: ctx.url || '',
notes: ctx.notes || '',
photoIds: ctx.photoIds || [],
source: ctx.source || null,
});
},
},
// Moved from sharetarget.js's own SHARE_ACTIONS (shipped v300) -- pure
// relocation, same importSharedRecipeUrl() call, same throws-on-failure
// contract. Only reads ctx.url.
recipe: {
label: 'Import as a recipe',
commitMode: 'direct', // recipes.js's own pending+review form is the real gate before Save
successBanner: (host) => `Read a recipe from ${host} — review and save it on the Menu tab.`,
run: async (ctx) => {
const { importSharedRecipeUrl } = await import('./recipes.js');
await importSharedRecipeUrl(ctx.url); // throws on any failure -> caller falls back
const { switchTab } = await import('../tabs.js');
switchTab('menu');
},
},
// A shared Tinder profile link, no photo -- not identity-resolved
// enough to be a connection, but Super Likes reached this way stay
// usable for 7 days from capture, so it's worth an actionable
// reminder rather than sitting untriaged. Reuses Task rather than a
// new record type: due date gets the existing overdue/soon badge for
// free, the "Super Like" context makes it a one-click filtered list.
superlike: {
label: 'Super Like candidate',
commitMode: 'direct',
successBanner: () => `Added as a Super Like candidate — 7 days to use it.`,
run: async (ctx) => {
const { captureTask } = await import('./tasks.js');
const { data, queueSave } = await import('../state.js');
const name = nameFromTinderShareUrl(ctx.url) || ctx.title || 'Super Like candidate';
if (!data.taskContexts.includes('Super Like')) {
data.taskContexts.push('Super Like');
queueSave();
}
captureTask({
title: name,
notes: ctx.title && ctx.title !== name ? ctx.title : (ctx.notes || ''),
link: ctx.url || '',
due: dateStrAdd(todayStr(), 7),
contexts: ['Super Like'],
source: ctx.source || null,
});
},
},
// The "I need sudafed / pledge / method floor cleaner" capture: lands
// on the Supermarket list (not a new record type -- same "a shopping
// item is a task like any other" reasoning shopping.js's own top
// comment already establishes), then automatically runs a price check
// so the next time the app's opened there's already a link to buy it
// from the right place -- see shopping.js's runAutoPriceCheck. Named
// `supermarket` specifically, not the vaguer `shopping`: the other
// three SHOPPING_CONTEXTS (Pharmacy, Black Friday, Aspirational
// purchases) are a genuinely different "note it and reconsider in
// months" pattern with no price-comparison urgency -- out of scope for
// this quick-capture path on purpose.
supermarket: {
label: 'Supermarket item',
commitMode: 'direct',
successBanner: () => `Added to your Supermarket list — checking prices…`,
run: async (ctx) => {
const { captureTask } = await import('./tasks.js');
let title = (ctx.title || '').trim();
// Only the image-marker path ever sets ctx.file -- and whatever
// title it carries there is always just a filename/generic fallback
// (captureinbox.js has no real product name to offer), never a real
// one, so ctx.file's presence alone is the signal to identify the
// actual product. Text/voice/URL captures never set ctx.file and
// skip this entirely -- their title is already the real thing.
if (ctx.file) {
try {
const { identifyProduct } = await import('../ai.js');
const identified = await identifyProduct(ctx.file);
if (identified) title = identified;
} catch (err) {
console.error('Product identification failed, falling back to the filename:', err);
}
}
const task = captureTask({
title: title || ctx.url || 'Supermarket item',
notes: ctx.notes || '',
link: ctx.url || '',
photoIds: ctx.photoIds || [],
contexts: ['Supermarket'],
source: ctx.source || null,
});
// Best-effort, never blocks the capture itself -- the task exists
// either way; this is enrichment on top, same contract every other
// auto-routed outcome above already follows.
try {
const { runAutoPriceCheck } = await import('./shopping.js');
await runAutoPriceCheck(task);
} catch (err) {
console.error('Auto price-check failed, item stays without one until Search prices is used manually:', err);
}
},
},
};

// The rule (if any) matching an explicit capture trigger -- a letter
// read off an image marker, or a `#<letter>` URL suffix. Case-sensitive
// on purpose: a drawn or typed capital is what the Settings examples
// show, and treating "t" and "T" as different triggers costs nothing
// while staying open to that distinction later if it's ever wanted.
function matchCaptureRule(data, inputMethod, trigger) {
if (!trigger) return null;
const rules = (data.prefs && data.prefs.captureRules) || [];
return rules.find((r) => r.inputMethod === inputMethod && r.trigger === trigger && CAPTURE_OUTCOMES[r.outcome]) || null;
}

export { CAPTURE_OUTCOMES, matchCaptureRule };
