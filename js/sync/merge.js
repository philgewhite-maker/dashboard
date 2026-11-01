// Three-way merge of the whole synced document, used when this device has
// edits the server has not seen yet AND the server's copy moved on
// (another device, or anything else that saved). The old behaviour was
// "the server wins and the local edit is gone"; this keeps both.
//
//   base   = the document as it was at the last successful sync
//   ours   = this device's document now
//   theirs = the server's document now
//
// Per top-level key: only we changed it -> ours; only they changed it ->
// theirs; both changed it -> merged one level down (records matched by
// `id`, then field by field). Anything that genuinely can't be told apart
// (both changed the same scalar, or an array with no ids) goes to theirs
// and is reported in `conflicts`, so the caller can keep a backup.
//
// Pure: no imports, no DOM, no state module.

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasIds = (arr) => arr.every((x) => isPlainObject(x) && typeof x.id === 'string' && x.id);

// Places where two devices changing the same value is expected and either
// outcome is acceptable, so they resolve themselves instead of being reported
// as conflicts (which would offer a backup for nothing).
//   scheduledRuns.<task>            "when did this last run": the later run wins
//   claudeApiSpend.months.*.<count> running totals: both devices' additions are kept
//   claudeApiSpend.lastDeviceUpdateAt  the later stamp wins
const SCHEDULED_RUN = /^\.?scheduledRuns\.[^.]+$/;
const SPEND_COUNTER = /^\.?claudeApiSpend\.months\..+\.(calls|input|output|cost)$/;
const SPEND_STAMP = /^\.?claudeApiSpend\.lastDeviceUpdateAt$/;
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);

function resolveBenign(base, ours, theirs, path) {
if (SCHEDULED_RUN.test(path) && isPlainObject(ours) && isPlainObject(theirs)) {
return { value: String(ours.at || '') > String(theirs.at || '') ? ours : theirs };
}
if (SPEND_COUNTER.test(path) && typeof ours === 'number' && typeof theirs === 'number') {
return { value: Math.max(0, num(base) + (ours - num(base)) + (theirs - num(base))) };
}
if (SPEND_STAMP.test(path) && typeof ours === 'string' && typeof theirs === 'string') {
return { value: ours > theirs ? ours : theirs };
}
return null;
}

function mergeValue(base, ours, theirs, path, conflicts) {
if (same(ours, base)) return theirs;
if (same(theirs, base)) return ours;
if (same(ours, theirs)) return ours;
const benign = resolveBenign(base, ours, theirs, path);
if (benign) return benign.value;
if (isPlainObject(ours) && isPlainObject(theirs)) {
return mergeObject(isPlainObject(base) ? base : {}, ours, theirs, path, conflicts);
}
if (Array.isArray(ours) && Array.isArray(theirs) && hasIds(ours) && hasIds(theirs) && (Array.isArray(base) ? hasIds(base) : base === undefined)) {
return mergeById(Array.isArray(base) ? base : [], ours, theirs, path, conflicts);
}
conflicts.push(path);
return theirs;
}

function mergeObject(base, ours, theirs, path, conflicts) {
const out = {};
const keys = new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)]);
keys.forEach((k) => {
const inO = k in ours, inT = k in theirs, inB = k in base;
let v;
if (inO && inT) v = mergeValue(base[k], ours[k], theirs[k], `${path}.${k}`, conflicts);
else if (inO) v = same(ours[k], base[k]) && inB ? undefined : ours[k]; // they deleted it: gone, unless we changed it
else if (inT) v = same(theirs[k], base[k]) && inB ? undefined : theirs[k]; // we deleted it: gone, unless they changed it
if (v !== undefined) out[k] = v;
});
return out;
}

function mergeById(base, ours, theirs, path, conflicts) {
const byId = (arr) => new Map(arr.map((x) => [x.id, x]));
const b = byId(base), o = byId(ours), t = byId(theirs);
const out = [];
const done = new Set();
// Their order first, so the server's arrangement is kept; our additions follow.
[...theirs, ...ours].forEach((rec) => {
const id = rec.id;
if (done.has(id)) return;
done.add(id);
const bi = b.get(id), oi = o.get(id), ti = t.get(id);
let v;
if (oi && ti) v = mergeValue(bi, oi, ti, `${path}[${id}]`, conflicts);
else if (oi) v = bi && same(oi, bi) ? undefined : oi; // they removed it; keep only if we edited it
else v = bi && same(ti, bi) ? undefined : ti; // we removed it; keep only if they edited it
if (v !== undefined) out.push(v);
});
return out;
}

// Top-level sections that are just a cache or a status stamp refreshed
// independently on every device (stock quotes, weather, "last synced at").
// Two devices always differ on them, so a merge would report a conflict and
// the caller would download a backup for nothing: take the server's value.
function mergeDocuments(base, ours, theirs, volatile = []) {
const conflicts = [];
if (!isPlainObject(base) || !isPlainObject(ours) || !isPlainObject(theirs)) return { merged: theirs, conflicts: ['(whole document)'] };
const strip = (doc) => { const c = { ...doc }; volatile.forEach((k) => { delete c[k]; }); return c; };
const merged = mergeObject(strip(base), strip(ours), strip(theirs), '', conflicts);
volatile.forEach((k) => {
if (k in theirs) merged[k] = theirs[k];
else if (k in ours) merged[k] = ours[k];
});
return { merged, conflicts };
}

export { mergeDocuments, mergeValue };
