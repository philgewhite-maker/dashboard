<?php
// Upload this file as it is. Its secrets and keys come from dashboard-config.php
// on the web host (see auth.php), so older notes below about filling in values
// in this file no longer apply.
declare(strict_types=1);

/**
 * Health data receiver.
 *
 * Accepts whatever a Health Connect bridge app (e.g. "HC Webhook" / "Health
 * Connect Webhook" on Google Play) posts from your phone — steps, sleep,
 * heart rate, weight, whatever data types you grant it — and appends it to
 * its own log file.
 *
 * Unlike sync.php, there is no {rev} check here. sync.php protects a
 * read-modify-write document where two overlapping saves could clobber each
 * other; this is append-only — a webhook firing repeatedly during the day
 * has no "current state" to race against, only a growing log, so a file
 * lock around each append is enough.
 *
 *   POST -> {...whatever the bridge app sends...}   append one entry, tagged
 *                                                    with the time it arrived
 *   GET  -> {entries: [...]}                         the most recent entries,
 *                                                    newest first
 *
 * The exact shape of what the bridge app posts is unknown until a real one
 * arrives — this deliberately stores whatever JSON (or raw body, if it isn't
 * JSON) shows up rather than assuming field names, so the first real POST
 * can be inspected via GET before any parsing logic gets built against it.
 *
 * Auth: X-Sync-Secret header only (master secret or a pair.php device
 * token). `?secret=` is accepted ONLY on a POST and ONLY when it matches the
 * separate, append-only $WEBHOOK_SECRET (HEALTH_AUTH_V2, Nov 2026).
 *
 * Upload to your Krystal hosting (cPanel -> File Manager) and set the
 * values below — same secret as sync.php. See README.md, "Health data
 * (Health Connect via HC Webhook)".
 */

// ---- Configuration ---------------------------------------------------

require_once __DIR__ . '/auth.php'; // loads dashboard-config.php
// The shared secret lives in dashboard-config.php (see auth.php); leave this empty.
$SECRET = '';

// OPTIONAL, for a phone bridge app that can only put a secret in the URL.
// A DIFFERENT random value from the master secret (openssl rand -hex 32),
// accepted only as ?secret= on a POST: it can append health data and do
// nothing else. Leave on the placeholder if your bridge app sends the
// X-Sync-Secret header -- then no secret is ever accepted in the address.
// If it is ever set equal to the master secret it is refused outright.
$WEBHOOK_SECRET = dash_config('health_webhook_secret');

// Outside public_html, like sync.php's document — not reachable over the
// web even if the .htaccess is ever lost.
$DATA_FILE = dirname(__DIR__) . '/health-data.jsonl';

// How many of the most recent entries a GET returns by default. This file
// only ever grows, so returning everything ever posted isn't useful past a
// certain point — override with ?limit=N (capped at 2000) if more is needed.
$DEFAULT_LIMIT = 500;

$ALLOWED_ORIGINS = [
    'https://philgewhite-maker.github.io',
    'http://localhost:8743',
];

// ---- End of configuration --------------------------------------------

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

function fail(int $code, string $message): void {
    http_response_code($code);
    echo json_encode(['error' => $message]);
    exit;
}

require_once __DIR__ . '/auth.php';
if (!dash_secret_configured($SECRET)) {
    fail(500, 'Server not configured: set master_secret in dashboard-config.php');
}
// HEALTH_AUTH_V2 (Nov 2026). The master secret and device tokens are
// accepted ONLY in the X-Sync-Secret header. Until now `?secret=` was
// accepted too, which put the master secret into the host's access logs on
// every webhook post (and, before dashboard v825, on every health fetch).
//
// A bridge app that cannot set a header can still post, but only with
// $WEBHOOK_SECRET below: a separate value that can do exactly one thing,
// append to this log (POST). It can't read health data, and it opens no
// other endpoint, so its copy in a log line is worth very little.
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$headerSecret = (string) ($_SERVER['HTTP_X_SYNC_SECRET'] ?? '');
$querySecret = isset($_GET['secret']) && is_string($_GET['secret']) ? $_GET['secret'] : '';

if ($headerSecret !== '') {
    // Accepts the master secret (auth.php or this file's $SECRET) or any
    // per-device token issued by pair.php.
    if (!dash_authorise($headerSecret, $SECRET)['ok']) {
        fail(401, 'Bad or missing secret');
    }
} elseif ($querySecret !== '') {
    $webhookReady = dash_is_real_secret($WEBHOOK_SECRET)
        && !hash_equals(dash_master_secret($SECRET), (string) $WEBHOOK_SECRET);
    if ($method !== 'POST' || !$webhookReady || !hash_equals((string) $WEBHOOK_SECRET, $querySecret)) {
        fail(401, 'A secret in the address is no longer accepted here. Send it in the X-Sync-Secret header, or (bridge app POSTs only) use the separate health webhook secret.');
    }
} else {
    fail(401, 'Bad or missing secret');
}

if ($method === 'POST') {
    $raw = file_get_contents('php://input') ?: '';
    // 512KB is far more than one health sync payload should ever be — a
    // sanity cap, not a real limit, so a misconfigured client can't slowly
    // fill the disk one oversized POST at a time.
    if (strlen($raw) > 512 * 1024) fail(413, 'That payload is larger than expected for a health sync.');
    $parsed = json_decode($raw, true);
    // Stored as-is even if it wasn't valid JSON — better to capture the raw
    // body for inspection than to reject a real payload just because its
    // shape was a surprise.
    $entry = ['receivedAt' => gmdate('c'), 'payload' => $parsed !== null ? $parsed : $raw];

    $lock = fopen($DATA_FILE . '.lock', 'c');
    if ($lock === false) fail(500, 'Could not open lock file — check directory permissions');
    flock($lock, LOCK_EX);
    $ok = file_put_contents($DATA_FILE, json_encode($entry) . "\n", FILE_APPEND | LOCK_EX);
    flock($lock, LOCK_UN);
    fclose($lock);
    if ($ok === false) fail(500, 'Could not write health data file — check directory permissions');

    echo json_encode(['ok' => true]);
    exit;
}

if ($method === 'GET') {
    if (!is_file($DATA_FILE)) {
        echo json_encode(['entries' => []]);
        exit;
    }
    $limit = isset($_GET['limit']) ? max(1, min(2000, (int) $_GET['limit'])) : $DEFAULT_LIMIT;
    $lines = file($DATA_FILE, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [];
    $recent = array_slice($lines, -$limit);
    $entries = array_values(array_filter(array_map(
        function ($line) { return json_decode($line, true); },
        $recent
    )));
    echo json_encode(['entries' => array_reverse($entries)]);
    exit;
}

fail(405, 'Use GET or POST');
