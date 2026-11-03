<?php
/** @var array $product @var array $currencies */
$h = 'Util::h';
$c = $product['content'];
$photos = $c['photos'] ?? array_merge(...array_map(fn($l) => $l['content']['photos'] ?? [], $product['listings']));
?>
<article class="product">
  <h1><?= $h($product['name']) ?></h1>
  <p class="lead"><?= $h(Util::t($c['description'] ?? ($product['listings'][0]['content']['description'] ?? ''))) ?></p>
  <?php if ($photos): ?>
  <div class="gallery"><?php foreach (array_slice($photos, 0, 8) as $p): ?><img src="<?= $h($p['src']) ?>" alt="<?= $h(Util::t($p['alt'] ?? '')) ?>" loading="lazy"><?php endforeach; ?></div>
  <?php endif; ?>

  <div class="split">
    <div>
    <?php foreach ($product['listings'] as $l): $lc = $l['content']; ?>
      <section class="listing">
        <?php if (count($product['listings']) > 1): ?><h2><?= $h($l['name']) ?></h2><?php endif; ?>
        <?php if (!empty($lc['features'])): ?><ul class="ticks"><?php foreach ($lc['features'] as $f): ?><li><?= $h(Util::t($f)) ?></li><?php endforeach; ?></ul><?php endif; ?>
        <p class="small">Sleeps <?= (int)$l['max_guests'] ?>. Hosted by <?= $h($l['host']['name']) ?>.</p>
        <?php if (!empty($lc['rating']) && $l['airbnb_url']): ?>
          <p class="small">Rated <?= $h((string)$lc['rating']['score']) ?>/5 from <?= (int)$lc['rating']['count'] ?> guest reviews on <a href="<?= $h($l['airbnb_url']) ?>" rel="nofollow noopener">Airbnb</a>.</p>
        <?php endif; ?>
        <?php foreach ($lc['reviews'] ?? [] as $r): ?>
          <blockquote><?= $h(Util::t($r['quote'])) ?><footer><?= $h($r['name'] ?? '') ?><?= !empty($r['date']) ? ', ' . $h($r['date']) : '' ?></footer></blockquote>
        <?php endforeach; ?>
      </section>
    <?php endforeach; ?>
      <?php $shared = $product['listings'][0]['content']; ?>
      <?php if (!empty($shared['amenities'])): ?><h2>In the flat</h2><ul class="ticks cols"><?php foreach ($shared['amenities'] as $a): ?><li><?= $h(Util::t($a)) ?></li><?php endforeach; ?></ul><?php endif; ?>
      <?php if (!empty($shared['house_rules'])): ?><h2>House rules</h2><ul><?php foreach ($shared['house_rules'] as $r): ?><li><?= $h(Util::t($r)) ?></li><?php endforeach; ?></ul><?php endif; ?>
    </div>
    <aside><?= View::render('_widget', ['product' => $product, 'currencies' => $currencies]) ?></aside>
  </div>
</article>
