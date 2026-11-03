<?php
declare(strict_types=1);
// php bin/publish.php  -- same as the admin's Publish button.
require dirname(__DIR__) . '/src/bootstrap.php';
$r = (new Publisher(App::get()))->publish();
if (!$r['ok']) {
    fwrite(STDERR, "Not published. Fix first:\n - " . implode("\n - ", $r['problems']) . "\n");
    exit(1);
}
echo 'Published ' . count($r['pages']) . " files:\n  " . implode("\n  ", $r['pages']) . "\n";
