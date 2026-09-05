import { kvGet, kvSet, photoDelete } from './db.js';
import { uid, todayStr, daysAgoStr, last7Dates, daysSince, daysUntil } from './utils.js';

const DATA_KEY = 'app-data';
const REV_KEY = 'app-data-rev'; // separate from DATA_KEY so it never leaks into backup exports
const LOCAL_SETTINGS_KEY = 'local-settings'; // device-only: never synced, never exported in backups

function sampleData() {
const dates = last7Dates();
const mk = (pattern) => {
const obj = {};
dates.forEach((d, i) => { obj[d] = pattern[i]; });
return obj;
};
return {
habits: [
{ id: uid(), name: 'Morning run', completions: mk([true, true, false, true, true, false, false]) },
{ id: uid(), name: 'Read 20 min', completions: mk([true, true, true, true, false, true, true]) },
{ id: uid(), name: 'Meditate', completions: mk([false, true, true, false, true, true, false]) },
],
goals: [
{ id: uid(), title: 'Launch side project', category: 'Personal', progress: 65 },
{ id: uid(), title: 'Run a 10k', category: 'Health', progress: 40 },
],
jobs: [],
connections: [],
calendars: [], // array of tracked calendar NAMES, as they appear in Google Calendar
calendarStatus: {}, // name -> {found, title, date, syncedAt} — filled in by Sync
airbnbListings: [], // {id, label, icsUrl, prefix, colour} -- configured in Settings
airbnbReservations: [], // synced from each listing's ICS feed, see js/features/airbnb.js
airbnbSyncStatus: {}, // listingId -> {ok, syncedAt, added, updated, removed, error}
airbnbCleanerEvents: [], // [{date, name}] -- last scan of "Cleaner - <Name>" events on the push-target calendar, see js/features/airbnb.js
airbnbCleanerSyncStatus: null, // {ok, syncedAt, error} for the cleaner-event scan above
vouchers: [],
businessIdeas: [],
subscriptions: [],
enhancementIdeas: [],
financeAccounts: [], // bank/card accounts -- see js/features/financeaccounts.js, blankFinanceAccount() below
mailSearches: [],
tasks: [],
taskContexts: [...DEFAULT_TASK_CONTEXTS],
claudeAnswers: {},
prefs: { ...DEFAULT_PREFS },
};
}

// The multi-value (array) fields on a connection that behave as tags: edited
// as chips on the connection, grouped into chips in Connections Overview, and
// bulk-assignable from there. Declared once here, next to the migrations that
// guarantee they exist, so the editor and the overview can't drift apart.
// `sensitive` fields stay hidden (and out of search and grouping) unless this
// device opts in — the data still syncs, only the display is per-device.
// How much the Calendar and Mail panels fetch. Part of the synced document
// rather than device-local settings: "show me 3 upcoming events" is a
// preference about your dashboard, not about this particular browser, so it
// should follow you to your phone.
// Fallbacks for a row that doesn't set its own limit. Blank on a row means
// "no limit" for days and "use this default" for count, so leaving the boxes
// empty stays the simple case.
const DEFAULT_PREFS = {
calendarEventCount: 1,
mailResultCount: 5,
airbnbCalendarId: '', // which Google Calendar "Push to Google Calendar" targets -- picked once, remembered
};

// Each mail search is one row in Settings: a kind, its value, and its own
// day/result caps. Replaces the old fixed "starred + hardcoded senders"
// shape, which couldn't express "invoices from the last 2 days" at all.
const MAIL_SEARCH_KINDS = [
{ kind: 'starred', label: 'Starred', needsValue: false },
{ kind: 'from', label: 'From', needsValue: true },
{ kind: 'to', label: 'To', needsValue: true },
{ kind: 'subject', label: 'Subject contains', needsValue: true },
{ kind: 'contains', label: 'Contains', needsValue: true },
{ kind: 'query', label: 'Gmail query', needsValue: true },
];

// What a row is called in the Mail panel, matching how you'd describe it:
// "Starred", "From: a@gmail.com", 'Contains: "invoice"'.
function mailSearchLabel(search) {
const value = String(search.value || '').trim();
switch (search.kind) {
case 'starred': return 'Starred';
case 'from': return `From: ${value}`;
case 'to': return `To: ${value}`;
case 'subject': return `Subject: ${value}`;
case 'contains': return `Contains: “${value}”`;
default: return value || 'Gmail query';
}
}

// GTD buckets. `inbox` is deliberately first and unfiled — capture is meant
// to be thoughtless, and deciding where something belongs is a separate step
// (that's the whole point of the allocation workspace).
const TASK_BUCKETS = [
{ bucket: 'inbox', label: 'Inbox', hint: 'Captured, not yet decided' },
{ bucket: 'next', label: 'Next actions', hint: 'Doable now, in some context' },
{ bucket: 'project', label: 'Projects', hint: 'Outcomes needing more than one action' },
{ bucket: 'waiting', label: 'Waiting for', hint: 'Blocked on someone else' },
{ bucket: 'someday', label: 'Someday / maybe', hint: 'Aspirational, not committed' },
{ bucket: 'done', label: 'Done', hint: 'Finished' },
];

const DEFAULT_TASK_CONTEXTS = ['Office', 'Home', 'DIY', 'Home PC', 'Outdoor errands'];

// Shopping is a view over ordinary tasks filtered to these contexts, not a
// separate data model — a shopping item is a task like any other, so it can
// be broken out into subtasks or sit alongside a project ("buy paint" tagged
// both DIY and Supermarket) exactly the way the rest of GTD already works.
const SHOPPING_CONTEXTS = ['Supermarket', 'Pharmacy', 'Black Friday', 'Aspirational purchases'];

// Connections' detailed star ratings. `field` is the stable key stored in
// c.ratings — kept separate from `label` so a label can be adjusted without
// silently orphaning every rating already given under the old name.
// "intelligence" became "iq" (see the migration below, which moves any
// rating already recorded under the old key rather than losing it) with
// "eq" and "voice" added alongside.
const DEFAULT_RATING_CATEGORIES = [
{ field: 'looks', label: 'Looks' },
{ field: 'figure', label: 'Figure' },
{ field: 'voice', label: 'Voice' },
{ field: 'iq', label: 'IQ' },
{ field: 'eq', label: 'EQ' },
{ field: 'humour', label: 'Humour' },
{ field: 'sex', label: 'Sex' },
{ field: 'practicality', label: 'Practicality' },
];

// Recipes' own detailed ratings — a separate configurable list from
// Connections', not the same one: "Taste"/"Health"/"Prep" are a different
// axis entirely. What's shared is the mechanism (configurable in Settings,
// star rows, averaged, sortable), not the categories.
const DEFAULT_RECIPE_RATING_CATEGORIES = [
{ field: 'taste', label: 'Taste' },
{ field: 'health', label: 'Health' },
{ field: 'prep', label: 'Prep' },
];

// Turns a typed label into a stable storage key when a new rating category
// is added in Settings — "Fitness level" -> "fitnesslevel". Collisions (two
// labels slugging to the same key) fall back to a counter suffix so a
// second category never silently overwrites the first one's ratings.
function slugifyField(label, taken) {
const base = String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '') || 'cat';
if (!taken.has(base)) return base;
let n = 2;
while (taken.has(`${base}${n}`)) n++;
return `${base}${n}`;
}

// How a connection relates to your Google Contacts. Only meaningful for
// people you've taken off the dating app — see CONTACT_MATCH_MIN_STAGE.
const CONTACT_STATUS_LABELS = {
linked: 'In contacts',
review: 'Review contact match',
missing: 'Missing in contacts',
};

// Matching is only attempted from "Moved to WhatsApp" upwards. Below that
// you're still talking inside an app, almost certainly have no number for
// them, and every result would be a weak name guess — which is worse than
// no answer, because it invites you to confirm something you can't verify.
const CONTACT_MATCH_MIN_STAGE = 4;

function blankTask(fields = {}) {
return {
id: uid(),
title: '',
notes: '',
bucket: 'inbox',
contexts: [],
parentId: null, // set for subtasks; the parent is any other task
bringForward: '', // ISO date — hidden from active lists until then
due: '',
link: '', // the page holding the detail behind a project
notionPageId: '', // set once a Notion page backs this task
photoIds: [], // legacy: image blobs in this device's IndexedDB only
// Files of any type held on your own host (server/files.php). Only the
// metadata lives here — {id, name, type, size} — which is what makes an
// attachment show up on your other devices; the bytes are fetched on
// demand. Unlike photoIds, these genuinely sync.
attachments: [],
source: null, // {kind:'mail'|'calendar'|'photo', label, url}
createdAt: new Date().toISOString(),
completedAt: '',
...fields,
};
}

// A batch of files captured together (mainly via Android's share sheet,
// or the in-app multi-file picker) waiting to be triaged into wherever
// they actually belong -- a Dating connection's photos, a Task
// attachment, or a future Health import. Removed from data.captureInbox
// entirely once every item in it is routed or discarded; no status field,
// since an emptied inbox entry just isn't an inbox entry any more.
function blankCaptureBatch(fields = {}) {
return {
id: uid(),
createdAt: new Date().toISOString(),
label: '',
notes: '',
source: null, // {kind:'share'|'manual', label, url}
// {id, name, type, size, kind:'photo'|'attachment'} -- 'photo' items went
// through storePhoto() (graceful local fallback, thumbnail via
// photoUrl(id)); 'attachment' items went through uploadAttachment()
// directly (hard-fail-and-report, download via openAttachment(meta)) --
// same two conventions every other photo/file in this app already uses.
items: [],
...fields,
};
}

// A screenshot-derived candidate list (Bumble/Tinder/Hinge matches list, or
// a single full profile) waiting for the user to accept/merge/discard each
// row -- see connections.js's queuePendingImport(). Persisted rather than
// kept in memory: confirmed live that a matches-list import "disappeared"
// before it could be reviewed, because the extraction result only ever
// lived in a closure around the confirm button, and Android backgrounding
// the PWA tab (the same unpredictable-reload risk already hit for Capture
// Inbox and wellness extraction) wiped it with nothing recoverable. Each
// candidate's photos are already durably stored (real photoIds, not Blobs)
// by the time a pending import lands here -- see queuePendingImport's own
// comment for why that has to happen at extraction time, not confirm time.
function blankPendingImport(fields = {}) {
return {
id: uid(),
kind: 'matches', // 'matches' | 'profile' -- which candidate shape/fields to render and merge
app: '', // e.g. 'Bumble', or '' if unknown
sourceLabel: '', // filename or share label, shown on the review card
candidates: [],
createdAt: new Date().toISOString(),
...fields,
};
}

// A trip is a `bucket:'project'` task (see blankTask) plus this entry
// holding the travel-specific structure -- same split notionplan.js already
// uses (task ↔ notionPageId ↔ Notion detail), except the "detail" here has
// to be readable offline for the itinerary export, so it lives in the
// synced document rather than an external service.
function blankTrip(fields = {}) {
return {
id: uid(),
taskId: '', // the project task this trip is the detail behind
title: '',
destinations: [], // multi-value, same reasoning as blankConnection's location -- a multi-city trip needs each place as its own entry, both for display and so planner.js can match connections' own location tags against it
startDate: '', endDate: '', // best-known bounds; refined as legs fill in
people: [], // {id, name, relation:'self'|'partner'|'child'|'other', connectionId}
legs: [],
createdAt: new Date().toISOString(),
...fields,
};
}

const LEG_KINDS = ['flight', 'car_hire', 'accommodation', 'transfer', 'other'];

// One logistics item. `fields` is a flat bag rather than a rigid per-kind
// shape, so a leg can hold partial data from the moment it exists (a bare
// shell the itinerary generator flags as one big gap) through to fully
// enriched by an email/screenshot extraction.
function blankTripLeg(fields = {}) {
return {
id: uid(),
kind: 'flight',
label: '', // "Outbound: LHR -> LIS", shown instead of a generic kind name
bookingStatus: 'unbooked',
fields: {},
// Per-field resolution: absent = still open, 'confirmed-na' = the user
// said this one doesn't apply. A real value in `fields` supersedes
// either state -- see updateLegField in travel.js.
gapStatus: {},
// Who's actually on THIS booking and what they're carrying -- a flat
// leg-level "seat" field can't represent three people on one flight with
// three different seats and three different baggage allowances (the real
// case that motivated this: a Ryanair confirmation for 3 passengers, each
// with their own seat and bag mix). {id, name, seat, baggage}.
passengers: [],
notes: '',
source: null, // {kind:'mail'|'screenshot'|'manual', label, url}
attachments: [],
createdAt: new Date().toISOString(),
...fields,
};
}

const LEG_STATUSES = ['unbooked', 'booked', 'confirmed'];
const LEG_STATUS_LABELS = { unbooked: 'Not booked yet', booked: 'Booked', confirmed: 'Confirmed' };

// The single source of truth for what counts as "complete" per leg kind --
// drives both the entry form and gap detection. Fields in LEG_SOFT_FIELDS
// are filled in when known but never block completeness. `company` on
// transfer covers the train operator / taxi firm the way it already did for
// car_hire -- airline (flight) and name (accommodation) play the same role
// for those kinds, so every kind now names its actual provider somewhere.
const LEG_FIELD_DEFS = {
flight: ['airline', 'flightNumber', 'departAirport', 'departTime', 'arriveAirport', 'arriveTime', 'confirmationRef'],
car_hire: ['company', 'pickupLocation', 'pickupTime', 'dropoffLocation', 'dropoffTime', 'confirmationRef', 'carType'],
accommodation: ['name', 'address', 'checkIn', 'checkOut', 'confirmationRef', 'contactPhone'],
transfer: ['company', 'mode', 'from', 'to', 'departTime', 'confirmationRef'],
other: ['description', 'when', 'confirmationRef'],
};
const LEG_SOFT_FIELDS = new Set(['carType', 'contactPhone']);
const LEG_FIELD_LABELS = {
airline: 'Airline', flightNumber: 'Flight number', departAirport: 'Departure airport', departTime: 'Departure time',
arriveAirport: 'Arrival airport', arriveTime: 'Arrival time', confirmationRef: 'Confirmation ref',
company: 'Company', pickupLocation: 'Pickup location', pickupTime: 'Pickup time', dropoffLocation: 'Drop-off location',
dropoffTime: 'Drop-off time', carType: 'Car type', name: 'Name', address: 'Address', checkIn: 'Check-in',
checkOut: 'Check-out', contactPhone: 'Contact phone', mode: 'Mode', from: 'From', to: 'To',
description: 'Description', when: 'When',
};
// Which of a leg's own fields actually hold a date (as opposed to a place,
// reference number, etc.) -- shared by travel.js (normalizes these to a
// fixed form the moment they're typed in) and planner.js (buckets a leg
// under the right day in a trip's mini-planner). Living here rather than
// duplicated in both keeps the field taxonomy in exactly one place.
const LEG_DATE_FIELDS = {
flight: ['departTime', 'arriveTime'],
car_hire: ['pickupTime', 'dropoffTime'],
accommodation: ['checkIn', 'checkOut'],
transfer: ['departTime'],
other: ['when'],
};

// One dated placement of a connection or an activity into a day box --
// either the main 14-day grid (tripId: '') or a specific trip's own
// mini-planner (tripId set). Deliberately NOT reusing data.tasks: a
// placement isn't a GTD action with contexts/bucket/due-date semantics,
// it's "this person/activity, this day, draft or firm" -- closer in shape
// to a trip leg's passengers list than to anything in tasks.js.
function blankPlannerEntry(fields = {}) {
return {
id: uid(),
date: '', // ISO yyyy-mm-dd -- the day box this sits in
tripId: '', // '' for the main grid, else the trip this entry belongs to
kind: 'connection', // 'connection' | 'activity'
connectionId: '', // set when kind === 'connection'
activityId: '', // set when kind === 'activity'
status: 'draft', // 'draft' | 'firm'
notes: '',
calendarPushed: false, // true once pushed -- lets the push UI show what's already gone out
createdAt: new Date().toISOString(),
...fields,
};
}

// The reusable "things to do" pool (Picnic, Theatre show...) -- a short
// user-curated list, same spirit as taskContexts/ratingCategories below,
// not one-off GTD actions.
function blankPlannerActivity(fields = {}) {
return {
id: uid(),
title: '',
notes: '',
createdAt: new Date().toISOString(),
...fields,
};
}

// One Airbnb listing's calendar-export config -- prefix and colour are
// both about ROOM identity (two listings sharing a colour are the same
// physical room presented as two separate listings), not the listing
// itself. `colour` is a name from the app's fixed palette (see
// css/style.css's --X custom properties + .dot.X classes), not a free
// pick -- there's no colour-picker UI anywhere else to reuse either.
function blankAirbnbListing(fields = {}) {
return { id: uid(), label: '', icsUrl: '', prefix: '', colour: 'blue', ...fields };
}

// One reservation synced from a listing's ICS feed. `uid` is the feed's
// OWN event UID (not this record's `id`) -- the stable key a re-sync
// matches against so re-running Sync updates in place instead of piling
// up duplicates. Airbnb's export never includes the guest's name (a
// genuine privacy limit on their side, not a gap here), so guestName/
// notes are always user-entered after the fact, never scraped.
function blankAirbnbReservation(fields = {}) {
return {
id: uid(),
listingId: '', uid: '',
checkin: '', checkout: '', // ISO yyyy-mm-dd, checkout is exclusive (the turnover day, not an occupied night)
guestName: '', notes: '',
googleEventId: '', googleCalendarId: '', // set once pushed -- see js/googlecalendar.js's findEvents()/createEvent()
createdAt: new Date().toISOString(),
...fields,
};
}

// A bank account or credit card kept open for its incentive -- a switch
// bonus, cashback, or a 0% balance-transfer deal. See
// js/features/financeaccounts.js. cassLinkedAccountId/
// fundingFromAccountId are self-references into data.financeAccounts
// (the CASS switch partner, and which account funds this one's monthly
// minimum-funding requirement) -- kept as plain ids, not embedded
// copies, so editing the OTHER account never leaves this one stale.
function blankFinanceAccount(fields = {}) {
return {
id: uid(),
bank: '', name: '', accountType: 'Current account', // Current account | Savings | Credit card | Mortgage | Loan | Other
sortCode: '', accountNumber: '',
openDate: '', closeDate: '',
cassLinkedAccountId: '',
deal: '', dealEndDate: '',
purpose: '',
directDebits: [], // plain strings -- often a condition of the deal, not a real transaction ledger
fundingAmount: '', fundingFromAccountId: '',
colour: 'blue', // fixed palette, see ACCOUNT_COLOURS in financeaccounts.js -- also the card's accent stripe when logoUrl is blank
logoUrl: '', // pasted image URL (e.g. the provider's own Play Store listing icon) -- hotlinked, never downloaded/stored locally
notes: '',
createdAt: new Date().toISOString(),
...fields,
};
}

const TAG_FIELDS = [
// Other names the same person goes by — "Kat" is also "Katya" and
// "Katerina". Used when matching Google Contacts, so any one of them can
// find the record.
{ field: 'aliases', label: 'Also known as', sensitive: false },
// Multi-value on purpose: "Highgate, London" as ONE string meant "London"
// alone, mentioned in a different profile's chat, never matched it --
// each place name needs to be its own entry to be independently
// matchable (knownCityMap() in utils.js). Also lets a manual Cyrillic->
// Latin correction coexist with a re-scraped value instead of needing to
// overwrite/"lock" it -- rendered at its own dedicated position near the
// top of the connection editor, not in the generic tag-field list below
// (see visibleTagFields()'s exclusion in connections.js).
{ field: 'location', label: 'City', sensitive: false },
// Generalizes what used to be a single metInPerson boolean -- a real
// relationship has more than one milestone worth a permanent record
// (Exchanged details, Met, Kissed, Slept together, Holidayed together,
// Married...), and none of them should be lost just because Stage moves
// on (Faded/Archived rank the same as never-progressed). Reaching "Met
// in person" or beyond through the normal Stage dropdown still adds
// "Met" automatically (see the Stage change handler); everything else
// is typed by hand, same as any other tag field.
{ field: 'milestones', label: 'Milestones', sensitive: false },
{ field: 'dateLocations', label: 'Date locations', sensitive: false },
{ field: 'dateEvents', label: 'Date events', sensitive: false },
{ field: 'languages', label: 'Language', sensitive: false },
{ field: 'nationality', label: 'Nationality', sensitive: false },
{ field: 'tags', label: 'Tags', sensitive: false },
{ field: 'sexTags', label: 'Sex', sensitive: true },
{ field: 'interests', label: 'Interests', sensitive: false },
// Orientation (Straight, Gay...) and relationship style (Monogamy...) share
// one field rather than two — both answer "what kind of relationship",
// just from different Tinder sections, and one "Relationship" chip list
// reads more naturally than two near-empty ones.
{ field: 'relationshipTags', label: 'Relationship', sensitive: false },
// Found by scanning imported text (chat, bio, prompt answers) for @handle
// mentions — kept generic rather than per-platform (Instagram/Snapchat/
// etc.) since a bare @handle rarely says which app it's for; see
// contactscan.js.
{ field: 'socialHandles', label: 'Social handles', sensitive: false },
];

// One connection, with every field any part of the app reads off one
// already defaulted -- manual add, screenshot import, and the WhatsApp/
// Telegram/Tinder/Photos importers used to each build a different ad-hoc
// object literal by hand, drifting further apart every time a field got
// added to only one of them (confirmed: photoalbums.js's copy had
// `location: ''`, a string, instead of the array every other field expects
// -- the exact same crash class already fixed once for the manual-add site).
// Same factory pattern blankTask()/blankTrip() already use for their own
// entities. TAG_FIELDS' array fields are spread in rather than hand-listed
// again here, so a future addition to TAG_FIELDS is picked up automatically
// instead of needing this factory remembered too.
function blankConnection(fields = {}) {
return {
id: uid(),
name: '', profileName: '', identities: [], app: '', priority: 3, stage: 'Matched',
// Explicit "spend time with this person" marker for the Planner tab's
// priority pool -- separate from the 1-5 star `priority` rating above
// (that's a general quality rating; this is "show me in the drag list
// regardless of stage"). isPriorityConnection() in connections.js also
// treats a late-enough Stage as automatically qualifying, so this flag
// only needs setting for someone worth prioritising before that.
priorityFlag: false,
lastContact: '', createdAt: new Date().toISOString(),
photoId: null, photoIds: [], tinderPhotoKeys: [], photoAlbums: [],
age: '', dob: '', ageAsOf: '',
address: '', kids: '', job: '', height: '', education: '',
// Free text, exactly as the app shows it -- captured the same way kids
// already is, not forced into a fixed Yes/No vocabulary. Used to be
// mashed into the generic tags array as one of a small hand-picked set
// of normalized strings ('Smoker'/'Non-smoker'/'Sober'/'Drinks'), which
// couldn't represent "Trying to quit" or "Socially, at the weekend" --
// real answers seen on both Tinder and Bumble -- and gave smoking and
// drinking the exact adjective-vs-verb mismatch the housekeeping audit
// flagged. Each is now its own field with its own flag rule, same as kids.
drinking: '', smoking: '',
phone: '', email: '',
contactStatus: '', contactResourceName: '', contactEtag: '', contactConflicts: [],
contactMatchedBy: '', unmatchedAt: '',
likes: '', notes: '', chatLog: '', chatLogWhatsApp: '', chatLogTelegram: '',
todos: [], ratings: {}, driveLink: '', photosAlbumUrl: '', photosPersonUrl: '',
distance: '', matchedOn: '', tinderMatchId: '', tinderLastScrapedAt: '', attentionSnoozedUntil: '',
...Object.fromEntries(TAG_FIELDS.map((t) => [t.field, []])),
...fields,
};
}

// Starting points, not gospel — surfaced in Settings once real tag values
// are visible, so these are deliberately conservative rather than an
// attempt to guess every value Tinder might ever show. Gender routes into
// the generic `tags` field (see tinderimport.js's ARRAY_FIELD_MAP) since it
// has no dedicated field of its own; smoking/drinking used to share that
// same arrangement but now have their own fields (see blankConnection),
// so a rule on each can hold its own vocabulary instead of fighting for
// space in one shared list.
const DEFAULT_FLAG_RULES = [
{ id: 'default-distance', field: 'distance', greenMax: 10, redMin: 50 },
{ id: 'default-education', field: 'education', green: ['Bachelor degree', 'Master degree', 'PhD', 'Doctorate degree'], amber: [], red: ['High school'] },
{ id: 'default-smoking', field: 'smoking', green: [], amber: [], red: ['Smoker'] },
{ id: 'default-sober', field: 'drinking', green: ['Sober'], amber: [], red: [] },
{ id: 'default-gender', field: 'tags', green: [], amber: [], red: ['Trans man', 'Trans woman', 'Transgender'] },
{ id: 'default-orientation', field: 'relationshipTags', green: [], amber: ['Gay', 'Lesbian', 'Bisexual', 'Pansexual', 'Asexual', 'Queer', 'Demisexual', 'Open relationship', 'Polyamory', 'Ethically non-monogamous'], red: [] },
// Taller-is-good is the opposite direction from Distance -- greenMin (green
// if >=) + redMax (red if <=) rather than greenMax/redMin. 170cm ~= 5'7",
// 152cm = 5'0" (height's stored as "170cm / 5'7"", see heightCm() above).
{ id: 'default-height', field: 'height', greenMin: 170, redMax: 152 },
// "Green" here just means "matches a common positive answer" -- not a
// claim about what YOU actually want; recolour or delete in Settings if
// wanting kids isn't what you're looking for.
{ id: 'default-kids', field: 'kids', green: ['Want kids', 'Wants kids'], amber: [], red: [] },
];

function blankData() {
return { habits: [], goals: [], jobs: [], connections: [], calendars: [], calendarStatus: {}, vouchers: [], businessIdeas: [], subscriptions: [], enhancementIdeas: [], financeAccounts: [], mailSearches: [], tasks: [], taskContexts: [...DEFAULT_TASK_CONTEXTS],
ratingCategories: DEFAULT_RATING_CATEGORIES.map((c) => ({ ...c })),
recipes: [], recipeRatingCategories: DEFAULT_RECIPE_RATING_CATEGORIES.map((c) => ({ ...c })),
claudeAnswers: {},
flagRules: DEFAULT_FLAG_RULES.map((r) => ({ ...r })),
flagRulesSeeded: DEFAULT_FLAG_RULES.map((r) => r.id),
myCity: '',
// Your own details, kept explicitly so they can be filtered OUT of
// import/matching -- see the migration guard below and their use in
// tinderimport.js's scanFields() and contacts.js's findMatch().
myName: '', myPhone: '', myEmail: '', myAddress: '',
// Per-stage override for reachOutThreshold(), in days -- {stage: days}.
// A stage with no entry falls back to the priority-scaled formula. See
// reachOutThreshold() below.
reachOutStageDays: {},
// Per-importer run history, keyed by importer id (see recordImportRun()
// below) -- name -> {lastRunAt, scope, count}. Same shape/spirit as
// calendarStatus above, just for the various dating-import panels.
importStatus: {},
prefs: { ...DEFAULT_PREFS } };
}

let data = null;
let saveTimer = null;
let onSaveStatus = () => {};
let onExternalUpdate = () => {};

// The revision this in-memory session last saw confirmed on disk. Compared
// against the current on-disk revision on every save — see persist() for
// why this exists.
let knownRev = 0;

// Fired after a local save that actually changed something, so the live-sync
// layer knows there's something to upload. Deliberately NOT fired when the
// save came from applying a remote document — that would bounce the same
// data straight back to the server and, with two devices, never settle.
let onLocalChange = () => {};
function setLocalChangeHandler(fn) { onLocalChange = fn; }

function setSaveStatusHandler(fn) { onSaveStatus = fn; }
// Called when persist() finds newer data on disk than this session knew
// about and pulls it in instead of overwriting it — app.js wires this to a
// full re-render so the UI reflects what actually got saved.
function setExternalUpdateHandler(fn) { onExternalUpdate = fn; }

async function loadData() {
const stored = await kvGet(DATA_KEY);
knownRev = (await kvGet(REV_KEY)) || 0;
data = stored || sampleData();
migrate();
if (!stored) await persist();
}

// Fills in fields added after the schema grew, so older saved data doesn't
// break newer rendering code that expects these to exist.
function migrate() {
if (!Array.isArray(data.habits)) data.habits = [];
if (!Array.isArray(data.goals)) data.goals = [];
if (!Array.isArray(data.jobs)) data.jobs = [];
if (!Array.isArray(data.connections)) data.connections = [];
if (!Array.isArray(data.calendars)) data.calendars = [];
// Tracked calendars have been through three shapes: {id,name,date} manual
// entries, then bare name strings, and now {name, maxDays, maxEvents} so
// each calendar carries its own limits. Normalise all of them forward,
// seeding the limits from whatever global prefs this document last had.
const priorDays = Number(data.prefs?.calendarDaysAhead) || 0;
const priorCount = Number(data.prefs?.calendarEventCount) || 1;
const seenCalendars = new Set();
data.calendars = data.calendars.map((c) => {
const name = (typeof c === 'string' ? c : c?.name) || '';
if (!name.trim()) return null;
return {
name: name.trim(),
maxDays: typeof c === 'object' && c ? (Number(c.maxDays) || 0) : priorDays,
maxEvents: typeof c === 'object' && c ? (Number(c.maxEvents) || 0) : priorCount,
};
}).filter((c) => {
if (!c) return false;
const key = c.name.toLowerCase();
if (seenCalendars.has(key)) return false;
seenCalendars.add(key);
return true;
});
if (!data.calendarStatus || typeof data.calendarStatus !== 'object' || Array.isArray(data.calendarStatus)) data.calendarStatus = {};
if (!Array.isArray(data.vouchers)) data.vouchers = [];
if (!Array.isArray(data.businessIdeas)) data.businessIdeas = [];
if (!Array.isArray(data.subscriptions)) data.subscriptions = [];
if (!Array.isArray(data.enhancementIdeas)) data.enhancementIdeas = [];
if (!Array.isArray(data.financeAccounts)) data.financeAccounts = [];
data.financeAccounts = data.financeAccounts.map((a) => ({ ...blankFinanceAccount(), ...a, id: a.id || uid() }));
// A CASS-link or funding-source pointing at an account since deleted is
// a dangling reference -- same orphan-drop reasoning as an Airbnb
// reservation whose listing was removed, just clearing a field instead
// of the whole record (the account itself is still fine on its own).
{
const financeAccountIds = new Set(data.financeAccounts.map((a) => a.id));
data.financeAccounts.forEach((a) => {
if (a.cassLinkedAccountId && !financeAccountIds.has(a.cassLinkedAccountId)) a.cassLinkedAccountId = '';
if (a.fundingFromAccountId && !financeAccountIds.has(a.fundingFromAccountId)) a.fundingFromAccountId = '';
});
}
// Deal Expiries (name/type/date/notes only -- no account identity, no
// linkage) is fully replaced by financeAccounts' own deal/dealEndDate
// fields -- removed outright rather than left as dead orphaned data.
delete data.dealExpiries;
// Answers to Claude's questions live in the synced document so they reach
// whichever device you next sit down at, not just the one you typed on.
if (!data.claudeAnswers || typeof data.claudeAnswers !== 'object' || Array.isArray(data.claudeAnswers)) {
data.claudeAnswers = {};
}
if (!Array.isArray(data.taskContexts) || data.taskContexts.length === 0) {
data.taskContexts = [...DEFAULT_TASK_CONTEXTS];
}
// Shopping reuses the task context mechanism rather than a separate system
// — a context list already supports exactly what shopping needs (buy paint
// tagged both DIY and Supermarket). Added once, case-insensitively, to an
// existing document rather than only seeding a brand-new one, so this
// actually reaches a document that already has contexts.
SHOPPING_CONTEXTS.forEach((name) => {
if (!data.taskContexts.some((c) => c.toLowerCase() === name.toLowerCase())) data.taskContexts.push(name);
});
if (!Array.isArray(data.tasks)) data.tasks = [];
const validBuckets = new Set(TASK_BUCKETS.map((b) => b.bucket));
data.tasks = data.tasks.map((t) => ({ ...blankTask(), ...t, id: t.id || uid() }));
data.tasks.forEach((t) => {
if (!validBuckets.has(t.bucket)) t.bucket = 'inbox';
if (!Array.isArray(t.contexts)) t.contexts = [];
if (!Array.isArray(t.photoIds)) t.photoIds = [];
// Drop anything without an id: an attachment row that can't be fetched
// or deleted is just a dead entry on every device.
t.attachments = Array.isArray(t.attachments)
? t.attachments.filter((a) => a && typeof a.id === 'string' && a.id)
: [];
});
// A subtask whose parent has been deleted would otherwise vanish from every
// list — it renders under its parent, and there's no parent to render.
// Promote it rather than silently orphaning it.
const taskIds = new Set(data.tasks.map((t) => t.id));
data.tasks.forEach((t) => { if (t.parentId && !taskIds.has(t.parentId)) t.parentId = null; });
if (!Array.isArray(data.captureInbox)) data.captureInbox = [];
data.captureInbox = data.captureInbox.map((b) => ({ ...blankCaptureBatch(), ...b, id: b.id || uid() }));
data.captureInbox.forEach((b) => {
b.items = Array.isArray(b.items)
? b.items.filter((it) => it && typeof it.id === 'string' && it.id && (it.kind === 'photo' || it.kind === 'attachment'))
: [];
});
// A batch with nothing left (everything already routed/discarded, e.g. a
// save landed mid-triage) is clutter, not a real inbox entry.
data.captureInbox = data.captureInbox.filter((b) => b.items.length > 0);
if (!Array.isArray(data.pendingImports)) data.pendingImports = [];
data.pendingImports = data.pendingImports.map((p) => ({ ...blankPendingImport(), ...p, id: p.id || uid(), candidates: Array.isArray(p.candidates) ? p.candidates : [] }));
// A pending import with nothing left (every candidate already
// added/updated/discarded) is clutter, not a real review entry -- same
// reasoning as the captureInbox filter just above.
data.pendingImports = data.pendingImports.filter((p) => p.candidates.length > 0);
// One row per local calendar day, fully rebuilt from server-held raw
// payloads on every parse (see healthparse.js) rather than edited by hand
// -- no per-item blank-factory needed, just an array-shape guard.
if (!Array.isArray(data.healthDaily)) data.healthDaily = [];
// One row per local calendar day of Renpho scale readings, accumulated
// (not rebuilt) across however many CSV exports get shared over time --
// see renpho.js's mergeRenphoDaily() for why a re-share is safe to repeat.
if (!Array.isArray(data.renphoDaily)) data.renphoDaily = [];
// One row per local calendar day of AI-vision-extracted Samsung Health
// readings (HRV, AGEs index, Antioxidant index) -- see wellness.js.
if (!Array.isArray(data.wellnessDaily)) data.wellnessDaily = [];
if (!Array.isArray(data.trips)) data.trips = [];
data.trips = data.trips.map((t) => ({ ...blankTrip(), ...t, id: t.id || uid() }));
data.trips.forEach((t) => {
// destination -> destinations migration. Idempotent -- the old field is
// deleted below, so this is a no-op on every load after the first.
if (!Array.isArray(t.destinations)) t.destinations = [];
if (typeof t.destination === 'string') {
const legacy = t.destination.trim();
if (legacy && !t.destinations.length) t.destinations = [legacy];
delete t.destination;
}
t.people = Array.isArray(t.people) ? t.people : [];
t.legs = Array.isArray(t.legs)
? t.legs.map((l) => ({
...blankTripLeg(), ...l, id: l.id || uid(), fields: l.fields || {}, gapStatus: l.gapStatus || {},
notes: l.notes || '',
bookingStatus: LEG_STATUSES.includes(l.bookingStatus) ? l.bookingStatus : 'unbooked',
passengers: Array.isArray(l.passengers)
? l.passengers.filter((p) => p && String(p.name || '').trim()).map((p) => ({ id: p.id || uid(), name: p.name, seat: p.seat || '', baggage: p.baggage || '' }))
: [],
}))
: [];
});
// A trip whose project task was deleted has nothing left routing it into
// the normal Tasks workflow -- same "promote or drop" instinct as the
// orphaned-subtask guard just above, but a trip has no meaningful "promote"
// so it's simply dropped rather than left dangling with a dead taskId.
const tripTaskIds = new Set(data.tasks.map((t) => t.id));
data.trips = data.trips.filter((t) => !t.taskId || tripTaskIds.has(t.taskId));
if (!Array.isArray(data.plannerActivities)) data.plannerActivities = [];
data.plannerActivities = data.plannerActivities.map((a) => ({ ...blankPlannerActivity(), ...a, id: a.id || uid() }));
if (!Array.isArray(data.plannerEntries)) data.plannerEntries = [];
data.plannerEntries = data.plannerEntries.map((e) => ({ ...blankPlannerEntry(), ...e, id: e.id || uid() }));
// A trip-scoped entry whose trip no longer exists (deleted, or dropped by
// the orphaned-trip filter just above) has nowhere left to render -- same
// "nothing left to route it" reasoning as the trip filter itself.
const plannerTripIds = new Set(data.trips.map((t) => t.id));
data.plannerEntries = data.plannerEntries.filter((e) => !e.tripId || plannerTripIds.has(e.tripId));
if (!Array.isArray(data.airbnbListings)) data.airbnbListings = [];
data.airbnbListings = data.airbnbListings.map((l) => ({ ...blankAirbnbListing(), ...l, id: l.id || uid() }));
if (!Array.isArray(data.airbnbReservations)) data.airbnbReservations = [];
data.airbnbReservations = data.airbnbReservations.map((r) => ({ ...blankAirbnbReservation(), ...r, id: r.id || uid() }));
// A reservation whose listing was since deleted from Settings has nothing
// left to sync it or show it against -- same orphan-drop reasoning as the
// planner-entries filter just above.
const airbnbListingIds = new Set(data.airbnbListings.map((l) => l.id));
data.airbnbReservations = data.airbnbReservations.filter((r) => airbnbListingIds.has(r.listingId));
if (!data.airbnbSyncStatus || typeof data.airbnbSyncStatus !== 'object' || Array.isArray(data.airbnbSyncStatus)) data.airbnbSyncStatus = {};
if (!Array.isArray(data.airbnbCleanerEvents)) data.airbnbCleanerEvents = [];
// Seed the mail search rows from the old fixed shape the first time only.
// Keyed on the array's absence rather than its emptiness, so deleting every
// row stays deleted instead of being helpfully repopulated next reload.
if (!Array.isArray(data.mailSearches)) {
const old = data.prefs || {};
data.mailSearches = [];
if ((Number(old.mailStarredLimit) || 0) > 0) {
data.mailSearches.push({ id: uid(), kind: 'starred', value: '', maxDays: 0, maxEvents: Number(old.mailStarredLimit) });
}
(Array.isArray(old.trackedSenders) ? old.trackedSenders : []).forEach((addr) => {
data.mailSearches.push({
id: uid(), kind: 'from', value: addr,
maxDays: Number(old.mailSenderDays) || 0,
maxEvents: Number(old.mailSenderLimit) || 0,
});
});
}
data.mailSearches = data.mailSearches.map((s) => ({
id: s.id || uid(),
kind: MAIL_SEARCH_KINDS.some((k) => k.kind === s.kind) ? s.kind : 'query',
value: String(s.value || ''),
maxDays: Math.max(0, Number(s.maxDays) || 0),
maxEvents: Math.max(0, Number(s.maxEvents) || 0),
}));

// Fill in any pref added since this document was last written, without
// discarding ones already customised. The pre-per-row keys are deliberately
// left in place rather than deleted — they're what the seeding above reads.
data.prefs = { ...DEFAULT_PREFS, ...(data.prefs || {}) };
// Calendar status used to hold a single {title, date}. Reshape those into
// the events array the multi-event view expects, so previously synced
// calendars keep showing their event instead of going blank until re-synced.
Object.values(data.calendarStatus).forEach((s) => {
if (s && !Array.isArray(s.events)) {
s.events = s.found && s.date ? [{ title: s.title, date: s.date }] : [];
}
});
data.connections.forEach((c) => {
// A screenshot import whose vision response had no readable name used to
// write name: null straight onto a new connection (see
// addNewConnectionFromCandidate() in connections.js, now fixed at the
// source) -- and every later .toLowerCase() call across the app that
// scans connections by name would crash on it, breaking every
// subsequent screenshot import, not just the one that created it. Heals
// any record already carrying that damage on load, so the fix above
// doesn't require hunting down the bad connection by hand.
if (typeof c.name !== 'string') c.name = 'Unnamed match';
if (typeof c.priorityFlag !== 'boolean') c.priorityFlag = false;
if (!Array.isArray(c.photoIds)) c.photoIds = c.photoId ? [c.photoId] : [];
if (typeof c.photoId !== 'string') c.photoId = c.photoIds[0] || null;
if (!Array.isArray(c.languages)) c.languages = [];
if (!Array.isArray(c.nationality)) c.nationality = [];
// location used to be a single string ("Highgate, London" as one value,
// unmatchable as two places) -- wrap an existing string into a one-item
// array rather than discarding it, so nobody's saved City is lost.
if (typeof c.location === 'string') c.location = c.location.trim() ? [c.location.trim()] : [];
else if (!Array.isArray(c.location)) c.location = [];
if (!Array.isArray(c.milestones)) c.milestones = [];
// metInPerson (a plain boolean + date) generalized into milestones (see
// TAG_FIELDS) -- folded in rather than discarded, so nobody's already-
// recorded "we met" is lost. The date specifically has nowhere left to
// live (milestones are plain tags, no per-value date), so it's kept as
// a notes line instead of silently dropped.
if (c.metInPerson && !c.milestones.some((m) => m.toLowerCase() === 'met')) c.milestones.push('Met');
if (c.metInPerson && c.metInPersonDate) {
const line = `Met in person: ${c.metInPersonDate}`;
if (!String(c.notes || '').includes(line)) c.notes = c.notes ? `${c.notes}\n${line}` : line;
}
delete c.metInPerson;
delete c.metInPersonDate;
if (!Array.isArray(c.todos)) c.todos = [];
if (!Array.isArray(c.tags)) c.tags = [];
if (!Array.isArray(c.aliases)) c.aliases = [];
if (!Array.isArray(c.dateLocations)) c.dateLocations = [];
if (!Array.isArray(c.dateEvents)) c.dateEvents = [];
if (!Array.isArray(c.sexTags)) c.sexTags = [];
if (!Array.isArray(c.interests)) c.interests = [];
if (!Array.isArray(c.relationshipTags)) c.relationshipTags = [];
if (!Array.isArray(c.socialHandles)) c.socialHandles = [];
if (typeof c.distance !== 'string') c.distance = '';
if (typeof c.matchedOn !== 'string') c.matchedOn = '';
if (typeof c.tinderMatchId !== 'string') c.tinderMatchId = '';
if (!Array.isArray(c.tinderPhotoKeys)) c.tinderPhotoKeys = [];
if (typeof c.chatLog !== 'string') c.chatLog = '';
// Separate per-source so a WhatsApp or Telegram import can never overwrite
// or hide another source's history -- chatLog stays Tinder's own (it
// predates these two and re-scrapes are always the full transcript, same
// growth-check merge as before). A connection whose Stage moved from
// "Chatting in app" to "Moved to WhatsApp" to "Moved to Telegram" is
// expected to end up with all three eventually; connections.js merges and
// sorts all three chronologically for display rather than showing one.
if (typeof c.chatLogWhatsApp !== 'string') c.chatLogWhatsApp = '';
if (typeof c.chatLogTelegram !== 'string') c.chatLogTelegram = '';
// ISO date the "Reach out" badge is suppressed until, even though the
// connection is still past its threshold -- lets a specific overdue
// connection be dismissed for a while without changing Stage or priority.
if (typeof c.attentionSnoozedUntil !== 'string') c.attentionSnoozedUntil = '';
if (typeof c.job !== 'string') c.job = '';
if (typeof c.height !== 'string') c.height = '';
if (typeof c.education !== 'string') c.education = '';
if (typeof c.drinking !== 'string') c.drinking = '';
if (typeof c.smoking !== 'string') c.smoking = '';
// One-time: drinking/smoking used to have no field of their own and were
// normalized into a small fixed set of strings pushed onto the generic
// tags array. Only those exact, unambiguous strings are moved out -- tags
// is a flat, provenance-free bag (see the audit's own "tag is 4
// incompatible shapes" finding), so anything else in there (a genuinely
// generic tag, or a richer un-normalized value like "Trying to quit" that
// happened to land in tags via a different path) can't be safely
// attributed to one field or the other by guessing, and is left in place.
if (Array.isArray(c.tags)) {
const migrateHabitTag = (value, field) => {
if (c[field]) return false; // already set -- don't overwrite
const idx = c.tags.findIndex((t) => t === value);
if (idx === -1) return false;
c[field] = value;
c.tags.splice(idx, 1);
return true;
};
migrateHabitTag('Smoker', 'smoking') || migrateHabitTag('Non-smoker', 'smoking');
migrateHabitTag('Sober', 'drinking') || migrateHabitTag('Drinks', 'drinking');
}
if (typeof c.driveLink !== 'string') c.driveLink = '';
// Google Photos links kept separate from driveLink so the Overview can
// tell "has an album" from "has a face/person link" — they're different
// gaps to go and fix.
if (typeof c.photosAlbumUrl !== 'string') c.photosAlbumUrl = '';
if (typeof c.photosPersonUrl !== 'string') c.photosPersonUrl = '';
// Albums, as [{label, url, cover, title}]. Replaces the single
// photosAlbumUrl: one person legitimately has several albums (a trip, a
// separate private one), and — unlike a face-group /search/ link, whose
// token doesn't survive — an album URL is a stable, shareable object.
// `label` is whatever follows the underscore in "Name_Label"; empty for a
// plain "Name_".
if (!Array.isArray(c.photoAlbums)) {
c.photoAlbums = String(c.photosAlbumUrl || '').trim()
? [{ location: '', date: '', other: '', url: c.photosAlbumUrl.trim(), cover: '', title: '' }]
: [];
}
c.photoAlbums = c.photoAlbums.filter((a) => a && typeof a.url === 'string' && a.url.trim());
// Phone and email are what make a reliable join to Google Contacts
// possible — a first name alone is far too weak a key.
if (typeof c.phone !== 'string') c.phone = '';
if (typeof c.email !== 'string') c.email = '';
// The name on the dating profile, which is often not their real one. Kept
// separate from `name` so you can rename a connection to what they're
// actually called without losing the key that photos and screenshots were
// filed under.
if (typeof c.profileName !== 'string') c.profileName = '';
// One-shot: seed the new per-platform identity table from whatever this
// connection already had recorded (profileName + tinderMatchId), so it
// isn't empty on day one. Never runs again once identities exists, even
// if it stays [] (e.g. a connection that had neither).
if (!Array.isArray(c.identities)) {
c.identities = [];
const seedName = String(c.profileName || '').trim();
if (seedName) upsertIdentity(c, { platform: c.app || 'Other', handle: seedName, matchId: c.tinderMatchId });
else if (c.tinderMatchId) upsertIdentity(c, { platform: 'Tinder', matchId: c.tinderMatchId });
}
if (typeof c.dob !== 'string') c.dob = '';
// `location` is the city and is what Connections Overview groups by;
// `address` holds the full postal address, which is detail rather than a
// grouping — a street address makes a chip of one.
if (typeof c.address !== 'string') c.address = '';
// An age already on record has no known vintage. Stamping today is the
// least-wrong assumption available: an age is far more likely to have been
// entered recently than years ago, and the alternative — leaving it blank —
// means it never ages at all, which is the bug being fixed.
if (typeof c.ageAsOf !== 'string') c.ageAsOf = String(c.age || '').trim() ? todayStr() : '';
// Field-by-field disagreements found against a matched Google contact:
// [{field, mine, theirs, source}]
if (!Array.isArray(c.contactConflicts)) c.contactConflicts = [];
// '' (never checked) | 'linked' | 'review' | 'missing'
if (typeof c.contactStatus !== 'string') c.contactStatus = '';
if (typeof c.contactResourceName !== 'string') c.contactResourceName = '';
if (typeof c.contactEtag !== 'string') c.contactEtag = '';
// Written by contacts.js (match confirmation) and tinderimport.js (the
// "unmatched" sweep) but never guarded here until now -- the one gap in
// this migration pass every other connection field already goes through.
if (typeof c.contactMatchedBy !== 'string') c.contactMatchedBy = '';
if (typeof c.unmatchedAt !== 'string') c.unmatchedAt = '';
if (!c.ratings || typeof c.ratings !== 'object') c.ratings = {};
// "Intelligence" became "IQ" — move any rating already given under the
// old key rather than losing it. Guarded so a document that's already
// been migrated (or never had the old key) is untouched.
if (c.ratings.intelligence && !c.ratings.iq) c.ratings.iq = c.ratings.intelligence;
delete c.ratings.intelligence;
// No prior record of when an existing connection was actually added, so
// this can't be backfilled — left blank, which "sort by date added"
// treats as oldest rather than guessing today's date for everyone.
if (typeof c.createdAt !== 'string') c.createdAt = '';
});
if (!Array.isArray(data.flagRules)) {
data.flagRules = DEFAULT_FLAG_RULES.map((r) => ({ ...r }));
data.flagRulesSeeded = DEFAULT_FLAG_RULES.map((r) => r.id);
} else {
// flagRulesSeeded is a PERMANENT record of which default rule ids have
// ever been offered — checking current presence instead would resurrect
// a default the user deliberately deleted every time a new default (like
// Height or Family plans) gets added later. Missing entirely means this
// is the first load since flagRulesSeeded was introduced: best-effort
// backfill treats whatever's currently present as already-seeded, so
// this migration doesn't retroactively re-add anything already customised.
if (!Array.isArray(data.flagRulesSeeded)) data.flagRulesSeeded = data.flagRules.map((r) => r.id);
const seeded = new Set(data.flagRulesSeeded);
DEFAULT_FLAG_RULES.forEach((r) => {
if (seeded.has(r.id)) return;
data.flagRules.push({ ...r });
data.flagRulesSeeded.push(r.id);
});
}
// One-time: these two rules used to target the generic `tags` field
// (drinking/smoking had no field of their own yet). Repointing an
// existing rule object at the new field preserves any green/amber/red
// customisation already made -- only the id match is checked, and only
// while it's still sitting on the old shared field, so this never
// touches a rule the user has already re-pointed or renamed by hand.
data.flagRules.forEach((r) => {
if (r.id === 'default-smoking' && r.field === 'tags') r.field = 'smoking';
if (r.id === 'default-sober' && r.field === 'tags') r.field = 'drinking';
});
if (typeof data.myCity !== 'string') data.myCity = '';
if (typeof data.myName !== 'string') data.myName = '';
if (typeof data.myPhone !== 'string') data.myPhone = '';
if (typeof data.myEmail !== 'string') data.myEmail = '';
if (typeof data.myAddress !== 'string') data.myAddress = '';
if (!data.reachOutStageDays || typeof data.reachOutStageDays !== 'object') data.reachOutStageDays = {};
if (!data.importStatus || typeof data.importStatus !== 'object') data.importStatus = {};
if (!Array.isArray(data.ratingCategories) || data.ratingCategories.length === 0) {
data.ratingCategories = DEFAULT_RATING_CATEGORIES.map((c) => ({ ...c }));
} else {
// A document written before "field" existed on each entry (there wasn't
// one to migrate from, since this is new) — belt and braces in case a
// hand-edited or partially-synced document is missing one.
const taken = new Set();
data.ratingCategories = data.ratingCategories.map((c) => {
const label = String((c && c.label) || '').trim() || 'Rating';
const field = (c && c.field) || slugifyField(label, taken);
taken.add(field);
return { field, label };
});
}
data.businessIdeas.forEach((idea) => {
if (typeof idea.status !== 'string') idea.status = 'Idea';
});
if (!Array.isArray(data.recipeRatingCategories) || data.recipeRatingCategories.length === 0) {
data.recipeRatingCategories = DEFAULT_RECIPE_RATING_CATEGORIES.map((c) => ({ ...c }));
} else {
const takenR = new Set();
data.recipeRatingCategories = data.recipeRatingCategories.map((c) => {
const label = String((c && c.label) || '').trim() || 'Rating';
const field = (c && c.field) || slugifyField(label, takenR);
takenR.add(field);
return { field, label };
});
}
if (!Array.isArray(data.recipes)) data.recipes = [];
data.recipes.forEach((r) => {
if (typeof r.id !== 'string' || !r.id) r.id = uid();
if (typeof r.name !== 'string') r.name = '';
if (!r.source || typeof r.source !== 'object') r.source = { kind: 'manual', url: '' };
if (typeof r.photoId !== 'string' && r.photoId !== null) r.photoId = null;
if (!Array.isArray(r.photoIds)) r.photoIds = r.photoId ? [r.photoId] : [];
if (!Array.isArray(r.photoAlbums)) r.photoAlbums = [];
if (!Array.isArray(r.ingredients)) r.ingredients = [];
if (!Array.isArray(r.instructions)) r.instructions = [];
if (typeof r.notes !== 'string') r.notes = '';
if (!r.ratings || typeof r.ratings !== 'object') r.ratings = {};
if (typeof r.createdAt !== 'string') r.createdAt = '';
if (typeof r.lastMade !== 'string') r.lastMade = '';
if (!Array.isArray(r.tags)) r.tags = [];
});
}

// Every save is a full-document overwrite of DATA_KEY — there's no way to
// merge two independent edits. The one thing that MUST hold is: this
// session never writes over data it hasn't actually seen. Without a check,
// a second tab, a service-worker-triggered reload mid-session, or any other
// way this session's in-memory `data` could fall behind disk would silently
// erase whatever the newer write added — exactly the shape of the "4
// connections became 2" report. The fix: track the revision this session
// last confirmed, and before writing, check whether disk has moved past
// that. If it has, something else saved more recently than we know about —
// pull that in and re-render instead of clobbering it. This also happens
// to be the same conflict check a future sync layer needs, so it's not
// throwaway work.
async function persist(opts = {}) {
try {
const onDiskRev = (await kvGet(REV_KEY)) || 0;
if (onDiskRev > knownRev) {
const onDiskData = await kvGet(DATA_KEY);
console.warn(`Refusing to overwrite: disk revision ${onDiskRev} is newer than this session's ${knownRev}. Reloading instead of saving.`);
data = onDiskData;
migrate();
knownRev = onDiskRev;
onSaveStatus('conflict');
onExternalUpdate();
return;
}
knownRev = onDiskRev + 1;
await kvSet(DATA_KEY, data);
await kvSet(REV_KEY, knownRev);
onSaveStatus('ok');
if (opts.notify !== false) onLocalChange();
} catch (e) {
onSaveStatus('error');
}
}

function queueSave() {
clearTimeout(saveTimer);
saveTimer = setTimeout(persist, 250);
}

// Bypasses the debounce and saves immediately. app.js calls this on
// visibilitychange/pagehide so a pending edit isn't silently lost if the
// tab is closed, refreshed, or backgrounded inside the 250ms debounce
// window — the normal debounce alone can't protect against that, since a
// page teardown cancels the pending setTimeout before it fires.
function flushSave() {
clearTimeout(saveTimer);
return persist();
}

let localSettingsCache = null;
// Every setLocalSetting() call does a read-modify-write of the whole
// record. Two calls for two different keys (e.g. typing the API key while
// a background Google reconnect concurrently sets `googleConnected`) can
// interleave: both read the same starting point, then whichever write
// lands second overwrites the other's change with a value that never saw
// it. Chaining every write through this one promise forces them to run one
// at a time, so each read always reflects every write queued before it.
let settingsQueue = Promise.resolve();

async function getLocalSettings() {
if (localSettingsCache) return localSettingsCache;
const s = await kvGet(LOCAL_SETTINGS_KEY);
localSettingsCache = s || { anthropicApiKey: '' };
return localSettingsCache;
}

function setLocalSetting(key, value) {
settingsQueue = settingsQueue.then(async () => {
const s = await getLocalSettings();
s[key] = value;
localSettingsCache = s;
await kvSet(LOCAL_SETTINGS_KEY, s);
});
return settingsQueue;
}

function computeStreak(completions) {
let streak = 0;
for (let i = 0; i < 60; i++) {
const d = daysAgoStr(i);
if (completions[d]) streak++;
else break;
}
return streak;
}

// An age typed in once is only true on the day you typed it — a year later
// the record quietly understates them. So `age` is stored with `ageAsOf`,
// the date it was correct on, and the current age is derived. An exact `dob`
// beats both when you know it.
//
// Returns null when there's nothing to work from, otherwise
// {value, exact, drifted}: `exact` when computed from a real date of birth,
// `drifted` when the stored number has been adjusted for elapsed years.
function currentAge(conn) {
const today = new Date();
if (conn.dob) {
const born = new Date(conn.dob);
if (!isNaN(born)) {
let years = today.getFullYear() - born.getFullYear();
// Not had their birthday yet this year.
const beforeBirthday = today.getMonth() < born.getMonth()
|| (today.getMonth() === born.getMonth() && today.getDate() < born.getDate());
if (beforeBirthday) years -= 1;
if (years >= 0 && years < 130) return { value: years, exact: true, drifted: false };
}
}
const base = parseInt(conn.age, 10);
if (!Number.isFinite(base)) return null;
if (!conn.ageAsOf) return { value: base, exact: false, drifted: false };
const asOf = new Date(conn.ageAsOf);
if (isNaN(asOf)) return { value: base, exact: false, drifted: false };
let years = today.getFullYear() - asOf.getFullYear();
const beforeAnniversary = today.getMonth() < asOf.getMonth()
|| (today.getMonth() === asOf.getMonth() && today.getDate() < asOf.getDate());
if (beforeAnniversary) years -= 1;
years = Math.max(0, years);
return { value: base + years, exact: false, drifted: years > 0 };
}

// "31" when it's from a date of birth, "~31" when it's an estimate carried
// forward — the tilde is the honest signal that it could be a year out.
function displayAge(conn) {
const age = currentAge(conn);
if (!age) return '';
return age.exact ? String(age.value) : `~${age.value}`;
}

// Photo coverage as a small set of buckets rather than a raw count — the
// point is spotting what needs attention ("who has only the one thumbnail
// from an import?"), and a chip per exact count would fragment that into
// dozens of groups of one.
function photoCoverage(conn) {
const n = (conn.photoIds || []).length;
if (n === 0) return 'No photos';
if (n === 1) return 'One photo only';
if (n <= 5) return '2–5 photos';
return '6+ photos';
}

// Which external photo links a connection has. Multi-valued, so someone can
// appear under several, and the "None" chip catches everyone with no link at
// all — which is usually the list you actually want to work through.
function photoLinkLabels(conn) {
const out = [];
if ((conn.photoAlbums || []).length) out.push('Album link');
if (String(conn.photosPersonUrl || '').trim()) out.push('Person link');
if (String(conn.driveLink || '').trim()) out.push('Drive link');
return out;
}

// Averages whichever of a connection's detailed ratings have actually been
// given a value — an unrated category is "not yet rated", not "rated 0",
// so it's excluded rather than dragging the average down. Returns null
// (not 0) when nothing has been rated at all, so callers can tell "rated
// low" from "not rated" apart rather than treating them the same.
// `categories` defaults to Connections' own list so every existing call
// site keeps working unchanged; Recipes passes data.recipeRatingCategories
// instead, since it's a different axis rated on the same mechanism.
function averageRating(entity, categories) {
const cats = categories || data.ratingCategories || [];
const values = cats.map((c) => (entity.ratings && entity.ratings[c.field]) || 0).filter((v) => v > 0);
if (values.length === 0) return null;
return { value: values.reduce((a, b) => a + b, 0) / values.length, count: values.length };
}

// A rough 0–1 completeness score, for sorting "who still needs filling in"
// to the top. Deliberately a curated set rather than every field — niche
// optional ones (a full address, a Drive link) would make completeness
// feel unfairly punishing for someone who's otherwise well-tracked.
const COMPLETENESS_CHECKS = [
(c) => !!String(c.age || '').trim(),
(c) => (c.location || []).length > 0,
(c) => !!String(c.job || '').trim(),
(c) => !!String(c.height || '').trim(),
(c) => !!String(c.education || '').trim(),
(c) => !!String(c.phone || '').trim(),
(c) => !!String(c.email || '').trim(),
(c) => !!String(c.notes || '').trim(),
(c) => (c.photoIds || []).length > 0,
(c) => (c.photoAlbums || []).length > 0,
(c) => !!averageRating(c),
(c) => c.contactStatus === 'linked',
];
function completeness(conn) {
const hits = COMPLETENESS_CHECKS.filter((check) => check(conn)).length;
return hits / COMPLETENESS_CHECKS.length;
}

// Shared "when did I last run this import, and how much did it cover"
// tracker for every import panel (Tinder snippet, WhatsApp, Telegram,
// screenshot imports, Photo Scan, Google Photos albums) -- one small
// keyed object rather than a bespoke field per importer, same pattern as
// calendarStatus above. `scope` is a free-text hint ("since 2026-08-01",
// "full history") since only the caller knows what kind of run it was;
// omit it for importers that don't have a meaningful notion of scope.
function recordImportRun(key, info) {
if (!data.importStatus) data.importStatus = {};
data.importStatus[key] = {
lastRunAt: new Date().toISOString(),
scope: (info && info.scope) || '',
count: info && typeof info.count === 'number' ? info.count : null,
};
queueSave();
}

function importStatusLine(key) {
const s = data.importStatus && data.importStatus[key];
if (!s || !s.lastRunAt) return '';
const when = new Date(s.lastRunAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
const parts = [s.scope, typeof s.count === 'number' ? `${s.count} item${s.count === 1 ? '' : 's'}` : ''].filter(Boolean);
return `Last run: ${when}${parts.length ? ' — ' + parts.join(', ') : ''}`;
}

// A plan already made ("Planning to meet"/"Planning to call") is
// time-sensitive on its own terms — whether you follow through matters
// regardless of how highly you happen to have starred this person — so it
// overrides the usual priority-scaled slack with a short fixed one instead
// of just nudging it slightly. Feeds both the default connections sort and
// the nudge pool from the same formula, so a bump here shows up in both
// places without them drifting out of sync with each other.
const URGENT_STAGES = new Set(['Planning to meet', 'Planning to call']);

// Higher priority = less slack before a "reach out" nudge appears. A
// per-stage override (set in the Connections panel) always wins -- it's the
// only way to quiet a stage that's stuck (e.g. old "Matched" entries that
// never progressed and never got manually marked Faded) without touching
// every connection in it individually.
function reachOutThreshold(priority, stage) {
const override = data.reachOutStageDays[stage];
if (typeof override === 'number' && override >= 0) return override;
if (URGENT_STAGES.has(stage)) return 2;
return 12 - (priority || 0) * 2; // priority 5 -> 2 days, priority 1 -> 10 days
}

function isDormantStage(stage) {
// 'Backlog review' deliberately excluded -- it's an active triage bucket
// (see connections.js's "Backlog review 180+" bulk-move button), not a
// resolved outcome like these four.
return stage === 'Faded' || stage === 'Archived' || stage === 'FriendZone' || stage === 'Got Away';
}

// Orthogonal to stage, not a replacement for it — someone mid-conversation
// or already met once doesn't lose that progress just because she's now out
// of normal reach-out rotation. Standby has no end date (a foreign-city
// match not worth nagging about unless/until travel lines up — cleared
// manually, or later by trip-date matching); Travelling auto-expires so a
// forgotten pause doesn't silently suppress nudges forever.
function isTravelPaused(conn) {
if (conn.travelStatus === 'standby') return true;
if (conn.travelStatus === 'travelling' && conn.travelUntil) return daysUntil(conn.travelUntil) >= 0;
return false;
}

// Distance is stored as a bucketed display string ("≤10mi/16km",
// "23mi/37km+" — see bucketDistance() in the console snippet), not a raw
// number, so a threshold rule needs the leading mile figure pulled back
// out rather than comparing the string directly.
function distanceMiles(distStr) {
const m = String(distStr || '').match(/(\d+(?:\.\d+)?)\s*mi/);
return m ? parseFloat(m[1]) : null;
}

// Height is stored as "170cm / 5'7"" (see formatHeight() in the console
// snippet) — the cm figure is always present and already rounded, so it's
// the cleaner unit to compare on rather than re-deriving feet/inches and
// risking a second rounding step.
function heightCm(heightStr) {
const m = String(heightStr || '').match(/(\d+)\s*cm/);
return m ? parseInt(m[1], 10) : null;
}

// Every field a flag rule can target, normalised to the same shape
// regardless of whether the underlying connection field is a single
// string (education, job) or an array (the TAG_FIELDS chip lists) — a
// value-list rule always compares against an array, a threshold rule
// always compares against a number, so the matching logic itself never
// needs to know which kind of field it's looking at.
const FLAG_FIELD_DEFS = [
{ field: 'distance', label: 'Distance (miles)', kind: 'number', getValue: (c) => distanceMiles(c.distance) },
{ field: 'age', label: 'Age', kind: 'number', getValue: (c) => { const a = currentAge(c); return a ? a.value : null; } },
{ field: 'education', label: 'Education', kind: 'text', getValue: (c) => (c.education ? [c.education] : []) },
{ field: 'height', label: 'Height (cm)', kind: 'number', getValue: (c) => heightCm(c.height) },
{ field: 'job', label: 'Job', kind: 'text', getValue: (c) => (c.job ? [c.job] : []) },
{ field: 'kids', label: 'Family plans', kind: 'text', getValue: (c) => (c.kids ? [c.kids] : []) },
{ field: 'drinking', label: 'Drinking', kind: 'text', getValue: (c) => (c.drinking ? [c.drinking] : []) },
{ field: 'smoking', label: 'Smoking', kind: 'text', getValue: (c) => (c.smoking ? [c.smoking] : []) },
{ field: 'stage', label: 'Stage', kind: 'text', getValue: (c) => (c.stage ? [c.stage] : []) },
// City's own entry comes from this spread now that it's a TAG_FIELDS
// member (multi-value) rather than a hand-written scalar getValue here.
...TAG_FIELDS.map((t) => ({ field: t.field, label: t.label, kind: 'text', getValue: (c) => c[t.field] || [] })),
];

// A threshold rule needs BOTH bounds set to produce an amber band (the
// gap between them) — one bound alone just flags what it flags and stays
// silent otherwise, rather than guessing where an unset boundary should be.
// Four independent optional bounds rather than a fixed "small is good"
// shape, so the same rule engine covers both directions a threshold can
// run: Distance is greenMax (green if <=) + redMin (red if >=) -- short
// is good. Height is the opposite -- tall is good -- so it's greenMin
// (green if >=) + redMax (red if <=). Whichever bounds are actually set
// on a given rule define its range; unset ones just don't constrain it.
function thresholdColor(rule, value) {
if (value === null || value === undefined || !Number.isFinite(value)) return null;
const hasGreen = Number.isFinite(rule.greenMin) || Number.isFinite(rule.greenMax);
const inGreen = hasGreen
&& (!Number.isFinite(rule.greenMin) || value >= rule.greenMin)
&& (!Number.isFinite(rule.greenMax) || value <= rule.greenMax);
if (inGreen) return 'green';
const hasRed = Number.isFinite(rule.redMin) || Number.isFinite(rule.redMax);
const inRed = hasRed
&& (!Number.isFinite(rule.redMin) || value >= rule.redMin)
&& (!Number.isFinite(rule.redMax) || value <= rule.redMax);
if (inRed) return 'red';
if (hasGreen && hasRed) return 'amber';
return null;
}

// Tinder itself appends " (shared)" to an interest it says you both have
// (see the console snippet) — stripped before comparing so a rule listing
// "Hiking" matches both a bare "Hiking" someone typed and the scraped
// "Hiking (shared)", rather than treating them as unrelated strings.
function stripSharedSuffix(v) {
return String(v || '').replace(/\s*\(shared\)\s*$/i, '').trim();
}

// One row per platform a connection has actually been found on, replacing
// the old single `profileName` scalar (which had no way to hold "Tinder
// called her Kat23, Bumble called her Katya" at once). Fill-gaps merge,
// same rule as applyCandidateUpdate()'s scalar setters -- a value already
// recorded outranks a re-scrape, never silently overwritten. `matchId` is
// the platform's own identifier where one exists (Tinder's match id,
// Telegram's chat id); left blank for sources that don't have one.
function upsertIdentity(conn, { platform, handle = '', matchId = '' }) {
if (!platform || (!String(handle || '').trim() && !String(matchId || '').trim())) return;
if (!Array.isArray(conn.identities)) conn.identities = [];
// Matches an identical matchId, or a same-platform row that hasn't got
// one recorded yet (so a later import can fill in a blank slot) -- but
// NOT a same-platform row that already carries a *different* matchId,
// since that's a genuine re-match under a new id, not the same record.
const row = conn.identities.find((r) => r.platform === platform && (!matchId || !r.matchId || r.matchId === matchId));
if (row) {
if (!String(row.handle || '').trim() && handle) row.handle = handle;
if (!String(row.matchId || '').trim() && matchId) row.matchId = matchId;
} else {
conn.identities.push({ id: uid(), platform, handle: handle || '', matchId: matchId || '' });
}
}

function valueListColor(rule, values) {
const norm = (values || []).map((v) => stripSharedSuffix(v).toLowerCase());
if (!norm.length) return null;
const has = (list) => (list || []).some((x) => norm.includes(stripSharedSuffix(x).toLowerCase()));
if (has(rule.red)) return 'red';
if (has(rule.amber)) return 'amber';
if (has(rule.green)) return 'green';
return null;
}

// Single-value convenience wrapper around valueListColor, for coloring one
// tag/chip/value at a time (Overview chips, the tag-chip editor) rather
// than a whole connection's array. Finds the field's rule itself so
// callers don't need to look it up.
function valueColorForField(rules, field, value) {
const rule = (rules || []).find((r) => r.field === field);
if (!rule || !value) return null;
return valueListColor(rule, [value]);
}

// Every rule that matched, plus the worst colour among them (red beats
// amber beats green) as the one dot a connection row actually shows — a
// single red flag shouldn't get visually buried under three green ones.
function computeFlags(conn, rules) {
const hits = [];
(rules || []).forEach((rule) => {
const def = FLAG_FIELD_DEFS.find((d) => d.field === rule.field);
if (!def) return;
const color = def.kind === 'number' ? thresholdColor(rule, def.getValue(conn)) : valueListColor(rule, def.getValue(conn));
if (color) hits.push({ ruleId: rule.id, field: rule.field, label: def.label, color });
});
const worst = hits.some((h) => h.color === 'red') ? 'red' : hits.some((h) => h.color === 'amber') ? 'amber' : hits.some((h) => h.color === 'green') ? 'green' : null;
return { hits, worst };
}

const ACTIONS = ['Contact now', 'Set up date', 'Clean up data', 'Confirm faded', 'Retry in future'];

// A first-pass heuristic, not a settled formula -- combines stage,
// dormancy, data completeness, and the red/amber/green flags into one
// suggested next step, recomputed fresh every time rather than stored
// (same "suggestion, not silent" spirit as suggestedStage() in the
// Tinder importer). The priority order below is a starting point worth
// reacting to and adjusting, not a claim that it's definitely right.
function suggestedAction(conn, rules) {
if (isDormantStage(conn.stage)) return null; // already resolved, nothing to suggest
if (isTravelPaused(conn)) return null; // deliberately out of reach-out rotation for now
const since = conn.lastContact ? daysSince(conn.lastContact) : null;
const threshold = reachOutThreshold(conn.priority, conn.stage);
if (since !== null && since > threshold * 3) return 'Confirm faded';
if (URGENT_STAGES.has(conn.stage)) return 'Set up date'; // already committed to a plan
if (completeness(conn) < 0.4) return 'Clean up data';
if (since === null) return 'Contact now';
if (since > threshold) return 'Retry in future';
return null; // nothing pressing right now
}

// Deterministic, per-connection conversation prompts -- for a personality
// that tends not to ask enough questions, a short list of "things worth
// asking or checking" doubles as a data-completeness pass (empty City,
// empty Family plans) and a "is this actually still going" check, all
// cheap enough to run over every connection with no AI call. A starting
// set, not exhaustive.
function suggestedQuestions(conn) {
if (isDormantStage(conn.stage)) return [];
if (isTravelPaused(conn)) return []; // 144 days is expected, not a red flag, while she's out of rotation
const out = [];
const since = conn.lastContact ? daysSince(conn.lastContact) : null;
const threshold = reachOutThreshold(conn.priority, conn.stage);
if (since !== null && since > threshold * 3) {
out.push('Still active? Message to check — archive if no reply.');
}
if (!(conn.location || []).length) {
out.push('Where do they live? Ask rather than assume.');
}
if (!(conn.nationality || []).length) {
out.push("What's their nationality? Ask rather than assume.");
}
// Only once there's an actual transcript -- asking about kids on a bare
// "Matched" with nothing said yet is premature. Any of the three chat
// fields (populated only once an import found real messages, on whichever
// app the conversation happened) is a more reliable signal for "a real
// conversation has happened" than stage alone, and avoids importing
// STAGE_RANK from connections.js (circular dependency).
if (!String(conn.kids || '').trim() && (String(conn.chatLog || '').trim() || String(conn.chatLogWhatsApp || '').trim() || String(conn.chatLogTelegram || '').trim())) {
out.push('Ask whether they have kids, or want them.');
}
if ((conn.interests || []).length && !(conn.dateEvents || []).length) {
out.push(`Mentioned interests (${conn.interests.slice(0, 3).join(', ')}) — worth turning into a date idea?`);
}
return out;
}

async function exportBackup() {
const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url;
a.download = `dashboard-backup-${todayStr()}.json`;
document.body.appendChild(a);
a.click();
document.body.removeChild(a);
URL.revokeObjectURL(url);
}

// Shared by "import a backup file" and "pull from OneDrive" — both are
// "replace local data with this external document" operations that need
// the same defaults-filling and persistence.
async function replaceData(parsed, opts = {}) {
const base = blankData();
data = Object.assign({}, base, parsed);
migrate();
await persist({ notify: opts.fromRemote !== true });
}

async function importBackup(file) {
const text = await file.text();
await replaceData(JSON.parse(text));
}

export {
data, sampleData, loadData, migrate, persist, queueSave, flushSave, setSaveStatusHandler,
setExternalUpdateHandler, setLocalChangeHandler, getLocalSettings, setLocalSetting, computeStreak, reachOutThreshold,
isDormantStage, currentAge, displayAge, photoCoverage, photoLinkLabels, averageRating, completeness,
exportBackup, importBackup, replaceData, DATA_KEY, TAG_FIELDS, DEFAULT_PREFS,
MAIL_SEARCH_KINDS, mailSearchLabel,
TASK_BUCKETS, DEFAULT_TASK_CONTEXTS, SHOPPING_CONTEXTS, blankTask, blankCaptureBatch, blankPendingImport, blankConnection,
blankTrip, blankTripLeg, LEG_KINDS, LEG_FIELD_DEFS, LEG_SOFT_FIELDS, LEG_FIELD_LABELS, LEG_STATUSES, LEG_STATUS_LABELS, LEG_DATE_FIELDS,
blankPlannerEntry, blankPlannerActivity,
blankAirbnbListing, blankAirbnbReservation, blankFinanceAccount,
CONTACT_STATUS_LABELS, CONTACT_MATCH_MIN_STAGE,
DEFAULT_RATING_CATEGORIES, slugifyField, DEFAULT_RECIPE_RATING_CATEGORIES,
FLAG_FIELD_DEFS, DEFAULT_FLAG_RULES, computeFlags, valueColorForField, stripSharedSuffix, suggestedAction, suggestedQuestions, isTravelPaused, ACTIONS, distanceMiles, heightCm,
recordImportRun, importStatusLine, upsertIdentity,
};

// `data` above is exported by binding, but ES module live-bindings only
// reflect *reassignments* the module itself makes (data = ...), not fields
// mutated from outside — that part works fine, since callers mutate the
// object's fields (data.habits.push(...)) rather than reassigning `data`.
