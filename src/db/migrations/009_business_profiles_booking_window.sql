ALTER TABLE business_profiles ADD COLUMN lead_time_min INTEGER NOT NULL DEFAULT 60;
ALTER TABLE business_profiles ADD COLUMN max_days_ahead INTEGER NOT NULL DEFAULT 14;
