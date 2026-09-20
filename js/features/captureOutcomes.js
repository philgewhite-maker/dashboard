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

// `tab` is where a successful capture's "Open it" banner should land.
// Held here rather than at the call site because only this registry
// knows where an outcome's record actually lives -- sharetarget.js used
// to hardcode a recipe-vs-everything-else ternary, which quietly sent
// reading-list captures to Tasks even before the reading list moved to
// the Media tab. A missing `tab` means "no particular destination".
const CAPTURE_OUTCOMES = {
task: {
label: 'Task',
commitMode: 'direct',
aiCost: 'none',
tab: 'tasks',
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
aiCost: 'none',
tab: 'media',
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
aiCost: 'conditional', // structured data on the page first, AI only as a fallback -- see importFromUrl (recipes.js)
tab: 'menu',
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
aiCost: 'none',
tab: 'tasks',
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
aiCost: 'conditional', // only the image-marker path's own product-ID call, see ctx.file below
tab: 'shopping',
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
// A film/series/album to watch or listen to. Two AI shapes, both
// conditional and both already built for other outcomes: a shared LINK
// whose title is still just the URL gets resolveUrlTitle (the same call
// Tasks/Shopping's "Resolve title" uses), and a marked SCREENSHOT -- a
// poster, a Netflix row, a Spotify album page -- gets
// extractMediaScreenshot, which is extractTripScreenshot's shape
// pointed at media instead of travel. Neither is reached by a capture
// that already carries a real title (typed, spoken, or from Telegram),
// same "ctx.file's presence is the signal" reasoning as `supermarket`.
media: {
label: 'Watch / listen',
commitMode: 'direct',
aiCost: 'conditional',
tab: 'media',
successBanner: (host) => `Added to your watch/listen list${host ? ` from ${host}` : ''}.`,
run: async (ctx) => {
const { addMediaItem, kindFromUrl } = await import('./media.js');
const { looksLikeUrl } = await import('../utils.js');
let title = (ctx.title || '').trim();
let kind = ctx.url ? kindFromUrl(ctx.url) : 'other';
let creator = '';
let year = '';
let externalIds = {};
let link = ctx.url || '';
if (ctx.file) {
try {
const { extractMediaScreenshot } = await import('../ai.js');
const found = await extractMediaScreenshot(ctx.file);
if (found.title) {
title = found.title;
if (found.kind) kind = found.kind;
creator = found.creator || '';
year = found.year || '';
}
// A screenshot of a catalogue page usually shows its own URL or id
// somewhere. Keeping that is the difference between "a film called
// Heat" and "this exact film" -- identifyUrl turns a visible URL
// into the same ids a shared link would have produced, and a bare
// visible id (tt0468569) is stored under the catalogue that uses
// that shape.
const { identifyUrl } = await import('../catalogue.js');
if (found.catalogueUrl) {
const fromShot = identifyUrl(found.catalogueUrl);
externalIds = { ...fromShot.ids };
if (!link && Object.keys(fromShot.ids).length) link = found.catalogueUrl;
}
if (found.catalogueId && /^tt\d+$/i.test(found.catalogueId)) externalIds.imdb = found.catalogueId;
} catch (err) {
console.error('Media screenshot extraction failed, keeping whatever title the capture carried:', err);
}
} else if (ctx.url && (!title || looksLikeUrl(title))) {
// A shared link usually arrives titled with the URL itself, which
// is useless in a list of films. Best-effort: the raw URL stays as
// the title if this fails, exactly like the manual Resolve button.
try {
const { resolveUrlTitle } = await import('../ai.js');
const resolved = await resolveUrlTitle(ctx.url);
if (resolved) title = resolved;
} catch (err) {
console.error("Couldn't resolve that media link's title:", err);
}
}
addMediaItem({
kind,
title: title || ctx.url || 'Untitled',
creator,
year,
link,
externalIds,
notes: ctx.notes || '',
photoIds: ctx.photoIds || [],
source: ctx.source || null,
});
},
},
// Event and Trip leg are `commitMode: 'draft'` -- the first two entries
// to actually use it (every entry above is 'direct', a one-click write,
// per this file's own header comment). Which trip, or whether AI/ICS
// extraction found anything usable at all, is a real decision the other
// outcomes never have to make, so instead of a `run(ctx)` that writes
// immediately, these have a `buildStep(ctx)` that does the (possibly
// AI-costing) extraction work and returns a `steps`-shaped object --
// unexecuted, exactly like voicecapture.js's own parseCaptureIntent
// output -- for the caller to wrap in a data.captureDrafts entry and
// queue for review. Only ever reached today via the `emailSubject`
// captureRules input method (js/features/mail.js's processMailMarkers)
// -- `ctx` needs a real Gmail message id (`mailMessageId`) to read a
// body/ICS from, which an image-marker or URL-suffix capture has no way
// to supply. The actual record creation, once a draft is confirmed,
// lives in voicecapture.js's runStep (case 'dateEvent'/'tripLeg') --
// this only ever builds the step, never writes anything itself.
dateEvent: {
label: 'Event',
commitMode: 'draft',
aiCost: 'conditional', // the .ics calendar invite first (free), AI only as a fallback
buildStep: async (ctx) => {
const mail = await import('./mail.js');
const { getMessageDetail } = await import('../googlemail.js');
const { bodyText, icsText } = await getMessageDetail(ctx.mailMessageId);
const icsResult = icsText ? mail.extractDateEventFromIcs(icsText) : null;
const result = mail.icsDateEventIsGoodEnough(icsResult) ? icsResult
: await (await import('../ai.js')).extractDateEventFromEmail(ctx.subject, ctx.from, bodyText);
return { type: 'dateEvent', ...result, mailUrl: ctx.url, mailSubject: ctx.subject };
},
},
tripLeg: {
label: 'Trip leg',
commitMode: 'draft',
aiCost: 'always',
buildStep: async (ctx) => {
const [{ extractTripLegFromEmail }, travel, { getMessageDetail }, { data }] = await Promise.all([
import('../ai.js'), import('./travel.js'), import('../googlemail.js'), import('../state.js'),
]);
const { bodyText } = await getMessageDetail(ctx.mailMessageId);
const extraction = await extractTripLegFromEmail(ctx.subject, ctx.from, bodyText);
// Same "exactly one trip open, nothing to pick" shortcut
// legTargetPickerHtml's own UI already uses -- a past trip is
// excluded (isPastTrip), same reasoning the Travel tab's own
// default view drops one 7+ days after it ends. Anything else
// (zero, or more than one, open trip) defaults to creating a new
// one -- an ambiguous auto-pick among several open trips would be
// a worse guess than just asking via a new trip, reviewable/
// discardable like every other field on this draft.
const openTrips = data.trips.filter((t) => !travel.isPastTrip(t));
return {
type: 'tripLeg', extraction,
tripId: openTrips.length === 1 ? openTrips[0].id : '__new__',
newTripTitle: extraction.suggestedTripTitle || 'New trip',
mailUrl: ctx.url, mailSubject: ctx.subject,
};
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
