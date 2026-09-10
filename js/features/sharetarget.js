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
import { escapeHtml } from '../utils.js';
import { data } from '../state.js';
import { captureTask, revealTask } from './tasks.js';

const SHARE_CACHE = 'pending-share';

// Shared-link auto-routing. A URL shared to the app is matched against
// data.prefs.shareUrlRules (see state.js); a matching rule's `action`
// keys into here. Adding an action later is just another entry -- the
// Settings rule editor lists whatever's registered, and the routing
// below dispatches by key with a uniform "throws -> fall back to a
// plain task carrying the URL and the error" contract. Only 'recipe' is
// wired today; airbnb/event/etc. slot in the same way.
const SHARE_ACTIONS = {
recipe: {
label: 'Import as a recipe',
successBanner: (host) => `Read a recipe from ${host} — review and save it on the Menu tab.`,
run: async (url) => {
const { importSharedRecipeUrl } = await import('./recipes.js');
await importSharedRecipeUrl(url); // throws on any failure -> caller falls back
const { switchTab } = await import('../tabs.js');
switchTab('menu');
},
},
};

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
if (!SHARE_ACTIONS[rule.action]) return false;
if (!hostMatches(rule.host, u.hostname)) return false;
const path = String(rule.path || '');
return !path || u.pathname.includes(path);
});
if (!hits.length) return null;
return hits.sort((a, b) => String(b.path || '').length - String(a.path || '').length)[0];
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

// A bare URL sitting in `text` is the common Chrome case.
const textIsUrl = /^https?:\/\/\S+$/i.test(text);
const link = url || (textIsUrl ? text : '');

let taskTitle = title;
if (!taskTitle && text && !textIsUrl) taskTitle = text.split('\n')[0].slice(0, 120);
if (!taskTitle && link) taskTitle = link;
if (!taskTitle && share.files.length) taskTitle = share.files[0].name;
if (!taskTitle) taskTitle = 'Shared item';

// The link isn't repeated in the notes: it already has its own field on
// the task (rendered as "Open reference") and is kept on `source`.
const notes = (text && text !== taskTitle && !textIsUrl) ? text : '';

return {
title: taskTitle,
notes,
link,
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
const { batch, failed, healthImports, matchesImports } = await addCaptureBatch({
label,
notes: text && text !== label ? text : '',
source: { kind: 'share', label: title || url || 'Shared from another app', url },
files: share.files,
});
// A recognised Health CSV, or a Bumble matches-list/full-profile
// screenshot that yielded candidates, is fully consumed on the way in and
// never becomes a batch item -- if that's everything that was shared,
// there's nothing left in Capture Inbox to open.
const parts = [];
if (batch.items.length) parts.push(`Captured ${batch.items.length} file${batch.items.length === 1 ? '' : 's'} to your Capture Inbox as "${label.slice(0, 60)}".`);
if (matchesImports.length) parts.push(matchesImports.join(' '));
if (healthImports.length) parts.push(healthImports.join(' '));
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
} else {
banner(msg);
}
return;
}

// A pure link share: try to auto-route it (recipe import, and whatever
// else gets registered later) before falling back to a plain Inbox task.
const composed = composeTask(share);
const link = composed.link;
const hit = link ? matchShareRule(link) : null;
if (hit) {
const host = (() => { try { return new URL(link).hostname.replace(/^www\./, ''); } catch (e) { return link; } })();
const action = SHARE_ACTIONS[hit.action];
banner(`Opening ${host}…`);
try {
await action.run(link);
banner(action.successBanner(host), async () => {
const { switchTab } = await import('../tabs.js');
switchTab(hit.action === 'recipe' ? 'menu' : 'tasks');
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

export { initShareTarget, composeTask, takePendingShare, SHARE_ACTIONS, matchShareRule };
