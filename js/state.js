import { kvGet, kvSet, photoDelete } from './db.js';
import { uid, todayStr, daysAgoStr, last7Dates } from './utils.js';

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
vouchers: [],
businessIdeas: [],
subscriptions: [],
enhancementIdeas: [],
dealExpiries: [],
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
const DEFAULT_PREFS = {
calendarEventCount: 1, // upcoming events shown per tracked calendar
calendarDaysAhead: 0, // 0 = no limit, otherwise ignore events beyond N days
mailStarredLimit: 5,
mailSenderDays: 2,
mailSenderLimit: 20,
trackedSenders: ['philip.g-white@db.com', 'tamara.anna.white@gmail.com'],
};

const TAG_FIELDS = [
{ field: 'dateLocations', label: 'Date locations', sensitive: false },
{ field: 'dateEvents', label: 'Date events', sensitive: false },
{ field: 'languages', label: 'Language', sensitive: false },
{ field: 'nationality', label: 'Nationality', sensitive: false },
{ field: 'tags', label: 'Tags', sensitive: false },
{ field: 'sexTags', label: 'Sex', sensitive: true },
];

function blankData() {
return { habits: [], goals: [], jobs: [], connections: [], calendars: [], calendarStatus: {}, vouchers: [], businessIdeas: [], subscriptions: [], enhancementIdeas: [], dealExpiries: [], prefs: { ...DEFAULT_PREFS } };
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
if (stored) {
data = stored;
migrate();
return;
}
data = sampleData();
await persist();
}

// Fills in fields added after the schema grew, so older saved data doesn't
// break newer rendering code that expects these to exist.
function migrate() {
if (!Array.isArray(data.habits)) data.habits = [];
if (!Array.isArray(data.goals)) data.goals = [];
if (!Array.isArray(data.jobs)) data.jobs = [];
if (!Array.isArray(data.connections)) data.connections = [];
if (!Array.isArray(data.calendars)) data.calendars = [];
// Earlier version tracked {id, name, date} manual entries instead of
// synced-by-name strings — collapse those down to just the name so
// existing tracked calendars carry over and pick up real sync data next
// time Sync runs, instead of being silently dropped.
data.calendars = data.calendars.map((c) => (typeof c === 'string' ? c : c?.name)).filter(Boolean);
data.calendars = [...new Set(data.calendars)];
if (!data.calendarStatus || typeof data.calendarStatus !== 'object' || Array.isArray(data.calendarStatus)) data.calendarStatus = {};
if (!Array.isArray(data.vouchers)) data.vouchers = [];
if (!Array.isArray(data.businessIdeas)) data.businessIdeas = [];
if (!Array.isArray(data.subscriptions)) data.subscriptions = [];
if (!Array.isArray(data.enhancementIdeas)) data.enhancementIdeas = [];
if (!Array.isArray(data.dealExpiries)) data.dealExpiries = [];
// Fill in any pref added since this document was last written, without
// discarding ones already customised.
data.prefs = { ...DEFAULT_PREFS, ...(data.prefs || {}) };
if (!Array.isArray(data.prefs.trackedSenders)) data.prefs.trackedSenders = [...DEFAULT_PREFS.trackedSenders];
// Calendar status used to hold a single {title, date}. Reshape those into
// the events array the multi-event view expects, so previously synced
// calendars keep showing their event instead of going blank until re-synced.
Object.values(data.calendarStatus).forEach((s) => {
if (s && !Array.isArray(s.events)) {
s.events = s.found && s.date ? [{ title: s.title, date: s.date }] : [];
}
});
data.connections.forEach((c) => {
if (!Array.isArray(c.photoIds)) c.photoIds = c.photoId ? [c.photoId] : [];
if (typeof c.photoId !== 'string') c.photoId = c.photoIds[0] || null;
if (!Array.isArray(c.languages)) c.languages = [];
if (!Array.isArray(c.nationality)) c.nationality = [];
if (!Array.isArray(c.todos)) c.todos = [];
if (!Array.isArray(c.tags)) c.tags = [];
if (!Array.isArray(c.dateLocations)) c.dateLocations = [];
if (!Array.isArray(c.dateEvents)) c.dateEvents = [];
if (!Array.isArray(c.sexTags)) c.sexTags = [];
if (typeof c.job !== 'string') c.job = '';
if (typeof c.height !== 'string') c.height = '';
if (typeof c.education !== 'string') c.education = '';
if (typeof c.driveLink !== 'string') c.driveLink = '';
if (!c.ratings || typeof c.ratings !== 'object') c.ratings = {};
});
data.businessIdeas.forEach((idea) => {
if (typeof idea.status !== 'string') idea.status = 'Idea';
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

// Higher priority = less slack before a "reach out" nudge appears.
function reachOutThreshold(priority) {
return 12 - (priority || 0) * 2; // priority 5 -> 2 days, priority 1 -> 10 days
}

function isDormantStage(stage) {
return stage === 'Faded' || stage === 'Archived';
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
isDormantStage, exportBackup, importBackup, replaceData, DATA_KEY, TAG_FIELDS, DEFAULT_PREFS,
};

// `data` above is exported by binding, but ES module live-bindings only
// reflect *reassignments* the module itself makes (data = ...), not fields
// mutated from outside — that part works fine, since callers mutate the
// object's fields (data.habits.push(...)) rather than reassigning `data`.
