# The booking model (v7)

What the dashboard's booking model does, what it learns from your own records, what it simply assumes, and what you
need to keep up to date for it to stay right. Written for checking the assumptions, not for reading the code.

Code: `js/features/bookingmodel.js` (the live model, v7). `js/features/guestprice.js` holds the guest-price maths.
`js/features/bookingmodel-v6.js` is a frozen copy of the previous model, kept only so the self-test and backtests can
compare the two; nothing in the app runs it.

## What it simulates

The model plays out the coming weeks many times over (1,500 runs for a booking request, 3,000 for the projection of
empty nights). In each run, booking requests arrive for every room and every check-in date, at a rate that follows
the season. Each one has a stay length, a lead time (how many days ahead it was made) and a weekday, all drawn from
your own history. A simulated host takes each request by a fixed rule: it has to fit the free nights, meet the minimum
stay (or exactly fill a gap), and not leave a gap shorter than the minimum stay unless it arrives within 7 days.

It is used three ways:

- **Booking evaluator** (a real request): two futures are compared over the nights around the request. *Accept*: the
  payout (allowing for a cancellation, late or early) plus whatever still books the free nights either side. *Reject*:
  whatever books the whole free stretch. Both count cleaning, changeover hassle and what an empty night is worth to
  you. Both use the same random arrivals, so the difference between them is steady even when each total is uncertain.
- **Projection of empty nights**: what the free nights from today are expected to earn, and how many are expected to
  stay empty. Saved projections are scored later in Model review.
- **Long-let check**: the short-let income the same room is expected to earn over a long let's dates.

Every money figure is **received money**, after all Airbnb fees, because that is what your income records hold. No
Airbnb guest or host fee is modelled.

## What it learns from your data

| Input | Learnt from | Held towards a starting assumption by |
|---|---|---|
| Raw nightly rate per room (weekday / weekend) | What stays paid (the earnings export first), with the cleaning fee taken out and the discounts undone | A room's own price boxes in Settings override it |
| Cleaning income per stay | Median cleaning fee in your earnings export | The room's own "Cleaning fee guests pay" box overrides it |
| Request rate (demand level) per room | Requests, enquiries and instant bookings, divided by how many dates were open to be asked for each week (last 104 weeks) | 3 pseudo-requests at an occupancy-based start (`LEVEL_PRIOR_K`); each month held towards London's shape by 5 (`MONTH_SHRINK_K`) |
| Seasonal shape | Your rooms' own months, then your other rooms' months | London's seasonal shape from Inside Airbnb (`marketdata.js`) where neither has evidence |
| Lead times | Your requests and stays | Settings → "When bookings arrive" medians; spread held at 1.3 by 10 pseudo-requests |
| Stay lengths | Your requests and stays | A rule of thumb (a stay twice as long is half as common) by 10 pseudo-requests per length |
| Weekday of check-in | Your stays | 3 pseudo check-ins per weekday |
| Cancellations | Your cancelled stays | 8% (10 pseudo-stays), 30% of them late |
| New-listing and Superhost price effect | Your own before/after change, once there are 4+ stays each side | The stage priors (below), 8 pseudo-stays |
| New-listing and Superhost demand effect | Your request rates before/after, once 10+ each side | No effect (1), 20 pseudo-requests |
| Review correction | Model review applies a demand factor from recent requests | 1 (no correction) |

## What it assumes (every unsourced number)

**Set in Settings → Booking evaluator** (stored in `data.prefs.bookingEvaluator`, defaults in `js/state.js`
`DEFAULT_PREFS.bookingEvaluator`):

| Number | Default | Source |
|---|---|---|
| Extra room cleaned the same day | £30 | Your estimate |
| Changeover hassle | £15 weekday, £0 weekend | Your estimate |
| Empty night worth to you | £25 Sun–Thu, £40 Fri–Sat; a second empty room 50% | Your estimate |
| Direct booking weight / guest with no reviews / low-rated guest | ×1, ×0.95, ×0.85 below 4.5 stars | Guesses |
| Late cancellation | within 5 days still pays 50% | Airbnb policy as you set it |
| Lead-time medians by month | 17–35 days; Christmas 300 | Guesses, blended with your data |
| Hidden 1-night demand | +10% | A guess: your own history cannot show it |
| Discounts (shared and per listing) | As read from Airbnb on 14 Nov 2026 | Airbnb settings |
| Gap discount | 15% on gaps of 2 nights or fewer | Your setting |
| New-listing discount | 15% before the 3rd review | Airbnb's promotion |
| Top-rated guests' share of bookings | 30% | A guess |
| Stage priors: nightly rate with no rating / as Superhost | −16% / +14% against a rated listing | Unsourced third-party ranges (midpoints) |
| v6 price sensitivity | 1.5 | A guess. v7 uses it only to keep demand at today's discounts where v6 put it |
| **Room type per listing** | Double: shared bathroom; the other two: en-suite | Airbnb settings 14 Nov 2026 and your answer |
| **Cleaning fees per listing (listed)** | Double £75 (£55 short stay); the other two £95 (£75 short stay) | Airbnb settings 14 Nov 2026 |
| **Short stay is up to** | 2 nights | An assumption: check Airbnb's fee page wording |
| **Price sensitivity to the all-in price** | En-suite −1.0, shared bathroom −1.8 | Unsourced (PRICING-PLAN.md section E): a prior only |
| **Month multiplier on it** | ×1.2 Jan–Mar and Nov, ×0.8 Jun–Aug, ×1.0 otherwise | An assumption of this build |
| **Short notice multiplier** | ×1.2 within 7 days | An assumption of this build |
| How sure the prior is | standard deviation 0.5 | An assumption; matters once fits exist |

**Fixed in the code** (`js/features/bookingmodel.js`, constants at the top):

| Number | Value | What it is |
|---|---|---|
| `LIVE_BEFORE_FIRST_ASK` | 7 days | A listing went live this long before its first request |
| `REVIEW_LAG_DAYS` | 4 days | A review appears this long after checkout |
| `NEW_STAGE_DAYS_PER_REVIEW` | 15 days | A listing short of 3 reviews gains one this often |
| `UNDATED_BOOKING_LEAD` | 14 days | A short stay with no booking date was booked this far ahead |
| `LONG_LET_LEAD_DAYS` | 30 days | A long let with no booking date held its nights this far ahead |
| `PRICE_HALF_LIFE_DAYS` | 180 days | A price sample counts half as much every 180 days |
| `PAST_MIN_NIGHTS` | 5 | Minimum stay assumed before shorter requests started appearing |
| `LAMBDA_MAX` | 4 | Ceiling on requests per check-in date |
| `LEAD_SIGMA_PRIOR` | 1.3 | Spread of the lead-time curve (Airbnb-wide figure) |
| `CANCEL_PRIOR` | 8%, 30% late | Starting cancellation rate |
| `OCC_PRIOR` | 60% | Starting occupancy with no data |
| `DEFAULT_PRICE` | £80 | Nightly price with no data at all |
| `LOS_MAX` | 28 nights | Longest simulated stay |
| `SIB_TRUST`, `MARKET_TRUST` | 0.6, 0.5 | How far a thin month follows your other rooms / London |

## What changed from v6 to v7, and why

**v6**: a guest responded only to the discount, through one sensitivity (1.5) for every room, month and lead time.
The cleaning fee and the room type made no difference to demand.

**v7**: a guest responds to the **all-in price per night**: the nightly rate after the short-notice, length and any
gap or void-plan discount, plus the cleaning fee spread over the nights. The sensitivity depends on the room type
(shared bathroom more sensitive), the month of the stay and short notice. So a cleaning fee now weighs more on a
2-night stay than a 14-night one, and a cut moves a shared-bathroom room more than an en-suite one.

**What v7 keeps from v6**: the demand level and the stay-length mix at today's settings. A reference price is solved for
each room, check-in date and stay length so that, at your stored discounts and cleaning fees, the expected bookings
equal v6's exactly. Only the response to a *change* in price differs. The backtest on your data confirmed it: v7 sits at
v6's level (both 1.01), with a marginally higher error. The random draws are seeded as v6's were (the new settings are
left out of the seed), so a v6/v7 difference comes from the model, not reshuffled randomness, and editing a cleaning
fee or the sensitivity does not reshuffle them either.

**Cleaning fees, listed and received**: the fees in Settings are what Airbnb shows guests. The model scales them to
received money by one factor per room: the room's calibrated cleaning income over its listed per-stay fee. At today's
settings a normal stay therefore pays exactly what your stays have paid, and the short-stay fee keeps its proportion.

**Fixed while going live**: the room types and cleaning fees are stored under the Airbnb listing id (from the calendar
link), but the model looks rooms up by the dashboard's own listing record id. The candidate build never matched them,
so every room was treated as en-suite and no short-stay fee applied. v7 now re-keys them the same way the per-listing
discounts already were. The demand level is unaffected (it is solved to equal v6's either way); the Double's response
to a price change, and every room's short-stay cleaning fee, now count as intended. The live backtest ran before this
fix.

## Known limitations

- **A change to the nightly rate itself does not move demand.** The reference price follows the base price, so raising
  or lowering the nightly rate changes income per booking but not how many bookings arrive. That waits for the hotel
  reference prices (phase 6 of PRICING-PLAN.md). Discounts, the cleaning fee and what-ifs do move demand.
- **The whole stay is priced at its check-in night.** A stay that runs from a cheap month into a dear one, or across a
  weekend, is priced at the first night's rate.
- **Top-rated-guest and new-listing discounts are not in the guest price.** They are undone on past stays to get the
  raw rate, but the price a simulated guest responds to leaves them out.
- **The extra-guest fee is folded into the received nightly rate** until guest counts are captured on each stay. A
  rate learnt from stays with extra guests reads slightly high for a single guest.
- **The price sensitivity is unsourced.** All of it (room type, season, short notice) is a starting figure until fits
  from the price ledger replace it (`elasticityPrior.fits`, empty for now).
- **The simulated host is simpler than you.** It accepts by a fixed rule, so the "reject" future is slightly
  undervalued: a mild lean towards accepting.
- **Discounts are taken as always having been today's.** Only today's Airbnb settings are known, so past stays are
  undone as if they had always applied.

## What keeps it correct

- **Settings → Booking evaluator → Guest price (model v7)**: one row per Airbnb listing. Keep each listing's room type
  and its cleaning fees (per stay, short stay, and how many nights count as short) the same as on Airbnb. Enter the
  listed amounts, not what you receive.
- **Settings → Booking evaluator → Discounts, per Airbnb listing**: keep the steps the same as on Airbnb.
- **Settings → Airbnb listings**: every listing needs its Airbnb calendar link; the Airbnb id in it is how the model
  matches a listing to its fees, room type and discounts.
- **Earnings exports**: import them regularly (Finances → Letting income). They are where the raw rates and cleaning
  income come from.
- **Booking requests and stays**: record requests (including declined ones) and stays with their booking dates. The
  demand level, lead times and stay lengths are learnt from them.
- **Times a room wasn't offered**: add them, or an empty spell reads as nobody wanting the room.
