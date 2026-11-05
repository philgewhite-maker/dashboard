<?php
$meta = [
    'path' => '/',
    'title' => $CFG['siteName'],
    'description' => 'Current switch offers from UK banks, explained in plain English: what each one asks for, how the Current Account Switch Service protects you, and what to line up before you start.',
];
$top = array_slice($OFFERS, 0, 5);
?>
<section class="hero">
  <p class="eyebrow">UK bank switch offers</p>
  <h1>Bank switch offers, explained so you know what you are signing up for</h1>
  <p class="lead">We track <?= $STATS['count'] ?> current switch offers from <?= $STATS['banks'] ?> banks, paying <?= gbp($STATS['minBonus']) ?> to <?= gbp($STATS['maxBonus']) ?> each. For every one we show what it asks of you: the money to pay in, the Direct Debits to move, any salary test and the deadline.</p>
  <p class="actions"><a class="btn" href="<?= h(url('/bank-switch-offers/')) ?>">See current offers</a> <a class="btn btn-ghost" href="<?= h(url('/guides/current-account-switch-service/')) ?>">How switching works</a></p>
  <?= updated_line($STATS) ?>
</section>

<section class="trust-strip" aria-label="About switching">
  <div><strong>7 working days</strong><span>from start to finish with the Current Account Switch Service</span></div>
  <div><strong>3 years</strong><span>minimum for payments sent to your old account to be redirected</span></div>
  <div><strong>50+</strong><span>banks and building societies take part</span></div>
  <div><strong>Guaranteed</strong><span>your new bank refunds interest and charges if the switch goes wrong</span></div>
</section>
<p class="fine center">Source: <?= ext('https://www.wearepay.uk/what-we-do/switching-services/current-account-switch-service/', 'Pay.UK, which runs the service') ?>. Details on our <?= a('/guides/current-account-switch-service/', 'switching guide') ?>.</p>

<section>
  <h2>The biggest switch bonuses right now</h2>
  <?= offers_table($top) ?>
  <p><?= a('/bank-switch-offers/', 'See all ' . $STATS['count'] . ' offers') ?>, with what each one needs.</p>
  <?= disclosure_note() ?>
</section>

<section>
  <h2>How a switch bonus works</h2>
  <ol class="how">
    <li><strong>Pick an offer you qualify for.</strong> Each one has rules about accounts you already hold and bonuses you have had before.</li>
    <li><strong>Open the new account</strong> and ask it to run a Current Account Switch from your old one. Choose a switch date at least seven working days ahead.</li>
    <li><strong>Meet the conditions.</strong> Usually that means moving some Direct Debits across and paying in a set amount, sometimes salary.</li>
    <li><strong>Wait for the bonus.</strong> Banks typically pay within a few weeks of the conditions being met; each offer says exactly when.</li>
  </ol>
  <p><?= a('/guides/how-a-switch-bonus-works/', 'Read the full walk-through') ?>.</p>
</section>

<section>
  <h2>The three things people get stuck on</h2>
  <div class="cards">
    <a class="card" href="<?= h(url('/guides/current-account-switch-service/')) ?>"><h3>Is switching safe?</h3><p>What the Current Account Switch Guarantee covers, what happens to your payments, and how your money is protected.</p></a>
    <a class="card" href="<?= h(url('/guides/switch-bonus-requirements/')) ?>"><h3>The money you need to move</h3><p>Pay-in tests, salary tests and minimum balances: <?= $STATS['needPayIn'] ?> offers have a pay-in test and <?= $STATS['needSalary'] ?> need salary.</p></a>
    <a class="card" href="<?= h(url('/guides/direct-debits-for-switch-offers/')) ?>"><h3>The Direct Debits</h3><p><?= $STATS['needDD'] ?> offers ask for <?= $STATS['ddMin'] === $STATS['ddMax'] ? $STATS['ddMin'] : $STATS['ddMin'] . ' to ' . $STATS['ddMax'] ?> Direct Debits. What counts, and how to line them up.</p></a>
  </div>
</section>

<section>
  <h2>More than the headline bonus</h2>
  <div class="cards two">
    <a class="card" href="<?= h(url('/cashback-sites/')) ?>"><h3>Cashback sites</h3><p>TopCashback and Quidco often pay extra for opening the same accounts. See the current amounts side by side and how to make sure they track.</p></a>
    <a class="card" href="<?= h(url('/ongoing-accounts/')) ?>"><h3>Accounts that keep paying</h3><p>Bills cashback accounts, salary matching and yearly member payments: what is worth keeping once the bonus has landed.</p></a>
  </div>
</section>

<section class="planner">
  <h2>Want the order worked out for you?</h2>
  <p>Our planner takes the same data and builds a day-by-day sequence of switches that fits your accounts, income and timing, with a checklist for each step. It is invite-only while we test it.</p>
  <p><a class="btn" href="<?= h($CFG['plannerUrl']) ?>" rel="noopener">Open the planner</a> <a class="btn btn-ghost" href="<?= h(url('/contact/')) ?>">Ask for an invite</a></p>
</section>
