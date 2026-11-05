<?php
$ddOffers = array_values(array_filter($OFFERS, fn($o) => $o['ddNeeded'] > 0));
usort($ddOffers, fn($a, $b) => [$b['ddNeeded'], $a['product']] <=> [$a['ddNeeded'], $b['product']]);
$range = $STATS['ddMin'] === $STATS['ddMax'] ? (string) $STATS['ddMin'] : $STATS['ddMin'] . ' to ' . $STATS['ddMax'];
$faq = [
    ['Do standing orders count as Direct Debits?', '<p>Normally not. Offers ask for Direct Debits specifically. A standing order is a payment you instruct from the account, and a card payment is a different thing again. Check the offer’s wording.</p>'],
    ['Can I set up the Direct Debits after the switch?', '<p>It depends on the offer. Many say the Direct Debits must be switched in, meaning they move across from the old account on the switch date. Those that allow later set-up say so. Setting them up on the old account first is the safer route.</p>'],
    ['How long do new Direct Debits take to show up?', '<p>A new Direct Debit does not appear until the company has set it up and, in many cases, collected the first payment. Allow a few weeks, and set them up before you start the switch.</p>'],
    ['What if the company collects annually or quarterly?', '<p>It may not count as live in time. Choose something that collects monthly, and check the terms for how the bank counts them.</p>'],
    ['Should I keep the Direct Debits after I get the bonus?', '<p>Keep them until the bonus has been paid. Cancelling early could put the test at risk. After that they are yours to keep, move or cancel.</p>'],
];
$meta = [
    'path' => '/guides/direct-debits-for-switch-offers/',
    'title' => 'Direct Debit requirements on switch offers: how many, what counts, how to set them up',
    'description' => 'Most bank switch offers ask for two or three Direct Debits to move across. What counts, why banks ask, how to set up the ones you are missing, and what the offers we track require.',
    'crumbs' => [['/guides/', 'Guides'], ['/guides/direct-debits-for-switch-offers/', 'Direct Debit requirements']],
    'article' => true,
    'faq' => $faq,
];
?>
<h1>Direct Debit requirements on switch offers</h1>
<p class="lead"><?= $STATS['needDD'] ?> of the <?= $STATS['count'] ?> offers we track ask for <?= h($range) ?> Direct Debits to move across to the new account. If you do not have that many, you can set up the ones you are missing. Here is what counts and how to line them up.</p>
<?= updated_line($STATS) ?>

<nav class="toc" aria-label="On this page"><strong>On this page</strong>
  <ol><li><a href="#why">Why banks ask</a></li><li><a href="#what">What counts</a></li><li><a href="#how-many">How many each offer needs</a></li><li><a href="#missing">If you do not have enough</a></li><li><a href="#timing">Timing</a></li></ol></nav>

<section id="why">
  <h2>Why banks ask for them</h2>
  <p>A Direct Debit is a payment a company collects from the account each time a bill falls due. A handful of live ones is a sign that the new account is being used as a real current account, not opened for the bonus and left. That is why offers usually tie the bonus to a minimum number.</p>
</section>

<section id="what">
  <h2>What counts as a Direct Debit</h2>
  <ul class="plain">
    <li><strong>Counts:</strong> a live Direct Debit that is moved across with the switch, such as council tax, energy, water, broadband, a mobile contract or a gym membership.</li>
    <li><strong>Usually does not count:</strong> a standing order, a card payment, a one-off payment or a Direct Debit that has been cancelled.</li>
    <li><strong>To check in the terms:</strong> whether the bank counts one per company, whether there is a minimum collection amount, and whether the Direct Debits must be on the account for a certain time.</li>
  </ul>
  <p>The Current Account Switch Service moves Direct Debits and standing orders for you; see <?= a('/guides/current-account-switch-service/', 'how it works') ?>. Recurring card payments are not moved.</p>
</section>

<section id="how-many">
  <h2>How many each offer needs</h2>
  <div class="table-wrap"><table class="data"><thead><tr><th>Offer</th><th class="num">Direct Debits</th><th class="num">Bonus</th></tr></thead><tbody>
  <?php foreach ($ddOffers as $o): ?>
    <tr><td data-label="Offer"><?= a('/bank-switch-offers/' . $o['slug'] . '/', h($o['product'])) ?> <span class="muted"><?= h($o['bank']) ?></span></td><td data-label="Direct Debits" class="num"><?= (int) $o['ddNeeded'] ?>+</td><td data-label="Bonus" class="num"><?= gbp($o['total']) ?></td></tr>
  <?php endforeach; ?>
  </tbody></table></div>
  <p>The other offers do not list a Direct Debit count in their terms, though a full switch will still carry across any you have.</p>
</section>

<section id="missing">
  <h2>If you do not have enough</h2>
  <p>People who pay most bills by card often have fewer than the offer needs. The fix is to create the missing ones on the account you are switching from, before you start:</p>
  <ul class="plain">
    <li><strong>Move bills you already pay</strong> to Direct Debit: council tax, energy, water, broadband, mobile, TV licence, insurance. Most providers offer it in their online account.</li>
    <li><strong>Give to a charity</strong> by Direct Debit. Many take a small monthly amount, and you can cancel any time once the bonus has been paid.</li>
    <li><strong>Start a small subscription</strong> that collects by Direct Debit rather than by card: a magazine, a gym, a cloud-storage plan.</li>
    <li><strong>Change a phone or broadband provider</strong>, as new contracts are usually paid by Direct Debit. Check you are not leaving a contract early.</li>
  </ul>
  <?= callout('warn', '<strong>Watch for cancellation charges and minimum terms</strong> on anything you start only to meet the test, and read the offer’s terms to be sure that kind of Direct Debit qualifies.') ?>
</section>

<section id="timing">
  <h2>Timing</h2>
  <ol class="steps">
    <li>Set up any missing Direct Debits on the account you are leaving, <strong>at least a few weeks before you start the switch</strong>, so they exist when the switch runs.</li>
    <li>Choose the switch date to fall after the first collections, when you can.</li>
    <li>After the switch, check each Direct Debit has arrived on the new account, and tell any company that did not move it.</li>
    <li>Keep them live until the bonus has been paid.</li>
  </ol>
</section>

<?= faq_html($faq) ?>
<section class="sources"><h2>Sources</h2><p>The counts in the table come from each offer’s terms as extracted; see <?= a('/how-we-get-our-data/', 'where our data comes from') ?>. Direct Debit rules are set by each bank and each offer.</p></section>
