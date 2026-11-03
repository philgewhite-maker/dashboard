<?php
/**
 * Booking request form. Works as a plain form description without JS;
 * book.js turns it into a live quote + request. Prefilled for event pages.
 * @var array $product @var array $currencies ?string $arrival ?string $departure ?string $occurrence_id
 */
$h = 'Util::h';
$cap = array_sum(array_map(fn($l) => (int)$l['max_guests'], $product['listings']));
?>
<form class="book" data-product="<?= $h($product['slug']) ?>" data-occurrence="<?= $h($occurrence_id ?? '') ?>" novalidate>
  <h3>Request to book: <?= $h($product['name']) ?></h3>
  <div class="row">
    <label>Arrive<input type="date" name="arrival" value="<?= $h($arrival ?? '') ?>" required></label>
    <label>Leave<input type="date" name="departure" value="<?= $h($departure ?? '') ?>" required></label>
    <label>Guests<select name="adults"><?php for ($i = 1; $i <= $cap; $i++): ?><option<?= $i === min(2, $cap) ? ' selected' : '' ?>><?= $i ?></option><?php endfor; ?></select></label>
    <label>Currency<select name="currency"><?php foreach ($currencies as $c): ?><option><?= $h($c) ?></option><?php endforeach; ?></select></label>
  </div>
  <div class="quote" aria-live="polite"><p class="muted">Pick dates to see the price.</p></div>
  <fieldset class="guest" hidden>
    <label>How to pay<select name="method"></select></label>
    <label>Full name<input name="name" autocomplete="name" required></label>
    <label>Email<input type="email" name="email" autocomplete="email" required></label>
    <label>Phone (optional)<input name="phone" autocomplete="tel"></label>
    <label>Country (optional)<input name="country" autocomplete="country-name"></label>
    <label>Message to the host (optional)<textarea name="message" rows="3" placeholder="Who's coming, what brings you to London"></textarea></label>
    <p class="muted small">This is a request: the host replies within 24 hours. Cards are authorised, not charged, until the host accepts. Other methods are paid only after acceptance.</p>
    <button type="submit">Send request</button>
  </fieldset>
  <p class="errors" role="alert"></p>
  <noscript><p>Booking needs JavaScript. Or email us with your dates.</p></noscript>
</form>
