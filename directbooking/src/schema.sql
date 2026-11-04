-- Direct booking site schema. Written to run on SQLite (the default: no
-- database to set up on the host) and to port to MySQL with only type tweaks.
-- Every `data` column is JSON text: translatable strings are stored either
-- as a plain string or as {"en": "...", "ko": "..."} (see Util::t()).
-- `tenant` is on every content row so other hosts can be added later
-- without a migration; Day 1 only ever uses 'default'.

-- One row per branded website. All share this database, the admin and the
-- rooms; each has its own address, look, wording and room list. The
-- request's host name picks the site.
CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,           -- https://host (no trailing slash)
  products TEXT NOT NULL DEFAULT '"*"',  -- JSON: "*" = every published product, or product ids in display order
  events TEXT NOT NULL DEFAULT 'all' CHECK (events IN ('all','none')),
  events_home TEXT,                 -- site whose event pages are the canonical copy; NULL = this one
  indexable INTEGER NOT NULL DEFAULT 0,  -- 0 = noindex everywhere (temporary addresses)
  sort INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL DEFAULT '{}'   -- headline, description, accent colours, contact/from email, home layout
);

CREATE TABLE IF NOT EXISTS hosts (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  email TEXT NOT NULL,              -- where booking notifications go
  from_email TEXT,                  -- what guest emails come from
  stripe_account TEXT,              -- acct_... once connected
  default_discount_pct REAL,        -- NULL = site default
  payment_methods TEXT NOT NULL DEFAULT '{}',  -- JSON, see config.example.php
  data TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS admins (
  email TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  host_id TEXT                      -- NULL = operator (sees and approves everything)
);

CREATE TABLE IF NOT EXISTS login_tokens (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

-- City -> Area -> Building -> Property. Each inherits `data` from its parent.
CREATE TABLE IF NOT EXISTS places (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL DEFAULT 'default',
  parent_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('city','area','building','property')),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL DEFAULT 'default',
  property_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  beds24_room_id TEXT,
  ical_url TEXT,                    -- Airbnb calendar export, used until Beds24 is connected
  airbnb_url TEXT,
  max_guests INTEGER NOT NULL DEFAULT 2,
  base_rate REAL,                   -- GBP/night fallback when no live rate exists
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  data TEXT NOT NULL DEFAULT '{}'
);

-- What can be booked: one listing, or several sold together.
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL DEFAULT 'default',
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  listing_ids TEXT NOT NULL,        -- JSON array
  multi_room_discount_pct REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  data TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS venues (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL DEFAULT 'default',
  area_id TEXT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}'
);

-- A specific spot: a gate, a start line, a station. venue_id NULL for a
-- point belonging only to a theme (e.g. Christmas lights on Regent Street).
CREATE TABLE IF NOT EXISTS points (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL DEFAULT 'default',
  venue_id TEXT,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  tfl_ref TEXT,                     -- postcode, lat,lon or stop id TfL's journey planner accepts
  data TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS event_series (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL DEFAULT 'default',
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  venue_id TEXT,                    -- NULL for a theme
  recurrence TEXT NOT NULL DEFAULT 'one-off' CHECK (recurrence IN ('annual','multi','one-off','theme')),
  point_ids TEXT NOT NULL DEFAULT '[]',  -- JSON; empty = all of the venue's points
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  data TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS occurrences (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL DEFAULT 'default',
  series_id TEXT NOT NULL,
  name TEXT,                        -- NULL = series name + year
  start_date TEXT,                  -- NULL while dates are unconfirmed
  end_date TEXT,
  ticket_url TEXT,
  source TEXT,                      -- where the dates came from
  min_nights INTEGER,
  cancellation_policy TEXT,
  discount_pct REAL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  data TEXT NOT NULL DEFAULT '{}'
);

-- From the property to a point (direction 'to') or back ('from').
CREATE TABLE IF NOT EXISTS routes (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL DEFAULT 'default',
  property_id TEXT NOT NULL,
  point_id TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'to' CHECK (direction IN ('to','from')),
  context TEXT NOT NULL DEFAULT 'normal' CHECK (context IN ('normal','event_day','late_night')),
  summary TEXT NOT NULL,
  minutes INTEGER,
  fare_pence INTEGER,
  legs TEXT NOT NULL DEFAULT '[]',  -- JSON [{mode, minutes, text}]
  source TEXT NOT NULL,
  verified_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published'))
);

-- Direct-booking rules over a date range. Rates and min stay for BOTH
-- channels live in Beds24; these are only what is direct-specific.
CREATE TABLE IF NOT EXISTS rate_rules (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL DEFAULT 'default',
  product_id TEXT,                  -- NULL = all products
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,           -- inclusive, a night date
  min_nights INTEGER,
  cancellation_policy TEXT,
  discount_pct REAL,
  note TEXT
);

-- Machine-proposed changes (roll-forwards, fetched routes, found fixtures)
-- wait here for a yes/no. Edits made by an admin by hand apply directly.
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  summary TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  tenant TEXT NOT NULL DEFAULT 'default',
  site_id TEXT,                     -- which branded site the guest booked on
  product_id TEXT NOT NULL,
  occurrence_id TEXT,
  arrival TEXT NOT NULL,
  departure TEXT NOT NULL,
  nights INTEGER NOT NULL,
  adults INTEGER NOT NULL,
  guest_name TEXT NOT NULL,
  guest_email TEXT NOT NULL,
  guest_phone TEXT,
  guest_country TEXT,
  message TEXT,
  currency TEXT NOT NULL,
  total_minor INTEGER NOT NULL,
  method TEXT NOT NULL,
  policy TEXT NOT NULL,
  status TEXT NOT NULL,             -- see Bookings::STATUSES
  quote TEXT NOT NULL,              -- JSON snapshot of the quote the guest accepted
  created_at TEXT NOT NULL,
  requested_at TEXT,
  approve_by TEXT,
  pay_by TEXT,
  decided_at TEXT,
  decided_by TEXT,
  note TEXT
);

-- One per listing in a booking: each is paid to that listing's owner.
CREATE TABLE IF NOT EXISTS booking_parts (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  hold_ref TEXT,                    -- Beds24 booking id while/after the dates are held
  status TEXT NOT NULL DEFAULT 'open'
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  part_id TEXT NOT NULL,
  seq INTEGER NOT NULL,             -- 1 = first payment; >1 = long-stay instalments
  covers_from TEXT,
  covers_to TEXT,
  due_date TEXT,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('card_auth','link','manual')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','authorised','paid','cancelled','refunded')),
  stripe_session_id TEXT,
  stripe_pi_id TEXT,
  paid_at TEXT,
  notified_at TEXT,                 -- when the guest was last sent this payment's link/instructions
  refunded_minor INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS fx_rates (
  currency TEXT PRIMARY KEY,
  per_gbp REAL NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_cache (
  listing_id TEXT NOT NULL,
  date TEXT NOT NULL,
  price REAL,
  available INTEGER NOT NULL,
  min_stay INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (listing_id, date)
);

CREATE TABLE IF NOT EXISTS mail_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  ok INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  message TEXT NOT NULL
);

-- Tasks proposed to the owner's personal dashboard (DashboardInbox).
CREATE TABLE IF NOT EXISTS inbox_outbox (
  key TEXT PRIMARY KEY,             -- e.g. request:bk_123, so nothing is proposed twice
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  batch_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_parts_booking ON booking_parts(booking_id);
CREATE INDEX IF NOT EXISTS idx_payments_part ON payments(part_id);
CREATE INDEX IF NOT EXISTS idx_occ_series ON occurrences(series_id);
CREATE INDEX IF NOT EXISTS idx_routes_point ON routes(point_id);
