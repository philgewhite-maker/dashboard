<?php
declare(strict_types=1);

/**
 * GBP -> guest currency, for showing and charging a price in the currency
 * the guest picked. Rates come from the ECB's free daily reference feed
 * (bin/cron.php refreshes them). The rate is locked into the booking's
 * quote, so a later rate change never alters what a guest agreed to.
 */
final class Fx
{
    public const ECB_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';

    public function __construct(private App $app) {}

    public function rate(string $currency): float
    {
        $currency = strtoupper($currency);
        if ($currency === 'GBP') return 1.0;
        $row = $this->app->one('SELECT per_gbp FROM fx_rates WHERE currency = ?', [$currency]);
        if (!$row) throw new RuntimeException("No exchange rate for $currency yet (run bin/cron.php fx).");
        return (float)$row['per_gbp'];
    }

    /** Parses the ECB feed (EUR-based) into per-GBP rates and stores them. */
    public function refresh(?string $xml = null): int
    {
        if ($xml === null) {
            [$code, $xml] = Util::http('GET', self::ECB_URL);
            if ($code !== 200) throw new RuntimeException("ECB feed returned HTTP $code");
        }
        preg_match_all("/currency='([A-Z]{3})'\s+rate='([0-9.]+)'/", $xml, $m, PREG_SET_ORDER);
        $perEur = ['EUR' => 1.0];
        foreach ($m as [, $cur, $rate]) $perEur[$cur] = (float)$rate;
        if (!isset($perEur['GBP'])) throw new RuntimeException('ECB feed had no GBP rate');
        $n = 0;
        foreach ($perEur as $cur => $rate) {
            if ($cur === 'GBP') continue;
            $this->app->exec('DELETE FROM fx_rates WHERE currency = ?', [$cur]);
            $this->app->insert('fx_rates', ['currency' => $cur, 'per_gbp' => $rate / $perEur['GBP'], 'updated_at' => Util::now()]);
            $n++;
        }
        return $n;
    }
}
