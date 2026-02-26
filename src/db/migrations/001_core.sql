-- 001_core.sql

CREATE TABLE IF NOT EXISTS businesses (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  industry           TEXT NOT NULL DEFAULT 'hvac',
  timezone           TEXT NOT NULL DEFAULT 'America/Chicago',
  working_hours_json TEXT NOT NULL DEFAULT '{}',

  default_duration_min  INTEGER NOT NULL DEFAULT 60,
  slot_granularity_min  INTEGER NOT NULL DEFAULT 15,
  buffer_before_min     INTEGER NOT NULL DEFAULT 0,
  buffer_after_min      INTEGER NOT NULL DEFAULT 30,
  lead_time_min         INTEGER NOT NULL DEFAULT 60,
  max_days_ahead        INTEGER NOT NULL DEFAULT 7,
  max_daily_jobs        INTEGER,

  emergency_enabled        INTEGER NOT NULL DEFAULT 1,
  emergency_keywords_json  TEXT NOT NULL DEFAULT '[]',

  created_at_utc        TEXT NOT NULL,
  updated_at_utc        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS google_tokens (
  business_id     TEXT PRIMARY KEY REFERENCES businesses(id),
  access_token    TEXT,
  refresh_token   TEXT,
  scope           TEXT,
  token_type      TEXT,
  expiry_date_utc TEXT,
  created_at_utc  TEXT NOT NULL,
  updated_at_utc  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  id                   TEXT PRIMARY KEY,
  business_id           TEXT NOT NULL REFERENCES businesses(id),

  start_utc             TEXT NOT NULL,
  end_utc               TEXT NOT NULL,

  status                TEXT NOT NULL CHECK(status IN ('pending','confirmed','cancelled','failed')),
  hold_expires_at_utc   TEXT,

  customer_name         TEXT,
  customer_phone        TEXT,
  customer_email        TEXT,

  job_summary           TEXT,
  gcal_event_id         TEXT,

  created_at_utc        TEXT NOT NULL,
  updated_at_utc        TEXT NOT NULL
);

-- Core indexes for range/overlap queries
CREATE INDEX IF NOT EXISTS idx_bookings_business_start_end
  ON bookings(business_id, start_utc, end_utc);

CREATE INDEX IF NOT EXISTS idx_bookings_business_start
  ON bookings(business_id, start_utc);

CREATE INDEX IF NOT EXISTS idx_bookings_business_end
  ON bookings(business_id, end_utc);

CREATE INDEX IF NOT EXISTS idx_bookings_hold_expires
  ON bookings(business_id, hold_expires_at_utc);

CREATE INDEX IF NOT EXISTS idx_bookings_business_status
  ON bookings(business_id, status);

CREATE TABLE IF NOT EXISTS call_logs (
  id             TEXT PRIMARY KEY,
  business_id    TEXT NOT NULL REFERENCES businesses(id),
  call_sid       TEXT,
  from_phone     TEXT,
  status         TEXT,
  meta_json      TEXT,
  created_at_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sms_logs (
  id             TEXT PRIMARY KEY,
  business_id    TEXT NOT NULL REFERENCES businesses(id),
  to_phone       TEXT NOT NULL,
  template_key   TEXT,
  body           TEXT,
  status         TEXT,
  provider_sid   TEXT,
  created_at_utc TEXT NOT NULL
);
