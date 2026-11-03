<?php
/** @var array $requested @var array $awaiting @var array $checkout @var array $upcoming @var array $manualDue @var bool $operator */
$h = 'Util::h';
$row = function (array $b, string $extra = '') use ($h): string {
    $q = Util::json($b['quote']);
    return '<tr><td><a href="/admin/booking?id=' . $h($b['id']) . '">' . $h($b['ref']) . '</a></td><td>' . $h($b['guest_name']) . '</td><td>' . $h($q['product_name'] ?? '')
        . '</td><td>' . $h(Util::fmtDate($b['arrival'])) . ' – ' . $h(Util::fmtDate($b['departure'])) . '</td><td>' . $h(Util::money((int)$b['total_minor'], $b['currency']))
        . ' · ' . $h($b['method']) . "</td><td>$extra</td></tr>";
};
$table = fn(array $rows, callable $extra) => $rows
    ? '<table class="routes"><thead><tr><th>Ref</th><th>Guest</th><th>Room</th><th>Dates</th><th>Total</th><th></th></tr></thead><tbody>' . implode('', array_map(fn($b) => $row($b, $extra($b)), $rows)) . '</tbody></table>'
    : '<p class="muted">None.</p>';
?>
<h2>Waiting for your answer</h2>
<?= $table($requested, fn($b) => 'answer by ' . $h(date('D j M H:i', strtotime($b['approve_by'])))) ?>

<h2>Accepted, waiting for payment</h2>
<?= $table($awaiting, fn($b) => 'pay by ' . $h(date('D j M H:i', strtotime((string)$b['pay_by'])))) ?>

<?php if ($manualDue): ?>
<h2>Bank, Revolut or USDT payments to look out for</h2>
<table class="routes"><thead><tr><th>Booking</th><th>Amount</th><th>Reference</th><th></th></tr></thead><tbody>
<?php foreach ($manualDue as $p): ?>
<tr><td><a href="/admin/booking?id=<?= $h($p['booking_id']) ?>"><?= $h($p['ref']) ?></a></td><td><?= $h(Util::money((int)$p['amount_minor'], $p['currency'])) ?></td><td><?= $h($p['ref'] . '-' . $p['seq']) ?></td>
<td><form method="post" action="/admin/booking/action" class="inline">{{csrf}}<input type="hidden" name="id" value="<?= $h($p['booking_id']) ?>"><input type="hidden" name="payment_id" value="<?= $h($p['id']) ?>"><button name="action" value="paid">Mark received</button></form></td></tr>
<?php endforeach; ?></tbody></table>
<?php endif; ?>

<h2>Coming up</h2>
<?= $table($upcoming, fn($b) => '') ?>

<?php if ($checkout): ?>
<h2>Guest still at card checkout</h2>
<?= $table($checkout, fn($b) => 'started ' . $h(date('H:i', strtotime($b['created_at'])))) ?>
<?php endif; ?>

<?php if ($operator): ?>
<h2>Proposed changes</h2>
<?php if (!$approvals): ?><p class="muted">None waiting.</p><?php endif; ?>
<?php foreach ($approvals as $a): ?>
  <form method="post" action="/admin/approval" class="approval">{{csrf}}<input type="hidden" name="id" value="<?= $h($a['id']) ?>">
    <strong><?= $h($a['summary']) ?></strong>
    <details><summary>Details</summary><pre class="small"><?= $h(json_encode(Util::json($a['payload']), JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)) ?></pre></details>
    <button name="decision" value="approve">Approve</button> <button name="decision" value="reject" class="secondary">Reject</button>
  </form>
<?php endforeach; ?>

<h2>Site</h2>
<?php if ($problems): ?>
  <p>Publishing is blocked until these are fixed:</p>
  <ul><?php foreach ($problems as $p): ?><li><?= $h($p) ?></li><?php endforeach; ?></ul>
<?php endif; ?>
<form method="post" action="/admin/publish">{{csrf}}<button>Publish the site</button></form>

<h3>Setup</h3>
<table class="routes"><tbody>
<?php foreach ($setup as [$what, $value, $state, $note]): ?>
<tr><td><?= $h($what) ?></td><td><span class="dot <?= $h($state) ?>"></span><?= $h($value) ?></td><td class="muted"><?php if (str_starts_with($note, 'host:')): ?>
<form method="post" action="/admin/stripe-onboard" class="inline">{{csrf}}<input type="hidden" name="host" value="<?= $h(substr($note, 5)) ?>"><button class="link">Make a Stripe sign-up link</button></form>
<?php else: ?><?= $h($note) ?><?php endif; ?></td></tr>
<?php endforeach; ?></tbody></table>

<h3>Recent activity</h3>
<ul class="small"><?php foreach ($activity as $a): ?><li><?= $h($a['at']) ?>:
  <?php if ($a['entity'] === 'booking' && $a['entity_id']): ?><a href="/admin/booking?id=<?= $h($a['entity_id']) ?>">booking</a>
  <?php elseif ($a['entity_id'] && $a['entity'] !== 'site'): ?><a href="/admin/edit?table=<?= $h($a['entity']) ?>&amp;id=<?= $h($a['entity_id']) ?>"><?= $h($a['entity']) ?></a>
  <?php else: ?><?= $h($a['entity']) ?><?php endif; ?> <?= $h($a['message']) ?></li><?php endforeach; ?></ul>
<?php endif; ?>
