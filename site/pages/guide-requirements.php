<?php
$salaryOffers = array_values(array_filter($OFFERS, fn($o) => $o['needsSalary']));
$payInOffers = array_values(array_filter($OFFERS, fn($o) => $o['needsPayIn']));
$staged = array_values(array_filter($OFFERS, fn($o) => array_sum(array_column($o['payments'], 'count')) > 1));

// The first requirement of a type in an offer, for the tables.
function first_req(array $o, string $type): ?array {
    foreach ($o['requirements'] as $r) if ($r['type'] === $type) return $r;
    return null;
}
function window_text(?array $r): string {
    if (!$r) return '';
    if (($r['period'] ?? '') === 'each-month') return 'each month' . (!empty($r['months']) && $r['months'] > 1 ? ' for ' . (int) $r['months'] . ' months' : '');
    return !empty($r['withinDays']) ? 'within ' . (int) $r['withinDays'] . ' days' : 'as the terms set out';
}
$example = null;
foreach ($OFFERS as $o) if ($o['needsPayIn'] && !$o['needsSalary']) { $example = $o; break; }

$faq = [
    ['Does the money I pay in have to be new money?', '<p>That depends on the offer. Some terms say salary or a transfer from outside the bank is needed; others accept a transfer from an account of your own. The offer’s own wording decides, and we show it on each offer page. If the terms are unclear, ask the bank in writing before you rely on it.</p>'],
    ['Can I move the money out again afterwards?', '<p>Often, once the conditions are met and any “must stay” period has passed. Offers differ, and some ask for the account to be kept open for a period or for payments to recur, so check before moving it.</p>'],
    ['What if I miss a month of a salary test?', '<p>It depends. Some offers let you qualify for later instalments even if you miss a month; others do not. The wording for each is on its offer page.</p>'],
    ['Do I need a salary to get a switch bonus?', '<p>Not for all of them: ' . $STATS['noSalaryCount'] . ' of the ' . $STATS['count'] . ' offers we track have no salary test. They may still ask for a pay-in or Direct Debits.</p>'],
];
$meta = [
    'path' => '/guides/switch-bonus-requirements/',
    'title' => 'Switch bonus requirements: pay-in, salary and balance tests explained',
    'description' => 'What the money tests on bank switch offers actually mean: salary from an employer, a minimum pay-in, how long it must stay, card payments and staged bonuses, with the figures from every offer we track.',
    'crumbs' => [['/guides/', 'Guides'], ['/guides/switch-bonus-requirements/', 'Money-in requirements']],
    'article' => true,
    'faq' => $faq,
];
?>
<h1>Switch bonus requirements: the money tests explained</h1>
<p class="lead">Most switch offers do not pay on opening alone. They ask you to move money through the new account in a particular way. This guide explains each kind of test and shows the figures for every offer we track.</p>
<?= updated_line($STATS) ?>

<nav class="toc" aria-label="On this page"><strong>On this page</strong>
  <ol><li><a href="#kinds">The kinds of test</a></li><li><a href="#salary">Salary tests</a></li><li><a href="#payin">Pay-in tests</a></li><li><a href="#stay">How long money must stay</a></li><li><a href="#staged">Bonuses paid in instalments</a></li><li><a href="#timeline">A worked timeline</a></li></ol></nav>

<section id="kinds">
  <h2>The kinds of test</h2>
  <p>Across the <?= $STATS['count'] ?> offers we track, you will meet these:</p>
  <ul class="plain">
    <li><strong>Salary</strong>: pay arriving from an employer. <?= $STATS['needSalary'] ?> of the <?= $STATS['count'] ?> offers have one.</li>
    <li><strong>Pay-in</strong>: a set amount paid in, from <?= gbp($STATS['payInMin']) ?> to <?= gbp($STATS['payInMax']) ?> across the offers that have one (<?= $STATS['needPayIn'] ?> offers).</li>
    <li><strong>Direct Debits</strong>: a number moved across (<?= a('/guides/direct-debits-for-switch-offers/', 'covered in its own guide') ?>).</li>
    <li><strong>Debit card payments</strong>: a count of purchases, often every month for a period.</li>
    <li><strong>App log-in</strong>: a one-off login to the bank’s app.</li>
  </ul>
  <p>A test almost always has a clock on it: “within 30 days of opening”, or “each month for five months”. Starting the clock too early, before the Direct Debits and payments are ready, is the most common reason a bonus is missed.</p>
</section>

<section id="salary">
  <h2>Salary tests</h2>
  <p>A salary test asks for pay arriving from an employer. The terms usually say what counts: typically a payment by Bacs from an employer, and sometimes a pension or benefits payment. They often say that a transfer from your own accounts does <em>not</em> count, which is why it matters to read the wording rather than assume.</p>
  <?php if ($salaryOffers): ?>
  <div class="table-wrap"><table class="data"><thead><tr><th>Offer</th><th class="num">Salary needed</th><th>How long</th></tr></thead><tbody>
  <?php foreach ($salaryOffers as $o): $r = first_req($o, 'salary'); ?>
    <tr><td data-label="Offer"><?= a('/bank-switch-offers/' . $o['slug'] . '/', h($o['product'])) ?></td><td data-label="Salary needed" class="num"><?= $o['salaryMax'] ? gbp($o['salaryMax']) . '+' : '<span class="muted">Amount not stated</span>' ?></td><td data-label="How long"><?= h(window_text($r)) ?></td></tr>
  <?php endforeach; ?>
  </tbody></table></div>
  <?php endif; ?>
  <p>No regular salary, because you are between jobs, self-employed or retired? The <?= $STATS['noSalaryCount'] ?> offers without a salary test are listed on the <?= a('/bank-switch-offers/', 'offers page') ?>.</p>
</section>

<section id="payin">
  <h2>Pay-in tests</h2>
  <p>A pay-in test asks for a minimum amount to arrive in the account, often within a number of days of opening or of the switch. How the money may be sourced varies by offer. Some terms accept a transfer from an account you hold elsewhere; others specify an employer or a third party. The exact wording is shown on each offer page.</p>
  <?php if ($payInOffers): ?>
  <div class="table-wrap"><table class="data"><thead><tr><th>Offer</th><th class="num">Pay in</th><th>When</th><th>Must stay</th></tr></thead><tbody>
  <?php foreach ($payInOffers as $o): $r = first_req($o, 'pay-in'); ?>
    <tr><td data-label="Offer"><?= a('/bank-switch-offers/' . $o['slug'] . '/', h($o['product'])) ?></td><td data-label="Pay in" class="num"><?= gbp($o['payInMax']) ?>+</td><td data-label="When"><?= h(window_text($r)) ?></td><td data-label="Must stay"><?= !empty($r['mustStayDays']) ? ($r['mustStayDays'] <= 1 ? '24 hours' : h(round($r['mustStayDays'])) . ' days') : '<span class="muted">Not stated</span>' ?></td></tr>
  <?php endforeach; ?>
  </tbody></table></div>
  <?php endif; ?>
  <?= callout('info', '<strong>A pay-in is a test of money arriving, not of what you earn.</strong> Whether your own money moved from another account satisfies it depends entirely on the offer’s wording, so read it before relying on that.') ?>
</section>

<section id="stay">
  <h2>How long the money has to stay</h2>
  <p>Some offers say a deposit has to remain in the account for a set time, often a day or more, before it counts. Others say nothing. Where the terms are silent we say “not stated”, which means the offer does not tell you, not that there is no rule. Keep a record of when payments arrive and leave, and check the terms before you move anything back.</p>
</section>

<section id="staged">
  <h2>Bonuses paid in instalments</h2>
  <p>Several offers pay part of the bonus up front and the rest over later months, on the condition that you keep meeting a test, such as salary or card payments, in each of those months.</p>
  <?php if ($staged): ?>
  <ul class="plain">
  <?php foreach ($staged as $o): ?>
    <li><?= a('/bank-switch-offers/' . $o['slug'] . '/', h($o['product'])) ?>: <?= h(join_and(array_map(fn($p) => ($p['count'] > 1 ? $p['count'] . ' × ' : '') . gbp($p['amount']), $o['payments']))) ?>, <?= gbp($o['total']) ?> in all</li>
  <?php endforeach; ?>
  </ul>
  <?php endif; ?>
  <p>Take care to ask whether the later instalments are worth the commitment. A salary test over six months means your pay is tied to that account for that long.</p>
</section>

<?php if ($example): $pi = first_req($example, 'pay-in'); ?>
<section id="timeline">
  <h2>A worked timeline</h2>
  <p>Here is how it looks for the <?= a('/bank-switch-offers/' . $example['slug'] . '/', h($example['product'])) ?>, using its own figures:</p>
  <ol class="steps">
    <li><strong>Day 0:</strong> open the account<?= !empty($example['switch']['withinDaysOfOpening']) ? ' and start the switch within ' . (int) $example['switch']['withinDaysOfOpening'] . ' days' : '' ?>.</li>
    <li><strong>Before the switch date:</strong> make sure the <?= (int) $example['ddNeeded'] ?> Direct Debits are in place on the account you are leaving.</li>
    <li><strong>About 7 working days later:</strong> the switch completes and the Direct Debits arrive.</li>
    <li><strong>The pay-in:</strong> <?= gbp($example['payInMax']) ?> <?= h(window_text($pi)) ?>.</li>
    <li><strong>The bonus:</strong> <?= gbp($example['total']) ?><?php $p0 = $example['payments'][0]; echo !empty($p0['paidWithin']) ? ', paid within ' . (int) $p0['paidWithin']['value'] . ' ' . h($p0['paidWithin']['unit']) . ' of the conditions being met' : ''; ?>.</li>
  </ol>
  <p class="fine">The timeline is illustrative. The offer’s own terms govern the dates.</p>
</section>
<?php endif; ?>

<?= faq_html($faq) ?>
<section class="sources"><h2>Sources</h2><p>Figures come from each offer’s terms as extracted; see <?= a('/how-we-get-our-data/', 'where our data comes from') ?>. The provider’s own terms always take priority.</p></section>
