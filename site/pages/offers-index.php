<?php
$meta = [
    'path' => '/bank-switch-offers/',
    'title' => 'Current bank switch offers',
    'description' => 'Every current UK bank switch offer we track, with the bonus, the Direct Debits, the pay-in or salary it needs, the fee and the deadline. Updated from the weekly check.',
    'crumbs' => [['/bank-switch-offers/', 'Switch offers']],
    'article' => true,
];
$noSalary = array_values(array_filter($OFFERS, fn($o) => !$o['needsSalary']));
?>
<h1>Current bank switch offers</h1>
<p class="lead"><?= $STATS['count'] ?> offers from <?= $STATS['banks'] ?> banks, listed biggest bonus first. Open an offer to see exactly what it asks for, who is excluded and when the bonus is paid.</p>
<?= updated_line($STATS) ?>

<?= offers_table($OFFERS) ?>
<?= disclosure_note() ?>

<h2>How to read the table</h2>
<ul class="plain">
  <li><strong>Bonus</strong> is everything the offer pays if you meet every condition, added up. Some are paid in instalments over several months.</li>
  <li><strong>What it asks for</strong> shows the main tests: a <em>salary</em> test needs pay from an employer, a <em>pay-in</em> test needs a set amount paid in, and the Direct Debit count is how many must move across. See <?= a('/guides/switch-bonus-requirements/', 'the money-in guide') ?> and <?= a('/guides/direct-debits-for-switch-offers/', 'the Direct Debit guide') ?>.</li>
  <li><strong>Start by</strong> is the date the switch must be started by, where the offer has one.</li>
</ul>

<?php if ($noSalary): ?>
<h2>Offers with no salary test</h2>
<p><?= count($noSalary) ?> of the <?= $STATS['count'] ?> offers do not ask for salary paid in by an employer, so they can suit people who are between jobs, self-employed or retired. They may still ask for a pay-in or Direct Debits.</p>
<ul class="plain">
<?php foreach ($noSalary as $o): ?>
  <li><?= a('/bank-switch-offers/' . $o['slug'] . '/', h($o['product'])) ?>: <?= gbp($o['total']) ?></li>
<?php endforeach; ?>
</ul>
<?php endif; ?>

<?= callout('info', '<strong>Check before you apply.</strong> Offers change often and each bank’s own terms are the final word. We link to the provider on every offer page so you can read them.') ?>
