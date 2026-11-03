<?php
declare(strict_types=1);

/**
 * "Publish": writes every public page as plain HTML into the web root, so
 * search engines and AI crawlers read full content without running JS.
 * Only records with status 'published' appear. It refuses to publish
 * anything still carrying a [CHECK] marker -- seeded text that nobody has
 * confirmed yet -- and lists where those markers are.
 */
final class Publisher
{
    private Content $content;
    private array $written = [];

    public function __construct(private App $app)
    {
        $this->content = new Content($app);
    }

    /** @return array{ok:bool, problems:array, pages:array} */
    public function publish(): array
    {
        $this->written = [];
        $problems = $this->check();
        if ($problems) return ['ok' => false, 'problems' => $problems, 'pages' => []];

        $site = $this->app->config['site'];
        $products = $this->content->products();
        $currencies = $this->app->config['booking']['currencies'];
        $events = $this->events();
        $property = $this->mainProperty($products);
        $base = rtrim($site['base_url'], '/');
        $business = $this->businessLd($site, $property);

        $this->write('/', View::page('home', [
            'site' => $site, 'path' => '/', 'property' => $property, 'products' => $products, 'events' => $events,
            'title' => Util::t($property['content']['seo_title'] ?? $site['name']),
            'description' => Util::t($property['content']['seo_description'] ?? $property['content']['description'] ?? ''),
            'jsonld' => [$business],
        ]));

        foreach ($products as $p) {
            $path = "/stay/{$p['slug']}/";
            $this->write($path, View::page('product', [
                'site' => $site, 'path' => $path, 'product' => $p, 'currencies' => $currencies, 'widget' => true,
                'title' => "{$p['name']} | {$site['name']}",
                'description' => Util::t($p['content']['summary'] ?? $p['listings'][0]['content']['summary'] ?? ''),
                'og_image' => isset($p['listings'][0]['content']['photos'][0]) ? $this->abs($p['listings'][0]['content']['photos'][0]['src']) : null,
                'jsonld' => [$this->roomLd($p, $business, $base . $path), $this->crumbs([[$site['name'], '/'], [$p['name'], $path]])],
            ]));
        }

        foreach ($events as $e) {
            $s = $e['series'];
            $occ = $e['occ'];
            $path = "/events/{$s['slug']}/";
            $c = $occ['content'] ?? $s['content'];
            $propertyId = $property['id'];
            $this->write($path, View::page('event', [
                'site' => $site, 'path' => $path, 'series' => $s, 'occ' => $occ, 'products' => $products, 'currencies' => $currencies, 'widget' => true,
                'routeGroups' => $this->content->routes($propertyId, $s['points']),
                'title' => Util::t($c['seo_title'] ?? "Where to stay for {$s['name']} | {$site['name']}"),
                'description' => Util::t($c['seo_description'] ?? $c['summary'] ?? ''),
                'jsonld' => array_values(array_filter([$this->eventLd($s, $occ, $base . $path), $this->crumbs([[$site['name'], '/'], ['Events', '/events/'], [$s['name'], $path]])])),
            ]));
        }

        $this->write('/events/', View::page('events', [
            'site' => $site, 'path' => '/events/', 'events' => $events,
            'title' => "Events near London Bridge | {$site['name']}", 'description' => 'Dates, transport from London Bridge and rooms for the events our guests come to London for.',
        ]));
        $methods = $products ? (new Pricing($this->app))->methodsFor($products[0], 'GBP') : [];
        $this->write('/policies/', View::page('policies', [
            'site' => $site, 'path' => '/policies/', 'methods' => $methods,
            'title' => "Booking, cancellation and privacy | {$site['name']}", 'description' => 'How direct booking works, cancellation policies, ways to pay and privacy.',
        ]));

        $this->writeRaw('/sitemap.xml', $this->sitemap($base));
        $this->writeRaw('/robots.txt', $this->robots($base));
        $this->writeRaw('/llms.txt', $this->llms($site, $property, $products, $events, $base));
        $this->sweep();
        $this->app->log('site', null, 'Published ' . count($this->written) . ' files');
        return ['ok' => true, 'problems' => [], 'pages' => array_keys($this->written)];
    }

    /** Every published record whose text still holds a [CHECK] marker. */
    public function check(): array
    {
        $out = [];
        $scan = function (string $what, ?string $json) use (&$out) {
            if ($json !== null && str_contains($json, '[CHECK')) {
                preg_match_all('/\[CHECK[^\]]*\][^"]{0,60}/', $json, $m);
                $out[] = "$what: " . implode(' | ', array_map(fn($s) => stripslashes($s), array_slice($m[0], 0, 3)));
            }
        };
        $products = $this->content->products();
        $placeIds = [];
        foreach ($products as $p) {
            $scan("Product {$p['name']}", $p['data']);
            foreach ($p['listings'] as $l) {
                $scan("Listing {$l['name']}", $l['data']);
                foreach ($this->content->placeChain($l['property_id']) as $pl) $placeIds[$pl['id']] = $pl;
            }
        }
        foreach ($placeIds as $pl) $scan("Place {$pl['name']}", $pl['data']);
        foreach ($this->events() as $e) {
            $scan("Event {$e['series']['name']}", $e['series']['data']);
            if ($e['series']['venue']) $scan("Venue {$e['series']['venue']['name']}", $e['series']['venue']['data']);
            if ($e['occ']) $scan("Occurrence {$e['occ']['label']}", $e['occ']['data']);
            foreach ($e['series']['points'] as $pt) $scan("Point {$pt['name']}", $pt['data']);
        }
        foreach ($this->app->all("SELECT * FROM routes WHERE status = 'published'") as $r) $scan("Route {$r['id']}", $r['summary'] . $r['legs']);
        if (!$products) $out[] = 'No published products: publish at least one room first.';
        return $out;
    }

    private function events(): array
    {
        $out = [];
        foreach ($this->app->all("SELECT id FROM event_series WHERE status = 'published' ORDER BY name") as $r) {
            $s = $this->content->series($r['id']);
            $out[] = ['series' => $s, 'occ' => $this->content->featuredOccurrence($s)];
        }
        usort($out, fn($a, $b) => strcmp($a['occ']['start_date'] ?? '9999', $b['occ']['start_date'] ?? '9999'));
        return $out;
    }

    private function mainProperty(array $products): array
    {
        $pid = $products[0]['listings'][0]['property_id'] ?? null;
        $row = $pid ? $this->app->one('SELECT * FROM places WHERE id = ?', [$pid]) : null;
        if (!$row) return ['id' => '', 'name' => $this->app->config['site']['name'], 'content' => []];
        $row['content'] = $this->content->placeData($pid);
        return $row;
    }

    // ---- structured data --------------------------------------------------

    private function businessLd(array $site, array $property): array
    {
        $c = $property['content'];
        return array_filter([
            '@context' => 'https://schema.org', '@type' => 'LodgingBusiness', '@id' => rtrim($site['base_url'], '/') . '/#business',
            'name' => $site['name'], 'url' => rtrim($site['base_url'], '/') . '/',
            'description' => Util::t($c['description'] ?? ''),
            // Area-level only: the exact address goes out in the confirmation email, never on a public page.
            'address' => ['@type' => 'PostalAddress', 'addressLocality' => Util::t($c['public_locality'] ?? 'London'), 'postalCode' => $c['public_postcode_district'] ?? null, 'addressCountry' => 'GB'],
            'geo' => isset($c['public_geo']) ? ['@type' => 'GeoCoordinates', 'latitude' => $c['public_geo'][0], 'longitude' => $c['public_geo'][1]] : null,
            'amenityFeature' => array_map(fn($a) => ['@type' => 'LocationFeatureSpecification', 'name' => Util::t($a), 'value' => true], $c['amenities'] ?? []),
            'email' => $site['operator_email'] ?: null,
        ]);
    }

    private function roomLd(array $p, array $business, string $url): array
    {
        return [
            '@context' => 'https://schema.org', '@type' => 'Accommodation', 'name' => $p['name'], 'url' => $url,
            'description' => Util::t($p['content']['description'] ?? $p['listings'][0]['content']['description'] ?? ''),
            'occupancy' => ['@type' => 'QuantitativeValue', 'maxValue' => array_sum(array_map(fn($l) => (int)$l['max_guests'], $p['listings']))],
            'containedInPlace' => ['@id' => $business['@id']],
            'image' => array_map(fn($ph) => $this->abs($ph['src']), array_slice($p['listings'][0]['content']['photos'] ?? [], 0, 4)),
        ];
    }

    private function eventLd(array $s, ?array $occ, string $url): ?array
    {
        if (!$occ || !$occ['start_date'] || !$s['venue']) return null;
        return array_filter([
            '@context' => 'https://schema.org', '@type' => 'Event', 'name' => $occ['label'],
            'startDate' => $occ['start_date'], 'endDate' => $occ['end_date'] ?: $occ['start_date'],
            'eventAttendanceMode' => 'https://schema.org/OfflineEventAttendanceMode',
            'location' => ['@type' => 'Place', 'name' => $s['venue']['name'], 'address' => Util::t($s['venue']['content']['address'] ?? 'London')],
            'url' => $occ['ticket_url'] ?: $url,
        ]);
    }

    private function crumbs(array $items): array
    {
        $base = rtrim($this->app->config['site']['base_url'], '/');
        return ['@context' => 'https://schema.org', '@type' => 'BreadcrumbList', 'itemListElement' => array_map(
            fn($i, $n) => ['@type' => 'ListItem', 'position' => $n + 1, 'name' => $i[0], 'item' => $base . $i[1]], $items, array_keys($items))];
    }

    // ---- files ------------------------------------------------------------

    private function sitemap(string $base): string
    {
        $x = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n";
        foreach (array_keys($this->written) as $p) if (str_ends_with($p, '/')) $x .= '  <url><loc>' . Util::h($base . $p) . '</loc><lastmod>' . date('Y-m-d') . "</lastmod></url>\n";
        return $x . "</urlset>\n";
    }

    private function robots(string $base): string
    {
        // AI crawlers are welcome: being cited by AI assistants is one of the site's goals.
        $private = "Disallow: /admin\nDisallow: /api/\nDisallow: /booking\nDisallow: /checkout/\nDisallow: /dev/\n";
        return "User-agent: *\n$private\nUser-agent: GPTBot\nUser-agent: OAI-SearchBot\nUser-agent: ClaudeBot\nUser-agent: Claude-SearchBot\nUser-agent: PerplexityBot\nUser-agent: Google-Extended\n$private\nSitemap: $base/sitemap.xml\n";
    }

    private function llms(array $site, array $property, array $products, array $events, string $base): string
    {
        $t = "# {$site['name']}\n\n> " . Util::t($property['content']['description'] ?? '') . "\n\n";
        $t .= "Rooms are booked directly with their hosts by request: the host answers within 24 hours. Payment by card (authorised, charged on acceptance), wallet or bank transfer; prices in GBP or the guest's choice of major currency.\n\n## Rooms\n\n";
        foreach ($products as $p) $t .= "- [{$p['name']}]($base/stay/{$p['slug']}/): " . Util::t($p['content']['summary'] ?? $p['listings'][0]['content']['summary'] ?? '') . "\n";
        $t .= "\n## Events (dates, transport from London Bridge, rooms)\n\n";
        foreach ($events as $e) $t .= "- [{$e['series']['name']}]($base/events/{$e['series']['slug']}/)" . ($e['occ'] && $e['occ']['start_date'] ? ': ' . Util::fmtDate($e['occ']['start_date']) : '') . "\n";
        return $t . "\n## Policies\n\n- [Booking, cancellation and privacy]($base/policies/)\n";
    }

    private function abs(string $src): string
    {
        return preg_match('#^https?://#', $src) ? $src : rtrim($this->app->config['site']['base_url'], '/') . '/' . ltrim($src, '/');
    }

    private function write(string $path, string $html): void
    {
        $this->writeRaw(rtrim($path, '/') . '/index.html', $html);
        $this->written[$path] = true;
    }

    private function writeRaw(string $rel, string $body): void
    {
        $file = $this->app->config['paths']['public'] . $rel;
        if (!is_dir(dirname($file))) mkdir(dirname($file), 0755, true);
        file_put_contents($file . '.tmp', $body);
        rename($file . '.tmp', $file);
        $this->written[$rel] ??= true;
    }

    /** Removes pages from a previous publish that no longer exist (an unpublished event, say). */
    private function sweep(): void
    {
        $manifest = $this->app->config['paths']['data'] . '/published.json';
        $old = is_file($manifest) ? Util::json(file_get_contents($manifest)) : [];
        $now = [];
        foreach (array_keys($this->written) as $p) $now[] = str_ends_with($p, '/') ? rtrim($p, '/') . '/index.html' : $p;
        $now = array_values(array_unique($now));
        foreach (array_diff($old, $now) as $gone) {
            $f = $this->app->config['paths']['public'] . $gone;
            if (is_file($f)) unlink($f);
        }
        file_put_contents($manifest, Util::enc($now));
    }
}
