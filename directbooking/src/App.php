<?php
declare(strict_types=1);

/**
 * Service container: config, database and the swappable providers.
 * Providers default from config (`rates.source`, `payments.gateway`) so the
 * whole site runs end-to-end with fakes before any account exists.
 */
final class App
{
    private static ?App $instance = null;

    public array $config;
    public PDO $db;
    private ?RateSource $rates = null;
    private ?PaymentGateway $gateway = null;
    private ?Mailer $mailer = null;
    private ?DashboardInbox $inbox = null;
    /** The branded site this request is for (picked by host name); null in CLI. */
    public ?array $site = null;

    private function __construct(array $config)
    {
        $this->config = array_replace_recursive(self::defaults(), $config);
        $this->db = new PDO($this->config['db']['dsn'], $this->config['db']['user'] ?? null, $this->config['db']['pass'] ?? null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
        if (str_starts_with($this->config['db']['dsn'], 'sqlite:')) {
            $this->db->exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
        }
    }

    public static function boot(?array $config = null): App
    {
        self::$instance = new App($config ?? directbooking_config());
        return self::$instance;
    }

    public static function get(): App
    {
        if (!self::$instance) self::boot();
        return self::$instance;
    }

    public static function defaults(): array
    {
        $root = dirname(__DIR__);
        return [
            'site' => [
                'name' => 'London Bridge Rooms',
                'base_url' => 'http://localhost:8080',
                'lang' => 'en',
                'secret' => '',                      // HMAC key for guest links and cron URL
                'operator_email' => '',
            ],
            'db' => ['dsn' => 'sqlite:' . $root . '/data/site.sqlite'],
            'paths' => [
                'public' => $root . '/public',      // published pages are written here
                'data' => $root . '/data',
            ],
            'booking' => [
                'default_discount_pct' => 12.0,
                'default_policy' => 'moderate',
                'long_stay_nights' => 28,
                'approve_within_hours' => 24,
                'checkout_minutes' => 60,           // how long dates are held while the guest is at Stripe
                'pay_within_hours' => ['link' => 24, 'manual' => 48],
                'instalment_notice_days' => 7,
                'bank_discount_pct' => 0.0,         // extra discount for bank-type methods (no surcharges: UK law)
                'currencies' => ['GBP', 'USD', 'EUR', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'SEK', 'NOK'],
                'show_airbnb_comparison' => false,  // see the plan doc: off while there's a card in the room
            ],
            'rates' => ['source' => 'local'],       // local | ical | beds24
            'beds24' => [
                'api' => 'https://api.beds24.com/v2',
                'refresh_token' => '',
                'hold_status' => 'request',         // VERIFY in Phase 1: must block Airbnb
                'confirm_status' => 'confirmed',
            ],
            'payments' => ['gateway' => 'fake'],    // fake | stripe
            'stripe' => ['secret_key' => '', 'webhook_secret' => ''],
            // Which Stripe-method can charge in which currency. Unknowns are
            // left narrow on purpose: widen only once each owner's Stripe
            // dashboard shows the method accepts that currency.
            'method_currencies' => [
                'card' => '*',
                'alipay' => ['GBP', 'EUR', 'USD'],
                'wechat_pay' => ['GBP', 'EUR', 'USD'],
                'pay_by_bank' => ['GBP'],
                'kakao_pay' => ['KRW'],             // Day 2, see plan
                'naver_pay' => ['KRW'],
            ],
            'mail' => ['transport' => 'log', 'from' => ''],
            'tfl' => ['app_key' => ''],
            // Phil's dashboard agent inbox (agent-write.php). Blank = off.
            'dashboard' => ['inbox_url' => '', 'secret' => '', 'data_file' => '', 'url' => 'https://philgewhite-maker.github.io/dashboard/'],
            // Offers from the dashboard booking model's void projection (Demand).
            'demand' => [
                'enabled' => true,
                'max_age_days' => 7,        // ignore a projection older than this
                'low_prob' => 0.5,          // only nights less likely than this to be booked get an offer
                'margin_pct' => 10,         // offer price = expected income if left empty, plus this
                'floor_gbp' => 45,          // never below this per night
                'max_discount_pct' => 30,   // never more than this off the direct price
                'extension_nights' => 3,    // look this many nights either side of a stay for extension offers
            ],
            // Changes to Beds24 (and so Airbnb) for dead voids, within limits. Off until switched on.
            'autopilot' => [
                'enabled' => false,
                'max_discount_pct' => 20,
                'floor_gbp' => 60,
                'max_days_ahead' => 45,
                'allow_min_stay' => true,
            ],
        ];
    }

    public function rates(): RateSource
    {
        return $this->rates ??= match ($this->config['rates']['source']) {
            'beds24' => new Beds24Rates($this),
            'ical' => new IcalRates($this),
            default => new LocalRates($this),
        };
    }

    public function gateway(): PaymentGateway
    {
        return $this->gateway ??= match ($this->config['payments']['gateway']) {
            'stripe' => new StripeGateway($this->config['stripe']),
            default => new FakeGateway($this->config['site']['base_url'], $this->config['paths']['data'] . '/fake-gateway.json'),
        };
    }

    public function mailer(): Mailer
    {
        return $this->mailer ??= new Mailer($this);
    }

    public function sites(): array
    {
        $rows = $this->all('SELECT * FROM sites ORDER BY sort, id');
        foreach ($rows as &$s) $s['content'] = Util::json($s['data']);
        return $rows;
    }

    public function siteById(?string $id): ?array
    {
        foreach ($this->sites() as $s) if ($s['id'] === $id) return $s;
        return null;
    }

    /** The site whose base_url has this host (and port); else the first site. */
    public function siteForHost(string $host): ?array
    {
        $sites = $this->sites();
        foreach ($sites as $s) {
            $u = parse_url($s['base_url']);
            $h = strtolower(($u['host'] ?? '') . (isset($u['port']) ? ':' . $u['port'] : ''));
            if ($h === strtolower($host)) return $s;
        }
        return $sites[0] ?? null;
    }

    public function inbox(): DashboardInbox
    {
        return $this->inbox ??= new DashboardInbox($this);
    }

    /** Tests swap providers in. */
    public function use(?RateSource $rates = null, ?PaymentGateway $gateway = null): void
    {
        if ($rates) $this->rates = $rates;
        if ($gateway) $this->gateway = $gateway;
    }

    public function migrate(): void
    {
        $this->db->exec(file_get_contents(__DIR__ . '/schema.sql'));
    }

    // ---- small DB helpers -------------------------------------------------

    public function one(string $sql, array $args = []): ?array
    {
        $st = $this->db->prepare($sql);
        $st->execute($args);
        $row = $st->fetch();
        return $row === false ? null : $row;
    }

    public function all(string $sql, array $args = []): array
    {
        $st = $this->db->prepare($sql);
        $st->execute($args);
        return $st->fetchAll();
    }

    public function exec(string $sql, array $args = []): int
    {
        $st = $this->db->prepare($sql);
        $st->execute($args);
        return $st->rowCount();
    }

    public function insert(string $table, array $row): void
    {
        $cols = array_keys($row);
        $sql = sprintf('INSERT INTO %s (%s) VALUES (%s)', $table, implode(',', $cols), implode(',', array_fill(0, count($cols), '?')));
        $this->exec($sql, array_values($row));
    }

    public function update(string $table, string $id, array $fields, string $key = 'id'): void
    {
        $sets = implode(',', array_map(fn($c) => "$c = ?", array_keys($fields)));
        $this->exec("UPDATE $table SET $sets WHERE $key = ?", [...array_values($fields), $id]);
    }

    /**
     * Runs $fn in a write transaction. On SQLite this is BEGIN IMMEDIATE, so
     * two guests checking the same night queue up instead of both passing.
     */
    public function tx(callable $fn): mixed
    {
        $sqlite = str_starts_with($this->config['db']['dsn'], 'sqlite:');
        $sqlite ? $this->db->exec('BEGIN IMMEDIATE') : $this->db->beginTransaction();
        try {
            $r = $fn();
            $sqlite ? $this->db->exec('COMMIT') : $this->db->commit();
            return $r;
        } catch (Throwable $e) {
            $sqlite ? $this->db->exec('ROLLBACK') : $this->db->rollBack();
            throw $e;
        }
    }

    public function log(string $entity, ?string $id, string $message): void
    {
        $this->insert('activity', ['at' => Util::now(), 'entity' => $entity, 'entity_id' => $id, 'message' => $message]);
    }
}
