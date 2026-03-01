import crypto from "crypto";
import { openDb, runMigrations } from "../src/db/migrate.js";
import { makeDataLayer } from "../src/data/index.js";
import { runRetriesOnce } from "../src/retries/runRetriesOnce.js";

const db = openDb();
await runMigrations(db);
const { data } = makeDataLayer({ db });
let business = (await data.listBusinesses())[0];
if (!business) {
  const id = crypto.randomUUID();
  await data.insertBusiness({ id, name: "Smoke Biz" });
  business = await data.getBusinessById(id);
}

await data.enqueueRetry({
  businessId: business.id,
  kind: "twilio_sms",
  payloadJson: { to: "+10000000000", body: "retry test" },
  maxAttempts: 1,
  nextAttemptAtUtc: new Date(Date.now() - 1000).toISOString(),
});

const out = await runRetriesOnce({ data, limit: 20 });
console.log("smoke_retry_worker:", out);

db.close();
