<?php
$meta = [
    'path' => '/terms/',
    'title' => 'Terms of use',
    'description' => 'The terms for using ' . $CFG['siteName'] . ': information not advice, accuracy of offer data, third-party links and limits of liability.',
    'crumbs' => [['/terms/', 'Terms of use']],
];
?>
<h1>Terms of use</h1>
<p class="fine">By using this site you accept these terms. They are written in plain English; if anything is unclear, <?= a('/contact/', 'ask us') ?>.</p>

<h2>Information, not advice</h2>
<p>Everything on this site is general information. <?= h($CFG['fcaStatement']) ?> Whether a bank account or offer is right for you depends on your circumstances; read the provider’s own terms and take advice if you need it.</p>

<h2>Accuracy of offers</h2>
<p>Offers, bonuses, fees and rules are set by providers and change often. We make reasonable efforts to keep the information correct and show when it was last checked, but we cannot promise that it is complete or current. The provider’s terms at the time you apply are the ones that count.</p>

<h2>Links to other sites</h2>
<p>We link to banks, cashback sites and other third parties. We do not control those sites and are not responsible for their content or practices. Some links are affiliate links; see <?= a('/how-we-make-money/', 'how we make money') ?>.</p>

<h2>Limits of liability</h2>
<p>We do not accept responsibility for losses that arise from relying on the information on this site, to the extent the law allows. Nothing here limits liability that cannot lawfully be limited.</p>

<h2>Our content</h2>
<p>The text and layout of this site belong to <?= h($CFG['publisher']) ?>. You may quote short extracts with a link back to the page, but please do not copy pages wholesale.</p>

<h2>Changes</h2>
<p>We may change these terms from time to time. The date of the last data check is shown in the page footer, and the current terms are always on this page.</p>
