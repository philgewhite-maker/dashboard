<?php
declare(strict_types=1);
// php bin/cron.php [all|expire|instalments|rates|fx|rollforward|routes]
require dirname(__DIR__) . '/src/bootstrap.php';
echo json_encode((new Cron(App::get()))->run($argv[1] ?? 'all'), JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), "\n";
