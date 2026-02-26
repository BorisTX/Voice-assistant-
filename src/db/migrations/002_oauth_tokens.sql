CREATE TABLE IF NOT EXISTS oauth_tokens (
  id INTEGER PRIMARY KEY,
  access_token TEXT,
  refresh_token TEXT,
  scope TEXT,
  token_type TEXT,
  expiry_date INTEGER,
  updated_at INTEGER
);

INSERT OR IGNORE INTO oauth_tokens (id, updated_at)
VALUES (1, strftime('%s','now'));
