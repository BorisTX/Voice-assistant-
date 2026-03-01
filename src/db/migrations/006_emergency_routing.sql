ALTER TABLE bookings ADD COLUMN is_emergency INTEGER NOT NULL DEFAULT 0;

ALTER TABLE businesses ADD COLUMN technician_phone TEXT;
ALTER TABLE businesses ADD COLUMN working_hours_start TEXT NOT NULL DEFAULT '08:00';
ALTER TABLE businesses ADD COLUMN working_hours_end TEXT NOT NULL DEFAULT '17:00';

CREATE TABLE IF NOT EXISTS emergency_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  booking_id TEXT REFERENCES bookings(id),
  technician_phone TEXT,
  escalation_type TEXT NOT NULL CHECK(escalation_type IN ('sms', 'call')),
  status TEXT NOT NULL CHECK(status IN ('sent', 'failed')),
  error_message TEXT,
  created_at_utc TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_emergency_logs_business_created
  ON emergency_logs(business_id, created_at_utc);

CREATE INDEX IF NOT EXISTS idx_emergency_logs_booking
  ON emergency_logs(booking_id);
