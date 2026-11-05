<?php
// Reusable page pieces. Offer-specific wording is built from the offer's structured fields,
// with the offer's own wording kept alongside it, so the page never says more than the data does.

function callout(string $kind, string $html): string {
    return '<aside class="callout callout-' . h($kind) . '">' . $html . '</aside>';
}

function chip(string $text, string $class = ''): string {
    return '<span class="chip ' . h($class) . '">' . h($text) . '</span>';
}

// ---- Requirements --------------------------------------------------------------
function req_sentence(array $r): string {
    $within = !empty($r['withinDays']) ? ' within ' . (int) $r['withinDays'] . ' days' : '';
    $months = (int) ($r['months'] ?? 0);
    $each = ($r['period'] ?? '') === 'each-month';
    switch ($r['type']) {
        case 'direct-debits':
            return 'Move <strong>' . (int) $r['count'] . '+ Direct Debits</strong> onto the new account' . $within . ' (a full switch carries them across).';
        case 'salary':
            $src = ($r['source'] ?? '') === 'employer' ? ' paid in by an employer (a transfer from your own accounts does not count)' : '';
            $when = $each ? ($months > 1 ? ' every month for ' . $months . ' months' : ($months === 1 ? ' in a month' : ' each month')) : '';
            $what = !empty($r['amount']) ? '<strong>' . gbp($r['amount']) . '+</strong> salary' : 'your <strong>salary</strong>';
            return 'Have ' . $what . $src . $when . $within . '.';
        case 'pay-in':
            $stay = !empty($r['mustStayDays']) ? ' The money has to stay ' . ($r['mustStayDays'] <= 1 ? 'at least 24 hours' : 'at least ' . round($r['mustStayDays']) . ' days') . '.' : '';
            $src = ($r['source'] ?? '') === 'employer' ? ' from an employer' : '';
            if ($each) return 'Pay in <strong>' . gbp($r['amount'] ?? 0) . '+</strong>' . $src . ' each month' . ($months > 1 ? ' for ' . $months . ' months' : '') . '.' . $stay;
            return 'Pay in <strong>' . gbp($r['amount'] ?? 0) . '+</strong>' . $src . $within . '.' . $stay;
        case 'debit-card-payments':
            $n = (int) ($r['count'] ?? 1);
            return 'Make <strong>' . $n . '+ debit card payment' . ($n === 1 ? '' : 's') . '</strong>' . ($each && $months > 1 ? ' in each of ' . $months . ' months' : $within) . '.';
        case 'card-spend':
            return 'Spend <strong>' . gbp($r['amount'] ?? 0) . '</strong> on the debit card' . $within . '.';
        case 'app-login':
            return 'Log in to the bank’s app' . $within . '.';
        default:
            return h($r['text'] ?? '');
    }
}

function requirements_html(array $offer): string {
    if (empty($offer['requirements'])) return '<p>The offer lists no further conditions beyond opening and switching.</p>';
    $li = '';
    foreach ($offer['requirements'] as $r) {
        $li .= '<li>' . req_sentence($r);
        if (!empty($r['text'])) $li .= '<details class="wording"><summary>The offer’s own wording</summary><p>' . h($r['text']) . '</p></details>';
        $li .= '</li>';
    }
    return '<ol class="steps">' . $li . '</ol>';
}

// ---- Payments -------------------------------------------------------------------
function payments_html(array $offer): string {
    $rows = '';
    foreach ($offer['payments'] as $p) {
        $count = (int) $p['count'];
        $paid = !empty($p['paidWithin']['value']) ? 'Paid within ' . (int) $p['paidWithin']['value'] . ' ' . h($p['paidWithin']['unit'] ?? 'days') . ' of the conditions being met' : 'Timing as set out in the terms';
        $every = !empty($p['intervalMonths']) && $count > 1 ? ', one every ' . ((int) $p['intervalMonths'] === 1 ? 'month' : (int) $p['intervalMonths'] . ' months') : '';
        $rows .= '<tr><td data-label="Payment"><strong>' . ($count > 1 ? $count . ' × ' : '') . gbp($p['amount']) . '</strong>' . (!empty($p['note']) ? ' <span class="muted">(' . h($p['note']) . ')</span>' : '') . '</td><td data-label="When">' . $paid . $every . '</td></tr>';
    }
    return '<table class="data"><thead><tr><th>Payment</th><th>When</th></tr></thead><tbody>' . $rows . '</tbody></table>';
}

// ---- Who can't get it -------------------------------------------------------------
function eligibility_items(array $o): array {
    $items = [];
    $e = $o['eligibility'] ?? [];
    $sw = $o['switch'] ?? [];
    if (!empty($e['heldAccount'])) {
        $h = $e['heldAccount'];
        $when = !empty($h['dateText']) ? $h['dateText'] : (!empty($h['since']) ? 'since ' . pretty_date($h['since']) : '');
        $items[] = 'Not open to people who held a <strong>' . h($h['scope'] ?? $o['bank']) . '</strong> current account ' . h($when) . '.';
    }
    if (!empty($e['bonusReceived'])) {
        $b = $e['bonusReceived'];
        $when = !empty($b['ever']) ? 'before' : (!empty($b['since']) ? 'since ' . pretty_date($b['since']) : '');
        $items[] = 'Not open to anyone who has received a <strong>' . h($b['scope'] ?? $o['bank']) . '</strong> switch bonus ' . h($when) . '.';
    }
    if (!empty($e['income']) && is_array($e['income'])) {
        $i = $e['income'];
        if (!empty($i['minAnnual'])) $items[] = 'Income test: <strong>' . gbp($i['minAnnual']) . '+ a year</strong>' . (($i['basis'] ?? '') === 'gross' ? ' (before tax)' : '') . (!empty($i['altRoute']) ? ', or ' . h($i['altRoute']) : '') . '.';
        elseif (!empty($i['altRoute'])) $items[] = 'Income test: ' . h($i['altRoute']) . '.';
    }
    if (!empty($sw['notFromGroups'])) $items[] = 'You must switch <strong>from a different banking group</strong>: not from ' . h(join_and($sw['notFromGroups'])) . '.';
    if (!empty($sw['startBy'])) $items[] = 'The switch has to be started by <strong>' . pretty_date($sw['startBy']) . '</strong>.';
    if (!empty($sw['withinDaysOfOpening'])) $items[] = 'Start the switch within <strong>' . (int) $sw['withinDaysOfOpening'] . ' days</strong> of opening the account.';
    if (empty($o['jointAllowed'])) $items[] = 'Single (sole) accounts only; the offer is not available on joint accounts.';
    return $items;
}

// ---- The offers table -------------------------------------------------------------
function needs_chips(array $o): string {
    $c = '';
    if ($o['needsSalary']) $c .= chip($o['salaryMax'] ? 'Salary: ' . gbp($o['salaryMax']) . '+' : 'Salary paid in', 'chip-warn');
    if ($o['needsPayIn']) $c .= chip('Pay in ' . gbp($o['payInMax']) . '+', 'chip-info');
    if ($o['ddNeeded']) $c .= chip($o['ddNeeded'] . ' Direct Debits');
    if (!$o['needsSalary'] && !$o['needsPayIn']) $c .= chip('No salary needed', 'chip-good');
    return $c;
}

function offers_table(array $offers, bool $withBank = true): string {
    $rows = '';
    foreach ($offers as $o) {
        $fee = $o['monthlyFee'] ? gbp($o['monthlyFee']) . ' a month' : 'Free';
        $rows .= '<tr>'
            . '<td data-label="Account"><a class="strong" href="' . h(url('/bank-switch-offers/' . $o['slug'] . '/')) . '">' . h($o['product']) . '</a>' . ($withBank ? '<div class="muted">' . h($o['bank']) . '</div>' : '') . '</td>'
            . '<td data-label="Bonus" class="num"><span class="bonus">' . gbp($o['total']) . '</span></td>'
            . '<td data-label="What it asks for">' . needs_chips($o) . '</td>'
            . '<td data-label="Fee">' . h($fee) . '</td>'
            . '<td data-label="Start by">' . ($o['deadline'] ? h(pretty_date($o['deadline'])) : '<span class="muted">No date set</span>') . '</td>'
            . '</tr>';
    }
    return '<div class="table-wrap"><table class="data offers"><thead><tr><th>Account</th><th class="num">Bonus</th><th>What it asks for</th><th>Fee</th><th>Start by</th></tr></thead><tbody>' . $rows . '</tbody></table></div>';
}

// ---- Calls to action and disclosure ---------------------------------------------------
function bank_link(array $o): array {
    global $CFG;
    $aff = $CFG['affiliate'][$o['bankSlug']] ?? null;
    if ($aff && !empty($aff['url'])) return ['url' => $aff['url'], 'sponsored' => true, 'network' => $aff['network'] ?? ''];
    $site = $CFG['bankSites'][$o['bankSlug']] ?? '';
    return ['url' => $site, 'sponsored' => false, 'network' => ''];
}

function disclosure_note(): string {
    return '<p class="fine">' . a('/how-we-make-money/', 'How we make money') . ': some links on this site are affiliate links, and we may be paid if you open an account or use a cashback site through them. It never changes what a provider pays you, and it does not decide what we show.</p>';
}

function cta_box(array $o): string {
    $l = bank_link($o);
    if ($l['url'] === '') return '';
    return '<div class="cta"><div><strong>' . h($o['product']) . '</strong><div class="muted">You will go to ' . h(possessive($o['bank'])) . ' website. Read its terms before you apply.</div></div>'
        . '<a class="btn" href="' . h($l['url']) . '" target="_blank" rel="' . ($l['sponsored'] ? 'sponsored nofollow noopener' : 'noopener') . '">Visit ' . h($o['bank']) . ($l['sponsored'] ? ' <span class="ad">Ad</span>' : '') . '</a></div>'
        . ($l['sponsored'] ? disclosure_note() : '');
}

// ---- FAQ -------------------------------------------------------------------------------
function faq_html(array $items): string {
    $out = '<section class="faq"><h2>Common questions</h2>';
    foreach ($items as [$q, $ans]) $out .= '<details><summary>' . h($q) . '</summary><div>' . $ans . '</div></details>';
    return $out . '</section>';
}

function faq_jsonld(array $items): array {
    return ['@context' => 'https://schema.org', '@type' => 'FAQPage', 'mainEntity' => array_map(fn($it) => [
        '@type' => 'Question', 'name' => $it[0],
        'acceptedAnswer' => ['@type' => 'Answer', 'text' => trim(preg_replace('/\s+/', ' ', strip_tags($it[1])))],
    ], $items)];
}

function sources_html(array $links): string {
    $li = '';
    foreach ($links as [$label, $href]) $li .= '<li>' . ext($href, h($label)) . '</li>';
    return '<section class="sources"><h2>Sources</h2><ul>' . $li . '</ul></section>';
}

function updated_line(array $stats): string {
    return $stats['asOf'] ? '<p class="updated">Offer data last checked <time datetime="' . h($stats['asOf']) . '">' . h(pretty_date($stats['asOf'])) . '</time>.</p>' : '';
}
