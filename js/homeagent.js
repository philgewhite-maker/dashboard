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
// Every wait starts with the time the job spends sitting in the queue
// before the agent even looks at it, which is up to one poll interval and
// has nothing to do with how long the work takes. Without this a caller
// has to know the agent's cadence to pick a timeout, and the stock check
// got it wrong: it waited 28 seconds for one page against a 45-second
// poll, so it ALWAYS gave up first -- and reported "is it running at
// home?" about an agent that was running, collected the job seconds
// later, and logged `page.fetch -> ok`.
//
// 60s covers the 45s default with slack. A faster POLL_SECONDS makes
// everything feel quicker; it never makes this wrong.
const COLLECT_ALLOWANCE_MS = 60000;

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
// A bare "Failed to fetch" (Chrome) / "NetworkError..." (Firefox) is the
// browser's own generic wording for "the request never even reached the
// server" -- DNS, no internet, a CORS block, the host being down -- and
// surfaces identically whether it's your own connection or commands.php
// itself that's the problem. Named here rather than left as the raw
// browser string, which every caller otherwise has to re-explain from
// scratch (confirmed live as a real support dead-end: "Failed to fetch"
// told nobody anything about where to even start looking).
if (err instanceof TypeError) throw new Error(`Couldn't reach the command queue (${endpoint}) at all -- check your internet connection, and that the sync URL in Settings is still correct.`);
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
// The caller's timeout is for the WORK; the allowance is for the wait
// before it starts.
const deadline = Date.now() + COLLECT_ALLOWANCE_MS + timeoutMs;
let lastStatus = null;
while (Date.now() < deadline) {
const { commands } = await request(`action=status&ids=${encodeURIComponent(id)}`);
const found = (commands || [])[0];
if (found && found.status === 'done') return found.result;
if (found && found.status === 'error') throw new Error(found.error || 'The agent reported a failure.');
if (found) lastStatus = found.status;
await new Promise((r) => setTimeout(r, RESULT_POLL_MS));
}
// Two genuinely different situations, confirmed live as actually
// different (not just a guess at two possible causes): 'claimed' means
// the agent DID pick this up and was actively working when this gave up
// -- commonly because it was still paying down an earlier batch of page
// fetches (a set search, a stock-check sweep -- each one paced seconds
// apart, so several of them queued together can easily run past this
// wait on their own). The job usually finishes moments later regardless
// -- lowering POLL_SECONDS wouldn't help here at all, since the agent
// was never idle. Only a genuinely 'pending' (or never-seen) status
// means the agent hasn't even looked at the queue, which IS what
// POLL_SECONDS governs.
if (lastStatus === 'claimed') {
throw new Error("The agent picked this up but hadn't finished by the time this gave up — most likely it was still working through an earlier batch of fetches (it does one at a time). It'll probably finish on its own moments later; try again shortly, or check `docker logs dashboard-agent` to see what it's doing.");
}
throw new Error("The agent never picked that up — check `docker logs dashboard-agent`; if it shows the job succeeded anyway, lower POLL_SECONDS in its .env.");
}

// The common case: ask, wait, get the answer.
async function run(verb, args = {}, options = {}) {
return resultFor(await enqueue(verb, args), options);
}

export { run, enqueue, resultFor, agentHeartbeat, AgentNotConfiguredError };
