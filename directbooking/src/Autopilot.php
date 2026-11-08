<?php
declare(strict_types=1);

/**
 * Applies the booking model's fix for a dead void to the shared calendar
 * (Beds24, which passes it on to Airbnb), within hard limits, and undoes it.
 *
 * Off unless autopilot.enabled is true AND the calendar source is Beds24:
 * without Beds24 there is no way to change Airbnb, and the dashboard's own
 * dead-void task covers it by hand.
 *
 * Limits, all in config autopilot.*: at most max_discount_pct off, never
 * below floor_gbp a night, only voids starting within max_days_ahead, a
 * minimum-stay change only if allow_min_stay. Each change is recorded with
 * the prices it replaced, so it can be undone, and the direct site keeps
 * pricing from the original (it makes its own offer instead).
 */
final class Autopilot
{
    public function __construct(private App $app) {}

    public function enabled(): bool
    {
        return (bool)$this->app->config['autopilot']['enabled'] && $this->app->rates()->canSetCalendar();
    }

    /** Prices before an active autopilot change, keyed by date (empty when none). */
    public function originalPrices(string $listingId, string $from, string $to): array
    {
        $out = [];
        foreach ($this->app->all("SELECT * FROM adjustments WHERE status = 'active' AND listing_id = ? AND date_from < ? AND date_to > ?", [$listingId, $to, $from]) as $a) {
            foreach (Util::json($a['old_prices']) as $d => $p) if ($d >= $from && $d < $to && $p !== null) $out[$d] = (float)$p;
        }
        return $out;
    }

    /** Applies fixes for new dead voids, and undoes changes the latest projection no longer supports. */
    public function run(): array
    {
        if (!$this->enabled()) return ['status' => 'off'];
        $cfg = $this->app->config['autopilot'];
        $done = [];
        $today = date('Y-m-d');
        $voids = $this->app->all("SELECT listing_id, void_from, void_to, MAX(best_pct) AS pct, MIN(best_min) AS min_stay FROM demand_nights
            WHERE dead = 1 AND void_from >= ? AND void_from <= ? GROUP BY listing_id, void_from, void_to", [$today, Util::addDays($today, (int)$cfg['max_days_ahead'])]);
        $live = [];
        foreach ($voids as $v) {
            $key = "{$v['listing_id']}|{$v['void_from']}|{$v['void_to']}";
            $live[$key] = true;
            if ($this->app->one("SELECT 1 FROM adjustments WHERE listing_id = ? AND date_from = ? AND date_to = ? AND status IN ('active','failed')", [$v['listing_id'], $v['void_from'], $v['void_to']])) continue;
            $done[] = $this->apply($v);
        }
        // Undo: the model no longer calls it dead (it filled, or demand changed), or it has passed.
        foreach ($this->app->all("SELECT * FROM adjustments WHERE status = 'active'") as $a) {
            if ($a['date_to'] <= $today) { $this->app->update('adjustments', $a['id'], ['status' => 'expired']); continue; }
            if (!isset($live["{$a['listing_id']}|{$a['date_from']}|{$a['date_to']}"]) && (new Demand($this->app))->status()['fresh']) $done[] = $this->revert($a['id'], 'model no longer expects it to stay empty');
        }
        return $done;
    }

    private function apply(array $v): string
    {
        $cfg = $this->app->config['autopilot'];
        $l = (new Content($this->app))->listing($v['listing_id']);
        $pct = min((int)$v['pct'], (int)$cfg['max_discount_pct']);
        $minStay = $cfg['allow_min_stay'] && $v['min_stay'] !== null ? (int)$v['min_stay'] : null;
        $cal = $this->app->rates()->calendar($l, $v['void_from'], $v['void_to']);
        $old = $new = [];
        foreach ($cal as $d => $day) {
            $old[$d] = $day['price'];
            if ($pct > 0 && $day['price'] !== null) $new[$d] = max((float)$cfg['floor_gbp'], round($day['price'] * (1 - $pct / 100)));
        }
        $oldMin = null;
        foreach ($cal as $day) if ($day['min_stay'] !== null) $oldMin = max($oldMin ?? 0, (int)$day['min_stay']);
        if (!$new && ($minStay === null || $minStay >= ($oldMin ?? 1))) return "{$l['name']} {$v['void_from']}: nothing within limits to change";
        $id = Util::id('adj_');
        $what = trim(($new ? "$pct% off" : '') . ($minStay !== null && $minStay < ($oldMin ?? 1) ? ($new ? ', ' : '') . "$minStay-night stays" : ''));
        $row = ['id' => $id, 'listing_id' => $l['id'], 'date_from' => $v['void_from'], 'date_to' => $v['void_to'], 'old_prices' => Util::enc($old), 'old_min_stay' => $oldMin,
            'new_price_pct' => $new ? $pct : null, 'new_min_stay' => $minStay, 'reason' => "Dead void: model's fix is $what", 'applied_at' => Util::now()];
        try {
            $this->app->rates()->setCalendar($l, $new, $minStay !== null && $minStay < ($oldMin ?? 1) ? [$v['void_from'], $v['void_to'], $minStay] : null);
            $this->app->insert('adjustments', $row + ['status' => 'active']);
        } catch (Throwable $e) {
            $this->app->insert('adjustments', $row + ['status' => 'failed', 'note' => $e->getMessage()]);
            return "{$l['name']} {$v['void_from']}: failed, " . $e->getMessage();
        }
        $label = Util::fmtDate($v['void_from']) . ' to ' . Util::fmtDate(Util::addDays($v['void_to'], -1));
        $this->app->log('adjustments', $id, "Applied on Beds24/Airbnb: {$l['name']}, $label, $what");
        $this->app->inbox()->propose("adjust:$id", "Applied on Airbnb via Beds24: $what for {$l['name']}, $label", '/admin/adjustments',
            "The booking model expects these nights to stay empty as they are. Undo it from the booking-site admin if you'd rather not.", null, true);
        return "{$l['name']} $label: $what";
    }

    public function revert(string $id, string $why = 'undone by hand'): string
    {
        $a = $this->app->one('SELECT * FROM adjustments WHERE id = ?', [$id]);
        if (!$a || $a['status'] !== 'active') return 'That change is not active.';
        $l = (new Content($this->app))->listing($a['listing_id']);
        $old = array_filter(Util::json($a['old_prices']), fn($p) => $p !== null);
        try {
            $this->app->rates()->setCalendar($l, $a['new_price_pct'] ? $old : [], $a['new_min_stay'] !== null && $a['old_min_stay'] !== null ? [$a['date_from'], $a['date_to'], (int)$a['old_min_stay']] : null);
        } catch (Throwable $e) {
            return 'Could not undo: ' . $e->getMessage();
        }
        $this->app->update('adjustments', $id, ['status' => 'reverted', 'reverted_at' => Util::now(), 'note' => $why]);
        $this->app->log('adjustments', $id, "Undone ($why)");
        return "Undone for {$l['name']}, " . Util::fmtDate($a['date_from']) . " ($why).";
    }
}
