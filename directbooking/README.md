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

## Deploy to Krystal (about 20 minutes)

All steps are **in cPanel on Krystal** unless they say otherwise.

1. **Domain.** Add your new domain under Domains, with its *document
   root* set to `directbooking/public`. That's outside `public_html`, so
   the code, database and config are never web-reachable.
2. **Upload.** Upload this whole `directbooking/` folder to your home
   directory (File Manager, or `git clone` this branch over SSH, then
   copy the folder).
3. **Config.** Copy `config/config.example.php` to `config/config.php` and
   fill in:
   - the domain as `base_url`;
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
8. **Check it's live.** View the page source of `https://YOUR-DOMAIN/`.
   It should contain your site name in the `<title>`, and
   `https://YOUR-DOMAIN/robots.txt` should list `GPTBot`.

Before taking real money: switch `rates.source` to `ical` (paste each
listing's Airbnb calendar export URL into its `ical_url`) or to
`beds24`. Then set up Stripe as below, and switch `mail.transport` to
`mail` once the domain's mailbox exists. In cPanel > Email
Deliverability, fix SPF and DKIM with the "Repair" button.

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

- `public/`: web root. Published pages are written here, and
  `index.php` handles everything dynamic.
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
