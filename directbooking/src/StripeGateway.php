<?php
declare(strict_types=1);

/** Stripe over plain HTTPS -- no SDK, so nothing to install on the host. */
final class StripeGateway implements PaymentGateway
{
    private const API = 'https://api.stripe.com/v1';

    public function __construct(private array $cfg)
    {
        if (empty($cfg['secret_key'])) throw new RuntimeException('stripe.secret_key is not set.');
    }

    public function authCheckout(string $account, array $p): array
    {
        $s = $this->call('POST', '/checkout/sessions', $account, $this->sessionParams($p) + [
            'payment_method_types' => ['card'],
            'payment_intent_data' => ['capture_method' => 'manual', 'metadata' => $p['metadata'], 'description' => $p['description']],
        ]);
        return [$s['id'], $s['url']];
    }

    public function payCheckout(string $account, string $method, array $p): array
    {
        $params = $this->sessionParams($p) + [
            'payment_method_types' => [$method],
            'payment_intent_data' => ['metadata' => $p['metadata'], 'description' => $p['description']],
        ];
        if ($method === 'wechat_pay') $params['payment_method_options'] = ['wechat_pay' => ['client' => 'web']];
        $s = $this->call('POST', '/checkout/sessions', $account, $params);
        return [$s['id'], $s['url']];
    }

    public function session(string $account, string $sessionId): array
    {
        $s = $this->call('GET', "/checkout/sessions/$sessionId?expand[]=payment_intent", $account);
        $pi = $s['payment_intent'] ?? null;
        return [
            'status' => $s['status'],
            'paid' => ($s['payment_status'] ?? '') === 'paid',
            'authorised' => is_array($pi) && ($pi['status'] ?? '') === 'requires_capture',
            'payment_intent' => is_array($pi) ? $pi['id'] : $pi,
        ];
    }

    public function capture(string $account, string $paymentIntent): void
    {
        $this->call('POST', "/payment_intents/$paymentIntent/capture", $account, []);
    }

    public function cancelAuth(string $account, string $paymentIntent): void
    {
        $this->call('POST', "/payment_intents/$paymentIntent/cancel", $account, []);
    }

    public function refund(string $account, string $paymentIntent, int $amountMinor): void
    {
        $this->call('POST', '/refunds', $account, ['payment_intent' => $paymentIntent, 'amount' => $amountMinor]);
    }

    /**
     * Connect onboarding: creates the owner's Stripe account under the
     * platform (once) and a one-time sign-up link to send them. They
     * complete identity and bank details on Stripe's own pages.
     */
    public function onboardingLink(?string $account, string $email, string $returnUrl): array
    {
        if (!$account) {
            $a = $this->call('POST', '/accounts', null, ['type' => 'standard', 'email' => $email, 'country' => 'GB']);
            $account = $a['id'];
        }
        $l = $this->call('POST', '/account_links', null, ['account' => $account, 'refresh_url' => $returnUrl, 'return_url' => $returnUrl, 'type' => 'account_onboarding']);
        return [$account, $l['url']];
    }

    public function webhook(string $payload, string $signatureHeader): array
    {
        $secret = $this->cfg['webhook_secret'] ?? '';
        if ($secret === '') throw new RuntimeException('stripe.webhook_secret is not set.');
        self::verify($payload, $signatureHeader, $secret);
        return Util::json($payload);
    }

    /** Stripe's scheme: HMAC-SHA256 of "{t}.{payload}", within 5 minutes. */
    public static function verify(string $payload, string $header, string $secret, ?int $now = null): void
    {
        $parts = [];
        foreach (explode(',', $header) as $kv) {
            [$k, $v] = array_pad(explode('=', $kv, 2), 2, '');
            $parts[$k][] = $v;
        }
        $t = (int)($parts['t'][0] ?? 0);
        if (abs(($now ?? time()) - $t) > 300) throw new RuntimeException('Webhook timestamp outside tolerance.');
        $expected = hash_hmac('sha256', "$t.$payload", $secret);
        foreach ($parts['v1'] ?? [] as $sig) if (hash_equals($expected, $sig)) return;
        throw new RuntimeException('Webhook signature mismatch.');
    }

    private function sessionParams(array $p): array
    {
        return [
            'mode' => 'payment',
            'line_items' => [[
                'quantity' => 1,
                'price_data' => ['currency' => strtolower($p['currency']), 'unit_amount' => $p['amount_minor'], 'product_data' => ['name' => $p['description']]],
            ]],
            'customer_email' => $p['email'],
            'success_url' => $p['success_url'],
            'cancel_url' => $p['cancel_url'],
            'expires_at' => time() + max(31, (int)$p['expires_minutes']) * 60,
            'metadata' => $p['metadata'],
        ];
    }

    private function call(string $method, string $path, ?string $account, ?array $params = null): array
    {
        $headers = ['Authorization: Bearer ' . $this->cfg['secret_key']];
        if ($account) $headers[] = 'Stripe-Account: ' . $account;
        $body = null;
        if ($params !== null) {
            $headers[] = 'Content-Type: application/x-www-form-urlencoded';
            $body = self::form($params);
            $headers[] = 'Idempotency-Key: ' . hash('sha256', $method . $path . $account . $body . floor(time() / 60));
        }
        [$code, $res] = Util::http($method, self::API . $path, $headers, $body);
        $j = Util::json($res);
        if ($code >= 300) throw new RuntimeException("Stripe $method $path: " . ($j['error']['message'] ?? "HTTP $code"));
        return $j;
    }

    /** Stripe's nested form encoding: a[b][0][c]=v. */
    public static function form(array $params, string $prefix = ''): string
    {
        $out = [];
        foreach ($params as $k => $v) {
            $key = $prefix === '' ? (string)$k : "{$prefix}[$k]";
            if (is_array($v)) $out[] = self::form($v, $key);
            elseif (is_bool($v)) $out[] = urlencode($key) . '=' . ($v ? 'true' : 'false');
            elseif ($v !== null) $out[] = urlencode($key) . '=' . urlencode((string)$v);
        }
        return implode('&', array_filter($out, fn($s) => $s !== ''));
    }
}
