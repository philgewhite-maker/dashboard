<?php /** @var string $table @var array $rows @var string $key */ $h = 'Util::h'; ?>
<p><a href="/admin/table">All content</a> · <a href="/admin/edit?table=<?= $h($table) ?>">Add new</a></p>
<table class="routes"><thead><tr><th>Name</th><th>Status</th><th>Flags</th></tr></thead><tbody>
<?php foreach ($rows as $r): $label = $r['name'] ?? $r['summary'] ?? ($r['start_date'] ?? $r[$key]); ?>
<tr><td><a href="/admin/edit?table=<?= $h($table) ?>&amp;id=<?= $h($r[$key]) ?>"><?= $h((string)$label) ?></a><?= isset($r['start_date']) && isset($r['series_id']) ? ' <span class="muted small">' . $h(Util::fmtDate($r['start_date'])) . '</span>' : '' ?></td>
<td><?= $h($r['status'] ?? '') ?></td><td><?= str_contains(Util::enc($r), '[CHECK') ? '<span class="warn">needs checking</span>' : '' ?></td></tr>
<?php endforeach; ?></tbody></table>
