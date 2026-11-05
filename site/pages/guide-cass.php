<?php
$requireFull = count(array_filter($OFFERS, fn($o) => !empty($o['switch']['required'])));
$participants = array_map(fn($n) => ucwords($n), $DATA['cassParticipants'] ?? []);
sort($participants);
$faq = [
    ['How long does a Current Account Switch take?', '<p>Seven working days from the switch starting to it completing. You choose the switch date, which has to be a working day, and the new bank handles the rest.</p>'],
    ['What happens to my old account?', '<p>The switch closes it. Your balance moves to the new account, your Direct Debits and standing orders are moved, and any payments still sent to the old account are redirected to the new one.</p>'],
    ['What if something goes wrong?', '<p>The Current Account Switch Guarantee says your new bank will refund any interest and charges you incur because of a delayed or incorrect switch. It is free to use.</p>'],
    ['Do I have to switch everything to get a bonus?', '<p>' . ($requireFull === count($OFFERS) ? 'Every offer we track (' . $requireFull . ' of ' . count($OFFERS) . ') requires a switch' : $requireFull . ' of the ' . count($OFFERS) . ' offers we track require a switch') . ', so the old account is closed as part of it. Each offer page says what it needs.</p>'],
    ['Does a switch affect my credit file?', '<p>Opening an account normally involves the new bank checking your credit record, and an application can leave a footprint that other lenders may see. The switch itself is not a credit application. If you plan several switches, space them out and check how the bank searches.</p>'],
    ['Will recurring card payments move across?', '<p>No. The service moves Direct Debits and standing orders and redirects payments into the account. Subscriptions you pay by card on file are not moved, so update those yourself.</p>'],
    ['Do I need to tell my employer?', '<p>Payments into your old account are redirected, but some offers need your salary to arrive directly in the new account, so it is safest to give your employer the new details. Check the offer’s wording.</p>'],
];
$meta = [
    'path' => '/guides/current-account-switch-service/',
    'title' => 'The Current Account Switch Service: how it works and whether it is safe',
    'description' => 'The Current Account Switch Service moves your account, Direct Debits and payments to a new bank in seven working days, with a guarantee if anything goes wrong. How it works, what it covers and how your money is protected.',
    'crumbs' => [['/guides/', 'Guides'], ['/guides/current-account-switch-service/', 'Current Account Switch Service']],
    'article' => true,
    'faq' => $faq,
];
?>
<h1>The Current Account Switch Service: how it works and whether it is safe</h1>
<p class="lead">Almost every bank switch offer needs a switch through the Current Account Switch Service (CASS). It is built so that you do not have to chase anyone: your new bank does the work, and a guarantee covers you if it goes wrong.</p>
<?= updated_line($STATS) ?>

<nav class="toc" aria-label="On this page"><strong>On this page</strong>
  <ol><li><a href="#what">What it is</a></li><li><a href="#how">How a switch runs</a></li><li><a href="#guarantee">The guarantee</a></li><li><a href="#money">How your money is protected</a></li><li><a href="#limits">What it does not do</a></li><li><a href="#checklist">Before you switch</a></li><li><a href="#banks">Which banks take part</a></li></ol></nav>

<section id="what">
  <h2>What it is</h2>
  <p>The Current Account Switch Service is run by <?= ext('https://www.wearepay.uk/what-we-do/switching-services/current-account-switch-service/', 'Pay.UK') ?>, which operates the UK’s payment systems. When you ask a new bank to switch you, it moves your balance, your Direct Debits and standing orders to the new account, and your old bank closes the old one. More than 50 banks and building societies take part.</p>
  <p>A switch bonus is almost always conditional on a full switch, not just on opening a new account: every offer in our data requires one.</p>
</section>

<section id="how">
  <h2>How a switch runs, step by step</h2>
  <ol class="steps">
    <li><strong>Open the new account.</strong> You apply directly with the new bank. Check the offer’s eligibility rules first, because a bonus can be refused if you fall foul of them (see <?= a('/guides/how-a-switch-bonus-works/', 'how a switch bonus works') ?>).</li>
    <li><strong>Ask the new bank to switch you.</strong> You give it the details of the account you are leaving and choose a switch date. The date has to be a working day, and at least seven working days away.</li>
    <li><strong>The new bank contacts the old one.</strong> You do not need to speak to your old bank. The new bank arranges for your Direct Debits and standing orders to move.</li>
    <li><strong>On the switch date</strong> your balance moves across, the old account closes and the new account takes over.</li>
    <li><strong>Payments that still go to the old account are redirected.</strong> Pay.UK says the redirection runs for a minimum of three years, or longer if needed, so a payer who has not updated your details still reaches you.</li>
  </ol>
</section>

<section id="guarantee">
  <h2>The Current Account Switch Guarantee</h2>
  <p>Every participating bank signs up to the same guarantee. In summary:</p>
  <ul class="plain">
    <li>The switch is <strong>free</strong>, simple and secure.</li>
    <li>If anything goes wrong, your <strong>new bank refunds any interest and charges</strong> you incur as a result of a delayed or incorrect switch.</li>
    <li>Payments to and from the old account are redirected to the new one, so nothing is lost in the gap.</li>
  </ul>
  <?= callout('info', 'Read the guarantee in the wording your new bank gives you. It sits in the bank’s switching terms, and the exact wording is theirs.') ?>
</section>

<section id="money">
  <h2>How your money is protected</h2>
  <p>A switch does not move your money outside the banking system, so the normal deposit protection applies at both ends. The Financial Services Compensation Scheme (FSCS) protects eligible deposits up to <strong>£120,000 per person per authorised firm</strong> for firms that fail from 1 December 2025 (it was £85,000 before). Each holder of a joint account is protected separately.</p>
  <p>The limit applies per banking licence, not per brand. If two of your accounts are with banks that share one licence, the £120,000 covers them together. That matters if you hold large balances while you work through several offers; the <?= ext('https://www.bankofengland.co.uk/explainers/what-is-the-financial-services-compensation-scheme', 'Bank of England’s explainer') ?> and the <?= ext('https://www.fscs.org.uk/what-we-cover/banks-building-societies-credit-unions/deposit-limit-increase/', 'FSCS’s own page') ?> set out the rules.</p>
</section>

<section id="limits">
  <h2>What it does not do</h2>
  <ul class="plain">
    <li><strong>It does not move card-on-file subscriptions.</strong> Anything you pay by card rather than Direct Debit needs updating by hand.</li>
    <li><strong>It does not decide who gets a bonus.</strong> Eligibility is set by each offer: accounts you already hold, bonuses you have had before and income tests all apply.</li>
    <li><strong>It does not cover every provider.</strong> Check the bank takes part before you rely on it.</li>
    <li><strong>It closes the old account.</strong> <?= $requireFull === count($OFFERS) ? 'All ' . $requireFull : $requireFull . ' of the ' . count($OFFERS) ?> offers we track need a full switch, so plan for that account to go.</li>
  </ul>
</section>

<section id="checklist">
  <h2>Before you switch</h2>
  <ol class="steps">
    <li>List every Direct Debit and standing order on the old account, and check it will not leave you short of the number the offer asks for (see <?= a('/guides/direct-debits-for-switch-offers/', 'the Direct Debit guide') ?>).</li>
    <li>Make a note of any card-on-file subscriptions to update afterwards.</li>
    <li>Leave a small buffer in the old account for the switch date, in case a payment lands late.</li>
    <li>Tell your employer the new details if the offer needs salary to arrive directly.</li>
    <li>Choose the switch date to suit your pay and bill dates, not just the earliest possible.</li>
  </ol>
</section>

<section id="banks">
  <h2>Which banks take part</h2>
  <p>Our data lists <?= count($participants) ?> participating providers. Check Pay.UK’s current list before you rely on it, because providers join and leave.</p>
  <ul class="cols"><?php foreach ($participants as $p) echo '<li>' . h($p) . '</li>'; ?></ul>
</section>

<?= faq_html($faq) ?>
<?= sources_html([
    ['Pay.UK: Current Account Switch Service', 'https://www.wearepay.uk/what-we-do/switching-services/current-account-switch-service/'],
    ['Current Account Switch Service (consumer site)', 'https://www.currentaccountswitch.co.uk/'],
    ['Bank of England: the FSCS and the £120,000 deposit limit', 'https://www.bankofengland.co.uk/explainers/what-is-the-financial-services-compensation-scheme'],
    ['FSCS: deposit limit increase', 'https://www.fscs.org.uk/what-we-cover/banks-building-societies-credit-unions/deposit-limit-increase/'],
]) ?>
