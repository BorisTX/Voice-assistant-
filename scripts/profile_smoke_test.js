import crypto from "crypto";
import { openDb, runMigrations } from "../src/db/migrate.js";
import { makeDataLayer } from "../src/data/index.js";

const db = openDb();
await runMigrations(db);
const { data } = makeDataLayer({ db });

let business = (await data.listBusinesses())[0];
if (!business) {
  const id = crypto.randomUUID();
  await data.insertBusiness({ id, name: "Profile Smoke Biz" });
  business = await data.getBusinessById(id);
}

const businessId = business.id;

const before = await data.getEffectiveBusinessProfile(businessId);
console.log("1) Effective profile before PUT:", JSON.stringify(before, null, 2));

await data.updateBusinessProfile(businessId, {
  timezone: "America/Denver",
  working_hours_json: JSON.stringify({
    mon: [{ start: "08:30", end: "16:30" }],
    tue: [{ start: "08:30", end: "16:30" }],
    wed: [{ start: "08:30", end: "16:30" }],
    thu: [{ start: "08:30", end: "16:30" }],
    fri: [{ start: "08:30", end: "16:30" }],
    sat: [],
    sun: [],
  }),
  slot_duration_min: 90,
  buffer_min: 20,
  emergency_enabled: 1,
  emergency_phone: "+1 (555) 123-4567",
  service_area_json: JSON.stringify({ mode: "zip", zips: ["75001", "75201"] }),
});

const after = await data.getEffectiveBusinessProfile(businessId);
console.log("2) Effective profile after PUT:", JSON.stringify(after, null, 2));

db.close();
