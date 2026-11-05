<?php
// Site settings. Everything marked CHANGE-ME is a placeholder: while `draft` is true the
// site is built with a "draft" banner and a noindex tag, and the build refuses to switch
// draft off while any placeholder is left (see build.php).
return [
    'draft' => true,

    'siteName' => 'Switch Bonus Guide',                        // CHANGE-ME: your brand
    'tagline' => 'Plain-English guides to UK bank switch offers',
    'baseUrl' => 'https://CHANGE-ME.example',                  // CHANGE-ME: the live domain (no trailing slash)
    'basePath' => '',                                          // '' on a domain root; '/public-site' when previewing in a subfolder
    'contactEmail' => 'CHANGE-ME@example.com',                 // CHANGE-ME: a monitored address
    'publisher' => 'CHANGE-ME: your name or company name',     // CHANGE-ME: who runs the site (networks check this)
    'publisherPlace' => 'United Kingdom',

    // Stated in the footer and on the disclosure page. Confirm it is true for you before launch.
    'fcaStatement' => 'We are not authorised or regulated by the Financial Conduct Authority. We give general information, not financial advice or personal recommendations.',

    // The interactive planner (the invite-only advisor app).
    'plannerUrl' => 'https://philgewhite-maker.github.io/dashboard/public-switchadvisor/',

    // Sections that are written and ready. Leave a section false and its pages are not built or linked.
    'sections' => [
        'isas' => false,
    ],

    // Where each bank's own site lives. Used for the "visit" button when no affiliate link is set.
    'bankSites' => [
        'barclays' => 'https://www.barclays.co.uk/',
        'hsbc' => 'https://www.hsbc.co.uk/',
        'first-direct' => 'https://www.firstdirect.com/',
        'lloyds-bank' => 'https://www.lloydsbank.com/',
        'natwest' => 'https://www.natwest.com/',
        'nationwide-building-society' => 'https://www.nationwide.co.uk/',
        'santander' => 'https://www.santander.co.uk/',
    ],

    // Affiliate links, keyed by bank slug, once a network approves you. A link set here is used for the
    // button on that bank's offer pages, marked rel="sponsored", and the disclosure is shown beside it.
    //   'barclays' => ['url' => 'https://…', 'network' => 'Awin'],
    'affiliate' => [],

    // Cashback-site referral links (refer-a-friend), shown on the cashback comparison.
    'referrals' => [
        'topcashback' => ['name' => 'TopCashback', 'site' => 'https://www.topcashback.co.uk/', 'url' => 'https://www.topcashback.co.uk/ref/phlwht99'],
        'quidco' => ['name' => 'Quidco', 'site' => 'https://www.quidco.com/', 'url' => 'https://quidco.com/raf/1078842/'],
        'krak' => ['name' => 'Krak', 'site' => 'https://support.krak.app/articles/krak-salary-match', 'url' => 'https://krak.app/@TheFlash'],
    ],

    'dataFile' => __DIR__ . '/data/offers.json',
    'outDir' => dirname(__DIR__) . '/public-site',
];
