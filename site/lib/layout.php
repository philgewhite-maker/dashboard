<?php
// The page shell: head tags, header, footer, structured data.

function nav_items(): array {
    global $CFG;
    $items = [
        ['/bank-switch-offers/', 'Switch offers'],
        ['/guides/', 'Guides'],
        ['/cashback-sites/', 'Cashback sites'],
        ['/ongoing-accounts/', 'Ongoing accounts'],
    ];
    if (!empty($CFG['sections']['isas'])) $items[] = ['/isas/', 'ISAs'];
    return $items;
}

function layout(array $meta, string $body): string {
    global $CFG, $STATS;
    $path = $meta['path'];
    $title = $meta['title'] . ($path === '/' ? '' : ' | ' . $CFG['siteName']);
    if ($path === '/') $title = $CFG['siteName'] . ': ' . $CFG['tagline'];
    $desc = $meta['description'];
    $canon = abs_url($path);
    $robots = $CFG['draft'] ? 'noindex, nofollow' : (!empty($meta['noindex']) ? 'noindex, follow' : 'index, follow');

    $ld = [];
    if ($path === '/') {
        $ld[] = ['@context' => 'https://schema.org', '@type' => 'WebSite', 'name' => $CFG['siteName'], 'url' => abs_url('/')];
        $ld[] = ['@context' => 'https://schema.org', '@type' => 'Organization', 'name' => $CFG['siteName'], 'url' => abs_url('/'), 'email' => $CFG['contactEmail']];
    }
    if (!empty($meta['crumbs'])) {
        $list = [['@type' => 'ListItem', 'position' => 1, 'name' => 'Home', 'item' => abs_url('/')]];
        foreach ($meta['crumbs'] as $i => [$cp, $ct]) $list[] = ['@type' => 'ListItem', 'position' => $i + 2, 'name' => $ct, 'item' => abs_url($cp)];
        $ld[] = ['@context' => 'https://schema.org', '@type' => 'BreadcrumbList', 'itemListElement' => $list];
    }
    if (!empty($meta['article'])) {
        $ld[] = ['@context' => 'https://schema.org', '@type' => 'Article', 'headline' => $meta['title'], 'description' => $desc, 'mainEntityOfPage' => $canon,
            'dateModified' => $STATS['asOf'] ?? date('Y-m-d'), 'author' => ['@type' => 'Organization', 'name' => $CFG['siteName']], 'publisher' => ['@type' => 'Organization', 'name' => $CFG['siteName']]];
    }
    if (!empty($meta['faq'])) $ld[] = faq_jsonld($meta['faq']);
    $ldHtml = '';
    foreach ($ld as $block) $ldHtml .= '<script type="application/ld+json">' . json_encode($block, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "</script>\n";

    $nav = '';
    foreach (nav_items() as [$p, $label]) {
        $on = $p === '/' ? $path === '/' : strpos($path, rtrim($p, '/')) === 0;
        $nav .= '<a href="' . h(url($p)) . '"' . ($on ? ' aria-current="page"' : '') . '>' . h($label) . '</a>';
    }
    $nav .= '<a class="nav-cta" href="' . h($CFG['plannerUrl']) . '" rel="noopener">Planner</a>';

    $crumbs = '';
    if (!empty($meta['crumbs'])) {
        $crumbs = '<nav class="crumbs" aria-label="Breadcrumb"><a href="' . h(url('/')) . '">Home</a>';
        foreach ($meta['crumbs'] as $i => [$cp, $ct]) {
            $crumbs .= ' <span aria-hidden="true">/</span> ' . ($i === count($meta['crumbs']) - 1 ? '<span aria-current="page">' . h($ct) . '</span>' : '<a href="' . h(url($cp)) . '">' . h($ct) . '</a>');
        }
        $crumbs .= '</nav>';
    }

    $draft = $CFG['draft'] ? '<div class="draft-bar">Draft preview: placeholders (name, domain, contact details) are not filled in and search engines are told not to index it.</div>' : '';
    $guides = [['/guides/current-account-switch-service/', 'The Current Account Switch Service'], ['/guides/switch-bonus-requirements/', 'Money-in requirements'], ['/guides/direct-debits-for-switch-offers/', 'Direct Debit requirements'], ['/guides/how-a-switch-bonus-works/', 'How a switch bonus works']];
    $gl = '';
    foreach ($guides as [$gp, $gt]) $gl .= '<li>' . a($gp, h($gt)) . '</li>';

    $year = date('Y');
    return '<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>' . h($title) . '</title>
<meta name="description" content="' . h($desc) . '">
<meta name="robots" content="' . h($robots) . '">
<link rel="canonical" href="' . h($canon) . '">
<meta property="og:type" content="website">
<meta property="og:site_name" content="' . h($CFG['siteName']) . '">
<meta property="og:title" content="' . h($title) . '">
<meta property="og:description" content="' . h($desc) . '">
<meta property="og:url" content="' . h($canon) . '">
<meta name="theme-color" content="#0f5c63">
<link rel="stylesheet" href="' . h(url('/assets/style.css')) . '">
' . $ldHtml . '</head>
<body>
<a class="skip" href="#main">Skip to the content</a>
' . $draft . '
<header class="site-header">
  <div class="wrap bar">
    <a class="brand" href="' . h(url('/')) . '">' . h($CFG['siteName']) . '</a>
    <nav class="main-nav" aria-label="Main">' . $nav . '</nav>
  </div>
</header>
<main id="main" class="wrap">
' . $crumbs . $body . '
</main>
<footer class="site-footer">
  <div class="wrap">
    <div class="foot-cols">
      <div><h2>Guides</h2><ul>' . $gl . '</ul></div>
      <div><h2>About this site</h2><ul>
        <li>' . a('/about/', 'About us') . '</li>
        <li>' . a('/how-we-make-money/', 'How we make money') . '</li>
        <li>' . a('/how-we-get-our-data/', 'Where our data comes from') . '</li>
        <li>' . a('/contact/', 'Contact') . '</li></ul></div>
      <div><h2>Legal</h2><ul>
        <li>' . a('/privacy/', 'Privacy and cookies') . '</li>
        <li>' . a('/terms/', 'Terms of use') . '</li></ul></div>
    </div>
    <p class="fine">' . h($CFG['fcaStatement']) . ' Offers, rates and terms are set by providers and change often: always read the provider’s own terms before you apply. Some links are affiliate links; see ' . a('/how-we-make-money/', 'how we make money') . '.</p>
    <p class="fine">&copy; ' . $year . ' ' . h($CFG['siteName']) . '. Run by ' . h($CFG['publisher']) . ', ' . h($CFG['publisherPlace']) . '.' . ($STATS['asOf'] ? ' Offer data last checked ' . h(pretty_date($STATS['asOf'])) . '.' : '') . '</p>
  </div>
</footer>
</body>
</html>
';
}
