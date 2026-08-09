// Calls the Anthropic Messages API directly from the browser using a key
// the user pastes into Settings (js/state.js keeps it in a device-local
// IndexedDB store that's never included in exports or synced anywhere).
// This only works because of the `anthropic-dangerous-direct-browser-access`
// header — normal server-side calls don't need it, but a client-only app
// with no backend does. See README for the tradeoffs.
import { getLocalSettings } from './state.js';
import { fileToBase64, loadImage, cropThumbnailToBlob } from './utils.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-opus-5';

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

async function callAnthropic(content, maxTokens, modelOverride) {
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
if (result.stop_reason === 'max_tokens') {
console.warn('Response was truncated at max_tokens — the JSON may be incomplete.', result);
}
const textBlock = (result.content || []).find((b) => b.type === 'text');
if (!textBlock) throw new Error('No text in response');
try {
return extractJson(textBlock.text);
} catch (parseErr) {
console.error('Could not parse JSON from Claude response:', textBlock.text);
throw parseErr;
}
}

async function callVision(base64, mediaType, promptText, maxTokens) {
return callAnthropic([
{ type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
{ type: 'text', text: promptText },
], maxTokens);
}

// Text-only Claude call, no image — used for reasoning-over-JSON tasks like
// ranking nudges. modelOverride lets a cheap/fast task (like ranking) skip
// past the user's chosen vision model without touching their Settings.
async function callTextJson(promptText, maxTokens, modelOverride) {
return callAnthropic([{ type: 'text', text: promptText }], maxTokens, modelOverride);
}

// maxTokens defaults are generous on purpose: output tokens are cheap
// relative to the cost of a screenshot import silently failing because a
// busy matches list didn't fit. A long scrolling screenshot can cost far
// more per person than a compact grid (more scroll positions, longer names/
// bios in view), so this is sized well above the typical case rather than
// the average one; if a screenshot still overflows it, the caller gets back
// whichever prefix parsed and a `truncated: true` flag instead of an error.
const MATCHES_MAX_TOKENS = 16000;
const PROFILE_MAX_TOKENS = 2000;

// A vision model estimating bounding-box coordinates has no pixel grid to
// anchor against, so a raw absolute-position guess drifts the further down
// a long image it's looking (observed: roughly half an avatar's diameter
// off by ~26 rows into a long Tinder screenshot). The main fix is in the
// prompt below — anchoring each avatar box to that row's name text instead
// of guessing an absolute position. Banding is a secondary safety net, not
// the primary fix, so the threshold is set high (most real screenshots
// never hit it) rather than aggressively slicing every long list.
const BAND_TARGET_HEIGHT = 4000;
const BAND_OVERLAP = 220;

function matchesPrompt(isBand) {
return 'This is a screenshot of a dating app matches or chat list'
+ (isBand ? ', showing one vertical section of a longer scrolling screenshot' : '')
+ '. For each distinct person visible, return their display name, their age if shown next to the name, a tight bounding box around ONLY their small circular avatar photo (not the name, text, or row background) as fractions of THIS IMAGE (0 to 1, top-left origin, keys x,y,w,h), and their stage: "Matched" if they appear in a row of just avatars with no message preview (e.g. a "New Matches" strip) — meaning you haven\'t started chatting; "Chatting in app" if their row shows a message preview/snippet or timestamp of a conversation, meaning you\'re already messaging.'
+ ' Estimate each avatar box relative to that row\'s name text rather than guessing its absolute position on the page: first locate the name you just read, then place the box immediately next to it (usually to its left) with the box\'s vertical center matching the name text\'s vertical center — anchoring to the name you\'re already reading is far more reliable than an independent guess at where a row falls in a long, uniform list. The box should be a tight square around just the circle — err on the side of too small rather than too large, since a box that\'s too tall will bleed into the next row.'
+ (isBand ? ' If a row is cut off at the very top or very bottom edge of this image (less than half the avatar visible), SKIP it entirely — it is fully visible in an adjacent section and will be captured there instead.' : '')
+ ' Return ONLY a JSON array, no other text, no markdown fences. Example: [{"name":"Alex","age":"29","stage":"Chatting in app","bbox":{"x":0.05,"y":0.12,"w":0.09,"h":0.09}}]. Use null for age or bbox if not visible or unsure, and use "Matched" for stage if you can\'t tell. If no people are visible, return [].';
}

// [{ y0, h }, ...] in source-image pixels. A single band covering the whole
// image when it's already short, so typical screenshots take the same one
// unsliced path as before.
function planBands(totalHeight) {
if (totalHeight <= BAND_TARGET_HEIGHT * 1.3) return [{ y0: 0, h: totalHeight }];
const bands = [];
let y0 = 0;
while (y0 < totalHeight) {
const h = Math.min(BAND_TARGET_HEIGHT, totalHeight - y0);
bands.push({ y0, h });
if (y0 + h >= totalHeight) break;
y0 += BAND_TARGET_HEIGHT - BAND_OVERLAP;
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
async function extractMatchesFromScreenshot(file) {
const base64 = await fileToBase64(file);
const mediaType = file.type || 'image/png';
const dataUrl = `data:${mediaType};base64,${base64}`;
const img = await loadImage(dataUrl);
const bands = planBands(img.naturalHeight);
const isBanded = bands.length > 1;

const settled = await Promise.allSettled(bands.map(async (band) => {
const bandBase64 = isBanded ? await sliceToBase64(img, band.y0, band.h) : base64;
const bandMediaType = isBanded ? 'image/png' : mediaType;
const { data: raw, truncated } = await callVision(bandBase64, bandMediaType, matchesPrompt(isBanded), MATCHES_MAX_TOKENS);
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
candidates.push({ name: r.name, age: r.age || '', stage: r.stage === 'Chatting in app' ? 'Chatting in app' : 'Matched', photoBlob });
}
return { candidates, truncated };
}

// Screenshot of ONE person's full profile page — richer fields, possibly
// several photos.
async function extractProfileFromScreenshot(file) {
const base64 = await fileToBase64(file);
const mediaType = file.type || 'image/png';
const dataUrl = `data:${mediaType};base64,${base64}`;
const prompt = 'This is a screenshot of ONE person\'s dating app profile page. Extract what\'s visible: name, age, a short list of languages they speak (array), a short list of nationalities (array, empty if not stated), whether they mention having kids (short phrase or empty), their job/occupation (empty if not shown), a one or two sentence bio/about-me summary, and rough bounding boxes (fractions 0 to 1 of the full image, keys x,y,w,h) around each distinct profile photo visible in the screenshot (there may be several). Return ONLY a JSON object, no other text, no markdown fences, in this exact shape: {"name":"Alex","age":"29","languages":["English"],"nationality":[],"kids":"","job":"","bio":"","photoBoxes":[{"x":0.1,"y":0.05,"w":0.8,"h":0.4}]}. Use empty string/array if something is not visible or unsure.';
const [{ data: raw }, img] = await Promise.all([
callVision(base64, mediaType, prompt, PROFILE_MAX_TOKENS),
loadImage(dataUrl),
]);
const photoBoxes = Array.isArray(raw.photoBoxes) ? raw.photoBoxes : [];
const photoBlobs = [];
for (const box of photoBoxes) {
const blob = await cropThumbnailToBlob(img, box);
if (blob) photoBlobs.push(blob);
}
return {
name: raw.name || 'unidentified',
age: raw.age || '',
languages: Array.isArray(raw.languages) ? raw.languages : [],
nationality: Array.isArray(raw.nationality) ? raw.nationality : [],
kids: raw.kids || '',
job: raw.job || '',
bio: raw.bio || '',
photoBlobs,
};
}

export { MissingKeyError, extractMatchesFromScreenshot, extractProfileFromScreenshot, callTextJson, DEFAULT_MODEL };
