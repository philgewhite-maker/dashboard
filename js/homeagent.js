// Talking to the agent at home, without anything at home being reachable.
//
// The dashboard can't call Plex: it runs on GitHub Pages, Plex is behind
// the router. So instead of a request, a command is left on commands.php
// (public hosting, same shared secret as every other proxy) and the agent
// on the NAS collects it, answers on the LAN, and posts the result back.
// Every call here is therefore "leave a note, then check for a reply" --
// which is why each one takes a while and none of them can be assumed to
// arrive at all. See home-agent/ for the other end.
import { getConfig } from './sync/selfhost.js';

class AgentNotConfiguredError extends Error {
constructor() {
super('The home agent needs live sync set up first — add your sync URL and secret in Settings.');
this.name = 'AgentNotConfiguredError';
}
}

async function commandsEndpoint() {
const { url, secret, configured } = await getConfig();
if (!configured) throw new AgentNotConfiguredError();
const endpoint = url.replace(/sync\.php(?=$|\?)/, 'commands.php');
if (endpoint === url) throw new Error(`Couldn't work out the commands URL from "${url}" — it should end in sync.php.`);
return { endpoint, secret };
}

const REQUEST_TIMEOUT_MS = 15000;
// How long to keep asking before giving up on a reply. The agent polls on
// its own schedule (45s by default), so anything less than a couple of
// those is just impatience; anything more is a hung UI.
const RESULT_TIMEOUT_MS = 150000;
const RESULT_POLL_MS = 3000;

async function request(path, options = {}) {
const { endpoint, secret } = await commandsEndpoint();
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
try {
const res = await fetch(`${endpoint}?${path}`, {
...options,
headers: { 'X-Sync-Secret': secret, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
signal: controller.signal,
});
if (!res.ok) {
let detail = `HTTP ${res.status}`;
try { detail = (await res.json()).error || detail; } catch (e) { /* not JSON */ }
throw new Error(detail);
}
return res.json();
} catch (err) {
if (err.name === 'AbortError') throw new Error("The command server didn't respond.");
throw err;
} finally {
clearTimeout(timer);
}
}

// Is anything listening? Used to say "the agent is offline" rather than
// leaving a queued command looking identical to a stopped container.
async function agentHeartbeat() {
const beat = await request('action=heartbeat');
return beat && beat.seenAt ? beat : null;
}

async function enqueue(verb, args = {}) {
const { id } = await request('action=enqueue', { method: 'POST', body: JSON.stringify({ verb, args }) });
return id;
}

async function resultFor(id, { timeoutMs = RESULT_TIMEOUT_MS } = {}) {
const deadline = Date.now() + timeoutMs;
while (Date.now() < deadline) {
const { commands } = await request(`action=status&ids=${encodeURIComponent(id)}`);
const found = (commands || [])[0];
if (found && found.status === 'done') return found.result;
if (found && found.status === 'error') throw new Error(found.error || 'The agent reported a failure.');
await new Promise((r) => setTimeout(r, RESULT_POLL_MS));
}
throw new Error("The agent didn't answer — is it running at home?");
}

// The common case: ask, wait, get the answer.
async function run(verb, args = {}, options = {}) {
return resultFor(await enqueue(verb, args), options);
}

export { run, enqueue, resultFor, agentHeartbeat, AgentNotConfiguredError };
