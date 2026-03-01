import test from "node:test";
import assert from "node:assert/strict";
import { createBookingFlow } from "./createBooking.js";

function flushAsync() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeFlowDeps({ sendSmsOk }) {
  const calls = {
    confirmBooking: 0,
    failBooking: 0,
    smsLogs: [],
  };

  const data = {
    getBusinessById: async () => ({ id: "biz-1", timezone: "America/Chicago", default_duration_min: 60 }),
    cleanupExpiredHolds: async () => true,
    createPendingHoldIfAvailableTx: async () => ({ ok: true }),
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

  return {
    calls,
    deps: {
      data,
      body: {
        businessId: "biz-1",
        startLocal: "2026-01-10T09:00:00",
        timezone: "America/Chicago",
        durationMins: 60,
        customer: { name: "A", phone: "+15550001111" },
      },
      makeOAuthClient: () => ({}),
      loadTokensIntoClientForBusiness: async () => true,
      google,
      googleApiTimeoutMs: 1000,
      withTimeout: async (promise) => promise,
      sendBookingConfirmationFn,
    },
  };
}

test("logs sms success when Twilio send succeeds", async () => {
  const { calls, deps } = makeFlowDeps({ sendSmsOk: true });

  const result = await createBookingFlow(deps);
  await flushAsync();

  assert.equal(result.status, 200);
  assert.equal(result.body.status, "confirmed");
  assert.equal(calls.confirmBooking, 1);
  assert.equal(calls.failBooking, 0);
  assert.equal(calls.smsLogs.length, 1);
  assert.equal(calls.smsLogs[0].status, "sent");
});

test("logs sms failure without reverting confirmed booking", async () => {
  const { calls, deps } = makeFlowDeps({ sendSmsOk: false });

  const result = await createBookingFlow(deps);
  await flushAsync();

  assert.equal(result.status, 200);
  assert.equal(result.body.status, "confirmed");
  assert.equal(calls.confirmBooking, 1);
  assert.equal(calls.failBooking, 0);
  assert.equal(calls.smsLogs.length, 1);
  assert.equal(calls.smsLogs[0].status, "failed");
  assert.equal(calls.smsLogs[0].errorMessage, "Twilio error");
});
