ALTER TABLE bookings ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_bookings_active_idempotency_key
ON bookings(idempotency_key)
WHERE idempotency_key IS NOT NULL
  AND (
    status = 'confirmed'
    OR (
      status = 'pending'
      AND hold_expires_at_utc IS NOT NULL
      AND julianday(hold_expires_at_utc) > julianday('now')
    )
  );
