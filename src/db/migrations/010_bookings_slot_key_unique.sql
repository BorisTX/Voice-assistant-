ALTER TABLE bookings ADD COLUMN slot_key TEXT NOT NULL DEFAULT '';

UPDATE bookings
SET slot_key = business_id || ':' || start_utc
WHERE slot_key = '' OR slot_key IS NULL;

CREATE INDEX IF NOT EXISTS idx_bookings_slot_key
  ON bookings(slot_key);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_bookings_active_slot_key
  ON bookings(slot_key)
  WHERE status IN ('pending', 'confirmed');
