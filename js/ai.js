// Calls the Anthropic Messages API directly from the browser using a key
// the user pastes into Settings (js/state.js keeps it in a device-local
// IndexedDB store that's never included in exports or synced anywhere).
// This only works because of the `anthropic-dangerous-direct-browser-access`
// header — normal server-side calls don't need it, but a client-only app
// with no backend does. See README for the tradeoffs.
import { getLocalSettings, setLocalSetting } from './state.js';
import { fileToBase64, loadImage, cropThumbnailToBlob, hashFile, captureDateOf, betterCaptureDate, ensureBrowserReadableImage } from './utils.js';
import { parseCacheGet, parseCachePut } from './db.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-opus-5';

// Anthropic list prices in USD per million tokens. Only ever used for the
// rough spend estimate shown in Settings — nothing functional depends on it,
// so a stale entry costs you an inaccurate number, not a broken feature.
// Update here if prices change; an unknown model shows tokens but no cost
// rather than guessing.
const PRICES_PER_MTOK = {
'claude-opus-5': { input: 5, output: 25 },
'claude-sonnet-5': { input: 3, output: 15 },
'claude-haiku-4-5': { input: 1, output: 5 },
'claude-haiku-4-5-20251001': { input: 1, output: 5 },
};

// Claude's vision API only accepts an EXACT match against these four MIME
// strings — a browser's own Blob/File.type can carry extra parameters
// (e.g. "image/webp;charset=binary") or a non-standard variant
// ("image/jpg") that look right but fail the API's strict check with a
// 400. Confirmed live: a Tinder-fetched webp failed AI photo comparison
// with exactly that error. Strips parameters and normalises known
// variants rather than trusting a blob's raw type string directly.
const ANTHROPIC_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
function normalizeImageMediaType(type) {
const base = String(type || '').split(';')[0].trim().toLowerCase();
if (ANTHROPIC_IMAGE_TYPES.has(base)) return base;
if (base === 'image/jpg') return 'image/jpeg';
return 'image/jpeg';
}

function currentMonthKey() { return new Date().toISOString().slice(0, 7); }

// Usage is bucketed by month, then by purpose+model, so Settings can show
// "photo import cost this much, nudges cost that much" and price each at the
// right rate. Stored in device-local settings (never exported or synced) —
// it describes this device's API spend, not your dashboard data.
async function recordUsage(purpose, model, usage) {
if (!usage) return;
const month = currentMonthKey();
const settings = await getLocalSettings();
const all = { ...(settings.apiUsage || {}) };
const monthEntry = { ...(all[month] || {}) };
const key = `${purpose}|${model}`;
const prev = monthEntry[key] || { calls: 0, input: 0, output: 0 };
monthEntry[key] = {
calls: prev.calls + 1,
input: prev.input + (usage.input_tokens || 0),
output: prev.output + (usage.output_tokens || 0),
};
all[month] = monthEntry;
await setLocalSetting('apiUsage', all);
}

// Rolls the stored buckets for one month into display rows plus a total.
// `cost` is null for a model missing from PRICES_PER_MTOK, which the caller
// renders as "—" rather than as $0.
function summarizeUsage(apiUsage, month) {
const entry = (apiUsage || {})[month] || {};
let totalCost = 0;
let anyUnpriced = false;
const rows = Object.entries(entry).map(([key, v]) => {
const [purpose, model] = key.split('|');
const price = PRICES_PER_MTOK[model];
const cost = price ? (v.input / 1e6) * price.input + (v.output / 1e6) * price.output : null;
if (cost === null) anyUnpriced = true; else totalCost += cost;
return { purpose, model, calls: v.calls, input: v.input, output: v.output, cost };
}).sort((a, b) => (b.cost || 0) - (a.cost || 0));
return { rows, totalCost, anyUnpriced };
}

class MissingKeyError extends Error {
constructor() { super('No Anthropic API key set. Add one in Settings.'); this.name = 'MissingKeyError'; }
}

// A screenshot with more people/fields than expected can make the response
// hit max_tokens mid-array — the model wrote valid JSON for the first N
// entries and got cut off starting the (N+1)th. Rather than fail the whole
// import, find the longest prefix of complete top-level array elements and
// parse just that, so "found 20, screenshot had 24" beats "found nothing."
// Tracks string/escape state so a `}` or `,` inside a name string (or a
// bounding-box object) doesn't get mistaken for a top-level boundary.
function salvageArrayPrefix(text) {
if (text[0] !== '[') return null;
let depth = 0;
let inString = false;
let escape = false;
const cutPoints = [];
for (let i = 0; i < text.length; i++) {
const ch = text[i];
if (inString) {
if (escape) escape = false;
else if (ch === '\\') escape = true;
else if (ch === '"') inString = false;
continue;
}
if (ch === '"') { inString = true; continue; }
if (ch === '{' || ch === '[') depth++;
else if (ch === '}' || ch === ']') {
depth--;
if (depth === 1 && ch === '}') cutPoints.push(i + 1);
}
}
for (let i = cutPoints.length - 1; i >= 0; i--) {
try { return JSON.parse(text.slice(0, cutPoints[i]) + ']'); } catch (e) { /* try an earlier cut point */ }
}
return null;
}

// Pulls the first balanced {...} or [...] out of a string. Claude is told
// to respond with ONLY JSON, but "only" is a request, not a guarantee — a
// stray "Here's what I found:" before the JSON, or a trailing caveat after
// it, is enough to break a bare JSON.parse. This is more forgiving than
// stripping markdown fences alone. Returns { data, truncated }.
function extractJson(text) {
const trimmed = text.trim();
try { return { data: JSON.parse(trimmed), truncated: false }; } catch (e) { /* fall through */ }
const stripped = trimmed.replace(/```json|```/g, '').trim();
try { return { data: JSON.parse(stripped), truncated: false }; } catch (e) { /* fall through */ }
const start = stripped.search(/[[{]/);
if (start !== -1) {
const opener = stripped[start];
const closer = opener === '{' ? '}' : ']';
const end = stripped.lastIndexOf(closer);
if (end !== -1 && end > start) {
try { return { data: JSON.parse(stripped.slice(start, end + 1)), truncated: false }; } catch (e) { /* fall through */ }
}
const salvaged = salvageArrayPrefix(stripped.slice(start));
if (salvaged) return { data: salvaged, truncated: true };
}
throw new Error(`Response wasn't JSON: ${stripped.slice(0, 200)}`);
}

async function callAnthropic(content, maxTokens, modelOverride, purpose, tools, effort) {
const settings = await getLocalSettings();
const apiKey = (settings.anthropicApiKey || '').trim();
if (!apiKey) throw new MissingKeyError();
const model = modelOverride || settings.anthropicModel || DEFAULT_MODEL;

let res;
try {
res = await fetch(API_URL, {
method: 'POST',
headers: {
'content-type': 'application/json',
'x-api-key': apiKey,
'anthropic-version': '2023-06-01',
'anthropic-dangerous-direct-browser-access': 'true',
},
body: JSON.stringify({
model,
max_tokens: maxTokens || 1500,
messages: [{ role: 'user', content }],
...(tools ? { tools } : {}),
// Confirmed against Anthropic's docs: Sonnet 5 defaults to "high"
// effort with no `thinking` param needed to trigger it -- "at higher
// effort levels, Claude thinks on most requests and at greater
// length; at lower levels, it can skip thinking entirely for simpler
// problems." That thinking counts against max_tokens the same as the
// real answer, which is exactly what starved a wellness extraction of
// any room for its JSON (see WELLNESS_MAX_TOKENS's own comment).
// Callers doing plain structured extraction (not open-ended
// reasoning) pass 'low' here so the model skips thinking rather than
// silently eating the token budget on a task that doesn't need it.
...(effort ? { output_config: { effort } } : {}),
}),
});
} catch (networkErr) {
// fetch() throws (not a rejected .ok) on DNS failure, offline, or a CORS
// rejection — surface that distinctly since "couldn't read the image"
// would be a misleading diagnosis for a connectivity problem.
console.error('Anthropic API request failed before a response was received:', networkErr);
throw new Error(`Network error calling the Anthropic API: ${networkErr.message}`);
}

if (!res.ok) {
const body = await res.text().catch(() => '');
console.error(`Anthropic API error ${res.status}:`, body);
let detail = body;
try { detail = JSON.parse(body).error?.message || body; } catch (e) { /* not JSON, use as-is */ }
throw new Error(`Anthropic API error ${res.status}: ${detail.slice(0, 300)}`);
}
const result = await res.json();
// Record before parsing: the call was billed whether or not the JSON that
// came back turns out to be usable, so a parse failure shouldn't quietly
// under-report spend.
await recordUsage(purpose || 'other', model, result.usage);
if (result.stop_reason === 'max_tokens') {
console.warn('Response was truncated at max_tokens — the JSON may be incomplete.', result);
}
// A server-executed tool (like web_search) runs inside this same response —
// no client-side loop needed — but it interleaves non-text tool-use/result
// blocks with one or more text blocks, so the final answer isn't always the
// single text block a plain call would have. Concatenating every text block
// gets the full answer regardless of how many search rounds it took.
const text = tools
? (result.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
: ((result.content || []).find((b) => b.type === 'text') || {}).text;
if (!text) {
// A bare "No text in response" told a user nothing actionable when this
// fired for real (a wellness screenshot that should have parsed fine) --
// stop_reason and what block types actually came back are the two things
// that explain WHY, so both the console and the thrown message (which
// callers surface straight to the user) now carry them.
const blockTypes = (result.content || []).map((b) => b.type).join(', ') || 'none';
console.error('Anthropic response had no text block:', result);
throw new Error(`No text in response (stop_reason: ${result.stop_reason || 'unknown'}, content: ${blockTypes})`);
}
try {
return extractJson(text);
} catch (parseErr) {
console.error('Could not parse JSON from Claude response:', text);
// Confirmed live: a wellness extraction failed with a raw "Response
// wasn't JSON" dump of a cut-off object -- the real cause (hit
// max_tokens before the closing brace) was buried in a console.warn
// several lines above stop_reason==='max_tokens', not in the error the
// user actually saw. Object responses can't be salvaged the way
// extractJson's salvageArrayPrefix repairs a cut-off array, so this is
// the one place that can name the real cause plainly instead of dumping
// unparseable text at whoever's reading the error message.
if (result.stop_reason === 'max_tokens') {
throw new Error(`Response was cut off at the ${maxTokens || 1500}-token limit before it finished — try again, or this call may need a higher limit.`);
}
throw parseErr;
}
}

async function callVision(base64, mediaType, promptText, maxTokens, modelOverride, effort) {
return callAnthropic([
{ type: 'image', source: { type: 'base64', media_type: normalizeImageMediaType(mediaType), data: base64 } },
{ type: 'text', text: promptText },
], maxTokens, modelOverride || null, 'Photo import', null, effort);
}

// Text-only Claude call, no image — used for reasoning-over-JSON tasks like
// ranking nudges. modelOverride lets a cheap/fast task (like ranking) skip
// past the user's chosen vision model without touching their Settings.
async function callTextJson(promptText, maxTokens, modelOverride, purpose, effort) {
return callAnthropic([{ type: 'text', text: promptText }], maxTokens, modelOverride, purpose || 'other', null, effort);
}

// maxTokens defaults are generous on purpose: output tokens are cheap
// relative to the cost of a screenshot import silently failing because a
// busy matches list didn't fit. A long scrolling screenshot can cost far
// more per person than a compact grid (more scroll positions, longer names/
// bios in view), so this is sized well above the typical case rather than
// the average one; if a screenshot still overflows it, the caller gets back
// whichever prefix parsed and a `truncated: true` flag instead of an error.
const MATCHES_MAX_TOKENS = 16000;
const PROFILE_MAX_TOKENS = 3000;
// Explicitly locked rather than left to inherit settings.anthropicModel/
// DEFAULT_MODEL (Opus 5) -- reading a profile's stats/bio and drawing photo
// bounding boxes is structured extraction, not a task that benefits from
// Opus-tier reasoning, and Haiku undersells accuracy on the nuanced bits
// (height written as "5'7\"" vs "170cm", a bio that needs summarising).
// Sonnet 5 is the deliberate middle tier for this job. Now banded for long
// profile screenshots (see safeBandHeight below), so this runs more than
// once per import -- worth pricing right, not just inheriting the user's
// chosen default.
const PROFILE_PARSE_MODEL = 'claude-sonnet-5';
// Escalation for an image tall/narrow enough to need more than one band
// even on the standard vision tier -- see VISION_TIER_HIGH_RES for why
// that specifically means Opus, not "a smarter model": Opus 4.7+ gets a
// materially larger native-resolution budget (2576px/4784 tokens vs
// Sonnet's 1568/1568), so the same image needs roughly half as many
// bands, each at higher fidelity, cutting the band-boundary risk that
// BAND_OVERLAP exists to manage. Reserved for the images that actually
// need it -- a normal-length profile never triggers this and stays on
// cheaper Sonnet.
const PROFILE_PARSE_MODEL_TALL = 'claude-opus-5';
// Bumped whenever profilePrompt()'s requested fields change. The rich-parse
// cache is keyed on this alongside the image hash -- without it, re-parsing
// the exact same screenshot after a prompt change (a genuinely common thing
// to do while testing a fix) silently serves the OLD cached result forever,
// since nothing else about the cache key ever changes. Confirmed live:
// re-uploading the same screenshot twice after adding new fields to the
// prompt kept returning the pre-change result with no error or indication
// why nothing was different.
const PROFILE_SCHEMA_VERSION = 11;

// A vision model estimating bounding-box coordinates has no pixel grid to
// anchor against, so a raw absolute-position guess drifts the further down
// a long image it's looking (observed: roughly half an avatar's diameter
// off by ~26 rows into a long Tinder screenshot). The main fix is in the
// prompt below — anchoring each avatar box to that row's name text instead
// of guessing an absolute position. Banding is a secondary safety net,
// but a band that's too tall carries its own accuracy cost -- see
// safeBandHeight below.
//
// Confirmed live against Anthropic's current vision docs (2026-08-25):
// the standard resolution tier caps an image at a 1568px long edge AND a
// 1568-visual-token budget (28x28px patches); anything past either limit
// is silently downscaled server-side before the model reads it. A fixed
// 4000px band height was well past that on the long edge alone -- for a
// real 540-wide, 8712-tall profile screenshot (a "Jenra" Bumble profile,
// root-caused from the actual file rather than guessed at), each 4000px
// band was getting downscaled to roughly 210px wide, past where already-
// small profile text stays legible. That screenshot came back with the
// wrong age and almost every other field empty. safeBandHeight computes
// the tallest band THIS image's actual width can carry at native
// resolution, so bands are only as tall as they can be without triggering
// any server-side downscale, rather than a single guessed constant.
//
// Standard tier (1568px edge / 1568 tokens), not the high-resolution
// tier (2576/4784). Briefly tried the high-res numbers on the theory
// that "Claude 4.7 and later models" (the docs' cutoff) would include
// Sonnet 5 by release order -- reverted after checking Sonnet 5's own
// changelog page directly: it explicitly bills itself as a drop-in
// upgrade for Sonnet 4.6 "with three behavior changes" (adaptive
// thinking default, extended thinking removed, sampling params
// rejected) and states the page "summarizes everything new at launch."
// No vision/resolution change is mentioned anywhere on it, and Sonnet
// 4.6 predates the numeric "4.7" cutoff, so Sonnet 4.6 -- and therefore,
// by inheritance, Sonnet 5 -- is standard tier. The "4.7 and later"
// phrase in the vision docs is a per-family version cutoff at the point
// high-res was introduced, not a cross-family chronological one; Sonnet
// never had a "4.7", it jumped straight from 4.6 to 5.
const VISION_TIER_STANDARD = { longEdge: 1568, maxTokens: 1568 };
// Confirmed live (Opus 5 migration guide): "Claude Opus 4.7 is the first
// Claude model with high-resolution image support" -- an Opus-lineage
// feature inherited by 4.8 and 5, automatic, no opt-in. Sonnet never had
// a 4.7 release and stays on the standard tier above (see the note on
// VISION_TIER_STANDARD's callers). Used only when escalating a
// too-tall-for-standard-tier image to Opus -- see the model-selection
// comment in extractProfileFromScreenshot/extractMatchesFromScreenshot.
const VISION_TIER_HIGH_RES = { longEdge: 2576, maxTokens: 4784 };
const VISION_PATCH = 28;
function safeBandHeight(width, tier) {
const patchesW = Math.max(1, Math.ceil(width / VISION_PATCH));
const maxPatchesH = Math.max(1, Math.floor(tier.maxTokens / patchesW));
return Math.min(tier.longEdge, maxPatchesH * VISION_PATCH);
}
// Widened from a fixed 220 -- that was sized for avatar-row drift on
// matches lists, but a profile's bio/prompt-answer text widget is taller
// than an avatar row (often 300-500px). A widget straddling the boundary
// without fitting fully inside the overlap gets a partial view in BOTH
// adjacent bands, and each now correctly declines to guess-complete a
// partial read (see profilePrompt's isBand text-skip instruction) -- so
// instead of a duplicate, it goes missing from both. A wider overlap
// makes it more likely any single widget lands fully inside the shared
// zone. Capped to a fraction of the actual band height in planBands
// below, since bands are now often much shorter than the old fixed 4000px
// -- an uncapped 500px overlap against, say, a 1120px band would waste
// nearly half of it re-covering the same content.
const BAND_OVERLAP = 500;

function matchesPrompt(isBand, app) {
return `This is a screenshot of ${app ? `the ${app} app's` : 'a dating app'} matches or chat list`
+ (isBand ? ', showing one vertical section of a longer scrolling screenshot' : '')
+ '. For each distinct person visible, return their display name, their age if shown next to the name, a tight bounding box around ONLY their small circular avatar photo (not the name, text, or row background) as fractions of THIS IMAGE (0 to 1, top-left origin, keys x,y,w,h), and their stage: "Matched" if they appear in a row of just avatars with no message preview (e.g. a "New Matches" strip) — meaning you haven\'t started chatting; "Chatting in app" if their row shows a message preview/snippet or timestamp of a conversation, meaning you\'re already messaging.'
+ ' Estimate each avatar box relative to that row\'s name text rather than guessing its absolute position on the page: first locate the name you just read, then place the box immediately next to it (usually to its left) with the box\'s vertical center matching the name text\'s vertical center — anchoring to the name you\'re already reading is far more reliable than an independent guess at where a row falls in a long, uniform list. The box should be a tight square around just the circle — err on the side of too small rather than too large, since a box that\'s too tall will bleed into the next row.'
+ (isBand ? ' If a row is cut off at the very top or very bottom edge of this image (less than half the avatar visible), SKIP it entirely — it is fully visible in an adjacent section and will be captured there instead.' : '')
+ ' Return ONLY a JSON array, no other text, no markdown fences. Example: [{"name":"Alex","age":"29","stage":"Chatting in app","bbox":{"x":0.05,"y":0.12,"w":0.09,"h":0.09}}]. Use null for age or bbox if not visible or unsure, and use "Matched" for stage if you can\'t tell. If no people are visible, return [].';
}

// [{ y0, h }, ...] in source-image pixels. A single band covering the whole
// image when it's already short, so typical screenshots take the same one
// unsliced path as before. Band height is derived from the image's own
// width (see safeBandHeight) rather than a fixed constant, so a band is
// never taller than what THIS image's width can carry without the API
// silently downscaling it.
function planBands(totalWidth, totalHeight, tier) {
const targetHeight = safeBandHeight(totalWidth, tier);
if (totalHeight <= targetHeight * 1.3) return [{ y0: 0, h: totalHeight }];
const overlap = Math.min(BAND_OVERLAP, Math.floor(targetHeight * 0.25));
const bands = [];
let y0 = 0;
while (y0 < totalHeight) {
const h = Math.min(targetHeight, totalHeight - y0);
bands.push({ y0, h });
if (y0 + h >= totalHeight) break;
y0 += targetHeight - overlap;
}
return bands;
}

function sliceToBase64(img, y0, h) {
return new Promise((resolve, reject) => {
const canvas = document.createElement('canvas');
canvas.width = img.naturalWidth;
canvas.height = h;
canvas.getContext('2d').drawImage(img, 0, y0, img.naturalWidth, h, 0, 0, img.naturalWidth, h);
canvas.toBlob(async (blob) => {
if (!blob) { reject(new Error('Could not slice image band')); return; }
resolve((await fileToBase64(blob)));
}, 'image/png');
});
}

// Two bands overlap on purpose (see BAND_OVERLAP above), so a row fully
// inside the overlap zone can legitimately come back from both bands
// intact. Same name + near-identical translated y position is treated as
// the same person; the first occurrence (from the earlier band) wins.
function dedupeByNameAndPosition(list) {
const out = [];
for (const r of list) {
const dupe = out.some((o) => o.name && r.name
&& o.name.trim().toLowerCase() === String(r.name).trim().toLowerCase()
&& o.bbox && r.bbox && Math.abs(o.bbox.y - r.bbox.y) < 0.03);
if (!dupe) out.push(r);
}
return out;
}

// Screenshot of a matches/chat list — many small avatars + names. Long
// screenshots are sliced into overlapping bands (see planBands) so bounding
// boxes stay accurate; each band is a separate, independent vision call.
async function extractMatchesFromScreenshot(file, app) {
file = await ensureBrowserReadableImage(file);
const base64 = await fileToBase64(file);
const mediaType = file.type || 'image/png';
const dataUrl = `data:${mediaType};base64,${base64}`;
const img = await loadImage(dataUrl);
// Standard tier, not the escalate-to-Opus treatment extractProfileFrom
// Screenshot gets -- this path sends no modelOverride to callVision, so
// it resolves to whatever the user has set as their default model in
// Settings (falling back to DEFAULT_MODEL). Standard-tier band sizing is
// always a safe floor regardless of which model that ends up being: a
// high-res-eligible model just gets more bands than it strictly needs,
// never smaller-than-safe ones.
const bands = planBands(img.naturalWidth, img.naturalHeight, VISION_TIER_STANDARD);
const isBanded = bands.length > 1;

const settled = await Promise.allSettled(bands.map(async (band) => {
const bandBase64 = isBanded ? await sliceToBase64(img, band.y0, band.h) : base64;
const bandMediaType = isBanded ? 'image/png' : mediaType;
const { data: raw, truncated } = await callVision(bandBase64, bandMediaType, matchesPrompt(isBanded, app), MATCHES_MAX_TOKENS);
if (!Array.isArray(raw)) return { people: [], truncated: false };
const people = raw.filter((r) => r.bbox).map((r) => ({
...r,
bbox: { x: r.bbox.x, y: (band.y0 + r.bbox.y * band.h) / img.naturalHeight, w: r.bbox.w, h: (r.bbox.h * band.h) / img.naturalHeight },
})).concat(raw.filter((r) => !r.bbox));
return { people, truncated };
}));

const people = [];
let truncated = false;
settled.forEach((result, i) => {
if (result.status === 'fulfilled') {
people.push(...result.value.people);
truncated = truncated || result.value.truncated;
} else {
console.error(`Screenshot band ${i + 1}/${bands.length} failed:`, result.reason);
}
});
if (settled.every((r) => r.status === 'rejected')) throw settled[0].reason;

const merged = isBanded ? dedupeByNameAndPosition(people) : people;
const candidates = [];
for (const r of merged) {
const photoBlob = await cropThumbnailToBlob(img, r.bbox);
candidates.push({ name: r.name || '', age: r.age || '', stage: r.stage === 'Chatting in app' ? 'Chatting in app' : 'Matched', photoBlob });
}
return { candidates, truncated };
}

// The cheap first pass. Reads only enough to decide who a screenshot is
// about and whether it's worth a full parse — a small fast model and a tiny
// token budget, so scanning a whole album costs a fraction of a penny rather
// than a full profile extraction each.
//
// Cached by a hash of the image bytes, so re-reviewing the same album never
// bills twice for the same photo.
const QUICK_SCAN_MODEL = 'claude-haiku-4-5-20251001';
const QUICK_SCAN_MAX_TOKENS = 400;

async function quickScanScreenshot(file, app) {
file = await ensureBrowserReadableImage(file);
const hash = await hashFile(file);
const cached = await parseCacheGet(hash, 'quick');
// Keep whichever showing of this image carried the better-evidenced date —
// a renamed copy falling back to its download date must not overwrite an
// EXIF or filename date recorded earlier.
const captured = betterCaptureDate(await captureDateOf(file), cached && cached.captured);
if (cached) {
if ((captured || {}).source !== (cached.captured || {}).source) {
await parseCachePut(hash, 'quick', { ...cached, captured });
}
return { ...cached.result, hash, captureDate: (captured || {}).date || '', fromCache: true };
}

const base64 = await fileToBase64(file);
const mediaType = file.type || 'image/png';
const prompt = `This is a screenshot from ${app || 'a dating app'}. Identify ONLY the following, quickly and cheaply — do not describe anything else. Return ONLY a JSON object, no other text, no markdown fences:
{"name":"", "age":"", "kind":"profile|matches|chat|other", "richness":"rich|thin"}
- name: the person's display name if one is clearly visible, else "".
- age: their age if shown as a number next to the name, else "".
- kind: "profile" for a single person's profile page, "matches" for a list of several people, "chat" for a conversation, "other" for anything else.
- richness: "rich" if the screenshot shows substantial profile detail worth extracting later (bio, job, height, education, prompts); "thin" if it is mostly just a photo, a name, or a chat.`;

const { data: raw } = await callAnthropic(
[
{ type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
{ type: 'text', text: prompt },
],
QUICK_SCAN_MAX_TOKENS,
QUICK_SCAN_MODEL,
'Photo quick scan',
);
const result = {
name: raw.name || '',
age: raw.age || '',
kind: raw.kind || 'other',
richness: raw.richness === 'rich' ? 'rich' : 'thin',
};
await parseCachePut(hash, 'quick', { result, model: QUICK_SCAN_MODEL, captured });
return { ...result, hash, captureDate: (captured || {}).date || '', fromCache: false };
}

// Same fields+shape as the unbanded prompt, plus banded-mode caveats: only
// report a field if it's genuinely visible in THIS section (another band
// supplies what this one can't see, rather than this one guessing), and
// skip a photo box cut off at the very top/bottom edge (under half
// visible) since it's fully visible in the adjacent overlapping band.
// Drinking/smoking get their own explicit instruction rather than a
// clause buried in the general extraction sentence -- confirmed live as
// unreliable without it. Bumble shows these as a bare icon + one-word
// answer with NO text field-label anywhere on screen (a wine-glass icon
// next to "Rarely", a cigarette icon next to "No"), so a model told to
// find a "drinking habit... shown by icon+label" has nothing to anchor
// "label" on and can miss the field entirely. Tinder, by contrast, prints
// a real field label ("Drinking", "How often do you smoke?") with a
// fuller answer ("Socially, at the weekend", "Trying to quit"). Both
// icon conventions and a realistic value range are spelled out so the
// model recognises either layout and reports the value verbatim.
const HABIT_FIELD_GUIDE = 'Their drinking habit and smoking habit specifically -- look for these even when there is NO text field-label at all, just an icon with a short word or phrase next to it: a wine glass, cocktail, or beer icon means drinking; a cigarette icon means smoking. Report the value exactly as shown, whichever form it takes -- a bare word ("Yes", "No", "Rarely", "Socially"), or a fuller phrase ("Socially, at the weekend", "Trying to quit", "Non-smoker", "Sober"). Leave empty only if genuinely not shown, not because it lacks a text label.';

function profilePrompt(isBand, app) {
return `This is a screenshot of ONE person's ${app ? `${app} ` : 'dating app '}profile page`
+ (isBand ? ', showing one vertical section of a longer scrolling screenshot' : '') + '.'
+ ' Extract what\'s visible: name, age, their height exactly as written (e.g. "5\'7\\"" or "170cm", empty if not shown), their education or university (empty if not shown), a short list of languages they speak (array), a short list of nationalities (array, empty if not stated), whether they mention having kids (short phrase or empty), their job/occupation (the exact short text/title only, literally as written, e.g. "Software Engineer" or "Student" — never invent, expand, or paraphrase into a longer description; leave empty if not shown or if you are not confident you\'re reading it correctly), their location or city (empty if not shown), their bio/about-me text -- capture ALL of it verbatim, not a summary: a plain free-text paragraph if that\'s what\'s shown, OR if the app shows separate named prompt-and-answer sections (e.g. Bumble/Hinge style "My simple pleasures are..." followed by their answer), include every one of those prompts with its answer, joined together, a short list of their stated interests/hobbies shown as distinct tag/chip UI elements (array, e.g. "Tennis", "Wine" — not free-text bio content) -- only include a tag if you can actually see its chip/pill shape and read its label text; do not infer or add a plausible-sounding interest just because it fits the person\'s vibe, what they say they\'re looking for/relationship goal (short phrase exactly as written, e.g. "Open to seeing where things go", empty if not shown). ' + HABIT_FIELD_GUIDE + ' Also give rough bounding boxes (fractions 0 to 1 of the full image, keys x,y,w,h) around each distinct profile PHOTOGRAPH visible in the screenshot -- an actual camera picture of the person, there may be several. Do NOT box a text/UI card as if it were a photo -- for example: a white or solid-colored card containing paragraph text (the bio, or a named prompt-and-answer widget like "My simple pleasures are..."), a location badge (a pin icon next to an address like "Alnwick, North East, United Kingdom"), an app menu or options overlay (e.g. "Unmatch" / "Report"), or any panel whose content is mostly typed characters on a plain background rather than a camera image. Only box a region that is clearly continuous-tone photographic imagery -- skin, clothing, scenery, objects. When unsure, leave it out rather than boxing it.'
+ (isBand ? ' Only report a field if its value is genuinely visible in THIS section — leave it empty rather than guessing from context, since another section will supply it. This applies to text just as much as photos: if the bio, or one of its named prompt-and-answer widgets (e.g. "My simple pleasures are..."), is cut off at the very top or bottom edge of this image so you cannot see its complete content, leave the bio field EMPTY for this section entirely rather than completing it from context or reporting a partial/uncertain read — another section has the complete, uncut version, and a partial guess here will just create a near-duplicate with different wording alongside the real one. If a photo is cut off at the very top or bottom edge of this image (less than half visible), SKIP its bounding box entirely — it is fully visible in an adjacent section and will be captured there instead.' : '')
+ ' Return ONLY a JSON object, no other text, no markdown fences, in this exact shape: {"name":"Alex","age":"29","height":"","education":"","languages":["English"],"nationality":[],"kids":"","job":"","location":"","bio":"","interests":["Tennis","Wine"],"lookingFor":"","drinking":"Rarely","smoking":"No","photoBoxes":[{"x":0.1,"y":0.05,"w":0.8,"h":0.4}]}. Use empty string/array if something is not visible or unsure — do not guess.';
}

// Two bands overlap on purpose (see BAND_OVERLAP) -- a photo box fully
// inside the overlap zone can legitimately come back from both bands
// intact. No name to key off here (unlike dedupeByNameAndPosition), so
// this dedupes on position alone.
function dedupePhotoBoxesByPosition(boxes) {
const out = [];
for (const b of boxes) {
const dupe = out.some((o) => Math.abs(o.y - b.y) < 0.03 && Math.abs(o.x - b.x) < 0.05);
if (!dupe) out.push(b);
}
return out;
}

// Merges one result per band into the single flat shape the rest of this
// function (and the cache) expects. Scalars: first band to actually see
// the field wins (the isBand prompt above asks each band not to guess a
// field it can't see, so "first non-empty" is "the band that saw it," not
// a race). Arrays union; bio concatenates (a bio can itself span a band
// boundary); photo boxes translate into whole-image coordinates and dedupe
// across the overlap the same way extractMatchesFromScreenshot does.
function mergeProfileBandResults(results, bands, totalHeight) {
const firstNonEmpty = (key) => (results.map((r) => r[key]).find((v) => String(v || '').trim())) || '';
const unionArr = (key) => {
const seen = new Set(); const out = [];
results.forEach((r) => (Array.isArray(r[key]) ? r[key] : []).forEach((v) => {
const k = String(v || '').trim().toLowerCase();
if (k && !seen.has(k)) { seen.add(k); out.push(v); }
}));
return out;
};
const bios = [...new Set(results.map((r) => String(r.bio || '').trim()).filter(Boolean))];
const photoBoxes = dedupePhotoBoxesByPosition(
results.flatMap((r, i) => (Array.isArray(r.photoBoxes) ? r.photoBoxes : []).map((b) => ({
x: b.x, y: (bands[i].y0 + b.y * bands[i].h) / totalHeight, w: b.w, h: (b.h * bands[i].h) / totalHeight,
}))),
);
return {
name: firstNonEmpty('name'), age: firstNonEmpty('age'), height: firstNonEmpty('height'),
education: firstNonEmpty('education'), languages: unionArr('languages'), nationality: unionArr('nationality'),
kids: firstNonEmpty('kids'), job: firstNonEmpty('job'), location: firstNonEmpty('location'),
bio: bios.join(' '), interests: unionArr('interests'), lookingFor: firstNonEmpty('lookingFor'),
drinking: firstNonEmpty('drinking'), smoking: firstNonEmpty('smoking'), photoBoxes,
};
}

// Screenshot of ONE person's full profile page — richer fields, possibly
// several photos. Long composite screenshots (a full scrolled profile,
// several photos plus every text section) are sliced into overlapping
// bands (see planBands, same mechanism extractMatchesFromScreenshot
// already uses) so text stays legible and photo boxes stay accurate —
// sent whole, a tall enough image gets downscaled by the API to fit its
// size budget, which for an extreme portrait aspect ratio can squash
// small text into illegibility before Claude ever reads it.
async function extractProfileFromScreenshot(file, app) {
file = await ensureBrowserReadableImage(file);
const base64 = await fileToBase64(file);
const mediaType = file.type || 'image/png';
const dataUrl = `data:${mediaType};base64,${base64}`;
// The text half is cached; the cropped photos are not, because they're
// blobs that would bloat the cache and are cheap to re-cut from the image.
const hash = await hashFile(file);
const richCacheKind = `rich-v${PROFILE_SCHEMA_VERSION}`;
const cachedText = await parseCacheGet(hash, richCacheKind);
const quickCached = await parseCacheGet(hash, 'quick');
// Reuse a better-evidenced date recorded by an earlier scan of this same
// image, whichever pass found it.
const captured = betterCaptureDate(
betterCaptureDate(await captureDateOf(file), cachedText && cachedText.captured),
quickCached && quickCached.captured,
);
const captureDate = (captured || {}).date || '';
const img = await loadImage(dataUrl);

let raw;
if (cachedText) {
raw = cachedText.result;
} else {
let bands = planBands(img.naturalWidth, img.naturalHeight, VISION_TIER_STANDARD);
let parseModel = PROFILE_PARSE_MODEL;
if (bands.length > 1) {
parseModel = PROFILE_PARSE_MODEL_TALL;
bands = planBands(img.naturalWidth, img.naturalHeight, VISION_TIER_HIGH_RES);
}
const isBanded = bands.length > 1;
const settled = await Promise.allSettled(bands.map(async (band) => {
const bandBase64 = isBanded ? await sliceToBase64(img, band.y0, band.h) : base64;
const bandMediaType = isBanded ? 'image/png' : mediaType;
const { data } = await callVision(bandBase64, bandMediaType, profilePrompt(isBanded, app), PROFILE_MAX_TOKENS, parseModel, 'low');
return data;
}));
const results = [];
const okBands = [];
settled.forEach((r, i) => {
if (r.status === 'fulfilled') { results.push(r.value); okBands.push(bands[i]); }
else console.error(`Profile band ${i + 1}/${bands.length} failed:`, r.reason);
});
if (!results.length) throw settled[0].reason;
raw = isBanded ? mergeProfileBandResults(results, okBands, img.naturalHeight) : results[0];
await parseCachePut(hash, richCacheKind, { result: raw, captured });
}

const photoBoxes = Array.isArray(raw.photoBoxes) ? raw.photoBoxes : [];
const photoBlobs = [];
for (const box of photoBoxes) {
const blob = await cropThumbnailToBlob(img, box);
if (blob) photoBlobs.push(blob);
}
return {
name: raw.name || 'unidentified',
age: raw.age || '',
// The date the screenshot was taken is when that age was true — it feeds
// straight into ageAsOf, so a 2023 screenshot doesn't claim a 2023 age is
// current.
ageAsOf: captureDate,
height: raw.height || '',
education: raw.education || '',
languages: Array.isArray(raw.languages) ? raw.languages : [],
nationality: Array.isArray(raw.nationality) ? raw.nationality : [],
kids: raw.kids || '',
job: raw.job || '',
location: raw.location || '',
bio: raw.bio || '',
interests: Array.isArray(raw.interests) ? raw.interests : [],
lookingFor: raw.lookingFor || '',
drinking: raw.drinking || '',
smoking: raw.smoking || '',
photoBlobs,
fromCache: !!cachedText,
};
}

// ---- Recipe extraction (Menu tab) ----
//
// Three intake formats share one output shape and one prompt, differing
// only in how the source material reaches Claude: an image goes through the
// same vision path as everything else in this file; a PDF uses the
// Messages API's "document" content block (base64, same shape as an image
// block, verified against Anthropic's current docs rather than assumed —
// this is a shape that has changed before); a web page's HTML is fetched
// server-side (the browser can't read most sites' HTML cross-origin any
// more than it can read Google's photo bytes) and sent as plain text, no
// vision needed.
const RECIPE_MAX_TOKENS = 3000;
function recipePrompt() {
return 'Extract this recipe. Return ONLY a JSON object, no other text, no markdown fences: '
+ '{"name":"", "ingredients":["1 tbsp olive oil", "2 cloves garlic, minced"], "instructions":["Step one.", "Step two."], "notes":""}. '
+ 'ingredients: one string per ingredient, quantity included where given, in the order listed. '
+ 'instructions: one string per step, in order, as written — do not merge or split steps. '
+ 'notes: anything else worth keeping (serving size, prep/cook time, a tip) that isn\'t an ingredient or a step, or "" if none. '
+ 'If no recipe is present, return {"name":"", "ingredients":[], "instructions":[], "notes":""}.';
}

async function extractRecipeFromImage(file) {
const readable = await ensureBrowserReadableImage(file);
const base64 = await fileToBase64(readable);
const { data: raw } = await callAnthropic([
{ type: 'image', source: { type: 'base64', media_type: normalizeImageMediaType(readable.type), data: base64 } },
{ type: 'text', text: recipePrompt() },
], RECIPE_MAX_TOKENS, null, 'Recipe import');
return normaliseRecipeExtract(raw);
}

async function extractRecipeFromPdf(file) {
const base64 = await fileToBase64(file);
const { data: raw } = await callAnthropic([
{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
{ type: 'text', text: recipePrompt() },
], RECIPE_MAX_TOKENS, null, 'Recipe import');
return normaliseRecipeExtract(raw);
}

// `html` arrives already fetched by recipe-fetch.php — most recipe sites
// embed a schema.org Recipe as JSON-LD for search-engine rich snippets,
// which recipes.js checks for and passes through directly when present
// (reliable and free — no model call needed). This is the fallback: hand
// the raw HTML to Claude as text when no such structured data was found.
async function extractRecipeFromHtml(html, sourceUrl) {
const truncated = html.length > 60000 ? html.slice(0, 60000) : html;
const { data: raw } = await callTextJson(
`This is the HTML of a recipe page${sourceUrl ? ` (${sourceUrl})` : ''}. ${recipePrompt()}\n\nHTML:\n${truncated}`,
RECIPE_MAX_TOKENS,
null,
'Recipe import',
);
return normaliseRecipeExtract(raw);
}

function normaliseRecipeExtract(raw) {
return {
name: (raw && raw.name) || '',
ingredients: Array.isArray(raw && raw.ingredients) ? raw.ingredients.map(String) : [],
instructions: Array.isArray(raw && raw.instructions) ? raw.instructions.map(String) : [],
notes: (raw && raw.notes) || '',
};
}

// Disambiguates a fuzzy name match against an incoming photo — "Alena" and
// "Alena A" are a plausible fuzzy match on name alone, but obviously
// different people once both faces are visible. Deliberately not run for
// exact name matches (they don't need it) or wired to auto-apply anything;
// it only ever informs a human decision already in progress, same as every
// other AI-assisted match in this app.
const FACE_COMPARE_MODEL = 'claude-haiku-4-5-20251001';
const FACE_COMPARE_MAX_TOKENS = 200;
async function compareFaces(blobA, blobB) {
const [base64A, base64B] = await Promise.all([fileToBase64(blobA), fileToBase64(blobB)]);
const prompt = 'Image 1 is a photo already saved for a tracked person. Image 2 is a photo from a Google Photos album being considered for the same person. Do these two images show the same person? Reply with ONLY a JSON object, no other text: {"same": true, "reason": "one short sentence"} — using true, false, or the string "unsure" for "same". Say "unsure" rather than guessing if the photos differ too much in angle, lighting or quality to tell, or if either image doesn\'t clearly show a face.';
const { data } = await callAnthropic([
{ type: 'image', source: { type: 'base64', media_type: normalizeImageMediaType(blobA.type), data: base64A } },
{ type: 'image', source: { type: 'base64', media_type: normalizeImageMediaType(blobB.type), data: base64B } },
{ type: 'text', text: prompt },
], FACE_COMPARE_MAX_TOKENS, FACE_COMPARE_MODEL, 'Face comparison');
return {
same: data && data.same === true ? true : data && data.same === false ? false : null,
reason: (data && data.reason) || '',
};
}

// ---- Shopping price search ----
//
// Uses Anthropic's server-hosted web_search tool: the search itself runs on
// Anthropic's infrastructure inside this one request, not as a second round
// trip this app has to drive. Billed per-search on top of tokens — that
// per-search fee isn't in PRICES_PER_MTOK, so the Settings usage estimate
// undercounts this purpose specifically.
const SHOPPING_SEARCH_MODEL = 'claude-haiku-4-5-20251001';
const SHOPPING_SEARCH_MAX_TOKENS = 2000;
function shoppingSearchPrompt(item) {
return `Search for where to buy "${item}" online in the UK, from a couple of well-known retailers that suit this item (e.g. a supermarket, Amazon, a relevant specialist). For each result, note the retailer, the exact product name, the price if shown, and the direct product page URL. `
+ 'After searching, respond with ONLY a JSON array, no other text, no markdown fences, in this exact shape: '
+ '[{"retailer":"","name":"","price":"","url":""}]. Only include results with a real product URL you actually found via search — never invent one. Best matches first, at most 6 results. If nothing useful turns up, return [].';
}
async function searchShoppingItem(item) {
const { data: raw } = await callAnthropic(
[{ type: 'text', text: shoppingSearchPrompt(item) }],
SHOPPING_SEARCH_MAX_TOKENS,
SHOPPING_SEARCH_MODEL,
'Shopping search',
[{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }],
);
const results = Array.isArray(raw) ? raw : [];
return results.filter((r) => r && r.url).slice(0, 6).map((r) => ({
retailer: String(r.retailer || ''), name: String(r.name || ''), price: String(r.price || ''), url: String(r.url || ''),
}));
}

// ---- Translation ----
//
// A free, local Chrome LanguageDetector check happens client-side before
// this is ever called (see tinderimport.js) — this is only reached once
// that's confirmed the text isn't already English, so a cheap/fast model
// is the right call here rather than whatever vision model Settings has
// configured for photo work.
const TRANSLATE_MODEL = 'claude-haiku-4-5-20251001';
const TRANSLATE_MAX_TOKENS = 800;
function translatePrompt(text) {
return `Detect the language of this dating-profile text and translate it into natural English. Text: ${JSON.stringify(text)}\n\n`
+ 'Reply with ONLY a JSON object, no other text, no markdown fences: {"language":"Spanish","translation":"..."} — "language" is the English name of the detected language (e.g. "Spanish", "Russian"), or "English" if it\'s already English (in which case "translation" can just repeat the original text).';
}
async function translateText(text) {
const { data } = await callAnthropic(
[{ type: 'text', text: translatePrompt(text) }],
TRANSLATE_MAX_TOKENS, TRANSLATE_MODEL, 'Translation',
);
return {
language: String((data && data.language) || '').trim(),
translation: String((data && data.translation) || '').trim(),
};
}

// ---- Wellness screenshot (Samsung Health) ----
//
// Reads one of three Samsung Health 7-day charts (Antioxidant index, AGEs
// index, Sleeping HRV) confirmed against real screenshots: each shows a
// row of day-of-month numbers under the chart, sometimes with an explicit
// "16–22 Aug"-style header and sometimes without (e.g. the HRV chart is
// often seen mid-scroll on a longer page, header cropped out). Structured
// extraction, same tier as profile parsing -- Sonnet 5, not the user's
// chosen vision model, for the same reasoning profilePrompt's own comment
// gives (nuanced reading, not deep reasoning).
const WELLNESS_MODEL = 'claude-sonnet-5';
// Confirmed live: this model returns a "thinking" content block even though
// nothing here ever requests one (no `thinking` param is sent) -- and that
// block counts against max_tokens the same as the actual answer. At 800,
// then even at 1500, the whole budget went to thinking and the call hit
// stop_reason:'max_tokens' with NO text block at all, let alone finished
// JSON. Unlike the matches-list extraction elsewhere in this file, a
// truncated JSON *object* also can't be salvaged the way a truncated array
// can (extractJson's salvageArrayPrefix only closes off a cut-off array), so
// this failed outright rather than degrading gracefully. Sized generously
// enough to leave real room after thinking, same "output tokens are cheap, a
// failed import isn't" reasoning PROFILE_MAX_TOKENS/MATCHES_MAX_TOKENS
// already use. If this model's thinking is actually an account-level default
// (an Anthropic Console setting on the API key, not something this app
// requests), no client-side token budget fixes the underlying waste -- worth
// checking there if this keeps needing headroom.
const WELLNESS_MAX_TOKENS = 4000;
// Bumped whenever wellnessPrompt()'s requested fields or WELLNESS_BANDS
// change -- same reason PROFILE_SCHEMA_VERSION exists above: without it,
// re-extracting the exact same screenshot after a prompt change would
// silently keep serving the OLD cached result forever, which is exactly
// what would happen re-testing the screenshots that motivated this.
const WELLNESS_SCHEMA_VERSION = 5;

// Real category-band numeric ranges, confirmed by the user against their
// own live Samsung Health app -- these charts have no numbered y-axis, but
// the bands they ARE labelled with (Low/Adequate/High/...) correspond to
// fixed, known ranges. Feeding the model the band ORDER (so it can match
// what's actually printed on the chart) and doing the label->range->value
// lookup here, rather than asking the model to recall or reproduce these
// numbers itself, keeps the one part that must be exactly right out of
// generation entirely.
const WELLNESS_BANDS = {
ages: [
{ label: 'low', min: 190, max: 398 },
{ label: 'adequate', min: 398, max: 436 },
{ label: 'high', min: 436, max: 644 },
{ label: 'very high', min: 644, max: 796 },
],
antioxidant: [
{ label: 'very low', min: 0, max: 49 },
{ label: 'low', min: 50, max: 74 },
{ label: 'adequate', min: 75, max: 100 },
],
};

function bandRange(metric, label) {
const bands = WELLNESS_BANDS[metric];
if (!bands) return null;
const norm = String(label || '').trim().toLowerCase();
return bands.find((b) => b.label === norm) || null;
}

// Same top-to-bottom screen order named in wellnessPrompt() below --
// exported as data here (not just prose in the prompt) so
// resolveBandedDayValue can turn "N band labels" into "N+1 boundary
// y-fractions" without re-deriving the order from anywhere else.
const WELLNESS_BAND_SCREEN_ORDER = {
antioxidant: ['adequate', 'low', 'very low'],
ages: ['very high', 'high', 'adequate', 'low'],
};

// Confirmed live: asking the model to directly judge "how far up within
// this band" a dot sits (a 0.0-1.0 fraction, no anchor to check itself
// against) produced wildly wrong values -- two dots visibly almost level
// with a known-correct 41 came back as ~2. Proportional-position-within-an-
// unlabelled-region is exactly the kind of fine judgement vision models are
// unreliable at. What they ARE reliably good at (this app's own matches-
// screenshot importer already relies on it for avatar bounding boxes) is
// reporting a coordinate anchored to something visible -- so the model's
// job here is now just "where is each gridline, where is each dot", both
// plain pixel-fraction coordinates, and the interpolation into an actual
// value is done afterward with real arithmetic against those two measured
// positions, not a self-reported guess.
function resolveBandedDayValue(metric, yFractions, dotY) {
const order = WELLNESS_BAND_SCREEN_ORDER[metric];
if (!order || !Array.isArray(yFractions) || yFractions.length !== order.length + 1) return null;
if (typeof dotY !== 'number') return null;
// yFractions must be monotonically increasing top-to-bottom (0=top of
// image) -- a model reporting them out of order means it didn't actually
// locate the lines, and no value here can be trusted.
for (let i = 1; i < yFractions.length; i++) if (yFractions[i] <= yFractions[i - 1]) return null;
const y = Math.min(yFractions[yFractions.length - 1], Math.max(yFractions[0], dotY));
for (let i = 0; i < order.length; i++) {
const top = yFractions[i], bottom = yFractions[i + 1];
if (y < top || y > bottom) continue;
const range = bandRange(metric, order[i]);
if (!range) return null;
// Higher up the screen (smaller y) = higher value, for every band on
// both of these charts -- so fractionUp is 1.0 at the band's top edge
// (its max) and 0.0 at its bottom edge (its min).
const fractionUp = bottom > top ? (bottom - y) / (bottom - top) : 0.5;
return Math.round(range.min + fractionUp * (range.max - range.min));
}
return null;
}

function wellnessPrompt(todayIso) {
return `This is a screenshot from the Samsung Health app (measurements taken via a Galaxy Watch). It shows ONE of these three 7-day charts: Antioxidant index, AGEs (Advanced Glycation End-products) index, or Sleeping heart rate variability (HRV). Today's date is ${todayIso}.

Work out the actual calendar date for each day-of-month number on the x-axis. If a date-range header is visible (e.g. "16–22 Aug"), use its month directly. If only bare day-of-month numbers are visible with no month shown, assume the LAST (rightmost/highest) day number falls within the same calendar month as today (${todayIso}) unless that day number is greater than today's day-of-month, in which case it falls in the previous calendar month -- then count backwards from there for the earlier days (a run of consecutive day-of-month numbers on one chart never crosses more than one month boundary).

Identify which metric this is, then extract:
- The period average, min, and max if shown as text (e.g. "Average 46", "Min 43", "Max 50", or "410 (Daily average)").
- The headline grade/category text if shown (e.g. "Good", "Adequate", "Low", "Very low", "High", "Very high") for the period or the most recent reading.
- The unit if shown (e.g. "ms" for HRV).
- For an Antioxidant or AGEs chart specifically, which are divided into horizontal bands labelled along the right edge (Antioxidant, top to bottom: Adequate, Low, Very low. AGEs, top to bottom: Very high, High, Adequate, Low) with a horizontal gridline at every boundary between them: report the y-position of EVERY boundary gridline as "gridlines", an array of fractions from 0.0 (very top of the whole image) to 1.0 (very bottom of the whole image), to the nearest 0.01, ordered top to bottom -- for Antioxidant (3 bands) that's 4 lines: above Adequate, between Adequate/Low, between Low/Very low, below Very low; for AGEs (4 bands) that's 5 lines. Look for the actual drawn horizontal rule lines, not the text labels (a label usually sits inside a band, not on its boundary line). Omit "gridlines" entirely (leave it null) if the lines genuinely aren't visible or countable -- don't estimate their positions from the labels alone.
- For EACH day with a visible plotted dot, resolve its ISO date (YYYY-MM-DD), then:
  - If a number is printed directly on or next to that dot -- including a callout/tooltip bubble showing one specific day's exact value, which appears when that day has been tapped/highlighted -- record it as "value" with "exact":true.
  - Otherwise, for an Antioxidant or AGEs chart where "gridlines" was reported above: record ONLY the dot's own vertical position as "yFraction", 0.0 (very top of the image) to 1.0 (very bottom), same coordinate system as "gridlines", to the nearest 0.01, with "exact":false. Use the vertical CENTER of the dot marker itself, not its top edge or outer rim -- a dot has a visible radius, and measuring from its edge instead of its middle biases every reading in the same direction. Do NOT judge which band it's in or how far within it -- just the dot's plain y-position; the band and value are computed afterward from where you placed the gridlines.
  - If none of the above apply to a dot (an HRV chart with no number printed at that point, for instance, or gridlines weren't reported), leave that day out of "days" entirely rather than guessing.

Reply with ONLY a JSON object, no other text, no markdown fences:
{"metric":"hrv"|"antioxidant"|"ages"|"unrecognized","periodLabel":"16–22 Aug"|null,"asOfDate":"2026-08-22","gridlines":[0.12,0.38,0.61,0.85]|null,"days":[{"date":"2026-08-22","value":38,"exact":true},{"date":"2026-08-19","yFraction":0.47,"exact":false}],"average":46|null,"min":43|null,"max":50|null,"headlineGrade":"Good"|null,"unit":"ms"|null}
- "asOfDate": the resolved date of the LAST (rightmost/most recent) day the chart covers -- always include this even when "days" is empty, since it's what the period average/min/max/grade describe.
- "days": can be empty if a chart shows no printed numbers, no tapped-day callout, and (for HRV specifically, which has no bands) no other way to place a dot.
- If "metric" is "unrecognized", every other field should be null/empty -- don't guess at a chart type you're not confident about.`;
}

async function extractWellnessScreenshot(file) {
file = await ensureBrowserReadableImage(file);
const hash = await hashFile(file);
const cacheKind = `wellness-v${WELLNESS_SCHEMA_VERSION}`;
const cached = await parseCacheGet(hash, cacheKind);
if (cached) return { ...cached.result, fromCache: true };

const base64 = await fileToBase64(file);
const mediaType = normalizeImageMediaType(file.type || 'image/png');
const todayIso = new Date().toISOString().slice(0, 10);
const { data: raw } = await callAnthropic(
[
{ type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
{ type: 'text', text: wellnessPrompt(todayIso) },
],
// 'low' effort: confirmed live this model thinks by default (Sonnet 5's
// API default is 'high' effort, which "thinks on most requests") even
// though nothing here ever asked for it, and that thinking ate the whole
// max_tokens budget before any JSON came out -- see WELLNESS_MAX_TOKENS's
// own comment. This is plain structured extraction, not reasoning, so
// low effort is the correct fix, not just a workaround: it tells the
// model to skip thinking on a task simple enough not to need it.
WELLNESS_MAX_TOKENS, WELLNESS_MODEL, 'Wellness screenshot', null, 'low',
);
const isIsoDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const metric = ['hrv', 'antioxidant', 'ages'].includes(raw.metric) ? raw.metric : 'unrecognized';
const gridlines = Array.isArray(raw.gridlines) && raw.gridlines.every((n) => typeof n === 'number') ? raw.gridlines : null;
// The model only ever reports plain pixel-fraction coordinates -- where the
// gridlines are, where a dot is -- never a value or a band judgement it
// worked out itself. resolveBandedDayValue does that arithmetic here
// against WELLNESS_BANDS' real, user-confirmed ranges, so neither a vision
// misjudgement of "how far within this band" nor an arithmetic slip can
// produce a wrong reading (see its own comment for why this replaced
// asking the model to self-report that fraction directly).
const days = Array.isArray(raw.days) ? raw.days.map((d) => {
if (!isIsoDate(d.date)) return null;
if (d.exact === true && typeof d.value === 'number') return { date: d.date, value: d.value, exact: true };
if (d.exact === false && typeof d.yFraction === 'number' && gridlines) {
const value = resolveBandedDayValue(metric, gridlines, d.yFraction);
if (value == null) return null;
return { date: d.date, value, exact: false };
}
return null;
}).filter(Boolean) : [];
const result = {
metric,
periodLabel: raw.periodLabel || null,
asOfDate: isIsoDate(raw.asOfDate) ? raw.asOfDate : null,
days,
average: typeof raw.average === 'number' ? raw.average : null,
min: typeof raw.min === 'number' ? raw.min : null,
max: typeof raw.max === 'number' ? raw.max : null,
headlineGrade: raw.headlineGrade || null,
unit: raw.unit || null,
};
await parseCachePut(hash, cacheKind, { result });
return { ...result, fromCache: false };
}

// ---- Trip logistics (screenshot + email) ----
//
// Two input paths (a booking confirmation screenshot dropped in Capture
// Inbox, or an email's full body read via Gmail), one shared field guide and
// result shape -- both only ever report a field they actually found stated
// in the source, same "never invent a gap-filling guess" principle
// wellnessPrompt's band-interpolation comment already establishes for
// numbers. travel.js's enrichLegFromExtraction is what actually writes
// these onto a leg.
const TRIP_MODEL = 'claude-sonnet-5';
// Room for several passengers each with their own seat/baggage line -- a
// family-of-5 booking confirmation genuinely needs more output than a
// single-traveller one, and 1000 tokens was confirmed live to be tight
// enough that a 3-passenger Ryanair confirmation came back with names and
// baggage dropped even though every one of them was printed in the email.
const TRIP_MAX_TOKENS = 1800;
// Bumped whenever tripFieldGuide()'s field list changes -- same reason
// WELLNESS_SCHEMA_VERSION exists, so a prompt change doesn't silently keep
// serving a stale cached screenshot result. v2: added per-passenger
// seat/baggage (previously a single leg-level "seat" field, which can't
// represent more than one traveller) and a `company` field for transfer.
const TRIP_SCHEMA_VERSION = 2;

const LEG_KIND_SET = new Set(['flight', 'car_hire', 'accommodation', 'transfer', 'other']);

const TRIP_FIELD_GUIDE = `- flight: airline, flightNumber, departAirport, departTime (ISO date+time if both known, else just what's printed), arriveAirport, arriveTime, confirmationRef (booking reference / PNR)
- car_hire: company, pickupLocation, pickupTime, dropoffLocation, dropoffTime, confirmationRef, carType
- accommodation: name, address, checkIn, checkOut, confirmationRef, contactPhone
- transfer: company (the train operator or taxi/transfer firm, if named), mode (e.g. "taxi", "train"), from, to, departTime, confirmationRef
- other: description, when, confirmationRef`;

function tripExtractionInstructions() {
return `Identify which ONE of these five kinds of travel logistics this is: flight, car_hire, accommodation, transfer, or other. Then extract ONLY the fields below that are actually stated in the source -- never guess or infer a value that isn't really there; leave a field out entirely if it's not present rather than filling it with something plausible.

Fields by kind (use exactly these JSON key names, only the ones for the kind you identified):
${TRIP_FIELD_GUIDE}

Separately, list EVERY named passenger/traveller/guest on this booking, each with whatever of these is printed for them specifically: their seat (e.g. "12A"), and their baggage/luggage allowance exactly as printed (e.g. "Checked Bag (20kg), Priority & 2 Cabin Bags"). Keep each name as printed, honorific included if shown (e.g. "Mr PHILIP WHITE"). A booking can have several passengers each with a DIFFERENT seat and baggage mix -- list all of them, don't collapse them into one.

Reply with ONLY a JSON object, no other text, no markdown fences. Example, for a 3-passenger Ryanair flight confirmation:
{"kind":"flight","label":"Outbound: London Stansted to Zadar","suggestedTripTitle":"Zadar trip","fields":{"airline":"Ryanair","flightNumber":"FR8388","departAirport":"London (Stansted) - STN","departTime":"Sat 22 Aug 2026, 20:10","arriveAirport":"Zadar - ZAD","arriveTime":"23:30","confirmationRef":"VZIJXS"},"passengers":[{"name":"Mr PHILIP WHITE","seat":"12A","baggage":"Baby equipment, Checked Bag (20kg), Priority & 2 Cabin Bags"},{"name":"Mr LEWIS WHITE","seat":"12B","baggage":"Priority & 2 Cabin Bags"},{"name":"Ms ZARA WHITE","seat":"12C","baggage":"Priority & 2 Cabin Bags"}]}
If nothing recognisable as travel logistics is present, reply {"kind":null,"label":null,"suggestedTripTitle":null,"fields":{},"passengers":[]}.`;
}

function shapeTripExtraction(raw) {
const passengers = Array.isArray(raw.passengers)
? raw.passengers.filter((p) => p && String(p.name || '').trim()).map((p) => ({
name: String(p.name).trim(), seat: p.seat ? String(p.seat).trim() : '', baggage: p.baggage ? String(p.baggage).trim() : '',
}))
: [];
return {
kind: LEG_KIND_SET.has(raw.kind) ? raw.kind : null,
label: raw.label || null,
suggestedTripTitle: raw.suggestedTripTitle || null,
fields: (raw.fields && typeof raw.fields === 'object') ? raw.fields : {},
passengers,
};
}

async function extractTripScreenshot(file) {
file = await ensureBrowserReadableImage(file);
const hash = await hashFile(file);
const cacheKind = `trip-v${TRIP_SCHEMA_VERSION}`;
const cached = await parseCacheGet(hash, cacheKind);
if (cached) return { ...cached.result, fromCache: true };

const base64 = await fileToBase64(file);
const mediaType = normalizeImageMediaType(file.type || 'image/png');
const prompt = `This is a screenshot of a travel booking confirmation (a flight boarding pass or e-ticket, a car hire confirmation, a hotel/accommodation booking, or a transfer/taxi booking). ${tripExtractionInstructions()}`;
const { data: raw } = await callAnthropic(
[
{ type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
{ type: 'text', text: prompt },
],
TRIP_MAX_TOKENS, TRIP_MODEL, 'Trip screenshot', null, 'low',
);
const result = shapeTripExtraction(raw);
await parseCachePut(hash, cacheKind, { result });
return { ...result, fromCache: false };
}

async function extractTripLegFromEmail(subject, from, bodyText) {
const prompt = `This is an email that may be a travel booking confirmation. Subject: "${subject || ''}". From: "${from || ''}".

Email body:
"""
${String(bodyText || '').slice(0, 12000)}
"""

${tripExtractionInstructions()}`;
const { data: raw } = await callTextJson(prompt, TRIP_MAX_TOKENS, TRIP_MODEL, 'Trip email', 'low');
return shapeTripExtraction(raw);
}

// ---- Country lookup ----
//
// For a city, school or university name — often not in English, and
// sometimes already transliterated out of Cyrillic — so the country isn't
// obvious just from the text alone the way it would be for a well-known
// English place name.
const COUNTRY_MODEL = 'claude-haiku-4-5-20251001';
const COUNTRY_MAX_TOKENS = 200;
function countryPrompt(place) {
return `What country is this place in: ${JSON.stringify(place)}? It may be a city, school or university name, possibly not in English or already transliterated out of another script.\n\n`
+ 'Reply with ONLY a JSON object, no other text, no markdown fences: {"country":"Italy"} — the country\'s common English name. If you genuinely can\'t tell, use {"country":""}.';
}
async function identifyCountry(place) {
const { data } = await callAnthropic(
[{ type: 'text', text: countryPrompt(place) }],
COUNTRY_MAX_TOKENS, COUNTRY_MODEL, 'Country lookup',
);
return { country: String((data && data.country) || '').trim() };
}

export {
MissingKeyError, extractMatchesFromScreenshot, extractProfileFromScreenshot, quickScanScreenshot,
callTextJson, DEFAULT_MODEL, summarizeUsage, currentMonthKey, compareFaces,
extractRecipeFromImage, extractRecipeFromPdf, extractRecipeFromHtml, searchShoppingItem, translateText,
identifyCountry, extractWellnessScreenshot,
extractTripScreenshot, extractTripLegFromEmail,
};
