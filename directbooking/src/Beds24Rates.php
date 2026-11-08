<?php
declare(strict_types=1);

/**
 * Beds24 API v2. Endpoint and field names are from Beds24's v2 docs as
 * understood when this was written -- milestone 4 of the plan is checking
 * them against a real account, starting with which booking status blocks
 * Airbnb (config beds24.hold_status).
 */
final class Beds24Rates extends RateSource
{
    public const DAYS_AHEAD = 400;

    public function calendar(array $listing, string $from, string $to): array
    {
        return $this->fromCache($listing, $from, $to, true);
    }

    public function pushesToAirbnb(): bool
    {
        return true;
    }

    public function refresh(): int
    {
        $n = 0;
        $today = date('Y-m-d');
        foreach ($this->app->all("SELECT * FROM listings WHERE beds24_room_id IS NOT NULL AND beds24_room_id != ''") as $l) {
            $res = $this->call('GET', '/inventory/rooms/calendar?' . http_build_query([
                'roomId' => $l['beds24_room_id'], 'startDate' => $today, 'endDate' => Util::addDays($today, self::DAYS_AHEAD),
                'includePrices' => 'true', 'includeNumAvail' => 'true', 'includeMinStay' => 'true',
            ]));
            $this->app->db->beginTransaction();
            $this->app->exec('DELETE FROM rate_cache WHERE listing_id = ?', [$l['id']]);
            foreach ($res['data'] ?? [] as $room) {
                foreach ($room['calendar'] ?? [] as $span) {
                    $last = $span['to'] ?? $span['from'];
                    for ($d = $span['from']; $d <= $last; $d = Util::addDays($d, 1)) {
                        $this->app->insert('rate_cache', [
                            'listing_id' => $l['id'], 'date' => $d,
                            'price' => isset($span['price1']) ? (float)$span['price1'] : null,
                            'available' => (int)(($span['numAvail'] ?? 0) > 0),
                            'min_stay' => isset($span['minStay']) ? (int)$span['minStay'] : null,
                            'updated_at' => Util::now(),
                        ]);
                        $n++;
                    }
                }
            }
            $this->app->db->commit();
        }
        return $n;
    }

    public function hold(array $listing, array $booking, array $part): ?string
    {
        if (empty($listing['beds24_room_id'])) return null;
        [$first, $last] = array_pad(explode(' ', trim($booking['guest_name']), 2), 2, '');
        $res = $this->call('POST', '/bookings', [[
            'roomId' => (int)$listing['beds24_room_id'],
            'status' => $this->app->config['beds24']['hold_status'],
            'arrival' => $booking['arrival'],
            'departure' => $booking['departure'],
            'numAdult' => (int)$booking['adults'],
            'firstName' => $first, 'lastName' => $last,
            'email' => $booking['guest_email'], 'mobile' => $booking['guest_phone'] ?? '',
            'price' => $part['amount_minor'] / Util::minorFactor($booking['currency']),
            'referer' => 'Direct site ' . $booking['ref'],
            'notes' => "Direct booking {$booking['ref']} ({$booking['currency']}).",
        ]]);
        $id = self::findId($res);
        if (!$id) throw new RuntimeException('Beds24 did not return a booking id: ' . Util::enc($res));
        return (string)$id;
    }

    public function confirm(?string $ref): void
    {
        if ($ref) $this->call('POST', '/bookings', [['id' => (int)$ref, 'status' => $this->app->config['beds24']['confirm_status']]]);
    }

    public function release(?string $ref): void
    {
        if ($ref) $this->call('POST', '/bookings', [['id' => (int)$ref, 'status' => 'cancelled']]);
    }

    /** Prices and minimum stay on the shared calendar (Beds24 passes them to Airbnb). VERIFY the v2 field names live. */
    public function canSetCalendar(): bool { return true; }

    public function setCalendar(array $listing, array $prices, ?array $minStay): void
    {
        if (empty($listing['beds24_room_id'])) throw new RuntimeException("{$listing['name']} has no Beds24 room id.");
        $cal = [];
        foreach ($prices as $d => $p) $cal[] = ['from' => $d, 'to' => $d, 'price1' => (float)$p];
        if ($minStay) $cal[] = ['from' => $minStay[0], 'to' => Util::addDays($minStay[1], -1), 'minStay' => (int)$minStay[2]];
        if ($cal) $this->call('POST', '/inventory/rooms/calendar', [['roomId' => (int)$listing['beds24_room_id'], 'calendar' => $cal]]);
        $this->refresh(); // so this site sees the new prices at once
    }

    private static function findId(mixed $res): mixed
    {
        if (!is_array($res)) return null;
        if (isset($res['new']['id'])) return $res['new']['id'];
        if (isset($res['id']) && is_scalar($res['id'])) return $res['id'];
        foreach ($res as $v) if (($id = self::findId($v)) !== null) return $id;
        return null;
    }

    private function token(): string
    {
        $file = $this->app->config['paths']['data'] . '/beds24-token.json';
        $cached = is_file($file) ? Util::json(file_get_contents($file)) : [];
        if (($cached['expires'] ?? 0) > time() + 60) return $cached['token'];
        [$code, $body] = Util::http('GET', $this->app->config['beds24']['api'] . '/authentication/token', ['refreshToken: ' . $this->app->config['beds24']['refresh_token']]);
        $j = Util::json($body);
        if ($code !== 200 || empty($j['token'])) throw new RuntimeException("Beds24 token refresh failed (HTTP $code): $body");
        file_put_contents($file, Util::enc(['token' => $j['token'], 'expires' => time() + (int)($j['expiresIn'] ?? 3600)]));
        return $j['token'];
    }

    private function call(string $method, string $path, ?array $body = null): array
    {
        $headers = ['token: ' . $this->token(), 'accept: application/json'];
        if ($body !== null) $headers[] = 'Content-Type: application/json';
        [$code, $res] = Util::http($method, $this->app->config['beds24']['api'] . $path, $headers, $body !== null ? Util::enc($body) : null);
        if ($code >= 300) throw new RuntimeException("Beds24 $method $path: HTTP $code $res");
        return Util::json($res);
    }
}
