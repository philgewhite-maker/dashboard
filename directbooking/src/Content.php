<?php
declare(strict_types=1);

/**
 * Reads content records and resolves inheritance:
 *   City -> Area -> Building -> Property -> Listing   (place data)
 *   Venue (+ its area) -> Series -> Occurrence        (event data)
 * A child's `data` keys win; lists are replaced, not appended (Util::inherit).
 */
final class Content
{
    public function __construct(private App $app) {}

    public function placeChain(string $placeId): array
    {
        $chain = [];
        for ($id = $placeId; $id; ) {
            $row = $this->app->one('SELECT * FROM places WHERE id = ?', [$id]);
            if (!$row) break;
            array_unshift($chain, $row);
            $id = $row['parent_id'];
            if (count($chain) > 10) throw new RuntimeException("Place hierarchy loop at $placeId");
        }
        return $chain;
    }

    public function placeData(string $placeId): array
    {
        $data = [];
        foreach ($this->placeChain($placeId) as $p) $data = Util::inherit($data, Util::json($p['data']));
        return $data;
    }

    public function listing(string $idOrSlug): ?array
    {
        $l = $this->app->one('SELECT * FROM listings WHERE id = ? OR slug = ?', [$idOrSlug, $idOrSlug]);
        if (!$l) return null;
        $l['content'] = Util::inherit($this->placeData($l['property_id']), Util::json($l['data']));
        $l['host'] = $this->host($l['host_id']);
        $l['property'] = $this->app->one('SELECT * FROM places WHERE id = ?', [$l['property_id']]);
        return $l;
    }

    public function host(string $id): ?array
    {
        $h = $this->app->one('SELECT * FROM hosts WHERE id = ?', [$id]);
        if ($h) $h['methods'] = Util::json($h['payment_methods']);
        return $h;
    }

    public function product(string $idOrSlug): ?array
    {
        $p = $this->app->one('SELECT * FROM products WHERE id = ? OR slug = ?', [$idOrSlug, $idOrSlug]);
        if (!$p) return null;
        $p['content'] = Util::json($p['data']);
        $p['listings'] = [];
        foreach (Util::json($p['listing_ids']) as $lid) {
            $l = $this->listing($lid);
            if (!$l) throw new RuntimeException("Product {$p['slug']} points at missing listing $lid");
            $p['listings'][] = $l;
        }
        return $p;
    }

    public function products(bool $publishedOnly = true): array
    {
        $rows = $this->app->all('SELECT id FROM products' . ($publishedOnly ? " WHERE status = 'published'" : '') . ' ORDER BY name');
        return array_map(fn($r) => $this->product($r['id']), $rows);
    }

    public function venue(?string $id): ?array
    {
        if (!$id) return null;
        $v = $this->app->one('SELECT * FROM venues WHERE id = ?', [$id]);
        if (!$v) return null;
        $v['content'] = Util::inherit($v['area_id'] ? $this->placeData($v['area_id']) : [], Util::json($v['data']));
        return $v;
    }

    public function series(string $idOrSlug): ?array
    {
        $s = $this->app->one('SELECT * FROM event_series WHERE id = ? OR slug = ?', [$idOrSlug, $idOrSlug]);
        if (!$s) return null;
        $s['venue'] = $this->venue($s['venue_id']);
        $s['content'] = Util::inherit($s['venue']['content'] ?? [], Util::json($s['data']));
        $pointIds = Util::json($s['point_ids']);
        $s['points'] = $pointIds
            ? array_values(array_filter(array_map(fn($id) => $this->app->one('SELECT * FROM points WHERE id = ?', [$id]), $pointIds)))
            : ($s['venue_id'] ? $this->app->all('SELECT * FROM points WHERE venue_id = ? ORDER BY name', [$s['venue_id']]) : []);
        foreach ($s['points'] as &$p) $p['content'] = Util::json($p['data']);
        $s['occurrences'] = $this->app->all('SELECT * FROM occurrences WHERE series_id = ? ORDER BY COALESCE(start_date, \'9999\')', [$s['id']]);
        return $s;
    }

    /** The occurrence a series page should feature: the next one not yet over, else the latest. */
    public function featuredOccurrence(array $series, bool $publishedOnly = true): ?array
    {
        $today = date('Y-m-d');
        $occ = array_values(array_filter($series['occurrences'], fn($o) => !$publishedOnly || $o['status'] === 'published'));
        foreach ($occ as $o) if ($o['end_date'] && $o['end_date'] >= $today) return $this->occurrence($o, $series);
        return $occ ? $this->occurrence(end($occ), $series) : null;
    }

    public function occurrence(array $o, array $series): array
    {
        $o['content'] = Util::inherit($series['content'], Util::json($o['data']));
        $o['label'] = $o['name'] ?: ($series['name'] . ($o['start_date'] ? ' ' . substr($o['start_date'], 0, 4) : ''));
        return $o;
    }

    /** Published routes from a property to each point, grouped by point. */
    public function routes(string $propertyId, array $points, bool $publishedOnly = true): array
    {
        $out = [];
        foreach ($points as $p) {
            $rows = $this->app->all(
                'SELECT * FROM routes WHERE property_id = ? AND point_id = ?' . ($publishedOnly ? " AND status = 'published'" : '') .
                " ORDER BY CASE context WHEN 'normal' THEN 0 WHEN 'event_day' THEN 1 ELSE 2 END, direction, minutes",
                [$propertyId, $p['id']]
            );
            foreach ($rows as &$r) $r['legs'] = Util::json($r['legs']);
            $out[] = ['point' => $p, 'routes' => $rows];
        }
        return $out;
    }

    /** Occurrences with direct-booking overrides, as rules over their nights. */
    public function occurrenceRules(): array
    {
        $rows = $this->app->all("SELECT * FROM occurrences WHERE status = 'published' AND start_date IS NOT NULL
            AND (min_nights IS NOT NULL OR cancellation_policy IS NOT NULL OR discount_pct IS NOT NULL)");
        return array_map(fn($o) => [
            'id' => 'occ:' . $o['id'], 'product_id' => null,
            'start_date' => Util::addDays($o['start_date'], -1),   // the night before counts as event demand
            'end_date' => $o['end_date'] ?: $o['start_date'],
            'min_nights' => $o['min_nights'], 'cancellation_policy' => $o['cancellation_policy'], 'discount_pct' => $o['discount_pct'],
        ], $rows);
    }
}
