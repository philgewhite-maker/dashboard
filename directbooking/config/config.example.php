<?php
// Copy to config/config.php (gitignored) and fill in. Anything left out
// falls back to App::defaults(). Nothing here is ever shown on the site.
return [
    'site' => [
        'name' => 'London Bridge Rooms',           // the brand; change with the domain
        'base_url' => 'https://YOUR-DOMAIN',       // no trailing slash
        'secret' => 'CHANGE-ME-long-random-string', // php -r "echo bin2hex(random_bytes(32));"
        'operator_email' => 'you@example.com',     // shown on the site as the contact address
    ],

    // SQLite file outside the web root: no database to create in cPanel.
    // 'db' => ['dsn' => 'sqlite:' . __DIR__ . '/../data/site.sqlite'],

    // Who gets seeded by bin/setup.php. Emails are where notifications and
    // sign-in links go. The operator approves anything; a host only their rooms.
    'seed' => [
        // Where each branded site lives. Temporary subdomains on the existing
        // domain until names are chosen; each points at directbooking/public.
        'site_urls' => [
            'rooms' => 'https://rooms.georgewhiteeuropean.co.uk',
            'katsu' => 'https://katsu.georgewhiteeuropean.co.uk',
            'stays' => 'https://stays.georgewhiteeuropean.co.uk',
        ],
        'operator' => ['name' => 'Phil', 'email' => 'you@example.com'],
        'hosts' => [
            'lewis' => ['name' => 'Lewis', 'email' => 'lewis@example.com'],
            'zara' => ['name' => 'Zara', 'email' => 'zara@example.com'],
        ],
    ],

    'booking' => [
        'default_discount_pct' => 12.0,            // below the Beds24/Airbnb price
        // 'bank_discount_pct' => 0.0,
        // 'currencies' => ['GBP', 'USD', 'EUR', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'SEK', 'NOK'],
    ],

    // 'local' until Airbnb calendars are wired; 'ical' with each listing's
    // Airbnb calendar export URL; 'beds24' once Lewis and Zara connect.
    'rates' => ['source' => 'local'],
    'beds24' => [
        'refresh_token' => '',                     // Beds24 > Settings > API > invite code -> refresh token
        // 'hold_status' => 'request',             // confirm this blocks Airbnb before going live
    ],

    // 'fake' = clickable test checkout, no money moves. 'stripe' once the
    // platform account exists and Lewis/Zara have connected theirs.
    'payments' => ['gateway' => 'fake'],
    'stripe' => [
        'secret_key' => '',                        // platform account's sk_live_... (sk_test_... first)
        'webhook_secret' => '',                    // whsec_... of the Connect webhook endpoint /api/stripe/webhook
    ],

    // Tasks for Phil's dashboard (its agent inbox), each linking to the admin
    // page where it's done. Secret = $AGENT_SECRET in agent-write.php.
    'dashboard' => [
        'inbox_url' => 'https://georgewhiteeuropean.co.uk/agent-write.php',
        'secret' => '',
        // The dashboard's own data file on this host (sync.php's $DATA_FILE: one level above
        // public_html). Read-only: the booking model's void projection drives special offers.
        'data_file' => '/home/YOUR-CPANEL-USER/dashboard-data.json',
    ],

    // Special offers from the booking model (defaults shown; see README "Demand").
    // 'demand' => ['low_prob' => 0.5, 'margin_pct' => 10, 'floor_gbp' => 45, 'max_discount_pct' => 30, 'max_age_days' => 7],
    // Dead-void fixes applied to Beds24/Airbnb within limits. Needs rates.source = beds24.
    // 'autopilot' => ['enabled' => false, 'max_discount_pct' => 20, 'floor_gbp' => 60, 'max_days_ahead' => 45, 'allow_min_stay' => true],

    // 'log' until the domain's mailbox and SPF/DKIM are set up, then 'mail'.
    'mail' => ['transport' => 'log', 'from' => 'bookings@YOUR-DOMAIN'],
];
