<?php /** @var array $tables */ $h = 'Util::h'; ?>
<p>Every record type, edited as JSON. A record with <code>"status": "draft"</code> stays off the site; set it to <code>"published"</code> and press Publish. Text marked <code>[CHECK]</code> blocks publishing until someone confirms it.</p>
<ul><?php foreach ($tables as $t): ?><li><a href="/admin/table?table=<?= $h($t) ?>"><?= $h(ucfirst(str_replace('_', ' ', $t))) ?></a></li><?php endforeach; ?></ul>
