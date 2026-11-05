<?php
// One page per offer, built entirely from that offer's structured fields. $offer is set by build.php.
$o = $offer;
$meta = [
    'path' => '/bank-switch-offers/' . $o['slug'] . '/',
    'title' => $o['product'] . ' switch offer: ' . gbp($o['total']) . ' bonus and what it asks for',
    'description' => $o['product'] . ' pays ' . gbp($o['total']) . ' for switching to it. What you need to do: ' . ($o['ddNeeded'] ? $o['ddNeeded'] . ' Direct Debits, ' : '') . ($o['needsSalary'] ? ($o['salaryMax'] ? gbp($o['salaryMax']) . '+ salary, ' : 'salary paid in, ') : '') . ($o['needsPayIn'] ? gbp($o['payInMax']) . ' paid in, ' : '') . 'who is excluded and when it pays.',
    'crumbs' => [['/bank-switch-offers/', 'Switch offers'], ['/bank-switch-offers/' . $o['slug'] . '/', $o['product']]],
    'article' => true,
];
$elig = eligibility_items($o);
$sameGroup = array_values(array_filter($OFFERS, fn($x) => $x['slug'] !== $o['slug'] && count(array_intersect($x['group'], $o['group']))));
$other = array_values(array_filter($OFFERS, fn($x) => $x['slug'] !== $o['slug'] && !count(array_intersect($x['group'], $o['group']))));
$other = array_slice($other, 0, 4);
?>
<h1><?= h($o['product']) ?>: <?= gbp($o['total']) ?> switch bonus</h1>
<p class="lead"><?php
$bits = [];
if ($o['ddNeeded']) $bits[] = 'move ' . $o['ddNeeded'] . '+ Direct Debits across';
if ($o['needsSalary']) $bits[] = $o['salaryMax'] ? 'have ' . gbp($o['salaryMax']) . '+ salary paid in' : 'have salary paid in';
if ($o['needsPayIn']) $bits[] = 'pay in ' . gbp($o['payInMax']) . '+';
?>
<?= h($o['bank']) ?> pays <strong><?= gbp($o['total']) ?></strong> in total to people who switch to the <?= h($o['product']) ?> <?= $bits ? 'and ' . h(join_and($bits)) . '.' : 'and meet its conditions.' ?></p>
<?= updated_line($STATS) ?>
<?= cta_box($o) ?>

<section>
  <h2>At a glance</h2>
  <dl class="glance">
    <div><dt>Total bonus</dt><dd><?= gbp($o['total']) ?></dd></div>
    <div><dt>Switch needed</dt><dd><?= !empty($o['switch']['required']) ? 'Yes, a full Current Account Switch' : 'No' ?></dd></div>
    <div><dt>Direct Debits</dt><dd><?= $o['ddNeeded'] ? h($o['ddNeeded']) . '+ moved across' : 'None required' ?></dd></div>
    <div><dt>Salary test</dt><dd><?= $o['needsSalary'] ? ($o['salaryMax'] ? gbp($o['salaryMax']) . '+ from an employer' : 'Salary from an employer') : 'None' ?></dd></div>
    <div><dt>Pay-in test</dt><dd><?= $o['needsPayIn'] ? gbp($o['payInMax']) . '+' : 'None' ?></dd></div>
    <div><dt>Monthly fee</dt><dd><?= $o['monthlyFee'] ? gbp($o['monthlyFee']) . (!empty($o['fees']['waivedBy']) ? ' (waived by ' . h($o['fees']['waivedBy']) . ')' : '') : 'None' ?></dd></div>
    <div><dt>Joint accounts</dt><dd><?= !empty($o['jointAllowed']) ? 'Allowed' : 'Not available' ?></dd></div>
    <div><dt>Start by</dt><dd><?= $o['deadline'] ? h(pretty_date($o['deadline'])) : 'No date set' ?></dd></div>
  </dl>
</section>

<section>
  <h2>What you need to do to get the bonus</h2>
  <?= requirements_html($o) ?>
  <p class="fine">Not sure what a test means? See <?= a('/guides/switch-bonus-requirements/', 'the money-in guide') ?> and <?= a('/guides/direct-debits-for-switch-offers/', 'the Direct Debit guide') ?>.</p>
</section>

<section>
  <h2>When you are paid</h2>
  <?= payments_html($o) ?>
</section>

<?php if ($elig): ?>
<section>
  <h2>Who cannot get it</h2>
  <ul class="plain"><?php foreach ($elig as $e) echo '<li>' . $e . '</li>'; ?></ul>
</section>
<?php endif; ?>

<section>
  <h2>Opening the account</h2>
  <?php if (!empty($o['howToOpen'])): ?><p><?= h($o['howToOpen']) ?></p><?php endif; ?>
  <p>Ask <?= h($o['bank']) ?> to start the Current Account Switch from the account you are leaving. It takes seven working days and closes the old account; see <?= a('/guides/current-account-switch-service/', 'how the service works') ?>.</p>
</section>

<?php if (!empty($o['perks']) || !empty($o['ongoing'])): ?>
<section>
  <h2>Extras</h2>
  <ul class="plain">
  <?php foreach (array_merge($o['perks'] ?? [], $o['ongoing'] ?? []) as $x): ?>
    <li><?= h($x['name']) ?><?= !empty($x['annualValue']) ? ' (about ' . gbp($x['annualValue']) . ' a year)' : '' ?></li>
  <?php endforeach; ?>
  </ul>
</section>
<?php endif; ?>

<?php if (!empty($o['conditions'])): ?>
<section>
  <h2>The terms in full</h2>
  <details class="wording"><summary>Show the offer’s conditions as extracted</summary><p><?= h($o['conditions']) ?></p></details>
  <p class="fine">This is a summary of the offer’s terms and may be out of date; the bank’s own terms apply. Last checked <?= h(pretty_date($STATS['asOf'])) ?>.</p>
</section>
<?php endif; ?>

<?php if ($sameGroup): ?>
<?= callout('warn', '<strong>One bonus per banking group.</strong> ' . h(join_and($o['group'])) . ' ' . (count($o['group']) > 1 ? 'are' : 'is') . ' treated as one banking group, so you generally cannot collect bonuses from more than one of its accounts at a time. Also in this group: ' . join_and(array_map(fn($x) => a('/bank-switch-offers/' . $x['slug'] . '/', h($x['product'])), $sameGroup)) . '.') ?>
<?php endif; ?>

<?php if ($other): ?>
<section>
  <h2>Other offers to compare</h2>
  <?= offers_table($other) ?>
</section>
<?php endif; ?>
<?= disclosure_note() ?>
