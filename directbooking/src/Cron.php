<?php
declare(strict_types=1);

/**
 * Scheduled jobs. Run every 15 minutes from cPanel:
 *   php /path/to/directbooking/bin/cron.php
 * or, without SSH, by URL (key = Util::sign('cron', site.secret), printed by bin/setup.php):
 *   wget -q -O /dev/null "https://DOMAIN/cron?key=KEY"
 * Each job is independent: one failing doesn't stop the rest.
 */
final class Cron
{
    public function __construct(private App $app) {}

    public function run(string $task = 'all'): array
    {
        $jobs = [
            'expire' => fn() => (new Bookings($this->app))->expireDue(),
            'instalments' => fn() => (new Bookings($this->app))->sendDueInstalments(),
            'rates' => fn() => $this->app->rates()->refresh(),
            'fx' => fn() => $this->due('fx', 20 * 3600) ? (new Fx($this->app))->refresh() : 'fresh',
            'rollforward' => fn() => $this->due('rollforward', 24 * 3600) ? $this->rollForward() : 'done today',
            'routes' => fn() => (new Tfl($this->app))->proposeAll(),
        ];
        // Routes cost TfL calls and need approval, so they only run when asked for by name.
        $run = $task === 'all' ? array_diff_key($jobs, ['routes' => 1]) : array_intersect_key($jobs, [$task => 1]);
        $out = [];
        foreach ($run as $name => $fn) {
            try { $out[$name] = $fn(); }
            catch (Throwable $e) { $out[$name] = 'ERROR: ' . $e->getMessage(); $this->app->log('cron', $name, $e->getMessage()); }
        }
        return $out;
    }

    private function due(string $job, int $everySeconds): bool
    {
        $file = $this->app->config['paths']['data'] . "/cron-$job.last";
        if (is_file($file) && time() - (int)file_get_contents($file) < $everySeconds) return false;
        file_put_contents($file, (string)time());
        return true;
    }

    /**
     * For each yearly event with nothing upcoming, proposes next year's
     * occurrence 52 weeks on (same weekday). The dates are an estimate and
     * carry a [CHECK] marker, so they can't be published unconfirmed.
     */
    public function rollForward(): int
    {
        $n = 0;
        $today = date('Y-m-d');
        foreach ($this->app->all("SELECT * FROM event_series WHERE recurrence = 'annual'") as $s) {
            $upcoming = $this->app->one('SELECT 1 FROM occurrences WHERE series_id = ? AND (end_date IS NULL OR end_date >= ?)', [$s['id'], $today]);
            if ($upcoming) continue;
            $last = $this->app->one('SELECT * FROM occurrences WHERE series_id = ? AND start_date IS NOT NULL ORDER BY start_date DESC LIMIT 1', [$s['id']]);
            if (!$last) continue;
            $start = Util::addDays($last['start_date'], 364);
            $end = Util::addDays($last['end_date'] ?: $last['start_date'], 364);
            (new Approvals($this->app))->propose('occurrence.create', 'occurrences', null, "Next {$s['name']}: about " . Util::fmtDate($start), [
                'series_id' => $s['id'], 'start_date' => $start, 'end_date' => $end, 'ticket_url' => $last['ticket_url'],
                'min_nights' => $last['min_nights'], 'cancellation_policy' => $last['cancellation_policy'], 'discount_pct' => $last['discount_pct'],
                'source' => 'Estimated from last year', 'data' => Util::enc(['note' => '[CHECK] dates estimated from last year: confirm on the official site, then remove this note']),
            ]);
            $n++;
        }
        return $n;
    }
}
