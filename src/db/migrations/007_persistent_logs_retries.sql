-- 007_persistent_logs_retries.sql

ALTER TABLE bookings ADD COLUMN service_address TEXT;
ALTER TABLE bookings ADD COLUMN service_type TEXT;
ALTER TABLE bookings ADD COLUMN timezone TEXT;
ALTER TABLE bookings ADD COLUMN failure_reason TEXT;

UPDATE bookings
SET timezone = COALESCE(timezone, 'UTC')
WHERE timezone IS NULL;

ALTER TABLE call_logs ADD COLUMN to_number TEXT;
ALTER TABLE call_logs ADD COLUMN from_number TEXT;
ALTER TABLE call_logs ADD COLUMN direction TEXT;
ALTER TABLE call_logs ADD COLUMN duration_sec INTEGER;
ALTER TABLE call_logs ADD COLUMN recording_url TEXT;

UPDATE call_logs
SET from_number = COALESCE(from_number, from_phone),
    direction = COALESCE(direction, 'inbound')
WHERE from_number IS NULL OR direction IS NULL;

ALTER TABLE sms_logs ADD COLUMN to_number TEXT;
ALTER TABLE sms_logs ADD COLUMN from_number TEXT;
ALTER TABLE sms_logs ADD COLUMN message_body TEXT;
ALTER TABLE sms_logs ADD COLUMN message_sid TEXT;
ALTER TABLE sms_logs ADD COLUMN type TEXT;

UPDATE sms_logs
SET to_number = COALESCE(to_number, phone, to_phone),
    message_body = COALESCE(message_body, message, body),
    type = COALESCE(type, 'other')
WHERE to_number IS NULL OR message_body IS NULL OR type IS NULL;

CREATE TABLE IF NOT EXISTS retries (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  booking_id TEXT REFERENCES bookings(id),
  kind TEXT NOT NULL CHECK(kind IN ('twilio_sms','twilio_call','gcal_create','gcal_update','gcal_delete')),
  payload_json TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_attempt_at_utc TEXT NOT NULL,
  last_error TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed')),
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_retries_status_next_attempt
  ON retries(status, next_attempt_at_utc);
