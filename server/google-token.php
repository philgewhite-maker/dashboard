<?php
// Upload this file as it is. Its secrets and keys come from dashboard-config.php
// on the web host (see auth.php).
declare(strict_types=1);

/**
 * Keeps ONE long-lived Google sign-in on the web host, so no device has to
 * open Google's sign-in window every hour.
 *
 * WHY. The browser-only sign-in (Google Identity Services' token flow) gives
 * a page a one-hour access token and no way to renew it unattended: every
 * renewal opens Google's sign-in window, which fails offline, gets blocked
 * when nobody clicked, and cannot run on the NAS at all. Google only issues
 * a renewable sign-in (a refresh token) to a client that can keep a secret,
 * which a public web page cannot. This file is that client.
 *
 * HOW. You link once from Settings: the app asks this file for a Google
 * address (action=start), opens it, you consent, and Google sends the
 * browser back HERE with a one-time code. This file swaps the code, with the
 * client secret, for a refresh token and keeps it in dashboard-google.json,
 * one folder above public_html. After that any paired device (or the NAS)
 * asks here for an access token and gets a fresh one-hour token, no window.
 *
 * WHAT NEVER LEAVES THIS SERVER: the refresh token and the client secret.
 * Callers only ever receive short-lived access tokens.
 *
 *   GET  ?action=status              -> {configured, linked, scopes, linkedAt, linkedBy, lastRefreshAt, lastError, redirectUri}
 *   POST ?action=start  {scopes}     -> {url}   the Google consent address to open (valid 10 minutes)
 *   GET  (no action; ?code&state)    Google's redirect back after consent. Authorised by the one-time state
 *                                     from action=start, not by a header, since it is a plain browser visit.
 *   POST ?action=token  {force?}     -> {accessToken, expiresIn, scopes}
 *                                      404 {error:'not_linked'} / 409 {error:'relink'} when there is nothing to renew from
 *   POST ?action=unlink              -> {ok}   revokes at Google and forgets the sign-in
 *
 * Auth (all but the redirect): X-Sync-Secret, the master secret or a pair.php device token, as sync.php.
 * Config: google_client_id and google_client_secret in dashboard-config.php, the SAME OAuth client the
 * app already signs in with, and this file's address (status's redirectUri) added to that client's
 * "Authorised redirect URIs" in the Google Cloud console.
 */

require_once __DIR__ . '/auth.php';
$SECRET = '';

$CLIENT_ID = (string) dash_config('google_client_id');
$CLIENT_SECRET = (string) dash_config('google_client_secret');
$STORE_FILE = dirname(__DIR__) . '/dashboard-google.json';
// Where Google sends the browser back: this very file, no query string (Google matches it exactly).
$REDIRECT_URI = (string) dash_config('google_redirect_uri', 'https://' . ($_SERVER['HTTP_HOST'] ?? '') . strtok((string) ($_SERVER['REQUEST_URI'] ?? '/google-token.php'), '?'));

$ALLOWED_ORIGINS = [
    'https://philgewhite-maker.github.io',
    'http://localhost:8743',
    'http://localhost:5173',
];

function store_read(string $file): array {
    if (!is_file($file)) return [];
    $parsed = json_decode((string) file_get_contents($file), true);
    return is_array($parsed) ? $parsed : [];
}

function store_write(string $file, array $store): bool {
    $tmp = $file . '.tmp';
    if (file_put_contents($tmp, json_encode($store, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), LOCK_EX) === false) return false;
    @chmod($tmp, 0600);
    return rename($tmp, $file);
}

/** POST a form to Google; returns [httpStatus, decodedBody, curlError]. */
function google_post(string $url, array $fields): array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => http_build_query($fields),
        CURLOPT_HTTPHEADER => ['Content-Type: application/x-www-form-urlencoded'],
        CURLOPT_TIMEOUT => 20,
    ]);
    $raw = curl_exec($ch);
    $err = $raw === false ? curl_error($ch) : '';
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $body = json_decode((string) $raw, true);
    return [$status, is_array($body) ? $body : [], $err];
}

/** Takes the store's lock for the rest of the request (released when PHP exits). */
function store_lock(string $file): void {
    $lock = fopen($file . '.lock', 'c');
    if ($lock !== false) { flock($lock, LOCK_EX); $GLOBALS['__store_lock'] = $lock; }
}

$configured = dash_is_real_secret($CLIENT_ID) && dash_is_real_secret($CLIENT_SECRET);
$action = (string) ($_GET['action'] ?? '');

// ---- Google's redirect back (a plain browser visit, so HTML, no header auth) ----
if ($action === '' && (isset($_GET['state']) || isset($_GET['error']))) {
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-store');
    $page = function (string $title, string $text): void {
        $t = htmlspecialchars($title, ENT_QUOTES);
        $x = htmlspecialchars($text, ENT_QUOTES);
        echo "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>$t</title>"
            . "<body style=\"font:16px/1.5 system-ui,sans-serif;max-width:32em;margin:3em auto;padding:0 16px;\"><h1 style=\"font-size:20px;\">$t</h1><p>$x</p>"
            . "<script>setTimeout(function(){window.close();},1500);</script></body>";
        exit;
    };
    if (!$configured) $page('Not set up', 'Set google_client_id and google_client_secret in dashboard-config.php first.');
    store_lock($STORE_FILE);
    $s = store_read($STORE_FILE);
    $state = (string) ($_GET['state'] ?? '');
    $pending = is_array($s['pending'] ?? null) ? $s['pending'] : [];
    $entry = $pending[$state] ?? null;
    unset($pending[$state]);
    $pending = array_filter($pending, fn ($p) => (int) ($p['expires'] ?? 0) > time());
    $s['pending'] = $pending;
    store_write($STORE_FILE, $s);
    if ($state === '' || !is_array($entry) || (int) ($entry['expires'] ?? 0) < time()) {
        $page('Link expired', 'That sign-in link is out of date or was already used. Go back to the dashboard and press Link again.');
    }
    if (isset($_GET['error'])) $page('Not linked', 'Google said: ' . (string) $_GET['error'] . '. Nothing was changed.');
    [$status, $body, $err] = google_post('https://oauth2.googleapis.com/token', [
        'code' => (string) ($_GET['code'] ?? ''),
        'client_id' => $CLIENT_ID,
        'client_secret' => $CLIENT_SECRET,
        'redirect_uri' => $REDIRECT_URI,
        'grant_type' => 'authorization_code',
    ]);
    if ($status !== 200 || empty($body['access_token'])) {
        $page('Not linked', 'Google refused the sign-in code: ' . (string) ($body['error_description'] ?? $body['error'] ?? ($err ?: "HTTP $status")));
    }
    $refresh = (string) ($body['refresh_token'] ?? ($s['refreshToken'] ?? ''));
    if ($refresh === '') $page('Not linked', "Google didn't hand over a renewable sign-in. Press Link again in the dashboard.");
    $s['refreshToken'] = $refresh;
    $s['scopes'] = (string) ($body['scope'] ?? '');
    $s['accessToken'] = (string) $body['access_token'];
    $s['expiresAt'] = time() + (int) ($body['expires_in'] ?? 3600);
    $s['linkedAt'] = gmdate('c');
    $s['linkedBy'] = (string) ($entry['by'] ?? '');
    $s['lastRefreshAt'] = gmdate('c');
    $s['lastError'] = null;
    if (!store_write($STORE_FILE, $s)) $page('Not linked', 'Could not write dashboard-google.json on the web host.');
    $page('Google is linked', 'Your devices and the NAS can now stay signed in to Google. This window closes by itself; go back to the dashboard.');
}

// ---- Everything else: JSON, header auth ----
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin !== '' && in_array($origin, $ALLOWED_ORIGINS, true)) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin');
}
header('Access-Control-Allow-Headers: Content-Type, X-Sync-Secret');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Content-Type: application/json');
header('Cache-Control: no-store');

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') { http_response_code(204); exit; }

function fail(int $code, string $error, string $message = ''): void {
    http_response_code($code);
    echo json_encode(['error' => $error, 'message' => $message !== '' ? $message : $error]);
    exit;
}

if (!dash_secret_configured($SECRET)) fail(500, 'not_configured', 'Server not configured: set master_secret in dashboard-config.php');
$auth = dash_authorise((string) ($_SERVER['HTTP_X_SYNC_SECRET'] ?? ''), $SECRET);
if (!$auth['ok']) fail(401, 'unauthorised', 'Bad or missing sync secret');
if ($action === '') $action = 'status';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($action === 'status') {
    $s = store_read($STORE_FILE);
    echo json_encode([
        'configured' => $configured,
        'linked' => !empty($s['refreshToken']),
        'scopes' => (string) ($s['scopes'] ?? ''),
        'linkedAt' => $s['linkedAt'] ?? null,
        'linkedBy' => $s['linkedBy'] ?? null,
        'lastRefreshAt' => $s['lastRefreshAt'] ?? null,
        'lastError' => $s['lastError'] ?? null,
        'redirectUri' => $REDIRECT_URI,
    ]);
    exit;
}

if ($method !== 'POST') fail(405, 'use_post', 'Use POST');
$req = json_decode(file_get_contents('php://input') ?: '', true);
if (!is_array($req)) $req = [];

if ($action === 'unlink') {
    store_lock($STORE_FILE);
    $s = store_read($STORE_FILE);
    if (!empty($s['refreshToken'])) google_post('https://oauth2.googleapis.com/revoke', ['token' => $s['refreshToken']]);
    if (is_file($STORE_FILE)) @unlink($STORE_FILE);
    echo json_encode(['ok' => true]);
    exit;
}

if (!$configured) fail(500, 'not_configured', 'Server not configured: set google_client_id and google_client_secret in dashboard-config.php');

if ($action === 'start') {
    $scopes = trim((string) ($req['scopes'] ?? ''));
    if ($scopes === '' || !preg_match('#^(https://www\.googleapis\.com/auth/[a-z.]+ ?)+$#', $scopes)) fail(400, 'bad_scopes', 'Expected {scopes}: Google API scope URLs separated by spaces');
    store_lock($STORE_FILE);
    $s = store_read($STORE_FILE);
    $state = bin2hex(random_bytes(16));
    $pending = array_filter(is_array($s['pending'] ?? null) ? $s['pending'] : [], fn ($p) => (int) ($p['expires'] ?? 0) > time());
    $pending[$state] = ['expires' => time() + 600, 'by' => $auth['label']];
    $s['pending'] = $pending;
    if (!store_write($STORE_FILE, $s)) fail(500, 'store_failed', 'Could not write dashboard-google.json');
    $url = 'https://accounts.google.com/o/oauth2/v2/auth?' . http_build_query([
        'client_id' => $CLIENT_ID,
        'redirect_uri' => $REDIRECT_URI,
        'response_type' => 'code',
        'scope' => $scopes,
        'access_type' => 'offline', // the renewable sign-in
        'prompt' => 'consent',      // Google only issues one when it shows the consent screen
        'include_granted_scopes' => 'true',
        'state' => $state,
    ]);
    echo json_encode(['url' => $url]);
    exit;
}

if ($action === 'token') {
    // One renewal at a time: several devices asking at once share the token the first one fetched.
    store_lock($STORE_FILE);
    $s = store_read($STORE_FILE);
    if (empty($s['refreshToken'])) fail(404, 'not_linked', 'Google is not linked to the server yet.');
    $force = !empty($req['force']);
    if (!$force && !empty($s['accessToken']) && (int) ($s['expiresAt'] ?? 0) > time() + 120) {
        echo json_encode(['accessToken' => $s['accessToken'], 'expiresIn' => (int) $s['expiresAt'] - time(), 'scopes' => (string) ($s['scopes'] ?? '')]);
        exit;
    }
    [$status, $body, $err] = google_post('https://oauth2.googleapis.com/token', [
        'refresh_token' => $s['refreshToken'],
        'client_id' => $CLIENT_ID,
        'client_secret' => $CLIENT_SECRET,
        'grant_type' => 'refresh_token',
    ]);
    if ($err !== '') fail(502, 'google_unreachable', 'Could not reach Google: ' . $err);
    if ($status !== 200 || empty($body['access_token'])) {
        $code = (string) ($body['error'] ?? "HTTP $status");
        if ($code === 'invalid_grant') {
            // Revoked, expired (an OAuth app left in Testing expires these after 7 days), or the password changed.
            $s['refreshToken'] = '';
            $s['accessToken'] = '';
            $s['lastError'] = gmdate('c') . ' Google no longer accepts the saved sign-in (invalid_grant)';
            store_write($STORE_FILE, $s);
            fail(409, 'relink', 'Google no longer accepts the saved sign-in. Link Google again in Settings.');
        }
        $s['lastError'] = gmdate('c') . ' ' . $code;
        store_write($STORE_FILE, $s);
        fail(502, 'refresh_failed', 'Google refused to renew the sign-in: ' . (string) ($body['error_description'] ?? $code));
    }
    $s['accessToken'] = (string) $body['access_token'];
    $s['expiresAt'] = time() + (int) ($body['expires_in'] ?? 3600);
    if (!empty($body['scope'])) $s['scopes'] = (string) $body['scope'];
    if (!empty($body['refresh_token'])) $s['refreshToken'] = (string) $body['refresh_token'];
    $s['lastRefreshAt'] = gmdate('c');
    $s['lastError'] = null;
    store_write($STORE_FILE, $s);
    echo json_encode(['accessToken' => $s['accessToken'], 'expiresIn' => $s['expiresAt'] - time(), 'scopes' => $s['scopes']]);
    exit;
}

fail(400, 'unknown_action', 'Unknown action: use status, start, token or unlink');
