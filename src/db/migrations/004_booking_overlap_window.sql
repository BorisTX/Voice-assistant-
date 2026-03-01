ALTER TABLE bookings ADD COLUMN overlap_start_utc TEXT;
ALTER TABLE bookings ADD COLUMN overlap_end_utc TEXT;

UPDATE bookings
SET overlap_start_utc = COALESCE(overlap_start_utc, start_utc),
    overlap_end_utc = COALESCE(overlap_end_utc, end_utc)
WHERE overlap_start_utc IS NULL OR overlap_end_utc IS NULL;

CREATE INDEX IF NOT EXISTS idx_bookings_business_overlap_window
  ON bookings(business_id, overlap_start_utc, overlap_end_utc);
