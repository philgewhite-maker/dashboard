<?php
declare(strict_types=1);

/**
 * Where nightly prices and availability come from, and where the site's
 * holds go so Airbnb sees them.
 *   LocalRates  - base_rate from the listing; no outside calendar (dev/tests).
 *   IcalRates   - Airbnb's calendar export for availability, base_rate for
 *                 price. Usable before Beds24 exists; holds are NOT pushed
 *                 to Airbnb, so the owner blocks Airbnb by hand on approval.
 *   Beds24Rates - the real thing: prices, min stay, availability, and holds
 *                 written back so Airbnb is blocked straight away.
 * All three also treat the site's own live bookings as unavailable, which
 * covers the gap between a hold and the next calendar refresh.
 */
abstract class RateSource
{
    public const BLOCKING = ['checkout', 'requested', 'approved', 'confirmed'];

    /** A booking whose own hold should not count against it (set while re-checking it). */
    public ?string $except = null;

    public function __construct(protected App $app) {}

    /** @return array<string,array{price:?float,available:bool,min_stay:?int}> keyed by night date */
    abstract public function calendar(array $listing, string $from, string $to): array;

    /** Holds the dates for a booking part; returns the outside reference, if any. */
    public function hold(array $listing, array $booking, array $part): ?string { return null; }
    public function confirm(?string $ref): void {}
    public function release(?string $ref): void {}
    /** Whether holds reach Airbnb by themselves (drives the owner's email). */
    public function pushesToAirbnb(): bool { return false; }
    /** Pulls outside calendars into rate_cache; returns rows written. */
    public function refresh(): int { return 0; }

    /** Nights the site itself has promised, excluding one booking (when re-checking it). */
    protected function ownBlocked(string $listingId, string $from, string $to, ?string $exceptBooking = null): array
    {
        $in = implode(',', array_fill(0, count(self::BLOCKING), '?'));
        $rows = $this->app->all(
            "SELECT b.arrival, b.departure FROM booking_parts p JOIN bookings b ON b.id = p.booking_id
             WHERE p.listing_id = ? AND b.status IN ($in) AND b.arrival < ? AND b.departure > ? AND b.id != ?",
            [$listingId, ...self::BLOCKING, $to, $from, $exceptBooking ?? '']
        );
        $set = [];
        foreach ($rows as $r) foreach (Util::nights($r['arrival'], $r['departure']) as $d) $set[$d] = true;
        return $set;
    }

    protected function fromCache(array $listing, string $from, string $to, bool $usePrice): array
    {
        $rows = $this->app->all('SELECT * FROM rate_cache WHERE listing_id = ? AND date >= ? AND date < ?', [$listing['id'], $from, $to]);
        $byDate = array_column($rows, null, 'date');
        $own = $this->ownBlocked($listing['id'], $from, $to, $this->except);
        $out = [];
        foreach (Util::nights($from, $to) as $d) {
            $c = $byDate[$d] ?? null;
            $out[$d] = [
                'price' => $usePrice && $c && $c['price'] !== null ? (float)$c['price'] : ($listing['base_rate'] !== null ? (float)$listing['base_rate'] : null),
                // No cached row = not refreshed that far ahead: treat as unknown, i.e. not bookable.
                'available' => $c !== null && (bool)$c['available'] && !isset($own[$d]),
                'min_stay' => $c['min_stay'] ?? null,
            ];
        }
        return $out;
    }
}
