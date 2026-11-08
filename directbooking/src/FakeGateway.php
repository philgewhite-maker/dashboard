<?php
declare(strict_types=1);

/**
 * Stands in for Stripe until the owners' accounts exist. Its "checkout"
 * is a local page (/dev/checkout) with Pay and Cancel buttons, so the whole
 * flow can be clicked through on the live domain before any real payment.
 * State is kept in a JSON file so it survives between requests.
 */
final class FakeGateway implements PaymentGateway
{
    private string $file;

    public function __construct(private string $baseUrl, ?string $file = null)
    {
        $this->file = $file ?? dirname(__DIR__) . '/data/fake-gateway.json';
    }

    public function authCheckout(string $account, array $p): array
    {
        return $this->create($account, 'card', true, $p);
    }

    public function payCheckout(string $account, string $method, array $p): array
    {
        return $this->create($account, $method, false, $p);
    }

    public function session(string $account, string $sessionId): array
    {
        $s = $this->load()[$sessionId] ?? null;
        if (!$s) throw new RuntimeException("Unknown fake session $sessionId");
        return ['status' => $s['status'], 'paid' => $s['paid'], 'authorised' => $s['authorised'], 'payment_intent' => $s['pi']];
    }

    /** What the fake checkout page calls: the guest "pays" (or authorises). */
    public function complete(string $sessionId): array
    {
        $all = $this->load();
        $s = &$all[$sessionId];
        $s['status'] = 'complete';
        if ($s['manual']) $s['authorised'] = true; else $s['paid'] = true;
        $this->save($all);
        return $s;
    }

    public function capture(string $account, string $paymentIntent, ?int $amountMinor = null): void { $this->pi($paymentIntent, 'captured'); if ($amountMinor !== null) $this->pi($paymentIntent, "captured $amountMinor"); }
    public function cancelAuth(string $account, string $paymentIntent): void { $this->pi($paymentIntent, 'cancelled'); }
    public function refund(string $account, string $paymentIntent, int $amountMinor): void { $this->pi($paymentIntent, "refunded $amountMinor"); }

    public function webhook(string $payload, string $signatureHeader): array
    {
        return Util::json($payload);
    }

    public function get(string $sessionId): ?array
    {
        return $this->load()[$sessionId] ?? null;
    }

    private function create(string $account, string $method, bool $manual, array $p): array
    {
        $id = 'cs_fake_' . bin2hex(random_bytes(6));
        $all = $this->load();
        $all[$id] = ['id' => $id, 'account' => $account, 'method' => $method, 'manual' => $manual, 'status' => 'open', 'paid' => false,
            'authorised' => false, 'pi' => 'pi_fake_' . bin2hex(random_bytes(6)), 'pi_log' => [], 'p' => $p];
        $this->save($all);
        return [$id, rtrim($this->baseUrl, '/') . '/dev/checkout?session=' . $id];
    }

    private function pi(string $pi, string $what): void
    {
        $all = $this->load();
        foreach ($all as &$s) if ($s['pi'] === $pi) $s['pi_log'][] = $what;
        $this->save($all);
    }

    private function load(): array
    {
        return is_file($this->file) ? Util::json(file_get_contents($this->file)) : [];
    }

    private function save(array $all): void
    {
        file_put_contents($this->file, Util::enc($all), LOCK_EX);
    }
}
