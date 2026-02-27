// scripts/smoke.js
const BASE_URL = process.env.SMOKE_BASE_URL || "http://127.0.0.1:10000";
const BUSINESS_ID = process.env.SMOKE_BUSINESS_ID || "";

async function run() {
  const health = await fetch(`${BASE_URL}/`);
  const healthText = await health.text();
  console.log("GET /", { status: health.status, body: healthText });

  const missingBiz = await fetch(`${BASE_URL}/api/available-slots`);
  const missingBizJson = await missingBiz.json();
  console.log("GET /api/available-slots (missing business_id)", {
    status: missingBiz.status,
    body: missingBizJson,
  });

  if (BUSINESS_ID) {
    const withBiz = await fetch(`${BASE_URL}/api/available-slots?business_id=${encodeURIComponent(BUSINESS_ID)}`);
    const withBizJson = await withBiz.json();
    console.log("GET /api/available-slots (with business_id)", {
      status: withBiz.status,
      body: withBizJson,
    });
  } else {
    console.log("SMOKE_BUSINESS_ID not set; skipped business-specific slots check");
  }
}

run().catch((err) => {
  console.error("Smoke test failed", err);
  process.exit(1);
});
