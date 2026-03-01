#!/usr/bin/env node

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:10000";
const API_KEY = process.env.API_KEY || "";
const DEBUG_ROUTES = process.env.DEBUG_ROUTES;
const NODE_ENV = process.env.NODE_ENV;
const DEBUG_ADMIN_KEY = process.env.DEBUG_ADMIN_KEY || "";

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, options);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { response, text, json };
}

function hasUnmaskedPii(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value || {});
  const phoneMatch = /\+?\d[\d\s().-]{7,}\d/.test(text);
  const emailMatch = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text);
  return phoneMatch || emailMatch;
}

async function main() {
  console.log(`BASE_URL=${BASE_URL}`);

  const withoutKey = await requestJson("/api/available-slots");
  if (!API_KEY && NODE_ENV !== "production") {
    if (withoutKey.response.status === 401) {
      fail("Expected non-401 when API_KEY is unset in non-production mode");
    }
    console.warn("WARN: API_KEY unset in non-production; auth test skipped by design");
  } else if (withoutKey.response.status !== 401) {
    fail(`Expected 401 without API key, got ${withoutKey.response.status}`);
  }

  if (API_KEY) {
    const withKey = await requestJson("/api/available-slots", {
      headers: { "x-api-key": API_KEY },
    });
    if (withKey.response.status === 401) {
      fail("Expected non-401 with correct API key");
    }
  } else {
    console.warn("WARN: API_KEY not set; skipping authenticated /api test");
  }

  const debugNoKey = await requestJson("/debug/bookings");
  if (DEBUG_ROUTES !== "1") {
    if (debugNoKey.response.status !== 404) {
      fail(`Expected 404 for /debug/bookings when DEBUG_ROUTES!=1, got ${debugNoKey.response.status}`);
    }
    console.log("PASS: debug routes hidden when DEBUG_ROUTES != 1");
  } else if (NODE_ENV === "production") {
    if (debugNoKey.response.status !== 404) {
      fail(`Expected 404 for /debug/bookings without debug admin key in production, got ${debugNoKey.response.status}`);
    }

    if (!DEBUG_ADMIN_KEY) {
      console.warn("WARN: DEBUG_ADMIN_KEY not set; skipping authenticated /debug sanitization check");
      console.log("PASS: smoke checks complete with warnings");
      return;
    }

    const debugWithKey = await requestJson("/debug/bookings", {
      headers: { "x-debug-key": DEBUG_ADMIN_KEY },
    });

    if (!String(debugWithKey.response.headers.get("content-type") || "").includes("application/json")) {
      fail("Expected JSON response for authenticated /debug/bookings in production");
    }

    if (hasUnmaskedPii(debugWithKey.text)) {
      fail("Detected potential unmasked phone/email in /debug/bookings response");
    }
  }

  console.log("PASS: smoke checks complete");
}

main().catch((error) => {
  fail(String(error?.message || error));
});
