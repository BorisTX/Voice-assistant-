const baseUrl = process.env.BASE_URL || "http://127.0.0.1:10000";
const debugRoutesEnabled = process.env.DEBUG_ROUTES === "1";

console.log("Smoke test: /debug gate");
console.log("Run server separately before executing this script.");
console.log(`Target: ${baseUrl}/debug/bookings`);
console.log(`Expectation: ${debugRoutesEnabled ? "status is not 404" : "status is 404"}`);

try {
  const response = await fetch(`${baseUrl}/debug/bookings`);
  const ok = debugRoutesEnabled ? response.status !== 404 : response.status === 404;

  if (!ok) {
    console.error(`FAILED: got status ${response.status}`);
    process.exit(1);
  }

  console.log(`PASSED: got status ${response.status}`);
} catch (error) {
  console.error("FAILED: request error", error);
  process.exit(1);
}
