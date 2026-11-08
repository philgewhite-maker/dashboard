# Direct booking site

A standalone site for booking Lewis's and Zara's London Bridge rooms
directly. It has request-to-book, payment through Stripe straight to each
room's owner, event pages with real TfL journey times, and an admin for
approvals. The plan is in the shared doc "Direct Booking Site — Build Plan
(Phase 0–1)".

It's plain PHP 8 plus SQLite: nothing to install and no database to create
on Krystal. It lives in this folder for now and will move to its own repo
(see the end of this file).

## What works now

- Room pages, a both-rooms page and four event pages (Wimbledon, The O2,
  Twickenham, Christmas lights), published as static HTML. Each page has
  structured data, plus a sitemap, a robots.txt that lets AI crawlers in,
  and llms.txt.
- Live quotes. Prices are the nightly rate less the direct discount, with
  event minimum stays and stricter cancellation policies on event dates.
  There's a multi-room discount, and long stays are split into monthly
  instalments. GBP by default; the guest can pick a G10 currency
  instead.
- Request-to-book:
  - Cards are authorised, then charged when the owner approves.
  - Wallets and Pay by Bank are paid after approval, by a link.
  - Bank transfers are marked received by hand.
  - Requests nobody answers expire automatically.
  - Cancellation refunds follow the booking's policy.
  - Both rooms means one checkout per owner.
- Admin at `/admin`:
  - Sign in by an emailed link.
  - Approve or decline requests, mark payments received, cancel with the
    refund shown first.
  - Approval queue for TfL routes and next year's events.
  - Content editor and a Publish button.
  - Setup checklist, including a button that makes each host's Stripe
    sign-up link.
- Scheduled jobs: request expiry, instalment emails, calendar refresh,
  exchange rates, and roll-forward of yearly events.
- Until accounts exist, the providers run in fake mode. **Test mode**
  (`payments.gateway = fake`) gives a clickable pretend checkout.
  `rates.source = local` or `ical` handles calendars until Beds24 is
  connected.

`php tests/run.php` runs 91 checks covering pricing, refunds, every
payment path, double-booking, expiry, publishing and webhooks.

## Not built yet / to verify

- **Beds24.** The client is written from Beds24's v2 docs but untested
  against a real account. The first job once the account exists is to
  confirm which booking status blocks Airbnb (`beds24.hold_status`).
- **Stripe.** Untested with real keys. Start with `sk_test_` keys,
  Connect test accounts and the Stripe CLI webhook forwarder before going
  live.
- **Photos.** None yet. Upload them to `public/photos/` and list them in
  each listing's `data.photos` as `[{"src": "/photos/x.jpg", "alt": "..."}]`.
- **Day 2 items in the plan:** ID checks, whole-flat product, area
  guides, extras page, Revolut Pay, Kakao/Naver Pay, USDT.

## Sites (brands)

One install serves several branded sites from the same rooms, admin and
database. The host name picks the site. Each site has its own:

- name, colour and headline;
- room list, in its own order;
- event pages, or none;
- noindex switch;
- wording for any record.

To give a record different wording on one site, add a `sites` block to
its `data`:

```json
{"summary": "King bed, ensuite...", "sites": {"katsu": {"summary": "Your own ensuite room, with Katsu for company"}}}
```

| Site | Temporary address | Lists | Events |
|---|---|---|---|
| `rooms`: London Bridge Rooms | rooms.georgewhiteeuropean.co.uk | both rooms + the pair | yes (canonical on `stays`) |
| `katsu`: Stay with Katsu | katsu.georgewhiteeuropean.co.uk | ensuite room only | none |
| `stays`: London Event Stays | stays.georgewhiteeuropean.co.uk | everything, later other hosts' rooms too | yes (their home) |

How the details work:

- **Duplicate content.** Event pages appear on more than one site, so
  only one copy is canonical: `events_home`, here `stays`. The other
  copies point search engines at it.
- **noindex while temporary.** All three are noindex
  (`indexable = 0`), so search engines don't build up ranking on
  addresses you'll replace. Flip `indexable` to 1 per site in
  `/admin` > Content > Sites once a site has its real domain.
- **Moving to a real domain.** Point the new domain's document root at
  `directbooking/public`, change the site's `base_url`, and add a 301
  redirect from the old subdomain.
- **Stripe's checkout page shows the room owner's Stripe name, not the
  site's brand.** That's because Stripe charges on the owner's own
  account.

## Deploy to Krystal (about 20 minutes)

All steps are **in cPanel on Krystal** unless they say otherwise.

1. **Addresses.** Under Domains, create the subdomains `rooms`, `katsu`
   and `stays` of georgewhiteeuropean.co.uk, each with *document root*
   `directbooking/public`. All three share one root, outside
   `public_html`, so the code, database and config are never
   web-reachable. If the domain's DNS isn't on Krystal, add an A record
   for each subdomain where the DNS is hosted. Then check SSL/TLS Status
   shows a certificate for each.
2. **Upload.** Upload this whole `directbooking/` folder to your home
   directory (File Manager, or `git clone` this branch over SSH, then
   copy the folder).
3. **Config.** Copy `config/config.example.php` to `config/config.php` and
   fill in:
   - `site.base_url` as `https://rooms.georgewhiteeuropean.co.uk`
     (used for admin links and the cron URL);
   - a random `secret`;
   - your email, and Lewis's and Zara's, under `seed`.

   Leave `payments.gateway` as `fake` and `rates.source` as `local` for
   now.
4. **Setup.** In cPanel > Terminal (or over SSH), run
   `php ~/directbooking/bin/setup.php`. It creates the database, seeds the
   content, fetches exchange rates and prints your cron URL.
5. **Cron.** Under Cron Jobs, add the printed `wget ... /cron?key=...`
   line to run every 15 minutes.
6. **Routes.** Open the printed `...&task=routes` URL once. Then go to
   `/admin` and approve the TfL routes.
7. **Review and publish.** Clear every `[CHECK]` marker under `/admin` >
   Content, then press **Publish**. Publish refuses to run while any
   marker remains.
8. **Check it's live.** `https://katsu.georgewhiteeuropean.co.uk/`
   should have the title "Stay with Katsu: an ensuite room in London
   with a resident Maine Coon". `https://stays.georgewhiteeuropean.co.uk/events/`
   should list the events.

Before taking real money: switch `rates.source` to `ical` (paste each
listing's Airbnb calendar export URL into its `ical_url`) or to
`beds24`. Then set up Stripe as below, and switch `mail.transport` to
`mail` once the domain's mailbox exists. In cPanel > Email
Deliverability, fix SPF and DKIM with the "Repair" button.

## Demand: special offers from the dashboard's booking model

The dashboard's booking model saves each void projection in its own data
file on this host. For every free night up to the end of next month, a
projection holds the chance the night gets booked, the income it's
expected to bring, and, for dead voids, the fix the model found best.
The cron job copies the latest projection into `demand_nights`, read-only.
It matches each dashboard room to a listing here by Airbnb listing
number, or by `data.dashboard_room_key` on the listing.

| Use | What the site does |
|---|---|
| Special offer price | A night with under a 50% chance of booking is offered at its expected income if left empty, plus 10%. Never below £45, never more than 30% off the direct price. The quote shows it as "Special offer on quieter nights". |
| Shorter stays | In a dead void the model says sells better with shorter stays, the calendar's minimum is relaxed to the model's figure. |
| Highlight offer dates | Each booking box lists the offer windows (`/api/offers`). Clicking one fills the dates. |
| Extend a stay | The quote suggests nights either side: quiet ones at the offer price, and any short gap the stay would strand, which nobody else could book. |
| Price the stay by its effect | Before anything is charged, the quote values what the stay does to its neighbours. If it strands nights nobody else can book (fewer than the minimum stay before the next booking), their expected income is added. That cost first takes back the offer discount, then becomes a "Short-gap adjustment" capped at 25% over the direct price, and the quote suggests adding those nights at the offer price instead. A stay that fits exactly between bookings gets 5% off, never below what its nights would bring if left open. |
| Re-offer lower | When the guest doesn't complete (card checkout abandoned, or not paid after acceptance), and the model says the dates would probably stay empty, they get one email offering the same dates 10% cheaper. The price is never below the nights' expected value and is held for 48 hours by a signed link for exactly those dates. Never sent after the owner declined or didn't answer; only once per guest and dates. |
| Re-price by hand | The admin can still approve at a lower total, and the card is charged less. |
| Airbnb, automatically | With Beds24 and `autopilot.enabled`, dead-void fixes go to the shared calendar. Limits: at most 20% off, at least £60 a night, within 45 days. Each change is logged at `/admin/adjustments` with undo, undone by itself when a newer projection stops calling the void dead, and reported to the dashboard. The direct site keeps pricing from the original price, so a cut isn't taken twice. |

Limits:

- **Stale projections.** A projection older than 7 days is ignored:
  offers pause rather than run on old guesses. The dashboard runs a
  projection only when asked (or after pushing a stay), so a weekly task
  reminds you while it's stale.
- **Rough price comparison.** The model's income figures are Airbnb
  payouts, while direct prices are before card fees, so the comparison
  is approximate.
- **Duplicate dead-void tasks.** The dashboard still creates its own
  Airbnb tasks for dead voids. With autopilot on, those are duplicates
  until the dashboard learns to skip them.

## Tasks in Phil's dashboard

With `dashboard.inbox_url` and `dashboard.secret` set in `config.php`,
the site proposes tasks into the personal dashboard's agent inbox. The
secret is `$AGENT_SECRET` from `agent-write.php`. All tasks go under one
"Direct booking site" project, in a "Bookings and site" group, and each
links straight to the admin page where it's done. After signing in you
land on that page.

| Task | When |
|---|---|
| Answer a booking request (due = the auto-decline time) | Immediately |
| Block the dates on Airbnb (only while not on Beds24) | Immediately, on confirmation |
| Check a bank, Revolut or USDT payment arrived | When the guest is sent the details |
| Review proposed changes (TfL routes, next year's events) | Weekly, while any are waiting |
| Publishing blocked by `[CHECK]` items | Weekly, while blocked |
| Events with no confirmed date, or within 4 months with no event rules | Monthly |
| Travel times over 6 months old | Quarterly (TfL times also refresh themselves quarterly) |
| Direct pricing check: discount, long-stay and event rules | Quarterly |
| A scheduled job failing | Once a day while it fails |
| The void projection is over a week old (offers paused) | Weekly while stale |
| An autopilot change made on Airbnb (with undo link) | Immediately |

Each task is keyed, so nothing is proposed twice in its period. If the
dashboard can't be reached, the task waits in `inbox_outbox` and the next
cron run sends it.

The inbox has one limit: it only accepts *new* proposals. Something
handled in the booking-site admin isn't ticked off in the dashboard by
itself; the task's link shows its current state. Nightly prices aren't
reviewed here, because the dashboard's own quarterly Airbnb rate review
already does that.

## Stripe setup

1. Phil: open the platform Stripe account and turn on **Connect** in its
   settings.
2. Put the `sk_test_...` key in `stripe.secret_key` and set
   `payments.gateway` to `stripe`.
3. Add a webhook endpoint `https://YOUR-DOMAIN/api/stripe/webhook`
   listening to **connected accounts**. Events:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.expired`

   Put its `whsec_...` in `stripe.webhook_secret`.
4. In `/admin` > Setup, press **Make a Stripe sign-up link** for Lewis,
   then Zara, and send each their link. Each of them completes ID and
   bank details on Stripe's own pages. Their payouts go to their own
   bank (e.g. their Revolut).
5. Each owner turns on Alipay, WeChat Pay and Pay by Bank in their own
   Stripe dashboard (Settings > Payment methods).
6. Test a booking end to end in test mode, then swap to live keys.

## Moving to its own repo

Create an empty repo (e.g. `direct-stays`), then run this on any machine
with this repo checked out:

```bash
git subtree split --prefix=directbooking -b directbooking-only
```

```bash
git push git@github.com:philgewhite-maker/direct-stays.git directbooking-only:main
```

## Layout

- `public/`: web root, holding only the assets and `index.php`. Published
  pages are in `data/published/<site>/`, served by host name.
- `src/`: one class per file:
  - `Pricing`, `Bookings`, `Cancellation`, `Publisher`, `Admin`
  - providers: `Beds24Rates`, `IcalRates`, `LocalRates`,
    `StripeGateway`, `FakeGateway`
  - `Tfl`, `Cron`, `Fx`
- `views/`: page templates.
- `seed/content.php`: Day 1 content. Anything unconfirmed is marked
  `[CHECK]`.
- `bin/`: `setup.php`, `cron.php`, `publish.php`.
- `data/`: SQLite database, logs and sessions (gitignored).
