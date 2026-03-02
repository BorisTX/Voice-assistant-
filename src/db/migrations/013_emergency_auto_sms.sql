ALTER TABLE business_profiles ADD COLUMN after_hours_auto_sms_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE business_profiles ADD COLUMN booking_link_base TEXT;
ALTER TABLE business_profiles ADD COLUMN emergency_notify_sms_to TEXT;
ALTER TABLE business_profiles ADD COLUMN emergency_notify_call_to TEXT;
ALTER TABLE business_profiles ADD COLUMN emergency_retries INTEGER NOT NULL DEFAULT 2;
ALTER TABLE business_profiles ADD COLUMN emergency_retry_delay_sec INTEGER NOT NULL DEFAULT 30;

ALTER TABLE sms_logs ADD COLUMN request_id TEXT;
ALTER TABLE sms_logs ADD COLUMN reason TEXT;
ALTER TABLE sms_logs ADD COLUMN dedupe_key TEXT;
ALTER TABLE sms_logs ADD COLUMN kind TEXT;
ALTER TABLE sms_logs ADD COLUMN error TEXT;
ALTER TABLE sms_logs ADD COLUMN twilio_sid TEXT;
ALTER TABLE sms_logs ADD COLUMN from_phone TEXT;

ALTER TABLE call_logs ADD COLUMN request_id TEXT;
ALTER TABLE call_logs ADD COLUMN error TEXT;

CREATE INDEX IF NOT EXISTS idx_sms_logs_request_kind ON sms_logs(request_id, kind);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_logs_dedupe_key ON sms_logs(dedupe_key) WHERE dedupe_key IS NOT NULL;
