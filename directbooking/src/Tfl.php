<?php
declare(strict_types=1);

/**
 * TfL Unified API journey planner -> route proposals. Real journey times
 * and fares, never typed from memory. Each result is proposed for
 * approval; nothing is published until someone says yes.
 */
final class Tfl
{
    private const API = 'https://api.tfl.gov.uk';
    private const MODES = 'tube,dlr,overground,elizabeth-line,national-rail,walking,bus,river-bus,tram';

    public function __construct(private App $app) {}

    /** Best (fastest) journey, simplified. Times are HHMM, date Ymd. */
    public function journey(string $from, string $to, string $date, string $time, bool $walkOnly = false): ?array
    {
        $qs = ['date' => $date, 'time' => $time, 'timeIs' => 'Departing', 'mode' => $walkOnly ? 'walking' : self::MODES, 'journeyPreference' => 'leasttime'];
        if ($key = $this->app->config['tfl']['app_key']) $qs['app_key'] = $key;
        [$code, $body] = Util::http('GET', self::API . '/Journey/JourneyResults/' . rawurlencode($from) . '/to/' . rawurlencode($to) . '?' . http_build_query($qs), [], null, 30);
        if ($code !== 200) throw new RuntimeException("TfL journey $from -> $to: HTTP $code " . substr($body, 0, 200));
        return self::simplify(Util::json($body));
    }

    public static function simplify(array $res): ?array
    {
        $journeys = $res['journeys'] ?? [];
        if (!$journeys) return null;
        usort($journeys, fn($a, $b) => ($a['duration'] ?? 999) <=> ($b['duration'] ?? 999));
        $j = $journeys[0];
        $legs = [];
        $modes = [];
        foreach ($j['legs'] ?? [] as $leg) {
            $mode = $leg['mode']['name'] ?? 'walking';
            $line = $leg['routeOptions'][0]['name'] ?? '';
            $text = trim((string)($leg['instruction']['summary'] ?? ''));
            $legs[] = ['mode' => $mode, 'minutes' => (int)($leg['duration'] ?? 0), 'text' => $text ?: ucfirst($mode)];
            $label = $mode === 'walking' ? 'walk' : ($line && !in_array($mode, ['bus'], true) ? (in_array($mode, ['tube', 'dlr', 'overground', 'elizabeth-line'], true) ? "$line line" : $line) : $mode);
            if ($mode === 'bus' && $line) $label = "bus $line";
            if (!$modes || end($modes) !== $label) $modes[] = $label;
        }
        $summary = ucfirst(implode(', then ', array_map(fn($m) => str_replace(['line line', 'Elizabeth line line'], ['line', 'Elizabeth line'], $m), $modes)));
        return [
            'minutes' => (int)$j['duration'],
            'fare_pence' => isset($j['fare']['totalCost']) ? (int)$j['fare']['totalCost'] : null,
            'legs' => $legs,
            'summary' => $summary,
        ];
    }

    /**
     * Public pages must never show the flat's postcode, and TfL's own
     * names for the end points are raw addresses ("28 ENTERTAINMENT
     * AVENUE"). The final walk is relabelled with the point's own name, and
     * any mention of the origin becomes "the flat".
     */
    public static function sanitize(array $legs, string $origin, string $endName): array
    {
        $variants = array_unique([$origin, preg_replace('/^(\S+?)(\d[A-Z]{2})$/i', '$1 $2', $origin)]);
        foreach ($legs as $i => &$leg) {
            $leg['text'] = str_ireplace($variants, 'the flat', $leg['text']);
            if ($i === count($legs) - 1 && $leg['mode'] === 'walking') $leg['text'] = "Walk to $endName";
        }
        return $legs;
    }

    /**
     * Proposes routes from each property to every point of published-or-draft
     * events. Plans per point come from point data `route_plans`, defaulting
     * to a midday trip there and a 23:00 trip back.
     */
    public function proposeAll(): array
    {
        $done = [];
        $approvals = new Approvals($this->app);
        $sat = date('Ymd', strtotime('next saturday'));
        foreach ($this->app->all("SELECT * FROM places WHERE kind = 'property'") as $prop) {
            $origin = (new Content($this->app))->placeData($prop['id'])['tfl_origin'] ?? null;
            if (!$origin) continue;
            foreach ($this->app->all("SELECT * FROM points WHERE tfl_ref IS NOT NULL AND tfl_ref != ''") as $pt) {
                $plans = Util::json($pt['data'])['route_plans'] ?? [['context' => 'normal', 'direction' => 'to', 'time' => '1200'], ['context' => 'late_night', 'direction' => 'from', 'time' => '2300']];
                foreach ($plans as $plan) {
                    [$a, $b] = $plan['direction'] === 'to' ? [$origin, $pt['tfl_ref']] : [$pt['tfl_ref'], $origin];
                    try {
                        $r = $this->journey($a, $b, $plan['date'] ?? $sat, $plan['time']);
                    } catch (RuntimeException $e) {
                        $done[] = "{$pt['name']} ({$plan['context']}): " . $e->getMessage();
                        continue;
                    }
                    if (!$r) { $done[] = "{$pt['name']} ({$plan['context']}): no journey found"; continue; }
                    $r['legs'] = self::sanitize($r['legs'], $origin, $plan['direction'] === 'to' ? $pt['name'] : 'the flat');
                    $label = $plan['direction'] === 'to' ? "Flat to {$pt['name']}" : "{$pt['name']} back to the flat";
                    $approvals->propose('route.upsert', 'routes', null, "Route: $label ({$plan['context']}, {$r['minutes']} min)", [
                        'property_id' => $prop['id'], 'point_id' => $pt['id'], 'direction' => $plan['direction'], 'context' => $plan['context'],
                        'summary' => $r['summary'], 'minutes' => $r['minutes'], 'fare_pence' => $r['fare_pence'], 'legs' => $r['legs'],
                        'source' => 'TfL journey planner, ' . date('j M Y', strtotime($plan['date'] ?? $sat)) . ' ' . substr($plan['time'], 0, 2) . ':' . substr($plan['time'], 2),
                        'verified_at' => date('Y-m-d'),
                    ]);
                    $done[] = "$label ({$plan['context']}): {$r['minutes']} min, {$r['summary']}";
                }
            }
        }
        return $done;
    }
}
