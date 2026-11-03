<?php
declare(strict_types=1);

// Everything that isn't a published file lands here (see .htaccess).
// Under `php -S` (local dev), real files are served directly.
if (PHP_SAPI === 'cli-server') {
    $file = rtrim($_SERVER['DOCUMENT_ROOT'] ?: __DIR__, '/') . parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
    if (is_file($file)) return false;
    if (is_file(rtrim($file, '/') . '/index.html')) { readfile(rtrim($file, '/') . '/index.html'); return true; }
}

require dirname(__DIR__) . '/src/bootstrap.php';

$path = rtrim(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?: '/', '/') ?: '/';
(new Web(App::get()))->handle($_SERVER['REQUEST_METHOD'], $path === '/admin' ? '/admin' : $path);
