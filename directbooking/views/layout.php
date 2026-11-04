<?php
/** @var array $site @var string $title @var string $description @var string $path @var string $body */
$h = 'Util::h';
$canonical = $canonical ?? (rtrim($site['base_url'], '/') . $path);
$jsonld = $jsonld ?? [];
?><!doctype html>
<html lang="<?= $h($site['lang']) ?>">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title><?= $h($title) ?></title>
<meta name="description" content="<?= $h($description) ?>">
<link rel="canonical" href="<?= $h($canonical) ?>">
<?php if (empty($site['indexable'])): ?><meta name="robots" content="noindex"><?php endif; ?>
<meta property="og:title" content="<?= $h($title) ?>">
<meta property="og:description" content="<?= $h($description) ?>">
<meta property="og:url" content="<?= $h($canonical) ?>">
<?php if (!empty($og_image)): ?><meta property="og:image" content="<?= $h($og_image) ?>">
<?php endif; ?>
<link rel="stylesheet" href="/assets/site.css">
<?php if (!empty($site['accent'])): ?><style>:root{--accent:<?= $h($site['accent']) ?>}<?php if (!empty($site['accent_dark'])): ?>@media (prefers-color-scheme: dark){:root{--accent:<?= $h($site['accent_dark']) ?>}}<?php endif; ?></style><?php endif; ?>
<?php foreach ($jsonld as $j): ?>
<script type="application/ld+json"><?= json_encode($j, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_HEX_TAG) ?></script>
<?php endforeach; ?>
</head>
<body>
<header class="top">
  <a class="brand" href="/"><?= $h($site['name']) ?></a>
  <nav><a href="/#rooms">Rooms</a><?php if ($site['show_events'] ?? true): ?><a href="/events/">Events</a><?php endif; ?><a href="/policies/">Policies</a></nav>
</header>
<main>
<?= $body ?>
</main>
<footer class="foot">
  <p>Book directly with the hosts. Questions: <a href="mailto:<?= $h($site['operator_email']) ?>"><?= $h($site['operator_email']) ?></a></p>
  <p><a href="/policies/">Cancellation, payment and privacy</a></p>
</footer>
<?php if (!empty($widget)): ?><script src="/assets/book.js" defer></script><?php endif; ?>
</body>
</html>
