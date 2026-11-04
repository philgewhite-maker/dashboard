<?php
/**
 * Day 1 content. Anything not confirmed by Phil, Lewis or Zara carries a
 * [CHECK] marker, and the publisher refuses to publish until each is
 * confirmed and the marker removed in the admin. Room descriptions came
 * from an AI sketch of the listings, so ALL of them need checking against
 * the real Airbnb listings.
 *
 * Walk times below were computed with the TfL journey planner from the
 * postcode in that sketch (SE1 4GT) on 2026-11-03. If the postcode is
 * wrong, so are they.
 *
 * Venue addresses and transport facts in tips are well-established, but
 * still worth a read: the site states them as fact.
 *
 * @param array $hosts ['lewis' => [...], 'zara' => [...]] from config seed.hosts
 */
return function (array $hosts): array {
    $j = fn($v) => json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    return [
        // Three brands over the same rooms. Temporary addresses on the existing
        // domain until names are chosen; noindex until then (indexable = 0).
        'sites' => [
            ['id' => 'rooms', 'name' => 'London Bridge Rooms', 'base_url' => 'https://rooms.georgewhiteeuropean.co.uk', 'sort' => 1,
             'products' => $j(['p-room-1', 'p-room-2', 'p-both']), 'events' => 'all', 'events_home' => 'stays', 'indexable' => 0,
             'data' => $j(['accent' => '#1f5f8b', 'accent_dark' => '#7fb6dc'])],
            ['id' => 'katsu', 'name' => 'Stay with Katsu', 'base_url' => 'https://katsu.georgewhiteeuropean.co.uk', 'sort' => 2,
             'products' => $j(['p-room-1']), 'events' => 'none', 'events_home' => null, 'indexable' => 0,
             'data' => $j([
                'accent' => '#b5541c', 'accent_dark' => '#f0a46c',
                'headline' => 'Stay with Katsu, in an ensuite room by London Bridge',
                'description' => '[CHECK] Katsu is the flat\'s big, friendly ginger Maine Coon. Book the ensuite king room and he comes with it: cat company on tap, a short walk from London Bridge.',
                'seo_title' => 'Stay with Katsu: an ensuite room in London with a resident Maine Coon',
                'seo_description' => 'An ensuite king room near London Bridge in a flat with a friendly resident Maine Coon. Book directly with the host.',
             ])],
            ['id' => 'stays', 'name' => 'London Event Stays', 'base_url' => 'https://stays.georgewhiteeuropean.co.uk', 'sort' => 3,
             'products' => $j('*'), 'events' => 'all', 'events_home' => null, 'indexable' => 0,
             'data' => $j([
                'home' => 'directory', 'accent' => '#2f6f4f', 'accent_dark' => '#86c9a3',
                'headline' => 'Rooms in London for the events you\'re coming for',
                'description' => 'Rooms booked directly with their hosts, with real travel times to the venues and back late at night.',
                'seo_title' => 'Where to stay in London for concerts, sport and events | book direct',
             ])],
        ],
        'hosts' => [
            ['id' => 'lewis', 'name' => $hosts['lewis']['name'] ?? 'Lewis', 'email' => $hosts['lewis']['email'] ?? 'lewis@example.com', 'from_email' => null, 'stripe_account' => null,
             'payment_methods' => $j(['card' => true, 'alipay' => true, 'wechat_pay' => true, 'pay_by_bank' => true, 'revolut' => false, 'bank_transfer' => []])],
            ['id' => 'zara', 'name' => $hosts['zara']['name'] ?? 'Zara', 'email' => $hosts['zara']['email'] ?? 'zara@example.com', 'from_email' => null, 'stripe_account' => null,
             'payment_methods' => $j(['card' => true, 'alipay' => true, 'wechat_pay' => true, 'pay_by_bank' => true, 'revolut' => false, 'bank_transfer' => []])],
        ],
        'places' => [
            ['id' => 'london', 'parent_id' => null, 'kind' => 'city', 'slug' => 'london', 'name' => 'London', 'data' => $j(['public_locality' => 'London'])],
            ['id' => 'london-bridge', 'parent_id' => 'london', 'kind' => 'area', 'slug' => 'london-bridge', 'name' => 'London Bridge and Bermondsey', 'data' => $j([
                'public_postcode_district' => 'SE1',
                'area_intro' => 'South of the river between London Bridge and Bermondsey: Borough Market, Bermondsey Street\'s restaurants and Tower Bridge are all on foot, and London Bridge station has the Jubilee and Northern lines and trains to south and east London.',
            ])],
            ['id' => 'building', 'parent_id' => 'london-bridge', 'kind' => 'building', 'slug' => 'building', 'name' => 'The building', 'data' => $j([
                'building_features' => ['[CHECK] High floor with two lifts', '[CHECK] 24-hour concierge', '[CHECK] Residents\' gym', '[CHECK] Roof terrace and podium garden'],
            ])],
            ['id' => 'flat', 'parent_id' => 'building', 'kind' => 'property', 'slug' => 'flat', 'name' => 'The flat', 'data' => $j([
                'tfl_origin' => 'SE14GT',
                'tfl_origin_note' => '[CHECK] SE1 4GT is from the AI sketch: confirm the postcode, then delete this note',
                'headline' => 'Rooms in a London Bridge flat, booked directly with the hosts',
                'description' => 'Two private rooms in a lived-in flat between London Bridge and Bermondsey, with skyline views. [CHECK] confirm wording',
                'seo_title' => 'London Bridge rooms to book direct | near Borough Market and the Jubilee line',
                'seo_description' => 'Two private rooms between London Bridge and Bermondsey. Book directly with the hosts: no platform fees, cards, Alipay, WeChat Pay or bank transfer.',
                'walk_times' => [
                    ['to' => 'Bermondsey Street', 'minutes' => 6],
                    ['to' => 'London Bridge station (Jubilee and Northern lines, trains)', 'minutes' => 10],
                    ['to' => 'Borough Market', 'minutes' => 15],
                    ['to' => 'Tower Bridge', 'minutes' => 18],
                ],
                'highlights' => ['[CHECK] Skyline views of the Shard from the balcony', '[CHECK] A large, friendly resident cat: not for guests with cat allergies', '[CHECK] Fast wifi', 'Hosts live in the flat'],
                'amenities' => ['[CHECK] Wifi', '[CHECK] Boiling and sparkling water tap', '[CHECK] Wine fridge', '[CHECK] Washing machine', '[CHECK] Residents\' gym'],
                'house_rules' => ['[CHECK] No smoking', '[CHECK] No parties', '[CHECK] Check-in from 15:00, check-out by 11:00', 'A cat lives here'],
                'arrival_info' => '[CHECK] Full address, how to get in, and who to call. This only goes in the confirmation email.',
                'sites' => ['katsu' => [
                    'highlights_heading' => 'About Katsu',
                    'highlights' => ['[CHECK] A large ginger Maine Coon, very friendly with guests', '[CHECK] Happy to be fed, fussed and photographed', 'Not for guests with cat allergies', 'He lives here: the room door locks if you want him out'],
                ]],
            ])],
        ],
        'listings' => [
            ['id' => 'room-1', 'property_id' => 'flat', 'host_id' => 'lewis', 'slug' => 'ensuite-king-room', 'name' => 'Ensuite king room',
             'beds24_room_id' => null, 'ical_url' => null, 'airbnb_url' => 'https://www.airbnb.co.uk/rooms/1651495519889440619', 'max_guests' => 2, 'base_rate' => 125, 'status' => 'published',
             'data' => $j([
                'base_rate_note' => '[CHECK] base rate £125 is from the AI sketch; Beds24 replaces it once connected',
                'summary' => 'King bed, private ensuite shower room and a desk with a big monitor. [CHECK]',
                'description' => '[CHECK] A king room with its own ensuite shower room, a work desk with a 43-inch monitor, a smart TV and views across London.',
                'features' => ['[CHECK] King-size bed', '[CHECK] Private ensuite shower room', '[CHECK] Desk with 43-inch monitor', '[CHECK] Smart TV', 'Lock on the bedroom door'],
                'weekly_discount_pct' => 0, 'monthly_discount_pct' => 0,
                'rating' => null, 'reviews' => [],
                'photos' => [],
                'sites' => ['katsu' => [
                    'summary' => 'Your own ensuite king room, with Katsu the Maine Coon for company. [CHECK]',
                    'description' => '[CHECK] A king room with its own ensuite shower room and a big desk, in a flat shared with Katsu, a large and very friendly ginger Maine Coon.',
                ]],
             ])],
            ['id' => 'room-2', 'property_id' => 'flat', 'host_id' => 'zara', 'slug' => 'double-room', 'name' => 'Double room with mini fridge',
             'beds24_room_id' => null, 'ical_url' => null, 'airbnb_url' => null, 'max_guests' => 2, 'base_rate' => 100, 'status' => 'published',
             'data' => $j([
                'base_rate_note' => '[CHECK] base rate £100 is from the AI sketch; Beds24 replaces it once connected',
                'airbnb_url_note' => '[CHECK] add Zara\'s Airbnb listing link in airbnb_url',
                'summary' => 'Double room with its own mini fridge and desk; bathroom shared with one other guest. [CHECK]',
                'description' => '[CHECK] A double room with a private mini fridge and a desk, sharing a bathroom with the one other room.',
                'features' => ['[CHECK] Double bed', '[CHECK] Private mini fridge', '[CHECK] Desk', '[CHECK] Bathroom shared with one other guest', 'Lock on the bedroom door'],
                'weekly_discount_pct' => 0, 'monthly_discount_pct' => 0,
                'rating' => null, 'reviews' => [],
                'photos' => [],
             ])],
        ],
        'products' => [
            ['id' => 'p-room-1', 'slug' => 'ensuite-king-room', 'name' => 'Ensuite king room', 'listing_ids' => $j(['room-1']), 'multi_room_discount_pct' => 0, 'status' => 'published', 'data' => $j([])],
            ['id' => 'p-room-2', 'slug' => 'double-room', 'name' => 'Double room with mini fridge', 'listing_ids' => $j(['room-2']), 'multi_room_discount_pct' => 0, 'status' => 'published', 'data' => $j([])],
            ['id' => 'p-both', 'slug' => 'both-rooms', 'name' => 'Both rooms, for up to 4', 'listing_ids' => $j(['room-1', 'room-2']), 'multi_room_discount_pct' => 5, 'status' => 'published', 'data' => $j([
                'discount_note' => '[CHECK] 5% multi-room discount is a placeholder: set the real figure',
                'summary' => 'Both private rooms for friends or family travelling together, with a discount for booking the pair.',
                'description' => 'Both rooms together, for two couples or a family of four. Each room is hosted by its own owner, so you\'ll pay each of them separately in one checkout.',
            ])],
        ],
        'venues' => [
            ['id' => 'o2', 'area_id' => null, 'slug' => 'the-o2', 'name' => 'The O2', 'data' => $j(['address' => 'Peninsula Square, London SE10 0DX'])],
            ['id' => 'twickenham', 'area_id' => null, 'slug' => 'twickenham-stadium', 'name' => 'Allianz Stadium, Twickenham', 'data' => $j(['address' => '200 Whitton Road, Twickenham TW2 7BA'])],
            ['id' => 'aeltc', 'area_id' => null, 'slug' => 'wimbledon', 'name' => 'All England Lawn Tennis Club, Wimbledon', 'data' => $j(['address' => 'Church Road, Wimbledon, London SW19 5AE'])],
        ],
        'points' => [
            ['id' => 'pt-o2', 'venue_id' => 'o2', 'slug' => 'o2-entrance', 'name' => 'The O2 entrance', 'tfl_ref' => '51.5030,0.0032', 'data' => $j([
                'note' => 'North Greenwich station (Jubilee line) is next to the venue.',
                'route_plans' => [['context' => 'normal', 'direction' => 'to', 'time' => '1800'], ['context' => 'late_night', 'direction' => 'from', 'time' => '2300']],
            ])],
            ['id' => 'pt-twick', 'venue_id' => 'twickenham', 'slug' => 'twickenham-stadium', 'name' => 'Twickenham stadium', 'tfl_ref' => '51.4559,-0.3415', 'data' => $j([
                'route_plans' => [['context' => 'normal', 'direction' => 'to', 'time' => '1200'], ['context' => 'event_day', 'direction' => 'from', 'time' => '1900']],
            ])],
            ['id' => 'pt-wimb', 'venue_id' => 'aeltc', 'slug' => 'wimbledon-grounds', 'name' => 'Wimbledon grounds', 'tfl_ref' => '51.4340,-0.2140', 'data' => $j([
                'route_plans' => [['context' => 'normal', 'direction' => 'to', 'time' => '0900'], ['context' => 'event_day', 'direction' => 'from', 'time' => '2100']],
            ])],
            ['id' => 'pt-regent', 'venue_id' => null, 'slug' => 'regent-street', 'name' => 'Regent Street lights', 'tfl_ref' => '51.5115,-0.1384', 'data' => $j([
                'route_plans' => [['context' => 'normal', 'direction' => 'to', 'time' => '1700'], ['context' => 'late_night', 'direction' => 'from', 'time' => '2300']],
            ])],
            ['id' => 'pt-covent', 'venue_id' => null, 'slug' => 'covent-garden', 'name' => 'Covent Garden', 'tfl_ref' => '51.5117,-0.1240', 'data' => $j([
                'route_plans' => [['context' => 'normal', 'direction' => 'to', 'time' => '1700']],
            ])],
        ],
        'event_series' => [
            ['id' => 'wimbledon', 'slug' => 'wimbledon', 'name' => 'Wimbledon', 'venue_id' => 'aeltc', 'recurrence' => 'annual', 'point_ids' => $j([]), 'status' => 'published', 'data' => $j([
                'headline' => 'Where to stay for Wimbledon: London Bridge, with easy trains to SW19',
                'summary' => 'Hotels near Wimbledon fill up and cost the earth during the Championships. Stay central instead, and get to the grounds by train or the District line.',
                'intro' => 'Most visitors reach the grounds from Southfields station (District line) or Wimbledon station (trains from Waterloo and Clapham Junction, plus the District line and trams). Queuing for tickets starts early in Wimbledon Park, so an early start from central London is normal.',
                'tips' => ['If you are queuing for day tickets, aim to arrive in Wimbledon Park by early morning.', 'Southfields is the nearest Tube station to the grounds; it gets busy at the end of play.'],
            ])],
            ['id' => 'o2-concerts', 'slug' => 'concerts-at-the-o2', 'name' => 'Concerts at The O2', 'venue_id' => 'o2', 'recurrence' => 'multi', 'point_ids' => $j([]), 'status' => 'published', 'data' => $j([
                'headline' => 'Staying near The O2? London Bridge is a short Jubilee line ride away',
                'summary' => 'The O2 is a short Jubilee line ride from Bermondsey and London Bridge, so you can stay somewhere with restaurants and bars on the doorstep and still be close after the show.',
                'intro' => 'North Greenwich station is right next to the arena, but after big shows the crowds are managed with queues, so allow time. The Uber Boat by Thames Clippers also runs between North Greenwich pier and London Bridge City pier, a 14-minute walk from the flat.',
                'tips' => ['After a sold-out show, expect queues at North Greenwich station.', 'The river boat is a calmer alternative after the show: check the last sailing before you go.'],
            ])],
            ['id' => 'twickenham-rugby', 'slug' => 'england-rugby-twickenham', 'name' => 'England rugby at Twickenham', 'venue_id' => 'twickenham', 'recurrence' => 'multi', 'point_ids' => $j([]), 'status' => 'published', 'data' => $j([
                'headline' => 'Where to stay for England rugby at Twickenham',
                'summary' => 'Stay central at London Bridge and take the train to Twickenham on match day, then come back to restaurants and bars rather than a hotel by the ring road.',
                'intro' => 'Twickenham station has trains from London Waterloo; from there it is a walk of about 15 minutes to the stadium. On match days, expect queues for trains back after the final whistle.',
                'tips' => ['Book a table for after the match near the flat: Bermondsey Street and Borough Market are close.', 'Trains back from Twickenham are queued after the game; allow extra time.'],
            ])],
            ['id' => 'christmas-lights', 'slug' => 'christmas-lights-london', 'name' => 'Christmas lights in central London', 'venue_id' => null, 'recurrence' => 'annual', 'point_ids' => $j(['pt-regent', 'pt-covent']), 'status' => 'published', 'data' => $j([
                'headline' => 'Seeing London\'s Christmas lights: stay at London Bridge',
                'summary' => 'Regent Street, Oxford Street, Carnaby Street and Covent Garden are lit up from November to early January. London Bridge is a short Tube ride away, and Borough Market is at its best in December.',
                'tips' => ['Weeknight evenings are quieter than weekends for seeing the lights.', 'Borough Market, a short walk from the flat, is busiest on Saturdays in December.'],
            ])],
        ],
        'occurrences' => [
            ['id' => 'wimbledon-2027', 'series_id' => 'wimbledon', 'name' => 'Wimbledon 2027', 'start_date' => '2027-06-28', 'end_date' => '2027-07-11',
             'ticket_url' => 'https://www.wimbledon.com/', 'source' => 'Expected dates: last Monday of June for two weeks', 'min_nights' => 3, 'cancellation_policy' => 'firm', 'discount_pct' => null,
             'status' => 'draft', 'data' => $j(['note' => '[CHECK] confirm 2027 dates on wimbledon.com, and the 3-night minimum and Firm policy, then remove this note and publish'])],
            ['id' => 'o2-example', 'series_id' => 'o2-concerts', 'name' => null, 'start_date' => null, 'end_date' => null, 'ticket_url' => null,
             'source' => null, 'min_nights' => null, 'cancellation_policy' => null, 'discount_pct' => null, 'status' => 'draft',
             'data' => $j(['note' => '[CHECK] pick a real upcoming concert: name, date, ticket link'])],
            ['id' => 'twick-example', 'series_id' => 'twickenham-rugby', 'name' => null, 'start_date' => null, 'end_date' => null, 'ticket_url' => null,
             'source' => null, 'min_nights' => null, 'cancellation_policy' => null, 'discount_pct' => null, 'status' => 'draft',
             'data' => $j(['note' => '[CHECK] add England\'s next home match: opponent, date, ticket link'])],
            ['id' => 'xmas-2026', 'series_id' => 'christmas-lights', 'name' => 'Christmas lights 2026', 'start_date' => '2026-11-14', 'end_date' => '2027-01-06',
             'ticket_url' => null, 'source' => 'Typical season', 'min_nights' => null, 'cancellation_policy' => null, 'discount_pct' => null, 'status' => 'draft',
             'data' => $j(['note' => '[CHECK] confirm this year\'s switch-on date'])],
        ],
    ];
};
