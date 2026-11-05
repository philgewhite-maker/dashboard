<?php
$meta = [
    'path' => '/how-we-get-our-data/',
    'title' => 'Where our data comes from, and its limits',
    'description' => 'How we collect switch offer details, turn the terms into structured facts, check them and keep them current, and what that process cannot promise.',
    'crumbs' => [['/how-we-get-our-data/', 'Where our data comes from']],
];
?>
<h1>Where our data comes from, and its limits</h1>
<p class="lead">Every number on this site comes from structured data, not hand-typed tables. Here is how it is made, and where it can be wrong.</p>

<h2>How it is collected</h2>
<ol class="steps">
  <li><strong>Gathering.</strong> Each week we read public sources on switch offers: published offer listings and comparison guides, cashback-site listings, and the providers’ own pages.</li>
  <li><strong>Extracting.</strong> Software reads the conditions and turns them into named fields: the bonus payments, the Direct Debit count, any salary or pay-in test (with amounts, time limits and how the money may be sourced), exclusions and deadlines.</li>
  <li><strong>Checking.</strong> The extraction is checked for internal consistency, and the offer’s own wording is kept next to the structured facts so you can compare the two.</li>
  <li><strong>Publishing.</strong> The pages are rebuilt from the data, and each shows the date of the last check.</li>
</ol>

<h2>What this means</h2>
<ul class="plain">
  <li>The same rules produce every page, so offers are described consistently.</li>
  <li>Extraction can misread unusual wording. We show the offer’s own wording beside our summary so that you can see when they differ, and we recommend you read the provider’s terms before applying.</li>
  <li>Offers change, sometimes within days. The date of the last check is on each page, and the provider’s current terms always take priority over anything here.</li>
</ul>

<h2>Sources we cite</h2>
<p>For general information we link to the primary source on each guide: <?= ext('https://www.wearepay.uk/what-we-do/switching-services/current-account-switch-service/', 'Pay.UK') ?> for the Current Account Switch Service, and the <?= ext('https://www.fscs.org.uk/what-we-cover/banks-building-societies-credit-unions/deposit-limit-increase/', 'FSCS') ?> and <?= ext('https://www.bankofengland.co.uk/explainers/what-is-the-financial-services-compensation-scheme', 'Bank of England') ?> for deposit protection.</p>

<h2>Spot a mistake?</h2>
<p><?= a('/contact/', 'Tell us') ?> which page and what is wrong, ideally with a link to the provider’s terms. We check and correct it.</p>
