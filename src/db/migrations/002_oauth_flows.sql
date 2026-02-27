-- 002_oauth_flows.sql
CREATE TABLE IF NOT EXISTS oauth_flows (
  nonce            TEXT PRIMARY KEY,
  business_id      TEXT NOT NULL REFERENCES businesses(id),
  code_verifier    TEXT NOT NULL,
  created_at_utc   TEXT NOT NULL,
  expires_at_utc   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_flows_business
  ON oauth_flows(business_id);

CREATE INDEX IF NOT EXISTS idx_oauth_flows_expires
  ON oauth_flows(expires_at_utc);
