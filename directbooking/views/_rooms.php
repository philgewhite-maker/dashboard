<?php
/** Room cards; each links to its own page. @var array $products */
$h = 'Util::h';
?>
<div class="cards">
<?php foreach ($products as $p):
    $c = $p['content'];
    $photo = $c['photos'][0] ?? ($p['listings'][0]['content']['photos'][0] ?? null);
    $sleeps = array_sum(array_map(fn($l) => (int)$l['max_guests'], $p['listings']));
?>
  <a class="card" href="/stay/<?= $h($p['slug']) ?>/">
    <?php if ($photo): ?><img src="<?= $h($photo['src']) ?>" alt="<?= $h(Util::t($photo['alt'] ?? '')) ?>" loading="lazy"><?php endif; ?>
    <strong><?= $h($p['name']) ?></strong>
    <span class="muted"><?= $h(Util::t($c['summary'] ?? ($p['listings'][0]['content']['summary'] ?? ''))) ?></span>
    <span class="small">Sleeps <?= $sleeps ?><?= count($p['listings']) > 1 && $p['multi_room_discount_pct'] > 0 ? ' · ' . $h((string)$p['multi_room_discount_pct']) . '% off for both rooms' : '' ?></span>
  </a>
<?php endforeach; ?>
</div>
