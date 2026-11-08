<?php /** @var array $rows @var bool $enabled @var array $cfg */ $h = 'Util::h'; ?>
<p>Changes the autopilot made to the shared calendar (Beds24, which passes them to Airbnb) for dead voids: nights the dashboard's booking model expects to stay empty as they are.
Autopilot is <strong><?= $enabled ? 'on' : 'off' ?></strong>. Limits: at most <?= (int)$cfg['max_discount_pct'] ?>% off, never below £<?= (int)$cfg['floor_gbp'] ?> a night, only voids starting within <?= (int)$cfg['max_days_ahead'] ?> days<?= $cfg['allow_min_stay'] ? ', minimum stay may be shortened' : '' ?>.
A change is undone by itself when a newer projection no longer calls the void dead.</p>
<?php if (!$rows): ?><p class="muted">No changes yet.</p><?php endif; ?>
<table class="routes"><thead><tr><th>Room</th><th>Nights</th><th>Change</th><th>Applied</th><th>Status</th><th></th></tr></thead><tbody>
<?php foreach ($rows as $a): ?>
<tr><td><a href="/admin/edit?table=listings&amp;id=<?= $h($a['listing_id']) ?>"><?= $h($a['listing'] ?? $a['listing_id']) ?></a></td>
<td><?= $h(Util::fmtDate($a['date_from'])) ?> – <?= $h(Util::fmtDate(Util::addDays($a['date_to'], -1))) ?></td>
<td><?= $h($a['reason']) ?></td><td><?= $h($a['applied_at']) ?></td><td><?= $h($a['status']) ?><?= $a['note'] ? '<br><span class="small muted">' . $h($a['note']) . '</span>' : '' ?></td>
<td><?php if ($a['status'] === 'active'): ?><form method="post" class="inline">{{csrf}}<input type="hidden" name="id" value="<?= $h($a['id']) ?>"><button class="secondary">Undo</button></form><?php endif; ?></td></tr>
<?php endforeach; ?></tbody></table>
