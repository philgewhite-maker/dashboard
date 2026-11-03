<?php
declare(strict_types=1);

// One entry point for web (public/index.php), cron and CLI scripts.
// Classes live one per file in src/, no namespace, no Composer: Krystal
// runs this as-is with nothing to install.

spl_autoload_register(function (string $class): void {
    $file = __DIR__ . '/' . $class . '.php';
    if (is_file($file)) require $file;
});

date_default_timezone_set('Europe/London');

/**
 * Loads config/config.php (or the path in DIRECTBOOKING_CONFIG) once.
 * Tests pass their own array to App::boot() instead.
 */
function directbooking_config(): array
{
    $path = getenv('DIRECTBOOKING_CONFIG') ?: dirname(__DIR__) . '/config/config.php';
    if (!is_file($path)) {
        throw new RuntimeException("Missing config: copy config/config.example.php to $path and fill it in.");
    }
    $cfg = require $path;
    if (!is_array($cfg)) throw new RuntimeException("$path must return an array.");
    return $cfg;
}
