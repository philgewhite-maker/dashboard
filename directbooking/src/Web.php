<?php
declare(strict_types=1);

/** Front controller for everything that isn't a published static file. */
final class Web
{
    public function __construct(private App $app) {}

    public function handle(string $method, string $path): void
    {
        try {
            $this->app->site = $this->app->siteForHost($_SERVER['HTTP_HOST'] ?? '');
            if (str_starts_with($path, '/admin')) { (new Admin($this->app))->handle($method, $path); return; }
            match (true) {
                $path === '/api/quote' => $this->quote(),
                $path === '/api/request' && $method === 'POST' => $this->request(),
                $path === '/api/stripe/webhook' && $method === 'POST' => $this->webhook(),
                $path === '/booking' => $this->booking(),
                $path === '/checkout/return' => $this->checkoutReturn(),
                $path === '/dev/checkout' => $this->devCheckout($method),
                $path === '/cron' => $this->cron(),
                $method === 'GET' || $method === 'HEAD' => $this->published($path),
                default => $this->notFound(),
            };
        } catch (Throwable $e) {
            error_log('directbooking: ' . $e);
            http_response_code(500);
            if (str_starts_with($path, '/api/')) self::json(['ok' => false, 'errors' => ['Something went wrong. Please try again or email us.']]);
            else echo 'Something went wrong. Please try again, or email us.';
        }
    }

    public static function json(array $data, int $code = 200): void
    {
        http_response_code($code);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        echo Util::enc($data);
    }

    private function quote(): void
    {
        $g = $_GET;
        $q = (new Pricing($this->app))->quote((string)($g['product'] ?? ''), (string)($g['arrival'] ?? ''), (string)($g['departure'] ?? ''),
            (int)($g['adults'] ?? 1), (string)($g['currency'] ?? 'GBP'), ($g['method'] ?? '') !== '' ? (string)$g['method'] : null);
        // Never expose per-night source prices or host ids to the browser.
        $public = array_intersect_key($q, array_flip(['ok', 'errors', 'nights', 'currency', 'total_minor', 'total_text', 'min_nights', 'policy', 'policy_text', 'methods', 'airbnb_gbp']));
        $public['lines'] = [];
        foreach ($q['parts'] ?? [] as $p) foreach ($p['lines'] as $l) $public['lines'][] = ['label' => $l['label'], 'text' => Util::money($l['minor'], $q['currency'])];
        $public['schedule'] = [];
        if (count(array_unique(array_column($q['schedule'] ?? [], 'seq'))) > 1) {
            $bySeq = [];
            foreach ($q['schedule'] as $s) { $bySeq[$s['seq']]['due'] = $s['due']; $bySeq[$s['seq']]['amount'] = ($bySeq[$s['seq']]['amount'] ?? 0) + $s['amount_minor']; }
            foreach ($bySeq as $s) $public['schedule'][] = ['due' => $s['due'] ? Util::fmtDate($s['due']) : 'on acceptance', 'text' => Util::money($s['amount'], $q['currency'])];
        }
        self::json($public);
    }

    private function request(): void
    {
        $in = Util::json(file_get_contents('php://input'));
        if (!empty($in['website'])) { self::json(['ok' => true, 'next_url' => '/']); return; } // honeypot
        $r = (new Bookings($this->app))->request($in);
        self::json($r, $r['ok'] ? 200 : 422);
    }

    private function webhook(): void
    {
        $payload = file_get_contents('php://input');
        try {
            $event = $this->app->gateway()->webhook($payload, $_SERVER['HTTP_STRIPE_SIGNATURE'] ?? '');
        } catch (RuntimeException $e) {
            self::json(['error' => $e->getMessage()], 400);
            return;
        }
        (new Bookings($this->app))->webhook($event);
        self::json(['received' => true]);
    }

    private function guestBooking(): ?array
    {
        $ref = (string)($_GET['ref'] ?? '');
        $k = (string)($_GET['k'] ?? '');
        if (!hash_equals(Util::sign($ref, $this->app->config['site']['secret']), $k)) return null;
        return (new Bookings($this->app))->byRef($ref);
    }

    private function booking(): void
    {
        $b = $this->guestBooking();
        if (!$b) { $this->notFound(); return; }
        $bookings = new Bookings($this->app);
        if (!empty($_GET['pay'])) {
            $pay = $this->app->one('SELECT p.* FROM payments p JOIN booking_parts bp ON bp.id = p.part_id WHERE p.id = ? AND bp.booking_id = ?', [$_GET['pay'], $b['id']]);
            $url = $pay ? $bookings->payUrl($b, $pay) : null;
            if ($url) { header('Location: ' . $url, true, 303); return; }
        }
        $site = Publisher::siteVars($this->app, $this->app->siteById($b['site_id']) ?? $this->app->site);
        header('Cache-Control: no-store');
        header('X-Robots-Tag: noindex');
        echo View::page('booking', [
            'site' => $site, 'path' => '/booking', 'title' => "Booking {$b['ref']} | {$site['name']}", 'description' => '',
            'b' => $b, 'payments' => $bookings->payments($b['id']), 'parts' => $bookings->parts($b['id']), 'bookings' => $bookings,
            'content' => new Content($this->app), 'cancelled' => !empty($_GET['cancelled']),
        ]);
    }

    private function checkoutReturn(): void
    {
        $b = $this->guestBooking();
        if (!$b) { $this->notFound(); return; }
        header('Location: ' . (new Bookings($this->app))->returned($b['ref']), true, 303);
    }

    private function devCheckout(string $method): void
    {
        $gw = $this->app->gateway();
        if (!$gw instanceof FakeGateway) { $this->notFound(); return; }
        $s = $gw->get((string)($_GET['session'] ?? ''));
        if (!$s) { $this->notFound(); return; }
        if ($method === 'POST') {
            if (($_POST['action'] ?? '') === 'pay') {
                $gw->complete($s['id']);
                $pay = $this->app->one('SELECT * FROM payments WHERE stripe_session_id = ?', [$s['id']]);
                if ($pay) (new Bookings($this->app))->syncPayment($pay);
                header('Location: ' . $s['p']['success_url'], true, 303);
            } else {
                header('Location: ' . $s['p']['cancel_url'], true, 303);
            }
            return;
        }
        $h = 'Util::h';
        echo '<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/assets/site.css"><main><h1>Test checkout</h1>'
            . '<p class="lead">No real payment: the site is in test mode until Stripe is connected.</p>'
            . '<p>' . $h($s['p']['description']) . '<br><strong>' . $h(Util::money((int)$s['p']['amount_minor'], $s['p']['currency'])) . '</strong> by ' . $h($s['method'])
            . ($s['manual'] ? ' (authorise only)' : '') . '</p><form method="post"><button name="action" value="pay">' . ($s['manual'] ? 'Authorise' : 'Pay') . '</button> '
            . '<button name="action" value="cancel" class="secondary">Cancel</button></form></main>';
    }

    private function cron(): void
    {
        $key = (string)($_GET['key'] ?? '');
        if (!hash_equals(Util::sign('cron', $this->app->config['site']['secret']), $key)) { $this->notFound(); return; }
        self::json((new Cron($this->app))->run((string)($_GET['task'] ?? 'all')));
    }

    /** Serves this site's published page (pages live outside the web root, one folder per site). */
    private function published(string $path): void
    {
        if (!$this->app->site) { $this->notFound(); return; }
        $dir = realpath(Publisher::outDir($this->app, $this->app->site['id']));
        $rel = $path === '/' || !preg_match('/\.[a-z0-9]+$/', $path) ? rtrim($path, '/') . '/index.html' : $path;
        $file = $dir ? realpath($dir . $rel) : false;
        if (!$file || !str_starts_with($file, $dir . DIRECTORY_SEPARATOR) || !is_file($file)) { $this->notFound(); return; }
        $types = ['html' => 'text/html; charset=utf-8', 'xml' => 'application/xml', 'txt' => 'text/plain; charset=utf-8'];
        header('Content-Type: ' . ($types[pathinfo($file, PATHINFO_EXTENSION)] ?? 'application/octet-stream'));
        header('Cache-Control: public, max-age=300');
        if (!$this->app->site['indexable']) header('X-Robots-Tag: noindex');
        readfile($file);
    }

    private function notFound(): void
    {
        http_response_code(404);
        echo 'Not found';
    }
}
