// Airbnb Superhost assessment, per listing owner (each owner is a separate Airbnb account).
//
// Airbnb reviews hosts quarterly (1 Jan, 1 Apr, 1 Jul, 1 Oct) over the previous 365 days:
//   * at least 10 completed stays, OR 3 stays totalling at least 100 nights
//   * overall rating 4.8 or higher
//   * response rate 90% or higher
//   * host cancellations under 1%
// Stays and ratings come from what the dashboard already holds: stays on file (airbnbReservations) plus older
// income-only ledger rows (lettingLedger). A guest rating is captured per stay (`reviewRating`); until one is
// entered a stay counts as 5 stars, and 0 means the guest left no review. Response rate and host cancellations
// aren't in any feed, so they're typed per owner (prefs.superhostByOwner).
//
// The maths (assessStays) is pure so it can be checked on its own; the rest is the Letting income display.

import { data, queueSave } from '../state.js';
import { escapeHtml, todayStr, dateStrAdd, scrollAndFlash } from '../utils.js';

export const SUPERHOST = { stays: 10, altStays: 3, altNights: 100, rating: 4.8, response: 90, cancelPct: 1, defaultRating: 5, windowDays: 365 };
const DAY = 86400000;
const QUARTERS_AHEAD = 5;

const days = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const fmtDate = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const star = (v) => (v == null ? '–' : `${v.toFixed(2)}★`);

// The next `n` assessment dates on or after `today`.
export function assessmentDates(today, n = QUARTERS_AHEAD) {
  let y = Number(today.slice(0, 4));
  const out = [];
  for (; out.length < n; y += 1) {
    for (const m of ['01', '04', '07', '10']) {
      const d = `${y}-${m}-01`;
      if (d >= today && out.length < n) out.push(d);
    }
  }
  return out;
}

// One assessment: the 365 days up to (not including) `assessOn`. A stay counts when it checks out in that window;
// stays with checkout after `today` are booked, not yet completed. `stays`: [{checkout, nights, rating}].
export function assessStays(stays, assessOn, today, { responseRate = 100, hostCancellations = 0 } = {}) {
  const from = dateStrAdd(assessOn, -SUPERHOST.windowDays);
  const inWin = stays.filter((s) => s.checkout >= from && s.checkout < assessOn);
  const booked = inWin.filter((s) => s.checkout > today).length;
  const count = inWin.length;
  const nights = inWin.reduce((n, s) => n + (s.nights || 0), 0);
  let sum = 0;
  let reviews = 0;
  let assumed = 0;
  inWin.forEach((s) => {
    if (s.rating === 0) return; // the guest left no review
    reviews += 1;
    if (s.rating == null) { assumed += 1; sum += SUPERHOST.defaultRating; } else sum += s.rating;
  });
  const avg = reviews ? sum / reviews : null;
  const cancelPct = count + hostCancellations > 0 ? (hostCancellations / (count + hostCancellations)) * 100 : 0;
  const staysOk = count >= SUPERHOST.stays || (count >= SUPERHOST.altStays && nights >= SUPERHOST.altNights);
  const ratingOk = avg == null || avg >= SUPERHOST.rating - 1e-9;
  const responseOk = responseRate >= SUPERHOST.response;
  const cancelOk = cancelPct < SUPERHOST.cancelPct;
  const avgNights = count ? Math.max(1, nights / count) : 3;
  // Bookings still needed on the stays test: the cheaper of 10 stays, or 3 stays that add up to 100 nights.
  const viaTen = Math.max(0, SUPERHOST.stays - count);
  const viaNights = count >= SUPERHOST.altStays && nights >= SUPERHOST.altNights ? 0
    : Math.max(SUPERHOST.altStays - count, Math.ceil(Math.max(0, SUPERHOST.altNights - nights) / avgNights));
  const staysNeeded = staysOk ? 0 : Math.min(viaTen, viaNights);
  // 5-star reviews that would lift the average to the bar (each new review is one more 5-star).
  const fiveNeeded = ratingOk || avg == null ? 0 : Math.ceil((SUPERHOST.rating * reviews - sum) / (SUPERHOST.defaultRating - SUPERHOST.rating) - 1e-9);
  // Lowest rating the NEXT review can be without dropping under the bar (null when any rating is safe).
  const floorNext = ratingOk && reviews ? Math.max(1, Math.ceil(SUPERHOST.rating * (reviews + 1) - sum - 1e-9)) : null;
  return {
    assessOn, from, count, booked, done: count - booked, nights, reviews, assumed, avg, cancelPct, responseRate, hostCancellations,
    staysOk, ratingOk, responseOk, cancelOk, ok: staysOk && ratingOk && responseOk && cancelOk,
    staysNeeded, viaTen, viaNights, fiveNeeded, floorNext, avgNights,
  };
}

// Stays per 30 days over the last 90, and whether anything new can still arrive (a stay lately or one booked ahead).
export function paceOf(stays, today) {
  const recent = stays.filter((s) => s.checkout <= today && s.checkout > dateStrAdd(today, -90)).length;
  const ahead = stays.filter((s) => s.checkout > today).length;
  return { perMonth: recent / 3, recent, ahead, active: recent > 0 || ahead > 0 };
}

// The whole picture for one owner: where they stand today, each coming assessment on booked stays alone and with
// more bookings at the recent pace, and the headline to show.
export function assessOwner(stays, settings, today) {
  const opts = { responseRate: settings.responseRate, hostCancellations: settings.hostCancellations };
  const pace = paceOf(stays, today);
  const lastBooked = stays.reduce((m, s) => (s.checkout > m ? s.checkout : m), today);
  const now = assessStays(stays, dateStrAdd(today, 1), today, opts);
  const rows = assessmentDates(today).map((date) => {
    const conf = assessStays(stays, date, today, opts);
    const gapDays = Math.max(0, days(lastBooked > today ? lastBooked : today, dateStrAdd(date, -1)));
    const extra = pace.active ? (pace.perMonth / 30) * gapDays : 0;
    const projCount = conf.count + extra;
    const projNights = conf.nights + extra * conf.avgNights;
    const projStaysOk = projCount >= SUPERHOST.stays - 0.5 || (projCount >= SUPERHOST.altStays && projNights >= SUPERHOST.altNights);
    const projOk = projStaysOk && conf.ratingOk && conf.responseOk && conf.cancelOk;
    return { date, conf, extra, projCount, projOk };
  });
  const q0 = rows[0];
  const lastDay = fmtDate(dateStrAdd(q0.date, -1));
  const reasons = (c, byDate) => {
    const r = [];
    if (!c.staysOk) {
      const n = c.staysNeeded;
      const viaNights = c.viaNights < c.viaTen;
      r.push(`needs ${plural(n, 'more booking')} by ${byDate}${viaNights ? ` (3 stays totalling 100 nights; ${plural(Math.max(0, SUPERHOST.altNights - c.nights), 'night')} short)` : ` (${c.count} of ${SUPERHOST.stays} so far)`}`);
    }
    if (!c.ratingOk) r.push(`rating ${star(c.avg)} is under ${SUPERHOST.rating}; needs ${plural(c.fiveNeeded, 'more 5★ review')}`);
    if (!c.responseOk) r.push(`response rate ${c.responseRate}% is under ${SUPERHOST.response}%`);
    if (!c.cancelOk) r.push(`host cancellations are ${c.cancelPct.toFixed(1)}% (must be under ${SUPERHOST.cancelPct}%)`);
    return r;
  };
  const firstFail = (pick) => rows.findIndex((r) => !pick(r));
  let state; let headline; let detail = '';
  const holds = !!settings.holds;
  const failConf = firstFail((r) => r.conf.ok);
  const failProj = firstFail((r) => r.projOk);
  if (q0.conf.ok) {
    if (failConf === -1) { state = 'ok'; headline = holds ? `safe through ${fmtDate(rows[rows.length - 1].date)}` : `qualifies at ${fmtDate(q0.date)}`; }
    else {
      const f = rows[failConf];
      const why = reasons(f.conf, fmtDate(dateStrAdd(f.date, -1)));
      const covered = f.projOk;
      state = covered ? 'ok' : (failConf <= 1 ? 'bad' : 'warn');
      headline = holds ? `fine at ${fmtDate(q0.date)}, at risk from ${fmtDate(f.date)}` : `qualifies at ${fmtDate(q0.date)}, but not at ${fmtDate(f.date)} on booked stays`;
      detail = `On booked stays alone, ${fmtDate(f.date)}: ${why.join('; ')}.${covered ? ' Your recent booking pace would cover it.' : (pace.active ? '' : ' No active listing is bringing in new bookings.')}`;
    }
  } else {
    const why = reasons(q0.conf, lastDay);
    state = q0.projOk ? 'warn' : 'bad';
    headline = holds ? `at risk at ${fmtDate(q0.date)}, ${why[0]}` : why[0];
    detail = why.slice(1).length ? `Also: ${why.slice(1).join('; ')}.` : '';
    if (pace.perMonth > 0 && !q0.conf.staysOk) detail = `${detail} At the recent pace (${pace.perMonth.toFixed(1)} stays a month) about ${q0.extra.toFixed(1)} more would complete by then.`.trim();
    if (!pace.active) detail = `${detail} No active listing is bringing in new bookings.`.trim();
    if (!holds && failProj >= 0 && failProj < rows.length) {
      const hit = rows.find((r) => r.projOk);
      detail = `${detail} ${hit ? `At the recent pace the first assessment you'd pass is ${fmtDate(hit.date)}.` : `At the recent pace you wouldn't pass within ${rows.length} assessments.`}`.trim();
    }
  }
  return { state, headline, detail, now, rows, pace, holds, lastBooked };
}

// ---- what counts as a stay ----------------------------------------------------------------

// Stays for one owner, from the reservations on their guest-facing listings plus income-only ledger rows (older
// stays whose reservation was pruned). `ownerKeyFor(listing)` is letting.js's own owner key.
export function collectStays(ownerKey, ownerKeyFor) {
  const listings = (data.airbnbListings || []).filter((l) => ownerKeyFor(l) === ownerKey && l.needsCleaning !== false);
  const ids = new Set(listings.map((l) => l.id));
  const labelOf = (id) => { const l = listings.find((x) => x.id === id); return (l && (l.label || l.prefix)) || ''; };
  const ledger = data.lettingLedger || [];
  const stays = [];
  const resIds = new Set();
  (data.airbnbReservations || []).forEach((r) => {
    resIds.add(r.id);
    if (!ids.has(r.listingId) || r.status === 'cancelled' || r.platform === 'other' || r.source === 'external' || !r.checkin || !r.checkout) return;
    const entry = ledger.find((e) => e.reservationId === r.id);
    stays.push({ kind: 'res', id: r.id, entryId: entry ? entry.id : '', checkin: r.checkin, checkout: r.checkout, nights: Math.max(0, days(r.checkin, r.checkout)), guest: r.guestName || '', rating: r.reviewRating == null ? null : Number(r.reviewRating), listing: labelOf(r.listingId) });
  });
  ledger.forEach((e) => {
    if (e.ownerKey !== ownerKey || !['accrual', 'earned'].includes(e.kind) || e.platform === 'other') return;
    if (e.reservationId && resIds.has(e.reservationId)) return;
    if (e.listingId && !ids.has(e.listingId)) return;
    const nights = Number(e.nights) || 0;
    const checkout = e.checkout || (e.startDate && nights ? dateStrAdd(e.startDate, nights) : e.date);
    if (!checkout) return;
    // An income row for a stay that is also on file as a reservation (same room, same checkout day) is that stay.
    const same = stays.find((s) => s.kind === 'res' && Math.abs(days(s.checkout, checkout)) <= 1 && (!e.listingId || (data.airbnbReservations.find((r) => r.id === s.id) || {}).listingId === e.listingId));
    if (same) { if (same.rating == null && e.reviewRating != null) same.rating = Number(e.reviewRating); return; }
    stays.push({ kind: 'ledger', id: e.id, entryId: e.id, checkin: e.startDate || dateStrAdd(checkout, -nights), checkout, nights, guest: e.guest || String(e.note || '').split(', ').slice(1).join(', '), rating: e.reviewRating == null ? null : Number(e.reviewRating), listing: labelOf(e.listingId) });
  });
  return stays.sort((a, b) => b.checkout.localeCompare(a.checkout));
}

export function settingsFor(ownerKey, isMine) {
  const s = (data.prefs.superhostByOwner || {})[ownerKey] || {};
  return {
    holds: s.holds == null ? !!isMine : !!s.holds,
    responseRate: s.responseRate == null ? 100 : Number(s.responseRate),
    hostCancellations: s.hostCancellations == null ? 0 : Number(s.hostCancellations),
  };
}

export function assessmentFor(ownerKey, ownerKeyFor, isMine) {
  const stays = collectStays(ownerKey, ownerKeyFor);
  const settings = settingsFor(ownerKey, isMine);
  return { stays, settings, ...assessOwner(stays, settings, todayStr()) };
}

// ---- display ------------------------------------------------------------------------------

const STATE_LABEL = { ok: 'on track', warn: 'watch', bad: 'action needed' };
const shOpen = new Set();

// The chip beside the owner's name.
export function superhostChipHtml(a, ownerKey) {
  const text = `${a.holds ? 'Superhost' : 'Not Superhost yet'}: ${a.headline}`;
  return `<span class="sh-chip ${escapeHtml(a.state)}" data-sh-chip="${escapeHtml(ownerKey)}" title="${escapeHtml(`${text}. ${a.detail}`.trim())}">&#9733; ${escapeHtml(text)}</span>`;
}

export function ratingOptionsHtml(value) {
  const cur = value == null ? '' : String(value);
  const opt = (v, label) => `<option value="${v}"${cur === v ? ' selected' : ''}>${label}</option>`;
  return [opt('', '5★ (default)'), opt('5', '5★'), opt('4', '4★'), opt('3', '3★'), opt('2', '2★'), opt('1', '1★'), opt('0', 'No review')].join('');
}

function verdictCell(c) {
  const bits = [];
  if (!c.staysOk) bits.push(`${c.count}/${SUPERHOST.stays} stays`);
  if (!c.ratingOk) bits.push(`${star(c.avg)}`);
  if (!c.responseOk) bits.push('response');
  if (!c.cancelOk) bits.push('cancellations');
  return c.ok ? '<span class="sh-pass">&#10003; passes</span>' : `<span class="sh-fail">&#10007; ${escapeHtml(bits.join(', '))}</span>`;
}

function row(label, c, extra) {
  const stays = `${c.count}${c.booked ? ` <span class="sh-dim">(${c.booked} booked)</span>` : ''}${extra ? ` <span class="sh-dim">~${extra}</span>` : ''}`;
  return `<tr><td>${label}</td><td>${stays}</td><td>${c.nights}</td><td>${star(c.avg)}${c.assumed ? ` <span class="sh-dim" title="${plural(c.assumed, 'stay')} with no rating entered count as 5★">(${c.assumed} assumed)</span>` : ''}</td><td>${verdictCell(c)}</td></tr>`;
}

// The assessment block inside an owner's section of Letting income.
export function superhostPanelHtml(a, ownerKey) {
  const k = escapeHtml(ownerKey);
  const s = a.settings;
  const today = todayStr();
  const recent = a.stays.filter((x) => x.checkout <= today && x.checkout > dateStrAdd(today, -SUPERHOST.windowDays));
  const open = shOpen.has(ownerKey);
  const paceLine = a.pace.active
    ? `Recent pace: ${plural(a.pace.recent, 'stay')} in the last 90 days${a.pace.ahead ? `, ${a.pace.ahead} booked ahead` : ''}.`
    : 'No stays lately and none booked ahead, so nothing new is coming in.';
  return `<div class="sh-panel" data-sh-panel="${k}">
<div class="sh-head"><span class="sh-chip ${escapeHtml(a.state)}">&#9733; ${escapeHtml(STATE_LABEL[a.state])}</span><b>Superhost assessment</b> <span class="settings-note" style="margin:0;">${escapeHtml(paceLine)}</span></div>
<div class="sh-line"><b>${escapeHtml(cap(a.holds ? `Superhost ${a.headline}` : a.headline))}.</b> ${escapeHtml(a.detail)}</div>
<div class="sh-scroll"><table class="sh-table"><thead><tr><th>Assessment</th><th>Stays</th><th>Nights</th><th>Rating</th><th>Result</th></tr></thead><tbody>
${row('Today', a.now)}
${a.rows.map((r) => row(escapeHtml(fmtDate(r.date)), r.conf, r.extra >= 0.5 ? r.extra.toFixed(0) : '')).join('')}
</tbody></table></div>
<div class="settings-note" style="margin:2px 0 6px;">Stays are those finishing in the 365 days before each date, counting booked ones. A <span class="sh-dim">~n</span> is how many more the recent pace would add. Rating: a stay with none entered counts as 5★.</div>
<div class="sh-set">
<label><input type="checkbox" data-sh-set="holds" data-sh-key="${k}"${s.holds ? ' checked' : ''}> Currently a Superhost</label>
<label>Response rate %<input type="number" min="0" max="100" step="1" class="settings-input" data-sh-set="responseRate" data-sh-key="${k}" value="${s.responseRate}" title="From the Airbnb app (Performance). Airbnb asks for 90% or more."></label>
<label>Host cancellations (12 months)<input type="number" min="0" step="1" class="settings-input" data-sh-set="hostCancellations" data-sh-key="${k}" value="${s.hostCancellations}" title="Cancellations you made as host, not guest cancellations. Airbnb allows under 1% of bookings."></label>
</div>
<div class="sh-reviews-toggle" data-sh-toggle="${k}">${open ? '&#9662;' : '&#9656;'} Guest ratings: ${plural(recent.length, 'stay')} in the last 12 months${a.now.assumed ? ` (${a.now.assumed} not yet rated)` : ''}</div>
${open ? `<div class="sh-reviews">${recent.length ? recent.map((x) => `<div class="sh-review"><span class="sh-rev-date">${escapeHtml(x.checkout)}</span>${x.entryId ? `<span class="sh-rev-guest" data-sh-goto="${escapeHtml(x.entryId)}" title="Show this stay in the ledger below">${escapeHtml(x.guest || x.listing || 'Stay')}</span>` : `<span class="sh-rev-guest">${escapeHtml(x.guest || x.listing || 'Stay')}</span>`}<span class="sh-dim">${escapeHtml(plural(x.nights, 'night'))}${x.listing ? `, ${escapeHtml(x.listing)}` : ''}</span><select class="settings-input" data-sh-rate="${x.kind}:${escapeHtml(x.id)}" title="The overall rating this guest gave. Leave on default to count 5★.">${ratingOptionsHtml(x.rating)}</select></div>`).join('') : '<div class="settings-note">No completed stays in the last 12 months.</div>'}</div>` : ''}
</div>`;
}

// Wire the chip, panel and any rating selects inside `root`. `rerender` redraws Letting income.
export function bindSuperhost(root, rerender) {
  root.querySelectorAll('[data-sh-toggle]').forEach((t) => t.addEventListener('click', () => {
    const k = t.dataset.shToggle;
    if (shOpen.has(k)) shOpen.delete(k); else shOpen.add(k);
    rerender();
  }));
  root.querySelectorAll('[data-sh-goto]').forEach((t) => t.addEventListener('click', () => scrollAndFlash(`[data-letting-rec="${CSS.escape(t.dataset.shGoto)}"]`)));
  root.querySelectorAll('[data-sh-set]').forEach((input) => input.addEventListener('change', () => {
    const key = input.dataset.shKey;
    const all = data.prefs.superhostByOwner || (data.prefs.superhostByOwner = {});
    const cur = all[key] || (all[key] = {});
    const f = input.dataset.shSet;
    if (f === 'holds') cur.holds = input.checked;
    else cur[f] = Math.max(0, Number(input.value) || 0);
    queueSave();
    rerender();
  }));
  root.querySelectorAll('[data-sh-rate]').forEach((sel) => sel.addEventListener('change', () => {
    const [kind, id] = sel.dataset.shRate.split(/:(.*)/s);
    const rec = kind === 'res' ? (data.airbnbReservations || []).find((r) => r.id === id) : (data.lettingLedger || []).find((e) => e.id === id);
    if (!rec) return;
    if (sel.value === '') delete rec.reviewRating; else rec.reviewRating = Number(sel.value);
    queueSave();
    rerender();
  }));
}
