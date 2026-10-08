<?php
declare(strict_types=1);

/**
 * Per-record sync for Connections only -- a smaller, additive sibling to
 * sync.php's whole-document endpoint, built to answer one specific
 * problem: every save re-encrypts and re-uploads the ENTIRE document
 * (2+ MB), even when only one connection actually changed. With several
 * clients, a NAS, and a relay app all writing, that's both wasteful and a
 * growing truncation/conflict risk (a big single-revision write is an
 * all-or-nothing gamble on a flaky connection).
 *
 * Each connection becomes its own small file, its own revision, so two
 * devices editing DIFFERENT connections never contend with each other at
 * all, and a device editing the SAME connection gets a real per-record
 * conflict it can merge (js/features/connections.js's own
 * mergeConnectionInto) instead of the whole document winning or losing.
 *
 * DELIBERATELY ADDITIVE, NOT A REPLACEMENT (yet): sync.php keeps syncing
 * data.connections exactly as it does today. This endpoint is a second,
 * lower-stakes path running alongside it -- nothing regresses if this one
 * has a bug, since the whole-document copy is still the source of truth
 * until a later step removes connections from that payload.
 *
 * Four operations, same shared-secret/device-token auth as sync.php:
 *   GET  ?index=1        -> [{id, rev, updatedAt}, ...]   every record's
 *                           id+rev, no data -- cheap, used to find out
 *                           which records changed since last sync.
 *   GET  ?id=<id>         -> {id, rev, updatedAt, data}    one record.
 *                           data is whatever the client sent (normally
 *                           ciphertext -- this endpoint never looks
 *                           inside it, same as sync.php).
 *   POST {id, rev, data}  -> write, but only if `rev` matches the
 *                           record's current rev (0 for a new record) --
 *                           otherwise 409 with the current {id, rev,
 *                           updatedAt, data} to adopt/merge.
 *   POST ?delete=1 {id, rev} -> delete the record file, same rev check.
 *
 * Upload next to sync.php. Needs no configuration of its own -- it reuses
 * sync.php's $SECRET (or the shared auth.php master secret / per-device
 * tokens) by requiring auth.php exactly as sync.php does. If this file
 * sits in the same directory as sync.php, nothing else to set up.
 */

// ---- Configuration ---------------------------------------------------

// Leave as a placeholder to fall back to auth.php's shared master secret
// (and any per-device tokens) -- same convention sync.php's own $SECRET
// override follows. Only set this if you want THIS endpoint to accept a
// different secret than everything else.
$SECRET = 'PUT-A-LONG-RANDOM-STRING-HERE';

// One directory ABOVE this script, same as sync.php's $DATA_FILE -- on
// cPanel that means outside public_html, so the record files are not
// web-reachable even if .htaccess is ever lost.
$RECORDS_DIR = dirname(__DIR__) . '/dashboard-connections';

// Must match sync.php's own $ALLOWED_ORIGINS -- duplicated rather than
// shared, since each endpoint file is meant to be uploaded standalone.
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

// A bare record id is used directly as a filename below (id . '.json').
// Every id this app issues is uid() from js/utils.js -- lowercase
// alphanumerics only -- but this is the one place a malformed/malicious
// id could otherwise walk outside $RECORDS_DIR (e.g. "../../etc/passwd"),
// so it's enforced here rather than trusted from the client.
function valid_id(string $id): bool {
    return $id !== '' && preg_match('/^[A-Za-z0-9_-]{1,100}$/', $id) === 1;
}

$provided = $_SERVER['HTTP_X_SYNC_SECRET'] ?? '';
require_once __DIR__ . '/auth.php';
if (!dash_secret_configured($SECRET)) {
    fail(500, 'Server not configured: set $DASH_MASTER_SECRET in auth.php');
}
if (!dash_authorise((string) $provided, $SECRET)['ok']) {
    fail(401, 'Bad or missing sync secret');
}

if (!is_dir($RECORDS_DIR)) {
    if (!@mkdir($RECORDS_DIR, 0700, true) && !is_dir($RECORDS_DIR)) {
        fail(500, 'Could not create records directory — check parent directory permissions');
    }
}

function record_path(string $dir, string $id): string {
    return $dir . '/' . $id . '.json';
}

// {rev:0, updatedAt:null, data:null} for a record that doesn't exist yet
// -- same "empty means rev 0" convention sync.php's read_store() uses,
// so a brand-new connection's first push (client-side rev 0) is accepted
// as a create rather than needing a separate "create" verb.
function read_record(string $path): array {
    $empty = ['rev' => 0, 'updatedAt' => null, 'data' => null];
    if (!is_file($path)) return $empty;
    $raw = file_get_contents($path);
    if ($raw === false || $raw === '') return $empty;
    $parsed = json_decode($raw, true);
    if (!is_array($parsed) || !array_key_exists('rev', $parsed)) return $empty;
    return [
        'rev' => (int) $parsed['rev'],
        'updatedAt' => $parsed['updatedAt'] ?? null,
        'data' => $parsed['data'] ?? null,
    ];
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($method === 'GET') {
    if (isset($_GET['index'])) {
        // Every *.json in the directory, id+rev+updatedAt only -- a pull
        // reconciles this against its own last-known revs to find out
        // which records to actually fetch, so this stays cheap even with
        // hundreds of connections.
        $out = [];
        foreach (glob($RECORDS_DIR . '/*.json') ?: [] as $file) {
            $id = basename($file, '.json');
            if (!valid_id($id)) continue;
            $rec = read_record($file);
            if ($rec['data'] === null) continue; // a stale empty read, not a real record
            $out[] = ['id' => $id, 'rev' => $rec['rev'], 'updatedAt' => $rec['updatedAt']];
        }
        echo json_encode($out);
        exit;
    }
    $id = (string) ($_GET['id'] ?? '');
    if (!valid_id($id)) fail(400, 'Missing or invalid id');
    $rec = read_record(record_path($RECORDS_DIR, $id));
    echo json_encode(array_merge(['id' => $id], $rec));
    exit;
}

if ($method !== 'POST') {
    fail(405, 'Use GET or POST');
}

$body = json_decode(file_get_contents('php://input') ?: '', true);
if (!is_array($body) || !array_key_exists('id', $body) || !array_key_exists('rev', $body)) {
    fail(400, 'Expected a JSON body of {id, rev, data}');
}
$id = (string) $body['id'];
if (!valid_id($id)) fail(400, 'Invalid id');

$path = record_path($RECORDS_DIR, $id);
$lock = fopen($path . '.lock', 'c');
if ($lock === false) fail(500, 'Could not open lock file — check directory permissions');
flock($lock, LOCK_EX);

$current = read_record($path);

if (isset($_GET['delete'])) {
    if ((int) $body['rev'] !== $current['rev']) {
        flock($lock, LOCK_UN);
        fclose($lock);
        http_response_code(409);
        echo json_encode(array_merge(['id' => $id], $current));
        exit;
    }
    if (is_file($path)) @unlink($path);
    @unlink($path . '.lock');
    flock($lock, LOCK_UN);
    fclose($lock);
    echo json_encode(['id' => $id, 'deleted' => true]);
    exit;
}

if (!array_key_exists('data', $body)) {
    flock($lock, LOCK_UN);
    fclose($lock);
    fail(400, 'Expected a JSON body of {id, rev, data}');
}

if ((int) $body['rev'] !== $current['rev']) {
    flock($lock, LOCK_UN);
    fclose($lock);
    http_response_code(409);
    echo json_encode(array_merge(['id' => $id], $current));
    exit;
}

$next = [
    'rev' => $current['rev'] + 1,
    'updatedAt' => gmdate('c'),
    'data' => $body['data'],
];

$tmp = $path . '.tmp';
if (file_put_contents($tmp, json_encode($next)) === false) {
    flock($lock, LOCK_UN);
    fclose($lock);
    fail(500, 'Could not write record file — check directory permissions');
}
rename($tmp, $path);

flock($lock, LOCK_UN);
fclose($lock);

echo json_encode(['id' => $id, 'rev' => $next['rev'], 'updatedAt' => $next['updatedAt']]);
