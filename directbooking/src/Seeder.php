<?php
declare(strict_types=1);

final class Seeder
{
    private const CONTENT = ['hosts', 'places', 'listings', 'products', 'venues', 'points', 'event_series', 'occurrences'];

    public static function run(App $app, bool $wipe = false): void
    {
        $seed = $app->config['seed'] ?? [];
        $content = (require dirname(__DIR__) . '/seed/content.php')($seed['hosts'] ?? []);
        $app->tx(function () use ($app, $content, $seed, $wipe) {
            if ($wipe) foreach (self::CONTENT as $t) $app->exec("DELETE FROM $t");
            foreach (self::CONTENT as $t) foreach ($content[$t] ?? [] as $row) $app->insert($t, $row);
            $op = $seed['operator'] ?? null;
            if ($op && !empty($op['email'])) {
                $app->exec('DELETE FROM admins WHERE email = ?', [$op['email']]);
                $app->insert('admins', ['email' => $op['email'], 'name' => $op['name'] ?? 'Operator', 'host_id' => null]);
            }
            foreach ($seed['hosts'] ?? [] as $id => $h) {
                if (empty($h['email']) || str_ends_with($h['email'], '@example.com')) continue;
                $app->exec('DELETE FROM admins WHERE email = ?', [$h['email']]);
                $app->insert('admins', ['email' => $h['email'], 'name' => $h['name'] ?? $id, 'host_id' => $id]);
            }
        });
    }
}
