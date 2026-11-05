<?php
declare(strict_types=1);
// Builds the static site into public-site/ from the structured offer data.
//
//   php site/build.php                      build from site/data/offers.json
//   php site/build.php --source=URL_OR_FILE build from another copy of the data (the server's public feed)
//   php site/build.php --refresh            also save that data as site/data/offers.json
//
// Every offer page, table and statistic comes from the data; the guides are hand-written
// templates in site/pages/ that quote the data's numbers. Re-run after each weekly scan.

$root = __DIR__;
$CFG = require "$root/config.php";
foreach (['helpers', 'data', 'blocks', 'layout'] as $lib) require "$root/lib/$lib.php";

$opts = getopt('', ['source::', 'refresh']);
$source = $opts['source'] ?? $CFG['dataFile'];
$text = @file_get_contents($source);
if ($text === false) { fwrite(STDERR, "Cannot read data from $source\n"); exit(1); }
if (isset($opts['refresh'])) file_put_contents($CFG['dataFile'], $text);
$tmp = tempnam(sys_get_temp_dir(), 'offers');
file_put_contents($tmp, $text);
$DATA = load_data($tmp);
unlink($tmp);
$OFFERS = normalise_offers($DATA);
$STATS = compute_stats($OFFERS, $DATA);

// A live (non-draft) build must have no placeholders left.
if (!$CFG['draft']) {
    $bad = [];
    foreach (['siteName', 'baseUrl', 'contactEmail', 'publisher'] as $k) {
        if (stripos((string) $CFG[$k], 'CHANGE-ME') !== false) $bad[] = $k;
    }
    if ($bad) { fwrite(STDERR, 'Refusing to build a live site with placeholders in config.php: ' . implode(', ', $bad) . "\n"); exit(1); }
}

// ---- Page list --------------------------------------------------------------------------
$pages = [];
foreach (['home', 'offers-index', 'guides-index', 'guide-cass', 'guide-requirements', 'guide-direct-debits', 'guide-how-bonus',
    'cashback-sites', 'ongoing-accounts', 'about', 'how-we-make-money', 'how-we-get-our-data', 'contact', 'privacy', 'terms'] as $f) {
    $pages[] = ['file' => $f, 'vars' => []];
}
if (!empty($CFG['sections']['isas'])) $pages[] = ['file' => 'isas', 'vars' => []];
foreach ($OFFERS as $o) $pages[] = ['file' => 'offer', 'vars' => ['offer' => $o]];

function render_template(string $file, array $vars): array {
    global $CFG, $DATA, $OFFERS, $STATS;
    extract($vars);
    $meta = [];
    ob_start();
    include __DIR__ . "/pages/$file.php";
    $body = ob_get_clean();
    if (empty($meta['path']) || empty($meta['title']) || empty($meta['description'])) throw new RuntimeException("Page $file is missing path/title/description");
    return [$meta, $body];
}

// ---- Output -----------------------------------------------------------------------------
$out = $CFG['outDir'];
if (basename($out) !== 'public-site') throw new RuntimeException('Refusing to clear an output folder not named public-site');
// Empties a folder but keeps the folder itself (a preview server may be holding it open).
function empty_dir(string $d): void {
    if (!is_dir($d)) return;
    foreach (scandir($d) as $f) {
        if ($f === '.' || $f === '..') continue;
        $p = "$d/$f";
        if (is_dir($p)) { empty_dir($p); @rmdir($p); } else unlink($p);
    }
}
empty_dir($out);
if (!is_dir($out . '/assets')) mkdir($out . '/assets', 0777, true);
copy("$root/assets/style.css", "$out/assets/style.css");

$sitemap = [];
foreach ($pages as $p) {
    [$meta, $body] = render_template($p['file'], $p['vars']);
    $dir = $out . rtrim($meta['path'], '/');
    if (!is_dir($dir)) mkdir($dir, 0777, true);
    file_put_contents($dir . '/index.html', layout($meta, $body));
    if (empty($meta['noindex'])) $sitemap[] = $meta['path'];
}

// 404 page
$notFound = ['path' => '/404/', 'title' => 'Page not found', 'description' => 'That page does not exist. Try the current switch offers or the switching guides from the menu.', 'noindex' => true];
file_put_contents("$out/404.html", layout($notFound, '<h1>Page not found</h1><p>That page does not exist. Try the ' . a('/bank-switch-offers/', 'current switch offers') . ' or the ' . a('/guides/', 'guides') . '.</p>'));

// sitemap.xml and robots.txt
$lastmod = $STATS['asOf'] ?? date('Y-m-d');
$xml = '<?xml version="1.0" encoding="UTF-8"?>' . "\n" . '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' . "\n";
foreach ($sitemap as $path) $xml .= '  <url><loc>' . h(abs_url($path)) . '</loc><lastmod>' . h($lastmod) . "</lastmod></url>\n";
file_put_contents("$out/sitemap.xml", $xml . "</urlset>\n");
file_put_contents("$out/robots.txt", $CFG['draft'] ? "User-agent: *\nDisallow: /\n" : "User-agent: *\nAllow: /\n\nSitemap: " . abs_url('/sitemap.xml') . "\n");

echo 'Built ' . count($pages) . ' pages (' . count($OFFERS) . " offers) into $out\n";
