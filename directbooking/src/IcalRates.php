<?php
declare(strict_types=1);

final class IcalRates extends RateSource
{
    public const DAYS_AHEAD = 400;

    public function calendar(array $listing, string $from, string $to): array
    {
        return $this->fromCache($listing, $from, $to, false);
    }

    public function refresh(): int
    {
        $n = 0;
        foreach ($this->app->all("SELECT * FROM listings WHERE ical_url IS NOT NULL AND ical_url != ''") as $l) {
            [$code, $body] = Util::http('GET', $l['ical_url']);
            if ($code !== 200) throw new RuntimeException("Calendar feed for {$l['name']} returned HTTP $code");
            $n += $this->store($l['id'], self::parse($body));
        }
        return $n;
    }

    /** Writes availability for the next DAYS_AHEAD nights from a list of blocked ranges. */
    public function store(string $listingId, array $ranges): int
    {
        $blocked = [];
        foreach ($ranges as [$s, $e]) foreach (Util::nights($s, $e) as $d) $blocked[$d] = true;
        $today = date('Y-m-d');
        $end = Util::addDays($today, self::DAYS_AHEAD);
        $this->app->db->beginTransaction();
        $this->app->exec('DELETE FROM rate_cache WHERE listing_id = ?', [$listingId]);
        $n = 0;
        foreach (Util::nights($today, $end) as $d) {
            $this->app->insert('rate_cache', ['listing_id' => $listingId, 'date' => $d, 'price' => null, 'available' => isset($blocked[$d]) ? 0 : 1, 'min_stay' => null, 'updated_at' => Util::now()]);
            $n++;
        }
        $this->app->db->commit();
        return $n;
    }

    /** Minimal VEVENT reader: returns [[start, endExclusive], ...] as Y-m-d. */
    public static function parse(string $ics): array
    {
        $ics = preg_replace("/\r?\n[ \t]/", '', $ics); // unfold continuation lines
        preg_match_all('/BEGIN:VEVENT(.*?)END:VEVENT/s', $ics, $events);
        $out = [];
        foreach ($events[1] as $ev) {
            if (!preg_match('/^DTSTART[^:]*:(\d{8})/m', $ev, $s)) continue;
            $start = DateTime::createFromFormat('Ymd', $s[1])->format('Y-m-d');
            $end = preg_match('/^DTEND[^:]*:(\d{8})/m', $ev, $e) ? DateTime::createFromFormat('Ymd', $e[1])->format('Y-m-d') : Util::addDays($start, 1);
            $out[] = [$start, $end];
        }
        return $out;
    }
}
