# The booking model (v9)

What the dashboard's booking model does, what it learns from your own records, what it simply assumes, and what you
need to keep up to date for it to stay right. Written for checking the assumptions, not for reading the code.

Code: `js/features/bookingmodel.js` (the live model, v9 since 17 Nov 2026; the v8 rows below say what v9 changed). `js/features/guestprice.js` holds the guest-price maths.
`js/features/bookingmodel-v8.js` and `js/features/bookingmodel-v6.js` are frozen copies of earlier models, kept only so
the self-tests and backtests can compare them; nothing in the app runs them.

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
| Cleaning income per stay | Median cleaning fee in your earnings export. **v8**: the median of every row, and every simulated booking is credited this one figure whatever its length, while the guest price charges the short-stay fee on short stays (audit finding 3; a room where most rows are short stays gets the short-stay fee as its "per-stay" figure). **v9**: the median of the rows longer than the short-stay limit (3+ of them), and a simulated short stay is credited the short-stay fee | The room's own "Cleaning fee guests pay" box overrides it |
| Request rate (demand level) per room | Requests and instant bookings, divided by how many dates were open to be asked for each week. **v8**: enquiries count only towards the stay-length and weekday mixes (at 0.3), not the level (audit finding 4); **v9** counts them at that weight in the level, its month adjustment, the lead-time fit and the stage demand. The weeks counted run from the room's first request, 104 at most. **v8** counts every week since then, so a gap between an old listing going quiet and a new one going live reads as weeks nobody wanted the room unless a "not offered" spell covers it (audit finding 2); **v9** leaves out the weeks of a month with no stay and no request, as the occupancy calibration already does | 3 pseudo-requests at an occupancy-based start (`LEVEL_PRIOR_K`); each month held towards London's shape by 5 (`MONTH_SHRINK_K`). **v9**: the other rooms' pooled rate instead of the occupancy start, see the v9 section |
| Seasonal shape | Your rooms' own months, then your other rooms' months | London's seasonal shape from Inside Airbnb (`marketdata.js`) where neither has evidence |
| Lead times | Your requests and stays, **all rooms pooled** (one shift and one spread for the house) | Settings → "When bookings arrive" medians; spread held at 1.3 by 10 pseudo-requests |
| Stay lengths | Your requests and stays, **all rooms pooled** (one curve) | A rule of thumb (a stay twice as long is half as common) by 10 pseudo-requests per length |
| Weekday of check-in | Your stays, **all rooms pooled** (one mix) | 3 pseudo check-ins per weekday |
| Cancellations | Your cancelled stays, **all rooms pooled**. The rate applies only to the request the evaluator is judging (late or early, with the late-cancel payout). **v8**: the projection of empty nights never cancels a simulated booking, so its nights run a little above what stays booked (audit finding 6); **v9** cancels simulated bookings at this rate and re-offers their nights | 8% (10 pseudo-stays), 30% of them late |
| New-listing and Superhost price effect | Your own before/after change, once there are 4+ stays each side | The stage priors (below), 8 pseudo-stays |
| New-listing and Superhost demand effect | Your request rates before/after, once 10+ each side | No effect (1), 20 pseudo-requests |
| Review correction | Model review applies a demand factor from recent requests | 1 (no correction) |

Only the demand level, its month adjustment, the price and the seasonal occupancy shape are per room; the rest of the
table is learnt from all rooms' records pooled (PRICING-PLAN.md section D).

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
| Lead-time medians by month | 17–35 days; Christmas 300 | Guesses, blended with your data. The Christmas figure has a cliff (audit finding 5): 20 Dec – 2 Jan sits on its own curve with a 300-day median that the fitted shift does not move, so from mid-November the model treats those dates as 95% already booked or never to be (a request for them has almost no simulated competition), while 19 Dec and 3 Jan are on the ordinary December / January curves. Check your own Christmas requests' lead times before trusting it; not changed in v9 |
| Hidden 1-night demand | +10% | A guess: your own history cannot show it |
| Discounts (shared and per listing) | As read from Airbnb on 14 Nov 2026 | Airbnb settings |
| Gap discount | 20% on gaps of 1 to 3 nights (`gapDiscountPct` 20, `gapMaxNights` 3) | Your setting |
| New-listing discount | 15% before the 3rd review | Airbnb's promotion |
| Top-rated guests' share of bookings | 50% | Your estimate (probably 50% or more) |
| Stage priors: nightly rate with no rating / as Superhost | −16% / +14% against a rated listing | Unsourced third-party ranges (midpoints) |
| v6 price sensitivity | 1.5 | A guess. v7/v8 use it only to keep demand at today's discounts where v6 put it (which is the double count of audit finding 1, below); v9 does not read it in the guest response at all |
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
| `PRICE_HALF_LIFE_DAYS` | 60 days | A price sample counts half as much every 60 days (180 before v907) |
| `PRICE_OPTS.deseason` | on | Each price sample is divided by its month's index before the base is taken, so the base is season-neutral and the month index is not applied twice (v907) |
| `PRICE_MARKET_GAMMA` | 0.3 | The month price index is held towards London's seasonal shape to this power (5 pseudo-stays), so a month with few or none of your stays still has a season (v907) |
| `PRICE_OPTS.interp` | on | The month index is read as a curve through the month midpoints (log-linear between the two nearest, December wraps to January) instead of a step on the 1st; off on the v906 basis the old self-tests use (v912) |
| `EVENT_MAX_NIGHTS` | 10 nights | A yearly calendar event this short or shorter is "in the history" (its stays are in the month index): uplift plus an offset. Longer: left to the season curve (v912) |
| `EVENT_OFFSET_DAYS` | 14 days | The offset window either side of an in-history event (v912) |
| `AUTO_DEMAND_K` | 60 nights | The demand factor bleeds in from scored nights: k^(n/(n+60)), k fitted from empty nights against forecasts normalised to factor 1, kept to 0.5–2; a factor you apply overrides it (v909) |
| `PAST_MIN_NIGHTS` | 5 | Minimum stay assumed before shorter requests started appearing |
| `LAMBDA_MAX` | 4 | Ceiling on requests per check-in date |
| `LEAD_SIGMA_PRIOR` | 1.3 | Spread of the lead-time curve (Airbnb-wide figure) |
| `LEAD_SIGMA_MIN`, `LEAD_SIGMA_MAX` | 0.7, 2 | Clamps on the fitted spread; the fit can sit on them (the seeded preview data sits on the 0.7 floor) |
| `LEAD_SHIFT_MAX` | 1.2 | Clamp on the fitted shift of the lead-time medians (log scale) |
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
v6's level (both 1.01), with a marginally higher error.

**This is the double count of audit finding 1 (v7 and v8, fixed in v9).** Keeping v6's level means a discounted
request is kept with a higher probability than an undiscounted one ((1 − discount)^−1.5), but the level, the stay-length
curve and the lead-time curve were learnt from requests that had already taken those discounts, so the simulation
applies the discounts' effect a second time: about +11% bookings for the Double (two short-notice steps, three length
steps), about +5% for En-Suite – Phil, plus a tilt of the mix towards longer and later stays (+7% nights at the Double's
steps). The monthly review's demand factor absorbs part of it after the fact. In v9 every request is kept alike at the
stored settings; the level, stay-length and lead-time mix are what your requests showed; only a change from those
settings (a what-if discount or cleaning fee, the gap discount, a void plan, or the market) moves demand. The random draws are seeded as v6's were (the new settings are
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

## What changed from v7 to v8, and why

**v7** priced a simulated stay, in the guest's all-in price, at its check-in night's rate for every night.
**v8** prices it night by night: the nightly part of the all-in price is the mean of the stay's own nights' rates (the
same per-night figure the price breakdown shows), plus the cleaning fee over the nights. A stay across a weekend or into
a dearer month now looks dearer to the guest. The reference price for each stay length is solved on the same basis, so
at today's settings the demand level and stay-length mix are still v6's for every check-in date (self-test). What
moves: the cleaning fee and discounts weigh a little less in a dearer stay's all-in price, so its response to a change
in them differs slightly, and the random draws part from v7's (the largest multiplier changes). The fallback
top-rated-guest share is now 50% (the saved setting already was).

## Yearly events calendar (v912)

Settings, Booking evaluator, Yearly events (`prefs.bookingEvaluator.events`): `{id, name, roomKey ('' = every room), rule 'fixed'|'nth'|'once', month, day, weekday, nth (1-4 or -1 last), date, nights, upliftPct}`. `eventOccurrences` turns one into day ranges; `eventFactorsAt(ctx, room, night)` gives the multipliers, used by both `basePrice` and `nightBreakdown` (after weekday and stage, before rate-review proposals).

- **Yearly, up to 10 nights**: the month index already holds past spikes of this kind (it learns from what stays earned), so a bare uplift would count twice. The event's nights take x(1+u); the other nights of the window (14 days either side) take x(1 - u k / (N - k)), k event nights, N window nights, so the window's average factor is exactly 1. Overlapping windows multiply.
- **Yearly, over 10 nights**: season, not an event. No uplift, no offset; the season curve carries it.
- **Once**: a plain uplift on its nights, no offset (it was never in the average).
- **Rate-review proposals** that overlap (same room, any night) an event that prices are ignored: the calendar wins. Others apply as before.
- **History check** (`eventHistoryCheck`): for each yearly event of up to 10 nights, your stays inside a past occurrence (at least half their nights) against stays starting in the window beside it, each against the season curve, give an implied uplift shown next to the one set (null with fewer than 2 event stays or 3 neighbours; flagged when 15 points or more apart).

## Known limitations

- **A change to the nightly rate itself does not move demand.** The reference price follows the base price, so raising
  or lowering the nightly rate changes income per booking but not how many bookings arrive. That waits for the hotel
  reference prices (phase 6 of PRICING-PLAN.md). Discounts, the cleaning fee and what-ifs do move demand.
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
- **The Superhost price prior (×1.14) is unsourced and one-directional** (audit finding 7). Every sample is put on the
  room's stage today, so with the room Superhost and the fit still at the prior, every earlier stay counts 14% above
  what it paid; the listing's own before/after is read only once 4+ stays each side of 1 Jan 2026 fall within 180 days
  of it, and even then it is held by 8 pseudo-samples. Small on the live rooms (recent samples carry most weight).
- **An accepted request's own booking removes its exposure in its own week** (audit finding 8). Availability is read on
  the Wednesday of each week while the request is counted on the day it landed, so a request accepted on a Monday has
  its own nights held by Wednesday. Leans the level up by a few percent; not patched.
- **The backtest's "actual"** is nights still booked today, booked after the as-of date. A "not offered" spell added
  later blocks the projection for that window (audit finding 10); true spells are fine, one added to explain a miss
  flatters the model.
- **Enquiries, cleaning fee per short stay, exposure weeks, cancellations in projections**: v8 limitations listed in the
  tables above (audit findings 2, 3, 4, 6), fixed in v9.

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

## v9 (live since 17 Nov 2026)

`js/features/bookingmodel.js` (MODEL_VERSION 9; 63 self-test cases). Live with **pooling and simulated cancellations
switched off** (`V9_DEFAULTS`), on the owner's approval after the per-fix backtest below. What it changes from v8:

**The market reference.** The guest-response reference becomes the market: the nearby-hotel basket median
(hotelbasket.js samples) times a per-cell ratio (month × check-in weekday × stay length). At today's prices the ratio is
solved so every cell expects exactly the no-market bookings (no level shift); with no usable hotel samples for a date
that date keeps the own-price reference. Once 8+ past stays have basket samples, the ratio learns your historical
price-to-market position, so being dearer against hotels than usual lowers demand. So a change to the nightly rate
itself now moves demand where there is a basket (the first known limitation above). `fitElasticity(ctx)` estimates each
room's price sensitivity from price changes in the price ledger (before/after request counts per change, ±14 days,
shrunk across rooms); not wired to settings yet.

**Partial pooling of the demand level** (`demandPool`). v8 held each room's level towards an occupancy-based start by 3
pseudo-requests; for a room with few requests (the Double) that simulated start decided the level. v9's prior for a
room's log level is the OTHER rooms' pooled request rate (requests over exposure, leave-one-out, as of the context's
date so a backtest sees no future) times a room-relative factor (its occupancy-based start against theirs, raised to
W / (W + 6), W its months of occupancy evidence), with a spread estimated across the rooms (floor 0.5 in log, so at most
4 pseudo-requests). The posterior keeps v8's closed form: L = (n + k) / (X + k / m) with m the house rate × factor and
k = 1 / (spread² + 1 / house requests). Where the other rooms have fewer than 10 requests, or there is one room, it is
v8's prior. A room with many requests is barely moved; a one-month-old room at the house's level is recovered far
better than from its own occupancy (self-test: RMSE of log level 0.2–0.3 against 0.6–1.5).

**The audit's fixes** (`js/features/bookingmodel-fixes.patch.md`, 16 Nov 2026), applied to v9 only:

1. *Discount boost counted twice.* The reference for a request of n nights in lead class i is its own all-in price at
   the stored settings, so every request is kept alike at the baseline (multiplier 1) and only a departure from the
   settings moves demand. v8's E6 (1.05–1.12 with discounts) is gone from request-calibrated rooms: expected about −11%
   bookings on the Double, −5% on En-Suite – Phil, and no tilt of the mix towards long and late stays. Rooms whose level
   still comes from the occupancy start are unmoved (that start was pre-boost); their mix is no longer tilted either.
   The market reference composes with it (ref = own all-in price × ratio × basket / nightly). A review demand factor
   fitted under v6–v8 was fitted on the inflated level and should be re-fitted after the first review on v9.
2. *Exposure weeks in unlisted months.* The exposure grid skips the weeks of a month with no stay night (long lets
   included) and no ask, as the occupancy calibration already does; the stage-demand weeks skip the same. One old stay
   two years back no longer halves a room's level by counting the dead weeks in between (self-test: 55 weeks against
   51, level within 5%; before, 104 against 51). The pooled house rate uses the same grids, so it composes. Trade-off:
   a listed month with genuinely no demand and no stay is dropped as evidence; "not offered" spells remain the precise
   tool. Expected: up for a room with a gap between listings or an early lone booking (check the Double's `from`).
3. *Cleaning income per booking.* A simulated booking is credited the received cleaning fee its guest was priced at
   (the short-stay fee on a short stay), and the calibrated per-stay figure (the scale factor's numerator) is the median
   of the earnings rows longer than the listing's short-stay limit when there are 3+, else of all rows. Expected: income
   per short booking down by (per-stay − short-stay) × scale (about £16 on each room at the stored fees); on a room
   where most rows were short stays the scale factor rises from about 0.73 to 1.
4. *Enquiries.* The code now does what the doc promised: an enquiry counts at `enquiryWeight` (0.3) in the level, the
   month adjustment, the lead-time fit and the stage demand (the stay-length and weekday mixes already did). The
   minimum-stay reading still takes requests only (an enquiry is not evidence of the minimum in force). Expected: up by
   the enquiry share × 0.3 on any room with enquiries.
6. *Cancellations in projections.* A simulated booking is cancelled with the calibrated probability (the rate the
   evaluator already applies to the request it judges), at a moment drawn uniformly between booking and check-in; its
   nights are held until then and re-offered after. Chosen over changing the backtest's "actual" because the owner sees
   the projection as nights that will stay booked and income that will be received, and the backtest's actual (nights
   still booked today) already means that; making the actual include cancelled stays would have matched the model to a
   figure nobody acts on. Not modelled: the late/early split of when they cancel. Expected: nights down by the
   cancellation rate net of re-booking (a few percent at 8%; at saturating demand almost nothing).

Left as documented limitations: 5 (Christmas lead), 7 (Superhost prior), 8 (ask's own week), 9 (Zara's Double dates:
check `priceTrace(ctx).stages`), 10 (backtest counting).

With no basket, v9 therefore no longer equals v8 (earlier candidate builds did): the self-test compares v9's no-basket
run with itself under unusable samples instead. The random streams are v8's except that an arrival takes one extra draw
(the cancellation) when the cancellation rate is above 0.

**Attribution switches** (`V9_FLAGS`, `setV9Flags`, 17 Nov 2026). Every v9 change can be turned back to v8's behaviour
for a backtest, one at a time, so a move in a room's figures can be attributed: `fix1` (own-price reference), `fix2`
(unlisted months' weeks skipped), `fix3` (cleaning fee per booking), `fix4` (enquiries in the level), `fix6`
(cancellations in projections), `pool`, `market`. `setV9Flags({ fix2: false })` sets them module-wide (the backtest
harness builds its own contexts); `ctx.v9flags` overrides per context. The app runs `V9_DEFAULTS` (`pool`, `poolW` and `fix6` off, the rest on;
`setV9Flags('default')` restores them); the self-test runs every switch on; with every
one off v9 is v8 exactly, draw for draw (self-test 41, on a three-room world with discounts, a gap in one
room's records, enquiries and a cancellation rate). Note that `fix2` also moves the shared lead-time fit, which reads
the same grids. Not a setting: nothing is read from the owner's data.

`poolW` (experimental, off in the app, 17 Nov 2026; only read when `pool` is on) changes the pooling's evidence weight
W_r, the one that sets how far a room's own occupancy-based start counts against the house rate (s_r = W_r / (W_r +
POOL_OCC_K)). Off, W_r is the booking-weighted occupancy evidence (the sum of `occ.byMonthW`), so a room on offer but
quiet reads as "little evidence" and is pulled hard towards the house rate: this is how the backtest's Double took
most of the En-Suite's demand (May/June projected 10-12 nights against 4). On, W_r is the room's months on offer
(`occ.months`), so a quiet month on offer counts as full evidence that the room sits where its own occupancy says
(POOL_OCC_K is reused as the half-weight point in months, an assumption). Self-test 42 shows the two on a two-room
world (a quiet room at a third of the house: s 0.8 against 0.5-0.6, the prior mean nearer its true rate on every seed,
the level pulled up less). Two limits seen while writing it: the prior holds at most 4 pseudo-requests, so a room with
20+ asks moves only a few percent whichever weight is used (it is the room with a handful of asks whose level the prior
mean decides); and at an extreme ratio (a twentieth) the weak relative factor under the booking weight leaves a wide
between-room spread, tau rises above its floor and that prior weakens by itself, so the two levels come out about the
same. Whether `poolW` should go live waits on a backtest of `{ pool: true, poolW: true }` against the defaults.

**Why pooling and simulated cancellations are off** (live backtest, 9 monthly as-of dates Dec 2025 – Aug 2026, 90-day
horizon; nights ratio / income ratio, mean absolute error in nights / £, months where actual income was inside the
projected range):

| Variant (all rooms) | Ratio | MAE | In range |
|---|---|---|---|
| v8 (1500 runs) | 0.88 / 0.92 | 7.0 / £817 | 9 of 9 |
| v9, every switch on (500 runs) | 0.90 / 0.93 | 8.3 / £778 | 7 of 9 |
| **v9 live: pool and fix6 off (1500 runs)** | **0.90 / 0.95** | 7.6 / **£802** | **9 of 9** |

Double alone: v8 0.66 / 0.62, v9 live 1.01 / 0.96. Pooling's evidence weight counts quiet months as little evidence, so
the Double borrowed most of the En-Suite's rate (May/June projected 10–12 nights against 4); weighting it by months on
offer instead is untried. Simulated cancellations pulled projections further below what stayed booked than the real
cancellations did. Removing the enquiry fix (fix4) drops the En-Suite to 0.75; removing the unlisted-weeks fix (fix2)
drops the Double to 0.49. The market reference had no effect (no hotel samples yet).

Unsourced constants (top of the file): 365-day market horizon, MARKET_FIT_MIN 8, MARKET_FIT_K 8, FIT_WINDOW_DAYS 14,
FIT_MIN_EVENTS 5, price changes outside ×0.5–×2 dropped, FIT_TAU_MIN 0.25, POOL_HOUSE_MIN_N 10, POOL_TAU_MIN 0.5,
POOL_OCC_K 6.

To backtest once hotel samples exist (needs NAS agent 1.17), on the live site console:

```js
const st = await import('./js/state.js');
const ok = st.data.hotelPrices.filter(r => r.ok); const since = ok.map(r => r.sampledAt.slice(0,10)).sort()[0];
const bt = await import('./js/features/modelbacktest.js');
const m8 = await import('./js/features/bookingmodel-v8.js');
const m9 = await import('./js/features/bookingmodel.js');
const o = { asOf: [since], horizon: 30, runs: 1500 };
const r8 = await bt.backtest({ ...o, model: m8 }), r9 = await bt.backtest({ ...o, model: m9 });
console.table([...r8.summary.map(s => ({ v: 8, ...s })), ...r9.summary.map(s => ({ v: 9, ...s }))]);
```
