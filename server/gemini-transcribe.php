<?php
declare(strict_types=1);

/**
 * Gemini audio-transcription proxy.
 *
 * Claude's own API has no audio-input content type, so a shared voice-memo
 * clip is transcribed via Gemini instead. Gemini's API sends no CORS
 * headers a browser would accept for this either, so the same detour
 * notion.php already uses applies here: the browser posts the raw audio
 * bytes to this file, this file base64-encodes them and forwards to
 * Gemini with your API key, and only the transcript text goes back to the
 * browser. Your Gemini key lives here, on your own host, never in the
 * browser.
 *
 * Usage: POST the raw audio bytes (Content-Type set to the real audio
 * mime type) authenticated with the same shared secret as sync.php.
 * Response: {"transcript": "..."}.
 *
 * Copy to gemini-transcribe.php, fill in the two values, upload to
 * public_html.
 */

// ---- Configuration ---------------------------------------------------

// The same secret as sync.php — one string to configure, not two.
$SECRET = 'PUT-THE-SAME-SECRET-AS-SYNC.PHP-HERE';

// A Gemini API key from Google AI Studio (aistudio.google.com/apikey).
$GEMINI_API_KEY = 'PUT-YOUR-GEMINI-API-KEY-HERE';

// Flash tier: fast and cheap, which is all a transcription call needs.
$GEMINI_MODEL = 'gemini-2.0-flash';

$ALLOWED_ORIGINS = [
    'https://philgewhite-maker.github.io',
    'http://localhost:8743',
];

// A generous cap, well under Gemini's own 20MB inline-audio limit —
// large enough for a long voice memo, small enough to fail fast on
// something that was never meant to land here.
$MAX_BYTES = 15 * 1024 * 1024;

// ---- End of configuration --------------------------------------------

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin !== '' && in_array($origin, $ALLOWED_ORIGINS, true)) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin');
}
header('Access-Control-Allow-Headers: Content-Type, X-Sync-Secret');
header('Access-Control-Allow-Methods: POST, OPTIONS');
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

if ($SECRET === '' || strpos($SECRET, 'PUT-') === 0) fail(500, 'Server not configured: set $SECRET in gemini-transcribe.php');
if ($GEMINI_API_KEY === '' || strpos($GEMINI_API_KEY, 'PUT-') === 0) fail(500, 'Server not configured: set $GEMINI_API_KEY in gemini-transcribe.php');

$provided = $_SERVER['HTTP_X_SYNC_SECRET'] ?? '';
if (!is_string($provided) || !hash_equals($SECRET, $provided)) fail(401, 'Bad or missing sync secret');

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') fail(405, 'Use POST');

$audio = file_get_contents('php://input');
if ($audio === false || $audio === '') fail(400, 'No audio in request body');
if (strlen($audio) > $MAX_BYTES) fail(413, 'That clip is larger than this proxy accepts');

$mimeType = $_SERVER['CONTENT_TYPE'] ?? 'audio/webm';
// Strip any charset/codec parameter -- Gemini wants a bare mime type
// (e.g. "audio/webm", not "audio/webm;codecs=opus").
$mimeType = trim(explode(';', $mimeType)[0]);
if (strpos($mimeType, 'audio/') !== 0) $mimeType = 'audio/webm';

$body = [
    'contents' => [[
        'parts' => [
            ['text' => 'Transcribe this audio clip exactly as spoken. Reply with only the transcript, no commentary, no quotation marks around it.'],
            ['inline_data' => ['mime_type' => $mimeType, 'data' => base64_encode($audio)]],
        ],
    ]],
];

$url = 'https://generativelanguage.googleapis.com/v1beta/models/' . $GEMINI_MODEL . ':generateContent?key=' . urlencode($GEMINI_API_KEY);

$ch = curl_init($url);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST => true,
    CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
    CURLOPT_POSTFIELDS => json_encode($body),
    CURLOPT_TIMEOUT => 60,
]);

$response = curl_exec($ch);
if ($response === false) {
    $err = curl_error($ch);
    curl_close($ch);
    fail(502, 'Could not reach Gemini: ' . $err);
}
$status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($status !== 200) {
    // Pass Gemini's own status through, so the client can tell a bad key
    // (401/403) from a rejected clip (400) rather than seeing everything
    // as a generic failure.
    http_response_code($status);
    echo json_encode(['error' => 'Gemini returned HTTP ' . $status . ': ' . substr($response, 0, 300)]);
    exit;
}

$parsed = json_decode($response, true);
$transcript = $parsed['candidates'][0]['content']['parts'][0]['text'] ?? '';
echo json_encode(['transcript' => trim((string) $transcript)]);
