<?php
$meta = [
    'path' => '/about/',
    'title' => 'About ' . $CFG['siteName'],
    'description' => 'Who runs ' . $CFG['siteName'] . ', why it exists, what it covers and how it is kept accurate.',
    'crumbs' => [['/about/', 'About']],
];
?>
<h1>About <?= h($CFG['siteName']) ?></h1>
<p class="lead"><?= h($CFG['siteName']) ?> explains UK bank switch offers: what each one asks you to do, how the Current Account Switch Service protects you, and what is worth keeping once the bonus has paid.</p>

<h2>Why it exists</h2>
<p>Switch offers are described by banks in marketing language, and the real conditions sit in the small print: how many Direct Debits, how much to pay in, whether it has to be salary, which accounts rule you out. We read those conditions, break them into structured facts and publish them in the same plain layout for every offer, so that you can compare like with like.</p>

<h2>What we cover</h2>
<ul class="plain">
  <li><?= a('/bank-switch-offers/', 'Current switch offers') ?> and the rules behind each.</li>
  <li><?= a('/guides/', 'Guides') ?> on switching, the money tests and Direct Debits.</li>
  <li><?= a('/cashback-sites/', 'Cashback site comparisons') ?> for the same accounts.</li>
  <li><?= a('/ongoing-accounts/', 'Accounts that keep paying') ?> after the bonus.</li>
</ul>

<h2>How we keep it accurate</h2>
<p>The offer data is collected and checked on a regular schedule, and every page shows when it was last checked. Read <?= a('/how-we-get-our-data/', 'where our data comes from') ?> for how, and the limits. If you find something wrong, <?= a('/contact/', 'tell us') ?> and we will correct it.</p>

<h2>Who runs it</h2>
<p><?= h($CFG['siteName']) ?> is run by <?= h($CFG['publisher']) ?>, based in the <?= h($CFG['publisherPlace']) ?>. You can reach us on the <?= a('/contact/', 'contact page') ?>.</p>

<h2>What we are not</h2>
<p><?= h($CFG['fcaStatement']) ?> Nothing here is a personal recommendation. Whether an offer suits you depends on your circumstances, so read the bank’s own terms and, if you need advice, speak to a regulated adviser.</p>
<p>We make money from some of the links on this site: see <?= a('/how-we-make-money/', 'how we make money') ?>.</p>
