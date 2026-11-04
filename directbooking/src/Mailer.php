<?php
declare(strict_types=1);

/**
 * Plain-text email. transport 'mail' uses PHP's mail() (Krystal sends from
 * the domain's own mail server; set SPF/DKIM in cPanel so it isn't junked).
 * transport 'log' only writes to mail_log -- the default until the domain's
 * mail is set up, and what the tests use. Every message is logged either way.
 */
final class Mailer
{
    public function __construct(private App $app) {}

    public function send(string $to, string $subject, string $body, ?string $from = null, ?string $fromName = null): bool
    {
        $fromName ??= $this->app->config['site']['name'];
        $from = $from ?: ($this->app->config['mail']['from'] ?: $this->app->config['site']['operator_email']);
        $ok = true;
        if ($this->app->config['mail']['transport'] === 'mail') {
            $headers = "From: $fromName <$from>\r\nReply-To: $from\r\nContent-Type: text/plain; charset=UTF-8";
            $ok = mail($to, '=?UTF-8?B?' . base64_encode($subject) . '?=', $body, $headers, $from ? "-f$from" : '');
        }
        $this->app->insert('mail_log', ['to_addr' => $to, 'subject' => $subject, 'body' => $body, 'sent_at' => Util::now(), 'ok' => (int)$ok]);
        return $ok;
    }
}
