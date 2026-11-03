<?php
declare(strict_types=1);

/**
 * Proposes tasks into Phil's personal dashboard (its agent inbox, via
 * agent-write.php), each linking straight to the admin page where it gets
 * done. Tasks are queued in `inbox_outbox`, keyed so the same thing is never
 * proposed twice, and sent as one batch per flush: right away for urgent
 * ones (a request to answer), otherwise by the cron job.
 *
 * Limits of the inbox itself: it only accepts new proposals, which Phil
 * accepts in the dashboard. Nothing here can update or close a task later,
 * so each task's link shows the live state, and a task already handled in
 * the admin is simply ticked off. Off unless dashboard.inbox_url is set.
 */
final class DashboardInbox
{
    public const PROJECT_KEY = 'direct-booking';
    private const MAX_ITEMS = 18; // agent-write.php takes 20 nodes; 2 go on the project and group

    public function __construct(private App $app) {}

    public function enabled(): bool
    {
        return ($this->app->config['dashboard']['inbox_url'] ?? '') !== '';
    }

    /**
     * Queues a task once per $key. $link is a site path ("/admin/booking?id=...").
     * $due is Y-m-d or null.
     */
    public function propose(string $key, string $title, string $link, string $notes = '', ?string $due = null, bool $urgent = false): void
    {
        if (!$this->enabled()) return;
        if ($this->app->one('SELECT 1 FROM inbox_outbox WHERE key = ?', [$key])) return;
        $this->app->insert('inbox_outbox', [
            'key' => $key, 'created_at' => Util::now(),
            'payload' => Util::enc(['title' => mb_substr($title, 0, 200), 'notes' => $notes, 'due' => $due ?? '',
                'link' => rtrim($this->app->config['site']['base_url'], '/') . $link]),
        ]);
        if ($urgent) {
            try { $this->flush(); } catch (Throwable $e) { $this->app->log('inbox', $key, 'Will retry: ' . $e->getMessage()); }
        }
    }

    /** Sends everything queued as one batch. Returns the batch id, or a reason nothing was sent. */
    public function flush(): string
    {
        if (!$this->enabled()) return 'off';
        $rows = $this->app->all('SELECT * FROM inbox_outbox WHERE sent_at IS NULL ORDER BY created_at LIMIT ' . self::MAX_ITEMS);
        if (!$rows) return 'nothing queued';
        $nodes = [
            ['tempId' => 'root', 'title' => 'Direct booking site'],
            ['tempId' => 'ops', 'parentTempId' => 'root', 'title' => 'Bookings and site', 'groupKey' => 'operations'],
        ];
        foreach ($rows as $i => $r) $nodes[] = ['tempId' => "t$i", 'parentTempId' => 'ops'] + Util::json($r['payload']);
        $label = count($rows) === 1 ? Util::json($rows[0]['payload'])['title'] : count($rows) . ' booking-site tasks';

        $id = null;
        for ($attempt = 0; $attempt < 2 && !$id; $attempt++) {
            $rev = $this->call('GET', '?fields=agentInbox')['rev'] ?? null;
            if ($rev === null) throw new RuntimeException('Dashboard inbox gave no rev.');
            try {
                $res = $this->call('POST', '', ['rev' => $rev, 'action' => 'append', 'field' => 'agentInbox',
                    'value' => ['label' => $label, 'projectKey' => self::PROJECT_KEY, 'projectLabel' => 'Direct booking site', 'nodes' => $nodes]]);
                $id = $res['id'] ?? null;
            } catch (RuntimeException $e) {
                if ($attempt === 1 || !str_contains($e->getMessage(), 'HTTP 409')) throw $e; // someone else wrote in between: re-read rev once
            }
        }
        foreach ($rows as $r) $this->app->update('inbox_outbox', $r['key'], ['sent_at' => Util::now(), 'batch_id' => $id], 'key');
        $this->app->log('inbox', $id, 'Sent ' . count($rows) . ' task(s) to the dashboard');
        return (string)$id;
    }

    private function call(string $method, string $query, ?array $body = null): array
    {
        $cfg = $this->app->config['dashboard'];
        $headers = ['Accept: application/json'];
        if (!empty($cfg['secret'])) $headers[] = 'X-Agent-Secret: ' . $cfg['secret'];
        if ($body !== null) $headers[] = 'Content-Type: application/json';
        [$code, $res] = Util::http($method, $cfg['inbox_url'] . $query, $headers, $body !== null ? Util::enc($body) : null);
        if ($code >= 300) throw new RuntimeException("Dashboard inbox HTTP $code: " . substr($res, 0, 200));
        return Util::json($res);
    }
}
