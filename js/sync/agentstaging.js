// Drains server/agent-write.php's always-plaintext staging mailbox into
// the real, synced (and possibly end-to-end-encrypted) data -- the ONE
// place allowed to, since this runs in the browser, which holds the
// E2E encryption key (js/synccrypto.js) that agent-write.php itself
// never has and never should. See that PHP file's own header comment
// for the full reasoning: the staging file exists specifically because
// a server-side script cannot read or splice a field into an encrypted
// document, only the browser can.
//
// Wired into js/sync/autosync.js's existing poll/visibility/init call
// sites, independently gated (its own config check, its own try/catch)
// so it never interferes with the main sync's own busy/isConfigured()
// state.
import { data, queueSave, getLocalSettings } from '../state.js';

async function getConfig() {
const settings = await getLocalSettings();
const url = (settings.agentWriteUrl || '').trim();
const secret = (settings.agentSecret || '').trim();
return { url, secret, configured: !!(url && secret) };
}

let draining = false;

async function drainAgentStaging() {
if (draining) return;
const { url, secret, configured } = await getConfig();
if (!configured) return;
draining = true;
try {
let res;
try {
res = await fetch(`${url}?fields=claudeSubscriptionUsage,agentInbox`, { headers: { 'X-Agent-Secret': secret } });
} catch {
return; // offline or misconfigured -- same quiet-skip resilience pull() already has
}
if (!res.ok) return;
const body = await res.json();
const { rev, claudeSubscriptionUsage, agentInbox } = body;
let changed = false;
if (claudeSubscriptionUsage) {
data.claudeSubscriptionUsage = claudeSubscriptionUsage;
changed = true;
}
const newEntries = (Array.isArray(agentInbox) ? agentInbox : []).filter((e) => !data.agentInbox.some((x) => x.id === e.id));
if (newEntries.length) {
data.agentInbox.push(...newEntries);
changed = true;
}
if (changed) queueSave();

// Consume by id, never a blanket clear -- avoids dropping something
// the external script appends in the gap between the GET above and
// the consume/replace calls below.
if (newEntries.length) {
await postConsume(url, secret, rev, newEntries.map((e) => e.id)).catch(() => {});
}
if (claudeSubscriptionUsage) {
// A flat value is always safely superseded by the next write -- no
// id-tracking needed, unlike the array above.
await postReplace(url, secret, rev, 'claudeSubscriptionUsage', null).catch(() => {});
}
} finally {
draining = false;
}
}

async function postConsume(url, secret, rev, ids) {
await fetch(url, {
method: 'POST',
headers: { 'X-Agent-Secret': secret, 'Content-Type': 'application/json' },
body: JSON.stringify({ rev, action: 'consume', field: 'agentInbox', ids }),
});
}
async function postReplace(url, secret, rev, field, value) {
await fetch(url, {
method: 'POST',
headers: { 'X-Agent-Secret': secret, 'Content-Type': 'application/json' },
body: JSON.stringify({ rev, action: 'replace', field, value }),
});
}

export { drainAgentStaging };
