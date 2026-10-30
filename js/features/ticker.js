// The strip across the top of Overview: numbers you want at a glance and
// would otherwise open five tabs for.
//
// WHERE EACH ONE COMES FROM, and why it matters: two of the feeds answer
// a browser directly and two do not, which decides what works before the
// home agent is deployed.
//
//   FX        Frankfurter (ECB daily)      direct, CORS open
//   Weather   Open-Meteo                   direct, CORS open
//   Quotes    Yahoo's chart endpoint       needs the proxy, no CORS
//   2y SONIA  Chatham's own public JSON    needs the proxy AND a Referer
//
// The SONIA one is the awkward one. The page you'd read it on is
// client-rendered, but it calls cf.com/public-api/public-rates/
// soniaswap.json, which returns every tenor plus the rate a day, a month
// and a year ago in 245 bytes -- so the daily/monthly toggle is answered
// by the data rather than by storing history. It sits behind Cloudflare
// and returns "Just a moment..." to a bare request; browser headers and a
// Referer get a 200. Whether Cloudflare accepts the WEB HOST's address is
// the same gamble Quidco lost, so this falls back to the home agent,
// exactly as the Agent Provocateur checks in stockwatch.js do.
//
// WHAT IS SHOWN is a list you edit in Settings, plus whatever your travel
// implies: a trip to Lisbon next week puts Lisbon's weather and GBP/EUR
// on the strip by itself and takes them off when you're home. See
// travelItems().
import { data, queueSave, inventorySets, SET_CORE_GROUPS } from '../state.js';
import { escapeHtml, uid, bindBackdropClose, claudeWeeklyPace, daysUntil } from '../utils.js';
import * as letting from './letting.js';
import { travelStripPrograms } from './loyaltybalances.js';
import { matchBankLogo } from '../bankLogos.js';
import { CHECKS as SITE_HEALTH_CHECKS, reportCheck as reportSiteHealth } from './sitehealth.js';

// How often the loyalty tile's own rotation advances (see tileFor's
// `kind: 'loyalty'` branch) -- reported directly as too slow at 2
// minutes (an earlier pass from 10 minutes, already too long on its
// own); short enough now that a normal Overview glance sees it change
// at least once. Random, not synced, so one browser tab's own
// rotation doesn't march in lockstep with another device open to the
// same account. Each tick IS guaranteed to show a different program
// than the one before it whenever more than one is available --
// consecutive integers taken mod N (N = how many are in rotation) are
// never equal, which is exactly what `(bucket index) % flat.length`
// below already does; the earlier complaint was purely that the
// bucket was too wide to ever observe that in a normal viewing
// session, not that the same one could repeat back-to-back.
const LOYALTY_TICKER_BUCKET_MS = 20 * 1000;
const loyaltyTickerPhaseOffset = Math.floor(Math.random() * 97); // a prime, so it doesn't resonate with small flat.length values

// Single source of truth for "which program/reading is showing right
// now" -- shared by tileFor's `kind: 'loyalty'` branch and the drive
// interval in initTicker() below, so the two can never disagree about
// whether the bucket has actually changed.
function currentLoyaltyPick() {
const entries = travelStripPrograms();
const flat = entries.flatMap(({ program, readings }) => readings.map((r) => ({ program, r })));
if (!flat.length) return null;
const idx = (Math.floor(Date.now() / LOYALTY_TICKER_BUCKET_MS) + loyaltyTickerPhaseOffset) % flat.length;
return flat[idx];
}
// A stable identity for whatever currentLoyaltyPick() currently returns
// -- the arrays it builds are fresh objects every call, so comparing by
// reference would never match twice in a row even with no real change.
function loyaltyPickKey() {
const pick = currentLoyaltyPick();
return pick ? `${pick.program.id}|${pick.r.id}` : null;
}
// Tracks what the ticker last actually rendered, updated inside
// renderTicker() itself (below) so it stays correct no matter what
// triggered that render -- the drive interval in initTicker() only
// needs to compare against this, never guess at timing.
let lastLoyaltyPickKey = null;

// A feed is re-fetched when its cached answer is older than this. FX and
// the swap rate are published once a day, so the floor is about not
// hammering them on every tab switch rather than about freshness.
const MAX_AGE_MS = 30 * 60 * 1000;

// Enough of the world to cover where you actually go. A country that
// isn't here simply gets no FX tile rather than a wrong one, which is the
// right failure: a made-up currency code would quietly show a rate for
// somewhere else.
const CURRENCY = {
AT: 'EUR', BE: 'EUR', CY: 'EUR', DE: 'EUR', EE: 'EUR', ES: 'EUR', FI: 'EUR', FR: 'EUR',
GR: 'EUR', HR: 'EUR', IE: 'EUR', IT: 'EUR', LT: 'EUR', LU: 'EUR', LV: 'EUR', MT: 'EUR',
NL: 'EUR', PT: 'EUR', SI: 'EUR', SK: 'EUR', ME: 'EUR', XK: 'EUR', AD: 'EUR', MC: 'EUR',
US: 'USD', EC: 'USD', PA: 'USD', CH: 'CHF', LI: 'CHF', NO: 'NOK', SE: 'SEK', DK: 'DKK',
IS: 'ISK', PL: 'PLN', CZ: 'CZK', HU: 'HUF', RO: 'RON', BG: 'BGN', TR: 'TRY', RS: 'RSD',
CA: 'CAD', AU: 'AUD', NZ: 'NZD', JP: 'JPY', CN: 'CNY', HK: 'HKD', SG: 'SGD', KR: 'KRW',
IN: 'INR', TH: 'THB', MY: 'MYR', ID: 'IDR', PH: 'PHP', VN: 'VND', AE: 'AED', SA: 'SAR',
IL: 'ILS', EG: 'EGP', MA: 'MAD', ZA: 'ZAR', KE: 'KES', BR: 'BRL', MX: 'MXN', AR: 'ARS',
CL: 'CLP', CO: 'COP', PE: 'PEN', GB: 'GBP',
};

// Frankfurter is the ECB's own set, so it covers the majors and nothing
// exotic. A pair it doesn't carry is reported as a failed tile rather
// than silently dropped.
const HOME = 'GBP';

function cache() {
if (!data.tickerCache || typeof data.tickerCache !== 'object') data.tickerCache = {};
return data.tickerCache;
}

// One key per thing fetched, so two items wanting the same city or the
// same pair share an answer instead of asking twice.
function keyFor(item) {
switch (item.kind) {
case 'fx': return `fx:${item.base || HOME}:${item.quote}`;
case 'quote': return `quote:${item.symbol}`;
case 'weather': return `wx:${Number(item.lat).toFixed(2)},${Number(item.lon).toFixed(2)}`;
case 'sonia': return 'sonia';
case 'cass': return `cass:${item.accountId}:${item.bonusId}`;
case 'sitehealth': return 'sitehealth';
default: return item.kind;
}
}

function fresh(key) {
const hit = cache()[key];
if (!hit || !hit.at || hit.value === undefined) return null;
return Date.now() - new Date(hit.at).getTime() < MAX_AGE_MS ? hit : null;
}

function store(key, value) {
cache()[key] = { ...value, at: new Date().toISOString() };
queueSave();
return cache()[key];
}

async function viaProxy(url, referer = '') {
const { fetchPageHtml } = await import('../files.js');
return fetchPageHtml(url, referer ? { referer } : {});
}

// ---- The feeds ------------------------------------------------------------

function iso(d) { return d.toISOString().slice(0, 10); }
function backDays(n) { const d = new Date(); d.setDate(d.getDate() - n - 6); return iso(d); }
function backMonths(n) { const d = new Date(); d.setMonth(d.getMonth() - n); return iso(d); }

// Any pair the ECB publishes. The response carries its own date because a
// weekend or a bank holiday returns the previous working day rather than
// nothing, and a tile that says "today" when it means Friday is a small
// lie that matters on a Monday.
async function fetchFx(item) {
const base = item.base || HOME;
const quote = item.quote;
const key = keyFor(item);
const cached = fresh(key);
if (cached) return cached;
const q = `base=${encodeURIComponent(base)}&symbols=${encodeURIComponent(quote)}`;
const [today, window, monthAgo] = await Promise.all([
fetch(`https://api.frankfurter.dev/v1/latest?${q}`).then((r) => r.json()),
fetch(`https://api.frankfurter.dev/v1/${backDays(1)}..?${q}`).then((r) => r.json()),
fetch(`https://api.frankfurter.dev/v1/${backMonths(1)}?${q}`).then((r) => r.json()),
]);
if (!today.rates || today.rates[quote] === undefined) throw new Error(`No ${base}/${quote} rate published`);
const rates = window.rates || {};
// The last date BEFORE today's, so a run before the ECB publishes
// doesn't compare today with itself and report no change.
const prior = Object.keys(rates).sort().filter((d) => d < today.date).pop();
return store(key, {
value: today.rates[quote],
date: today.date,
prevDay: prior ? rates[prior][quote] : null,
prevMonth: (monthAgo.rates || {})[quote] ?? null,
});
}

// Yahoo's chart endpoint carries the previous close and a month of daily
// closes in one call -- enough for both changes without a second request.
async function fetchQuote(item) {
const key = keyFor(item);
const cached = fresh(key);
if (cached) return cached;
// events=div costs nothing extra for an ordinary quote tile (just unused
// JSON) and is what lets the Holding tile below flag "ex-div" for a
// couple of weeks after a real payout -- range stays 1mo, unchanged,
// since prevMonth below depends on the array covering exactly that.
const raw = await viaProxy(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(item.symbol)}?range=1mo&interval=1d&events=div`);
const body = JSON.parse(raw);
const result = ((body.chart || {}).result || [])[0];
if (!result) throw new Error(`Yahoo returned no data for ${item.symbol}`);
const meta = result.meta || {};
const closes = (((result.indicators || {}).quote || [])[0] || {}).close || [];
const known = closes.filter((c) => typeof c === 'number');
const dividends = Object.values((result.events || {}).dividends || {});
const lastDividendAt = dividends.length ? iso(new Date(Math.max(...dividends.map((d) => d.date * 1000)))) : null;
return store(key, {
value: meta.regularMarketPrice,
currency: meta.currency || '',
// chartPreviousClose is the close before the range started, so the
// previous DAY is the second-to-last point in the series itself.
prevDay: known.length > 1 ? known[known.length - 2] : meta.chartPreviousClose ?? null,
prevMonth: known.length ? known[0] : null,
lastDividendAt,
});
}
const WMO = [
[[0], 'Clear', 'clear'], [[1], 'Mostly clear', 'clear'],
[[2], 'Part cloud', 'part'], [[3], 'Cloudy', 'cloud'],
[[45, 48], 'Fog', 'fog'],
[[51, 53, 55, 56, 57], 'Drizzle', 'drizzle'],
[[61, 63, 65, 66, 67], 'Rain', 'rain'],
[[71, 73, 75, 77, 85, 86], 'Snow', 'snow'],
[[80, 81, 82], 'Showers', 'showers'],
[[95, 96, 99], 'Thunder', 'thunder'],
];

function weatherWord(code) {
const hit = WMO.find(([codes]) => codes.includes(code));
return hit ? hit[1] : '—';
}
function weatherShape(code) {
const hit = WMO.find(([codes]) => codes.includes(code));
return hit ? hit[2] : 'cloud';
}

// Drawn rather than fetched: an icon font or a sprite sheet would be a
// network dependency and a licence for five small pictures. `night` only
// changes the clear and part-cloud shapes -- rain at midnight looks like
// rain at noon.
function weatherIcon(code, { night = false } = {}) {
const shape = weatherShape(code);
const S = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"
stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="${escapeHtml(weatherWord(code))}">${inner}</svg>`;
const sun = '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2M12 19.4v2M2.6 12h2M19.4 12h2M5.4 5.4l1.4 1.4M17.2 17.2l1.4 1.4M18.6 5.4l-1.4 1.4M6.8 17.2l-1.4 1.4"/>';
const moon = '<path d="M20 14.5A8.2 8.2 0 0 1 9.5 4 8.3 8.3 0 1 0 20 14.5Z"/>';
const cloud = '<path d="M7 19h10.2a3.8 3.8 0 0 0 .3-7.6 5.6 5.6 0 0 0-10.8-1.2A4 4 0 0 0 7 19Z"/>';
const smallBody = night
? '<path d="M15.5 9.6A4.6 4.6 0 0 1 9.6 3.7 4.7 4.7 0 1 0 15.5 9.6Z"/>'
: '<circle cx="8.4" cy="7.4" r="3"/><path d="M8.4 1.9v1.6M8.4 11.3v1.6M2.9 7.4h1.6M12.3 7.4h1.6M4.5 3.5l1.1 1.1M11.2 10.2l1.1 1.1M12.3 3.5l-1.1 1.1M5.6 10.2l-1.1 1.1"/>';
switch (shape) {
case 'clear': return S(night ? moon : sun);
case 'part': return S(`${smallBody}<path d="M9 20h8.4a3.3 3.3 0 0 0 .2-6.6 4.9 4.9 0 0 0-9.3-1A3.5 3.5 0 0 0 9 20Z"/>`);
case 'fog': return S('<path d="M4 10h16M4 14h16M6 18h12"/>');
case 'drizzle': return S(`${cloud}<path d="M9.5 21.4v.6M14.5 21.4v.6"/>`);
case 'rain': return S(`${cloud}<path d="M9 21l-.8 2M13 21l-.8 2M17 21l-.8 2"/>`);
case 'showers': return S(`${smallBody}<path d="M9 17.5h8a3.2 3.2 0 0 0 .2-6.4 4.8 4.8 0 0 0-9-1A3.4 3.4 0 0 0 9 17.5Z"/><path d="M10 19.5l-.7 2M15 19.5l-.7 2"/>`);
case 'snow': return S(`${cloud}<path d="M9.5 21.5h.01M13 22.5h.01M16.5 21.5h.01"/>`);
case 'thunder': return S(`${cloud}<path d="M13 20l-2.6 3.4h3L11 26"/>`);
default: return S(cloud);
}
}

// Daily for the high and low, hourly for the two pictures: the daily
// weather_code is one summary for the whole day, which cannot say that a
// bright afternoon turns to rain by nine.

// Daily for the high and low, hourly for the two pictures: the daily
// weather_code is one summary for the whole day, which cannot say that a
// bright afternoon turns to rain by nine.
async function fetchWeather(item) {
const key = keyFor(item);
const cached = fresh(key);
if (cached) return cached;
const url = `https://api.open-meteo.com/v1/forecast?latitude=${item.lat}&longitude=${item.lon}`
+ '&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max'
+ `&hourly=weather_code&forecast_days=1&timezone=${encodeURIComponent(item.tz || 'auto')}`;
const body = await (await fetch(url)).json();
const d = body.daily || {};
if (!(d.temperature_2m_max || []).length) throw new Error(`No forecast for ${item.city}`);
const hours = (body.hourly || {}).time || [];
const codes = (body.hourly || {}).weather_code || [];
const at = (hh) => {
const i = hours.findIndex((h) => h.slice(11, 13) === hh);
return i >= 0 ? codes[i] : null;
};
return store(key, {
value: d.temperature_2m_max[0], // `value` marks a tile as having an answer
max: d.temperature_2m_max[0],
min: (d.temperature_2m_min || [])[0],
code: (d.weather_code || [])[0],
dayCode: at('14') ?? (d.weather_code || [])[0],
nightCode: at('22') ?? (d.weather_code || [])[0],
rain: (d.precipitation_probability_max || [])[0],
});
}

// Chatham's own endpoint. The proxy is tried first because it needs
// nothing deployed; the home agent is the fallback for a Cloudflare
// refusal, which is a 403 or the "Just a moment" interstitial rather than
// a network error -- so both are treated as "ask the agent".
async function fetchSonia() {
const cached = fresh('sonia');
if (cached) return cached;
const url = 'https://cf.com/public-api/public-rates/soniaswap.json/';
let raw = '';
let via = 'server';
try {
raw = await viaProxy(url, 'https://cf.com/rates/europe/sonia-swaps/historical-rates');
if (/just a moment|challenge-platform/i.test(raw)) throw new Error('Cloudflare challenged the server');
} catch (serverErr) {
const { run } = await import('../homeagent.js');
const res = await run('page.fetch', { urls: [url] }, { timeoutMs: 60000 });
const page = ((res && res.pages) || [])[0];
if (!page || !page.body) throw new Error(`${serverErr.message || serverErr}, and the home agent couldn't get it either`);
raw = page.body;
via = 'agent';
}
const body = JSON.parse(raw);
const two = (body.Rates || []).find((r) => Number(r.LengthInMonths) === 24);
if (!two) throw new Error('No 2-year tenor in that response');
// Chatham's field names are from its own page's point of view, so
// "PreviousDay" is the CURRENT rate and there is nothing to compute a
// DAILY move from -- we keep that ourselves, carrying our own small
// rolling history of what we actually fetched, keyed by OUR calendar
// date, not Chatham's own PreviousDay/Month/Year fields (those stay
// exactly what they say -- a day/month/year back from THEIR last
// snapshot, used only for the monthly/yearly toggle below).
const value = Number(two.PreviousDay);
const today = new Date().toISOString().slice(0, 10);
const prior = cache().sonia;
const history = Array.isArray(prior?.history) ? prior.history.slice() : [];
if (history.length && history[history.length - 1].date === today) {
history[history.length - 1].value = value; // same-day refetch -- update in place, don't grow the list
} else {
history.push({ date: today, value });
if (history.length > 6) history.shift(); // only ever needs to reach back a couple of days
}
// Reported live: unauthenticated, Chatham's own feed appears to serve
// a snapshot that's at least a day staler than it looks -- the symptom
// this was built to fix is that the daily change ALWAYS read exactly
// 0%, because yesterday's fetch and today's fetch were both reading
// the same underlying stale number. Walking back through OUR OWN
// history (not Chatham's) for the most recent day that's actually
// DIFFERENT from today's value, rather than hardcoding "exactly one
// day further back", is what makes this self-correcting if the real
// staleness turns out to span more than one extra day -- it reaches
// back however far it actually needs to. Falls back to the oldest day
// on file if every one we have is still identical, an honest "no
// change detected yet" rather than a guess.
const priorDays = history.filter((h) => h.date !== today);
let prevDay = null;
for (let i = priorDays.length - 1; i >= 0; i--) {
if (priorDays[i].value !== value) { prevDay = priorDays[i].value; break; }
}
if (prevDay === null && priorDays.length) prevDay = priorDays[0].value;
return store('sonia', {
value,
prevDay,
history,
prevMonth: Number(two.PreviousMonth),
prevYear: Number(two.PreviousYear),
via,
});
}

// A city name to a point on the map, looked up once and kept: the answer
// never changes, and the alternative is a geocode on every refresh for
// every trip you have planned.
async function geocode(cityName) {
const key = `geo:${cityName.trim().toLowerCase()}`;
const hit = cache()[key];
if (hit && hit.lat !== undefined) return hit;
const body = await (await fetch(
`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityName)}&count=1&language=en&format=json`,
)).json();
const found = (body.results || [])[0];
if (!found) throw new Error(`Couldn't find "${cityName}" on the map`);
cache()[key] = {
lat: found.latitude, lon: found.longitude, tz: found.timezone,
city: found.name, cc: found.country_code, country: found.country,
at: new Date().toISOString(),
};
queueSave();
return cache()[key];
}

// ---- What the strip shows -------------------------------------------------

// Trips you are on or about to take, turned into tiles. This is the part
// that earns its keep without being asked: a trip to Lisbon next week
// puts Lisbon's weather and GBP/EUR on the strip by itself, and takes
// them off again when you get home.
// Four weeks, not the ten days this started at: the rate you'll change
// money at and the weather you'll pack for are both things you look at
// while booking, not on the way to the airport.
const TRIP_LEAD_DAYS = 28;

function upcomingDestinations() {
const today = iso(new Date());
const horizon = new Date();
horizon.setDate(horizon.getDate() + TRIP_LEAD_DAYS);
const out = [];
for (const trip of data.trips || []) {
const start = trip.startDate || '';
const end = trip.endDate || start;
// On it now, or starting within the lead time. A trip with no dates
// is excluded rather than shown forever.
if (!start) continue;
if (end && end < today) continue;
if (start > iso(horizon)) continue;
for (const place of trip.destinations || []) {
if (place && !out.some((o) => o.place.toLowerCase() === place.toLowerCase())) {
out.push({ place, trip: trip.title || 'a trip', tripId: trip.id, start, end });
}
}
}
return out;
}

// Built from whatever has already been geocoded, so this stays synchronous
// and the strip renders immediately; refreshTicker() does the looking up.
function travelItems() {
const items = [];
for (const dest of upcomingDestinations()) {
const geo = cache()[`geo:${dest.place.trim().toLowerCase()}`];
if (!geo || geo.lat === undefined) continue;
const when = dest.start > iso(new Date()) ? `from ${dest.start}` : `until ${dest.end || '?'}`;
items.push({
id: `auto-wx-${geo.city}`, kind: 'weather', auto: true,
city: geo.city, lat: geo.lat, lon: geo.lon, tz: geo.tz,
// The trip is a record this app tracks, and these tiles exist only
// because of it -- so per CLAUDE.md it has to be reachable from here
// rather than merely named. The plane glyph reveals it; the tile
// itself still opens the forecast, which is what you came for.
tripId: dest.tripId, note: `${dest.trip}, ${when}`,
});
const ccy = CURRENCY[geo.cc];
if (ccy && ccy !== HOME) {
items.push({
id: `auto-fx-${ccy}`, kind: 'fx', auto: true, base: HOME, quote: ccy,
tripId: dest.tripId, note: `${geo.country} — ${dest.trip}`,
});
}
}
return items;
}

// A switch bonus still "Working on" shows up here on its own -- computed
// live from the finance accounts each render, the same way travelItems()
// derives its tiles, rather than something added to data.ticker.items by
// hand: the set changes as a bonus is met or paid, not something you'd
// curate in Settings. Stops the moment the status moves on, same as a
// trip tile disappearing once you're home.
function cassBonusItems() {
const items = [];
for (const a of data.financeAccounts || []) {
for (const sb of a.switchBonuses || []) {
if (sb.status !== 'Working on') continue;
items.push({
id: `auto-cass-${sb.id}`, kind: 'cass', auto: true,
accountId: a.id, bonusId: sb.id,
bank: a.bank || '', logoUrl: a.logoUrl || matchBankLogo(a.bank) || '',
amount: Number(sb.amount) || 0, description: sb.description || '',
});
}
}
return items;
}

// One tile while any dated reminder for a yearly bank payment (Nationwide
// Fairer Share, see yearlyperks.js) is awake and not ticked off -- derived
// from the tasks themselves, so ticking them off is what removes it. A
// reminder still hidden by its bring-forward date doesn't count.
function yearlyPerkItems() {
const live = (data.tasks || []).filter((t) => t.source && t.source.kind === 'yearly perk' && t.parentId && t.bucket !== 'done'
&& !(t.bringForward && daysUntil(t.bringForward) > 0));
if (!live.length) return [];
live.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
return [{ id: 'auto-yearlyperk', kind: 'yearlyperk', auto: true, count: live.length, first: live[0], label: live[0].source.label || 'Yearly perk', amount: Number(live[0].source.amount) || 0 }];
}

// A single escalation tile, present only while at least one site-health
// check is actually failing -- not a tile per check (a bad day for three
// checks at once shouldn't crowd out everything else on the strip), and
// gone the moment every check is passing again, same as a CASS tile
// disappearing once its bonus is no longer "Working on". "Worst" is
// whichever's been broken longest, since that's the one most worth
// looking at first.
function siteHealthFailureItems() {
const health = data.siteHealth || {};
const failing = SITE_HEALTH_CHECKS
.map((c) => ({ check: c, row: health[c.id] }))
.filter((x) => x.row && x.row.ok === false)
.sort((a, b) => (a.row.brokenSince || '').localeCompare(b.row.brokenSince || ''));
if (!failing.length) return [];
return [{ id: 'auto-sitehealth', kind: 'sitehealth', auto: true, count: failing.length, worst: failing[0] }];
}

// A single tile while at least one usage row that cost real money in a
// month has a newer model available in its family (the monthly check in
// modelcheck.js writes data.modelCheck; this only reads it, so the ticker
// never imports ai.js). Same "one tile, not one per thing" shape as the
// site-health tile above; gone once every finding is dismissed.
function modelUpgradeItems() {
const mc = data.modelCheck;
if (!mc || !Array.isArray(mc.findings)) return [];
const dismissed = new Set(mc.dismissed || []);
const live = mc.findings.filter((f) => !dismissed.has(f.key)).sort((a, b) => b.cost - a.cost);
if (!live.length) return [];
return [{ id: 'auto-modelcheck', kind: 'modelcheck', auto: true, count: live.length, top: live[0], all: live, minCost: mc.flagMinCost || 1 }];
}

// One tile while a subscription reading exists (written by the hourly
// Claude Code task via agent-write.php); absent until the first reading.
function claudeUsageItems() {
const sub = data.claudeSubscriptionUsage;
if (!claudeWeeklyPace(sub)) return [];
return [{ id: 'auto-claudeusage', kind: 'claudeusage', auto: true, sub }];
}

// Lazy, not a top-level import -- connections.js is a heavy module this
// file would otherwise force onto every single page load (the ticker
// renders before any tab is even chosen), the same cost travel.js's own
// person-picker deliberately avoids by loading it on demand instead.
// Starts null (tile stays off, the privacy-safe default) and is filled
// in once, then re-renders so the tile can appear retroactively.
let sensitiveFieldsShownFn = null;
function loadSensitiveFieldsGate() {
if (sensitiveFieldsShownFn) return;
import('./connections.js').then(({ sensitiveFieldsShown }) => {
sensitiveFieldsShownFn = sensitiveFieldsShown;
renderTicker();
});
}

// A single escalation tile for every owned bra/knickers piece still
// missing its other half -- same "one tile, not one per thing" shape as
// the site-health tile above, and gone the moment nothing's incomplete.
// Gated behind the same device-local "sensitive fields" toggle the
// Inventory panel itself already is (shopping.js's renderInventory) --
// the ticker is always on screen, unlike a tab you have to choose to
// open, so showing a lingerie-gap count here on an unlocked phone would
// undercut the exact thing that gate exists for.
function incompleteSetItems() {
loadSensitiveFieldsGate();
if (!sensitiveFieldsShownFn || !sensitiveFieldsShownFn()) return [];
const incomplete = inventorySets().filter((s) => !s.complete && s.groups.some((g) => SET_CORE_GROUPS.includes(g)));
if (!incomplete.length) return [];
return [{ id: 'auto-inv-incomplete', kind: 'inv-incomplete', auto: true, count: incomplete.length, sets: incomplete }];
}

// Your own list plus the travel ones, with duplicates dropped: a trip to
// Dublin shouldn't give you a second GBP/EUR tile next to the one you
// already keep.
function activeItems() {
const mine = (data.ticker.items || []).filter((i) => !i.hidden);
const seen = new Set(mine.map(keyFor));
const extra = [...travelItems(), ...cassBonusItems(), ...yearlyPerkItems(), ...siteHealthFailureItems(), ...modelUpgradeItems(), ...claudeUsageItems(), ...incompleteSetItems()].filter((i) => !seen.has(keyFor(i)));
return [...mine, ...extra];
}

// ---- The share scheme -----------------------------------------------------

// The first business day of a month, which is when the scheme buys. Only
// weekends are skipped: a bank holiday would shift it by a day and the
// price used would be a day out, which is inside the drift you said you'd
// correct by hand anyway.
function firstBusinessDay(year, month) {
const d = new Date(Date.UTC(year, month, 1));
while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
return d;
}

// What £250 bought on a given day: the DBK close and the GBP/EUR rate
// from THAT day, five years before the shares land. Both feeds return the
// previous working day for a date they have no fixing for, so a date that
// falls awkwardly still answers.
async function purchaseOn(dateIso) {
const from = new Date(dateIso);
const to = new Date(from);
to.setDate(to.getDate() + 7);
const chart = JSON.parse(await viaProxy(
`https://query1.finance.yahoo.com/v8/finance/chart/${DBK}`
+ `?period1=${Math.floor(from.getTime() / 1000)}&period2=${Math.floor(to.getTime() / 1000)}&interval=1d`,
));
const result = ((chart.chart || {}).result || [])[0];
const closes = ((((result || {}).indicators || {}).quote || [])[0] || {}).close || [];
const price = closes.find((c) => typeof c === 'number');
if (!price) throw new Error(`No DBK price around ${dateIso}`);
const fx = await (await fetch(`https://api.frankfurter.dev/v1/${dateIso}?base=GBP&symbols=EUR`)).json();
const rate = (fx.rates || {}).EUR;
if (!rate) throw new Error(`No GBP/EUR rate around ${dateIso}`);
return { price, rate, shares: (data.ticker.monthlyGbp * rate) / price };
}

// Adds the months that have come due since the last run. Deliberately
// forward-only from the count you entered: reconstructing five years of
// purchases would produce a number you'd then have to correct, and you
// said you adjust by hand for dividends and sales anyway.
async function accrueShares() {
const t = data.ticker;
if (!t.sharesAt) { t.sharesAt = iso(new Date()); queueSave(); return { added: 0 }; }
const now = new Date();
const last = new Date(t.sharesAt);
let added = 0;
const bought = [];
// Walk month by month rather than jumping, so a gap of several months --
// an app not opened all summer -- lands every purchase it missed.
for (let y = last.getUTCFullYear(), m = last.getUTCMonth(); ;) {
m += 1;
if (m > 11) { m = 0; y += 1; }
const due = firstBusinessDay(y, m);
if (due > now) break;
if (iso(due) <= t.sharesAt) continue;
// The price five years earlier is what these shares actually cost.
const paidOn = firstBusinessDay(y - t.vestYears, m);
try {
const buy = await purchaseOn(iso(paidOn));
t.shares = Number((t.shares + buy.shares).toFixed(4));
bought.push({ on: iso(due), paidOn: iso(paidOn), price: buy.price, shares: buy.shares });
// Kept on the record so the Holding tile can show its working: a
// monthly number that silently inflates a holding is worse than no
// automation at all.
t.lastBuy = { on: iso(due), paidOn: iso(paidOn), price: buy.price, shares: buy.shares };
// The month-by-month record the holding editor lists since the baseline.
if (!Array.isArray(t.accruals)) t.accruals = [];
t.accruals.push({ on: iso(due), paidOn: iso(paidOn), price: buy.price, shares: buy.shares, gbp: t.monthlyGbp });
added += buy.shares;
} catch (err) {
// A month that can't be priced stops the walk rather than being
// skipped: skipping it would lose that purchase silently and leave
// sharesAt past it, so it could never be recovered.
console.error('Share accrual stopped at', iso(due), err);
break;
}
t.sharesAt = iso(due);
}
if (added) queueSave();
return { added, bought };
}


// ---- Rendering ------------------------------------------------------------

function pct(now, then) {
if (typeof now !== 'number' || typeof then !== 'number' || !then) return null;
return ((now - then) / then) * 100;
}

function changeHtml(now, then, { points = false } = {}) {
if (typeof now !== 'number' || typeof then !== 'number') return '<span class="tick-flat">—</span>';
const diff = now - then;
const shown = points ? `${diff >= 0 ? '+' : ''}${diff.toFixed(3)}` : `${diff >= 0 ? '+' : ''}${pct(now, then).toFixed(2)}%`;
const cls = diff > 0 ? 'tick-up' : diff < 0 ? 'tick-down' : 'tick-flat';
return `<span class="${cls}">${escapeHtml(shown)}</span>`;
}

// A link where there's a page worth landing on, a plain span where there
// isn't -- a tile that looks clickable and does nothing is worse than one
// that doesn't invite the click.
function tile(label, value, change, title, { href = '', edit = false, auto = false, tripId = '', accountId = '', gotoTab = '', gotoTarget = '', taskId = '' } = {}) {
const attrs = `class="tick${auto ? ' tick-auto' : ''}" title="${escapeHtml(title || '')}"`;
const inner = `<span class="tick-label">${escapeHtml(label)}</span>
<span class="tick-value">${value}</span>
${change || ''}`;
// Outside the link, so the plane goes to the trip and the rest of the
// tile goes to the forecast without one swallowing the other.
const plane = tripId
? `<button class="tick-trip" type="button" data-open-trip="${escapeHtml(tripId)}" title="Open the trip this is here for">&#9992;</button>`
: '';
// A CASS bonus names a real finance account (CLAUDE.md's record-
// reference rule), so it has to link back the same way the trip plane
// does -- the whole tile is the target here rather than a second icon,
// since there's no separate "forecast" the tile would otherwise open.
// gotoTab/gotoTarget is the simpler, generic form of the same idea --
// app.js's own document-level `[data-goto-tab]` handler already does
// switchTab + open-the-settings-group + scrollAndFlash for free, so a
// tile pointing into Settings (site health, anything added later) needs
// no bespoke click handler of its own the way accountId still has.
const extraAttr = edit ? ' data-ticker-edit="1"'
: accountId ? ` data-ticker-account="${escapeHtml(accountId)}"`
: taskId ? ` data-ticker-task="${escapeHtml(taskId)}"`
: gotoTab ? ` data-goto-tab="${escapeHtml(gotoTab)}"${gotoTarget ? ` data-goto-target="${escapeHtml(gotoTarget)}"` : ''}`
: '';
if (href) return `<span class="tick-pair">${plane}<a ${attrs} href="${escapeHtml(href)}" target="_blank" rel="noopener">${inner}</a></span>`;
return `<span class="tick-pair">${plane}<span ${attrs}${extraAttr}>${inner}</span></span>`;
}

const SOURCE = {
fx: (i) => `https://www.xe.com/currencycharts/?from=${i.base || HOME}&to=${i.quote}`,
quote: (i) => `https://finance.yahoo.com/quote/${encodeURIComponent(i.symbol)}`,
sonia: () => 'https://cf.com/rates/europe/sonia-swaps/historical-rates',
weather: (i) => `https://www.google.com/search?q=weather+${encodeURIComponent(i.city)}`,
};

function tileFor(item, monthly) {
const c = cache();
const hit = c[keyFor(item)];
const pick = (h) => (monthly ? h.prevMonth : h.prevDay);
const t = data.ticker;

if (item.kind === 'letting') {
// Derived from the ledger every time rather than cached: it changes
// when you add a payment, not when a feed refreshes.
const { totalOwed, owners, balanceFor, ownerNameFor, money, isMyOwnKey } = letting;
const total = totalOwed();
// Same self-exclusion totalOwed() itself already applies -- a self-
// owned listing's own balance is never actually owed to anyone, so it
// has no business in this "who owes you" breakdown either (confirmed
// live: this line was still listing "Phil £1,000.00" alongside the
// correct headline total).
const owed = owners().filter((k) => !isMyOwnKey(k));
if (!owed.length) return '';
return tile('Owed', escapeHtml(money(total)), '',
`${owed.map((k) => `${ownerNameFor(k)} ${money(balanceFor(k))}`).join(' · ')}. Letting income owed to you — click to open Lettings.`,
{ gotoTab: 'finances', gotoTarget: '#letting-panel' });
}
if (item.kind === 'loyalty') {
// One tile, rotating through whichever programs are flagged
// showOnTravel (js/features/loyaltybalances.js's own Finance-tab
// config) -- see currentLoyaltyPick() for the shared selection logic.
const pick = currentLoyaltyPick();
if (!pick) return '';
const { program, r } = pick;
const valueText = r.balance != null ? r.balance.toLocaleString('en-GB') : '—';
// Compact: the programme's logo stands in for its name when it has one
// ("45,000" with the Bonvoy mark), otherwise the short name follows the
// number ("45,000 Bonvoy"). A bare "points" unit adds nothing either way.
// tile() escapes its label and title itself, so those are passed RAW --
// pre-escaping them showed "Miles &amp More".
const unit = r.unit && !/^(points?|miles?|pts)$/i.test(r.unit) ? ` ${r.unit}` : '';
const shortName = String(program.name || '').replace(/^(marriott|british airways|virgin)\s+/i, '').replace(/\s+(executive club|flying club|advantage card|gold plus rewards|rewards|club)$/i, '') || program.name;
const logo = program.logoUrl ? `<img class="tick-bank-logo" src="${escapeHtml(program.logoUrl)}" alt="${escapeHtml(program.name)}" onerror="this.replaceWith(document.createTextNode(this.alt))">` : '';
return tile('', `${logo}${escapeHtml(valueText)}${escapeHtml(unit)}${logo || unit ? '' : ` ${escapeHtml(shortName)}`}`, '',
`${program.name}: ${r.label} ${valueText} ${r.unit || ''} as of ${r.date}. Click to open Loyalty balances.`,
{ gotoTab: 'finances', gotoTarget: '#loyalty-balances-panel' });
}
if (item.kind === 'cass') {
const logo = item.logoUrl ? `<img class="tick-bank-logo" src="${escapeHtml(item.logoUrl)}" alt="" onerror="this.remove()">` : '';
return tile('CASS', `${logo}${letting.money(item.amount)}`, '',
`${item.bank}${item.description ? ` — ${item.description}` : ''}. Switch bonus still being worked on — click to open the account.`,
{ auto: true, accountId: item.accountId });
}
if (item.kind === 'yearlyperk') {
return tile('Perk', `${letting.money(item.amount)} · ${item.count} to do`, '',
`${item.label}: ${item.count} reminder${item.count === 1 ? '' : 's'} due — next: ${item.first.title}. Click to open it.`,
{ auto: true, taskId: item.first.id });
}
if (item.kind === 'inv-incomplete') {
const names = item.sets.map((s) => [s.brand, s.style, s.colour].filter(Boolean).join(' ') || 'Unnamed set');
return tile('Stock', item.count === 1 ? '1 set' : `${item.count} sets`, '',
`Missing a piece: ${names.join(' · ')}. Inventory — Shopping tab.`,
{ auto: true, gotoTab: 'shopping', gotoTarget: '#inventory-list' });
}
if (item.kind === 'sitehealth') {
const { check, row } = item.worst;
// Naming the check directly in the tile's own value, not just its
// title tooltip -- a tooltip needs a hover or a long-press, neither
// reliable on a phone, which is exactly where "where IS the failing
// check" turned out to be unanswerable from the ticker alone. Jumps
// straight to that check's own row (site-health-row-<id>, added to
// sitehealth.js's table for this), not just the table in general, so
// even with several failing you land on the one actually named here.
return tile('Checks', escapeHtml(item.count === 1 ? check.label : `${item.count} failing`), '',
`${check.label}: ${row.detail || 'failing'}${item.count > 1 ? ` (and ${item.count - 1} other check${item.count === 2 ? '' : 's'} -- this names the longest-broken one)` : ''}. Click to open it.`,
{ auto: true, gotoTab: 'settings', gotoTarget: `#site-health-row-${check.id}` });
}
if (item.kind === 'modelcheck') {
const { top } = item;
// Names the feature and the model in the value itself, not just the
// tooltip -- same lesson as the Checks tile (a hover is unreliable on a
// phone). Rate wording comes from the finding so a same-price upgrade
// never reads as a saving.
const lines = item.all.map((f) => `${f.purpose}: ${f.model} → ${f.upgrade} ($${f.cost.toFixed(2)} in ${f.month}; ${f.price.text})`);
return tile('Models', escapeHtml(item.count === 1 ? `${top.purpose} ↑ ${top.upgrade}` : `${item.count} upgrades`), '',
`${lines.join(' · ')}. A newer model exists for something that cost over $${item.minCost} in a month. Click to open.`,
{ auto: true, gotoTab: 'settings', gotoTarget: '#model-check-panel' });
}
if (item.kind === 'claudeusage') {
const pace = claudeWeeklyPace(item.sub);
if (!pace) return '';
const fh = item.sub.fiveHour || {};
const ageH = item.sub.asOf ? (Date.now() - new Date(item.sub.asOf).getTime()) / 3600000 : null;
const stale = ageH !== null && ageH > 6;
// Used above the flat-pace line reads red, at or under it green.
const cls = pace.points > 0.5 ? 'tick-down' : 'tick-up';
const five = fh.percentUsed != null ? `<span class="tick-flat">5h ${Math.round(fh.percentUsed)}%${stale ? ' · stale' : ''}</span>` : (stale ? '<span class="tick-flat">stale</span>' : '');
const exhaust = pace.exhaustAt ? ` At this rate it hits 100% around ${new Date(pace.exhaustAt).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}.` : '';
return tile('Claude', `<span class="${cls}">w${Math.round(pace.used)}%/${Math.round(pace.expected)}%</span>`, five,
`Weekly usage ${Math.round(pace.used)}% against ${Math.round(pace.expected)}% of the week elapsed (${Math.abs(pace.points).toFixed(1)} points ${pace.points > 0 ? 'ahead of' : 'behind'} a flat pace).${exhaust}${item.sub.asOf ? ` Reading taken ${Math.round(ageH)}h ago.` : ''} Click for detail.`,
{ auto: true, gotoTab: 'settings', gotoTarget: '#claude-usage-summary' });
}
if (item.kind === 'holding') {
// Folded into the quote tile for the same stock when the strip has one.
const holdSym = t.holdingSymbol || 'DBK.DE';
if ((t.items || []).some((i) => !i.hidden && i.kind === 'quote' && i.symbol === holdSym)
&& t.shares && c[keyFor({ kind: 'quote', symbol: holdSym })]?.value !== undefined) return '';
const fxHit = c[keyFor({ kind: 'fx', base: HOME, quote: 'EUR' })];
const dbkHit = c[keyFor({ kind: 'quote', symbol: t.holdingSymbol || 'DBK.DE' })];
if (!fxHit || fxHit.value === undefined || !dbkHit || dbkHit.value === undefined) return '';
// With no share count there was nothing to click, and the editor was
// only reachable BY clicking -- so a fresh document could never be
// given a number. The tile asks for one instead.
if (!t.shares) {
return tile('Holding', '<span class="tick-flat">set shares</span>', '',
'No share count yet. Click to enter how many you hold.', { edit: true });
}
const gbp = (t.shares * dbkHit.value) / fxHit.value;
const prev = pick(dbkHit) && pick(fxHit) ? (t.shares * pick(dbkHit)) / pick(fxHit) : null;
// Flagged for 14 days after a real payout, or until you next edit the
// count (editShares() stamps exDivClearedAt then) -- whichever comes
// first. The per-share price drops by roughly the dividend amount on
// that date, so without this a holding that's actually fine reads as a
// sudden loss.
const daysSinceDiv = dbkHit.lastDividendAt ? (Date.now() - new Date(dbkHit.lastDividendAt).getTime()) / 86400000 : Infinity;
const cleared = t.exDivClearedAt && dbkHit.lastDividendAt && new Date(t.exDivClearedAt) >= new Date(dbkHit.lastDividendAt);
const exDiv = daysSinceDiv <= 14 && !cleared;
return tile('Holding', `£${Math.round(gbp).toLocaleString('en-GB')}${exDiv ? ' ex-div' : ''}`, changeHtml(gbp, prev),
`${t.shares.toFixed(2)} shares at ${dbkHit.value.toFixed(2)}, converted at ${fxHit.value.toFixed(4)}.`
+ (t.lastBuy ? ` Last added ${t.lastBuy.shares.toFixed(2)} on ${t.lastBuy.on}, priced at €${t.lastBuy.price.toFixed(2)} (${t.lastBuy.paidOn}).` : '')
+ (exDiv ? ` Went ex-dividend ${dbkHit.lastDividendAt} -- the price drop is the payout, not a loss.` : '')
+ ' Click to set the count or the monthly amount.', { edit: true });
}

// A feed that failed says so in its own slot. Several of these need the
// proxy, so "missing" and "the proxy isn't updated" look identical from
// the outside unless the tile admits which.
if (!hit || hit.value === undefined) {
if (!hit || !hit.error) return '';
return tile(labelFor(item), '<span class="tick-flat">·</span>',
'<span class="tick-down">failed</span>', `${labelFor(item)}: ${hit.error}. Click to open the ticker settings.`,
{ gotoTab: 'settings', gotoTarget: '#ticker-items' });
}

switch (item.kind) {
case 'fx':
return tile(labelFor(item), hit.value.toFixed(4), changeHtml(hit.value, pick(hit)),
`ECB fixing for ${hit.date}, via Frankfurter.${item.note ? ` ${item.note}.` : ''}`,
{ href: SOURCE.fx(item), auto: item.auto, tripId: item.tripId });
case 'quote': {
const sym = `${hit.currency === 'EUR' ? '€' : hit.currency === 'USD' ? '$' : ''}${hit.value.toFixed(2)}`;
// The share-scheme holding is the same stock, so it rides on this tile
// ("DBK €29.11 / £6,401") instead of taking a second one. Click opens the
// holding editor, which a plain quote link has no use for.
const fxHit = c[keyFor({ kind: 'fx', base: HOME, quote: 'EUR' })];
if (item.symbol === (t.holdingSymbol || 'DBK.DE') && t.shares && fxHit && fxHit.value !== undefined) {
const gbp = (t.shares * hit.value) / fxHit.value;
const daysSinceDiv = hit.lastDividendAt ? (Date.now() - new Date(hit.lastDividendAt).getTime()) / 86400000 : Infinity;
const cleared = t.exDivClearedAt && hit.lastDividendAt && new Date(t.exDivClearedAt) >= new Date(hit.lastDividendAt);
const exDiv = daysSinceDiv <= 14 && !cleared;
return tile(labelFor(item), `${sym} / £${Math.round(gbp).toLocaleString('en-GB')}${exDiv ? ' ex-div' : ''}`,
changeHtml(hit.value, pick(hit)),
`${item.symbol} at ${hit.value.toFixed(2)}; your ${t.shares.toFixed(2)} shares are worth about £${Math.round(gbp).toLocaleString('en-GB')} at ${fxHit.value.toFixed(4)}.`
+ (t.lastBuy ? ` Last added ${t.lastBuy.shares.toFixed(2)} on ${t.lastBuy.on}.` : '')
+ (exDiv ? ` Went ex-dividend ${hit.lastDividendAt} -- the price drop is the payout, not a loss.` : '')
+ ' Click to set the count or the monthly amount.', { edit: true, auto: item.auto });
}
return tile(labelFor(item), sym,
changeHtml(hit.value, pick(hit)), `${item.symbol}, via Yahoo Finance.`,
{ href: SOURCE.quote(item), auto: item.auto });
}
case 'sonia':
return tile('2y SONIA', `${hit.value.toFixed(3)}%`,
// A swap rate moves in basis points, so a percentage change of a
// percentage reads as nonsense -- this one shows the points.
changeHtml(hit.value, monthly ? hit.prevMonth : hit.prevDay, { points: true }),
`2-year SONIA swap, Chatham Financial${hit.via === 'agent' ? ', via the home agent' : ''}. A month ago ${hit.prevMonth}%, a year ago ${hit.prevYear}%.`,
{ href: SOURCE.sonia() });
case 'weather': {
// Two pictures rather than a word: the afternoon and the evening are
// often different days as far as a coat is concerned.
const day = weatherIcon(hit.dayCode ?? hit.code);
const night = weatherIcon(hit.nightCode ?? hit.code, { night: true });
return tile(labelFor(item), `${Math.round(hit.max)}° / ${Math.round(hit.min)}°`,
`<span class="tick-flat tick-wx">${day}${night}${hit.rain >= 20 ? ` ${hit.rain}%` : ''}</span>`,
`High ${Math.round(hit.max)}°, low ${Math.round(hit.min)}°. `
+ `Afternoon ${weatherWord(hit.dayCode ?? hit.code).toLowerCase()}, evening ${weatherWord(hit.nightCode ?? hit.code).toLowerCase()}, `
+ `${hit.rain}% chance of rain.${item.note ? ` ${item.note}.` : ''}`,
{ href: SOURCE.weather(item), auto: item.auto, tripId: item.tripId });
}
default: return '';
}
}

function labelFor(item) {
switch (item.kind) {
case 'fx': return `${item.base || HOME}/${item.quote}`;
case 'quote': return item.label || item.symbol;
case 'weather': return item.city;
case 'sonia': return '2y SONIA';
case 'letting': return 'Owed';
case 'loyalty': return 'Loyalty balances';
case 'holding': return 'Holding';
case 'cass': return 'CASS';
case 'yearlyperk': return 'Perk';
case 'sitehealth': return 'Checks';
case 'modelcheck': return 'Models';
case 'claudeusage': return 'Claude';
default: return item.kind;
}
}

function renderTicker() {
const el = document.getElementById('ticker');
if (!el) return;
lastLoyaltyPickKey = loyaltyPickKey();
const monthly = data.ticker.mode === 'month';
const tiles = activeItems().map((i) => tileFor(i, monthly)).filter(Boolean);
if (!tiles.length) { el.innerHTML = ''; el.classList.remove('is-rolling'); return; }

// Where the marquee had got to, so rebuilding the strip (the loyalty tile
// rotates every 20s, and any feed can finish) carries on from the same
// place instead of snapping back to the start -- which is why the later
// tiles were never reached before the next rebuild.
const oldAnim = el.querySelector('#tick-track')?.getAnimations?.()[0];
const resumeAt = oldAnim ? Number(oldAnim.currentTime) || 0 : 0;

// The track is duplicated so the loop has no seam: the animation slides
// it exactly one copy's width and restarts, which looks continuous
// because the second copy is already in the first copy's place.
const row = tiles.join('');
el.innerHTML = `<div class="tick-viewport"><div class="tick-track" id="tick-track">`
+ `<span class="tick-run">${row}</span><span class="tick-run" aria-hidden="true">${row}</span>`
+ `</div></div>`
+ `<button class="tick-toggle" type="button" id="ticker-mode" title="Switch between change since yesterday and since a month ago">${monthly ? 'month' : 'day'}</button>`;

el.querySelector('#ticker-mode').addEventListener('click', () => {
data.ticker.mode = monthly ? 'day' : 'month';
queueSave();
renderTicker();
});
// querySelectorAll, not querySelector -- the track is rendered TWICE
// (the second .tick-run copy just below, for the seamless scroll loop),
// so a singular query only ever bound the first copy and left clicks on
// the second one doing nothing, depending on which copy a click landed
// on.
el.querySelectorAll('[data-ticker-edit]').forEach((span) => span.addEventListener('click', editShares));
// Reuses Travel's own reveal rather than a second way of showing a trip.
el.querySelectorAll('[data-open-trip]').forEach((btn) => {
btn.addEventListener('click', async () => {
const [{ switchTab }, travel] = await Promise.all([import('../tabs.js'), import('./travel.js')]);
switchTab('travel');
travel.revealTrip(btn.dataset.openTrip);
});
});
// Same reveal shape, for a CASS tile's own account -- the finance
// accounts panel's existing expand+scroll+flash, not a second one.
el.querySelectorAll('[data-ticker-account]').forEach((span) => {
span.addEventListener('click', async () => {
const [{ switchTab }, financeaccounts] = await Promise.all([import('../tabs.js'), import('./financeaccounts.js')]);
switchTab('finances');
financeaccounts.expandAccountRow(span.dataset.tickerAccount);
});
});
// A yearly-perk tile opens its next due reminder in Tasks.
el.querySelectorAll('[data-ticker-task]').forEach((span) => {
span.addEventListener('click', async () => {
const [{ switchTab }, tasks] = await Promise.all([import('../tabs.js'), import('./tasks.js')]);
switchTab('tasks');
tasks.revealTask(span.dataset.tickerTask);
});
});
startRolling(el, resumeAt);
}

// Rotation, but only when it is needed and only when it is wanted: a
// strip that fits has nothing to scroll past, and a moving strip is
// exactly the thing prefers-reduced-motion exists to stop. Speed is fixed
// in pixels per second rather than a fixed duration, so adding a tile
// slows the loop instead of speeding everything up.
const ROLL_PX_PER_SEC = 26;

function startRolling(el, resumeAt = 0) {
const track = el.querySelector('#tick-track');
const run = el.querySelector('.tick-run');
if (!track || !run) return;
const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
// Measured after layout, so the width is the real one rather than zero.
requestAnimationFrame(() => {
const runWidth = run.getBoundingClientRect().width;
const viewport = el.querySelector('.tick-viewport').getBoundingClientRect().width;
const overflows = runWidth > viewport + 4;
el.classList.toggle('is-rolling', overflows && !still);
if (!overflows || still) { track.style.animation = ''; return; }
track.style.setProperty('--roll-distance', `-${runWidth}px`);
const seconds = Math.max(20, runWidth / ROLL_PX_PER_SEC);
track.style.animationDuration = `${seconds}s`;
if (resumeAt > 0) {
track.getBoundingClientRect(); // apply the new style so the animation object exists
const anim = track.getAnimations()[0];
if (anim) anim.currentTime = resumeAt % (seconds * 1000);
}
});
}

// A real dialog, not two chained prompt() calls -- confirmed live that a
// second prompt() fired right after the first one resolves doesn't
// reliably show (browsers throttle/suppress back-to-back dialogs from
// the same handler), which left the monthly figure unreachable in
// practice even though the code asked for it. Same backdrop-card shape
// every other small dialog in this app already uses (e.g. tasks.js's
// "file to Projects" dialog), not a new pattern.
// The holding dialog: the baseline you last set, what the monthly scheme has
// added since (by month), and the controls to rebaseline -- which sets the
// share count and wipes that list -- or just change the monthly amount.
function editShares() {
const t = data.ticker;
const accruals = Array.isArray(t.accruals) ? t.accruals : [];
const accruedShares = accruals.reduce((n, a) => n + (Number(a.shares) || 0), 0);
const baseline = Number((t.shares - accruedShares).toFixed(4));
const monthKey = (d) => String(d).slice(0, 7);
const byMonth = new Map();
accruals.forEach((a) => {
const k = monthKey(a.on);
const row = byMonth.get(k) || { shares: 0, gbp: 0, prices: [] };
row.shares += Number(a.shares) || 0;
row.gbp += Number(a.gbp) || 0;
if (a.price) row.prices.push(a.price);
byMonth.set(k, row);
});
const monthLabel = (k) => new Date(`${k}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
const rows = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, r]) => `<tr>
<td>${escapeHtml(monthLabel(k))}</td>
<td style="text-align:right;">+${r.shares.toFixed(4)}</td>
<td style="text-align:right;">${r.prices.length ? `€${(r.prices.reduce((n, p) => n + p, 0) / r.prices.length).toFixed(2)}` : ''}</td>
<td style="text-align:right;">£${Math.round(r.gbp).toLocaleString('en-GB')}</td>
</tr>`).join('');
const since = t.baselineAt || t.sharesAt || '';
const dialog = document.createElement('div');
dialog.className = 'mail-view-backdrop';
dialog.innerHTML = `<div class="mail-view-card" style="max-width:420px;">
<div class="mail-view-subject">Holding — ${escapeHtml(t.holdingSymbol || 'DBK.DE')}</div>
<div class="settings-note" style="margin:0 0 4px;">Baseline: <strong>${baseline.toLocaleString('en-GB')}</strong> shares${since ? `, set ${escapeHtml(since)}` : ''}</div>
${rows ? `<table class="limits-table" style="min-width:0;width:100%;margin:4px 0;"><thead><tr><th>Month</th><th style="text-align:right;">Shares added</th><th style="text-align:right;">Price paid</th><th style="text-align:right;">Put in</th></tr></thead><tbody>${rows}</tbody>
<tfoot><tr><td><strong>Since baseline</strong></td><td style="text-align:right;"><strong>+${accruedShares.toFixed(4)}</strong></td><td></td><td style="text-align:right;"><strong>£${Math.round(accruals.reduce((n, a) => n + (Number(a.gbp) || 0), 0)).toLocaleString('en-GB')}</strong></td></tr></tfoot></table>`
: '<div class="settings-note" style="margin:4px 0;">Nothing added since the baseline yet. Each month\'s purchase will be listed here.</div>'}
<div class="settings-note" style="margin:4px 0 10px;">Now: <strong>${t.shares.toLocaleString('en-GB')}</strong> shares</div>
<label class="settings-note" style="display:block;margin:0 0 3px;">Rebaseline: the real share count today</label>
<div class="sync-row" style="margin:0;">
<input type="number" step="any" min="0" id="holding-edit-shares" class="settings-input" value="${t.shares}" style="flex:1;">
<button class="sync-btn sm inline" type="button" data-holding-rebaseline title="Sets the share count to this number, wipes the monthly list above and counts again from today">Rebaseline</button>
</div>
<label class="settings-note" style="display:block;margin:10px 0 3px;">Monthly contribution (£), added on the first business day of each month, priced as at five years earlier</label>
<input type="number" step="any" min="0" id="holding-edit-monthly" class="settings-input" value="${t.monthlyGbp}" style="width:100%;">
<div class="mail-view-actions">
<button class="sync-btn sm" type="button" data-holding-cancel>Close</button>
<button class="add-btn" type="button" data-holding-save>Save monthly amount</button>
</div>
</div>`;
document.body.appendChild(dialog);
const close = () => dialog.remove();
bindBackdropClose(dialog, close);
dialog.querySelector('[data-holding-cancel]').addEventListener('click', close);
dialog.querySelector('[data-holding-rebaseline]').addEventListener('click', () => {
const n = Number(dialog.querySelector('#holding-edit-shares').value);
if (!Number.isFinite(n) || n < 0) return;
if (accruals.length && !confirm(`Set the holding to ${n.toLocaleString('en-GB')} shares and clear the ${accruals.length} month${accruals.length === 1 ? '' : 's'} listed? Counting starts again from today.`)) return;
t.shares = n;
// Counted from today, so entering a corrected number doesn't replay
// purchases that number already includes.
t.sharesAt = iso(new Date());
t.baselineAt = iso(new Date());
t.accruals = [];
// Rebaselining is itself the "I've seen this" action the ex-div flag
// exists to prompt.
t.exDivClearedAt = new Date().toISOString();
queueSave();
renderTicker();
close();
});
dialog.querySelector('[data-holding-save]').addEventListener('click', () => {
const m = Number(dialog.querySelector('#holding-edit-monthly').value);
if (Number.isFinite(m) && m >= 0) t.monthlyGbp = m;
queueSave();
renderTicker();
close();
});
}

// Each feed is independent: one failing should cost you that tile, not the
// strip. A failure leaves the previous cached answer on screen, which is
// why the tiles carry their own date rather than implying "now".
async function refreshTicker({ force = false } = {}) {
if (force) {
// Geocodes are kept: they are answers to "where is Lisbon", which does
// not go stale and costs a request to ask again.
const geo = Object.fromEntries(Object.entries(cache()).filter(([k]) => k.startsWith('geo:')));
data.tickerCache = geo;
}
// Trip destinations are looked up first, so the tiles they imply exist
// before the feeds are fetched and nothing needs a second pass.
await Promise.all(upcomingDestinations().map(async (d) => {
try { await geocode(d.place); } catch (err) { console.error('Ticker: geocode failed for', d.place, err); }
}));

const jobs = activeItems().filter((i) => i.kind !== 'holding');
await Promise.all(jobs.map(async (item) => {
const key = keyFor(item);
// Both ride on an undocumented third-party endpoint with no stability
// contract (see sitehealth.js's own note on each) -- reported here,
// at their one real trigger, rather than a second canary fetch asking
// the same question again.
const healthCheckId = item.kind === 'sonia' ? 'sonia-swap-feed' : item.kind === 'quote' ? 'yahoo-finance-quote' : '';
try {
if (item.kind === 'fx') await fetchFx(item);
else if (item.kind === 'quote') await fetchQuote(item);
else if (item.kind === 'weather') await fetchWeather(item);
else if (item.kind === 'sonia') await fetchSonia();
// Any previous failure is cleared by a success, so a tile that has
// started working stops apologising for yesterday.
if (cache()[key]) delete cache()[key].error;
if (healthCheckId) reportSiteHealth(healthCheckId, true, `${labelFor(item)} refreshed OK`);
} catch (err) {
console.error(`Ticker: ${key} failed:`, err);
// A tile that simply vanishes is the worst of both worlds: you can
// see something is missing but not what, and the console is not
// where you were looking. The message is kept and shown.
const existing = cache()[key] || {};
cache()[key] = { ...existing, error: err.message || String(err), erroredAt: new Date().toISOString() };
queueSave();
if (healthCheckId) reportSiteHealth(healthCheckId, false, err.message || String(err));
}
}));
try { await accrueShares(); } catch (err) { console.error('Ticker: share accrual failed:', err); }
renderTicker();
}

function initTicker() {
if (!document.getElementById('ticker')) return;
renderTicker();
window.addEventListener('claude-usage-updated', renderTicker);
// After first paint and the initial document pull, like the scheduled
// syncs: a fetch into a half-loaded app just fails and caches nothing.
setTimeout(() => refreshTicker(), 3000);
// Drives the loyalty tile's own rotation (see tileFor's `kind:
// 'loyalty'` branch) -- confirmed live as a real gap: without this,
// NOTHING in this file ever re-rendered the ticker on its own, so the
// rotation only advanced on whatever other event happened to trigger
// a re-render, which could easily never land on a new bucket.
//
// Checks every 2s (cheap, local-only, no network) but only actually
// calls renderTicker() when loyaltyPickKey() has genuinely changed --
// confirmed live as a real regression from the first version of this
// fix, which called renderTicker() unconditionally every 10s: that
// rebuilds the WHOLE ticker's DOM (renderTicker's own innerHTML
// rewrite) and restarts its CSS scroll animation every time, even on
// the 9 out of 10 ticks where the loyalty bucket hadn't actually
// changed -- the marquee never got to finish a single lap (its own
// minimum duration is 20s, longer than the 10s restart interval),
// which read as "scrolls for a few seconds then jumps back."
setInterval(() => {
if (loyaltyPickKey() === lastLoyaltyPickKey) return;
renderTicker();
}, 2000);
// The strip's width decides whether it rolls, so a rotated phone or a
// resized window has to be re-measured.
let t = null;
window.addEventListener('resize', () => {
clearTimeout(t);
t = setTimeout(() => startRolling(document.getElementById('ticker')), 200);
});
}

export { initTicker, renderTicker, refreshTicker, accrueShares, geocode, CURRENCY, labelFor };
