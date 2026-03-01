ALTER TABLE sms_logs ADD COLUMN booking_id TEXT;
ALTER TABLE sms_logs ADD COLUMN phone TEXT;
ALTER TABLE sms_logs ADD COLUMN message TEXT;
ALTER TABLE sms_logs ADD COLUMN error_message TEXT;

UPDATE sms_logs
SET
  phone = COALESCE(phone, to_phone),
  message = COALESCE(message, body)
WHERE phone IS NULL OR message IS NULL;

CREATE INDEX IF NOT EXISTS idx_sms_logs_business_created
  ON sms_logs(business_id, created_at_utc);

CREATE INDEX IF NOT EXISTS idx_sms_logs_booking
  ON sms_logs(booking_id);
