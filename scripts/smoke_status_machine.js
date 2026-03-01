import assert from "assert";
import crypto from "crypto";
import { openDb, runMigrations } from "../src/db/migrate.js";
import { makeDataLayer } from "../src/data/index.js";

const db = openDb();
await runMigrations(db);
const { data } = makeDataLayer({ db });

let business = (await data.listBusinesses())[0];
if (!business) {
  const id = crypto.randomUUID();
  await data.insertBusiness({ id, name: "Smoke Biz" });
  business = await data.getBusinessById(id);
}
assert.ok(business, "Need at least one business row");

const id = crypto.randomUUID();
await data.createPendingHold({
  id,
  business_id: business.id,
  start_utc: new Date(Date.now() + 3600000).toISOString(),
  end_utc: new Date(Date.now() + 7200000).toISOString(),
  hold_expires_at_utc: new Date(Date.now() + 300000).toISOString(),
});

await data.confirmBooking(id, "event_123");
let threw = false;
try {
  await data.failBooking(id, "should-fail");
} catch (e) {
  threw = e?.code === "INVALID_STATUS_TRANSITION";
}
assert.ok(threw, "confirmed -> failed must throw INVALID_STATUS_TRANSITION");

console.log("smoke_status_machine: ok");
db.close();
