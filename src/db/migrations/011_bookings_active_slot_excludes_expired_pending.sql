DROP INDEX IF EXISTS uniq_bookings_active_slot_key;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_bookings_active_slot_key
  ON bookings(slot_key)
  WHERE status = 'confirmed'
     OR (
       status = 'pending'
       AND hold_expires_at_utc IS NOT NULL
       AND julianday(hold_expires_at_utc) > julianday('now')
     );
