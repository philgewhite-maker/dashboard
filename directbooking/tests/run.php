<?php
declare(strict_types=1);
// php tests/run.php  -- self-contained: temp SQLite, fake Stripe, local calendar.

require dirname(__DIR__) . '/src/bootstrap.php';

$fails = 0;
$count = 0;
function ok(bool $cond, string $what): void
{
    global $fails, $count;
    $count++;
    if (!$cond) { $fails++; echo "FAIL: $what\n"; }
}
function eq(mixed $a, mixed $b, string $what): void
{
    ok($a === $b, $what . ($a === $b ? '' : ' (got ' . var_export($a, true) . ', want ' . var_export($b, true) . ')'));
}

$tmp = sys_get_temp_dir() . '/directbooking-test-' . bin2hex(random_bytes(4));
mkdir("$tmp/public", 0777, true);
mkdir("$tmp/data", 0777, true);
$app = App::boot([
    'site' => ['base_url' => 'https://example.test', 'secret' => 'test-secret', 'operator_email' => 'op@example.test', 'name' => 'Test Rooms'],
    'db' => ['dsn' => "sqlite:$tmp/data/t.sqlite"],
    'paths' => ['public' => "$tmp/public", 'data' => "$tmp/data"],
    'seed' => ['operator' => ['name' => 'Op', 'email' => 'op@example.test'], 'hosts' => ['lewis' => ['name' => 'Lewis', 'email' => 'lewis@example.test'], 'zara' => ['name' => 'Zara', 'email' => 'zara@example.test']]],
    'rates' => ['source' => 'local'],
    'payments' => ['gateway' => 'fake'],
]);
$app->migrate();
Seeder::run($app);
foreach (['USD' => 1.27, 'EUR' => 1.18, 'JPY' => 190.0] as $c => $r) $app->insert('fx_rates', ['currency' => $c, 'per_gbp' => $r, 'updated_at' => Util::now()]);
$gw = $app->gateway();
$content = new Content($app);
$pricing = new Pricing($app);
$bk = new Bookings($app);
$d = fn(int $days) => Util::addDays(date('Y-m-d'), $days);

// ---- content inheritance ---------------------------------------------------
$l = $content->listing('room-1');
ok(isset($l['content']['walk_times']), 'listing inherits property walk times');
ok(isset($l['content']['area_intro']), 'listing inherits area text');
ok(isset($l['content']['building_features']), 'listing inherits building features');
eq($l['host']['id'], 'lewis', 'room 1 hosted by Lewis');
$s = $content->series('christmas-lights');
eq(count($s['points']), 2, 'theme with no venue uses its own points');
$s = $content->series('concerts-at-the-o2');
eq($s['points'][0]['id'], 'pt-o2', 'venue series uses venue points');

// ---- pricing -----------------------------------------------------------------
$q = $pricing->quote('ensuite-king-room', $d(30), $d(33), 2);
ok($q['ok'], 'simple quote ok: ' . implode(' ', $q['errors']));
eq($q['total_minor'], 33000, '3 nights at £125 less 12% = £330');
eq($q['policy'], 'moderate', 'default policy moderate');

$q = $pricing->quote('both-rooms', $d(30), $d(32), 4);
eq($q['total_minor'], 20900 + 16720, 'both rooms: 2 nights, 12% then 5% multi-room');
eq(count($q['parts']), 2, 'both rooms has a part per owner');

$q = $pricing->quote('ensuite-king-room', $d(30), $d(33), 2, 'USD');
eq($q['total_minor'], 41910, 'USD at locked rate');
$q = $pricing->quote('ensuite-king-room', $d(30), $d(33), 2, 'JPY');
eq($q['total_minor'], 62700, 'JPY has no minor unit');
ok(!in_array('alipay', $q['methods'], true), 'Alipay not offered in JPY');
$q = $pricing->quote('ensuite-king-room', $d(30), $d(33), 2, 'KRW');
ok(!$q['ok'], 'KRW refused without a Korean wallet');

$q = $pricing->quote('ensuite-king-room', $d(30), $d(33), 3);
ok(!$q['ok'], 'too many guests refused');
$q = $pricing->quote('ensuite-king-room', $d(-3), $d(1), 2);
ok(!$q['ok'], 'past arrival refused');

$q = $pricing->quote('double-room', $d(40), $d(100), 1);
eq($q['policy'], 'long_term', '60 nights is a long stay');
ok(count($q['schedule']) >= 2, 'long stay split into monthly instalments');
eq(array_sum(array_column($q['schedule'], 'amount_minor')), $q['total_minor'], 'instalments add up to the total');
eq($q['schedule'][0]['due'], null, 'first instalment due on acceptance');

// Event rules: publish Wimbledon 2027 (3-night minimum, Firm).
$app->update('occurrences', 'wimbledon-2027', ['status' => 'published']);
$q = $pricing->quote('ensuite-king-room', '2027-06-30', '2027-07-02', 2);
ok(!$q['ok'] && str_contains(implode(' ', $q['errors']), 'minimum stay of 3'), 'event minimum nights enforced');
$q = $pricing->quote('ensuite-king-room', '2027-06-30', '2027-07-03', 2);
ok($q['ok'], 'event stay meeting the minimum is fine');
eq($q['policy'], 'firm', 'event dates take the stricter policy');
$app->update('occurrences', 'wimbledon-2027', ['status' => 'draft']);

// ---- cancellation ----------------------------------------------------------
$booked = '2026-01-01 10:00:00';
eq(Cancellation::refund('moderate', 30000, 3, $booked, '2026-02-01 12:00:00', '2026-02-10'), 30000, 'moderate: 9 days out, full refund');
eq(Cancellation::refund('moderate', 30000, 3, $booked, '2026-02-08 12:00:00', '2026-02-10'), 15000, 'moderate: 2 days out, half');
eq(Cancellation::refund('firm', 30000, 3, $booked, '2026-01-31 12:00:00', '2026-02-10'), 15000, 'firm: 10 days out, half');
eq(Cancellation::refund('firm', 30000, 3, $booked, '2026-02-05 12:00:00', '2026-02-10'), 0, 'firm: 5 days out, nothing');
eq(Cancellation::refund('strict', 30000, 3, $booked, '2026-01-02 09:00:00', '2026-02-10'), 30000, 'strict: within 48h and 14+ days out');
eq(Cancellation::refund('long_term', 60000, 60, $booked, '2026-01-20 12:00:00', '2026-02-10'), 30000, 'long term: first 30 of 60 nights kept');
eq(Cancellation::refund('flexible', 30000, 3, $booked, '2026-02-09 18:00:00', '2026-02-10'), 20000, 'flexible: under a day, first night kept');

// ---- booking: card ---------------------------------------------------------
$guest = ['name' => 'Ada Guest', 'email' => 'ada@example.test', 'country' => 'US'];
$r = $bk->request(['product' => 'ensuite-king-room', 'arrival' => $d(20), 'departure' => $d(23), 'adults' => 2, 'currency' => 'GBP', 'method' => 'card', 'guest' => $guest]);
ok($r['ok'], 'card request accepted: ' . implode(' ', $r['errors'] ?? []));
ok(str_contains($r['next_url'], '/dev/checkout?session='), 'card request goes to checkout');
$b = $bk->byRef($r['ref']);
eq($b['status'], 'checkout', 'status checkout while authorising');

$r2 = $bk->request(['product' => 'both-rooms', 'arrival' => $d(21), 'departure' => $d(22), 'adults' => 3, 'currency' => 'GBP', 'method' => 'card', 'guest' => $guest]);
ok(!$r2['ok'], 'overlapping request refused while dates are held');

parse_str(parse_url($r['next_url'], PHP_URL_QUERY), $qs);
$gw->complete($qs['session']);
$next = $bk->returned($r['ref']);
$b = $bk->byRef($r['ref']);
eq($b['status'], 'requested', 'authorised card -> waiting for owner');
ok(str_contains($next, '/booking?ref='), 'guest lands on their booking page');
ok((bool)$app->one("SELECT 1 FROM mail_log WHERE to_addr = 'lewis@example.test' AND subject LIKE 'Approve or decline%'"), 'owner emailed to approve');
ok((bool)$app->one("SELECT 1 FROM mail_log WHERE to_addr = 'ada@example.test' AND subject LIKE 'Request received%'"), 'guest emailed receipt');

$msg = $bk->approve($b['id'], 'op@example.test');
$b = $bk->byRef($r['ref']);
eq($b['status'], 'confirmed', 'approve captures and confirms: ' . $msg);
eq($bk->payments($b['id'])[0]['status'], 'paid', 'payment marked paid');
ok(in_array('captured', $gw->get($qs['session'])['pi_log'], true), 'authorisation captured at the gateway');
ok((bool)$app->one("SELECT 1 FROM mail_log WHERE to_addr = 'lewis@example.test' AND body LIKE '%block these dates on Airbnb%'"), 'owner told to block Airbnb when calendar is not pushed');

$msg = $bk->cancel($b['id'], 'op@example.test', date('Y-m-d H:i:s'));
$b = $bk->byRef($r['ref']);
eq($b['status'], 'cancelled', 'cancel closes the booking');
eq((int)$bk->payments($b['id'])[0]['refunded_minor'], 33000, 'moderate, 20 days out: full refund');

// ---- booking: decline releases dates ----------------------------------------
$r = $bk->request(['product' => 'double-room', 'arrival' => $d(50), 'departure' => $d(52), 'adults' => 1, 'currency' => 'EUR', 'method' => 'card', 'guest' => $guest]);
parse_str(parse_url($r['next_url'], PHP_URL_QUERY), $qs);
$gw->complete($qs['session']);
$bk->returned($r['ref']);
$b = $bk->byRef($r['ref']);
$bk->decline($b['id'], 'zara@example.test', 'Away that week.');
eq($bk->byRef($r['ref'])['status'], 'declined', 'declined');
ok(in_array('cancelled', $gw->get($qs['session'])['pi_log'], true), 'authorisation voided on decline');
ok($pricing->quote('double-room', $d(50), $d(52), 1)['ok'], 'declined dates are free again');

// ---- booking: pay-later wallet ------------------------------------------------
$r = $bk->request(['product' => 'double-room', 'arrival' => $d(60), 'departure' => $d(63), 'adults' => 2, 'currency' => 'GBP', 'method' => 'alipay', 'guest' => $guest]);
ok($r['ok'], 'alipay request ok');
$b = $bk->byRef($r['ref']);
eq($b['status'], 'requested', 'wallet request waits for owner without payment');
$bk->approve($b['id'], 'op@example.test');
$b = $bk->byRef($r['ref']);
eq($b['status'], 'approved', 'approved, waiting for payment');
$pay = $bk->payments($b['id'])[0];
$url = $bk->payUrl($b, $pay);
ok($url !== null && str_contains($url, '/dev/checkout'), 'pay link created');
parse_str(parse_url($url, PHP_URL_QUERY), $qs);
eq($gw->get($qs['session'])['method'], 'alipay', 'checkout uses the chosen wallet');
$gw->complete($qs['session']);
$bk->syncPayment($app->one('SELECT * FROM payments WHERE id = ?', [$pay['id']]));
eq($bk->byRef($r['ref'])['status'], 'confirmed', 'paid wallet booking confirmed');

// ---- booking: manual bank transfer ------------------------------------------
$app->update('hosts', 'zara', ['payment_methods' => Util::enc(['card' => true, 'bank_transfer' => ['GBP' => "Zara Example\nSort code 00-00-00\nAccount 12345678"]])]);
$app->update('hosts', 'lewis', ['payment_methods' => Util::enc(['card' => true, 'bank_transfer' => ['GBP' => 'Lewis Example 00-00-00 87654321']])]);
$q = $pricing->quote('both-rooms', $d(70), $d(72), 2);
ok(in_array('bank_transfer', $q['methods'], true), 'bank transfer offered when both owners give GBP details');
ok(!in_array('alipay', $q['methods'], true), 'a method one owner lacks is not offered for both rooms');
$r = $bk->request(['product' => 'double-room', 'arrival' => $d(70), 'departure' => $d(72), 'adults' => 1, 'currency' => 'GBP', 'method' => 'bank_transfer', 'guest' => $guest]);
$b = $bk->byRef($r['ref']);
$bk->approve($b['id'], 'zara@example.test');
ok((bool)$app->one("SELECT 1 FROM mail_log WHERE to_addr = 'ada@example.test' AND body LIKE '%Sort code 00-00-00%'"), 'bank details emailed after approval');
$bk->markPaid($bk->payments($b['id'])[0]['id'], 'zara@example.test');
eq($bk->byRef($r['ref'])['status'], 'confirmed', 'manual payment marked received -> confirmed');

// ---- both rooms by card: two checkouts --------------------------------------
$r = $bk->request(['product' => 'both-rooms', 'arrival' => $d(80), 'departure' => $d(82), 'adults' => 4, 'currency' => 'GBP', 'method' => 'card', 'guest' => $guest]);
parse_str(parse_url($r['next_url'], PHP_URL_QUERY), $qs);
$gw->complete($qs['session']);
$next = $bk->returned($r['ref']);
ok(str_contains($next, '/dev/checkout'), 'second room gets its own checkout');
parse_str(parse_url($next, PHP_URL_QUERY), $qs2);
ok($gw->get($qs['session'])['account'] !== null && $qs['session'] !== $qs2['session'], 'two separate sessions');
$gw->complete($qs2['session']);
$bk->returned($r['ref']);
eq($bk->byRef($r['ref'])['status'], 'requested', 'both authorised -> requested');

// ---- expiry -------------------------------------------------------------------
$b = $bk->byRef($r['ref']);
$n = $bk->expireDue(date('Y-m-d H:i:s', strtotime('+2 days')));
ok($n >= 1, 'expiry ran');
eq($bk->byRef($r['ref'])['status'], 'expired', 'unanswered request expires');

// ---- long-stay instalments --------------------------------------------------------
$r = $bk->request(['product' => 'ensuite-king-room', 'arrival' => $d(100), 'departure' => $d(170), 'adults' => 1, 'currency' => 'GBP', 'method' => 'card', 'guest' => $guest]);
parse_str(parse_url($r['next_url'], PHP_URL_QUERY), $qs);
$gw->complete($qs['session']);
$bk->returned($r['ref']);
$b = $bk->byRef($r['ref']);
eq($gw->get($qs['session'])['p']['amount_minor'] < (int)$b['total_minor'], true, 'long stay authorises only the first month');
$bk->approve($b['id'], 'op@example.test');
$sent = $bk->sendDueInstalments($d(140));
ok($sent >= 1, 'due instalment link sent');
eq($bk->sendDueInstalments($d(140)), 0, 'not sent twice');

// ---- webhooks, ICS, TfL --------------------------------------------------------
$payload = '{"type":"checkout.session.completed"}';
$t = time();
$sig = "t=$t,v1=" . hash_hmac('sha256', "$t.$payload", 'whsec_x');
try { StripeGateway::verify($payload, $sig, 'whsec_x'); ok(true, 'good signature accepted'); } catch (Throwable $e) { ok(false, 'good signature accepted'); }
try { StripeGateway::verify($payload, $sig, 'whsec_y'); ok(false, 'bad signature refused'); } catch (Throwable $e) { ok(true, 'bad signature refused'); }
eq(StripeGateway::form(['a' => ['b' => [['c' => 1]]], 'd' => true]), 'a%5Bb%5D%5B0%5D%5Bc%5D=1&d=true', 'Stripe form encoding');

$ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20270101\r\nDTEND;VALUE=DATE:20270104\r\nSUMMARY:Reserved\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
eq(IcalRates::parse($ics), [['2027-01-01', '2027-01-04']], 'ICS blocked range parsed');

$legs = Tfl::sanitize([['mode' => 'walking', 'minutes' => 3, 'text' => 'Walk to SE1 4GT'], ['mode' => 'tube', 'minutes' => 6, 'text' => 'Jubilee line to North Greenwich'], ['mode' => 'walking', 'minutes' => 10, 'text' => 'Walk to 28 ENTERTAINMENT AVENUE']], 'SE14GT', 'The O2 entrance');
eq($legs[0]['text'], 'Walk to the flat', 'postcode removed from route text');
eq($legs[2]['text'], 'Walk to The O2 entrance', 'final walk named after the point');

// ---- roll-forward ---------------------------------------------------------------
$app->insert('occurrences', ['id' => 'wimb-old', 'series_id' => 'wimbledon', 'start_date' => $d(-400), 'end_date' => $d(-386), 'status' => 'published', 'data' => '{}']);
$app->update('occurrences', 'wimbledon-2027', ['end_date' => $d(-1), 'start_date' => $d(-14)]);
eq((new Cron($app))->rollForward(), 1, 'past yearly event proposes next year');
eq((new Cron($app))->rollForward(), 1, 'repeat run does not stack a duplicate');
eq((int)$app->one("SELECT COUNT(*) AS n FROM approvals WHERE kind = 'occurrence.create'")['n'], 1, 'one pending proposal');

// ---- dashboard inbox tasks ---------------------------------------------------
// A dead local port: queueing works, sending fails fast and is retried later.
$app->config['dashboard'] = ['inbox_url' => 'http://127.0.0.1:9/agent-write.php', 'secret' => 'x'];
$r = $bk->request(['product' => 'double-room', 'arrival' => $d(200), 'departure' => $d(202), 'adults' => 1, 'currency' => 'GBP', 'method' => 'bank_transfer', 'guest' => $guest]);
$b = $bk->byRef($r['ref']);
$row = $app->one('SELECT * FROM inbox_outbox WHERE key = ?', ["request:{$b['id']}"]);
ok($row !== null, 'new request queues a dashboard task');
ok(str_contains(Util::json($row['payload'])['link'], "/admin/booking?id={$b['id']}"), 'task links straight to the booking in the admin');
eq($row['sent_at'], null, 'unsent while the dashboard is unreachable (retried by cron)');
(new Approvals($app))->propose('route.upsert', 'routes', null, 'Route: test', ['x' => 1]);
eq((int)$app->one("SELECT COUNT(*) AS n FROM inbox_outbox WHERE key LIKE 'approval:%'")['n'], 0, 'single proposals do not each make a task');
$rv = new Reviews($app);
$rv->run();
ok((bool)$app->one("SELECT 1 FROM inbox_outbox WHERE key LIKE 'approvals:%'"), 'weekly task summarises waiting proposals');
ok((bool)$app->one("SELECT 1 FROM inbox_outbox WHERE key LIKE 'events:%'"), 'monthly task lists events with no confirmed date');
ok((bool)$app->one("SELECT 1 FROM inbox_outbox WHERE key LIKE 'pricing:%'"), 'quarterly pricing check queued');
ok((bool)$app->one("SELECT 1 FROM inbox_outbox WHERE key LIKE 'publish-blocked:%'"), 'blocked publishing becomes a task');
$before = (int)$app->one('SELECT COUNT(*) AS n FROM inbox_outbox')['n'];
$rv->run();
eq((int)$app->one('SELECT COUNT(*) AS n FROM inbox_outbox')['n'], $before, 'reviews do not repeat within their period');
try { $app->inbox()->flush(); ok(false, 'flush fails while unreachable'); } catch (RuntimeException $e) { ok(true, 'flush fails while unreachable'); }
$app->config['dashboard'] = ['inbox_url' => '', 'secret' => ''];

// ---- publishing -------------------------------------------------------------------
$pub = new Publisher($app);
$r = $pub->publish();
ok(!$r['ok'] && count($r['problems']) > 3, 'unconfirmed [CHECK] text blocks publishing');
// Simulate the review: strip every marker.
foreach (['places', 'listings', 'products', 'event_series', 'occurrences', 'points', 'venues'] as $tbl) {
    foreach ($app->all("SELECT id, data FROM $tbl") as $row) {
        $app->update($tbl, $row['id'], ['data' => str_replace(['[CHECK] ', '[CHECK]'], '', $row['data'])]);
    }
}
$app->insert('routes', ['id' => 'rt1', 'property_id' => 'flat', 'point_id' => 'pt-o2', 'direction' => 'to', 'context' => 'normal', 'summary' => 'Walk, then Jubilee line', 'minutes' => 33,
    'fare_pence' => 405, 'legs' => Util::enc($legs), 'source' => 'TfL', 'verified_at' => date('Y-m-d'), 'status' => 'published']);
$r = $pub->publish();
ok($r['ok'], 'publishes once reviewed: ' . implode(' | ', $r['problems']));
foreach (['/index.html', '/stay/both-rooms/index.html', '/events/concerts-at-the-o2/index.html', '/events/index.html', '/policies/index.html', '/sitemap.xml', '/robots.txt', '/llms.txt'] as $f) {
    ok(is_file("$tmp/public$f"), "wrote $f");
}
$all = '';
foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator("$tmp/public", FilesystemIterator::SKIP_DOTS)) as $f) $all .= file_get_contents((string)$f);
ok(!preg_match('/SE1 ?4GT/i', $all), 'postcode never published');
ok(!str_contains($all, 'only goes in the confirmation email'), 'private arrival info never published');
ok(str_contains($all, 'Walk to The O2 entrance'), 'route shown on event page');
$o2 = file_get_contents("$tmp/public/events/concerts-at-the-o2/index.html");
preg_match_all('#<script type="application/ld\+json">(.*?)</script>#s', $o2, $m);
ok($m[1] && array_reduce($m[1], fn($c, $j) => $c && is_array(json_decode($j, true)), true), 'structured data is valid JSON');
ok(str_contains(file_get_contents("$tmp/public/robots.txt"), 'GPTBot'), 'robots welcomes AI crawlers');

// Unpublishing an event removes its page on the next publish.
$app->update('event_series', 'o2-concerts', ['status' => 'draft']);
$pub->publish();
ok(!is_file("$tmp/public/events/concerts-at-the-o2/index.html"), 'unpublished event page removed');

echo "\n$count checks, " . ($fails ? "$fails FAILED" : 'all passed') . "\n";
exit($fails ? 1 : 0);
