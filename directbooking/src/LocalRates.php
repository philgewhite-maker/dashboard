<?php
declare(strict_types=1);

/** base_rate for price and only the site's own bookings for availability: dev and tests. */
final class LocalRates extends RateSource
{
    public function calendar(array $listing, string $from, string $to): array
    {
        $own = $this->ownBlocked($listing['id'], $from, $to, $this->except);
        $out = [];
        foreach (Util::nights($from, $to) as $d) {
            $out[$d] = ['price' => $listing['base_rate'] !== null ? (float)$listing['base_rate'] : null, 'available' => !isset($own[$d]), 'min_stay' => null];
        }
        return $out;
    }
}
