<?php
/** Transport from the flat to each point of an event. @var array $routeGroups */
$h = 'Util::h';
$ctx = ['normal' => 'Usual', 'event_day' => 'Event day', 'late_night' => 'Late night'];
?>
<?php foreach ($routeGroups as $g): if (!$g['routes']) continue; ?>
<section class="route-group">
  <h3><?= $h($g['point']['name']) ?></h3>
  <?php if (!empty($g['point']['content']['note'])): ?><p class="muted"><?= $h(Util::t($g['point']['content']['note'])) ?></p><?php endif; ?>
  <table class="routes">
    <thead><tr><th>When</th><th>Way</th><th>Time</th><th>Fare</th></tr></thead>
    <tbody>
    <?php foreach ($g['routes'] as $r): ?>
      <tr>
        <td><?= $h($ctx[$r['context']] ?? $r['context']) ?><?= $r['direction'] === 'from' ? ', back' : '' ?></td>
        <td><?= $h($r['summary']) ?>
          <?php if ($r['legs']): ?><ol class="legs"><?php foreach ($r['legs'] as $leg): ?><li><?= $h($leg['text']) ?> <span class="muted">(<?= (int)$leg['minutes'] ?> min)</span></li><?php endforeach; ?></ol><?php endif; ?>
        </td>
        <td><?= $r['minutes'] !== null ? (int)$r['minutes'] . ' min' : '—' ?></td>
        <td><?= $r['fare_pence'] !== null ? '£' . number_format($r['fare_pence'] / 100, 2) : '—' ?></td>
      </tr>
    <?php endforeach; ?>
    </tbody>
  </table>
  <p class="small muted">Journey times from the TfL journey planner<?= $g['routes'][0]['verified_at'] ? ', checked ' . $h(Util::fmtDate($g['routes'][0]['verified_at'])) : '' ?>. Check TfL on the day: event-day closures change.</p>
</section>
<?php endforeach; ?>
