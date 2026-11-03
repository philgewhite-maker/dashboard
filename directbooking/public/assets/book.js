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
      quoteBox.innerHTML = `<table>${rows}<tr class="total"><td>Total</td><td>${esc(q.total_text)}</td></tr></table>${sched}`
        + `<p class="small muted">Cancellation: ${esc(q.policy_text)}</p>`;
      const current = $('method').value;
      $('method').innerHTML = q.methods.map((m) => `<option value="${esc(m)}">${esc(METHOD_NAMES[m] || m)}</option>`).join('');
      if (q.methods.includes(current)) $('method').value = current;
      guest.hidden = q.methods.length === 0;
      if (!q.methods.length) quoteBox.insertAdjacentHTML('beforeend', '<p class="errors">No payment method takes this currency for these rooms. Try GBP.</p>');
    }
    const later = () => { clearTimeout(timer); timer = setTimeout(quote, 250); };

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
          currency: $('currency').value, method: $('method').value, message: $('message').value,
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
