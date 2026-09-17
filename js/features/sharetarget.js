// Turns an Android "Share → Dashboard" into either a Task or a Capture
// Inbox batch, depending on what was shared: a share carrying one or more
// files (photos, a CSV, anything) becomes a Capture Inbox batch, waiting
// to be triaged into wherever it actually belongs -- see captureinbox.js.
// A pure text/link share (nothing but a title/text/url, no files) still
// becomes a Task in the GTD Inbox exactly as before.
//
// The service worker answers the POST from the share sheet (GitHub Pages
// can't) and stashes the payload in a cache; this reads it on the next page
// load and captures it. Splitting it that way is forced by the platform, but
// it also means a share survives being interrupted — if the app is killed
// before this runs, the payload is still in the cache next time.
//
// Only works from an installed PWA on Android. iOS has no share target.
import { escapeHtml, scrollAndFlash } from '../utils.js';
import { data } from '../state.js';
import { captureTask, revealTask } from './tasks.js';
import { CAPTURE_OUTCOMES, matchCaptureRule } from './captureOutcomes.js';

const SHARE_CACHE = 'pending-share';

// Kept as an alias, not a second registry -- CAPTURE_OUTCOMES
// (captureOutcomes.js) is the one shared "what can a capture become"
// list every routing mechanism draws from now (this file's own
// shareUrlRules/matchShareRule below, the explicit captureRules
// checked in initShareTarget, and captureinbox.js's image-marker
// check). Re-exported under the old name purely so nothing importing
// it has to change in the same commit.
const SHARE_ACTIONS = CAPTURE_OUTCOMES;

// Case-insensitive exact-or-dot-boundary host match, so a rule for
// "bbcgoodfood.com" catches "www."/"m." subdomains but not
// "notbbcgoodfood.com".
function hostMatches(ruleHost, actualHost) {
const r = String(ruleHost || '').toLowerCase().replace(/^www\./, '');
const a = String(actualHost || '').toLowerCase();
return a === r || a.endsWith('.' + r);
}

// The rule that best matches `link`, or null. Among all rules whose host
// and (optional) path substring both match, the one with the longest
// `path` wins -- so airbnb.co.uk + "/rooms/" beats a bare airbnb.co.uk
// rule for a /rooms/ URL, and a /guest/messages/ URL matches neither.
function matchShareRule(link) {
let u;
try { u = new URL(link); } catch (e) { return null; }
if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
const rules = (data.prefs && data.prefs.shareUrlRules) || [];
const hits = rules.filter((rule) => {
if (!CAPTURE_OUTCOMES[rule.action]) return false;
if (!hostMatches(rule.host, u.hostname)) return false;
const path = String(rule.path || '');
return !path || u.pathname.includes(path);
});
if (!hits.length) return null;
return hits.sort((a, b) => String(b.path || '').length - String(a.path || '').length)[0];
}

// An explicit `#<letter>` on a shared URL -- e.g. "...#T" -- is a
// deliberate override, checked BEFORE shareUrlRules' own host/path
// inference and bypassing it entirely: "I want this as a task/reading
// item today, regardless of what site it's from." Returns the matching
// captureRules row (see state.js) plus the link with the suffix
// stripped, so the suffix never ends up stored on the task/record
// itself; or null if there's no recognised suffix.
function matchUrlSuffix(link) {
let u;
try { u = new URL(link); } catch (e) { return null; }
const trigger = (u.hash || '').replace(/^#/, '');
if (!trigger) return null;
const rule = matchCaptureRule(data, 'urlSuffix', trigger);
if (!rule) return null;
u.hash = '';
return { rule, cleanLink: u.toString() };
}

function metaUrl() {
return new URL('__share-meta', new URL('./', location.href)).href;
}

// Reads and clears the stash. Cleared even on a partial failure, so a
// payload that can't be processed doesn't re-appear on every single load.
async function takePendingShare() {
if (!('caches' in window)) return null;
let cache;
try { cache = await caches.open(SHARE_CACHE); } catch (e) { return null; }
const res = await cache.match(metaUrl());
if (!res) return null;

let meta;
try { meta = await res.json(); } catch (e) { await cache.delete(metaUrl()); return null; }

const files = [];
for (const f of meta.files || []) {
try {
const fileRes = await cache.match(f.key);
if (fileRes) files.push(new File([await fileRes.blob()], f.name, { type: f.type || 'application/octet-stream' }));
} catch (e) {
console.error('Could not read a shared file:', e);
} finally {
await cache.delete(f.key).catch(() => {});
}
}
await cache.delete(metaUrl()).catch(() => {});
return { ...meta, files };
}

// Android apps are inconsistent about which field carries what: some put the
// link in `url`, many put it in `text`, some send a title and nothing else.
// So build the task from whatever actually arrived rather than trusting any
// one field.
function composeTask(share) {
const title = (share.title || '').trim();
const text = (share.text || '').trim();
const url = (share.url || '').trim();

// A bare URL sitting in `text` is the common Chrome case. A forwarded
// message (WhatsApp, a Tinder profile share) usually carries a link
// embedded in a longer sentence instead -- pull out the first one
// found, trimming the trailing punctuation a sentence naturally leaves
// stuck to it, so routing still has something to match against.
const textIsUrl = /^https?:\/\/\S+$/i.test(text);
const embeddedMatch = !textIsUrl && text ? text.match(/https?:\/\/\S+/i) : null;
const embeddedLink = embeddedMatch ? embeddedMatch[0].replace(/[)\]}>.,!?'"]+$/, '') : '';
const link = url || (textIsUrl ? text : embeddedLink);

let taskTitle = title;
if (!taskTitle && text && !textIsUrl) taskTitle = text.split('\n')[0].slice(0, 120);
if (!taskTitle && link) taskTitle = link;
if (!taskTitle && share.files.length) taskTitle = share.files[0].name;
// The generic fallback needs a timestamp -- without one, every share
// this thin (nothing but this) lands in the Inbox titled identically
// "Shared item" with no way to tell two of them apart at a glance.
// Every other branch above already has something distinguishing (the
// title/text/link/filename itself), so this is the only one that needs
// it. `generic` (not a string match against the title) is what the
// caller below actually checks -- keeps that check correct even though
// the title text itself now varies share to share.
const generic = !taskTitle;
if (generic) {
taskTitle = `Shared item, ${new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
}

// The link isn't repeated in the notes: it already has its own field on
// the task (rendered as "Open reference") and is kept on `source`. An
// embedded link stays in the notes too (unlike a bare-URL text) since
// it's still part of the original message, not just a duplicate of the
// link field.
const notes = (text && text !== taskTitle && !textIsUrl) ? text : '';

return {
title: taskTitle,
notes,
link,
generic,
source: { kind: 'share', label: title || link || 'Shared from another app', url: link },
};
}

function banner(message, onOpen) {
const el = document.createElement('div');
el.className = 'share-banner';
el.innerHTML = `<span>${escapeHtml(message)}</span>${onOpen ? '<button type="button">Open it</button>' : ''}<span class="share-x">&times;</span>`;
document.body.appendChild(el);
const close = () => el.remove();
el.querySelector('.share-x').addEventListener('click', close);
const open = el.querySelector('button');
if (open) {
open.addEventListener('click', async () => {
await onOpen();
close();
});
}
setTimeout(close, 12000);
}

async function initShareTarget() {
// Checked on every load rather than only when ?shared=1 is present: the
// query string is easily lost (a redirect, a restored session), and a
// stranded payload would then never be captured.
let share;
try { share = await takePendingShare(); } catch (e) { console.error('Share pickup failed:', e); return; }
// sw.js's handleShare now responds with the redirect BEFORE it reads the
// shared file (see its own comment for why) -- so the page this runs on
// can load and check the share cache before that background write has
// actually finished, finding nothing even though a share genuinely is on
// its way. Only worth retrying when ?shared=1 marks this load as freshly
// arriving from that redirect -- a normal load finding nothing pending is
// the common case, not worth delaying.
if (!share && new URLSearchParams(location.search).get('shared') === '1') {
for (let i = 0; i < 6 && !share; i++) {
await new Promise((r) => setTimeout(r, 300));
try { share = await takePendingShare(); } catch (e) { console.error('Share pickup retry failed:', e); break; }
}
}
if (!share) return;

// A share carrying files goes to the Capture Inbox to be triaged --
// Dating photos, a Task attachment, a Health import -- rather than
// always becoming a Task the way it used to. A pure text/link share
// (no files) falls through below, unchanged.
if (share.files.length > 0) {
const { addCaptureBatch, revealCaptureBatch } = await import('./captureinbox.js');
const title = (share.title || '').trim();
const url = (share.url || '').trim();
const text = (share.text || '').trim();
const label = title || url || text.split('\n')[0].slice(0, 120) || `${share.files.length} shared file${share.files.length === 1 ? '' : 's'}`;
const { batch, failed, healthImports, matchesImports, markerImports, voiceImports } = await addCaptureBatch({
label,
notes: text && text !== label ? text : '',
source: { kind: 'share', label: title || url || 'Shared from another app', url },
files: share.files,
});
// A recognised Health CSV, a Bumble matches-list/full-profile screenshot
// that yielded candidates, a photo claimed by a capture marker, or a
// voice clip that got transcribed is fully consumed on the way in and
// never becomes a batch item -- if that's everything that was shared,
// there's nothing left in Capture Inbox to open.
const parts = [];
if (batch.items.length) parts.push(`Captured ${batch.items.length} file${batch.items.length === 1 ? '' : 's'} to your Capture Inbox as "${label.slice(0, 60)}".`);
if (matchesImports.length) parts.push(matchesImports.join(' '));
if (healthImports.length) parts.push(healthImports.join(' '));
if (markerImports.length) parts.push(markerImports.join(' '));
if (voiceImports.length) parts.push(voiceImports.join(' '));
if (failed.length) parts.push(`${failed.length} couldn't be captured — see Settings.`);
const msg = parts.join(' ') || `Nothing from "${label.slice(0, 60)}" could be captured — see Settings.`;
if (batch.items.length) {
banner(msg, async () => {
const { switchTab } = await import('../tabs.js');
switchTab('tasks');
revealCaptureBatch(batch.id);
});
} else if (matchesImports.length) {
banner(msg, async () => {
const { switchTab } = await import('../tabs.js');
switchTab('datingadmin');
});
} else if (healthImports.length) {
banner(msg, async () => {
const { switchTab } = await import('../tabs.js');
switchTab('health');
});
} else if (markerImports.length || voiceImports.length) {
// Both outcomes a marker can currently reach (task, reading list), and
// the Capture drafts a transcribed voice clip lands in, live on the
// Tasks tab -- always the right destination regardless of which
// actually fired.
banner(msg, async () => {
const { switchTab } = await import('../tabs.js');
switchTab('tasks');
});
} else {
banner(msg);
}
return;
}

// A pure link share: try to auto-route it before falling back to a
// plain Inbox task. An explicit "#<letter>" suffix is a deliberate
// override checked FIRST -- it bypasses shareUrlRules' own host/path
// inference entirely (see matchUrlSuffix's own comment). Absent that,
// shareUrlRules' domain-based inference (recipe import, and whatever
// else gets registered later) gets its turn.
let composed = composeTask(share);
// Nothing usable came through at all -- landing here with title/text/
// url/files all empty (composeTask's own timestamped "Shared item,
// <when>" fallback title kicks in -- see its own comment). Root cause
// NOT established: confirmed live once that the OS share sheet can
// stage a real image for this app as the target and still nothing
// arrives here, which rules out "the source app never attached a
// file" but doesn't yet say what actually goes wrong between the POST
// and this code running -- see sw.js's handleShare for the raw
// request-level facts (content-type/length, actual form field names)
// recorded specifically to narrow that down, surfaced in the note
// below rather than guessed at here. `composed.generic` is the flag
// for "the fallback fired", not a string match against the title --
// the title text itself now carries a timestamp and varies share to
// share.
if (composed.generic && !composed.notes && !composed.link && !share.files.length) {
	const attempted = share.fileAttemptCount > 0;
	// Deliberately states only what was observed, never a guess at why.
	// A first cut of this note asserted "likely blocked by the source
	// app, common for banking-app screenshots" and that turned out to
	// contradict what the user could see for themselves (the same
	// screenshot shares fine, with an image, to WhatsApp and to Claude).
	// A later attempt showed the OS share sheet staging a real 489KB
	// image for this app as the target, yet NOTHING arrived here at
	// all -- ruling out "the source app never attached a file" too, and
	// pointing at this app's own share handling instead. Cause still
	// not established -- these are raw facts (request content-type/
	// length, which form field names actually parsed out, or a handler
	// exception if one was thrown) for diagnosing FROM, not a diagnosis.
	// `at` (when sw.js actually stashed this) matters as much as the rest:
	// this cache is deliberately never cleared on deploy (see sw.js's own
	// SHARE_CACHE comment -- an interrupted share must survive an app
	// update), so an old failed attempt's empty stash can sit there and
	// only get read on some much-later page load, looking exactly like a
	// fresh empty share when it isn't one. Confirmed as a live risk, not
	// yet confirmed as what actually happened -- this timestamp is what
	// would settle it next time, by comparing it to when the share was
	// actually made.
	const stashedAt = share.at ? new Date(share.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'unknown';
	const rawFacts = `[stashed: ${stashedAt} · ct: ${share.requestContentType || '(none)'} · len: ${share.requestContentLength || '(none)'} · fields: ${(share.formFieldNames || []).join(', ') || '(none)'}${share.handlerError ? ` · handler threw: ${share.handlerError}` : ''}]`;
	// The raw bytes sw.js read directly off the request, bypassing
	// formData() entirely -- proves whether a real body arrived (byte
	// count) and, from the snippet, whether the multipart structure
	// (boundary line, a "files" part) is genuinely in there even though
	// formData() parsed none of it out. On its own line since it can run
	// to a few hundred characters, unlike the compact rawFacts line above.
	// My own bug, first cut of this: byteLength null (the read failed)
	// silently discarded whatever rawBodySnippet held -- which is exactly
	// where sw.js puts the failure's own error message. Show it either way.
	const rawBody = share.rawBodyByteLength != null
		? `Raw body: ${share.rawBodyByteLength} bytes. First 400 as text: "${share.rawBodySnippet || ''}"`
		: `Raw body: not captured. ${share.rawBodySnippet || '(no error recorded)'}`;
	const note = attempted
		? `Shared with no readable content — the share attached ${share.fileAttemptCount === 1 ? 'a file' : `${share.fileAttemptCount} files`} (${(share.emptyFileNames || []).filter(Boolean).join(', ') || 'unnamed'}), but 0 bytes of it arrived here, so nothing could be captured. ${rawFacts}\n\n${rawBody}`
		: `Shared with no title, text, link, or file at all. ${rawFacts}\n\n${rawBody}`;
	// The exact signature of the platform-level failure chased at length on
	// 18 Sept: Android/Chrome hands over a multipart envelope with a real
	// boundary and ZERO parts in it (raw body is just the closing boundary,
	// ~75 bytes). Everything app-side was eliminated as a cause -- the
	// source app, this app's own code (unchanged since file shares
	// demonstrably worked), the manifest's accept list, and a genuinely
	// re-minted WebAPK (version code 2) -- and a plain link share through
	// the same share_target still works, so only the files param is
	// affected. Nothing here can conjure bytes the browser never sent, so
	// rather than banking a useless "Shared item" task every time, point
	// at the one intake path that doesn't involve the share sheet at all.
	const emptyMultipart = /multipart\/form-data/i.test(share.requestContentType || '') && !(share.formFieldNames || []).length;
	if (emptyMultipart) {
		console.error('Share arrived as an empty multipart body, no parts:', note);
		banner("Android didn't pass the file through — use Capture files instead.", async () => {
			const { switchTab } = await import('../tabs.js');
			switchTab('tasks');
			scrollAndFlash('#capture-inbox-panel');
		});
		return;
	}
	composed = { ...composed, notes: note };
}
const link = composed.link;
const suffixHit = link ? matchUrlSuffix(link) : null;
if (suffixHit) {
// Never store the routing suffix itself on the fallback task if the
// outcome below throws -- strip it from the link/source up front.
// composeTask() falls back to the (unstripped) link as the title when
// nothing better was shared alongside it, so that needs the same fix
// or the suffix survives into the title even though the URL itself is
// clean.
composed = {
...composed,
title: composed.title === link ? suffixHit.cleanLink : composed.title,
link: suffixHit.cleanLink,
source: { ...composed.source, url: suffixHit.cleanLink },
};
}
const hit = !suffixHit && link ? matchShareRule(link) : null;

if (suffixHit || hit) {
const outcomeKey = suffixHit ? suffixHit.rule.outcome : hit.action;
const action = CAPTURE_OUTCOMES[outcomeKey];
const host = (() => { try { return new URL(composed.link).hostname.replace(/^www\./, ''); } catch (e) { return composed.link; } })();
banner(`Opening ${host}…`);
try {
await action.run({ title: composed.title, notes: composed.notes, url: composed.link, photoIds: [], source: composed.source });
banner(action.successBanner(host), async () => {
const { switchTab } = await import('../tabs.js');
switchTab(outcomeKey === 'recipe' ? 'menu' : 'tasks');
});
return;
} catch (err) {
// Fall through to the task fallback below, carrying the reason.
fileShareAsTask(composed, `Tried to auto-open this (${action.label}) but: ${err.message || err}`);
return;
}
}

fileShareAsTask(composed);
}

// The unchanged fallback: a shared link becomes an Inbox task. `note`,
// when given, is an auto-route failure reason appended to the task's
// notes so the URL and what went wrong stay together.
function fileShareAsTask(composed, note) {
const notes = note ? (composed.notes ? `${composed.notes}\n\n${note}` : note) : composed.notes;
const task = captureTask({ ...composed, notes });
banner(`Captured "${task.title.slice(0, 60)}" to your Inbox${note ? ' — auto-open didn\'t work, see its notes' : ''}.`, async () => {
const { switchTab } = await import('../tabs.js');
switchTab('tasks');
revealTask(task.id);
});
}

// banner() is also reused by shopping.js's price-scrape intake — same
// "dismissable, self-closing notice, optional action button" shape,
// not worth a second copy just because that one isn't share-triggered.
export { initShareTarget, composeTask, takePendingShare, SHARE_ACTIONS, matchShareRule, banner };
