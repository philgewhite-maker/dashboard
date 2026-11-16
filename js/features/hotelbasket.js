// Hotel reference prices (PRICING-PLAN.md phase 6, section F).
//
// Two baskets of named hotels near SE1 are sampled weekly through the NAS page renderer (home-agent `page.render`,
// via js/homeagent.js) for stays 7/30/60/90/180/270/350 days ahead, a weekday night (Wed) and a weekend night (Sat)
// each. Every attempt is stored in data.hotelPrices (blankHotelPrice in state.js), failures included, so a hotel that
// stops working is visible rather than silently missing. basketReference(room, date) turns the latest samples into one
// reference price for a date (median across hotels, interpolated between sample dates); it is NOT used by the booking
// model yet (that is a later model change).
//
// Assumption for every hotel: 1 night, 1 room, 2 adults, cheapest bookable room type for the dates (the lowest "from"
// price, which for the chains is a non-flexible/saver rate). Price is the per-night total in GBP as shown. How each
// hotel's extraction was proved (16 Nov 2026, through the claude-test channel) is in the HOTELS table below.
import { data, queueSave, blankHotelPrice } from '../state.js';
import { escapeHtml, todayStr, dateStrAdd } from '../utils.js';
import { isConfigured } from '../sync/selfhost.js';
import { run, agentHeartbeat } from '../homeagent.js';

const OFFSETS = [7, 30, 60, 90, 180, 270, 350];
const WEEKDAY_DOW = 3; // Wednesday
const WEEKEND_DOW = 6; // Saturday
const WEEKLY_MS = 7 * 86400000;
const ATTEMPT_GAP_MS = 20 * 3600000; // at most one automatic attempt a day
const RENDER_GAP_MS = 6000; // pause between one hotel page and the next
const CONCURRENCY = 2;
const KEEP_DAYS = 120;
const FAR_AHEAD_DAYS = 150; // beyond this, hotels often show placeholder rack rates
const RENDER_TIMEOUT_MS = 120000;
const ATTEMPT_KEY = 'hotelBasketLastAttempt';

const pad = (n) => String(n).padStart(2, '0');
const parts = (iso) => { const [y, m, d] = iso.split('-').map(Number); return { y, m, d }; };
const money0 = (n) => `£${Math.round(n).toLocaleString('en-GB')}`;
const dow = (iso) => new Date(`${iso}T00:00:00`).getDay();
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00`) - new Date(`${a}T00:00:00`)) / 86400000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dayOf = (iso) => String(iso || '').slice(0, 10);

const PREMIER = 'https://www.premierinn.com/gb/en/hotels/england/greater-london/london';
const premierUrl = (slug) => (ci) => { const p = parts(ci); return `${PREMIER}/${slug}.html?ARRdd=${pad(p.d)}&ARRmm=${pad(p.m)}&ARRyyyy=${p.y}&NIGHTS=1&ROOMS=1&ADULT1=2&CHILD1=0&COT1=0&INTTYP1=DB`; };
// Premier Inn hotel page: every rate is a `data-testid="pence-price-integer"` span (the £ is a separate span). The
// cheapest of them is the "from" price (the non-refundable Standard rate of the cheapest room).
const PREMIER_EXTRACT = [String.raw`data-testid="pence-price-integer"[^>]*>\d+<`];
function parsePremier(html) {
const prices = [...html.matchAll(/data-testid="pence-price-integer"[^>]*>(\d+)</g)].map((m) => Number(m[1]));
return prices.length ? Math.min(...prices) : null;
}

// basket: 'double' = budget (the Double), 'ensuite' = mid-scale (the en-suites).
// status 'blocked' = proven NOT to work (so not guessed at): the sampler skips it and it counts as a failure for the
// "two failed" fallback.
const HOTELS = [
{
id: 'travelodge-bermondsey', name: 'Travelodge London Bermondsey', basket: 'double', home: 'https://www.travelodge.co.uk/hotels/705/London-Bermondsey-hotel',
// Hotel id 705 / code GB2060 (from travelodge.co.uk/sitemap-general.xml). The /ocb/ booking URL honours dates and goes
// straight to a basket with the default cheapest Saver double/twin; the page carries `'basketRoomPrice': '119.99'`.
url: (ci) => { const p = parts(ci); const n = parts(dateStrAdd(ci, 1)); return `https://www.travelodge.co.uk/ocb/GB2060?checkIn=${pad(p.d)}/${pad(p.m)}/${p.y}&checkOut=${pad(n.d)}/${pad(n.m)}/${n.y}&rooms%5B0%5D%5Badults%5D=2`; },
extract: [String.raw`'basketRoomPrice':\s*'\d+(?:\.\d+)?'`],
parse: (html) => { const m = html.match(/'basketRoomPrice':\s*'(\d+(?:\.\d+)?)'/); return m ? Number(m[1]) : null; },
},
{
id: 'premierinn-tower-bridge', name: 'Premier Inn London Tower Bridge', basket: 'double', home: `${PREMIER}/london-tower-bridge.html`,
url: premierUrl('london-tower-bridge'), extract: PREMIER_EXTRACT, parse: parsePremier,
},
{
id: 'premierinn-southwark-borough', name: 'Premier Inn London Southwark (Borough High St)', basket: 'double', home: `${PREMIER}/london-southwark-borough-high-st.html`,
url: premierUrl('london-southwark-borough-high-st'), extract: PREMIER_EXTRACT, parse: parsePremier,
},
{
id: 'premierinn-southwark-bankside', name: 'Premier Inn London Southwark (Bankside)', basket: 'double', home: `${PREMIER}/london-southwark-bankside.html`,
url: premierUrl('london-southwark-bankside'), extract: PREMIER_EXTRACT, parse: parsePremier,
},
{
id: 'bermondsey-square', name: 'The Bermondsey Square Hotel', basket: 'ensuite', home: 'https://www.bermondseysquarehotel.co.uk/',
// Avvio booking engine behind the hotel's own site (URL shape from its booking-panel-v2.js). The page lists every room
// with a 7-day strip of nightly prices, "16 Dec 2026 &nbsp; GBP211"; the cheapest room's price for the arrival date is
// the minimum of the matches for that date.
url: (ci) => { const p = parts(ci); return `https://secure.bermondseysquarehotel.co.uk/convert/site/Bermondsey%20Square%20Hotel%20London/en/results.php?av=search&checkin=${p.y}-${p.m}-${p.d}&nights=1`; },
extract: [String.raw`\d{1,2} [A-Z][a-z]{2,3} \d{4}(?:\s|&nbsp;)*GBP\d+(?:\.\d+)?`],
parse: (html, ci) => {
const p = parts(ci);
const mon = new Date(`${ci}T00:00:00`).toLocaleDateString('en-GB', { month: 'short' });
const re = new RegExp(`(?<!\\d)${p.d} ${mon} ${p.y}(?:\\s|&nbsp;)*GBP(\\d+(?:\\.\\d+)?)`, 'g');
const prices = [...html.matchAll(re)].map((m) => Number(m[1]));
return prices.length ? Math.min(...prices) : null;
},
},
{
id: 'london-bridge-hotel', name: 'London Bridge Hotel', basket: 'ensuite', home: 'https://www.londonbridgehotel.com/',
status: 'blocked', blockedReason: 'Its booking engine (bookings.londonbridgehotel.com) renders a date picker that ignored the date parameters tried, so no per-night price could be read.',
url: () => '', parse: () => null,
},
{
id: 'residence-inn-london-bridge', name: 'Residence Inn by Marriott London Bridge', basket: 'ensuite', home: 'https://www.marriott.com/en-gb/hotels/lonri-residence-inn-london-bridge/overview/',
status: 'blocked', blockedReason: 'marriott.com reservation pages answer Access Denied to the renderer; the hotel pages render but show no prices.',
url: () => '', parse: () => null,
},
{
id: 'residence-inn-london-tower-bridge', name: 'Residence Inn by Marriott London Tower Bridge', basket: 'ensuite', home: 'https://www.marriott.com/en-gb/hotels/lonbd-residence-inn-london-tower-bridge/overview/',
status: 'blocked', blockedReason: 'Same Marriott block as the London Bridge Residence Inn (property code LONBD).',
url: () => '', parse: () => null,
},
{
id: 'locke-bermonds', name: 'Bermonds Locke', basket: 'ensuite', home: 'https://www.lockeliving.com/en/london/bermonds-locke/your-stay/city-studio',
// Checked 16 Nov 2026 through claude-test. Locke books through Mews (property/configuration id
// fff9828e-f506-45c8-837a-ab51009c36f7); app.mews.com/distributor/<id>?mewsStart=YYYY-MM-DD&mewsEnd=YYYY-MM-DD&mewsAdultCount=2
// honours the dates, but the booking app draws itself into a same-origin iframe written with document.write, which the
// renderer's page serialisation leaves out (body is an empty iframe + cookie banner, no price text), and the prices
// come from a POST GraphQL API (booking-engine.services.mews.com/graphql) that page.render/page.fetch cannot call. The
// lockeliving.com room page itself carries no dated price. Revisit if the renderer can read child frames.
status: 'blocked', blockedReason: 'Locke books through Mews, whose booking app renders inside an iframe the page renderer does not capture, and the prices come from a POST-only API, so no dated nightly price can be read.',
url: () => '', parse: () => null,
},
];
const BASKET_TEXT = { double: 'Budget hotels nearby', ensuite: 'Mid-scale hotels nearby' };
const hotelById = (id) => HOTELS.find((h) => h.id === id);
const activeHotels = () => HOTELS.filter((h) => h.status !== 'blocked');

// Which basket a room is compared with: the Double against budget hotels, the en-suites against mid-scale.
function basketOfRoom(room) {
const r = room || {};
return /double/i.test(`${r.label || ''} ${r.key || ''}`) ? 'double' : 'ensuite';
}

// ---- Sample dates -------------------------------------------------------------------------------------
function nextDow(from, wanted) { let d = from; while (dow(d) !== wanted) d = dateStrAdd(d, 1); return d; }
function samplePoints(today = todayStr()) {
const out = [];
OFFSETS.forEach((n) => {
const base = dateStrAdd(today, n);
out.push({ offset: n, checkin: nextDow(base, WEEKDAY_DOW), kind: 'weekday' });
out.push({ offset: n, checkin: nextDow(base, WEEKEND_DOW), kind: 'weekend' });
});
return out;
}

// ---- Store ---------------------------------------------------------------------------------------------
function storeSample(rec) {
if (!Array.isArray(data.hotelPrices)) data.hotelPrices = [];
const i = data.hotelPrices.findIndex((r) => r.id === rec.id);
if (i >= 0) data.hotelPrices[i] = rec; else data.hotelPrices.push(rec);
}
function prune() {
const cut = dateStrAdd(todayStr(), -KEEP_DAYS);
data.hotelPrices = (data.hotelPrices || []).filter((r) => r.checkin >= cut && hotelById(r.hotel));
}
const lastSampledAt = () => (data.hotelPrices || []).reduce((m, r) => (r.sampledAt > m ? r.sampledAt : m), '');

// The newest attempt for each hotel + check-in date.
function latestSamples() {
const best = new Map();
(data.hotelPrices || []).forEach((r) => { const k = `${r.hotel}|${r.checkin}`; const b = best.get(k); if (!b || r.sampledAt > b.sampledAt) best.set(k, r); });
return [...best.values()];
}

// ---- Sampling run ----------------------------------------------------------------------------------------
let running = false;
let progress = '';
const listeners = new Set();
const notify = () => listeners.forEach((f) => { try { f(); } catch (e) { /* a panel that is gone */ } });

function attemptedRecently() { try { const t = Number(localStorage.getItem(ATTEMPT_KEY)); return !!t && Date.now() - t < ATTEMPT_GAP_MS; } catch (e) { return false; } }
function markAttempt() { try { localStorage.setItem(ATTEMPT_KEY, String(Date.now())); } catch (e) { /* private window */ } }

async function sampleOne(hotel, point, sampledAt) {
const rec = blankHotelPrice({ id: `${hotel.id}:${point.checkin}:${dayOf(sampledAt)}`, hotel: hotel.id, basket: hotel.basket, checkin: point.checkin, sampledAt });
// `extract` (agent 1.16+): only the matching snippets come back, never the ~0.8 MB page, which would otherwise sit in
// commands.php's single queue file for a day (84 pages a run). sampleNow refuses to run on an older agent.
const res = await run('page.render', { urls: [hotel.url(point.checkin)], extract: hotel.extract || [] }, { timeoutMs: RENDER_TIMEOUT_MS });
const page = ((res && res.pages) || [])[0];
if (!page || page.error || !Array.isArray(page.matches)) { rec.error = (page && page.error) || 'the renderer returned no page'; return rec; }
if (/Access Denied/i.test(page.title || '')) { rec.error = 'the hotel site refused the renderer (Access Denied)'; return rec; }
const price = hotel.parse(page.matches.join(' | '), point.checkin);
if (price == null || !(price > 0)) { rec.error = 'no price on the page (sold out for that night, or the page layout changed)'; return rec; }
rec.price = price; rec.ok = true;
return rec;
}

// Sample every active hotel at every point. Two pages in flight at most, a pause after each, and a hard stop if the agent
// itself is unreachable (nothing is stored for that: a dead agent is not a hotel failing).
async function sampleNow() {
if (running) return { skipped: 'already running' };
if (!(await isConfigured())) return { error: 'Live sync is not set up, so the home agent cannot be reached.' };
running = true; progress = 'Checking the home agent…'; notify();
markAttempt();
try {
const beat = await agentHeartbeat();
if (!beat) return { error: 'The home agent has not been seen recently, so nothing was sampled.' };
const [maj, min] = String(beat.version || '0').split('.').map(Number);
if (!(maj > 1 || (maj === 1 && min >= 16))) return { error: `The home agent is version ${beat.version || 'unknown'}; hotel sampling needs 1.16 (it sends back only the prices, not whole pages). Update the agent on the NAS.` };
const sampledAt = new Date().toISOString();
const points = samplePoints();
const jobs = [];
activeHotels().forEach((h) => points.forEach((p) => jobs.push([h, p])));
const total = jobs.length;
let done = 0; let okCount = 0; let fatal = null;
const worker = async () => {
while (jobs.length && !fatal) {
const [h, p] = jobs.shift();
try {
const rec = await sampleOne(h, p, sampledAt);
storeSample(rec); if (rec.ok) okCount++;
} catch (err) { fatal = err; return; }
done++; progress = `Sampling hotel prices… ${done} of ${total}`; notify();
queueSave();
await sleep(RENDER_GAP_MS);
}
};
await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => sleep(i * 2000).then(worker)));
prune(); queueSave();
if (fatal) return { error: `Stopped after ${done} pages: ${fatal.message || fatal}`, done, okCount };
return { done, okCount };
} catch (err) {
return { error: err.message || String(err) };
} finally {
running = false; progress = ''; notify();
}
}

// Weekly: when the newest sample is over 7 days old (or there is none), the agent is configured, and no attempt has been
// made in the last day.
async function maybeSample() {
if (running || attemptedRecently()) return;
const last = lastSampledAt();
if (last && Date.now() - new Date(last).getTime() < WEEKLY_MS) return;
if (!(await isConfigured())) return;
await sampleNow();
}
let started = false;
function initHotelBasket() {
if (started) return;
started = true;
setTimeout(() => { maybeSample().catch((err) => console.error('Hotel basket sampling failed:', err)); }, 30000);
}

// ---- Reference price -------------------------------------------------------------------------------------
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const isWeekendNight = (iso) => dow(iso) === 5 || dow(iso) === 6; // Fri, Sat nights

// One hotel's price for `date`: its samples of the same kind of night (weekend or weekday), linearly interpolated by
// date between the two sample dates either side; outside the sampled range the nearest sample stands (extrapolated).
function hotelPriceAt(samples, date) {
const wk = isWeekendNight(date);
const pts = samples.filter((s) => isWeekendNight(s.checkin) === wk).sort((a, b) => (a.checkin < b.checkin ? -1 : 1));
if (!pts.length) return null;
const exact = pts.find((p) => p.checkin === date);
if (exact) return { price: exact.price, extrapolated: false };
const before = [...pts].reverse().find((p) => p.checkin < date);
const after = pts.find((p) => p.checkin > date);
if (before && after) {
const t = daysBetween(before.checkin, date) / daysBetween(before.checkin, after.checkin);
return { price: before.price + (after.price - before.price) * t, extrapolated: false };
}
return { price: (before || after).price, extrapolated: true };
}

// The reference for a room and night: {price, hotels:[{id,name,price}], farAhead, extrapolated, sampledAt} or null when
// fewer than 2 hotels of its basket have a price (then the caller shows "hotel prices unavailable" and carries on).
// `room` is {key,label}, or a basket name ('double' | 'ensuite').
function basketReference(room, date) {
const basket = typeof room === 'string' && BASKET_TEXT[room] ? room : basketOfRoom(typeof room === 'string' ? { key: room } : room);
const today = todayStr();
const ok = latestSamples().filter((s) => s.ok && s.basket === basket && s.price > 0 && s.checkin >= today);
const perHotel = [];
HOTELS.filter((h) => h.basket === basket && h.status !== 'blocked').forEach((h) => {
const at = hotelPriceAt(ok.filter((s) => s.hotel === h.id), date);
if (at) perHotel.push({ id: h.id, name: h.name, price: at.price, extrapolated: at.extrapolated });
});
if (perHotel.length < 2) return null;
const sampledAt = ok.reduce((m, s) => (s.sampledAt > m ? s.sampledAt : m), '');
return {
basket, price: median(perHotel.map((h) => h.price)), hotels: perHotel,
farAhead: daysBetween(today, date) >= FAR_AHEAD_DAYS, extrapolated: perHotel.some((h) => h.extrapolated), sampledAt,
};
}

// The basket has no usable reference because fewer than 2 of its hotels have a price (blocked, failing, or never sampled).
function basketStatus(basket) {
const hs = HOTELS.filter((h) => h.basket === basket);
const sampled = (data.hotelPrices || []).some((r) => r.basket === basket);
const today = todayStr();
const latest = latestSamples();
const withPrice = hs.filter((h) => latest.some((s) => s.hotel === h.id && s.ok && s.checkin >= today));
return { hotels: hs.length, withPrice: withPrice.length, sampled, unavailable: withPrice.length < 2 };
}

// ---- Text for the price breakdown ----------------------------------------------------------------------------
// "Budget hotels nearby: £134 (Double is 82% of that)". `ours` is the room's current asking price for that night.
function referenceLine(room, date, ours) {
const basket = basketOfRoom(room);
const ref = basketReference(room, date);
if (!ref) return basketStatus(basket).sampled ? 'hotel prices unavailable' : 'hotel prices not sampled yet';
const pct = ours > 0 ? ` (${room.label || 'This room'} is ${Math.round((ours / ref.price) * 100)}% of that)` : '';
const caveat = ref.farAhead ? ' Far-ahead hotel rates are often placeholder rack rates.' : '';
const extra = ref.extrapolated ? ' Beyond the sampled dates: nearest sample used.' : '';
return `${BASKET_TEXT[basket]}: ${money0(ref.price)}${pct}. Median of ${ref.hotels.length} hotels.${caveat}${extra}`;
}

// ---- Panel (shown inside the price breakdown) ------------------------------------------------------------------
function panelHtml() {
const today = todayStr();
const latest = latestSamples();
const rows = HOTELS.map((h) => {
const mine = latest.filter((s) => s.hotel === h.id && s.checkin >= today);
const okS = mine.filter((s) => s.ok).sort((a, b) => (a.checkin < b.checkin ? -1 : 1));
const lastErr = mine.filter((s) => !s.ok).sort((a, b) => (a.sampledAt < b.sampledAt ? 1 : -1))[0];
let state;
if (h.status === 'blocked') state = `<span class="settings-note" style="margin:0;">not sampled: ${escapeHtml(h.blockedReason)}</span>`;
else if (!mine.length) state = '<span class="settings-note" style="margin:0;">not sampled yet</span>';
else state = `${okS.length} of ${mine.length} dates priced${okS.length ? `, nearest ${money0(okS[0].price)} on ${new Date(`${okS[0].checkin}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}${lastErr ? `<span class="settings-note" style="margin:0;"> · latest failure: ${escapeHtml(lastErr.error)}</span>` : ''}`;
return `<tr><td><a href="${escapeHtml(h.home)}" target="_blank" rel="noopener">${escapeHtml(h.name)}</a></td><td>${h.basket === 'double' ? 'Budget (Double)' : 'Mid-scale (en-suites)'}</td><td>${state}</td></tr>`;
}).join('');
const last = lastSampledAt();
const lastTxt = last ? new Date(last).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'never';
const warn = ['double', 'ensuite'].filter((b) => { const s = basketStatus(b); return s.sampled && s.unavailable; }).map((b) => `${BASKET_TEXT[b]}: hotel prices unavailable.`).join(' ');
return `<details class="pb-hotels" id="hb-details"><summary>Hotel reference prices (last sampled ${escapeHtml(lastTxt)})</summary>
<div class="settings-note">Sampled weekly through the home agent: 1 night, 1 room, 2 adults, the cheapest bookable room, for stays 7 to 350 days ahead, a Wednesday and a Saturday night each. ${warn ? `<strong>${escapeHtml(warn)}</strong>` : ''}</div>
<div class="pb-table-wrap"><table class="pb-table"><thead><tr><th>Hotel</th><th>Basket</th><th>Latest samples</th></tr></thead><tbody>${rows}</tbody></table></div>
<div class="sync-row" style="align-items:center;flex-wrap:wrap;gap:8px;"><button type="button" class="sync-btn sm inline" id="hb-sample">Sample now</button><span class="sync-status" id="hb-status">${escapeHtml(progress)}</span></div>
</details>`;
}
function bindPanel(root, onChange) {
if (!root || root.dataset.hbBound) return;
root.dataset.hbBound = '1';
const refresh = () => {
if (!root.isConnected) return;
const d = root.querySelector('#hb-details');
if (!d) return;
if (running) { const st = root.querySelector('#hb-status'); if (st) st.textContent = progress; return; } // mid-run: only the progress line moves
const open = d.open; const holder = document.createElement('div'); holder.innerHTML = panelHtml();
d.replaceWith(holder.firstElementChild); root.querySelector('#hb-details').open = open;
if (onChange) onChange();
};
listeners.add(refresh);
root.addEventListener('click', async (e) => {
const btn = e.target.closest('#hb-sample');
if (!btn) return;
btn.disabled = true;
const res = await sampleNow();
const st = root.querySelector('#hb-status');
if (st) st.textContent = res.error ? res.error : res.skipped ? 'A sampling run is already in progress.' : `Done: ${res.okCount} of ${res.done} pages priced.`;
const b2 = root.querySelector('#hb-sample'); if (b2) b2.disabled = false;
});
}

export { initHotelBasket, sampleNow, maybeSample, basketReference, basketOfRoom, basketStatus, referenceLine, samplePoints, panelHtml, bindPanel, HOTELS, hotelPriceAt };
