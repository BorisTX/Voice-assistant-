import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

test("migration uses julianday('now') for active pending hold comparison", async () => {
  const migrationPath = path.resolve("src/db/migrations/011_bookings_active_slot_excludes_expired_pending.sql");
  const migrationSql = await fs.readFile(migrationPath, "utf8");

  assert.match(migrationSql, /DROP INDEX IF EXISTS uniq_bookings_active_slot_key/i);
  assert.match(migrationSql, /CREATE UNIQUE INDEX IF NOT EXISTS uniq_bookings_active_slot_key/i);
  assert.match(migrationSql, /status = 'confirmed'/i);
  assert.match(
    migrationSql,
    /status = 'pending'[\s\S]*hold_expires_at_utc IS NOT NULL[\s\S]*julianday\(hold_expires_at_utc\) > julianday\('now'\)/i
  );
  assert.doesNotMatch(migrationSql, /CURRENT_TIMESTAMP/i);
});
