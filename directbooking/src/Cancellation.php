<?php
declare(strict_types=1);

/**
 * Cancellation policies named after Airbnb's, so guests and hosts read them
 * the same way. The wording here is our own understanding of Airbnb's
 * definitions when this was built -- CHECK against Airbnb's current help
 * page before launch; what binds a direct guest is what this site shows.
 */
final class Cancellation
{
    public const ORDER = ['flexible', 'moderate', 'firm', 'strict', 'long_term'];

    public const POLICIES = [
        'flexible' => [
            'name' => 'Flexible',
            'text' => 'Full refund if you cancel at least 1 day before check-in. After that, nights not stayed are refunded except the first.',
        ],
        'moderate' => [
            'name' => 'Moderate',
            'text' => 'Full refund if you cancel at least 5 days before check-in. After that, 50% of the nights not stayed is refunded.',
        ],
        'firm' => [
            'name' => 'Firm',
            'text' => 'Full refund if you cancel at least 30 days before check-in; 50% if at least 7 days before. No refund after that.',
        ],
        'strict' => [
            'name' => 'Strict',
            'text' => 'Full refund within 48 hours of booking if check-in is at least 14 days away; 50% if you cancel at least 7 days before check-in. No refund after that.',
        ],
        'long_term' => [
            'name' => 'Long stay',
            'text' => 'Full refund if you cancel at least 30 days before check-in. After that, the first 30 nights (or the whole stay, if shorter) are not refundable.',
        ],
    ];

    public static function valid(?string $p): bool
    {
        return $p !== null && isset(self::POLICIES[$p]);
    }

    public static function stricter(string $a, string $b): string
    {
        return array_search($a, self::ORDER, true) >= array_search($b, self::ORDER, true) ? $a : $b;
    }

    /**
     * Refund due, in minor units, if the guest cancels at $cancelAt.
     * $total is what the guest paid for the whole stay. Check-in is taken as
     * 15:00 on the arrival date.
     */
    public static function refund(string $policy, int $total, int $nights, string $bookedAt, string $cancelAt, string $arrival): int
    {
        $checkIn = strtotime("$arrival 15:00");
        $now = strtotime($cancelAt);
        $daysBefore = ($checkIn - $now) / 86400;
        $perNight = $nights > 0 ? $total / $nights : 0;
        $nightsLeft = $daysBefore >= 0 ? $nights : max(0, $nights - (int)ceil(-$daysBefore));

        $r = match ($policy) {
            'flexible' => $daysBefore >= 1 ? $total : $perNight * max(0, $nightsLeft - ($daysBefore >= 0 ? 1 : 0)),
            'moderate' => $daysBefore >= 5 ? $total : 0.5 * $perNight * $nightsLeft,
            'firm' => $daysBefore >= 30 ? $total : ($daysBefore >= 7 ? 0.5 * $total : 0),
            'strict' => ($now - strtotime($bookedAt) <= 48 * 3600 && $daysBefore >= 14) ? $total : ($daysBefore >= 7 ? 0.5 * $total : 0),
            'long_term' => $daysBefore >= 30 ? $total : $perNight * max(0, $nightsLeft - max(0, 30 - ($nights - $nightsLeft))),
            default => throw new InvalidArgumentException("Unknown policy $policy"),
        };
        return (int)floor(min($total, max(0, $r)));
    }
}
