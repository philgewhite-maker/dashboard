<?php
declare(strict_types=1);

/**
 * Demand from the dashboard's booking model.
 *
 * The personal dashboard runs a Monte Carlo booking model and saves each
 * "void projection" into its own data file on this same web host
 * (data.bookingProjections in dashboard-data.json): for every free night up
 * to the end of next month, the chance it gets booked and the income it is
 * expected to bring, plus, for "dead voids" (likely to stay empty), the
 * change the model found best (allow shorter stays, take N% off).
 *
 * This class copies the latest fresh projection into `demand_nights`,
 * mapped onto this site's listings by their Airbnb listing number. It never
 * writes to the dashboard. A projection older than demand.max_age_days is
 * ignored: offers stop rather than run on stale guesses.
 */
final class Demand
{
    public function __construct(private App $app) {}

    public function cfg(): array
    {
        return $this->app->config['demand'];
    }

    /** Reads the dashboard's data file and refreshes demand_nights. Returns a summary. */
    public function sync(?array $dashboardData = null): array
    {
        if ($dashboardData === null) {
            $file = $this->app->config['dashboard']['data_file'] ?? '';
            if ($file === '' || !is_file($file)) return ['status' => 'off: dashboard.data_file not set or missing'];
            $store = Util::json(file_get_contents($file));
            $dashboardData = $store['data'] ?? [];
        }
        $today = date('Y-m-d');
        $projections = array_filter($dashboardData['bookingProjections'] ?? [], fn($p) => ($p['to'] ?? '') > $today);
        usort($projections, fn($a, $b) => strcmp((string)$b['madeAt'], (string)$a['madeAt']));
        $p = $projections[0] ?? null;
        $this->app->exec('DELETE FROM demand_nights');
        if (!$p) return ['status' => 'no current projection in the dashboard'];

        $map = $this->listingMap($dashboardData['airbnbListings'] ?? []);
        $dead = [];
        foreach ($p['deadVoids'] ?? [] as $dv) if (!empty($dv['best'])) $dead["{$dv['roomKey']}|{$dv['from']}"] = $dv['best'];
        $rooms = array_column($p['rooms'] ?? [], null, 'key');
        $madeAt = substr(str_replace('T', ' ', (string)$p['madeAt']), 0, 19);
        $n = 0;
        $unmapped = [];
        $this->app->tx(function () use ($p, $map, $dead, $rooms, $madeAt, &$n, &$unmapped) {
            foreach ($p['voids'] ?? [] as $v) {
                $listingId = $map['rooms'][$v['roomKey']] ?? $map['dash'][$v['listingId'] ?? ($rooms[$v['roomKey']]['listingId'] ?? '')] ?? null;
                if (!$listingId) { $unmapped[$v['roomLabel'] ?? $v['roomKey']] = true; continue; }
                $best = $dead["{$v['roomKey']}|{$v['from']}"] ?? null;
                for ($i = 0; $i < (int)$v['nights']; $i++) {
                    $this->app->insert('demand_nights', [
                        'listing_id' => $listingId, 'date' => Util::addDays($v['from'], $i),
                        'prob' => (float)($v['nightProb'][$i] ?? 0), 'income' => (float)($v['nightIncome'][$i] ?? 0),
                        'void_from' => $v['from'], 'void_to' => $v['to'], 'open_ended' => (int)!empty($v['open']),
                        'dead' => (int)($best !== null), 'best_pct' => $best['pct'] ?? null, 'best_min' => $best['minNights'] ?? null,
                        'projected_at' => $madeAt,
                    ]);
                    $n++;
                }
            }
        });
        $out = ['status' => 'ok', 'projected_at' => $madeAt, 'nights' => $n];
        if ($unmapped) $out['unmapped_rooms'] = array_keys($unmapped);
        return $out;
    }

    /**
     * Dashboard room/listing -> this site's listing. Matched on the Airbnb
     * listing number (in this listing's airbnb_url or ical_url, and in the
     * dashboard listing's calendar URL). A listing can also name its
     * dashboard room outright in data.dashboard_room_key.
     */
    private function listingMap(array $dashListings): array
    {
        $byAirbnb = [];
        $rooms = [];
        foreach ($this->app->all('SELECT id, airbnb_url, ical_url, data FROM listings') as $l) {
            foreach ([$l['airbnb_url'], $l['ical_url']] as $u) if ($u && preg_match('/(\d{6,})/', $u, $m)) $byAirbnb[$m[1]] = $l['id'];
            $key = Util::json($l['data'])['dashboard_room_key'] ?? null;
            if ($key) $rooms[$key] = $l['id'];
        }
        $dash = [];
        foreach ($dashListings as $dl) {
            foreach (['icsUrl', 'url', 'airbnbUrl'] as $f) {
                if (!empty($dl[$f]) && preg_match('/(\d{6,})/', (string)$dl[$f], $m) && isset($byAirbnb[$m[1]])) { $dash[$dl['id']] = $byAirbnb[$m[1]]; break; }
            }
        }
        return ['rooms' => $rooms, 'dash' => $dash];
    }

    /** Fresh demand rows for a listing over [from, to), keyed by date. Empty when off or stale. */
    public function nights(string $listingId, string $from, string $to): array
    {
        if (!$this->cfg()['enabled']) return [];
        $fresh = date('Y-m-d H:i:s', strtotime('-' . (int)$this->cfg()['max_age_days'] . ' days'));
        $rows = $this->app->all('SELECT * FROM demand_nights WHERE listing_id = ? AND date >= ? AND date < ? AND projected_at >= ?', [$listingId, $from, $to, $fresh]);
        return array_column($rows, null, 'date');
    }

    /**
     * The offer price for one quiet night, or null when there's no offer.
     * Selling a night now beats keeping it open when the price is above what
     * the night is expected to bring if left free (the model's income for it).
     * So: expected income plus a margin, never below the floor, never more
     * than max_discount_pct off, and only for nights with a low chance of
     * being booked.
     */
    public function offerPrice(float $direct, ?array $night): ?float
    {
        if (!$night) return null;
        $c = $this->cfg();
        if ($night['prob'] > $c['low_prob']) return null;
        $price = max($night['income'] * (1 + $c['margin_pct'] / 100), (float)$c['floor_gbp'], $direct * (1 - $c['max_discount_pct'] / 100));
        $price = round($price, 2);
        return $price < $direct - 0.5 ? $price : null;
    }

    public function status(): array
    {
        $row = $this->app->one('SELECT MAX(projected_at) AS at, COUNT(*) AS n FROM demand_nights');
        return ['projected_at' => $row['at'], 'nights' => (int)$row['n'],
            'fresh' => $row['at'] && $row['at'] >= date('Y-m-d H:i:s', strtotime('-' . (int)$this->cfg()['max_age_days'] . ' days'))];
    }
}
