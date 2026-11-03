<?php
/** Guest's own booking page. @var array $b @var array $payments @var array $parts @var Bookings $bookings @var Content $content @var bool $cancelled */
$h = 'Util::h';
$q = Util::json($b['quote']);
$status = [
    'checkout' => 'Waiting for your card authorisation.',
    'requested' => 'Sent to the host. You will hear back by ' . date('D j M, H:i', strtotime((string)$b['approve_by'])) . ' (UK time).',
    'approved' => 'Accepted. Please pay by ' . date('D j M, H:i', strtotime((string)$b['pay_by'])) . ' (UK time) to confirm.',
    'confirmed' => 'Confirmed. See you soon.',
    'declined' => 'The host could not accept this request. You have not been charged.',
    'expired' => 'This request lapsed. Any card authorisation has been released.',
    'cancelled' => 'Cancelled.',
][$b['status']] ?? $b['status'];
$partById = array_column($parts, null, 'id');
?>
<h1>Booking <?= $h($b['ref']) ?></h1>
<?php if ($cancelled && $b['status'] === 'checkout'): ?><p class="errors">Card checkout was cancelled. You can try again below.</p><?php endif; ?>
<p class="lead"><?= $h($status) ?></p>
<ul class="facts">
  <li><strong><?= $h($q['product_name'] ?? '') ?></strong></li>
  <li><?= $h(Util::fmtDate($b['arrival'])) ?> to <?= $h(Util::fmtDate($b['departure'])) ?> (<?= (int)$b['nights'] ?> nights, <?= (int)$b['adults'] ?> guests)</li>
  <li>Total <?= $h(Util::money((int)$b['total_minor'], $b['currency'])) ?></li>
</ul>

<?php if ($b['status'] === 'checkout'): ?>
  <p><a class="button" href="/checkout/return?ref=<?= $h($b['ref']) ?>&amp;k=<?= $h($_GET['k'] ?? '') ?>">Continue to card authorisation</a></p>
<?php endif; ?>

<?php if (in_array($b['status'], ['approved', 'confirmed'], true)): ?>
<h2>Payments</h2>
<table class="routes">
  <thead><tr><th>Room</th><th>Covers</th><th>Amount</th><th>Status</th></tr></thead>
  <tbody>
  <?php foreach ($payments as $p): $part = $partById[$p['part_id']]; $l = $content->listing($part['listing_id']); ?>
    <tr>
      <td><?= $h($l['name']) ?></td>
      <td><?= $h(Util::fmtDate($p['covers_from'])) ?> to <?= $h(Util::fmtDate($p['covers_to'])) ?></td>
      <td><?= $h(Util::money((int)$p['amount_minor'], $p['currency'])) ?></td>
      <td><?php if ($p['status'] === 'pending' && ($p['seq'] == 1 || $p['notified_at'])): ?>
            <?php if ($p['kind'] === 'manual'): ?><pre class="small"><?= $h($bookings->manualInstructions($b, $content->host($part['host_id']), $p)) ?></pre>
            <?php else: ?><a class="button" href="<?= $h($bookings->guestUrl($b['ref'])) ?>&amp;pay=<?= $h($p['id']) ?>">Pay now</a><?php endif; ?>
          <?php elseif ($p['status'] === 'pending'): ?>Due <?= $h(Util::fmtDate($p['due_date'])) ?>
          <?php else: ?><?= $h($p['status']) ?><?php endif; ?></td>
    </tr>
  <?php endforeach; ?>
  </tbody>
</table>
<?php endif; ?>

<h2>Cancellation</h2>
<p><?= $h(Cancellation::POLICIES[$b['policy']]['name']) ?>: <?= $h(Cancellation::POLICIES[$b['policy']]['text']) ?> To cancel, reply to any of our emails.</p>
