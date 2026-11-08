<?php
declare(strict_types=1);

/**
 * Request-to-book, end to end.
 *
 *   checkout  -> dates held; card guest is at Stripe authorising (not charged)
 *   requested -> waiting for the owner; card authorised, or a pay-later method chosen
 *   approved  -> owner said yes; waiting for a pay-later payment
 *   confirmed -> first payment taken; Beds24 booking confirmed
 *   declined / expired / cancelled -> dates released, authorisations voided
 *
 * A booking has one part per listing, each paid to that listing's owner.
 * The dates are held in the rate source from the moment the request is
 * made, so Airbnb (via Beds24) can't sell them meanwhile.
 */
final class Bookings
{
    public const OPEN = ['checkout', 'requested', 'approved'];

    private Content $content;
    private Pricing $pricing;

    public function __construct(private App $app)
    {
        $this->content = new Content($app);
        $this->pricing = new Pricing($app);
    }

    // ---- guest side -------------------------------------------------------

    /** @return array{ok:bool, errors?:array, ref?:string, next_url?:string} */
    public function request(array $in): array
    {
        $guest = $in['guest'] ?? [];
        $errors = [];
        $name = trim((string)($guest['name'] ?? ''));
        $email = trim((string)($guest['email'] ?? ''));
        if (mb_strlen($name) < 2) $errors[] = 'Enter your full name.';
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) $errors[] = 'Enter a valid email address.';
        $method = (string)($in['method'] ?? '');
        if ($method === '') $errors[] = 'Pick how you would like to pay.';
        if ($errors) return ['ok' => false, 'errors' => $errors];

        $q = $this->pricing->quote((string)$in['product'], (string)$in['arrival'], (string)$in['departure'], (int)$in['adults'], (string)($in['currency'] ?? 'GBP'), $method);
        if (!$q['ok']) return ['ok' => false, 'errors' => $q['errors']];

        $cfg = $this->app->config['booking'];
        $id = Util::id('bk_');
        $ref = Util::ref();
        $card = $method === 'card';
        $b = [
            'id' => $id, 'ref' => $ref, 'site_id' => $this->app->site['id'] ?? null, 'product_id' => $q['product_id'], 'occurrence_id' => $in['occurrence_id'] ?? null,
            'arrival' => $q['arrival'], 'departure' => $q['departure'], 'nights' => $q['nights'], 'adults' => $q['adults'],
            'guest_name' => $name, 'guest_email' => $email,
            'guest_phone' => trim((string)($guest['phone'] ?? '')) ?: null, 'guest_country' => trim((string)($guest['country'] ?? '')) ?: null,
            'message' => trim(mb_substr((string)($in['message'] ?? ''), 0, 2000)) ?: null,
            'currency' => $q['currency'], 'total_minor' => $q['total_minor'], 'method' => $method, 'policy' => $q['policy'],
            'status' => $card ? 'checkout' : 'requested', 'quote' => Util::enc($q), 'created_at' => Util::now(),
            'requested_at' => $card ? null : Util::now(),
            'approve_by' => $card ? null : $this->hoursFromNow($cfg['approve_within_hours']),
        ];

        try {
            $this->app->tx(function () use ($b, $q, $method, $card, $id, $in) {
                // Re-check inside the write lock so two guests can't take the same night.
                $again = $this->pricing->quote((string)$in['product'], $b['arrival'], $b['departure'], (int)$b['adults'], $b['currency'], $method);
                if (!$again['ok']) throw new DomainException(implode(' ', $again['errors']));
                $this->app->insert('bookings', $b);
                foreach ($q['parts'] as $pi => $part) {
                    $partId = Util::id('pt_');
                    $this->app->insert('booking_parts', ['id' => $partId, 'booking_id' => $id, 'listing_id' => $part['listing_id'], 'host_id' => $part['host_id'], 'amount_minor' => $part['amount_minor'], 'status' => 'open']);
                    foreach (array_filter($q['schedule'], fn($s) => $s['part'] === $pi) as $s) {
                        $this->app->insert('payments', [
                            'id' => Util::id('pay_'), 'part_id' => $partId, 'seq' => $s['seq'], 'covers_from' => $s['covers_from'], 'covers_to' => $s['covers_to'],
                            'due_date' => $s['due'], 'amount_minor' => $s['amount_minor'], 'currency' => $q['currency'],
                            'kind' => $this->pricing->isManual($method) ? 'manual' : ($card && $s['seq'] === 1 ? 'card_auth' : 'link'), 'status' => 'pending',
                        ]);
                    }
                }
            });
        } catch (DomainException $e) {
            return ['ok' => false, 'errors' => [$e->getMessage()]];
        }

        // Hold in the outside calendar. If that fails, nothing is half-booked.
        try {
            foreach ($this->parts($id) as $p) {
                $l = $this->content->listing($p['listing_id']);
                $hold = $this->app->rates()->hold($l, $this->booking($id), $p);
                if ($hold) $this->app->update('booking_parts', $p['id'], ['hold_ref' => $hold]);
            }
        } catch (Throwable $e) {
            $this->close($id, 'cancelled', 'system', 'Could not hold the dates: ' . $e->getMessage());
            return ['ok' => false, 'errors' => ['Sorry, we could not hold those dates just now. Please try again in a few minutes.']];
        }
        $this->app->log('booking', $id, "Request $ref created ($method, " . Util::money($q['total_minor'], $q['currency']) . ')');

        if ($card) return ['ok' => true, 'ref' => $ref, 'next_url' => $this->nextCheckoutUrl($this->booking($id))];
        $this->notifyRequested($this->booking($id));
        return ['ok' => true, 'ref' => $ref, 'next_url' => $this->guestUrl($ref)];
    }

    /**
     * Where a card guest goes next: the first part not yet authorised gets a
     * Stripe checkout on its owner's account (two rooms = two checkouts in a
     * row). Returns the status page once everything is authorised.
     */
    public function nextCheckoutUrl(array $b): string
    {
        foreach ($this->firstPayments($b['id']) as $pay) {
            if ($pay['status'] !== 'pending' || $pay['kind'] !== 'card_auth') continue;
            $part = $this->app->one('SELECT * FROM booking_parts WHERE id = ?', [$pay['part_id']]);
            [$sid, $url] = $this->app->gateway()->authCheckout($this->account($part['host_id']), $this->checkoutParams($b, $pay, $part, $this->app->config['booking']['checkout_minutes']));
            $this->app->update('payments', $pay['id'], ['stripe_session_id' => $sid]);
            return $url;
        }
        return $this->guestUrl($b['ref']);
    }

    /** Guest came back from Stripe: sync what Stripe says, then move on. */
    public function returned(string $ref): string
    {
        $b = $this->byRef($ref);
        if (!$b) return $this->base(null);
        foreach ($this->payments($b['id']) as $pay) if ($pay['stripe_session_id'] && $pay['status'] === 'pending') $this->syncPayment($pay);
        $b = $this->booking($b['id']);
        return $b['status'] === 'checkout' ? $this->nextCheckoutUrl($b) : $this->guestUrl($ref);
    }

    /** A pay-later or instalment payment: open a fresh checkout for it. */
    public function payUrl(array $b, array $pay): ?string
    {
        if ($pay['kind'] === 'manual' || !in_array($pay['status'], ['pending'], true)) return null;
        if (!in_array($b['status'], ['approved', 'confirmed'], true)) return null;
        $part = $this->app->one('SELECT * FROM booking_parts WHERE id = ?', [$pay['part_id']]);
        $method = $pay['seq'] > 1 && $b['method'] === 'card' ? 'card' : $b['method'];
        [$sid, $url] = $this->app->gateway()->payCheckout($this->account($part['host_id']), $method, $this->checkoutParams($b, $pay, $part, 24 * 60));
        $this->app->update('payments', $pay['id'], ['stripe_session_id' => $sid]);
        return $url;
    }

    public function webhook(array $event): void
    {
        $type = $event['type'] ?? '';
        $session = $event['data']['object'] ?? [];
        $pay = isset($session['id']) ? $this->app->one('SELECT * FROM payments WHERE stripe_session_id = ?', [$session['id']]) : null;
        if (!$pay) return;
        if (in_array($type, ['checkout.session.completed', 'checkout.session.async_payment_succeeded'], true)) {
            $this->syncPayment($pay);
        } elseif ($type === 'checkout.session.expired') {
            $b = $this->bookingForPayment($pay);
            if ($b && $b['status'] === 'checkout') $this->close($b['id'], 'expired', 'system', 'Card checkout was not completed.');
        }
    }

    // ---- owner side -------------------------------------------------------

    /**
     * $priceMinor: approve at a LOWER total than requested (a counter-offer down,
     * e.g. when the dashboard's evaluator says the dates are worth less). Every
     * payment is scaled down; a card is charged the smaller amount from its
     * authorisation. A higher price needs the guest's agreement, so it isn't offered here.
     */
    public function approve(string $id, string $by, ?int $priceMinor = null): string
    {
        $b = $this->booking($id);
        if (!$b || $b['status'] !== 'requested') return 'Only a waiting request can be approved.';
        $note = '';
        if ($priceMinor !== null && $priceMinor !== (int)$b['total_minor']) {
            if ($priceMinor <= 0 || $priceMinor > (int)$b['total_minor']) return 'An approval price must be lower than the requested total.';
            $this->reprice($b, $priceMinor);
            $note = ' at the reduced price of ' . Util::money($priceMinor, $b['currency']);
            $b = $this->booking($id);
        }
        $cfg = $this->app->config['booking'];
        if ($b['method'] === 'card') {
            foreach ($this->firstPayments($id) as $pay) {
                $part = $this->app->one('SELECT * FROM booking_parts WHERE id = ?', [$pay['part_id']]);
                $this->app->gateway()->capture($this->account($part['host_id']), $pay['stripe_pi_id'], (int)$pay['amount_minor']);
                $this->app->update('payments', $pay['id'], ['status' => 'paid', 'paid_at' => Util::now()]);
            }
            $this->app->update('bookings', $id, ['status' => 'approved', 'decided_at' => Util::now(), 'decided_by' => $by]);
            $this->confirm($id);
            return "Approved and charged {$b['ref']}$note.";
        }
        $hours = $this->pricing->isManual($b['method']) ? $cfg['pay_within_hours']['manual'] : $cfg['pay_within_hours']['link'];
        $this->app->update('bookings', $id, ['status' => 'approved', 'pay_by' => $this->hoursFromNow($hours), 'decided_at' => Util::now(), 'decided_by' => $by]);
        $this->app->log('booking', $id, "Approved by $by; waiting for payment");
        $this->sendPaymentRequest($this->booking($id), $this->firstPayments($id));
        return "Approved {$b['ref']}$note; payment request sent to the guest.";
    }

    public function decline(string $id, string $by, string $reason = ''): string
    {
        $b = $this->booking($id);
        if (!$b || !in_array($b['status'], self::OPEN, true)) return 'That booking is not open.';
        $this->close($id, 'declined', $by, $reason);
        $this->mail($b['guest_email'], "Your request {$b['ref']} could not be accepted",
            "Hello {$b['guest_name']},\n\nSorry, we can't accept your request for " . Util::fmtDate($b['arrival']) . ' to ' . Util::fmtDate($b['departure']) . ".\n" .
            ($reason ? "\n$reason\n" : '') . "\nAny card authorisation has been released and you have not been charged.\n", $this->hostFrom($id), $b);
        return "Declined {$b['ref']}.";
    }

    public function markPaid(string $paymentId, string $by): string
    {
        $pay = $this->app->one('SELECT * FROM payments WHERE id = ?', [$paymentId]);
        if (!$pay || $pay['status'] !== 'pending') return 'That payment is not waiting.';
        $this->app->update('payments', $paymentId, ['status' => 'paid', 'paid_at' => Util::now()]);
        $b = $this->bookingForPayment($pay);
        $this->app->log('booking', $b['id'], "Payment $paymentId marked paid by $by");
        $this->advance($b['id']);
        return "Marked paid for {$b['ref']}.";
    }

    /** Cancels a confirmed or open booking and refunds what the policy allows. */
    public function cancel(string $id, string $by, ?string $at = null): string
    {
        $b = $this->booking($id);
        if (!$b || in_array($b['status'], ['declined', 'expired', 'cancelled'], true)) return 'That booking is already closed.';
        $paid = array_filter($this->payments($id), fn($p) => $p['status'] === 'paid');
        $paidTotal = array_sum(array_column($paid, 'amount_minor'));
        $refund = Cancellation::refund($b['policy'], $paidTotal, (int)$b['nights'], $b['requested_at'] ?? $b['created_at'], $at ?? Util::now(), $b['arrival']);
        $left = $refund;
        foreach ($paid as $pay) {
            if ($left <= 0) break;
            $amt = min($left, $pay['amount_minor']);
            $part = $this->app->one('SELECT * FROM booking_parts WHERE id = ?', [$pay['part_id']]);
            if ($pay['stripe_pi_id']) $this->app->gateway()->refund($this->account($part['host_id']), $pay['stripe_pi_id'], $amt);
            $this->app->update('payments', $pay['id'], ['refunded_minor' => $amt, 'status' => $amt === $pay['amount_minor'] ? 'refunded' : 'paid']);
            $left -= $amt;
        }
        $this->close($id, 'cancelled', $by, 'Cancelled; refund ' . Util::money($refund, $b['currency']));
        $manualNote = array_filter($paid, fn($p) => !$p['stripe_pi_id']) && $refund > 0 ? "\nPart of the refund was paid by bank, so it will be returned to you the same way.\n" : '';
        $this->mail($b['guest_email'], "Booking {$b['ref']} cancelled",
            "Hello {$b['guest_name']},\n\nYour booking for " . Util::fmtDate($b['arrival']) . " has been cancelled.\nRefund under the " .
            Cancellation::POLICIES[$b['policy']]['name'] . ' policy: ' . Util::money($refund, $b['currency']) . ".\n$manualNote", $this->hostFrom($id), $b);
        return "Cancelled {$b['ref']}; refund " . Util::money($refund, $b['currency']) . '.';
    }

    /** Scales every part and payment of a booking down to a new total; the last payment takes the rounding. */
    private function reprice(array $b, int $newTotal): void
    {
        $factor = $newTotal / (int)$b['total_minor'];
        $pays = $this->payments($b['id']);
        $left = $newTotal;
        foreach ($pays as $i => $p) {
            $amt = $i === count($pays) - 1 ? $left : (int)round($p['amount_minor'] * $factor);
            $left -= $amt;
            $this->app->update('payments', $p['id'], ['amount_minor' => $amt]);
        }
        foreach ($this->parts($b['id']) as $part) {
            $sum = (int)$this->app->one('SELECT SUM(amount_minor) AS s FROM payments WHERE part_id = ?', [$part['id']])['s'];
            $this->app->update('booking_parts', $part['id'], ['amount_minor' => $sum]);
        }
        $this->app->update('bookings', $b['id'], ['total_minor' => $newTotal]);
        $this->app->log('booking', $b['id'], 'Repriced from ' . Util::money((int)$b['total_minor'], $b['currency']) . ' to ' . Util::money($newTotal, $b['currency']));
    }

    // ---- scheduled jobs ---------------------------------------------------

    /** Closes requests nobody answered, unpaid approvals and abandoned checkouts. */
    public function expireDue(?string $now = null): int
    {
        $now ??= Util::now();
        $n = 0;
        $abandoned = date('Y-m-d H:i:s', strtotime($now) - ($this->app->config['booking']['checkout_minutes'] + 15) * 60);
        foreach ($this->app->all("SELECT id FROM bookings WHERE status = 'checkout' AND created_at < ?", [$abandoned]) as $r) {
            $this->close($r['id'], 'expired', 'system', 'Card checkout was not completed.'); $n++;
        }
        foreach ($this->app->all("SELECT * FROM bookings WHERE status = 'requested' AND approve_by < ?", [$now]) as $b) {
            $this->close($b['id'], 'expired', 'system', 'Not answered in time.'); $n++;
            $this->mail($b['guest_email'], "Your request {$b['ref']} has lapsed",
                "Hello {$b['guest_name']},\n\nSorry: your request wasn't answered in time, so it has lapsed and any card authorisation has been released. You have not been charged.\n", $this->hostFrom($b['id']), $b);
        }
        foreach ($this->app->all("SELECT * FROM bookings WHERE status = 'approved' AND pay_by < ?", [$now]) as $b) {
            $this->close($b['id'], 'expired', 'system', 'Payment not received in time.'); $n++;
            $this->mail($b['guest_email'], "Booking {$b['ref']} released", "Hello {$b['guest_name']},\n\nWe didn't receive payment in time, so the dates have been released.\n", $this->hostFrom($b['id']), $b);
        }
        return $n;
    }

    /** Long-stay instalments: sends each one's link or instructions once it falls due. */
    public function sendDueInstalments(?string $today = null): int
    {
        $today ??= date('Y-m-d');
        $rows = $this->app->all("SELECT p.*, bp.booking_id FROM payments p JOIN booking_parts bp ON bp.id = p.part_id JOIN bookings b ON b.id = bp.booking_id
            WHERE b.status = 'confirmed' AND p.seq > 1 AND p.status = 'pending' AND p.notified_at IS NULL AND p.due_date <= ?", [$today]);
        $byBooking = [];
        foreach ($rows as $r) $byBooking[$r['booking_id']][] = $r;
        foreach ($byBooking as $bid => $pays) $this->sendPaymentRequest($this->booking($bid), $pays);
        return count($rows);
    }

    // ---- internals --------------------------------------------------------

    public function syncPayment(array $pay): void
    {
        if (!$pay['stripe_session_id'] || $pay['status'] !== 'pending') return;
        $part = $this->app->one('SELECT * FROM booking_parts WHERE id = ?', [$pay['part_id']]);
        $s = $this->app->gateway()->session($this->account($part['host_id']), $pay['stripe_session_id']);
        if ($s['authorised']) $this->app->update('payments', $pay['id'], ['status' => 'authorised', 'stripe_pi_id' => $s['payment_intent']]);
        elseif ($s['paid']) $this->app->update('payments', $pay['id'], ['status' => 'paid', 'paid_at' => Util::now(), 'stripe_pi_id' => $s['payment_intent']]);
        else return;
        $this->advance($part['booking_id']);
    }

    private function advance(string $id): void
    {
        $b = $this->booking($id);
        $first = $this->firstPayments($id);
        if ($b['status'] === 'checkout' && !array_filter($first, fn($p) => $p['status'] !== 'authorised')) {
            $this->app->update('bookings', $id, ['status' => 'requested', 'requested_at' => Util::now(), 'approve_by' => $this->hoursFromNow($this->app->config['booking']['approve_within_hours'])]);
            $this->app->log('booking', $id, 'Card authorised; waiting for the owner');
            $this->notifyRequested($this->booking($id));
        } elseif ($b['status'] === 'approved' && !array_filter($first, fn($p) => $p['status'] !== 'paid')) {
            $this->confirm($id);
        }
    }

    private function confirm(string $id): void
    {
        $b = $this->booking($id);
        $this->app->update('bookings', $id, ['status' => 'confirmed']);
        foreach ($this->parts($id) as $p) $this->app->rates()->confirm($p['hold_ref']);
        $this->app->log('booking', $id, 'Confirmed');
        $product = $this->content->product($b['product_id']);
        $arrival = [];
        foreach ($product['listings'] as $l) if (!empty($l['content']['arrival_info'])) $arrival[] = Util::t($l['content']['arrival_info']);
        $schedule = '';
        $later = array_filter($this->payments($id), fn($p) => $p['seq'] > 1);
        if ($later) {
            $schedule = "\nRemaining monthly payments (we'll email each one before it's due):\n";
            foreach ($later as $p) $schedule .= ' - ' . Util::fmtDate($p['due_date']) . ': ' . Util::money($p['amount_minor'], $p['currency']) . "\n";
        }
        $this->mail($b['guest_email'], "Confirmed: {$product['name']}, " . Util::fmtDate($b['arrival']),
            "Hello {$b['guest_name']},\n\nYour stay is confirmed.\n\nBooking: {$b['ref']}\nCheck-in: " . Util::fmtDate($b['arrival']) . "\nCheck-out: " . Util::fmtDate($b['departure']) .
            "\nGuests: {$b['adults']}\n" . $schedule . "\nCancellation: " . Cancellation::POLICIES[$b['policy']]['text'] . "\n" .
            ($arrival ? "\nArriving:\n" . implode("\n\n", array_unique($arrival)) . "\n" : '') .
            "\nYour booking page: " . $this->guestUrl($b['ref']) . "\n", $this->hostFrom($id), $b);
        if (!$this->app->rates()->pushesToAirbnb()) {
            $airbnb = array_filter(array_map(fn($l) => $l['airbnb_url'] ? "{$l['name']}: {$l['airbnb_url']}" : null, $product['listings']));
            $this->app->inbox()->propose("block:$id", 'Block ' . date('j M', strtotime($b['arrival'])) . '–' . date('j M', strtotime($b['departure'])) . " on Airbnb for {$product['name']} ({$b['ref']})",
                '/admin/booking?id=' . $id, "Confirmed direct booking; until Beds24 is connected Airbnb doesn't know.
" . implode("
", $airbnb), date('Y-m-d'), true);
        }
        foreach ($this->hostsFor($id) as $h) {
            $push = $this->app->rates()->pushesToAirbnb() ? '' : "\nACTION: block these dates on Airbnb now -- this site can't do it until Beds24 is connected.\n";
            $this->mail($h['email'], "Confirmed {$b['ref']}: " . Util::fmtDate($b['arrival']) . " ({$b['guest_name']})",
                "Direct booking {$b['ref']} is confirmed and paid.\n$push\nDetails: " . $this->adminUrl($b) . "\n");
        }
    }

    /** Ends a booking: voids authorisations, releases holds, records why. */
    private function close(string $id, string $status, string $by, string $note): void
    {
        foreach ($this->payments($id) as $pay) {
            if ($pay['status'] === 'authorised' && $pay['stripe_pi_id']) {
                $part = $this->app->one('SELECT * FROM booking_parts WHERE id = ?', [$pay['part_id']]);
                try { $this->app->gateway()->cancelAuth($this->account($part['host_id']), $pay['stripe_pi_id']); }
                catch (Throwable $e) { $this->app->log('booking', $id, 'Could not void authorisation: ' . $e->getMessage()); }
            }
            if (in_array($pay['status'], ['pending', 'authorised'], true)) $this->app->update('payments', $pay['id'], ['status' => 'cancelled']);
        }
        foreach ($this->parts($id) as $p) {
            try { $this->app->rates()->release($p['hold_ref']); }
            catch (Throwable $e) { $this->app->log('booking', $id, "Could not release hold {$p['hold_ref']}: " . $e->getMessage()); }
        }
        $this->app->update('bookings', $id, ['status' => $status, 'decided_at' => Util::now(), 'decided_by' => $by, 'note' => $note]);
        $this->app->log('booking', $id, ucfirst($status) . " by $by" . ($note ? ": $note" : ''));
    }

    private function notifyRequested(array $b): void
    {
        $q = Util::json($b['quote']);
        $this->mail($b['guest_email'], "Request received: {$b['ref']}",
            "Hello {$b['guest_name']},\n\nThanks: your request for {$q['product_name']}, " . Util::fmtDate($b['arrival']) . ' to ' . Util::fmtDate($b['departure']) .
            ", is with the host. You'll hear back by " . date('D j M, H:i', strtotime($b['approve_by'])) . " (UK time).\n\n" .
            ($b['method'] === 'card' ? "Your card has been authorised, not charged. It is only charged if the host accepts.\n" : "Nothing has been charged. If the host accepts, we'll email you how to pay.\n") .
            "\nTotal: " . Util::money((int)$b['total_minor'], $b['currency']) . "\nYour booking page: " . $this->guestUrl($b['ref']) . "\n", $this->hostFrom($b['id']), $b);
        foreach ($this->hostsFor($b['id']) as $h) {
            $this->mail($h['email'], "Approve or decline {$b['ref']} by " . date('D H:i', strtotime($b['approve_by'])),
                "{$b['guest_name']} ({$b['guest_email']}" . ($b['guest_country'] ? ", {$b['guest_country']}" : '') . ") asks for " . $q['product_name'] . ":\n" .
                Util::fmtDate($b['arrival']) . ' to ' . Util::fmtDate($b['departure']) . " ({$b['nights']} nights, {$b['adults']} guests)\n" .
                'Total ' . Util::money((int)$b['total_minor'], $b['currency']) . " by {$b['method']}\n" . ($b['message'] ? "\nMessage:\n{$b['message']}\n" : '') .
                "\nApprove or decline: " . $this->adminUrl($b) . "\nNo answer by then = declined automatically.\n");
        }
        $this->app->inbox()->propose("request:{$b['id']}",
            "Answer {$b['ref']} by " . date('D H:i', strtotime($b['approve_by'])) . ": {$b['guest_name']}, {$q['product_name']}, " . date('j M', strtotime($b['arrival'])) . '–' . date('j M', strtotime($b['departure'])),
            '/admin/booking?id=' . $b['id'],
            Util::money((int)$b['total_minor'], $b['currency']) . " by {$b['method']}. Unanswered requests are declined automatically. If it's already answered in the booking site, just tick this off.",
            date('Y-m-d', strtotime($b['approve_by'])), true);
        $op = $this->app->config['site']['operator_email'];
        if ($op && !in_array($op, array_column($this->hostsFor($b['id']), 'email'), true)) {
            $this->mail($op, "New request {$b['ref']}", "New direct request: " . $this->adminUrl($b) . "\n");
        }
    }

    private function sendPaymentRequest(array $b, array $pays): void
    {
        $lines = [];
        foreach ($pays as $pay) {
            $part = $this->app->one('SELECT * FROM booking_parts WHERE id = ?', [$pay['part_id']]);
            $l = $this->content->listing($part['listing_id']);
            $amount = Util::money((int)$pay['amount_minor'], $pay['currency']);
            if ($pay['kind'] === 'manual') {
                $h = $this->content->host($part['host_id']);
                $this->app->inbox()->propose("manual:{$pay['id']}", "Check {$h['name']} received $amount by {$b['method']} for {$b['ref']} (ref {$b['ref']}-{$pay['seq']})",
                    '/admin/booking?id=' . $b['id'], 'Mark it received in the booking site once it arrives.', $b['pay_by'] ? date('Y-m-d', strtotime($b['pay_by'])) : $pay['due_date']);
                $lines[] = "{$l['name']}: $amount\n" . $this->manualInstructions($b, $h, $pay);
            } else {
                $lines[] = "{$l['name']}: $amount\nPay here: " . $this->guestUrl($b['ref']) . '&pay=' . $pay['id'];
            }
            $this->app->update('payments', $pay['id'], ['notified_at' => Util::now()]);
        }
        $deadline = $b['status'] === 'approved' && $b['pay_by'] ? "\nPlease pay by " . date('D j M, H:i', strtotime($b['pay_by'])) . " (UK time) or the dates will be released.\n" : '';
        $this->mail($b['guest_email'], "Payment for {$b['ref']}",
            "Hello {$b['guest_name']},\n\n" . ($b['status'] === 'approved' ? "Good news: your request is accepted.\n\n" : '') .
            implode("\n\n", $lines) . "\n$deadline", $this->hostFrom($b['id']), $b);
    }

    public function manualInstructions(array $b, array $host, array $pay): string
    {
        $m = $host['methods'];
        $ref = "{$b['ref']}-{$pay['seq']}";
        return match ($b['method']) {
            'bank_transfer' => "Bank transfer to:\n" . Util::t($m['bank_transfer'][$pay['currency']] ?? '') . "\nReference: $ref",
            'revolut' => 'Revolut transfer to ' . Util::t($m['revolut']['revtag'] ?? '') . " with note $ref",
            'usdt' => "USDT to the address below, exact amount, then reply to this email with the transaction hash:\n" . Util::t(is_array($m['usdt']) ? implode("\n", array_map(fn($k, $v) => "$k: $v", array_keys($m['usdt']), $m['usdt'])) : $m['usdt']) . "\nReference: $ref",
            default => "Reference: $ref",
        };
    }

    private function checkoutParams(array $b, array $pay, array $part, int $minutes): array
    {
        $l = $this->content->listing($part['listing_id']);
        $base = $this->base($b);
        $k = Util::sign($b['ref'], $this->app->config['site']['secret']);
        return [
            'amount_minor' => (int)$pay['amount_minor'], 'currency' => $pay['currency'], 'email' => $b['guest_email'],
            'description' => "{$l['name']}, " . Util::fmtDate($pay['covers_from']) . ' to ' . Util::fmtDate($pay['covers_to']) . " ({$b['ref']})",
            'metadata' => ['booking_ref' => $b['ref'], 'payment_id' => $pay['id']],
            'success_url' => "$base/checkout/return?ref={$b['ref']}&k=$k",
            'cancel_url' => "$base/booking?ref={$b['ref']}&k=$k&cancelled=1",
            'expires_minutes' => $minutes,
        ];
    }

    private function account(string $hostId): string
    {
        $h = $this->content->host($hostId);
        if (!$h['stripe_account'] && $this->app->config['payments']['gateway'] !== 'fake') throw new RuntimeException("{$h['name']} has no Stripe account connected.");
        return (string)$h['stripe_account'];
    }

    private function hoursFromNow(int|float $h): string
    {
        return date('Y-m-d H:i:s', time() + (int)round($h * 3600));
    }

    /** Guest emails ($b given) are signed and sent as the site the guest booked on. */
    private function mail(string $to, string $subject, string $body, ?string $from = null, ?array $b = null): void
    {
        $site = $b ? $this->app->siteById($b['site_id']) : null;
        $name = $site['name'] ?? $this->app->config['site']['name'];
        $from ??= $site['content']['from_email'] ?? null;
        $this->app->mailer()->send($to, $subject, $body . "\n-- \n$name\n" . $this->base($b) . "\n", $from, $name);
    }

    /** The address of the site a booking was made on (else the main one). */
    private function base(?array $b): string
    {
        $site = $b ? $this->app->siteById($b['site_id']) : null;
        return rtrim($site['base_url'] ?? $this->app->site['base_url'] ?? $this->app->config['site']['base_url'], '/');
    }

    private function hostFrom(string $bookingId): ?string
    {
        $h = $this->hostsFor($bookingId)[0] ?? null;
        return $h['from_email'] ?? null;
    }

    public function hostsFor(string $bookingId): array
    {
        return $this->app->all('SELECT DISTINCT h.* FROM hosts h JOIN booking_parts p ON p.host_id = h.id WHERE p.booking_id = ?', [$bookingId]);
    }

    public function guestUrl(string $ref): string
    {
        return $this->base($this->byRef($ref)) . "/booking?ref=$ref&k=" . Util::sign($ref, $this->app->config['site']['secret']);
    }

    public function adminUrl(array $b): string
    {
        return rtrim($this->app->config['site']['base_url'], '/') . '/admin/booking?id=' . $b['id'];
    }

    public function booking(string $id): ?array { return $this->app->one('SELECT * FROM bookings WHERE id = ?', [$id]); }
    public function byRef(string $ref): ?array { return $this->app->one('SELECT * FROM bookings WHERE ref = ?', [$ref]); }
    public function parts(string $id): array { return $this->app->all('SELECT * FROM booking_parts WHERE booking_id = ? ORDER BY id', [$id]); }

    public function payments(string $id): array
    {
        return $this->app->all('SELECT p.* FROM payments p JOIN booking_parts bp ON bp.id = p.part_id WHERE bp.booking_id = ? ORDER BY p.seq, bp.id', [$id]);
    }

    private function firstPayments(string $id): array
    {
        return array_values(array_filter($this->payments($id), fn($p) => (int)$p['seq'] === 1));
    }

    private function bookingForPayment(array $pay): ?array
    {
        return $this->app->one('SELECT b.* FROM bookings b JOIN booking_parts bp ON bp.booking_id = b.id WHERE bp.id = ?', [$pay['part_id']]);
    }
}
