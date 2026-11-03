<?php
declare(strict_types=1);
/**
 * php bin/setup.php            -- creates the database and seeds Day 1 content (once)
 * php bin/setup.php --reseed   -- wipes CONTENT tables and reseeds (bookings are kept)
 * Prints the cron URL key at the end.
 */
require dirname(__DIR__) . '/src/bootstrap.php';

$app = App::get();
$app->migrate();
echo "Database ready.\n";

$reseed = in_array('--reseed', $argv, true);
$has = $app->one('SELECT COUNT(*) AS n FROM listings')['n'] > 0;
if ($has && !$reseed) {
    echo "Content already there; use --reseed to replace it.\n";
} else {
    Seeder::run($app, $reseed);
    echo "Seeded Day 1 content (rooms, venues, four test events).\n";
}

try {
    echo 'Exchange rates: ' . (new Fx($app))->refresh() . " currencies.\n";
} catch (Throwable $e) {
    echo 'Exchange rates not fetched (' . $e->getMessage() . "); the cron job will retry.\n";
}

$key = Util::sign('cron', $app->config['site']['secret']);
echo "\nCron URL (every 15 min in cPanel > Cron Jobs):\n  wget -q -O /dev/null \"{$app->config['site']['base_url']}/cron?key=$key\"\n";
echo "Route proposals from TfL (run once now, then approve in /admin):\n  {$app->config['site']['base_url']}/cron?key=$key&task=routes\n";
