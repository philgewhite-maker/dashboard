// Wi-Fi arrivals: when did the guests' devices first appear on the guest Wi-Fi, when were they last seen, and when did
// the cleaner's phone come and go.
//
// The router (TP-Link Archer BE3600) has a segregated guest network, so "a new device on the guest Wi-Fi" is a good
// proxy for "the guests have arrived". The home agent (home-agent/wifipresence.py, agent 1.18+) polls the router's
// client list and turns it into visits; this file pulls them (wifi.events), keeps them in the synced document and
// answers "which stay does this device belong to".
//
// Data: data.wifiDevices (MAC -> {hostname, net, firstSeen, lastSeen, role, label}), data.wifiVisits (one stretch of a
// device on the Wi-Fi, id = mac_from), data.wifiPulledAt (cursor for the next pull). All times are ISO UTC strings.
//
// Pure functions (no DOM, no clock unless passed): mergeWifiEvents, matchStays, cleanerVisits, selfTest.
// Console: (await import('./js/features/wifipresence.js')).selfTest()
import { run, AgentNotConfiguredError } from '../homeagent.js';
import { getConfig } from '../sync/selfhost.js';
import { data, queueSave, blankWifiDevice, blankWifiVisit } from '../state.js';
import { escapeHtml } from '../utils.js';

const ROLES = [['', 'Unassigned'], ['guest', 'Guest'], ['me', 'Me'], ['family', 'Family'], ['visitor', 'Visitors'], ['cleaner', 'Cleaner'], ['household', 'Household'], ['ignore', 'Ignore']];
// Only these can be a stay's guest device: a device tagged cleaner/household/ignore never is.
const GUEST_ROLES = new Set(['', 'guest']);
const RETENTION_MS = 120 * 86400000;
const PULL_OVERLAP_MS = 10 * 60 * 1000; // ask for a little before the cursor, so a clock difference can't drop a change
const AUTO_PULL_MS = 5 * 60 * 1000;
const MAX_CLEANER_ROWS = 15;

let busy = false;
let agentStatus = null; // the agent's last status object (wifi.events / wifi.pause / wifi.resume replies); not synced
let lastError = null; // {html} of the last failed call
let lastAttemptAt = 0;

// ---- pure logic -------------------------------------------------------------------------------------------------

const ms = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : null; };
const localMs = (date, hour) => { const [y, m, d] = String(date).split('-').map(Number); return new Date(y, m - 1, d, hour, 0, 0).getTime(); };

// Fold a wifi.events reply into `store` ({wifiDevices, wifiVisits}) -- the live `data`, or a fake in the self-test.
// Visits are matched by mac + from, so pulling the same change twice (or an open visit that has since closed) replaces
// rather than duplicates. A device's role and label are only ever changed by the user, never here.
function mergeWifiEvents(store, result, now = Date.now()) {
const visits = Array.isArray(store.wifiVisits) ? store.wifiVisits : (store.wifiVisits = []);
const devices = store.wifiDevices && typeof store.wifiDevices === 'object' ? store.wifiDevices : (store.wifiDevices = {});
const byId = new Map(visits.map((v, i) => [v.id, i]));
(result && result.visits || []).forEach((raw) => {
if (!raw || !raw.mac || !raw.from) return;
const v = blankWifiVisit({ ...raw, id: `${raw.mac}_${raw.from}` });
if (byId.has(v.id)) visits[byId.get(v.id)] = v; else { byId.set(v.id, visits.length); visits.push(v); }
});
// Devices are rebuilt from every visit we hold for that MAC (first/last seen, latest hostname and network), so the
// device row stays right even when only a changed visit was pulled.
const latest = new Map();
visits.forEach((v) => {
const cur = latest.get(v.mac);
if (!cur || (v.lastSeen || v.from) >= (cur.lastSeen || cur.from)) latest.set(v.mac, v);
});
latest.forEach((v, mac) => {
const mine = visits.filter((x) => x.mac === mac);
const first = mine.reduce((a, x) => (x.from < a ? x.from : a), v.from);
const d = devices[mac] || (devices[mac] = blankWifiDevice());
d.firstSeen = d.firstSeen && d.firstSeen < first ? d.firstSeen : first;
d.lastSeen = v.lastSeen || v.from;
d.net = v.net || d.net || 'home';
if (v.hostname) d.hostname = v.hostname;
});
// 120 days, like the agent. A visit still open is never dropped.
const cutoff = new Date(now - RETENTION_MS).toISOString();
store.wifiVisits = visits.filter((v) => v.to == null || (v.lastSeen || v.from) >= cutoff);
return store;
}

// For each stay, the guest-network devices that arrived during it.
//
// A device belongs to a stay when it is on the guest network, is not tagged cleaner/household/ignore, and was FIRST seen
// inside the stay's window: check-in day 00:00 local to checkout day 12:00 local. One first seen before that check-in day
// is someone else's (a previous guest, the owner) and is excluded. Two stays whose windows both contain the first sighting
// (the one guest SSID serves both rooms, and a turnover day overlaps the stay before) list the device on both, marked
// `ambiguousWith` the other stays' ids: it can't be told which room.
// `lastSeen` is the latest sighting among those devices' visits that began by checkout noon; `open` is true while one is
// still running. Cancelled stays and same-day bookings (checkout not after check-in) are skipped.
function matchStays(stays, devices, visits) {
const live = (stays || []).filter((s) => s && s.status !== 'cancelled' && s.checkin && s.checkout && s.checkout > s.checkin)
.map((s) => ({ stay: s, start: localMs(s.checkin, 0), end: localMs(s.checkout, 12), devices: [] }));
const visitsByMac = new Map();
(visits || []).forEach((v) => { if (!visitsByMac.has(v.mac)) visitsByMac.set(v.mac, []); visitsByMac.get(v.mac).push(v); });
Object.keys(devices || {}).forEach((mac) => {
const dev = devices[mac];
if (!dev || dev.net !== 'guest' || !GUEST_ROLES.has(dev.role || '')) return;
const mine = visitsByMac.get(mac) || [];
const firsts = [ms(dev.firstSeen), ...mine.map((v) => ms(v.from))].filter((t) => t != null);
if (!firsts.length) return;
const first = Math.min(...firsts);
const hits = live.filter((w) => first >= w.start && first <= w.end);
hits.forEach((w) => {
const during = mine.filter((v) => ms(v.from) != null && ms(v.from) <= w.end);
const lastTimes = during.map((v) => ms(v.lastSeen || v.from)).filter((t) => t != null);
if (!lastTimes.length && ms(dev.lastSeen) != null) lastTimes.push(ms(dev.lastSeen));
w.devices.push({
mac, device: dev, firstSeen: first,
lastSeen: lastTimes.length ? Math.max(...lastTimes) : first,
open: during.some((v) => v.to == null),
ambiguousWith: hits.filter((o) => o !== w).map((o) => o.stay.id),
});
});
});
return live.map((w) => {
const d = w.devices.slice().sort((a, b) => a.firstSeen - b.firstSeen);
return {
stay: w.stay, start: w.start, end: w.end, devices: d,
firstSeen: d.length ? d[0].firstSeen : null,
lastSeen: d.length ? Math.max(...d.map((x) => x.lastSeen)) : null,
open: d.some((x) => x.open),
ambiguous: d.some((x) => x.ambiguousWith.length),
};
});
}

// Visits of devices tagged Cleaner, newest first: [{mac, name, from, to|null, lastSeen, ms}]
function cleanerVisits(devices, visits) {
return (visits || [])
.filter((v) => devices && devices[v.mac] && devices[v.mac].role === 'cleaner')
.map((v) => ({ mac: v.mac, name: deviceName(devices[v.mac], v.mac), from: ms(v.from), to: v.to == null ? null : ms(v.to), lastSeen: ms(v.lastSeen || v.from) }))
.filter((v) => v.from != null)
.sort((a, b) => b.from - a.from);
}

const pad = (n) => String(n).padStart(2, '0');
function clock(t) { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function dayName(t) { return new Date(t).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }); }
function duration(fromMs, toMs) {
const mins = Math.max(0, Math.round((toMs - fromMs) / 60000));
const h = Math.floor(mins / 60);
return h ? `${h}h ${pad(mins % 60)}m` : `${mins}m`;
}
function deviceName(dev, mac) {
return (dev && (dev.label || dev.hostname)) || `Device …${String(mac).slice(-5)}`;
}

// ---- self-test (console) ----------------------------------------------------------------------------------------

function selfTest() {
const failures = [];
let passed = 0;
const ok = (name, cond) => { if (cond) passed++; else failures.push(name); };
const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString(); // local wall time -> ISO UTC
const stayA = { id: 'A', listingId: 'L1', checkin: '2026-03-10', checkout: '2026-03-13', status: 'booked' };
const stayB = { id: 'B', listingId: 'L2', checkin: '2026-03-12', checkout: '2026-03-15', status: 'booked' };
const dev = (firstSeen, o = {}) => blankWifiDevice({ net: 'guest', firstSeen, lastSeen: firstSeen, ...o });
const visit = (mac, from, to, lastSeen, o = {}) => blankWifiVisit({ id: `${mac}_${from}`, mac, net: 'guest', from, to, lastSeen: lastSeen || to || from, ...o });
const find = (res, id) => res.find((r) => r.stay.id === id);

// 1. A guest device first seen mid-stay belongs to it, with first and last sighting.
{
const devices = { 'AA:01': dev(at(2026, 3, 10, 14, 32)) };
const visits = [visit('AA:01', at(2026, 3, 10, 14, 32), at(2026, 3, 11, 9, 0)), visit('AA:01', at(2026, 3, 12, 18, 0), at(2026, 3, 13, 10, 5))];
const r = find(matchStays([stayA], devices, visits), 'A');
ok('matched: one device', r.devices.length === 1);
ok('matched: first sighting', r.firstSeen === Date.parse(at(2026, 3, 10, 14, 32)));
ok('matched: last seen is the latest visit', r.lastSeen === Date.parse(at(2026, 3, 13, 10, 5)));
ok('matched: closed, not open', r.open === false && r.ambiguous === false);
}
// 2. Seen before the check-in day: excluded. Seen on the check-in day after 00:00: included. After checkout noon: out.
{
const devices = { 'B1': dev(at(2026, 3, 9, 23, 59)), 'B2': dev(at(2026, 3, 10, 0, 1)), 'B3': dev(at(2026, 3, 13, 12, 1)), 'B4': dev(at(2026, 3, 13, 11, 59)) };
const r = find(matchStays([stayA], devices, []), 'A');
const macs = r.devices.map((d) => d.mac).sort().join();
ok('window edges: before check-in day excluded, 00:01 on the day in, noon+1min out, 11:59 on checkout in', macs === 'B2,B4');
}
// 3. A device with a visit before check-in but a stale device.firstSeen is still excluded (earliest known wins).
{
const devices = { 'C1': dev(at(2026, 3, 10, 15, 0)) };
const visits = [visit('C1', at(2026, 3, 5, 8, 0), at(2026, 3, 5, 9, 0)), visit('C1', at(2026, 3, 10, 15, 0), null, at(2026, 3, 11, 8, 0))];
ok('earliest visit counts as first seen', find(matchStays([stayA], devices, visits), 'A').devices.length === 0);
}
// 4. Tagged cleaner/household/ignore and home-network devices are excluded; guest tag and unassigned are included.
{
const t = at(2026, 3, 11, 12, 0);
const devices = { D1: dev(t, { role: 'cleaner' }), D2: dev(t, { role: 'household' }), D3: dev(t, { role: 'ignore' }), D4: dev(t, { net: 'home' }), D5: dev(t, { role: 'guest' }), D6: dev(t) };
const r = find(matchStays([stayA], devices, []), 'A');
ok('role/network filter', r.devices.map((d) => d.mac).sort().join() === 'D5,D6');
}
// 5. Two stays overlapping the same moment: the device is on both and marked ambiguous.
{
const devices = { E1: dev(at(2026, 3, 12, 16, 0)), E2: dev(at(2026, 3, 10, 16, 0)) };
const res = matchStays([stayA, stayB], devices, []);
const a = find(res, 'A'); const b = find(res, 'B');
ok('overlap: on both stays', a.devices.some((d) => d.mac === 'E1') && b.devices.some((d) => d.mac === 'E1'));
ok('overlap: flagged with the other stay', a.devices.find((d) => d.mac === 'E1').ambiguousWith.join() === 'B' && b.devices.find((d) => d.mac === 'E1').ambiguousWith.join() === 'A');
ok('overlap: unambiguous device stays single', b.devices.every((d) => d.mac !== 'E2') && a.devices.find((d) => d.mac === 'E2').ambiguousWith.length === 0);
ok('overlap: stay-level flag', a.ambiguous === true);
}
// 6. An open visit: still connected, last seen is its lastSeen.
{
const devices = { F1: dev(at(2026, 3, 10, 15, 0)) };
const visits = [visit('F1', at(2026, 3, 10, 15, 0), null, at(2026, 3, 11, 7, 30))];
const r = find(matchStays([stayA], devices, visits), 'A');
ok('open visit', r.open === true && r.lastSeen === Date.parse(at(2026, 3, 11, 7, 30)));
}
// 7. Cancelled and same-day stays are skipped; several devices sort by first sighting.
{
const devices = { G2: dev(at(2026, 3, 11, 18, 0)), G1: dev(at(2026, 3, 10, 13, 0)) };
const res = matchStays([{ ...stayA, id: 'X', status: 'cancelled' }, { ...stayA, id: 'Y', checkout: '2026-03-10' }, stayA], devices, []);
ok('cancelled and same-day skipped', res.length === 1 && res[0].stay.id === 'A');
ok('devices ordered by first sighting', res[0].devices.map((d) => d.mac).join() === 'G1,G2' && res[0].firstSeen === Date.parse(at(2026, 3, 10, 13, 0)));
}
// 8. No devices: nothing, not NaN.
{
const r = find(matchStays([stayA], {}, []), 'A');
ok('empty stay', r.firstSeen === null && r.lastSeen === null && r.devices.length === 0 && r.open === false);
}
// 9. Cleaner visits: only Cleaner-tagged devices, newest first, open and closed.
{
const devices = { H1: dev(at(2026, 3, 11, 9, 0), { role: 'cleaner', label: 'Maria' }), H2: dev(at(2026, 3, 11, 9, 0)) };
const visits = [visit('H1', at(2026, 3, 11, 9, 0), at(2026, 3, 11, 12, 30)), visit('H1', at(2026, 3, 14, 10, 0), null, at(2026, 3, 14, 11, 0)), visit('H2', at(2026, 3, 12, 9, 0), at(2026, 3, 12, 10, 0))];
const c = cleanerVisits(devices, visits);
ok('cleaner visits: only the tagged device', c.length === 2 && c.every((v) => v.mac === 'H1'));
ok('cleaner visits: newest first, open has no end, label used', c[0].to === null && c[1].to === Date.parse(at(2026, 3, 11, 12, 30)) && c[0].name === 'Maria');
ok('duration format', duration(Date.parse(at(2026, 3, 11, 9, 0)), Date.parse(at(2026, 3, 11, 12, 30))) === '3h 30m' && duration(0, 25 * 60000) === '25m');
}
// 10. Merging pulled events: dedup by mac+from, open visit replaced by its closed version, role/label kept, 120-day prune.
{
const now = Date.parse(at(2026, 3, 20, 12, 0));
const store = { wifiDevices: { 'M1': blankWifiDevice({ net: 'guest', role: 'cleaner', label: 'Maria', firstSeen: at(2026, 3, 1, 9, 0) }) }, wifiVisits: [] };
mergeWifiEvents(store, { visits: [{ mac: 'M1', net: 'guest', hostname: 'iphone', from: at(2026, 3, 11, 9, 0), to: null, lastSeen: at(2026, 3, 11, 10, 0), updated: at(2026, 3, 11, 10, 0) }] }, now);
ok('merge: adds visit and keeps tags', store.wifiVisits.length === 1 && store.wifiDevices.M1.role === 'cleaner' && store.wifiDevices.M1.label === 'Maria' && store.wifiDevices.M1.hostname === 'iphone');
ok('merge: earlier known firstSeen is kept', store.wifiDevices.M1.firstSeen === at(2026, 3, 1, 9, 0));
mergeWifiEvents(store, { visits: [{ mac: 'M1', net: 'guest', hostname: 'iphone', from: at(2026, 3, 11, 9, 0), to: at(2026, 3, 11, 12, 0), lastSeen: at(2026, 3, 11, 12, 0), updated: at(2026, 3, 11, 12, 30) }] }, now);
ok('merge: same mac+from replaces, no duplicate', store.wifiVisits.length === 1 && store.wifiVisits[0].to === at(2026, 3, 11, 12, 0) && store.wifiDevices.M1.lastSeen === at(2026, 3, 11, 12, 0));
mergeWifiEvents(store, { visits: [{ mac: 'N1', net: 'home', hostname: 'old', from: at(2025, 10, 1, 9, 0), to: at(2025, 10, 1, 10, 0), lastSeen: at(2025, 10, 1, 10, 0) }] }, now);
ok('merge: visits older than 120 days are dropped', store.wifiVisits.length === 1 && store.wifiVisits[0].mac === 'M1');
ok('merge: ids are mac_from', store.wifiVisits[0].id === `M1_${at(2026, 3, 11, 9, 0)}`);
}
const result = { passed, failed: failures.length, failures };
console.log(`wifipresence selfTest: ${passed} passed, ${failures.length} failed`, failures);
return result;
}

// ---- agent calls ------------------------------------------------------------------------------------------------

function syncLinkHtml() {
return '<span class="inline-goto-link" data-goto-tab="settings" data-goto-target="#sync-url-input">live sync in Settings</span>';
}

// What went wrong, in a few words, as HTML (it can carry a link).
function reasonHtml(err) {
if (err instanceof AgentNotConfiguredError) return `set up ${syncLinkHtml()} first`;
const m = (err && err.message) || String(err);
if (/doesn't know the verb/i.test(m)) return 'Agent 1.18 needed: this home agent is older and has no Wi-Fi support. Update it on the NAS (home-agent/ files, then rebuild).';
if (/isn't configured on the agent|ROUTER_PASSWORD|tplinkrouterc6u/i.test(m)) return escapeHtml(m);
if (/hadn't finished/i.test(m)) return 'the home agent was busy: try again shortly';
if (/never picked that up/i.test(m)) return "the home agent didn't respond (is it running?)";
if (/command server didn't respond|Couldn't reach the command queue/i.test(m)) return "couldn't reach the command server";
const first = m.split(/(?<=[.!?])\s|\s[—–-]{1,2}\s/)[0].trim();
return escapeHtml(first.length > 120 ? `${first.slice(0, 117)}…` : first);
}

async function callAgent(verb, args, { quiet = false } = {}) {
if (busy) return null;
busy = true;
lastAttemptAt = Date.now();
if (!quiet) setStatusHtml('Asking the home agent…', 'busy');
try {
const res = await run(verb, args, { timeoutMs: 30000 });
lastError = null;
return res;
} catch (err) {
lastError = { html: reasonHtml(err) };
return null;
} finally {
busy = false;
}
}

async function pull({ quiet = false } = {}) {
const since = data.wifiPulledAt ? new Date(Date.parse(data.wifiPulledAt) - PULL_OVERLAP_MS).toISOString() : undefined;
const res = await callAgent('wifi.events', since ? { since } : {}, { quiet });
if (res) {
agentStatus = { ...(res.status || {}), configured: res.configured !== false };
mergeWifiEvents(data, res);
if (res.now) data.wifiPulledAt = res.now;
queueSave();
}
renderWifiPresence();
}

async function pauseFor(minutes) {
const res = await callAgent('wifi.pause', { minutes });
if (res) agentStatus = res;
renderWifiPresence();
}

async function resumeNow() {
const res = await callAgent('wifi.resume', {});
if (res) agentStatus = res;
renderWifiPresence();
}

// ---- rendering --------------------------------------------------------------------------------------------------

function setStatusHtml(html, cls = '') {
const el = document.getElementById('wifi-status');
if (!el) return;
el.innerHTML = html;
el.className = `sync-status ${cls}`.trim();
}

function statusHtml() {
const s = agentStatus;
const parts = [];
if (lastError) parts.push(`couldn't ask the agent: ${lastError.html}`);
if (s && s.configured === false) parts.push(`Wi-Fi tracking isn't switched on at the agent: ${escapeHtml(s.reason || 'set ROUTER_PASSWORD in its .env')}`);
else if (s) {
if (s.paused && s.paused_until) parts.push(`<strong>Paused until ${clock(ms(s.paused_until))}</strong>: the router isn't being read, so devices coming or going now are missed.`);
else {
parts.push(s.last_poll ? `Router read ${clock(ms(s.last_poll))}` : 'Router not read yet');
if (s.guest_clients != null) parts.push(`${s.guest_clients} on guest Wi-Fi now (${s.clients} in all)`);
if (s.last_error) parts.push(`last poll failed: ${escapeHtml(String(s.last_error).slice(0, 120))}`);
}
if (s.persisting === false) parts.push("the agent isn't saving history (its data folder isn't writable), so a restart loses it");
} else if (!lastError) parts.push('Not checked yet: press Refresh.');
return parts.join(' · ');
}

function stayDevicesHtml(item, chipFor) {
return item.devices.map((d) => {
const other = d.ambiguousWith.map((id) => (data.airbnbReservations || []).find((r) => r.id === id)).filter(Boolean);
const tell = other.length ? ` <span class="wifi-amb" title="One guest Wi-Fi serves both rooms, so this device can't be tied to one of them.">can't tell which room · also ${other.map((r) => chipFor(r)).join(' ')}</span>` : '';
return `<span class="wifi-dev-chip">${escapeHtml(deviceName(d.device, d.mac))} <small>${clock(d.firstSeen)}</small></span>${tell}`;
}).join(' ');
}

const isLive = (item, now) => item.open && now <= item.end + 24 * 3600000;

function stayLine(item, now) {
if (!item.devices.length) return item.end < now ? 'Guest Wi-Fi: no new device seen during this stay.' : 'Guest Wi-Fi: no new device yet.';
const last = isLive(item, now) ? 'still connected' : `last seen ~${clock(item.lastSeen)} on ${dayName(item.lastSeen)}`;
return `Guest Wi-Fi: first device ~${clock(item.firstSeen)} on ${dayName(item.firstSeen)} · ${last}`;
}

// For the Airbnb panel (js/features/airbnb.js): stay id -> {item, live} for every stay with at least one guest device.
// The stay rows outline the guest name from this and show stayWifiHtml in their expander.
function wifiByStay(reservations, now = Date.now()) {
const map = new Map();
matchStays((reservations || []).filter((r) => r.source !== 'external'), data.wifiDevices, data.wifiVisits).forEach((it) => {
if (it.devices.length) map.set(it.stay.id, { item: it, live: isLive(it, now) });
});
return map;
}

// The Guest Wi-Fi block inside a stay's expander. chipFor renders the other stays named by "can't tell which room".
function stayWifiHtml(item, chipFor, now = Date.now()) {
return `<div class="stay-wifi${item.ambiguous ? ' amb' : ''}"><div class="wifi-line">${escapeHtml(stayLine(item, now))}</div>${item.devices.length ? `<div class="wifi-devs">${stayDevicesHtml(item, chipFor)}</div>` : ''}</div>`;
}

function cleanerRowsHtml(list) {
if (!list.length) return '<div class="settings-note" style="margin:0;">No visits yet. Tag a device as Cleaner below and its arrivals and departures appear here.</div>';
return list.slice(0, MAX_CLEANER_ROWS).map((v) => {
const who = escapeHtml(v.name);
const day = dayName(v.from);
const times = v.to == null
? `arrived ${clock(v.from)}, still here (last seen ${clock(v.lastSeen)})`
: `arrived ${clock(v.from)}, left ${clock(v.to)} (${duration(v.from, v.to)})`;
return `<div class="wifi-clean-row"><span class="wifi-clean-day">${escapeHtml(day)}</span> <span>${who}</span> <span class="wifi-clean-times">${escapeHtml(times)}</span></div>`;
}).join('');
}

// `matched`: the stays this device was matched to (from matchStays), shown as chips; an unassigned one then reads as an
// automatic guest rather than as something still to sort out.
function deviceRowHtml(mac, d, matched = [], chipFor = (r) => escapeHtml(r.guestName || 'Stay')) {
const name = deviceName(d, mac);
const auto = !d.role && matched.length;
const roleOpts = ROLES.map(([v, label]) => `<option value="${v}"${(d.role || '') === v ? ' selected' : ''}>${v === '' && auto ? 'Guest (auto)' : label}</option>`).join('');
const stayHtml = matched.length ? `<span class="wifi-dev-stay">${matched.map((r) => chipFor(r)).join(' ')}</span>` : '';
const first = ms(d.firstSeen); const last = ms(d.lastSeen);
return `<div class="wifi-dev" data-wifi-mac="${escapeHtml(mac)}">
<span class="wifi-dev-name" title="${escapeHtml(mac)}">${escapeHtml(name)} <small>…${escapeHtml(mac.slice(-5))}</small></span>
<span class="cal-badge ${d.net === 'guest' ? 'blue' : 'sage'}">${d.net === 'guest' ? 'guest' : 'home'}</span>
<span class="wifi-dev-when">${first != null ? `first ${escapeHtml(dayName(first))} ${clock(first)}` : ''}${last != null ? ` · last ${escapeHtml(dayName(last))} ${clock(last)}` : ''}</span>
<select data-wifi-role="${escapeHtml(mac)}" title="What this device is. Guest and Unassigned guest-network devices are matched to stays; Cleaner ones are timed below.">${roleOpts}</select>
<input type="text" autocomplete="off" class="tag-add-input" data-wifi-label="${escapeHtml(mac)}" placeholder="Label (optional)" value="${escapeHtml(d.label || '')}">
${stayHtml}
</div>`;
}

async function renderWifiPresence() {
const stays = document.getElementById('wifi-stays');
if (!stays) return;
let chipFor = (r) => escapeHtml(r.guestName || 'Stay');
try {
const { stayChipHtml, bindStayChips } = await import('./airbnb.js');
bindStayChips();
chipFor = (r) => stayChipHtml(r);
} catch (e) { /* the plain name stays */ }
const now = Date.now();
setStatusHtml(statusHtml(), lastError ? 'zero' : '');
const paused = !!(agentStatus && agentStatus.paused);
const pauseBtn = document.getElementById('wifi-pause-btn');
const resumeBtn = document.getElementById('wifi-resume-btn');
if (pauseBtn) pauseBtn.hidden = paused;
if (resumeBtn) resumeBtn.hidden = !paused;

const candidates = (data.airbnbReservations || []).filter((r) => r.source !== 'external');
const matched = matchStays(candidates, data.wifiDevices, data.wifiVisits);
// MAC -> the stays it was matched to, for the device list.
const staysByMac = new Map();
matched.forEach((it) => it.devices.forEach((d) => { if (!staysByMac.has(d.mac)) staysByMac.set(d.mac, []); staysByMac.get(d.mac).push(it.stay); }));
// Each stay's guest devices are shown on its row in the Airbnb panel (name outlined, details in its expander), so
// this panel only says where to look, naming the stays that have devices connected now.
const live = matched.filter((it) => it.devices.length && isLive(it, now)).sort((a, b) => b.start - a.start);
const goAirbnb = '<span class="inline-goto-link" data-goto-tab="overview" data-goto-target="#airbnb-panel">Airbnb</span>';
stays.innerHTML = `<div class="settings-note" style="margin:0;">${live.length ? `Connected now: ${live.map((it) => chipFor(it.stay)).join(' ')}. ` : ''}Guest devices show on each stay in ${goAirbnb}: a green outline on the guest's name means devices were seen (stronger while connected), and the stay's &#9662; lists them.</div>`;

const cleaners = document.getElementById('wifi-cleaners');
if (cleaners) cleaners.innerHTML = cleanerRowsHtml(cleanerVisits(data.wifiDevices, data.wifiVisits));

const macs = Object.keys(data.wifiDevices || {});
const order = (mac) => { const d = data.wifiDevices[mac]; return `${d.net === 'guest' ? 0 : 1}${d.role || staysByMac.has(mac) ? 1 : 0}${String(9e15 - (ms(d.lastSeen) || 0)).padStart(16, '0')}`; };
macs.sort((a, b) => order(a).localeCompare(order(b)));
const list = document.getElementById('wifi-devices');
if (list) list.innerHTML = macs.length ? macs.map((m) => deviceRowHtml(m, data.wifiDevices[m], staysByMac.get(m) || [], chipFor)).join('') : '<div class="settings-note" style="margin:0;">No devices yet.</div>';
const label = document.getElementById('wifi-devices-summary');
if (label) label.textContent = `Devices (${macs.length})`;
const count = document.getElementById('wifi-count');
if (count) count.textContent = agentStatus && agentStatus.guest_clients ? `${agentStatus.guest_clients} now` : '';
}

function initWifiPresence() {
const panel = document.getElementById('wifi-panel');
if (!panel) return;
document.getElementById('wifi-refresh-btn').addEventListener('click', () => pull());
document.getElementById('wifi-pause-btn').addEventListener('click', () => pauseFor(60));
document.getElementById('wifi-resume-btn').addEventListener('click', () => resumeNow());
const list = document.getElementById('wifi-devices');
list.addEventListener('change', (e) => {
const role = e.target.closest('[data-wifi-role]');
const label = e.target.closest('[data-wifi-label]');
const mac = role ? role.dataset.wifiRole : label ? label.dataset.wifiLabel : null;
if (!mac || !data.wifiDevices[mac]) return;
if (role) data.wifiDevices[mac].role = role.value;
if (label) data.wifiDevices[mac].label = label.value.trim();
queueSave();
renderWifiPresence();
});
renderWifiPresence();
// First pull shortly after open, then every few minutes while the app is visible and sync is set up. Each pull costs the
// agent nothing: it answers from its own memory, not from the router.
const autoPull = async () => {
if (busy || document.hidden || Date.now() - lastAttemptAt < AUTO_PULL_MS) return;
try { if (!(await getConfig()).configured) return; } catch (e) { return; }
pull({ quiet: true });
};
setTimeout(autoPull, 5000);
setInterval(autoPull, AUTO_PULL_MS);
}

export { initWifiPresence, renderWifiPresence, wifiByStay, stayWifiHtml, pull as pullWifiEvents, mergeWifiEvents, matchStays, cleanerVisits, selfTest };
