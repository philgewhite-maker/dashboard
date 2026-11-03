<?php
/** @var array $site @var array $methods */
$h = 'Util::h';
$names = ['card' => 'Card, Apple Pay or Google Pay', 'alipay' => 'Alipay', 'wechat_pay' => 'WeChat Pay', 'pay_by_bank' => 'Pay by bank (UK)',
    'bank_transfer' => 'Bank transfer', 'revolut' => 'Revolut transfer', 'usdt' => 'USDT', 'kakao_pay' => 'Kakao Pay', 'naver_pay' => 'Naver Pay'];
?>
<h1>Booking, cancellation and privacy</h1>

<h2>How booking works</h2>
<ol>
  <li>You send a request with your dates. If you pay by card, it is authorised, not charged.</li>
  <li>The host accepts or declines within 24 hours. No answer means declined, and any authorisation is released.</li>
  <li>When accepted, your card is charged, or we email you a payment link or bank details.</li>
  <li>Stays of 28 nights or more are paid monthly in advance.</li>
</ol>
<p>You pay the host directly: each room's payment goes to the person who hosts it. We never add a fee for any payment method. Prices are in pounds unless you pick another currency, which is then fixed when you book.</p>

<h2>Ways to pay</h2>
<ul><?php foreach ($methods as $m): ?><li><?= $h($names[$m] ?? $m) ?></li><?php endforeach; ?></ul>

<h2>Cancellation policies</h2>
<p>Each booking shows its policy before you request it. Busy event dates can have a stricter one.</p>
<dl>
<?php foreach (Cancellation::POLICIES as $p): ?>
  <dt><?= $h($p['name']) ?></dt><dd><?= $h($p['text']) ?></dd>
<?php endforeach; ?>
</dl>

<h2>Privacy</h2>
<p>We keep your name, contact details, dates and messages to manage your stay, and share them only with the host and our payment and calendar providers (Stripe and Beds24). Card details go straight to Stripe; we never see them. We don't use tracking cookies. Ask us at <a href="mailto:<?= $h($site['operator_email']) ?>"><?= $h($site['operator_email']) ?></a> to see or delete your data.</p>
