<?php
$groups = $DATA['bankGroups'] ?? [];
$deadlines = array_values(array_filter($OFFERS, fn($o) => $o['deadline']));
$faq = [
    ['Can I get a bonus from the same bank twice?', '<p>Usually not. Most offers exclude anyone who has had a switch bonus from that bank, or its banking group, before, and some set a look-back date. The rule for each offer is on its page.</p>'],
    ['Can I switch from a bank to another in the same group?', '<p>Not for an offer. The new account has to come from a different banking group from the one you are switching from. The offer pages list the groups each one excludes.</p>'],
    ['Do banks pay on time?', '<p>Each offer states a payment window, commonly some weeks after the conditions are met. If it is late, contact the bank with proof of meeting the conditions, and keep your records.</p>'],
    ['Are switch bonuses taxable?', '<p>We do not give tax advice. How a bonus is treated can depend on your circumstances, so check HMRC’s guidance or ask an adviser.</p>'],
    ['What happens if an offer ends while I am part way through?', '<p>That depends on the offer’s terms and on when you applied. Keep the terms that applied when you opened the account, and contact the bank if you are unsure.</p>'],
];
$meta = [
    'path' => '/guides/how-a-switch-bonus-works/',
    'title' => 'How a bank switch bonus works: eligibility, timing and the rules that catch people out',
    'description' => 'The life of a switch bonus from application to payment, with the rules that decide who can get one: banking groups, previous bonuses, deadlines and the credit-file footprint.',
    'crumbs' => [['/guides/', 'Guides'], ['/guides/how-a-switch-bonus-works/', 'How a switch bonus works']],
    'article' => true,
    'faq' => $faq,
];
?>
<h1>How a bank switch bonus works</h1>
<p class="lead">A switch bonus is a payment a bank makes to win your current account. It is conditional: you have to be eligible, switch properly, and then meet the tests. This guide covers the order things happen in and the rules that trip people up.</p>
<?= updated_line($STATS) ?>

<nav class="toc" aria-label="On this page"><strong>On this page</strong>
  <ol><li><a href="#life">From application to payment</a></li><li><a href="#groups">Banking groups</a></li><li><a href="#past">Accounts and bonuses you have had before</a></li><li><a href="#deadlines">Deadlines</a></li><li><a href="#credit">Your credit file</a></li><li><a href="#after">After the bonus</a></li></ol></nav>

<section id="life">
  <h2>From application to payment</h2>
  <ol class="steps">
    <li><strong>Check you are eligible.</strong> Read the exclusions on the offer’s page before applying.</li>
    <li><strong>Apply for the account</strong>, usually through the bank’s app or website.</li>
    <li><strong>Prepare:</strong> Direct Debits in place, and any pay-in or salary arranged (see the <?= a('/guides/switch-bonus-requirements/', 'requirements guide') ?> and the <?= a('/guides/direct-debits-for-switch-offers/', 'Direct Debit guide') ?>).</li>
    <li><strong>Start the switch</strong> with the Current Account Switch Service. It completes in <?= a('/guides/current-account-switch-service/', 'seven working days') ?>.</li>
    <li><strong>Meet the tests</strong> within the offer’s time limits.</li>
    <li><strong>The bonus is paid</strong> within the window the offer states.</li>
  </ol>
</section>

<section id="groups">
  <h2>Banking groups: one bonus per group</h2>
  <p>Many familiar brands are one bank. A bonus offer from one of them generally excludes you if you hold an account with, or have had a bonus from, anything in the same group. Our data treats these as groups:</p>
  <ul class="plain">
  <?php foreach ($groups as $g): ?><li><?= h(join_and($g)) ?></li><?php endforeach; ?>
  </ul>
  <p>Some offers go further and exclude specific other banks as the account you switch <em>from</em>. The page for each offer lists these under “Who cannot get it”.</p>
</section>

<section id="past">
  <h2>Accounts and bonuses you have had before</h2>
  <p>Typical exclusions are holding a current account with the bank (or its group) on a stated date, or having received a switch bonus from it within a look-back period. These rules are the reason a plan that works for one person fails for another, so they are worth checking first.</p>
</section>

<section id="deadlines">
  <h2>Deadlines</h2>
  <?php if ($deadlines): ?>
  <p>Some offers have a date by which the switch has to start. At the time of the last check:</p>
  <ul class="plain"><?php foreach ($deadlines as $o): ?><li><?= a('/bank-switch-offers/' . $o['slug'] . '/', h($o['product'])) ?>: start by <?= h(pretty_date($o['deadline'])) ?></li><?php endforeach; ?></ul>
  <?php else: ?><p>None of the offers we track currently state a date by which the switch must start, though offers can be withdrawn at any time.</p><?php endif; ?>
  <p>Offers can be changed or withdrawn without notice, so check the bank’s page on the day you apply.</p>
</section>

<section id="credit">
  <h2>Your credit file</h2>
  <p>Banks normally check your credit record when you apply for an account, and some do a search that other lenders can see. A switch itself is not a credit application, but each new account you open is. If you plan several, leave gaps between them and avoid applying for other credit at the same time, particularly if you are about to apply for a mortgage.</p>
</section>

<section id="after">
  <h2>After the bonus</h2>
  <p>Once a bonus has been paid you are free to keep the account or switch away from it. Some accounts keep paying: see <?= a('/ongoing-accounts/', 'accounts that keep paying') ?>. Banks can change fees and benefits, so check what an account costs to keep before you leave it open.</p>
</section>

<?= faq_html($faq) ?>
<section class="sources"><h2>Sources</h2><p>Offer-specific rules come from each offer’s terms as extracted; see <?= a('/how-we-get-our-data/', 'where our data comes from') ?>. Banking-group information comes from the same extraction and from each bank’s published terms.</p></section>
