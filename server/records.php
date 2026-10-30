<?php
declare(strict_types=1);

/**
 * Per-record store for the whole dashboard -- the successor to keeping
 * everything in one JSON document (sync.php). Each record (a task, a trip, a
 * day of health data, one pref) is its own row with its own revision, so two
 * devices editing different records never conflict, a delete is a real
 * tombstone that reaches every device, and a device only downloads what
 * changed since it last asked.
 *
 * ADDITIVE: sync.php is untouched and stays the source of truth until the
 * client flips a collection over (js/sync/recordsync.js). Uploading this file
 * changes nothing for a client that doesn't know about it.
 *
 * MULTI-USER READY: every row carries a user_id, and that id comes ONLY from
 * the credential presented -- never from the request body. The master secret
 * and every device paired so far belong to user "owner"; a device row in
 * dashboard-devices.json can carry a "userId" to belong to someone else.
 * Every query below is scoped by that one value, which is the whole of the
 * isolation guarantee.
 *
 * The server never looks inside `data`: it's whatever the client sent,
 * normally an AES-GCM envelope (js/cryptobox.js), so this file stores
 * ciphertext and can't leak content even to someone holding the DB file.
 *
 *   GET  ?ping                  -> {ok, version, user}
 *   GET  ?since=<seq>[&limit=n] -> {seq, more, changes:[{coll,id,rev,deleted,updatedAt,data}]}
 *   POST {writes:[{coll,id,rev,data}|{coll,id,rev,deleted:true}]}
 *                               -> {seq, results:[{coll,id,ok,rev} | {coll,id,ok:false,conflict:{rev,deleted,updatedAt,data}}]}
 *
 * A write is accepted only if its `rev` matches the row's current revision
 * (0 for a row that doesn't exist yet) -- the same rule sync.php and
 * sync-connections.php use, applied per row instead of per document.
 *
 * Needs PHP's pdo_sqlite (standard on cPanel hosts). Upload next to
 * sync.php; no configuration needed -- it reuses auth.php.
 */

// ---- Configuration ---------------------------------------------------

// Leave as a placeholder to use auth.php's master secret and device tokens,
// the same convention as sync-connections.php.
$SECRET = 'PUT-A-LONG-RANDOM-STRING-HERE';

// One directory ABOVE this script: outside public_html on cPanel, so the
// database is never web-reachable even if .htaccess is lost.
$STORE_FILE = dirname(__DIR__) . '/dashboard-store.sqlite';

// Must match sync.php's own $ALLOWED_ORIGINS.
$ALLOWED_ORIGINS = [
    'https://philgewhite-maker.github.io',
    'http://localhost:8743',
];

// ---- End of configuration --------------------------------------------

const RECORDS_VERSION = 1;
const MAX_WRITES = 500;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_PAGE = 1000;
const MAX_PAGE = 5000;

if (!defined('RECORDS_NO_MAIN')) {
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($origin !== '' && in_array($origin, $ALLOWED_ORIGINS, true)) {
        header('Access-Control-Allow-Origin: ' . $origin);
        header('Vary: Origin');
    }
    header('Access-Control-Allow-Headers: Content-Type, X-Sync-Secret');
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Max-Age: 86400');
    header('Content-Type: application/json');
    header('Cache-Control: no-store');
    if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
        http_response_code(204);
        exit;
    }
}

function rec_fail(int $code, string $message): void {
    http_response_code($code);
    echo json_encode(['error' => $message]);
    exit;
}

function rec_valid_coll(string $c): bool {
    return preg_match('/^[A-Za-z0-9_]{1,64}$/', $c) === 1;
}

// Ids are app-issued uid()s, ISO dates (health rows), or pref names.
function rec_valid_id(string $id): bool {
    return preg_match('/^[A-Za-z0-9_.:-]{1,200}$/', $id) === 1;
}

/**
 * Which user a credential belongs to. Master secret -> "owner". A device
 * token -> that device's "userId", or "owner" for every device paired before
 * users existed. Returns null when the credential is not valid at all.
 */
function rec_user_for(string $provided, ?string $localSecret): ?string {
    global $DASH_DEVICES_FILE;
    $auth = dash_authorise($provided, $localSecret);
    if (!$auth['ok']) return null;
    if ($auth['via'] === 'master') return 'owner';
    $device = dash_find_device(dash_devices_read($DASH_DEVICES_FILE)['devices'], $provided);
    $user = is_array($device) ? (string) ($device['userId'] ?? '') : '';
    if ($user === '') return 'owner';
    return preg_match('/^[A-Za-z0-9_-]{1,64}$/', $user) === 1 ? $user : null;
}

function rec_open(string $file): PDO {
    $pdo = new PDO('sqlite:' . $file, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    @chmod($file, 0600);
    // WAL lets readers carry on while one writer commits; busy_timeout makes
    // a second writer wait its turn instead of failing straight away.
    $pdo->exec('PRAGMA journal_mode = WAL');
    $pdo->exec('PRAGMA busy_timeout = 5000');
    $pdo->exec('PRAGMA synchronous = NORMAL');
    $pdo->exec('CREATE TABLE IF NOT EXISTS records (
        user_id TEXT NOT NULL,
        coll TEXT NOT NULL,
        id TEXT NOT NULL,
        rev INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        data TEXT,
        PRIMARY KEY (user_id, coll, id)
    )');
    $pdo->exec('CREATE INDEX IF NOT EXISTS records_by_seq ON records (user_id, seq)');
    // One global counter: every write takes the next number, so "everything
    // after N" is a single indexed range scan for a pull.
    $pdo->exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)');
    $pdo->exec("INSERT OR IGNORE INTO meta (k, v) VALUES ('seq', 0)");
    return $pdo;
}

function rec_current_seq(PDO $pdo): int {
    return (int) $pdo->query("SELECT v FROM meta WHERE k = 'seq'")->fetchColumn();
}

function rec_row_out(array $r): array {
    return [
        'coll' => $r['coll'],
        'id' => $r['id'],
        'rev' => (int) $r['rev'],
        'deleted' => (bool) $r['deleted'],
        'updatedAt' => $r['updated_at'],
        'data' => $r['data'] === null ? null : json_decode($r['data']),
    ];
}

/** Changes for one user after `since`, oldest first, one page at a time. */
function rec_changes(PDO $pdo, string $user, int $since, int $limit): array {
    $limit = max(1, min(MAX_PAGE, $limit));
    // Both reads below must see the same snapshot: otherwise a write
    // committed between them could move the counter past a row this page
    // never saw, and that change would be skipped for good.
    $pdo->exec('BEGIN');
    try {
        $out = rec_changes_in_snapshot($pdo, $user, $since, $limit);
        $pdo->exec('COMMIT');
        return $out;
    } catch (Throwable $e) {
        $pdo->exec('ROLLBACK');
        throw $e;
    }
}

function rec_changes_in_snapshot(PDO $pdo, string $user, int $since, int $limit): array {
    $st = $pdo->prepare('SELECT coll, id, rev, seq, deleted, updated_at, data FROM records
        WHERE user_id = :u AND seq > :s ORDER BY seq LIMIT :l');
    $st->bindValue(':u', $user);
    $st->bindValue(':s', $since, PDO::PARAM_INT);
    $st->bindValue(':l', $limit + 1, PDO::PARAM_INT);
    $st->execute();
    $rows = $st->fetchAll();
    $more = count($rows) > $limit;
    if ($more) array_pop($rows);
    // With nothing new, hand back the global counter: nothing of this user's
    // can sit below it any more, so the next pull starts from there.
    $seq = $rows ? (int) end($rows)['seq'] : max($since, rec_current_seq($pdo));
    return ['seq' => $seq, 'more' => $more, 'changes' => array_map('rec_row_out', $rows)];
}

/**
 * Apply a batch of writes for one user in a single transaction. Each write
 * succeeds or reports a conflict on its own; a conflict never blocks the
 * other writes in the batch.
 */
function rec_write(PDO $pdo, string $user, array $writes): array {
    $pdo->exec('BEGIN IMMEDIATE');
    try {
        $get = $pdo->prepare('SELECT rev, deleted, updated_at, data FROM records WHERE user_id = :u AND coll = :c AND id = :i');
        $put = $pdo->prepare('INSERT INTO records (user_id, coll, id, rev, seq, deleted, updated_at, data)
            VALUES (:u, :c, :i, :r, :s, :d, :t, :data)
            ON CONFLICT (user_id, coll, id) DO UPDATE SET rev = excluded.rev, seq = excluded.seq,
            deleted = excluded.deleted, updated_at = excluded.updated_at, data = excluded.data');
        $bump = $pdo->prepare("UPDATE meta SET v = v + 1 WHERE k = 'seq'");
        $results = [];
        foreach ($writes as $w) {
            // The body is decoded with objects kept as objects, so an empty
            // {} in a record survives the round trip (assoc decoding would
            // turn it into [] and the record would come back changed).
            $w = is_object($w) ? (array) $w : (is_array($w) ? $w : []);
            $coll = (string) ($w['coll'] ?? '');
            $id = (string) ($w['id'] ?? '');
            if (!rec_valid_coll($coll) || !rec_valid_id($id) || !array_key_exists('rev', $w)) {
                $results[] = ['coll' => $coll, 'id' => $id, 'ok' => false, 'error' => 'invalid write'];
                continue;
            }
            $deleted = !empty($w['deleted']);
            if (!$deleted && !array_key_exists('data', $w)) {
                $results[] = ['coll' => $coll, 'id' => $id, 'ok' => false, 'error' => 'missing data'];
                continue;
            }
            $get->execute([':u' => $user, ':c' => $coll, ':i' => $id]);
            $cur = $get->fetch();
            $get->closeCursor();
            $curRev = $cur ? (int) $cur['rev'] : 0;
            if ((int) $w['rev'] !== $curRev) {
                $results[] = ['coll' => $coll, 'id' => $id, 'ok' => false, 'conflict' => [
                    'rev' => $curRev,
                    'deleted' => $cur ? (bool) $cur['deleted'] : false,
                    'updatedAt' => $cur ? $cur['updated_at'] : null,
                    'data' => ($cur && $cur['data'] !== null) ? json_decode($cur['data']) : null,
                ]];
                continue;
            }
            $bump->execute();
            $seq = rec_current_seq($pdo);
            $now = gmdate('c');
            $put->execute([
                ':u' => $user, ':c' => $coll, ':i' => $id, ':r' => $curRev + 1, ':s' => $seq,
                ':d' => $deleted ? 1 : 0, ':t' => $now,
                ':data' => $deleted ? null : json_encode($w['data'], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
            ]);
            $results[] = ['coll' => $coll, 'id' => $id, 'ok' => true, 'rev' => $curRev + 1, 'updatedAt' => $now];
        }
        $pdo->exec('COMMIT');
        return ['seq' => rec_current_seq($pdo), 'results' => $results];
    } catch (Throwable $e) {
        $pdo->exec('ROLLBACK');
        throw $e;
    }
}

if (defined('RECORDS_NO_MAIN')) return;

// ---- Request handling --------------------------------------------------

require_once __DIR__ . '/auth.php';
if (!dash_secret_configured($SECRET)) rec_fail(500, 'Server not configured: set $DASH_MASTER_SECRET in auth.php');
if (!extension_loaded('pdo_sqlite')) rec_fail(500, 'This host has no pdo_sqlite extension');

$user = rec_user_for((string) ($_SERVER['HTTP_X_SYNC_SECRET'] ?? ''), $SECRET);
if ($user === null) rec_fail(401, 'Bad or missing sync secret');

try {
    $pdo = rec_open($STORE_FILE);
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($method === 'GET') {
        if (isset($_GET['ping'])) {
            echo json_encode(['ok' => true, 'version' => RECORDS_VERSION, 'user' => $user]);
            exit;
        }
        $since = max(0, (int) ($_GET['since'] ?? 0));
        $limit = (int) ($_GET['limit'] ?? DEFAULT_PAGE);
        echo json_encode(rec_changes($pdo, $user, $since, $limit), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        exit;
    }
    if ($method !== 'POST') rec_fail(405, 'Use GET or POST');
    $raw = file_get_contents('php://input') ?: '';
    if (strlen($raw) > MAX_BODY_BYTES) rec_fail(413, 'Body too large');
    $body = json_decode($raw);
    $writes = is_object($body) ? ($body->writes ?? null) : null;
    if (!is_array($writes) || !array_is_list($writes)) rec_fail(400, 'Expected {writes:[...]}');
    if (count($writes) > MAX_WRITES) rec_fail(413, 'At most ' . MAX_WRITES . ' writes per request');
    echo json_encode(rec_write($pdo, $user, $writes), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
} catch (Throwable $e) {
    rec_fail(500, 'Store error: ' . $e->getMessage());
}
