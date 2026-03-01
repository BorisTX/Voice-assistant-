CREATE TABLE IF NOT EXISTS business_profiles (
  business_id TEXT PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  timezone TEXT NOT NULL DEFAULT 'America/Chicago',
  working_hours_json TEXT NOT NULL,
  slot_duration_min INTEGER NOT NULL DEFAULT 60,
  buffer_min INTEGER NOT NULL DEFAULT 0,
  emergency_enabled INTEGER NOT NULL DEFAULT 1,
  emergency_phone TEXT,
  service_area_json TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);
