<?php
declare(strict_types=1);

/**
 * Machine-proposed changes wait in `approvals` until someone says yes.
 * Each kind knows how to apply its payload:
 *   occurrence.create - a new occurrence (e.g. next year's Wimbledon), created as draft
 *   route.upsert      - a TfL route; replaces the same point/direction/context
 *   record.update     - field changes to any content row
 */
final class Approvals
{
    public function __construct(private App $app) {}

    public function propose(string $kind, string $entity, ?string $entityId, string $summary, array $payload): string
    {
        $pending = $this->app->one("SELECT id FROM approvals WHERE status = 'pending' AND kind = ? AND summary = ?", [$kind, $summary]);
        if ($pending) return $pending['id'];  // don't stack duplicates on repeat runs
        $id = Util::id('apr_');
        $this->app->insert('approvals', ['id' => $id, 'kind' => $kind, 'entity' => $entity, 'entity_id' => $entityId, 'summary' => $summary,
            'payload' => Util::enc($payload), 'status' => 'pending', 'created_at' => Util::now()]);
        return $id;
    }

    public function apply(array $a): void
    {
        $p = Util::json($a['payload']);
        match ($a['kind']) {
            'occurrence.create' => $this->app->insert('occurrences', $p + ['id' => $a['entity_id'] ?? Util::id('occ_'), 'status' => 'draft']),
            'route.upsert' => $this->upsertRoute($p),
            'record.update' => $this->app->update($a['entity'], (string)$a['entity_id'], $p),
            default => throw new RuntimeException("Unknown approval kind {$a['kind']}"),
        };
        $this->app->log($a['entity'], $a['entity_id'], "Applied approval: {$a['summary']}");
    }

    private function upsertRoute(array $r): void
    {
        $this->app->exec('DELETE FROM routes WHERE property_id = ? AND point_id = ? AND direction = ? AND context = ?', [$r['property_id'], $r['point_id'], $r['direction'], $r['context']]);
        $r['legs'] = is_string($r['legs']) ? $r['legs'] : Util::enc($r['legs']);
        $this->app->insert('routes', $r + ['id' => Util::id('rt_'), 'status' => 'published']);
    }
}
