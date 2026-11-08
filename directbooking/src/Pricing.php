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
        $demand = new Demand($this->app);
        $autopilot = new Autopilot($this->app);
        $sourceMin = 1;      // the shared calendar's minimum (Beds24/Airbnb), which a dead-void offer may relax
        $offerNights = 0;
        $cals = [];
        $N = (int)$this->app->config['demand']['extension_nights'];
        foreach ($product['listings'] as $l) {
            // Wide enough to look for extension nights and short gaps either side.
            $cals[$l['id']] = $cal = $this->app->rates()->calendar($l, Util::addDays($arrival, -$N - 1), Util::addDays($departure, $N + 14));
            $dem = $demand->nights($l['id'], Util::addDays($arrival, -$N - 1), Util::addDays($departure, $N + 14));
            $orig = $autopilot->originalPrices($l['id'], Util::addDays($arrival, -$N - 1), Util::addDays($departure, $N + 14));
            $night = fn(string $d) => $this->nightPrice($l, $cal[$d] ?? null, $d, $rules, $dem[$d] ?? null, $orig[$d] ?? null);
            $host = $l['host'];
            $sub = $subDirect = 0.0;
            $nightly = [];
            $listingMin = 1;
            foreach ($dates as $i => $d) {
                $day = $cal[$d] ?? null;
                if (!$day || !$day['available']) { $errors[] = "{$l['name']} is not free on " . Util::fmtDate($d) . '.'; continue; }
                if ($i === 0 && !empty($day['min_stay'])) $listingMin = (int)$day['min_stay'];
                $np = $night($d);
                if ($np === null) { $errors[] = "{$l['name']} has no price for " . Util::fmtDate($d) . '.'; continue; }
                $grossGbp += $np['gross'];
                $nightly[$d] = $np['price'];
                $sub += $np['price'];
                $subDirect += $np['direct'];
                if ($np['offer']) $offerNights++;
            }
            // A dead void the model says sells better with shorter stays: the offer relaxes the calendar's minimum.
            $arr = $dem[$arrival] ?? null;
            if ($arr && $arr['dead'] && $arr['best_min'] !== null) $listingMin = min($listingMin, (int)$arr['best_min']);
            $sourceMin = max($sourceMin, $listingMin);
            $lines = [['label' => "{$l['name']}: $nights night" . ($nights > 1 ? 's' : ''), 'gbp' => $subDirect]];
            if ($subDirect - $sub > 0.005) $lines[] = ['label' => 'Special offer on quieter nights', 'gbp' => $sub - $subDirect];
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
            $nightFns[$l['id']] = $night;
        }
        $minNights = max($minNights, $sourceMin);
        if ($nights < $minNights) $errors[] = "These dates need a minimum stay of $minNights nights.";
        $extensions = $errors ? [] : $this->extensions($product, $cals, $nightFns ?? [], $arrival, $departure, $sourceMin, $fx, $currency);

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
            'offer_nights' => $offerNights,
            'extensions' => $extensions,
        ]);
        if ($cfg['show_airbnb_comparison']) $q['airbnb_gbp'] = round($grossGbp, 2);
        return $q;
    }

    /**
     * Upcoming windows of special-offer nights for a product (every room in it
     * free and quiet), for the booking box's "special offers" list.
     */
    public function offers(string $productSlug, int $days = 60): array
    {
        $product = (new Content($this->app))->product($productSlug);
        if (!$product || $product['status'] !== 'published' || ($this->app->site && !Content::siteLists($this->app->site, $product['id']))) return [];
        $from = Util::addDays(date('Y-m-d'), 1);
        $to = Util::addDays($from, $days);
        $rules = $this->rulesFor($product['id']);
        $byDate = [];
        foreach ($product['listings'] as $li => $l) {
            $cal = $this->app->rates()->calendar($l, $from, $to);
            $dem = (new Demand($this->app))->nights($l['id'], $from, $to);
            $orig = (new Autopilot($this->app))->originalPrices($l['id'], $from, $to);
            foreach (Util::nights($from, $to) as $d) {
                $day = $cal[$d] ?? null;
                $np = $day && $day['available'] ? $this->nightPrice($l, $day, $d, $rules, $dem[$d] ?? null, $orig[$d] ?? null) : null;
                if (!$np || !$np['offer']) { $byDate[$d] = false; continue; }
                if (($byDate[$d] ?? null) === false) continue;
                $byDate[$d] = ['direct' => ($byDate[$d]['direct'] ?? 0) + $np['direct'], 'price' => ($byDate[$d]['price'] ?? 0) + $np['price'], 'n' => ($byDate[$d]['n'] ?? 0) + 1,
                    'min' => max($byDate[$d]['min'] ?? 1, ($dem[$d]['dead'] ?? 0) && $dem[$d]['best_min'] !== null ? (int)$dem[$d]['best_min'] : (int)($day['min_stay'] ?? 1))];
            }
        }
        $windows = [];
        $cur = null;
        foreach ($byDate as $d => $x) {
            if ($x && $x['n'] === count($product['listings'])) {
                if (!$cur) $cur = ['from' => $d, 'nights' => 0, 'direct' => 0, 'price' => 0, 'low' => INF, 'min' => $x['min']];
                $cur['nights']++; $cur['direct'] += $x['direct']; $cur['price'] += $x['price']; $cur['low'] = min($cur['low'], $x['price']); $cur['min'] = min($cur['min'], $x['min']);
            } elseif ($cur) { $windows[] = $cur; $cur = null; }
        }
        if ($cur) $windows[] = $cur;
        return array_map(fn($w) => [
            'arrival' => $w['from'], 'departure' => Util::addDays($w['from'], $w['nights']), 'nights' => $w['nights'],
            'pct_off' => (int)round(100 * (1 - $w['price'] / $w['direct'])),
            'from_text' => 'from ' . Util::money(Util::toMinor($w['low'], 'GBP'), 'GBP') . '/night',
            'min_nights' => min($w['min'], $w['nights']),
            'label' => date('D j M', strtotime($w['from'])) . ($w['nights'] > 1 ? ' – ' . date('D j M', strtotime(Util::addDays($w['from'], $w['nights']))) : ''),
        ], array_slice(array_values(array_filter($windows, fn($w) => $w['nights'] >= 1)), 0, 6));
    }

    /**
     * One night of one listing: the shared calendar's price (before any
     * autopilot change, so a cut made for Airbnb isn't taken twice), less the
     * direct discount, then the model's special offer if the night is quiet.
     */
    private function nightPrice(array $l, ?array $day, string $d, array $rules, ?array $demandRow, ?float $original): ?array
    {
        $price = $original ?? $day['price'] ?? $l['base_rate'];
        if ($price === null) return null;
        $disc = $l['host']['default_discount_pct'] ?? $this->app->config['booking']['default_discount_pct'];
        foreach ($this->rulesOn($rules, $d) as $r) if ($r['discount_pct'] !== null) $disc = (float)$r['discount_pct'];
        $direct = round((float)$price * (1 - $disc / 100), 2);
        $offer = (new Demand($this->app))->offerPrice($direct, $demandRow);
        return ['gross' => (float)$price, 'direct' => $direct, 'price' => $offer ?? $direct, 'offer' => $offer !== null];
    }

    /**
     * Nights the guest could add either side of their stay:
     *  - a short gap: the free nights between this stay and the next booking
     *    (or the previous one) are fewer than the minimum stay, so nobody else
     *    can book them. Offered whole, at the offer price.
     *  - quiet nights: up to demand.extension_nights next to the stay that the
     *    model expects to stay empty, at their offer price.
     * Every listing in the product must be free those nights.
     */
    private function extensions(array $product, array $cals, array $nightFns, string $arrival, string $departure, int $minStay, float $fx, string $currency): array
    {
        $N = (int)$this->app->config['demand']['extension_nights'];
        $freeAll = function (string $d) use ($product, $cals) {
            foreach ($product['listings'] as $l) { $day = $cals[$l['id']][$d] ?? null; if (!$day || !$day['available']) return false; }
            return true;
        };
        $out = [];
        foreach (['before' => -1, 'after' => 1] as $side => $step) {
            $start = $side === 'before' ? Util::addDays($arrival, -1) : $departure;
            $run = [];
            for ($d = $start, $i = 0; $i < $N + 14 && $freeAll($d); $d = Util::addDays($d, $step), $i++) $run[] = $d;
            // Bounded by a booking (not just the end of what we can see), and too short for anyone else's minimum stay.
            $bounded = count($run) < $N + 14;
            $isGap = $run && $bounded && count($run) < max(2, $minStay);
            $nightsOut = [];
            foreach ($run as $k => $d) {
                if (!$isGap && $k >= $N) break;
                $total = 0.0; $allOffer = true;
                foreach ($product['listings'] as $l) {
                    $np = ($nightFns[$l['id']] ?? fn() => null)($d);
                    if (!$np) continue 3;
                    $priceForGap = max((float)$this->app->config['demand']['floor_gbp'], $np['direct'] * (1 - $this->app->config['demand']['max_discount_pct'] / 100));
                    $total += $np['offer'] ? $np['price'] : ($isGap ? min($np['direct'], $priceForGap) : $np['direct']);
                    if (!$np['offer']) $allOffer = false;
                }
                if (!$isGap && !$allOffer) break;
                $nightsOut[] = ['date' => $d, 'gbp' => $total];
            }
            if (!$nightsOut) continue;
            if ($side === 'before') $nightsOut = array_reverse($nightsOut);
            $gbp = array_sum(array_column($nightsOut, 'gbp'));
            $minor = Util::toMinor($gbp * $fx, $currency);
            $out[] = [
                'side' => $side, 'nights' => count($nightsOut),
                'arrival' => $side === 'before' ? $nightsOut[0]['date'] : $arrival,
                'departure' => $side === 'after' ? Util::addDays(end($nightsOut)['date'], 1) : $departure,
                'reason' => $isGap ? 'gap' : 'quiet',
                'extra_minor' => $minor, 'extra_text' => Util::money($minor, $currency),
                'text' => ($isGap
                    ? 'Fill the ' . (count($nightsOut) === 1 ? 'night' : count($nightsOut) . ' nights') . ($side === 'before' ? ' before your stay' : ' after your stay') . ' (nobody else can book ' . (count($nightsOut) === 1 ? 'it' : 'them') . ')'
                    : 'Add ' . (count($nightsOut) === 1 ? Util::fmtDate($nightsOut[0]['date']) : count($nightsOut) . ' nights ' . ($side === 'before' ? 'before' : 'after'))) . ' for ' . Util::money($minor, $currency),
            ];
        }
        return $out;
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
