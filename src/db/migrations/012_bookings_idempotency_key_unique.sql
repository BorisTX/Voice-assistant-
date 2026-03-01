ALTER TABLE bookings ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_bookings_active_idempotency_key
ON bookings(idempotency_key)
WHERE idempotency_key IS NOT NULL
  AND status IN ('pending','confirmed');
