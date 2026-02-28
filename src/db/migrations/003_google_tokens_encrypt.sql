ALTER TABLE google_tokens ADD COLUMN refresh_token_enc TEXT;
ALTER TABLE google_tokens ADD COLUMN refresh_token_iv  TEXT;
ALTER TABLE google_tokens ADD COLUMN refresh_token_tag TEXT;

-- optional: access_token тоже можно позже
-- ALTER TABLE google_tokens ADD COLUMN access_token_enc TEXT;
-- ALTER TABLE google_tokens ADD COLUMN access_token_iv  TEXT;
-- ALTER TABLE google_tokens ADD COLUMN access_token_tag TEXT;
