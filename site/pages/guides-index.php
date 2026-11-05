<?php
$meta = [
    'path' => '/guides/',
    'title' => 'Bank switching guides',
    'description' => 'Plain-English guides to switching bank accounts for a bonus: how the Current Account Switch Service works, the money and Direct Debit tests, and the rules that decide who gets paid.',
    'crumbs' => [['/guides/', 'Guides']],
];
?>
<h1>Bank switching guides</h1>
<p class="lead">Start here if you are new to switching. Each guide uses the figures from the offers we track, so the numbers stay current.</p>
<div class="cards">
  <a class="card" href="<?= h(url('/guides/current-account-switch-service/')) ?>"><h3>The Current Account Switch Service</h3><p>How a switch runs in seven working days, what the guarantee covers, and how your money is protected.</p></a>
  <a class="card" href="<?= h(url('/guides/switch-bonus-requirements/')) ?>"><h3>Money-in requirements</h3><p>Salary, pay-in and card-payment tests, how long money must stay, and bonuses paid in instalments.</p></a>
  <a class="card" href="<?= h(url('/guides/direct-debits-for-switch-offers/')) ?>"><h3>Direct Debit requirements</h3><p>Why offers ask for two or three, what counts, and how to set up the ones you are missing.</p></a>
  <a class="card" href="<?= h(url('/guides/how-a-switch-bonus-works/')) ?>"><h3>How a switch bonus works</h3><p>Eligibility, banking groups, deadlines and the credit-file footprint, from application to payment.</p></a>
</div>
<h2>Also on the site</h2>
<ul class="plain">
  <li><?= a('/bank-switch-offers/', 'Current switch offers') ?>: every offer we track, with what it asks for.</li>
  <li><?= a('/cashback-sites/', 'Cashback sites compared') ?>: TopCashback and Quidco for the same accounts.</li>
  <li><?= a('/ongoing-accounts/', 'Accounts that keep paying') ?>: bills cashback, salary matching and yearly payments.</li>
</ul>
