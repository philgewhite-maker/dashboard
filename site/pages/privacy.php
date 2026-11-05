<?php
$meta = [
    'path' => '/privacy/',
    'title' => 'Privacy and cookies',
    'description' => 'What personal data ' . $CFG['siteName'] . ' collects (very little), how cookies and affiliate links work, and your rights under UK data protection law.',
    'crumbs' => [['/privacy/', 'Privacy and cookies']],
];
?>
<h1>Privacy and cookies</h1>
<p class="fine">This is a plain-English statement of how this site handles data. It describes the site as it is today and will be updated if that changes.</p>

<h2>Who is responsible</h2>
<p><?= h($CFG['publisher']) ?> (<?= h($CFG['publisherPlace']) ?>) is the data controller for this site. Contact: <a href="mailto:<?= h($CFG['contactEmail']) ?>"><?= h($CFG['contactEmail']) ?></a>.</p>

<h2>What we collect</h2>
<ul class="plain">
  <li><strong>Browsing this site.</strong> We do not ask you to register, and the pages do not run analytics or advertising trackers. Our web host keeps standard server logs (such as IP address, page requested and time) for security and to keep the site running.</li>
  <li><strong>If you email us.</strong> We keep your message and email address so we can reply, and delete them when they are no longer needed.</li>
  <li><strong>The planner.</strong> The invite-only planner is a separate tool with its own handling of data. Income figures you enter stay in your browser and are not stored on our server.</li>
</ul>

<h2>Cookies</h2>
<p>This site does not set cookies of its own. When you click an affiliate or referral link, the site you arrive at (the bank, a cashback site or an affiliate network) may set cookies to record that you came from us, so that we can be paid. Those cookies are set by them, under their own privacy policies.</p>

<h2>Your rights</h2>
<p>Under UK data protection law you can ask to see the personal data we hold about you, have it corrected or deleted, and object to how it is used. Email us to ask. You can also complain to the Information Commissioner’s Office (<?= ext('https://ico.org.uk/', 'ico.org.uk') ?>).</p>

<h2>Changes</h2>
<p>If we add analytics or anything else that uses cookies or collects more data, we will update this page and ask for your consent first where the law requires it.</p>
