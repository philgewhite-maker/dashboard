<?php
// Checks every internal link and asset in the built site resolves to a file, that each page has
// one h1, a title and a meta description, and that no external link opens without rel=noopener.
//   php site/check-links.php
$out = dirname(__DIR__) . '/public-site';
$cfg = require __DIR__ . '/config.php';
$base = rtrim($cfg['basePath'], '/');
$bad = 0;
$pages = 0;
$it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($out, FilesystemIterator::SKIP_DOTS));
foreach ($it as $f) {
    if (substr($f->getFilename(), -5) !== '.html') continue;
    $pages++;
    $rel = str_replace('\\', '/', substr($f->getPathname(), strlen($out)));
    $html = file_get_contents($f->getPathname());
    $problems = [];
    if (substr_count($html, '<h1') !== 1) $problems[] = 'expected exactly one h1, found ' . substr_count($html, '<h1');
    if (!preg_match('/<title>[^<]{5,}<\/title>/', $html)) $problems[] = 'missing title';
    if (!preg_match('/<meta name="description" content="[^"]{40,}"/', $html)) $problems[] = 'missing or short meta description';
    if (preg_match_all('/(?:href|src)="([^"]+)"/', $html, $m)) {
        foreach (array_unique($m[1]) as $u) {
            if (preg_match('#^(https?:|mailto:|tel:|\#)#', $u)) continue;
            $path = strtok($u, '#?');
            if ($base !== '' && strpos($path, $base) === 0) $path = substr($path, strlen($base));
            $target = $out . $path;
            if (!(is_file($target) || is_file(rtrim($target, '/') . '/index.html'))) $problems[] = "broken link $u";
        }
    }
    if (preg_match_all('/<a [^>]*href="https?:[^"]+"[^>]*>/', $html, $m)) {
        foreach ($m[0] as $tag) if (strpos($tag, 'target="_blank"') !== false && strpos($tag, 'noopener') === false) $problems[] = 'external link without noopener: ' . substr($tag, 0, 80);
    }
    if ($problems) { $bad += count($problems); echo "$rel\n  - " . implode("\n  - ", $problems) . "\n"; }
}
echo "$pages pages checked, $bad problems\n";
exit($bad ? 1 : 0);
