# Bank-switch advisor — deploy

A separate, invite-only app for a couple of other people to use the same
bank-switch-bonus logic your own dashboard already has — without touching
your personal dashboard data. See the original plan this was built from:
`.claude/plans/eager-jumping-whistle.md` (one directory above `dashboard/`).

There is now exactly ONE place that scrapes MoneySavingExpert's
switch-offers page and the CASS participant list: this app's own
`switchadvisor-scan.php`. Your personal dashboard's `js/features/
switchoffers.js` reads the SAME scraped result (once `SWITCHADVISOR_URL`
is set there — see step 6) instead of running its own second scrape, so
the two never drift into disagreeing about what's currently on offer.

## 1. Upload the two PHP files

1. Copy `switchadvisor.php.example` → `switchadvisor.php` and
   `switchadvisor-scan.php.example` → `switchadvisor-scan.php`.
2. In `switchadvisor.php`, set `$ADMIN_SECRET` (generate with the same
   PowerShell one-liner the main README gives for `sync.php`'s secret).
3. Upload both files to `public_html`, next to `sync.php`/`commands.php`.
   `switchadvisor-data.json` and `switchadvisor-cache.json` will be
   created automatically, one directory above `public_html` — not
   web-reachable, same as `dashboard-data.json`.

Both real files are gitignored (see the root `.gitignore` entries added
alongside this folder) — only the `.example`s are tracked, same rule as
every other secret-carrying file in this repo.

## 2. Seed the cache with real data (one-time, optional but recommended)

`switchadvisor-cache.seed.json` in this folder has real MSE switch
offers and the real CASS participant list, fetched live on 2026-10-22
when this was built. Upload it as `switchadvisor-cache.json` (one
directory above `public_html`, next to where `switchadvisor-data.json`
will appear) so the app has real data from day one instead of waiting a
week for the first cron run. The Kraken tier figures in it are **seeded
from your own stated figures, not yet confirmed by a real scrape** — see
its own `krakTiersSource` field; set `$KRAKEN_TERMS_URL` in step 4 and
run a scan once you have the real terms page URL.

## 3. Pair the scan script as its own home-agent device

`switchadvisor-scan.php` needs a `commands.php` credential of its own —
a revocable device token, not your master dashboard secret, same
reasoning as the home-agent's own `.env.example`:

```bash
curl -s -X POST "https://yourdomain/pair.php?action=start" \
  -H "X-Sync-Secret: YOUR_DASHBOARD_SECRET"
# -> {"code":"ABCD-EFGH", ...}

curl -s -X POST "https://yourdomain/pair.php?action=redeem" \
  -H "Content-Type: application/json" \
  -d '{"code":"ABCD-EFGH","label":"switchadvisor scan"}'
# -> {"token": "...", ...}  <- paste this into $COMMANDS_SECRET below
```

## 4. Configure `switchadvisor-scan.php`

Fill in:
- `$SCAN_SECRET` — a new random string, the trigger secret (step 5).
- `$COMMANDS_URL` — your dashboard's own `commands.php` URL.
- `$COMMANDS_SECRET` — the token from step 3.
- `$ANTHROPIC_API_KEY` — from console.anthropic.com. This is the only
  place in the whole app that spends AI tokens, at most weekly.
- `$KRAKEN_TERMS_URL` — optional, leave blank until you have the real
  URL for Kraken's own tiered-reward terms page.

## 5. Weekly cron job

cPanel → Cron Jobs → Add New Cron Job, once a week:

```bash
wget -q -O /dev/null "https://yourdomain/switchadvisor-scan.php?secret=YOUR_SCAN_SECRET"
```

You can also trigger it by hand any time by visiting that same URL.

## 6. Point the personal dashboard at the shared scrape

In `dashboard/js/features/switchoffers.js`, set:

```js
const SWITCHADVISOR_URL = 'https://yourdomain/switchadvisor.php';
```

Bump `sw.js`'s `CACHE_NAME` and `index.html`'s build-stamp (the usual
deploy ritual — see `CLAUDE.md`), commit, push. From then on your own
"Check via home agent" button and the weekly automatic check both use
the shared scrape first, with the original AI-scan path kept as a
fallback if the shared app is ever unreachable.

## 7. Deploy the frontend

`public-switchadvisor/` is plain static files — no build step. Set
`API_BASE` in `public-switchadvisor/js/config.js` to your
`switchadvisor.php` URL, commit, push. GitHub Pages serves it at
`https://philgewhite-maker.github.io/dashboard/public-switchadvisor/`
automatically, the same as the rest of this repo.

## 8. Invite people

Open the deployed frontend, go to **Admin**, enter `$ADMIN_SECRET`,
create an invite with a label, and send the resulting link. Visiting it
is the whole sign-in flow — no password, ever (see
`switchadvisor.php`'s own header comment for why).

## Verifying it actually worked

Per the original plan's own verification steps:
1. Seed 2-3 test accounts via the UI and check the recommendation table
   looks sane against `switchadvisor-cache.seed.json`'s real offers.
2. Visit an invite link, close the browser, reopen it — you should still
   be logged in (cookie/localStorage). Re-click the original invite link
   after clearing site data — same account comes back.
3. Trigger `switchadvisor-scan.php` by hand (step 5) and confirm
   `switchadvisor-cache.json`'s `history` array grew by one entry.
4. Check the Kraken row recomputes as you change salary/balance in your
   profile, including the blank-balance "2 months' net salary" default.
5. `curl` the live `switchadvisor.php?action=banklist` from outside —
   don't just trust `git log`, per `CLAUDE.md`'s own standing rule.
