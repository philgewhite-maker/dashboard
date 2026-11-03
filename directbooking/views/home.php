<?php
/** @var array $property @var array $products @var array $events */
$h = 'Util::h';
$c = $property['content'];
?>
<section class="hero">
  <h1><?= $h(Util::t($c['headline'] ?? $property['name'])) ?></h1>
  <p class="lead"><?= $h(Util::t($c['description'] ?? '')) ?></p>
  <?php if (!empty($c['walk_times'])): ?>
  <ul class="facts"><?php foreach ($c['walk_times'] as $w): ?><li><strong><?= (int)$w['minutes'] ?> min</strong> walk to <?= $h(Util::t($w['to'])) ?></li><?php endforeach; ?></ul>
  <?php endif; ?>
</section>

<section id="rooms">
  <h2>Rooms</h2>
  <?= View::render('_rooms', ['products' => $products]) ?>
</section>

<?php if (!empty($c['highlights'])): ?>
<section>
  <h2>The flat</h2>
  <ul class="ticks"><?php foreach ($c['highlights'] as $x): ?><li><?= $h(Util::t($x)) ?></li><?php endforeach; ?></ul>
</section>
<?php endif; ?>

<?php if ($events): ?>
<section>
  <h2>Coming to London for an event?</h2>
  <ul class="event-list">
  <?php foreach ($events as $e): ?>
    <li><a href="/events/<?= $h($e['series']['slug']) ?>/"><?= $h($e['series']['name']) ?></a>
      <span class="muted"><?= $e['occ'] && $e['occ']['start_date'] ? $h(Util::fmtDate($e['occ']['start_date'])) : 'dates to be confirmed' ?></span></li>
  <?php endforeach; ?>
  </ul>
</section>
<?php endif; ?>
