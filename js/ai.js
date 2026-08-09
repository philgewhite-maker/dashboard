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

// Screenshot of a matches/chat list — many small avatars + names.
async function extractMatchesFromScreenshot(file) {
const base64 = await fileToBase64(file);
const mediaType = file.type || 'image/png';
const dataUrl = `data:${mediaType};base64,${base64}`;
const prompt = 'This is a screenshot of a dating app matches or chat list. For each distinct person visible, return their display name, their age if shown next to the name, a tight bounding box around ONLY their small circular avatar photo (not the name, text, or row background) as fractions of the full image (0 to 1, top-left origin, keys x,y,w,h), and their stage: "Matched" if they appear in a row of just avatars with no message preview (e.g. a "New Matches" strip) — meaning you haven\'t started chatting; "Chatting in app" if their row shows a message preview/snippet or timestamp of a conversation, meaning you\'re already messaging. The box should be a tight square around just the circle — err on the side of too small rather than too large, since a box that\'s too tall will bleed into the next row. Return ONLY a JSON array, no other text, no markdown fences. Example: [{"name":"Alex","age":"29","stage":"Chatting in app","bbox":{"x":0.05,"y":0.12,"w":0.09,"h":0.09}}]. Use null for age or bbox if not visible or unsure, and use "Matched" for stage if you can\'t tell. If no people are visible, return [].';
const [{ data: raw, truncated }, img] = await Promise.all([
callVision(base64, mediaType, prompt, MATCHES_MAX_TOKENS),
loadImage(dataUrl),
]);
if (!Array.isArray(raw)) return { candidates: [], truncated: false };
const candidates = [];
for (const r of raw) {
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
