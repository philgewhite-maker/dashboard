<?php
declare(strict_types=1);

/**
 * One lower offer when a booking falls through on the guest's side: a card
 * checkout abandoned, or an accepted request not paid in time. (Never after
 * the owner declined.) Sent once per guest and dates, only if:
 *  - the dates are still free,
 *  - a fresh projection from the dashboard's booking model says they'd
 *    probably stay empty (average chance of booking below demand.low_prob),
 *  - the new price is clearly lower: reoffer.pct below what they were
 *    quoted, but never below what the nights are expected to bring if left
 *    open (+ margin).
 * The email carries a signed link that holds that total for these exact
 * dates, guests and currency for reoffer.hours_valid; nothing else changes.
 */
final class ReOffer
{
    public function __construct(private App $app) {}

    public static function make(App $app, array $o): string
    {
        $payload = rtrim(strtr(base64_encode(Util::enc($o)), '+/', '-_'), '=');
        return $payload . '.' . Util::sign("offer.$payload", $app->config['site']['secret']);
    }

    /** The held offer, or null if forged, malformed or expired. */
    public static function parse(App $app, string $token): ?array
    {
        [$payload, $sig] = array_pad(explode('.', $token, 2), 2, '');
        if ($payload === '' || !hash_equals(Util::sign("offer.$payload", $app->config['site']['secret']), $sig)) return null;
        $o = Util::json((string)base64_decode(strtr($payload, '-_', '+/')));
        foreach (['p', 'a', 'd', 'n', 'c', 't', 'x'] as $k) if (!isset($o[$k])) return null;
        return $o['x'] >= time() ? $o : null;
    }

    /** Returns true if an offer went out. */
    public function maybeSend(?array $b): bool
    {
        $cfg = $this->app->config['demand'];
        // Only when the guest didn't complete: not when the owner declined or didn't answer.
        $guestSide = in_array($b['note'] ?? '', ['Card checkout was not completed.', 'Payment not received in time.'], true);
        if (!$b || !$cfg['enabled'] || !$cfg['reoffer']['enabled'] || $b['status'] !== 'expired' || !$guestSide) return false;
        $key = 'reoffer:' . strtolower($b['guest_email']) . "|{$b['product_id']}|{$b['arrival']}";
        if ($this->app->one("SELECT 1 FROM activity WHERE entity = 'reoffer' AND entity_id = ?", [$key])) return false;

        $prevSite = $this->app->site;
        $this->app->site = $this->app->siteById($b['site_id']) ?? $prevSite;
        try {
            $product = (new Content($this->app))->product($b['product_id']);
            $q = (new Pricing($this->app))->quote($product['slug'], $b['arrival'], $b['departure'], (int)$b['adults'], $b['currency']);
            if (!$q['ok']) return false;                     // dates gone, or no longer bookable
            // Only when the model says these dates would probably stay empty.
            $demand = new Demand($this->app);
            $probs = [];
            $floorGbp = 0.0;
            foreach ($q['parts'] as $p) {
                $dem = $demand->nights($p['listing_id'], $b['arrival'], $b['departure']);
                foreach ($p['nightly_gbp'] as $d => $price) {
                    if (isset($dem[$d])) { $probs[] = (float)$dem[$d]['prob']; $floorGbp += min($price, $dem[$d]['income'] * (1 + $cfg['margin_pct'] / 100)); }
                    else $floorGbp += $price;
                }
            }
            if (!$probs || array_sum($probs) / count($probs) > $cfg['low_prob']) return false;
            $was = min((int)$b['total_minor'], (int)$q['total_minor']);
            $floor = Util::toMinor($floorGbp * $q['fx'], $b['currency']);
            $offer = max($floor, (int)round($was * (1 - $cfg['reoffer']['pct'] / 100)));
            if ($offer > (int)round((int)$b['total_minor'] * 0.97)) return false;  // not clearly lower: don't bother the guest

            $until = time() + (int)$cfg['reoffer']['hours_valid'] * 3600;
            $token = self::make($this->app, ['p' => $product['slug'], 'a' => $b['arrival'], 'd' => $b['departure'], 'n' => (int)$b['adults'], 'c' => $b['currency'], 't' => $offer, 'x' => $until]);
            $bk = new Bookings($this->app);
            $link = $bk->base($b) . "/stay/{$product['slug']}/?offer=" . rawurlencode($token);
            $bk->mail($b['guest_email'], "Still thinking about {$product['name']}? " . Util::money($offer, $b['currency']) . ' for your dates',
                "Hello {$b['guest_name']},\n\nYour dates, " . Util::fmtDate($b['arrival']) . ' to ' . Util::fmtDate($b['departure']) . ", are still free, and we can do them for " .
                Util::money($offer, $b['currency']) . ' (was ' . Util::money((int)$b['total_minor'], $b['currency']) . ').' .
                "\n\nThat price is held for you until " . date('D j M, H:i', $until) . " (UK time):\n$link\n\nIf your plans have changed, no need to reply: this is the only reminder we'll send.\n",
                $bk->hostFrom($b['id']), $b);
            $this->app->log('reoffer', $key, "Offered {$b['ref']}'s dates again at " . Util::money($offer, $b['currency']));
            return true;
        } finally {
            $this->app->site = $prevSite;
        }
    }
}
