<?php
declare(strict_types=1);

final class Util
{
    // Stripe's zero-decimal currencies among the ones this site can charge in.
    private const ZERO_DECIMAL = ['JPY', 'KRW'];

    public static function h(?string $s): string
    {
        return htmlspecialchars((string)$s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    }

    /** A translatable value: a plain string, or {"en": ..., "ko": ...}. */
    public static function t(mixed $v, string $lang = 'en'): string
    {
        if (is_array($v)) return (string)($v[$lang] ?? $v['en'] ?? reset($v) ?: '');
        return (string)($v ?? '');
    }

    public static function json(?string $s): array
    {
        if ($s === null || $s === '') return [];
        $v = json_decode($s, true);
        return is_array($v) ? $v : [];
    }

    public static function enc(mixed $v): string
    {
        return json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    }

    public static function id(string $prefix = ''): string
    {
        return $prefix . bin2hex(random_bytes(8));
    }

    /** Short, unambiguous booking reference: DB-7F3K2Q. */
    public static function ref(): string
    {
        $alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
        $s = '';
        for ($i = 0; $i < 6; $i++) $s .= $alphabet[random_int(0, strlen($alphabet) - 1)];
        return 'DB-' . $s;
    }

    public static function now(): string
    {
        return date('Y-m-d H:i:s');
    }

    public static function addDays(string $date, int $days): string
    {
        return date('Y-m-d', strtotime("$date " . ($days >= 0 ? '+' : '') . "$days days"));
    }

    public static function nightsBetween(string $arrival, string $departure): int
    {
        return (int)round((strtotime($departure) - strtotime($arrival)) / 86400);
    }

    /** Each night's date, arrival inclusive, departure exclusive. */
    public static function nights(string $arrival, string $departure): array
    {
        $out = [];
        for ($d = $arrival; $d < $departure; $d = self::addDays($d, 1)) $out[] = $d;
        return $out;
    }

    public static function isDate(?string $s): bool
    {
        return is_string($s) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $s) && strtotime($s) !== false && date('Y-m-d', strtotime($s)) === $s;
    }

    public static function minorFactor(string $currency): int
    {
        return in_array(strtoupper($currency), self::ZERO_DECIMAL, true) ? 1 : 100;
    }

    public static function toMinor(float $amount, string $currency): int
    {
        return (int)round($amount * self::minorFactor($currency));
    }

    public static function money(int $minor, string $currency): string
    {
        $f = self::minorFactor($currency);
        $symbols = ['GBP' => '£', 'USD' => 'US$', 'EUR' => '€', 'JPY' => '¥', 'AUD' => 'A$', 'CAD' => 'C$', 'NZD' => 'NZ$'];
        $sign = $minor < 0 ? '−' : '';
        $num = number_format(abs($minor) / $f, $f === 1 ? 0 : 2);
        return $sign . (isset($symbols[$currency]) ? $symbols[$currency] . $num : "$num $currency");
    }

    public static function fmtDate(?string $d): string
    {
        return $d ? date('D j M Y', strtotime($d)) : 'dates to be confirmed';
    }

    public static function slug(string $s): string
    {
        return trim(preg_replace('/[^a-z0-9]+/', '-', strtolower($s)), '-');
    }

    /** Deep-merge for inherited content: child keys win, lists are replaced, not appended. */
    public static function inherit(array $parent, array $child): array
    {
        foreach ($child as $k => $v) {
            if (is_array($v) && isset($parent[$k]) && is_array($parent[$k]) && !array_is_list($v) && !array_is_list($parent[$k])) {
                $parent[$k] = self::inherit($parent[$k], $v);
            } else {
                $parent[$k] = $v;
            }
        }
        return $parent;
    }

    /** Signed token for guest-facing links (booking status, pay pages). */
    public static function sign(string $payload, string $secret): string
    {
        return substr(hash_hmac('sha256', $payload, $secret), 0, 24);
    }

    public static function http(string $method, string $url, array $headers = [], ?string $body = null, int $timeout = 20): array
    {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_USERAGENT => 'directbooking/1.0',
        ]);
        if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        $res = curl_exec($ch);
        $code = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $err = curl_error($ch);
        curl_close($ch);
        if ($res === false) throw new RuntimeException("HTTP $method $url failed: $err");
        return [$code, $res];
    }
}
