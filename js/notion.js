// Talks to Notion through the proxy on your own host (server/notion.php).
//
// Notion sends no CORS headers, so the browser cannot call api.notion.com
// directly — this is not a choice, it's the only shape that works. The
// upside is that the Notion token stays on your server and never reaches
// the browser, which matters because that token can read and write your
// whole workspace.
import { getLocalSettings, setLocalSetting } from './state.js';

class NotionNotConfiguredError extends Error {
constructor() {
super('Notion isn\'t set up yet — add the proxy URL and pick a database in Settings.');
this.name = 'NotionNotConfiguredError';
}
}

async function notionConfig() {
const s = await getLocalSettings();
return {
url: (s.notionProxyUrl || '').trim(),
secret: (s.syncSecret || '').trim(), // deliberately the same secret as sync
databaseId: (s.notionDatabaseId || '').trim(),
dataSourceId: (s.notionDataSourceId || '').trim(),
configured: !!((s.notionProxyUrl || '').trim() && (s.syncSecret || '').trim()),
};
}

async function notionFetch(path, method = 'GET', body = null) {
const cfg = await notionConfig();
if (!cfg.configured) throw new NotionNotConfiguredError();

let res;
try {
res = await fetch(cfg.url, {
method: 'POST',
headers: { 'Content-Type': 'application/json', 'X-Sync-Secret': cfg.secret },
body: JSON.stringify({ path, method, body }),
});
} catch (err) {
throw new Error(`Couldn't reach the Notion proxy — check the URL is right and it's https. (${err.message})`);
}

const text = await res.text();
let json = null;
try { json = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON error page */ }

if (!res.ok) {
// Notion's own status codes come through the proxy, so the common
// mistakes can be named rather than reported as a generic failure.
const detail = (json && (json.message || json.error)) || text.slice(0, 160);
if (res.status === 401) throw new Error(`Notion rejected the token — check NOTION_TOKEN in notion.php. (${detail})`);
if (res.status === 404) throw new Error('Notion says "not found" — the usual cause is the database not being shared with your integration. Open it in Notion, ⋯ menu → Connections → add your integration.');
throw new Error(`Notion error ${res.status}: ${detail}`);
}
return json;
}

// A database can now hold several data sources, and pages are created
// against a data source rather than the database itself (API 2025-09-03).
// Resolving it once and caching means the extra lookup isn't paid per page.
async function resolveDataSourceId() {
const cfg = await notionConfig();
if (cfg.dataSourceId) return cfg.dataSourceId;
if (!cfg.databaseId) throw new NotionNotConfiguredError();
const db = await notionFetch(`v1/databases/${cfg.databaseId}`);
const first = (db.data_sources || [])[0];
if (!first) throw new Error('That Notion database has no data sources — unusual; check the ID is a database, not a page.');
await setLocalSetting('notionDataSourceId', first.id);
return first.id;
}

// Which property in the chosen database is the title. Databases name it
// whatever they like ("Name", "Task", "Project"), so it's read from the
// schema rather than assumed.
async function titlePropertyName(dataSourceId) {
const ds = await notionFetch(`v1/data_sources/${dataSourceId}`);
const props = ds.properties || {};
const found = Object.keys(props).find((k) => props[k].type === 'title');
return found || 'Name';
}

// Notion caps a single rich_text run at 2000 characters, and rejects the
// whole request if any run is longer — so long text is split rather than
// silently truncated or failing the call.
function textBlocks(text) {
const paragraphs = String(text || '').split(/\n{2,}/).filter((p) => p.trim());
const blocks = [];
paragraphs.forEach((p) => {
for (let i = 0; i < p.length; i += 1900) {
blocks.push({
object: 'block', type: 'paragraph',
paragraph: { rich_text: [{ type: 'text', text: { content: p.slice(i, i + 1900) } }] },
});
}
});
return blocks;
}

function headingBlock(text) {
return {
object: 'block', type: 'heading_2',
heading_2: { rich_text: [{ type: 'text', text: { content: String(text).slice(0, 1900) } }] },
};
}

function todoBlock(text) {
return {
object: 'block', type: 'to_do',
to_do: { rich_text: [{ type: 'text', text: { content: String(text).slice(0, 1900) } }], checked: false },
};
}

// Creates a page in the configured database for a dashboard task.
async function createPageForTask(task) {
const dataSourceId = await resolveDataSourceId();
const titleProp = await titlePropertyName(dataSourceId);
const children = [
...textBlocks(task.notes),
headingBlock('Captured from the dashboard'),
...textBlocks(`Bucket: ${task.bucket}${(task.contexts || []).length ? `\nContexts: ${task.contexts.join(', ')}` : ''}${task.due ? `\nDue: ${task.due}` : ''}`),
];
const page = await notionFetch('v1/pages', 'POST', {
parent: { type: 'data_source_id', data_source_id: dataSourceId },
properties: {
[titleProp]: { title: [{ type: 'text', text: { content: (task.title || 'Untitled').slice(0, 1900) } }] },
},
children,
});
return { id: page.id, url: page.url };
}

// Appends blocks to an existing page. Notion accepts 100 children per call,
// so a long plan is sent in batches rather than rejected.
async function appendBlocks(pageId, blocks) {
for (let i = 0; i < blocks.length; i += 100) {
await notionFetch(`v1/blocks/${pageId}/children`, 'PATCH', { children: blocks.slice(i, i + 100) });
}
}

async function testConnection() {
const me = await notionFetch('v1/users/me');
return me.name || me.bot?.owner?.user?.name || 'connected';
}

export {
NotionNotConfiguredError, notionConfig, notionFetch, testConnection,
createPageForTask, appendBlocks, resolveDataSourceId,
textBlocks, headingBlock, todoBlock,
};
