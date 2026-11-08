<?php
/** @var array $b @var array $parts @var array $payments @var Content $content @var array $activity @var int $refundNow @var int $paidTotal @var bool $pushes */
$h = 'Util::h';
$q = Util::json($b['quote']);
$partById = array_column($parts, null, 'id');
?>
<p><strong><?= $h(ucfirst($b['status'])) ?></strong> · <?= $h($q['product_name'] ?? '') ?> · <?= $h(Util::fmtDate($b['arrival'])) ?> to <?= $h(Util::fmtDate($b['departure'])) ?> (<?= (int)$b['nights'] ?> nights, <?= (int)$b['adults'] ?> guests)</p>
<p><?= $h($b['guest_name']) ?> · <a href="mailto:<?= $h($b['guest_email']) ?>"><?= $h($b['guest_email']) ?></a><?= $b['guest_phone'] ? ' · ' . $h($b['guest_phone']) : '' ?><?= $b['guest_country'] ? ' · ' . $h($b['guest_country']) : '' ?></p>
<?php if ($b['message']): ?><blockquote><?= nl2br($h($b['message'])) ?></blockquote><?php endif; ?>
<p>Total <?= $h(Util::money((int)$b['total_minor'], $b['currency'])) ?> by <?= $h($b['method']) ?> · <?= $h(Cancellation::POLICIES[$b['policy']]['name']) ?> cancellation</p>

<?php if ($b['status'] === 'requested'): ?>
<div class="actions">
  <?php if (!$pushes): ?><p class="warn">Before approving: check the dates are still free on Airbnb, and block them there once approved.</p><?php endif; ?>
  <form method="post" action="/admin/booking/action" class="stack" style="max-width:260px">{{csrf}}<input type="hidden" name="id" value="<?= $h($b['id']) ?>">
    <button name="action" value="approve">Approve<?= $b['method'] === 'card' ? ' and charge' : '' ?> <?= $h(Util::money((int)$b['total_minor'], $b['currency'])) ?></button>
    <label>Or approve at a lower total (<?= $h($b['currency']) ?>)<input name="price" type="number" step="0.01" min="1" max="<?= $h((string)((int)$b['total_minor'] / Util::minorFactor($b['currency']))) ?>" placeholder="e.g. what the evaluator suggests"></label>
    <button name="action" value="approve" class="secondary">Approve at this price</button>
    <p class="small muted">Check it first in the dashboard's booking evaluator (channel: Direct). A higher price needs the guest's agreement: decline with a note instead.</p>
  </form>
  <form method="post" action="/admin/booking/action" class="stack">{{csrf}}<input type="hidden" name="id" value="<?= $h($b['id']) ?>">
    <label>Reason for the guest (optional)<input name="reason"></label><button name="action" value="decline" class="secondary">Decline</button></form>
</div>
<?php endif; ?>

<h2>Rooms and payments</h2>
<table class="routes"><thead><tr><th>Room</th><th>#</th><th>Covers</th><th>Due</th><th>Amount</th><th>Status</th><th></th></tr></thead><tbody>
<?php foreach ($payments as $p): $part = $partById[$p['part_id']]; $l = $content->listing($part['listing_id']); ?>
<tr><td><a href="/admin/edit?table=listings&amp;id=<?= $h($l['id']) ?>"><?= $h($l['name']) ?></a><br><span class="small muted">to <?= $h($l['host']['name']) ?><?= $part['hold_ref'] ? ' · Beds24 ' . $h($part['hold_ref']) : '' ?></span></td>
<td><?= (int)$p['seq'] ?></td><td><?= $h(Util::fmtDate($p['covers_from'])) ?> – <?= $h(Util::fmtDate($p['covers_to'])) ?></td><td><?= $p['due_date'] ? $h(Util::fmtDate($p['due_date'])) : 'on acceptance' ?></td>
<td><?= $h(Util::money((int)$p['amount_minor'], $p['currency'])) ?><?= $p['refunded_minor'] ? ' (refunded ' . $h(Util::money((int)$p['refunded_minor'], $p['currency'])) . ')' : '' ?></td><td><?= $h($p['status']) ?></td>
<td><?php if ($p['kind'] === 'manual' && $p['status'] === 'pending' && in_array($b['status'], ['approved', 'confirmed'], true)): ?>
<form method="post" action="/admin/booking/action" class="inline">{{csrf}}<input type="hidden" name="id" value="<?= $h($b['id']) ?>"><input type="hidden" name="payment_id" value="<?= $h($p['id']) ?>"><button name="action" value="paid">Mark received</button></form><?php endif; ?></td></tr>
<?php endforeach; ?></tbody></table>

<?php if (in_array($b['status'], ['requested', 'approved', 'confirmed'], true)): ?>
<h2>Cancel</h2>
<p>Paid so far: <?= $h(Util::money($paidTotal, $b['currency'])) ?>. Cancelling now refunds <strong><?= $h(Util::money($refundNow, $b['currency'])) ?></strong> under the policy<?= $paidTotal && array_filter($payments, fn($p) => $p['status'] === 'paid' && !$p['stripe_pi_id']) ? '; bank-paid amounts must be returned by hand' : '' ?>.</p>
<form method="post" action="/admin/booking/action" onsubmit="return confirm('Cancel <?= $h($b['ref']) ?> and refund <?= $h(Util::money($refundNow, $b['currency'])) ?>?')">{{csrf}}<input type="hidden" name="id" value="<?= $h($b['id']) ?>"><button name="action" value="cancel" class="secondary">Cancel booking</button></form>
<?php endif; ?>

<h2>History</h2>
<ul class="small"><?php foreach ($activity as $a): ?><li><?= $h($a['at']) ?>: <?= $h($a['message']) ?></li><?php endforeach; ?></ul>
