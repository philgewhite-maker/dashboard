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
import { data, queueSave } from '../state.js';
import { escapeHtml, uid } from '../utils.js';

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
const raw = await viaProxy(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(item.symbol)}?range=1mo&interval=1d`);
const body = JSON.parse(raw);
const result = ((body.chart || {}).result || [])[0];
if (!result) throw new Error(`Yahoo returned no data for ${item.symbol}`);
const meta = result.meta || {};
const closes = (((result.indicators || {}).quote || [])[0] || {}).close || [];
const known = closes.filter((c) => typeof c === 'number');
return store(key, {
value: meta.regularMarketPrice,
currency: meta.currency || '',
// chartPreviousClose is the close before the range started, so the
// previous DAY is the second-to-last point in the series itself.
prevDay: known.length > 1 ? known[known.length - 2] : meta.chartPreviousClose ?? null,
prevMonth: known.length ? known[0] : null,
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
// DAILY move from -- we keep that ourselves, carrying the last value
// across whenever the calendar date changes. The day column is blank
// until the strip has seen two days, which is honest; the alternative
// was labelling a month-old rate as yesterday's.
const previous = cache().sonia;
const value = Number(two.PreviousDay);
const sameDay = previous && previous.at && previous.at.slice(0, 10) === new Date().toISOString().slice(0, 10);
return store('sonia', {
value,
prevDay: sameDay ? (previous.prevDay ?? null) : (previous && previous.value !== undefined ? previous.value : null),
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

// Your own list plus the travel ones, with duplicates dropped: a trip to
// Dublin shouldn't give you a second GBP/EUR tile next to the one you
// already keep.
function activeItems() {
const mine = (data.ticker.items || []).filter((i) => !i.hidden);
const seen = new Set(mine.map(keyFor));
const extra = travelItems().filter((i) => !seen.has(keyFor(i)));
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
function tile(label, value, change, title, { href = '', edit = false, auto = false, tripId = '' } = {}) {
const attrs = `class="tick${auto ? ' tick-auto' : ''}" title="${escapeHtml(title || '')}"`;
const inner = `<span class="tick-label">${escapeHtml(label)}</span>
<span class="tick-value">${value}</span>
${change || ''}`;
// Outside the link, so the plane goes to the trip and the rest of the
// tile goes to the forecast without one swallowing the other.
const plane = tripId
? `<button class="tick-trip" type="button" data-open-trip="${escapeHtml(tripId)}" title="Open the trip this is here for">&#9992;</button>`
: '';
if (href) return `<span class="tick-pair">${plane}<a ${attrs} href="${escapeHtml(href)}" target="_blank" rel="noopener">${inner}</a></span>`;
return `<span class="tick-pair">${plane}<span ${attrs}${edit ? ' data-ticker-edit="1"' : ''}>${inner}</span></span>`;
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

if (item.kind === 'holding') {
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
return tile('Holding', `£${Math.round(gbp).toLocaleString('en-GB')}`, changeHtml(gbp, prev),
`${t.shares.toFixed(2)} shares at ${dbkHit.value.toFixed(2)}, converted at ${fxHit.value.toFixed(4)}.`
+ (t.lastBuy ? ` Last added ${t.lastBuy.shares.toFixed(2)} on ${t.lastBuy.on}, priced at €${t.lastBuy.price.toFixed(2)} (${t.lastBuy.paidOn}).` : '')
+ ' Click to set the count.', { edit: true });
}

// A feed that failed says so in its own slot. Several of these need the
// proxy, so "missing" and "the proxy isn't updated" look identical from
// the outside unless the tile admits which.
if (!hit || hit.value === undefined) {
if (!hit || !hit.error) return '';
return tile(labelFor(item), '<span class="tick-flat">·</span>',
'<span class="tick-down">failed</span>', `${labelFor(item)}: ${hit.error}`);
}

switch (item.kind) {
case 'fx':
return tile(labelFor(item), hit.value.toFixed(4), changeHtml(hit.value, pick(hit)),
`ECB fixing for ${hit.date}, via Frankfurter.${item.note ? ` ${item.note}.` : ''}`,
{ href: SOURCE.fx(item), auto: item.auto, tripId: item.tripId });
case 'quote':
return tile(labelFor(item), `${hit.currency === 'EUR' ? '€' : hit.currency === 'USD' ? '$' : ''}${hit.value.toFixed(2)}`,
changeHtml(hit.value, pick(hit)), `${item.symbol}, via Yahoo Finance.`,
{ href: SOURCE.quote(item), auto: item.auto });
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
case 'holding': return 'Holding';
default: return item.kind;
}
}

function renderTicker() {
const el = document.getElementById('ticker');
if (!el) return;
const monthly = data.ticker.mode === 'month';
const tiles = activeItems().map((i) => tileFor(i, monthly)).filter(Boolean);
if (!tiles.length) { el.innerHTML = ''; el.classList.remove('is-rolling'); return; }

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
el.querySelector('[data-ticker-edit]')?.addEventListener('click', editShares);
// Reuses Travel's own reveal rather than a second way of showing a trip.
el.querySelectorAll('[data-open-trip]').forEach((btn) => {
btn.addEventListener('click', async () => {
const [{ switchTab }, travel] = await Promise.all([import('../tabs.js'), import('./travel.js')]);
switchTab('travel');
travel.revealTrip(btn.dataset.openTrip);
});
});
startRolling(el);
}

// Rotation, but only when it is needed and only when it is wanted: a
// strip that fits has nothing to scroll past, and a moving strip is
// exactly the thing prefers-reduced-motion exists to stop. Speed is fixed
// in pixels per second rather than a fixed duration, so adding a tile
// slows the loop instead of speeding everything up.
const ROLL_PX_PER_SEC = 26;

function startRolling(el) {
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
track.style.animationDuration = `${Math.max(20, runWidth / ROLL_PX_PER_SEC)}s`;
});
}

function editShares() {
const t = data.ticker;
const now = prompt(`Shares held in ${t.holdingSymbol || 'DBK.DE'}.\n\nThe scheme adds £${t.monthlyGbp} on the first business day of each month, priced as at five years earlier. Set the number here after a dividend or a sale.`, String(t.shares));
if (now === null) return;
const n = Number(now);
if (!Number.isFinite(n) || n < 0) return;
t.shares = n;
// Counted from today, so entering a corrected number doesn't replay
// purchases that number already includes.
t.sharesAt = iso(new Date());
queueSave();
renderTicker();
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
try {
if (item.kind === 'fx') await fetchFx(item);
else if (item.kind === 'quote') await fetchQuote(item);
else if (item.kind === 'weather') await fetchWeather(item);
else if (item.kind === 'sonia') await fetchSonia();
// Any previous failure is cleared by a success, so a tile that has
// started working stops apologising for yesterday.
if (cache()[key]) delete cache()[key].error;
} catch (err) {
console.error(`Ticker: ${key} failed:`, err);
// A tile that simply vanishes is the worst of both worlds: you can
// see something is missing but not what, and the console is not
// where you were looking. The message is kept and shown.
const existing = cache()[key] || {};
cache()[key] = { ...existing, error: err.message || String(err), erroredAt: new Date().toISOString() };
queueSave();
}
}));
try { await accrueShares(); } catch (err) { console.error('Ticker: share accrual failed:', err); }
renderTicker();
}

function initTicker() {
if (!document.getElementById('ticker')) return;
renderTicker();
// After first paint and the initial document pull, like the scheduled
// syncs: a fetch into a half-loaded app just fails and caches nothing.
setTimeout(() => refreshTicker(), 3000);
// The strip's width decides whether it rolls, so a rotated phone or a
// resized window has to be re-measured.
let t = null;
window.addEventListener('resize', () => {
clearTimeout(t);
t = setTimeout(() => startRolling(document.getElementById('ticker')), 200);
});
}

export { initTicker, renderTicker, refreshTicker, accrueShares, geocode, CURRENCY, labelFor };
