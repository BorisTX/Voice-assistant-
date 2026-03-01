import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

test("idempotency unique index excludes expired pending holds", async () => {
  const migrationPath = path.resolve("src/db/migrations/012_bookings_idempotency_key_unique.sql");
  const migrationSql = await fs.readFile(migrationPath, "utf8");

  assert.match(migrationSql, /CREATE UNIQUE INDEX IF NOT EXISTS uniq_bookings_active_idempotency_key/i);
  assert.match(migrationSql, /status = 'confirmed'/i);
  assert.match(
    migrationSql,
    /status = 'pending'[\s\S]*hold_expires_at_utc IS NOT NULL[\s\S]*julianday\(hold_expires_at_utc\) > julianday\('now'\)/i
  );
  assert.doesNotMatch(migrationSql, /status IN \('pending','confirmed'\)/i);
});
