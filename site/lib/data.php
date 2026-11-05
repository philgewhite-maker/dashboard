<?php
// Turns the extracted structured data into what the templates need: every offer with its
// derived facts (total bonus, what it asks for), plus site-wide statistics. Nothing here is
// written by hand; when the weekly extraction changes, so does everything that is built from it.

function load_data(string $file): array {
    $raw = json_decode((string) file_get_contents($file), true);
    if (!is_array($raw) || empty($raw['offers'])) throw new RuntimeException("No offers in $file");
    return $raw;
}

// Which banking group an offer's bank belongs to ("Lloyds, Halifax, Bank of Scotland"), from the data.
function bank_group_of(string $bank, array $groups): array {
    foreach ($groups as $g) {
        foreach ($g as $name) if (strcasecmp($name, $bank) === 0) return $g;
    }
    return [$bank];
}

function normalise_offers(array $data): array {
    $out = [];
    foreach ($data['offers'] as $o) {
        if ((int) ($o['schema'] ?? 1) < 2 || empty($o['payments'])) continue;
        $total = 0.0;
        foreach ($o['payments'] as $p) $total += $p['amount'] * $p['count'];
        $types = [];
        foreach ($o['requirements'] as $r) $types[$r['type']] = true;
        $dd = 0;
        foreach ($o['requirements'] as $r) if ($r['type'] === 'direct-debits') $dd = max($dd, (int) ($r['count'] ?? 0));
        $dd = max($dd, (int) ($o['switch']['minDirectDebits'] ?? 0));
        $salary = 0.0;
        $payIn = 0.0;
        foreach ($o['requirements'] as $r) {
            if ($r['type'] === 'salary') $salary = max($salary, (float) ($r['amount'] ?? 0));
            if ($r['type'] === 'pay-in') $payIn = max($payIn, (float) ($r['amount'] ?? 0));
        }
        $o['slug'] = $o['id'] ?? slugify($o['bank'] . ' ' . $o['product']);
        $o['bankSlug'] = slugify($o['bank']);
        $o['total'] = $total;
        $o['needsSalary'] = isset($types['salary']);
        $o['needsPayIn'] = isset($types['pay-in']);
        $o['ddNeeded'] = $dd;
        $o['salaryMax'] = $salary;
        $o['payInMax'] = $payIn;
        $o['deadline'] = $o['switch']['startBy'] ?? ($o['switch']['completeBy'] ?? null);
        $o['monthlyFee'] = $o['fees']['monthly'] ?? null;
        $o['group'] = bank_group_of((string) $o['bank'], $data['bankGroups'] ?? []);
        $out[] = $o;
    }
    usort($out, fn($a, $b) => $b['total'] <=> $a['total']);
    return $out;
}

function compute_stats(array $offers, array $data): array {
    $dds = array_values(array_filter(array_column($offers, 'ddNeeded')));
    $payIns = array_values(array_filter(array_column($offers, 'payInMax')));
    return [
        'count' => count($offers),
        'maxBonus' => $offers ? max(array_column($offers, 'total')) : 0,
        'minBonus' => $offers ? min(array_column($offers, 'total')) : 0,
        'needSalary' => count(array_filter($offers, fn($o) => $o['needsSalary'])),
        'needPayIn' => count(array_filter($offers, fn($o) => $o['needsPayIn'])),
        'needDD' => count($dds),
        'ddMin' => $dds ? min($dds) : 0,
        'ddMax' => $dds ? max($dds) : 0,
        'payInMin' => $payIns ? min($payIns) : 0,
        'payInMax' => $payIns ? max($payIns) : 0,
        'noSalaryCount' => count(array_filter($offers, fn($o) => !$o['needsSalary'])),
        'cassCount' => count($data['cassParticipants'] ?? []),
        'asOf' => $data['scrapedAt'] ?? null,
        'banks' => count(array_unique(array_column($offers, 'bank'))),
    ];
}

// Cashback-site deals lined up bank by bank: one row per account, a column per site.
function cashback_rows(array $data): array {
    $rows = [];
    foreach (($data['cashbackDeals'] ?? []) as $d) {
        $key = strtolower(trim(preg_replace('/\s+/', ' ', str_replace(['®', '™'], '', $d['name']))));
        $rows[$key]['name'] = $rows[$key]['name'] ?? trim(preg_replace('/\s+/', ' ', str_replace(['®', '™'], '', $d['name'])));
        $rows[$key][$d['provider']] = (float) $d['amount'];
    }
    uasort($rows, fn($a, $b) => max($b['topcashback'] ?? 0, $b['quidco'] ?? 0) <=> max($a['topcashback'] ?? 0, $a['quidco'] ?? 0));
    return array_values($rows);
}
