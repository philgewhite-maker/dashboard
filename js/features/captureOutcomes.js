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
// photoIds, source}. An outcome only reads the fields it needs (recipe
// only looks at `url`; task/reading use most of the rest).
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
