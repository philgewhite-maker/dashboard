<?php
/** @var array $events */
$h = 'Util::h';
?>
<h1>Events near London Bridge</h1>
<p class="lead">Pages for the events our guests come for: dates, how to get there from the flat and back late at night, and rooms for those dates.</p>
<ul class="event-list">
<?php foreach ($events as $e): ?>
  <li><a href="/events/<?= $h($e['series']['slug']) ?>/"><?= $h($e['series']['name']) ?></a>
    <span class="muted"><?= $e['occ'] && $e['occ']['start_date'] ? $h(Util::fmtDate($e['occ']['start_date'])) : 'dates to be confirmed' ?><?= $e['series']['venue'] ? ' · ' . $h($e['series']['venue']['name']) : '' ?></span></li>
<?php endforeach; ?>
</ul>
