# Switch advisor: open site (for affiliate approval and search)

A crawlable, no-login site generated from the same structured data the planner uses. The planner
stays the interactive, invite-only tool; this site is the public face that explains, compares and
sends people on.

## How it is built

```
weekly scan -> server cache -> ?action=public-offers (public, read-only, cached 1h)
                                      |
                       php site/build.php --source=URL
                                      |
                              public-site/  (plain static HTML, CSS, sitemap.xml, robots.txt)
```

- `site/config.php`: brand, domain, contact, affiliate links, sections switched on.
- `site/lib/`: formatting, data derivation, page blocks, layout (head tags, JSON-LD, footer).
- `site/pages/*.php`: one template per page. Offer pages are one template run once per offer.
- `site/build.php`: renders everything. `site/check-links.php`: every link resolves, one `h1`, title and
  description on every page, outbound links carry `noopener`.
- Draft mode (`'draft' => true`): `noindex`, `Disallow: /`, and a banner. The build refuses to switch
  draft off while a `CHANGE-ME` placeholder is left.

Why static HTML: reviewers and crawlers see real content with no scripts, it loads fast, and it can be
hosted anywhere (the existing web host, GitHub Pages with a custom domain, Netlify).

## Site map

| Path | Content | Driven by data |
|---|---|---|
| `/` | Value proposition, trust strip, top 5 offers, how it works, guide cards, planner CTA | counts, min/max bonus, top offers |
| `/bank-switch-offers/` | Table of every offer; "no salary test" list | all offers |
| `/bank-switch-offers/<offer>/` (one per offer) | At a glance, what to do (from requirements), when you are paid, who cannot get it, fees and extras, terms as extracted, same-group warning, comparison table, CTA | one offer's fields |
| `/guides/` | Index | none |
| `/guides/current-account-switch-service/` | What CASS is, how a switch runs, the guarantee, FSCS protection, limits, checklist, participating banks, FAQ, sources | CASS participant list, share of offers needing a full switch |
| `/guides/switch-bonus-requirements/` | Salary, pay-in, balance, card tests, "must stay", instalments, worked timeline | salary and pay-in tables, instalment list, example offer |
| `/guides/direct-debits-for-switch-offers/` | Why 2-3, what counts, per-offer count table, creating missing ones, timing | DD counts per offer, range |
| `/guides/how-a-switch-bonus-works/` | Life of a bonus, banking groups, past accounts, deadlines, credit file | bank groups, deadlines |
| `/cashback-sites/` | TopCashback vs Quidco per account, how to make it track, referral links | cashback deals |
| `/ongoing-accounts/` | Bills/everyday cashback accounts, Krak tiers, yearly perks | ongoing accounts, Krak tiers, perks |
| `/isas/` (off by default) | ISA transfer how-to, timings; fee comparison to come | none yet |
| Trust pages | `/about/`, `/how-we-make-money/`, `/how-we-get-our-data/`, `/contact/`, `/privacy/`, `/terms/`, `404`, sitemap, robots | config |

Adding a section = a new template in `site/pages/`, a line in the page list in `build.php`, and (for a data
section) a new key in the feed. ISA fee and rate comparison would follow the offers pattern: extract to
structured fields weekly, generate an index table and per-provider pages.

## What an affiliate network reviewer looks for (checklist)

- [ ] **Its own domain** (not a `github.io` path), HTTPS, a name that is not a placeholder.
- [ ] **About page naming who runs it**, a monitored contact email, a UK location.
- [ ] **Clear affiliate disclosure** near every paid link and on `/how-we-make-money/` (done in templates;
      paid links carry "Ad", `rel="sponsored"`).
- [ ] **Original, substantial content**: four guides, per-offer pages, comparisons (done; the guides run about 700-1,300 words
      each, and more depth on the money-in and Direct Debit guides would help).
- [ ] **No login wall**, working navigation, no dead links (checked by `check-links.php`).
- [ ] **Privacy and cookie statement, terms of use** (templates written; have them reviewed).
- [ ] **Accurate, non-misleading finance claims**: nothing says "best" or "guaranteed" about a bonus; the
      guarantee language is about CASS and attributed to Pay.UK; every guide cites primary sources.
- [ ] **Regulatory position stated truthfully** (see open questions: this one needs a human answer).
- [ ] Some traffic or an indexed history: many networks want to see a live site that has been up for a while.

## Things that could sink an application, in order

1. **Financial promotions rules.** Current accounts are regulated products. The FCA treats a promotion
   containing a firm's referral link as that firm's communication, and affiliates are inside its social-media
   and affiliate-marketing guidance. Networks with financial advertisers usually ask affiliates to confirm
   their regulatory status and may require approved wording. I could not verify the specific rules for
   deposit-account promotions from the sources I found, so this needs a compliance check (the networks'
   own financial-services policies, and a regulated promotions approver if needed) before you apply.
2. **Where the data comes from.** The extraction reads comparison-guide listings (MoneySavingExpert) as well
   as bank pages. A public, monetised site should rest on the banks' own terms. Plan to add a "checked
   against the provider's terms on <date>" step per offer and link each offer to the provider's own terms
   page rather than the comparison guide. Also check the source's terms of use for republishing.
3. **Placeholders.** Name, domain, publisher, contact email are all `CHANGE-ME`.
4. **Thin or unchecked claims** on pages that go beyond the data. Every guide statement beyond the
   structured data is sourced to Pay.UK, the FSCS or the Bank of England, or phrased as "check the terms".

## Operating it

- Weekly: after the scan, run `php site/build.php --source=<feed URL> --refresh`, check, publish `public-site/`.
  This could be a scheduled job on the NAS (which already runs the scan) or a scheduled GitHub Action.
- When a network approves you, add the link in `config.php` under `affiliate` keyed by bank slug (for
  example `'barclays' => ['url' => '...', 'network' => 'Awin']`). The offer pages then use it, mark it as
  an ad and show the disclosure.
- Analytics: none yet, so no cookie banner is needed. If you add any, update `/privacy/` and add consent.

## Open decisions

1. Brand name and domain (and whether it lives on the existing web host or a new one).
2. Who is the publisher (a person or a company) and which email to show.
3. Whether you are, or will be, FCA authorised or use an authorised approver for promotions.
4. Which networks to apply to first, so the per-bank links can be wired.
