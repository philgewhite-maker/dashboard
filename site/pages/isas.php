<?php
// Built only when config 'sections' => ['isas' => true]. Written and ready to extend: ISA fee and rate
// comparison pages would be generated from a new structured feed in the same way offers are.
$faq = [
    ['Should I withdraw my ISA money and pay it into the new one myself?', '<p>No. Withdrawing the money and depositing it elsewhere can mean it loses its tax-free status, unless your ISA is a flexible one that allows it. Ask the new provider to transfer it for you with an ISA transfer form.</p>'],
    ['Can I transfer only part of the money?', '<p>For money you paid in during previous tax years, usually yes. For the current tax year, providers normally require the whole of that year’s subscription to move. Check both providers’ rules.</p>'],
];
$meta = [
    'path' => '/isas/',
    'title' => 'ISAs: transfers and fees explained',
    'description' => 'How to move an ISA without losing its tax-free status, how long transfers take, and the fees to compare before you move.',
    'crumbs' => [['/isas/', 'ISAs']],
    'article' => true,
    'faq' => $faq,
];
?>
<h1>ISAs: transfers and fees explained</h1>
<p class="lead">Moving an ISA is simple if you use the official transfer route and awkward if you do not. This section explains the rules and will compare the fees that matter.</p>

<h2>How a transfer works</h2>
<ol class="steps">
  <li><strong>Choose the new provider</strong> and open an account with them. Not every provider accepts transfers in, so check first.</li>
  <li><strong>Ask the new provider for an ISA transfer form</strong> (or use their online transfer service). Do not withdraw the money yourself.</li>
  <li><strong>The new provider asks the old one</strong> to move the money, and the tax-free wrapper moves with it.</li>
  <li><strong>Check it has arrived</strong> and that your allowance for the year is untouched.</li>
</ol>

<h2>How long it takes</h2>
<p>Cash ISA to cash ISA transfers should usually complete within about 15 working days. Transfers involving stocks and shares can take longer, up to around 30 days, depending on the provider, because investments may need to be sold and re-bought. Some providers charge for transferring each fund. Fixed-term cash ISAs can carry early-exit penalties, so check before moving one.</p>

<h2>What we will compare</h2>
<ul class="plain">
  <li>Cash ISA rates and whether the provider accepts transfers in.</li>
  <li>Stocks and shares platform fees, fund charges and any transfer-in or transfer-out fees.</li>
  <li>Switching incentives, where a provider pays one.</li>
</ul>
<p class="fine">This section uses the same approach as the bank offers: structured data, shown in the same layout for every provider, with the date it was last checked.</p>

<?= faq_html($faq) ?>
<?= sources_html([['Money to the Masses: ISA transfers explained', 'https://moneytothemasses.com/saving-for-your-future/investing/isa-transfers-explained-everything-need-know']]) ?>
