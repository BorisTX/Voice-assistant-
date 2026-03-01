import test from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { createBookingFlow } from "./createBooking.js";

function flushAsync() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeFlowDeps({ sendSmsOk = true, bodyOverrides = {}, emergencyResult = { escalated: true } } = {}) {
  const nowInChicago = DateTime.fromISO("2026-01-01T09:00:00", { zone: "America/Chicago" });
  const calls = {
    createPendingBookingLock: 0,
    beginImmediateTransaction: 0,
    commitTransaction: 0,
    rollbackTransaction: 0,
    confirmBooking: 0,
    failBooking: 0,
    smsLogs: [],
    emergencyCalls: [],
  };

  const data = {
    getBusinessById: async () => ({
      id: "biz-1",
      timezone: "America/Chicago",
      default_duration_min: 60,
      working_hours_start: "08:00",
      working_hours_end: "17:00",
      technician_phone: "+15551234567",
    }),
    cleanupExpiredHolds: async () => true,
    getEffectiveBusinessProfile: async () => ({
      timezone: "America/Chicago",
      slot_duration_min: 60,
      buffer_min: 15,
      lead_time_min: 60,
      max_days_ahead: 14,
    }),
    beginImmediateTransaction: async () => {
      calls.beginImmediateTransaction += 1;
      return true;
    },
    createPendingBookingLock: async () => {
      calls.createPendingBookingLock += 1;
      return true;
    },
    commitTransaction: async () => {
      calls.commitTransaction += 1;
      return true;
    },
    rollbackTransaction: async () => {
      calls.rollbackTransaction += 1;
      return true;
    },
    confirmBooking: async () => {
      calls.confirmBooking += 1;
      return true;
    },
    failBooking: async () => {
      calls.failBooking += 1;
      return true;
    },
    logSmsAttempt: async (payload) => {
      calls.smsLogs.push(payload);
      return true;
    },
  };

  const google = {
    calendar: () => ({
      freebusy: {
        query: async () => ({ data: { calendars: { primary: { busy: [] } } } }),
      },
      events: {
        insert: async () => ({ data: { id: "gcal-123" } }),
      },
    }),
  };

  const sendBookingConfirmationFn = async () => {
    if (sendSmsOk) {
      return { ok: true, message: "ok" };
    }
    return { ok: false, message: "failed-msg", error: "Twilio error" };
  };

  const handleEmergencyFn = async (payload) => {
    calls.emergencyCalls.push(payload);
    return emergencyResult;
  };

  return {
    calls,
    deps: {
      data,
      body: {
        businessId: "biz-1",
        startLocal: nowInChicago.plus({ days: 2 }).toISO({ includeOffset: false }),
        timezone: "America/Chicago",
        durationMins: 60,
        customer: { name: "A", phone: "+15550001111", address: "123 Main St" },
        ...bodyOverrides,
      },
      makeOAuthClient: () => ({}),
      loadTokensIntoClientForBusiness: async () => true,
      google,
      googleApiTimeoutMs: 1000,
      withTimeout: async (promise) => promise,
      nowFn: () => nowInChicago,
      sendBookingConfirmationFn,
      handleEmergencyFn,
    },
  };
}

test("normal booking does not trigger emergency escalation", async () => {
  const { calls, deps } = makeFlowDeps({ sendSmsOk: true });

  const result = await createBookingFlow(deps);
  await flushAsync();

  assert.equal(result.status, 200);
  assert.equal(result.body.status, "confirmed");
  assert.equal(result.body.isEmergency, false);
  assert.equal(result.body.emergencyEscalated, false);
  assert.equal(calls.confirmBooking, 1);
  assert.equal(calls.failBooking, 0);
  assert.ok(calls.smsLogs.length >= 1);
  assert.equal(calls.emergencyCalls.length, 0);
});

test("emergency service triggers technician escalation", async () => {
  const { calls, deps } = makeFlowDeps({
    sendSmsOk: true,
    bodyOverrides: { service: "emergency" },
  });

  const result = await createBookingFlow(deps);
  await flushAsync();

  assert.equal(result.status, 200);
  assert.equal(result.body.isEmergency, true);
  assert.equal(result.body.emergencyEscalated, true);
  assert.equal(calls.emergencyCalls.length, 1);
});

test("after-hours booking auto-escalates", async () => {
  const { calls, deps } = makeFlowDeps({
    sendSmsOk: true,
    bodyOverrides: { startLocal: "2026-01-10T22:00:00" },
  });

  const result = await createBookingFlow(deps);
  await flushAsync();

  assert.equal(result.status, 200);
  assert.equal(result.body.isEmergency, true);
  assert.equal(result.body.emergencyEscalated, true);
  assert.equal(calls.emergencyCalls.length, 1);
});

test("Twilio failure logs sms failure without reverting confirmed booking", async () => {
  const { calls, deps } = makeFlowDeps({
    sendSmsOk: false,
    bodyOverrides: { service: "emergency" },
    emergencyResult: { escalated: false, sms: { ok: false, error: "Twilio down" } },
  });

  const result = await createBookingFlow(deps);
  await flushAsync();

  assert.equal(result.status, 200);
  assert.equal(result.body.status, "confirmed");
  assert.equal(calls.confirmBooking, 1);
  assert.equal(calls.failBooking, 0);
  assert.ok(calls.smsLogs.length >= 1);
  const failedSmsLog = calls.smsLogs.find((x) => x.status === "failed");
  assert.ok(failedSmsLog);
  assert.equal(failedSmsLog.errorMessage, "Twilio error");
  assert.equal(calls.emergencyCalls.length, 1);
});

test("rejects booking that violates lead_time_min", async () => {
  const { calls, deps } = makeFlowDeps({
    bodyOverrides: { startLocal: "2026-01-01T09:05:00" },
  });

  const result = await createBookingFlow(deps);

  assert.equal(result.status, 400);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.error, "INVALID_BOOKING_TIME_WINDOW");
  assert.equal(result.body.details[0].reason, "START_TOO_SOON");
  assert.equal(calls.createPendingBookingLock, 0);
  assert.equal(calls.confirmBooking, 0);
  assert.equal(calls.failBooking, 0);
});

test("rejects booking that violates max_days_ahead", async () => {
  const { calls, deps } = makeFlowDeps({
    bodyOverrides: { startLocal: "2027-01-01T09:00:00" },
  });

  const result = await createBookingFlow(deps);

  assert.equal(result.status, 400);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.error, "INVALID_BOOKING_TIME_WINDOW");
  assert.equal(result.body.details[0].reason, "START_TOO_FAR");
  assert.equal(calls.createPendingBookingLock, 0);
  assert.equal(calls.confirmBooking, 0);
  assert.equal(calls.failBooking, 0);
});

test("returns 409 when slot unique constraint is hit", async () => {
  const { deps } = makeFlowDeps();
  deps.data.createPendingBookingLock = async () => {
    const err = new Error("UNIQUE constraint failed: bookings.slot_key");
    err.code = "SQLITE_CONSTRAINT";
    throw err;
  };

  const result = await createBookingFlow(deps);

  assert.equal(result.status, 409);
  assert.equal(result.body.error, "SLOT_ALREADY_BOOKED");
});

test("returns 409 and rolls back when freebusy is already busy", async () => {
  const { calls, deps } = makeFlowDeps();
  deps.google = {
    calendar: () => ({
      freebusy: {
        query: async () => ({
          data: {
            calendars: {
              primary: {
                busy: [{ start: "2026-01-03T15:00:00.000Z", end: "2026-01-03T16:00:00.000Z" }],
              },
            },
          },
        }),
      },
      events: {
        insert: async () => ({ data: { id: "should-not-happen" } }),
      },
    }),
  };

  const result = await createBookingFlow(deps);

  assert.equal(result.status, 409);
  assert.equal(result.body.error, "SLOT_ALREADY_BOOKED");
  assert.equal(calls.rollbackTransaction, 1);
  assert.equal(calls.commitTransaction, 0);
  assert.equal(calls.confirmBooking, 0);
});
