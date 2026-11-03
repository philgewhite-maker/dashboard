<?php
declare(strict_types=1);

/**
 * Periodic reviews that turn into tasks in Phil's dashboard, each linking
 * to the admin page where the work is done. Every task is keyed by its
 * period (week, month, quarter), so a review appears at most once per
 * period however often cron runs, and only when there's something to do.
 *
 * Nightly prices themselves are not reviewed here: the dashboard's own
 * quarterly Airbnb rate review already finds demand dates, and once Beds24
 * is connected those prices are set in Beds24 for both channels. This
 * covers what only the booking site knows.
 */
final class Reviews
{
    public function __construct(private App $app) {}

    public function run(?string $today = null): array
    {
        $today ??= date('Y-m-d');
        $inbox = $this->app->inbox();
        $week = date('o-\WW', strtotime($today));
        $month = substr($today, 0, 7);
        $quarter = substr($today, 0, 4) . '-Q' . (intdiv((int)substr($today, 5, 2) - 1, 3) + 1);
        $done = [];

        // Proposed changes waiting (TfL routes, next year's events): one task a week while any wait.
        $n = (int)$this->app->one("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'")['n'];
        if ($n) {
            $inbox->propose("approvals:$week", "Review $n proposed change" . ($n > 1 ? 's' : '') . ' in the booking site', '/admin#approvals',
                'Refreshed travel times and next year\'s event dates wait for a yes or no before they reach the site.');
            $done[] = "approvals: $n";
        }

        // Publishing blocked by unconfirmed text: weekly.
        $problems = (new Publisher($this->app))->check();
        if ($problems) {
            $inbox->propose("publish-blocked:$week", 'Booking site can\'t publish: ' . count($problems) . ' item' . (count($problems) > 1 ? 's' : '') . ' to confirm', '/admin',
                implode("\n", array_slice($problems, 0, 8)));
            $done[] = 'publish blocked: ' . count($problems);
        }

        // Events: monthly. Published event pages with no confirmed upcoming date,
        // and upcoming dates missing event rules.
        $missing = $thin = [];
        foreach ($this->app->all("SELECT * FROM event_series WHERE status = 'published' ORDER BY name") as $s) {
            $next = $this->app->one("SELECT * FROM occurrences WHERE series_id = ? AND status = 'published' AND start_date IS NOT NULL AND COALESCE(end_date, start_date) >= ? ORDER BY start_date LIMIT 1", [$s['id'], $today]);
            if (!$next) $missing[] = $s['name'];
            elseif ($next['start_date'] <= Util::addDays($today, 120) && $next['min_nights'] === null && $next['cancellation_policy'] === null) {
                $thin[] = "{$s['name']} on " . Util::fmtDate($next['start_date']);
            }
        }
        if ($missing || $thin) {
            $notes = ($missing ? "No confirmed upcoming date (page shows 'dates to be confirmed'):\n- " . implode("\n- ", $missing) . "\n" : '')
                . ($thin ? "\nWithin 4 months but no minimum stay or cancellation rule for the event:\n- " . implode("\n- ", $thin) . "\nSet them on the occurrence, and the event price in Beds24.\n" : '');
            $inbox->propose("events:$month", 'Review booking-site event dates and rules (' . (count($missing) + count($thin)) . ')', '/admin/table?table=occurrences', $notes);
            $done[] = 'events: ' . (count($missing) + count($thin));
        }

        // Travel times: quarterly, if any published route is over 6 months old
        // (the quarterly TfL refresh should normally have replaced it).
        $old = $this->app->all("SELECT r.*, p.name AS point FROM routes r JOIN points p ON p.id = r.point_id WHERE r.status = 'published' AND (r.verified_at IS NULL OR r.verified_at < ?)", [Util::addDays($today, -182)]);
        if ($old) {
            $inbox->propose("routes:$quarter", 'Refresh ' . count($old) . ' booking-site travel time' . (count($old) > 1 ? 's' : '') . ' over 6 months old', '/admin/table?table=routes',
                "Run the cron URL with &task=routes, then approve.\n- " . implode("\n- ", array_unique(array_column($old, 'point'))));
            $done[] = 'routes: ' . count($old);
        }

        // Direct pricing: quarterly check of the discount and rules against the year ahead.
        $rules = (int)$this->app->one('SELECT COUNT(*) AS n FROM rate_rules WHERE end_date >= ?', [$today])['n'];
        $inbox->propose("pricing:$quarter", 'Quarterly booking-site pricing check', '/admin/table?table=rate_rules',
            "Direct discount is {$this->app->config['booking']['default_discount_pct']}% below the Beds24/Airbnb price. $rules date rule(s) cover the year ahead.\n"
            . "Check: discount still about Airbnb's fee less card fees; long-stay discounts; event minimum stays and cancellation rules. Nightly prices themselves come from the dashboard's quarterly rate review.");
        $done[] = 'pricing check';

        return $done;
    }
}
