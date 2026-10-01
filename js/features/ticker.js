// The strip across the top of Overview: five numbers you want at a glance
// and would otherwise open five tabs for.
//
// WHERE EACH ONE COMES FROM, and why it matters: two of the four feeds
// answer a browser directly and two do not, which decides what works
// before the home agent is deployed.
//
//   GBP/EUR   Frankfurter (ECB daily)      direct, CORS open
//   Weather   Open-Meteo                   direct, CORS open
//   DBK.DE    Yahoo's chart endpoint       needs the proxy, no CORS
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
import { data, queueSave } from '../state.js';
import { escapeHtml } from '../utils.js';

// A feed is re-fetched when its cached answer is older than this. FX and
// the swap rate are published once a day, so the floor is about not
// hammering them on every tab switch rather than about freshness.
const MAX_AGE_MS = 30 * 60 * 1000;
const DBK = 'DBK.DE';

function cache() {
if (!data.tickerCache || typeof data.tickerCache !== 'object') data.tickerCache = {};
return data.tickerCache;
}

function fresh(key) {
const hit = cache()[key];
if (!hit || !hit.at) return null;
return Date.now() - new Date(hit.at).getTime() < MAX_AGE_MS ? hit : null;
}

function store(key, value) {
cache()[key] = { ...value, at: new Date().toISOString() };
queueSave();
return cache()[key];
}

// ---- The feeds ------------------------------------------------------------

async function viaProxy(url, referer = '') {
const { fetchPageHtml } = await import('../files.js');
return fetchPageHtml(url, referer ? { referer } : {});
}

// GBP/EUR, today and a month ago. Frankfurter is the ECB's daily fixing,
// so a weekend or a bank holiday returns the previous working day rather
// than nothing -- which is why the response carries its own date and the
// tile shows it.
async function fetchFx() {
const cached = fresh('fx');
if (cached) return cached;
const today = await (await fetch('https://api.frankfurter.dev/v1/latest?base=GBP&symbols=EUR')).json();
const prevDay = await (await fetch(`https://api.frankfurter.dev/v1/${backDays(1)}..?base=GBP&symbols=EUR`)).json();
const monthAgo = await (await fetch(`https://api.frankfurter.dev/v1/${backMonths(1)}?base=GBP&symbols=EUR`)).json();
const rates = prevDay.rates || {};
const dates = Object.keys(rates).sort();
// The last date BEFORE today's, so a run before the ECB publishes
// doesn't compare today with itself and report no change.
const prior = dates.filter((d) => d < today.date).pop();
return store('fx', {
value: today.rates.EUR,
date: today.date,
prevDay: prior ? rates[prior].EUR : null,
prevMonth: (monthAgo.rates || {}).EUR ?? null,
});
}

// Yahoo's chart endpoint, which carries the previous close and a month of
// daily closes in one call -- enough for both changes without a second
// request.
async function fetchDbk() {
const cached = fresh('dbk');
if (cached) return cached;
const raw = await viaProxy(`https://query1.finance.yahoo.com/v8/finance/chart/${DBK}?range=1mo&interval=1d`);
const body = JSON.parse(raw);
const result = ((body.chart || {}).result || [])[0];
if (!result) throw new Error('Yahoo returned no data for ' + DBK);
const meta = result.meta || {};
const closes = (((result.indicators || {}).quote || [])[0] || {}).close || [];
const known = closes.filter((c) => typeof c === 'number');
return store('dbk', {
value: meta.regularMarketPrice,
currency: meta.currency || 'EUR',
// chartPreviousClose is the close before the range started, so the
// previous DAY is the second-to-last point in the series itself.
prevDay: known.length > 1 ? known[known.length - 2] : meta.chartPreviousClose ?? null,
prevMonth: known.length ? known[0] : null,
});
}

// WMO codes grouped to the handful of pictures worth drawing, with a
// word kept for the tooltip and for anyone reading with a screen reader.
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
async function fetchWeather() {
const cached = fresh('weather');
if (cached) return cached;
const url = 'https://api.open-meteo.com/v1/forecast?latitude=51.5074&longitude=-0.1278'
+ '&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max'
+ '&hourly=weather_code&forecast_days=1&timezone=Europe%2FLondon';
const body = await (await fetch(url)).json();
const d = body.daily || {};
const hours = (body.hourly || {}).time || [];
const codes = (body.hourly || {}).weather_code || [];
const at = (hh) => {
const i = hours.findIndex((h) => h.slice(11, 13) === hh);
return i >= 0 ? codes[i] : null;
};
return store('weather', {
max: (d.temperature_2m_max || [])[0],
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
// Chatham's field names are from its own page's point of view:
// "PreviousDay" is the rate as last published, i.e. the current one.
// So the feed gives a month and a year back but nothing to compute a
// DAILY move from -- we keep that ourselves, carrying the last value
// across whenever the calendar date changes. It means the day column is
// blank until the strip has seen two days, which is honest; the
// alternative was labelling the month-old rate as yesterday's.
const previous = cache().sonia;
const value = Number(two.PreviousDay);
const sameDay = previous && previous.at && previous.at.slice(0, 10) === new Date().toISOString().slice(0, 10);
return store('sonia', {
value,
prevDay: sameDay ? (previous.prevDay ?? null) : (previous ? previous.value : null),
prevMonth: Number(two.PreviousMonth),
prevYear: Number(two.PreviousYear),
via,
});
}

// ---- The share scheme -----------------------------------------------------

function iso(d) { return d.toISOString().slice(0, 10); }
function backDays(n) { const d = new Date(); d.setDate(d.getDate() - n - 6); return iso(d); }
function backMonths(n) { const d = new Date(); d.setMonth(d.getMonth() - n); return iso(d); }

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
function tile(label, value, change, title, { href = '', edit = false } = {}) {
const attrs = `class="tick" title="${escapeHtml(title || '')}"`;
const inner = `<span class="tick-label">${escapeHtml(label)}</span>
<span class="tick-value">${value}</span>
${change || ''}`;
if (href) return `<a ${attrs} href="${escapeHtml(href)}" target="_blank" rel="noopener">${inner}</a>`;
return `<span ${attrs}${edit ? ' data-ticker-edit="1"' : ''}>${inner}</span>`;
}



// Where each figure came from, for the click-through. Frankfurter and
// Open-Meteo are the feeds, but neither is somewhere you'd want to land —
// these are the pages a person would actually read.
const SOURCE = {
fx: 'https://www.xe.com/currencycharts/?from=GBP&to=EUR',
dbk: 'https://finance.yahoo.com/quote/DBK.DE',
sonia: 'https://cf.com/rates/europe/sonia-swaps/historical-rates',
weather: 'https://www.bbc.co.uk/weather/2643743',
};

function renderTicker() {
const el = document.getElementById('ticker');
if (!el) return;
const t = data.ticker;
const c = cache();
const monthly = t.mode === 'month';
const pick = (hit) => (monthly ? hit.prevMonth : hit.prevDay);
const tiles = [];

if (c.fx) {
tiles.push(tile('GBP/EUR', c.fx.value ? c.fx.value.toFixed(4) : '—',
changeHtml(c.fx.value, pick(c.fx)),
`ECB fixing for ${c.fx.date}, via Frankfurter.`,
{ href: SOURCE.fx }));
}
if (c.dbk) {
tiles.push(tile('DBK', c.dbk.value ? `€${c.dbk.value.toFixed(2)}` : '—',
changeHtml(c.dbk.value, pick(c.dbk)),
'Deutsche Bank, XETRA, via Yahoo Finance.',
{ href: SOURCE.dbk }));
}
if (c.fx && c.dbk && t.shares) {
// Shares are priced in euros and you think in pounds, so the holding
// is converted at today's rate rather than at what it cost.
const gbp = (t.shares * c.dbk.value) / c.fx.value;
const prevGbp = pick(c.dbk) && pick(c.fx) ? (t.shares * pick(c.dbk)) / pick(c.fx) : null;
tiles.push(tile('Holding', `£${Math.round(gbp).toLocaleString('en-GB')}`,
changeHtml(gbp, prevGbp),
`${t.shares.toFixed(2)} DBK shares at €${c.dbk.value.toFixed(2)}, converted at ${c.fx.value.toFixed(4)}.`
+ (t.lastBuy ? ` Last added ${t.lastBuy.shares.toFixed(2)} on ${t.lastBuy.on}, priced at €${t.lastBuy.price.toFixed(2)} (${t.lastBuy.paidOn}).` : '')
+ ' Click to set the count.',
{ edit: true }));
}
if (c.sonia) {
tiles.push(tile('2y SONIA', `${c.sonia.value.toFixed(3)}%`,
// A swap rate moves in basis points, so a percentage change of a
// percentage reads as nonsense -- this one shows the points.
changeHtml(c.sonia.value, monthly ? c.sonia.prevMonth : c.sonia.prevDay, { points: true }),
`2-year SONIA swap, Chatham Financial${c.sonia.via === 'agent' ? ', via the home agent' : ''}. A month ago ${c.sonia.prevMonth}%, a year ago ${c.sonia.prevYear}%.`,
{ href: SOURCE.sonia }));
}
if (c.weather) {
// Two pictures rather than a word: the afternoon and the evening are
// often different days as far as a coat is concerned.
const day = weatherIcon(c.weather.dayCode ?? c.weather.code);
const night = weatherIcon(c.weather.nightCode ?? c.weather.code, { night: true });
tiles.push(tile('London', `${Math.round(c.weather.max)}° / ${Math.round(c.weather.min)}°`,
`<span class="tick-flat tick-wx">${day}${night}${c.weather.rain >= 20 ? ` ${c.weather.rain}%` : ''}</span>`,
`High ${Math.round(c.weather.max)}°, low ${Math.round(c.weather.min)}°. `
+ `Afternoon ${weatherWord(c.weather.dayCode ?? c.weather.code).toLowerCase()}, `
+ `evening ${weatherWord(c.weather.nightCode ?? c.weather.code).toLowerCase()}, `
+ `${c.weather.rain}% chance of rain.`,
{ href: SOURCE.weather }));
}

el.innerHTML = tiles.length
? `${tiles.join('')}<button class="tick-toggle" type="button" id="ticker-mode" title="Switch between change since yesterday and since a month ago">${monthly ? 'month' : 'day'}</button>`
: '';

el.querySelector('#ticker-mode')?.addEventListener('click', () => {
data.ticker.mode = monthly ? 'day' : 'month';
queueSave();
renderTicker();
});
el.querySelector('[data-ticker-edit]')?.addEventListener('click', editShares);
}
function editShares() {
const t = data.ticker;
const now = prompt(`DBK shares held.\n\nThe scheme adds £${t.monthlyGbp} on the first business day of each month, priced as at five years earlier. Set the number here after a dividend or a sale.`, String(t.shares));
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

// Each feed is independent: one failing should cost you the other four,
// not the strip. A failure leaves the previous cached answer on screen,
// which is why the tiles carry their own date rather than implying "now".
async function refreshTicker({ force = false } = {}) {
if (force) data.tickerCache = {};
const jobs = [['fx', fetchFx], ['dbk', fetchDbk], ['weather', fetchWeather], ['sonia', fetchSonia]];
await Promise.all(jobs.map(async ([name, fn]) => {
try { await fn(); } catch (err) { console.error(`Ticker: ${name} failed:`, err); }
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
}

export { initTicker, renderTicker, refreshTicker, accrueShares };
