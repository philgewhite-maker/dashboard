<?php
declare(strict_types=1);

/**
 * Builds the quote a guest sees and books against.
 *
 * Price per night = the rate source's nightly price (the same price Beds24
 * pushes to Airbnb) less the direct discount for that night. Then, per
 * listing: length-of-stay discount, multi-room discount, bank-method
 * discount. Converted once into the guest's currency at a locked rate.
 * No surcharge for any payment method: UK law bans them on consumer cards.
 */
final class Pricing
{
    private Content $content;

    public function __construct(private App $app)
    {
        $this->content = new Content($app);
    }

    /** Payment methods the whole product can take (every owner must offer it). */
    public function methodsFor(array $product, string $currency): array
    {
        $out = null;
        foreach ($product['listings'] as $l) {
            $mine = [];
            foreach ($l['host']['methods'] as $m => $cfg) {
                if (!$cfg) continue;
                if ($this->methodAccepts($m, $cfg, $currency) && ($this->isManual($m) || $l['host']['stripe_account'] || $this->app->config['payments']['gateway'] === 'fake')) $mine[] = $m;
            }
            $out = $out === null ? $mine : array_values(array_intersect($out, $mine));
        }
        return $out ?? [];
    }

    public function isManual(string $method): bool
    {
        return in_array($method, ['bank_transfer', 'revolut', 'usdt'], true);
    }

    private function methodAccepts(string $method, mixed $cfg, string $currency): bool
    {
        if ($method === 'bank_transfer') return is_array($cfg) && !empty($cfg[$currency]);
        if ($method === 'usdt') return $currency === 'USD';
        if ($method === 'revolut') return true;
        $allowed = $this->app->config['method_currencies'][$method] ?? [];
        return $allowed === '*' || in_array($currency, (array)$allowed, true);
    }

    private function isBankType(string $method): bool
    {
        return in_array($method, ['pay_by_bank', 'bank_transfer', 'revolut'], true);
    }

    public function quote(string $productSlug, string $arrival, string $departure, int $adults, string $currency = 'GBP', ?string $method = null, bool $publicOnly = true): array
    {
        $cfg = $this->app->config['booking'];
        $currency = strtoupper($currency);
        $errors = [];
        $q = ['ok' => false, 'product' => $productSlug, 'arrival' => $arrival, 'departure' => $departure, 'adults' => $adults, 'currency' => $currency, 'method' => $method];

        $product = $this->content->product($productSlug);
        if ($product && $publicOnly && $this->app->site && !Content::siteLists($this->app->site, $product['id'])) $product = null;
        if (!$product || ($publicOnly && $product['status'] !== 'published')) return $q + ['errors' => ['That room or package is not available.']];
        if (!Util::isDate($arrival) || !Util::isDate($departure)) return $q + ['errors' => ['Pick valid dates.']];
        $nights = Util::nightsBetween($arrival, $departure);
        if ($nights < 1) return $q + ['errors' => ['Departure must be after arrival.']];
        if ($arrival < date('Y-m-d')) $errors[] = 'Arrival is in the past.';
        if ($nights > 366) $errors[] = 'Stays are limited to a year; get in touch for longer.';
        $capacity = array_sum(array_map(fn($l) => (int)$l['max_guests'], $product['listings']));
        if ($adults < 1 || $adults > $capacity) $errors[] = "This sleeps up to $capacity.";
        if (!in_array($currency, $cfg['currencies'], true) && !$this->krwAllowed($currency, $method)) $errors[] = "Prices can't be shown in $currency.";

        $q['nights'] = $nights;
        $q['product_name'] = $product['name'];
        $rules = $this->rulesFor($product['id']);
        $dates = Util::nights($arrival, $departure);

        // Direct-specific rules for the stay: strictest policy, longest minimum.
        $policy = $cfg['default_policy'];
        $minNights = 1;
        foreach ($dates as $d) {
            foreach ($this->rulesOn($rules, $d) as $r) {
                if (Cancellation::valid($r['cancellation_policy'])) $policy = Cancellation::stricter($policy, $r['cancellation_policy']);
                if ($r['min_nights']) $minNights = max($minNights, (int)$r['min_nights']);
            }
        }
        if ($nights >= $cfg['long_stay_nights']) $policy = 'long_term';

        $fx = 1.0;
        try { $fx = (new Fx($this->app))->rate($currency); } catch (RuntimeException $e) { $errors[] = $e->getMessage(); }
        $q['fx'] = $fx;

        $parts = [];
        $grossGbp = 0.0;
        foreach ($product['listings'] as $l) {
            $cal = $this->app->rates()->calendar($l, $arrival, $departure);
            $host = $l['host'];
            $sub = 0.0;
            $nightly = [];
            foreach ($dates as $i => $d) {
                $day = $cal[$d] ?? null;
                if (!$day || !$day['available']) { $errors[] = "{$l['name']} is not free on " . Util::fmtDate($d) . '.'; continue; }
                if ($i === 0 && !empty($day['min_stay'])) $minNights = max($minNights, (int)$day['min_stay']);
                $price = $day['price'] ?? $l['base_rate'];
                if ($price === null) { $errors[] = "{$l['name']} has no price for " . Util::fmtDate($d) . '.'; continue; }
                $disc = $host['default_discount_pct'] ?? $cfg['default_discount_pct'];
                foreach ($this->rulesOn($rules, $d) as $r) if ($r['discount_pct'] !== null) $disc = (float)$r['discount_pct'];
                $grossGbp += (float)$price;
                $nightly[$d] = round((float)$price * (1 - $disc / 100), 2);
                $sub += $nightly[$d];
            }
            $lines = [['label' => "{$l['name']}: $nights night" . ($nights > 1 ? 's' : ''), 'gbp' => $sub]];
            $c = $l['content'];
            $los = $nights >= 28 ? ($c['monthly_discount_pct'] ?? 0) : ($nights >= 7 ? ($c['weekly_discount_pct'] ?? 0) : 0);
            if ($los > 0) $lines[] = ['label' => ($nights >= 28 ? 'Monthly' : 'Weekly') . " discount ($los%)", 'gbp' => -$sub * $los / 100];
            $after = $sub * (1 - $los / 100);
            if (count($product['listings']) > 1 && $product['multi_room_discount_pct'] > 0) {
                $lines[] = ['label' => "Multi-room discount ({$product['multi_room_discount_pct']}%)", 'gbp' => -$after * $product['multi_room_discount_pct'] / 100];
                $after *= 1 - $product['multi_room_discount_pct'] / 100;
            }
            if ($method && $this->isBankType($method) && $cfg['bank_discount_pct'] > 0) {
                $lines[] = ['label' => "Pay-by-bank discount ({$cfg['bank_discount_pct']}%)", 'gbp' => -$after * $cfg['bank_discount_pct'] / 100];
                $after *= 1 - $cfg['bank_discount_pct'] / 100;
            }
            $amount = Util::toMinor($after * $fx, $currency);
            foreach ($lines as &$line) $line['minor'] = Util::toMinor($line['gbp'] * $fx, $currency);
            unset($line);
            $parts[] = [
                'listing_id' => $l['id'], 'listing_name' => $l['name'], 'host_id' => $host['id'], 'host_name' => $host['name'],
                'nightly_gbp' => $nightly, 'lines' => $lines, 'amount_minor' => $amount,
            ];
        }
        if ($nights < $minNights) $errors[] = "These dates need a minimum stay of $minNights nights.";

        $methods = $this->methodsFor($product, $currency);
        if ($method !== null && !in_array($method, $methods, true)) $errors[] = 'That payment method is not available for this booking and currency.';

        $total = array_sum(array_column($parts, 'amount_minor'));
        $q = array_merge($q, [
            'ok' => !$errors,
            'errors' => array_values(array_unique($errors)),
            'product_id' => $product['id'],
            'parts' => $parts,
            'total_minor' => $total,
            'total_text' => Util::money($total, $currency),
            'min_nights' => $minNights,
            'policy' => $policy,
            'policy_text' => Cancellation::POLICIES[$policy]['text'],
            'methods' => $methods,
            'schedule' => $this->schedule($parts, $arrival, $departure, $nights),
        ]);
        if ($cfg['show_airbnb_comparison']) $q['airbnb_gbp'] = round($grossGbp, 2);
        return $q;
    }

    private function krwAllowed(string $currency, ?string $method): bool
    {
        return $currency === 'KRW' && in_array($method, ['kakao_pay', 'naver_pay'], true);
    }

    private function rulesFor(string $productId): array
    {
        $rows = $this->app->all('SELECT * FROM rate_rules WHERE product_id IS NULL OR product_id = ?', [$productId]);
        return [...$rows, ...$this->content->occurrenceRules()];
    }

    private function rulesOn(array $rules, string $date): array
    {
        return array_filter($rules, fn($r) => $r['start_date'] <= $date && $date <= $r['end_date']);
    }

    /**
     * One payment per part for a normal stay. A long stay is billed monthly
     * in advance: one instalment per calendar month from arrival, split by
     * nights, the first due on approval and the rest a notice period before
     * each month starts.
     */
    private function schedule(array $parts, string $arrival, string $departure, int $nights): array
    {
        $cfg = $this->app->config['booking'];
        $periods = [[$arrival, $departure]];
        if ($nights >= $cfg['long_stay_nights']) {
            $periods = [];
            for ($from = $arrival; $from < $departure; ) {
                $to = min($departure, date('Y-m-d', strtotime("$from +1 month")));
                $periods[] = [$from, $to];
                $from = $to;
            }
        }
        $out = [];
        foreach ($parts as $pi => $p) {
            $left = $p['amount_minor'];
            foreach ($periods as $i => [$from, $to]) {
                $last = $i === count($periods) - 1;
                $amt = $last ? $left : (int)round($p['amount_minor'] * Util::nightsBetween($from, $to) / $nights);
                $left -= $amt;
                $out[] = [
                    'part' => $pi, 'seq' => $i + 1, 'covers_from' => $from, 'covers_to' => $to, 'amount_minor' => $amt,
                    'due' => $i === 0 ? null : Util::addDays($from, -$cfg['instalment_notice_days']),
                ];
            }
        }
        return $out;
    }
}
