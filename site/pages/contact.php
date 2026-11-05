<?php
$meta = [
    'path' => '/contact/',
    'title' => 'Contact us',
    'description' => 'How to reach ' . $CFG['siteName'] . ': corrections, questions about the data, partnership enquiries and access to the planner.',
    'crumbs' => [['/contact/', 'Contact']],
];
?>
<h1>Contact us</h1>
<p class="lead">The quickest way to reach us is by email. We read everything and aim to reply within a few working days.</p>
<p><strong>Email:</strong> <a href="mailto:<?= h($CFG['contactEmail']) ?>"><?= h($CFG['contactEmail']) ?></a></p>
<p><strong>Run by:</strong> <?= h($CFG['publisher']) ?>, <?= h($CFG['publisherPlace']) ?></p>

<h2>What to write to us about</h2>
<ul class="plain">
  <li><strong>A correction.</strong> Say which page, what is wrong and, if you can, a link to the provider’s terms.</li>
  <li><strong>A question about how we work.</strong> See <?= a('/how-we-get-our-data/', 'where our data comes from') ?> first.</li>
  <li><strong>The planner.</strong> The planner that builds a switching sequence for you is invite-only while we test it. Ask for an invite here.</li>
  <li><strong>Partnerships.</strong> Providers and networks are welcome to get in touch; see <?= a('/how-we-make-money/', 'how we make money') ?> for how we work with them.</li>
</ul>
<p class="fine">We cannot give personal financial advice or help with problems on an account. Please contact your bank for those.</p>
