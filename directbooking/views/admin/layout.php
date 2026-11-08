<?php
/** @var string $title @var string $body @var ?array $me @var ?array $flash @var string $csrf @var array $site @var bool $operator */
$h = 'Util::h';
?><!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title><?= $h($title) ?> | Admin</title><link rel="stylesheet" href="/assets/site.css"></head>
<body class="admin">
<header class="top"><a class="brand" href="/admin"><?= $h($site['name']) ?> admin</a>
<?php if ($me): ?><nav><a href="/admin">Bookings</a><?php if ($operator): ?><a href="/admin/table">Content</a><a href="/admin/adjustments">Airbnb changes</a><?php endif; ?>
<form method="post" action="/admin/logout" class="inline"><input type="hidden" name="csrf" value="<?= $h($csrf) ?>"><button class="link"><?= $h($me['name']) ?>: sign out</button></form></nav><?php endif; ?>
</header>
<main>
<?php if ($flash): ?><div class="flash"><?php if (isset($flash['html'])): ?><?= $flash['html'] ?><?php else: ?><?= $h($flash['text']) ?><?php if (!empty($flash['booking'])): ?> <a href="/admin/booking?id=<?= $h($flash['booking']) ?>">Open <?= $h($flash['ref']) ?></a><?php endif; ?><?php endif; ?></div><?php endif; ?>
<h1><?= $h($title) ?></h1>
<?= str_replace('{{csrf}}', '<input type="hidden" name="csrf" value="' . $h($csrf) . '">', $body) ?>
</main></body></html>
