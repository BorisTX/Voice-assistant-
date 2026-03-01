const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:10000";
const BUSINESS_ID = process.env.BUSINESS_ID;
const START_LOCAL = process.env.START_LOCAL;
const TIMEZONE = process.env.TIMEZONE || "America/Chicago";
const DURATION_MIN = Number(process.env.DURATION_MIN || 60);
const N = 10;

if (!BUSINESS_ID) {
  console.error("Missing required env: BUSINESS_ID");
  process.exit(1);
}

if (!START_LOCAL) {
  console.error("Missing required env: START_LOCAL (example: 2026-03-01T10:00:00)");
  process.exit(1);
}

const payload = {
  businessId: BUSINESS_ID,
  startLocal: START_LOCAL,
  timezone: TIMEZONE,
  durationMins: DURATION_MIN,
  bufferMins: 15,
  service: "repair",
  customer: {
    name: "Concurrency Test",
    phone: "+15555550100",
    email: "concurrency-test@example.com",
    address: "123 Test St",
  },
  notes: "Parallel booking race test",
};

async function attempt(index) {
  try {
    const res = await fetch(`${BASE_URL}/api/bookings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    let body = null;
    try { body = await res.json(); } catch {}

    return { index, status: res.status, ok: res.ok, body };
  } catch (error) {
    return { index, status: null, ok: false, error: String(error?.message || error) };
  }
}

async function main() {
  console.log(`Running ${N} parallel requests against ${BASE_URL}/api/bookings`);
  const results = await Promise.all(Array.from({ length: N }, (_, i) => attempt(i + 1)));

  let success = 0;
  let conflicts = 0;
  let other = 0;

  for (const r of results) {
    if (r.status === 200) success += 1;
    else if (r.status === 409) conflicts += 1;
    else other += 1;
  }

  console.log("\nResults:");
  console.log(`  success (200): ${success}`);
  console.log(`  conflicts (409): ${conflicts}`);
  console.log(`  other: ${other}`);

  console.log("\nPer-request statuses:");
  for (const r of results) {
    console.log(`  #${r.index}: ${r.status ?? "ERR"}`);
  }

  if (success <= 1) {
    console.log("\nPASS: successes <= 1");
    process.exit(0);
  }

  console.log("\nFAIL: successes > 1");
  process.exit(2);
}

main();
