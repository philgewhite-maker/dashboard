<?php
declare(strict_types=1);

/**
 * Payments are always taken on the room owner's own Stripe account
 * (Connect "direct charges"), so each owner is the merchant and is paid
 * straight into their own bank. $account is that owner's acct_... id.
 */
interface PaymentGateway
{
    /** Card checkout that only authorises (captured on approval). Returns [id, url]. */
    public function authCheckout(string $account, array $p): array;

    /** Checkout that takes payment now with one method (alipay, wechat_pay, pay_by_bank, card...). Returns [id, url]. */
    public function payCheckout(string $account, string $method, array $p): array;

    /** ['status' => open|complete|expired, 'paid' => bool, 'authorised' => bool, 'payment_intent' => ?string] */
    public function session(string $account, string $sessionId): array;

    /** Charges an authorisation; $amountMinor (optional) charges less than was authorised. */
    public function capture(string $account, string $paymentIntent, ?int $amountMinor = null): void;

    public function cancelAuth(string $account, string $paymentIntent): void;

    public function refund(string $account, string $paymentIntent, int $amountMinor): void;

    /** Verifies and decodes a webhook; throws on a bad signature. */
    public function webhook(string $payload, string $signatureHeader): array;
}
