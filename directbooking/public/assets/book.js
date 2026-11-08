// Booking widget: live quote as dates change, then the request.
// One small script, no framework; every form.book on the page is independent.
(() => {
  const METHOD_NAMES = {
    card: 'Card, Apple Pay or Google Pay (authorised now, charged if accepted)',
    alipay: 'Alipay (pay after acceptance)', wechat_pay: 'WeChat Pay (pay after acceptance)',
    pay_by_bank: 'Pay by bank, UK (pay after acceptance)', bank_transfer: 'Bank transfer (pay after acceptance)',
    revolut: 'Revolut transfer (pay after acceptance)', usdt: 'USDT (pay after acceptance)',
    kakao_pay: 'Kakao Pay', naver_pay: 'Naver Pay',
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const today = new Date().toISOString().slice(0, 10);

  document.querySelectorAll('form.book').forEach((form) => {
    const $ = (n) => form.elements[n];
    const quoteBox = form.querySelector('.quote');
    const guest = form.querySelector('.guest');
    const errors = form.querySelector('.errors');
    let timer = null;
    let seq = 0;
    // A re-offer link (?offer=...): a held price for exact dates. The token is signed by the server;
    // here it only prefills the form, and the server checks it again on every quote.
    let offer = new URLSearchParams(location.search).get('offer') || '';
    if (offer) {
      try {
        const o = JSON.parse(atob(offer.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')));
        if (o.p !== form.dataset.product) offer = '';
        else { $('arrival').value = o.a; $('departure').value = o.d; $('adults').value = String(o.n); $('currency').value = o.c; }
      } catch (e) { offer = ''; }
    }
    $('arrival').min = today;
    $('departure').min = today;

    // A currency the visitor used before is a convenience only; never required.
    try { const c = localStorage.getItem('db-currency'); if (c && [...$('currency').options].some((o) => o.value === c)) $('currency').value = c; } catch (e) { /* storage blocked */ }

    async function quote() {
      errors.textContent = '';
      const a = $('arrival').value, d = $('departure').value;
      if (!a || !d) { guest.hidden = true; return; }
      const my = ++seq;
      const params = new URLSearchParams({ product: form.dataset.product, arrival: a, departure: d, adults: $('adults').value, currency: $('currency').value });
      if ($('method').value) params.set('method', $('method').value);
      if (offer) params.set('offer', offer);
      quoteBox.innerHTML = '<p class="muted">Checking…</p>';
      let q;
      try {
        q = await (await fetch('/api/quote?' + params)).json();
      } catch (e) {
        quoteBox.innerHTML = '<p class="errors">Could not check prices just now. Try again in a moment.</p>';
        return;
      }
      if (my !== seq) return; // a newer change already asked
      if (!q.ok) {
        quoteBox.innerHTML = '<p class="errors">' + (q.errors || []).map(esc).join('<br>') + '</p>';
        guest.hidden = true;
        return;
      }
      const rows = q.lines.map((l) => `<tr><td>${esc(l.label)}</td><td>${esc(l.text)}</td></tr>`).join('');
      const sched = q.schedule.length ? '<p class="small">Paid monthly in advance: ' + q.schedule.map((s) => `${esc(s.text)} ${esc(s.due)}`).join('; ') + '.</p>' : '';
      const ext = (q.extensions || []).map((x) => `<button type="button" class="chip ext" data-a="${esc(x.arrival)}" data-d="${esc(x.departure)}">${esc(x.text)}</button>`).join(' ');
      quoteBox.innerHTML = `<table>${rows}<tr class="total"><td>Total</td><td>${esc(q.total_text)}</td></tr></table>${sched}`
        + (q.held_until ? `<p class="small"><strong>Your special price is held until ${esc(q.held_until)}.</strong></p>` : '')
        + (ext ? `<p class="small">Stay longer? ${ext}</p>` : '')
        + `<p class="small muted">Cancellation: ${esc(q.policy_text)}</p>`;
      quoteBox.querySelectorAll('.ext').forEach((b) => b.addEventListener('click', () => setDates(b.dataset.a, b.dataset.d)));
      const current = $('method').value;
      $('method').innerHTML = q.methods.map((m) => `<option value="${esc(m)}">${esc(METHOD_NAMES[m] || m)}</option>`).join('');
      if (q.methods.includes(current)) $('method').value = current;
      guest.hidden = q.methods.length === 0;
      if (!q.methods.length) quoteBox.insertAdjacentHTML('beforeend', '<p class="errors">No payment method takes this currency for these rooms. Try GBP.</p>');
    }
    const later = () => { clearTimeout(timer); timer = setTimeout(quote, 250); };

    // Special offers: quiet dates the booking model expects to stay empty, as clickable windows.
    const offersBox = form.querySelector('.offers');
    const setDates = (a, d) => { $('arrival').value = a; $('departure').value = d; $('departure').min = a; later(); };
    fetch('/api/offers?' + new URLSearchParams({ product: form.dataset.product })).then((r) => r.json()).then((o) => {
      if (!o.offers || !o.offers.length) return;
      offersBox.innerHTML = '<p class="small"><strong>Special offers</strong> on quieter dates:</p>' + o.offers.map((w) =>
        `<button type="button" class="chip" data-a="${esc(w.arrival)}" data-d="${esc(w.departure)}">${esc(w.label)} · ${esc(String(w.pct_off))}% off${w.min_nights === 1 ? ' · 1 night OK' : ''}</button>`).join(' ');
      offersBox.hidden = false;
      offersBox.addEventListener('click', (e) => {
        const b = e.target.closest('[data-a]');
        if (!b) return;
        // Keep the guest's own stay length where it fits inside the window.
        const len = $('arrival').value && $('departure').value ? Math.round((new Date($('departure').value) - new Date($('arrival').value)) / 864e5) : 0;
        const winLen = Math.round((new Date(b.dataset.d) - new Date(b.dataset.a)) / 864e5);
        const dep = len > 0 && len < winLen ? new Date(new Date(b.dataset.a + 'T12:00:00Z').getTime() + len * 864e5).toISOString().slice(0, 10) : b.dataset.d;
        setDates(b.dataset.a, dep);
      });
    }).catch(() => { /* offers are optional */ });

    $('arrival').addEventListener('change', () => {
      if ($('arrival').value && (!$('departure').value || $('departure').value <= $('arrival').value)) {
        const d = new Date($('arrival').value + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 2);
        $('departure').value = d.toISOString().slice(0, 10);
      }
      $('departure').min = $('arrival').value || today;
      later();
    });
    ['departure', 'adults', 'method'].forEach((n) => $(n).addEventListener('change', later));
    $('currency').addEventListener('change', () => { try { localStorage.setItem('db-currency', $('currency').value); } catch (e) { /* ignore */ } later(); });

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      errors.textContent = '';
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const body = {
          product: form.dataset.product, occurrence_id: form.dataset.occurrence || null,
          arrival: $('arrival').value, departure: $('departure').value, adults: Number($('adults').value),
          currency: $('currency').value, method: $('method').value, message: $('message').value, offer,
          guest: { name: $('name').value, email: $('email').value, phone: $('phone').value, country: $('country').value },
        };
        const r = await (await fetch('/api/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
        if (r.ok) { location.href = r.next_url; return; }
        errors.innerHTML = (r.errors || ['Something went wrong.']).map(esc).join('<br>');
      } catch (e) {
        errors.textContent = 'Could not send the request. Please try again.';
      }
      btn.disabled = false;
    });

    if ($('arrival').value && $('departure').value) quote();
  });
})();
