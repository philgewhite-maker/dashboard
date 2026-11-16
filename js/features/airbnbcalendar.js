// Phase 7 groundwork (PRICING-PLAN.md): read the owner's real Airbnb host-calendar prices into the price ledger.
//
// What the Airbnb month grid exposes (read live 16 Nov 2026, ES-Phil listing; Double and ES-Lewis not read, see below):
//   * The page loads its days with a persisted GET to /api/v3/getDLSHostCalendar/<hash> (variables: listingId as base64
//     "StayListing:<id>", startDate, endDate, hostCalendarViewType MONTH_VIEW, lensTypes NOTE/PRICE/PROMOTION). It loads
//     a ~3 month window first (30 Sep to 31 Dec 2026) and fetches more as the grid is scrolled.
//   * The grid is a virtualised list (data-testid "virtuoso-scroller"): only ~3 months are in the DOM, and NOTHING renders
//     while the tab is in the background. The days are <button id="date-YYYY-MM-DD"> elements whose text is
//       "Friday 20 Nov | 20 | Unavailable | Nightly price | £145 | 3-night minimum[ and 20% off]"
//     (the minimum line only on days that have a per-date override; a promotion adds "and N% off"; holidays add a
//     label line). "Unavailable" is a visually-hidden span present on every day in that sample, so it is NOT a reliable
//     open/closed flag; it is passed through as `unavailable` and the importer does not use it.
// So extraction is done from the rendered DOM by a snippet run in the FOREGROUND calendar tab (below).

// The snippet. Written as a real function so it can be tested, then sent as text via .toString().
async function airbnbCalendarSnippet(months = 12) {
  const m = location.pathname.match(/multicalendar\/(\d+)/);
  const listingId = m ? m[1] : '';
  const sc = document.querySelector('[data-testid="virtuoso-scroller"]');
  if (!listingId || !sc) return JSON.stringify({ error: 'Open https://www.airbnb.co.uk/multicalendar/<listingId> in a visible tab first.' });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = new Date();
  const limit = new Date(now.getFullYear(), now.getMonth() + months + 1, 1).toISOString().slice(0, 10);
  const days = new Map();
  const grab = () => {
    let added = 0;
    document.querySelectorAll('button[id^="date-"]').forEach((b) => {
      const date = b.id.slice(5);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
      const lines = b.innerText.split('\n').map((s) => s.trim()).filter(Boolean);
      const text = lines.join(' | ');
      const price = (text.match(/Nightly price \| £([\d,]+(?:\.\d+)?)/) || [])[1];
      const prev = days.get(date);
      if (prev && prev.price != null) return;
      if (!prev) added++;
      days.set(date, {
        listingId,
        date,
        price: price ? Number(price.replace(/,/g, '')) : null,
        minStay: Number((text.match(/(\d+)-night minimum/) || [])[1]) || null,
        promoPct: Number((text.match(/(\d+)% off/) || [])[1]) || 0,
        unavailable: lines.includes('Unavailable'),
        available: !lines.includes('Unavailable'),
      });
    });
    return added;
  };
  sc.scrollTop = 0;
  await sleep(600);
  grab();
  let idle = 0;
  for (let i = 0; i < 400 && idle < 6; i++) {
    const before = sc.scrollTop;
    sc.scrollTop += 600;
    await sleep(450);
    idle = grab() ? 0 : idle + 1;
    const last = [...days.keys()].sort().pop();
    if (last >= limit || (sc.scrollTop === before && idle >= 2)) break;
  }
  const rows = [...days.values()].filter((d) => d.date >= now.toISOString().slice(0, 10) && d.date < limit).sort((a, b) => a.date.localeCompare(b.date));
  const json = JSON.stringify(rows);
  try { if (typeof copy === 'function') copy(json); } catch (e) { /* devtools-only helper */ }
  return json;
}
const AIRBNB_CALENDAR_SNIPPET = `(${airbnbCalendarSnippet.toString()})()`;

// ---- Importer ------------------------------------------------------------------------------------------------------
// Listing id -> evaluator room key: the same lookup the price breakdown uses (bookingsettings.evaluatorRooms(): a room
// owns the listingIds of the Airbnb listings that sell it).
async function roomKeyByListing() {
  const { evaluatorRooms } = await import('./bookingsettings.js');
  const map = new Map();
  evaluatorRooms().forEach((room) => room.listingIds.forEach((id) => map.set(String(id), room.key)));
  return map;
}

// jsonText: output of the snippet ([{listingId,date,price,minStay,promoPct}]) or {rows:[...]}.
// Consecutive nights with the same price and minimum nights go in as one setLedgerRange call. A night showing a promotion
// ("and 20% off") has its minimum recorded but not its price, because it is not known whether the figure shown is
// before or after the promotion. Returns {nights, created, changed, unchanged, promoSkipped, unmapped:[listingId], error}.
async function importAirbnbCalendar(jsonText, { roomKeys } = {}) {
  let rows;
  try { const j = JSON.parse(String(jsonText || '').trim()); rows = Array.isArray(j) ? j : j.rows; } catch (e) { return { error: 'That is not valid JSON.' }; }
  if (!Array.isArray(rows) || !rows.length) return { error: 'No rows found. Run the snippet on the Airbnb calendar page first.' };
  const { setLedgerRange } = await import('./priceledger.js');
  const map = roomKeys || (await roomKeyByListing());
  const out = { nights: 0, created: 0, changed: 0, unchanged: 0, promoSkipped: 0, unmapped: [] };
  const byRoom = new Map();
  rows.forEach((r) => {
    if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) return;
    const roomKey = map.get(String(r.listingId));
    if (!roomKey) { if (!out.unmapped.includes(String(r.listingId))) out.unmapped.push(String(r.listingId)); return; }
    if (!byRoom.has(roomKey)) byRoom.set(roomKey, []);
    byRoom.get(roomKey).push(r);
  });
  for (const [roomKey, list] of byRoom) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    let run = null;
    const flush = () => {
      if (!run) return;
      const f = { roomKey, from: run.from, to: run.to, source: 'airbnb-calendar' };
      if (run.price != null) f.price = run.price;
      if (run.minStay != null) f.minStay = run.minStay;
      if (f.price !== undefined || f.minStay !== undefined) {
        const res = setLedgerRange(f);
        if (res.error) { out.error = res.error; } else { out.nights += res.nights; out.created += res.created; out.changed += res.changed; out.unchanged += res.unchanged; }
      }
      run = null;
    };
    list.forEach((r) => {
      const promo = Number(r.promoPct) > 0;
      if (promo && r.price != null) out.promoSkipped++;
      const price = !promo && Number(r.price) > 0 ? Number(r.price) : null;
      const minStay = Number(r.minStay) >= 1 ? Number(r.minStay) : null;
      const next = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
      if (run && run.price === price && run.minStay === minStay && next(run.to) === r.date) run.to = r.date;
      else { flush(); run = { from: r.date, to: r.date, price, minStay }; }
    });
    flush();
  }
  return out;
}

function summaryText(res) {
  if (res.error) return res.error;
  const bits = [res.created && `${res.created} new`, res.changed && `${res.changed} changed`, res.unchanged && `${res.unchanged} already that`].filter(Boolean);
  let t = `${res.nights} night${res.nights === 1 ? '' : 's'} read from Airbnb: ${bits.join(', ') || 'nothing to record'}.`;
  if (res.promoSkipped) t += ` ${res.promoSkipped} promotion night${res.promoSkipped === 1 ? '' : 's'} kept their minimum only (price unclear).`;
  if (res.unmapped.length) t += ` Not a room in the evaluator: listing ${res.unmapped.join(', ')}.`;
  return t;
}

// The paste box, shown under the ledger entry form.
function airbnbImportHtml() {
  return `<div class="sync-row pl-form" id="pl-import" style="align-items:center;flex-wrap:wrap;gap:8px;margin-top:8px;">
<span class="settings-note" style="margin:0;">Read prices from Airbnb:</span>
<button type="button" class="sync-btn sm inline" id="pl-snip-copy" title="Copy the console snippet to run on an open Airbnb calendar page (it only reads)">Copy snippet</button>
<textarea id="pl-import-json" class="settings-input" rows="2" style="width:260px;" placeholder="Paste the snippet's JSON here"></textarea>
<button type="button" class="sync-btn sm inline" id="pl-import-btn" title="Record every night in the pasted JSON in the ledger">Import</button>
<span class="sync-status" id="pl-import-status"></span>
</div>`;
}

function bindAirbnbImport(root, onSaved) {
  root.addEventListener('click', async (e) => {
    const status = root.querySelector('#pl-import-status');
    const say = (t) => { if (status) status.textContent = t; };
    if (e.target.closest('#pl-snip-copy')) {
      try { await navigator.clipboard.writeText(AIRBNB_CALENDAR_SNIPPET); say('Snippet copied. Open the listing calendar in Airbnb, keep that tab in front, paste it in the console, then paste the result here.'); } catch (err) { say('Could not copy to the clipboard.'); }
      return;
    }
    if (!e.target.closest('#pl-import-btn')) return;
    const box = root.querySelector('#pl-import-json');
    say('Importing…');
    const res = await importAirbnbCalendar(box ? box.value : '');
    say(summaryText(res));
    if (!res.error && typeof onSaved === 'function') onSaved(res);
  });
}

export { importAirbnbCalendar, airbnbCalendarSnippet, AIRBNB_CALENDAR_SNIPPET, airbnbImportHtml, bindAirbnbImport };
