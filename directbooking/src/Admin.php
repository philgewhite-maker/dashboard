<?php
declare(strict_types=1);

/**
 * /admin: sign in by emailed one-time link (no passwords to manage).
 * The operator (an admin with no host_id) sees everything and edits
 * content; a host sees and answers the bookings for their own rooms.
 */
final class Admin
{
    private const EDITABLE = ['sites', 'hosts', 'admins', 'places', 'listings', 'products', 'venues', 'points', 'event_series', 'occurrences', 'routes', 'rate_rules'];
    private const JSON_COLS = ['data', 'payment_methods', 'listing_ids', 'point_ids', 'legs'];

    private ?array $me = null;

    public function __construct(private App $app) {}

    public function handle(string $method, string $path): void
    {
        $this->startSession();
        header('Cache-Control: no-store');
        header('X-Robots-Tag: noindex');
        if ($path === '/admin/login' && $method === 'POST') { $this->login(); return; }
        if ($path === '/admin/auth') { $this->auth(); return; }
        $this->me = isset($_SESSION['admin']) ? $this->app->one('SELECT * FROM admins WHERE email = ?', [$_SESSION['admin']]) : null;
        if (!$this->me && $method === 'GET' && $path !== '/admin' && str_starts_with($_SERVER['REQUEST_URI'] ?? '', '/admin/')) $_SESSION['next'] = $_SERVER['REQUEST_URI'];
        if (!$this->me) { $this->page('Sign in', View::render('admin/login', ['sent' => !empty($_GET['sent'])])); return; }
        if ($method === 'POST' && !hash_equals($_SESSION['csrf'] ?? '', (string)($_POST['csrf'] ?? ''))) { http_response_code(400); echo 'Form expired: go back and reload.'; return; }

        match ($path) {
            '/admin', '/admin/' => $this->dashboard(),
            '/admin/booking' => $this->booking(),
            '/admin/booking/action' => $this->bookingAction(),
            '/admin/approval' => $this->operatorOnly(fn() => $this->approval()),
            '/admin/publish' => $this->operatorOnly(fn() => $this->publish()),
            '/admin/table' => $this->operatorOnly(fn() => $this->table()),
            '/admin/edit' => $this->operatorOnly(fn() => $this->edit($method)),
            '/admin/stripe-onboard' => $this->operatorOnly(fn() => $this->stripeOnboard()),
            '/admin/logout' => $this->logout(),
            default => $this->page('Not found', '<p>Not found.</p>'),
        };
    }

    // ---- auth -------------------------------------------------------------

    private function startSession(): void
    {
        if (session_status() === PHP_SESSION_ACTIVE) return;
        $dir = $this->app->config['paths']['data'] . '/sessions';
        if (!is_dir($dir)) mkdir($dir, 0700, true);
        session_save_path($dir);
        session_name('dbadmin');
        session_set_cookie_params(['lifetime' => 0, 'path' => '/admin', 'httponly' => true, 'samesite' => 'Lax',
            'secure' => str_starts_with($this->app->config['site']['base_url'], 'https://')]);
        session_start();
        $_SESSION['csrf'] ??= bin2hex(random_bytes(16));
    }

    private function login(): void
    {
        $email = strtolower(trim((string)($_POST['email'] ?? '')));
        $admin = $this->app->one('SELECT * FROM admins WHERE lower(email) = ?', [$email]);
        if ($admin) {
            $token = bin2hex(random_bytes(24));
            $this->app->insert('login_tokens', ['token_hash' => hash('sha256', $token), 'email' => $admin['email'], 'expires_at' => time() + 900, 'used_at' => null]);
            $url = rtrim($this->app->config['site']['base_url'], '/') . "/admin/auth?t=$token";
            $this->app->mailer()->send($admin['email'], 'Your sign-in link', "Sign in to {$this->app->config['site']['name']} admin (valid 15 minutes, once):\n\n$url\n\nIf you didn't ask for this, ignore it.");
        }
        header('Location: /admin?sent=1', true, 303); // same answer either way: doesn't reveal who is an admin
    }

    private function auth(): void
    {
        $row = $this->app->one('SELECT * FROM login_tokens WHERE token_hash = ?', [hash('sha256', (string)($_GET['t'] ?? ''))]);
        if (!$row || $row['used_at'] || $row['expires_at'] < time()) { $this->page('Sign in', '<p>That link has expired or was already used. <a href="/admin">Get a new one</a>.</p>'); return; }
        $this->app->update('login_tokens', $row['token_hash'], ['used_at' => time()], 'token_hash');
        session_regenerate_id(true);
        $_SESSION['admin'] = $row['email'];
        $next = $_SESSION['next'] ?? '/admin';
        unset($_SESSION['next']);
        // Only ever back into the admin on this site: never an outside address.
        header('Location: ' . (preg_match('#^/admin(/|$|\?)#', $next) ? $next : '/admin'), true, 303);
    }

    private function logout(): void
    {
        $_SESSION = [];
        session_destroy();
        header('Location: /admin', true, 303);
    }

    private function operator(): bool
    {
        return $this->me && $this->me['host_id'] === null;
    }

    private function operatorOnly(callable $fn): void
    {
        if (!$this->operator()) { $this->page('Not allowed', '<p>Only the site operator can do that.</p>'); return; }
        $fn();
    }

    private function canSee(array $b): bool
    {
        if ($this->operator()) return true;
        return (bool)$this->app->one('SELECT 1 FROM booking_parts WHERE booking_id = ? AND host_id = ?', [$b['id'], $this->me['host_id']]);
    }

    // ---- pages ------------------------------------------------------------

    private function dashboard(): void
    {
        $scope = $this->operator() ? '' : ' AND b.id IN (SELECT booking_id FROM booking_parts WHERE host_id = ' . $this->app->db->quote($this->me['host_id']) . ')';
        $q = fn(string $where, string $order = 'b.arrival') => $this->app->all("SELECT b.* FROM bookings b WHERE $where$scope ORDER BY $order");
        $vars = [
            'requested' => $q("b.status = 'requested'", 'b.approve_by'),
            'awaiting' => $q("b.status = 'approved'", 'b.pay_by'),
            'checkout' => $q("b.status = 'checkout'", 'b.created_at'),
            'upcoming' => $q("b.status = 'confirmed' AND b.departure >= date('now')"),
            'manualDue' => $this->app->all("SELECT p.*, b.ref, b.id AS booking_id FROM payments p JOIN booking_parts bp ON bp.id = p.part_id JOIN bookings b ON b.id = bp.booking_id
                WHERE p.kind = 'manual' AND p.status = 'pending' AND b.status IN ('approved','confirmed') AND (p.seq = 1 OR p.notified_at IS NOT NULL)$scope ORDER BY p.due_date"),
            'operator' => $this->operator(),
        ];
        if ($this->operator()) {
            $vars['approvals'] = $this->app->all("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at");
            $vars['problems'] = (new Publisher($this->app))->check();
            $vars['setup'] = $this->setupStatus();
            $vars['activity'] = $this->app->all('SELECT * FROM activity ORDER BY id DESC LIMIT 15');
        }
        $this->page('Bookings', View::render('admin/dashboard', $vars));
    }

    private function setupStatus(): array
    {
        $c = $this->app->config;
        $out = [];
        $out[] = ['Calendar source', $c['rates']['source'], $c['rates']['source'] === 'beds24' ? 'ok' : 'warn',
            $c['rates']['source'] === 'beds24' ? 'Beds24 holds block Airbnb automatically.' : 'Approving a booking does NOT block Airbnb: owners must block the dates by hand.'];
        $out[] = ['Payments', $c['payments']['gateway'], $c['payments']['gateway'] === 'stripe' ? 'ok' : 'warn',
            $c['payments']['gateway'] === 'stripe' ? 'Live Stripe.' : 'Test mode: no real money moves.'];
        foreach ($this->app->all('SELECT * FROM hosts') as $h) {
            $out[] = ["Stripe: {$h['name']}", $h['stripe_account'] ?: 'not connected', $h['stripe_account'] ? 'ok' : 'warn', 'host:' . $h['id']];
        }
        $fx = $this->app->one('SELECT MAX(updated_at) AS at FROM fx_rates');
        $out[] = ['Exchange rates', $fx['at'] ?? 'never', ($fx['at'] ?? '') > date('Y-m-d', strtotime('-3 days')) ? 'ok' : 'warn', 'Refreshed by the cron job.'];
        $rc = $this->app->one('SELECT MAX(updated_at) AS at FROM rate_cache');
        if ($c['rates']['source'] !== 'local') $out[] = ['Calendar refresh', $rc['at'] ?? 'never', ($rc['at'] ?? '') > date('Y-m-d H:i:s', strtotime('-2 hours')) ? 'ok' : 'warn', 'Refreshed by the cron job.'];
        $stale = $this->app->one("SELECT COUNT(*) AS n FROM routes WHERE status = 'published' AND (verified_at IS NULL OR verified_at < ?)", [date('Y-m-d', strtotime('-1 year'))]);
        $out[] = ['Routes older than a year', (string)$stale['n'], $stale['n'] ? 'warn' : 'ok', 'Re-run bin/fetch-routes.php and approve.'];
        return $out;
    }

    private function booking(): void
    {
        $b = (new Bookings($this->app))->booking((string)($_GET['id'] ?? ''));
        if (!$b || !$this->canSee($b)) { $this->page('Not found', '<p>No such booking.</p>'); return; }
        $bk = new Bookings($this->app);
        $paidTotal = array_sum(array_map(fn($p) => $p['status'] === 'paid' ? (int)$p['amount_minor'] : 0, $bk->payments($b['id'])));
        $refundNow = Cancellation::refund($b['policy'], $paidTotal, (int)$b['nights'], $b['requested_at'] ?? $b['created_at'], Util::now(), $b['arrival']);
        $this->page("Booking {$b['ref']}", View::render('admin/booking', [
            'b' => $b, 'parts' => $bk->parts($b['id']), 'payments' => $bk->payments($b['id']), 'content' => new Content($this->app),
            'activity' => $this->app->all("SELECT * FROM activity WHERE entity = 'booking' AND entity_id = ? ORDER BY id", [$b['id']]),
            'refundNow' => $refundNow, 'paidTotal' => $paidTotal, 'pushes' => $this->app->rates()->pushesToAirbnb(),
        ]));
    }

    private function bookingAction(): void
    {
        $bk = new Bookings($this->app);
        $b = $bk->booking((string)($_POST['id'] ?? ''));
        if (!$b || !$this->canSee($b)) { $this->page('Not found', '<p>No such booking.</p>'); return; }
        $who = $this->me['email'];
        $msg = match ($_POST['action'] ?? '') {
            'approve' => $bk->approve($b['id'], $who),
            'decline' => $bk->decline($b['id'], $who, trim((string)($_POST['reason'] ?? ''))),
            'paid' => $bk->markPaid((string)($_POST['payment_id'] ?? ''), $who),
            'cancel' => $bk->cancel($b['id'], $who),
            default => 'Unknown action.',
        };
        $_SESSION['flash'] = ['text' => $msg, 'booking' => $b['id'], 'ref' => $b['ref']];
        header('Location: /admin/booking?id=' . urlencode($b['id']), true, 303);
    }

    private function approval(): void
    {
        $a = $this->app->one('SELECT * FROM approvals WHERE id = ?', [(string)($_POST['id'] ?? '')]);
        if (!$a || $a['status'] !== 'pending') { header('Location: /admin', true, 303); return; }
        $yes = ($_POST['decision'] ?? '') === 'approve';
        if ($yes) (new Approvals($this->app))->apply($a);
        $this->app->update('approvals', $a['id'], ['status' => $yes ? 'approved' : 'rejected', 'decided_at' => Util::now(), 'decided_by' => $this->me['email']]);
        $link = $a['entity_id'] ? " <a href=\"/admin/edit?table=" . Util::h($a['entity']) . '&amp;id=' . Util::h($a['entity_id']) . '">Open it</a>' : '';
        $_SESSION['flash'] = ['html' => ($yes ? 'Approved: ' : 'Rejected: ') . Util::h($a['summary']) . '.' . $link . ($yes ? ' Publish to put it on the site.' : '')];
        header('Location: /admin', true, 303);
    }

    private function publish(): void
    {
        $r = (new Publisher($this->app))->publish();
        $_SESSION['flash'] = $r['ok']
            ? ['html' => 'Published ' . count($r['pages']) . ' files. View: ' . implode(' · ', array_map(fn($id, $url) => '<a href="' . Util::h($url) . '/" target="_blank" rel="noopener">' . Util::h($id) . '</a>', array_keys($r['sites']), $r['sites'])) . '.']
            : ['html' => 'Not published. Fix these first (see each record under Content):<ul>' . implode('', array_map(fn($p) => '<li>' . Util::h($p) . '</li>', $r['problems'])) . '</ul>'];
        header('Location: /admin', true, 303);
    }

    /** Makes a Stripe sign-up link for a host; the operator sends it to them. */
    private function stripeOnboard(): void
    {
        $h = $this->app->one('SELECT * FROM hosts WHERE id = ?', [(string)($_POST['host'] ?? '')]);
        $gw = $this->app->gateway();
        if (!$h || !$gw instanceof StripeGateway) {
            $_SESSION['flash'] = ['text' => 'Switch payments.gateway to "stripe" and add the platform secret key in config.php first.'];
            header('Location: /admin', true, 303);
            return;
        }
        try {
            [$acct, $url] = $gw->onboardingLink($h['stripe_account'], $h['email'], rtrim($this->app->config['site']['base_url'], '/') . '/admin');
            if ($acct !== $h['stripe_account']) $this->app->update('hosts', $h['id'], ['stripe_account' => $acct]);
            $this->app->log('hosts', $h['id'], "Stripe sign-up link made for $acct");
            $_SESSION['flash'] = ['html' => 'Send this one-time link to ' . Util::h($h['name']) . ' (' . Util::h($h['email']) . '); it expires within minutes, so make a fresh one if needed:<br><input readonly style="width:100%" value="' . Util::h($url) . '" onclick="this.select()">'];
        } catch (Throwable $e) {
            $_SESSION['flash'] = ['text' => 'Stripe said: ' . $e->getMessage()];
        }
        header('Location: /admin', true, 303);
    }

    private function table(): void
    {
        $t = (string)($_GET['table'] ?? '');
        if (!in_array($t, self::EDITABLE, true)) { $this->page('Content', View::render('admin/tables', ['tables' => self::EDITABLE])); return; }
        $rows = $this->app->all("SELECT * FROM $t ORDER BY " . ($t === 'admins' ? 'email' : 'id'));
        $this->page(ucfirst(str_replace('_', ' ', $t)), View::render('admin/table', ['table' => $t, 'rows' => $rows, 'key' => $t === 'admins' ? 'email' : 'id']));
    }

    /** Edits one row as JSON: plain, but covers every field of every record type. */
    private function edit(string $method): void
    {
        $t = (string)($_GET['table'] ?? '');
        $id = (string)($_GET['id'] ?? '');
        if (!in_array($t, self::EDITABLE, true)) { header('Location: /admin/table', true, 303); return; }
        $key = $t === 'admins' ? 'email' : 'id';
        $row = $id !== '' ? $this->app->one("SELECT * FROM $t WHERE $key = ?", [$id]) : null;
        $error = null;
        if ($method === 'POST') {
            $new = json_decode((string)($_POST['json'] ?? ''), true);
            if (!is_array($new)) $error = 'That is not valid JSON: ' . json_last_error_msg();
            else {
                foreach (self::JSON_COLS as $c) if (array_key_exists($c, $new) && !is_string($new[$c])) $new[$c] = Util::enc($new[$c]);
                try {
                    if ($row) {
                        unset($new[$key]);
                        if ($new) $this->app->update($t, $id, $new, $key);
                    } else {
                        if ($key === 'id' && empty($new['id'])) $new['id'] = Util::id(substr($t, 0, 3) . '_');
                        $this->app->insert($t, $new);
                        $id = (string)$new[$key];
                    }
                    $this->app->log($t, $id, ($row ? 'Edited' : 'Created') . " by {$this->me['email']}");
                    $_SESSION['flash'] = ['html' => 'Saved <a href="/admin/edit?table=' . Util::h($t) . '&amp;id=' . Util::h($id) . '">' . Util::h($t . ' ' . ($new['name'] ?? $row['name'] ?? $id)) . '</a>. Publish to update the site.'];
                    header("Location: /admin/table?table=$t", true, 303);
                    return;
                } catch (PDOException $e) {
                    $error = 'Could not save: ' . $e->getMessage();
                }
            }
        }
        $shown = $row ?? ($_POST ? json_decode((string)$_POST['json'], true) : null) ?? $this->template($t);
        foreach (self::JSON_COLS as $c) if (isset($shown[$c]) && is_string($shown[$c])) $shown[$c] = Util::json($shown[$c]) ?: json_decode($shown[$c]);
        $this->page(($row ? 'Edit ' : 'New ') . str_replace('_', ' ', $t), View::render('admin/edit', [
            'table' => $t, 'id' => $id, 'json' => json_encode($shown, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), 'error' => $error, 'isNew' => !$row,
        ]));
    }

    private function template(string $t): array
    {
        $cols = array_column($this->app->all("PRAGMA table_info($t)"), 'name');
        $out = array_fill_keys(array_diff($cols, ['tenant']), null);
        foreach (self::JSON_COLS as $c) if (array_key_exists($c, $out)) $out[$c] = in_array($c, ['listing_ids', 'point_ids', 'legs'], true) ? [] : new stdClass();
        if (array_key_exists('status', $out)) $out['status'] = 'draft';
        return $out;
    }

    private function page(string $title, string $body): void
    {
        $flash = $_SESSION['flash'] ?? null;
        unset($_SESSION['flash']);
        echo View::render('admin/layout', ['title' => $title, 'body' => $body, 'me' => $this->me, 'flash' => $flash, 'csrf' => $_SESSION['csrf'] ?? '', 'site' => $this->app->config['site'], 'operator' => $this->operator()]);
    }
}
