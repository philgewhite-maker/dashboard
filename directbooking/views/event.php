<?php
/** @var array $series @var ?array $occ @var array $routeGroups @var array $products @var array $currencies */
$h = 'Util::h';
$c = $occ['content'] ?? $series['content'];
$arrival = $occ && $occ['start_date'] ? Util::addDays($occ['start_date'], -1) : null;
$departure = null;
if ($arrival) {
    // Short events: cover the whole thing. Long ones (Wimbledon's fortnight): suggest a few nights from the start.
    $span = Util::nightsBetween($occ['start_date'], $occ['end_date'] ?: $occ['start_date']);
    $departure = $span <= 3 ? Util::addDays($occ['end_date'] ?: $occ['start_date'], 1) : Util::addDays($arrival, max(3, (int)$occ['min_nights']));
}
if ($arrival && $arrival < date('Y-m-d')) $arrival = $departure = null;
?>
<article class="event">
  <p class="crumbs"><a href="/events/">Events</a> ›</p>
  <h1><?= $h(Util::t($c['headline'] ?? "Where to stay for {$series['name']}")) ?></h1>
  <p class="lead"><?= $h(Util::t($c['summary'] ?? '')) ?></p>
  <ul class="facts">
    <li><strong>When:</strong> <?php if ($occ && $occ['start_date']): ?><?= $h(Util::fmtDate($occ['start_date'])) ?><?= $occ['end_date'] && $occ['end_date'] !== $occ['start_date'] ? ' to ' . $h(Util::fmtDate($occ['end_date'])) : '' ?><?php else: ?>dates to be confirmed<?php endif; ?></li>
    <?php if ($series['venue']): ?><li><strong>Where:</strong> <?= $h($series['venue']['name']) ?></li><?php endif; ?>
    <?php if ($occ && $occ['ticket_url']): ?><li><a href="<?= $h($occ['ticket_url']) ?>" rel="noopener">Official site and tickets</a></li><?php endif; ?>
  </ul>

  <?php if (!empty($c['intro'])): ?><p><?= $h(Util::t($c['intro'])) ?></p><?php endif; ?>

  <h2>Getting there from London Bridge</h2>
  <?= View::render('_routes', ['routeGroups' => $routeGroups]) ?>

  <?php if (!empty($c['tips'])): ?>
  <h2>Tips</h2>
  <ul><?php foreach ($c['tips'] as $t): ?><li><?= $h(Util::t($t)) ?></li><?php endforeach; ?></ul>
  <?php endif; ?>

  <h2>Rooms for these dates</h2>
  <?php foreach ($products as $p): ?>
    <div class="split">
      <div><h3><a href="/stay/<?= $h($p['slug']) ?>/"><?= $h($p['name']) ?></a></h3><p class="muted"><?= $h(Util::t($p['content']['summary'] ?? ($p['listings'][0]['content']['summary'] ?? ''))) ?></p></div>
      <aside><?= View::render('_widget', ['product' => $p, 'currencies' => $currencies, 'arrival' => $arrival, 'departure' => $departure, 'occurrence_id' => $occ['id'] ?? null]) ?></aside>
    </div>
  <?php endforeach; ?>
</article>
