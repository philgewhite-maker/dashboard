<?php
$rows = cashback_rows($DATA);
$tcb = $CFG['referrals']['topcashback'];
$qui = $CFG['referrals']['quidco'];
$asOf = $DATA['cashbackAsOf'] ?? $STATS['asOf'];
$faq = [
    ['Can I use a cashback site and the bank’s own switch bonus together?', '<p>Usually yes: the cashback is paid by the site for sending you to the bank, and the switch bonus is paid by the bank. Read both sets of terms. Some banks exclude customers who arrive through certain channels.</p>'],
    ['Why has my cashback not tracked?', '<p>Most often because the click-through was not made in the same browser session before applying, an ad blocker interfered, or the application was started somewhere else first. Tracking can take some time to show, so keep a screenshot of the click and the application.</p>'],
    ['Can I claim through two sites?', '<p>Treat one application as one site. Most terms do not allow the same purchase to be claimed twice, and a double claim risks both.</p>'],
    ['When is the cashback paid?', '<p>Cashback sites normally show it as pending first and confirm it after the bank confirms the account. The wait is set by the site and the bank.</p>'],
];
$meta = [
    'path' => '/cashback-sites/',
    'title' => 'Cashback sites compared for bank account switching: TopCashback and Quidco',
    'description' => 'What TopCashback and Quidco currently pay for opening the same current accounts, side by side, with how to make sure the cashback tracks alongside a bank switch bonus.',
    'crumbs' => [['/cashback-sites/', 'Cashback sites']],
    'article' => true,
    'faq' => $faq,
];
?>
<h1>Cashback sites compared for bank accounts</h1>
<p class="lead">On top of a bank’s own switch bonus, cashback sites often pay a smaller fee for sending you to open an account. The amounts differ by site and change often, so it pays to compare them for the account you are opening.</p>
<p class="updated">Cashback amounts last checked <time datetime="<?= h($asOf) ?>"><?= h(pretty_date($asOf)) ?></time>.</p>

<section>
  <h2>What each site pays right now</h2>
  <div class="table-wrap"><table class="data"><thead><tr><th>Account</th><th class="num">TopCashback</th><th class="num">Quidco</th></tr></thead><tbody>
  <?php foreach ($rows as $r): ?>
    <tr><td data-label="Account"><?= h($r['name']) ?></td>
      <td data-label="TopCashback" class="num"><?= isset($r['topcashback']) ? gbp($r['topcashback']) : '<span class="muted">Not listed</span>' ?></td>
      <td data-label="Quidco" class="num"><?= isset($r['quidco']) ? gbp($r['quidco']) : '<span class="muted">Not listed</span>' ?></td></tr>
  <?php endforeach; ?>
  </tbody></table></div>
  <p class="fine">Figures are what each site listed when last checked. Quidco may show higher rates to paying members, so the figure you see could differ. The site’s own listing is the one that counts.</p>
</section>

<section>
  <h2>The two sites</h2>
  <div class="cards two">
    <div class="card"><h3><?= h($tcb['name']) ?></h3><p>A free-to-join cashback site. Use it for the accounts in the table above.</p>
      <p><?= ext($tcb['url'], 'Join ' . h($tcb['name']), true) ?> <span class="ad">Referral link</span></p></div>
    <div class="card"><h3><?= h($qui['name']) ?></h3><p>A cashback site with a free tier and paid memberships that can raise some rates. Compare before you click.</p>
      <p><?= ext($qui['url'], 'Join ' . h($qui['name']), true) ?> <span class="ad">Referral link</span></p></div>
  </div>
  <?= disclosure_note() ?>
</section>

<section>
  <h2>How to make sure it tracks</h2>
  <ol class="steps">
    <li><strong>Pick one site</strong> for each application and do not mix.</li>
    <li><strong>Start from the cashback site</strong>, search for the bank, and click through to its page in the same browser window you will use to apply.</li>
    <li><strong>Turn off ad blockers</strong> for the click and use no other discount codes or links on the way.</li>
    <li><strong>Apply in one go</strong>, in the same session, and do not start the application elsewhere first.</li>
    <li><strong>Keep a record</strong>: a screenshot of the click and of the confirmation email.</li>
    <li><strong>Check back</strong> after a few days that the cashback shows as pending, and chase the site with your evidence if not.</li>
  </ol>
</section>

<?= faq_html($faq) ?>
<?= sources_html([
    ['TopCashback current account listings', $DATA['cashbackSources']['topcashback'] ?? 'https://www.topcashback.co.uk/'],
    ['Quidco current account listings', $DATA['cashbackSources']['quidco'] ?? 'https://www.quidco.com/'],
]) ?>
