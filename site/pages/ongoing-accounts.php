<?php
$ongoing = $DATA['ongoingAccounts'] ?? [];
$perks = $DATA['annualPerks'] ?? [];
$krakTiers = $DATA['krakTiers'] ?? [];
$krakCard = $DATA['krakCardTiers'] ?? [];
$krak = $CFG['referrals']['krak'];
$meta = [
    'path' => '/ongoing-accounts/',
    'title' => 'Accounts that keep paying: bills cashback, salary matching and yearly payments',
    'description' => 'Once a switch bonus has paid, some accounts keep earning: cashback on household bills, salary-matching rewards and yearly member payments. What they pay, what they need and what they cost.',
    'crumbs' => [['/ongoing-accounts/', 'Ongoing accounts']],
    'article' => true,
];
?>
<h1>Accounts that keep paying</h1>
<p class="lead">A switch bonus is a one-off. A few accounts keep rewarding you afterwards. Whether they are worth keeping depends on what they ask for and what they cost, so we set out both.</p>
<?= updated_line($STATS) ?>

<?php if ($ongoing): ?>
<section>
  <h2>Everyday accounts that pay you back</h2>
  <?php foreach ($ongoing as $a): ?>
  <div class="card wide">
    <h3><?= h($a['product']) ?> <span class="muted"><?= h($a['bank']) ?></span></h3>
    <p><?= h($a['summary'] ?? '') ?></p>
    <dl class="glance">
      <?php if (isset($a['minPayIn'])): ?><div><dt>Pay in</dt><dd><?= gbp($a['minPayIn']) ?> a month</dd></div><?php endif; ?>
      <?php if (isset($a['directDebitsNeeded'])): ?><div><dt>Direct Debits</dt><dd><?= (int) $a['directDebitsNeeded'] ?>+</dd></div><?php endif; ?>
      <?php if (isset($a['monthlyFee'])): ?><div><dt>Monthly fee</dt><dd><?= $a['monthlyFee'] ? gbp($a['monthlyFee']) : 'None' ?></dd></div><?php endif; ?>
      <?php if (!empty($a['annualValue'])): ?><div><dt>Most it pays in a year</dt><dd><?= gbp($a['annualValue']) ?></dd></div><?php endif; ?>
    </dl>
    <?php if (!empty($a['annualValueNote'])): ?><p class="fine"><?= h($a['annualValueNote']) ?></p><?php endif; ?>
  </div>
  <?php endforeach; ?>
  <p class="fine">The yearly figure is the most the account can pay, after any monthly fee: you earn the cashback percentage on what you actually spend or pay by Direct Debit, up to the cap. It only pays that if you meet the account’s monthly tests, so read its terms first.</p>
</section>
<?php endif; ?>

<?php if ($krakTiers): ?>
<section>
  <h2>Salary matching</h2>
  <p><?= h($krak['name']) ?> (an app account from Kraken) pays a percentage of each salary payment, set by your average balance over the last 30 days, and a separate percentage as cashback on card spending. The salary has to arrive from an employer, at least <?= gbp($DATA['krakSalaryMin'] ?? 2500) ?> a month, and salary above <?= gbp($DATA['krakSalaryCap'] ?? 25000) ?> a month is not counted.</p>
  <div class="table-wrap"><table class="data"><thead><tr><th>Tier</th><th class="num">Average balance</th><th class="num">Salary match</th><th class="num">Card cashback</th></tr></thead><tbody>
  <?php foreach ($krakTiers as $i => $t): ?>
    <tr><td data-label="Tier"><?= h($t['name']) ?></td><td data-label="Average balance" class="num"><?= $t['minBalance'] ? gbp($t['minBalance']) . '+' : 'Any' ?></td><td data-label="Salary match" class="num"><?= h(rtrim(rtrim(number_format((float) $t['percent'], 2), '0'), '.')) ?>%</td><td data-label="Card cashback" class="num"><?= isset($krakCard[$i]) ? h(rtrim(rtrim(number_format((float) $krakCard[$i]['percent'], 2), '0'), '.')) . '%' : '' ?></td></tr>
  <?php endforeach; ?>
  </tbody></table></div>
  <?= callout('warn', '<strong>Check how your money is protected.</strong> A Krak account is not a UK bank account, and the protection on funds held there can differ from the Financial Services Compensation Scheme protection that covers deposits with authorised UK banks and building societies. Read Krak’s own terms before holding a balance there.') ?>
  <p><?= ext($krak['url'], 'Krak’s Salary Match page', true) ?> <span class="ad">Referral link</span></p>
  <?= disclosure_note() ?>
</section>
<?php endif; ?>

<?php if ($perks): ?>
<section>
  <h2>Yearly member payments</h2>
  <?php foreach ($perks as $p): ?>
  <div class="card wide">
    <h3><?= h($p['name']) ?> <span class="muted">about <?= gbp($p['amount']) ?> a year<?= empty($p['guaranteed']) ? ', not guaranteed' : '' ?></span></h3>
    <p><?= h($p['note']) ?></p>
    <?php if (!empty($p['url'])): ?><p><?= ext($p['url'], 'How it works') ?></p><?php endif; ?>
  </div>
  <?php endforeach; ?>
</section>
<?php endif; ?>

<?= callout('info', 'Rates, fees and rules on ongoing accounts can change at any time. We show what the provider’s terms said when we last checked, and the provider’s current terms apply.') ?>
