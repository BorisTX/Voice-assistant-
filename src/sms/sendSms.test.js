import test from "node:test";
import assert from "node:assert/strict";
import { sendAutoSmsToCaller, sendEmergencyNotify } from "./sendSms.js";

test("when isEmergency=true emergency notify SMS includes requestId and logs", async () => {
  const smsLogs = [];
  const twilioClient = {
    sendSms: async () => ({ sid: "SM123" }),
    makeCall: async () => ({ sid: "CA123" }),
  };

  const data = {
    logSmsAttempt: async (payload) => {
      smsLogs.push(payload);
      return true;
    },
    logCallEvent: async () => true,
  };

  const result = await sendEmergencyNotify({
    callerNumber: "+15550001111",
    business: { emergency_notify_sms_to: "+15552223333", emergency_notify_call_to: "+15552223333", emergency_retries: 0, emergency_retry_delay_sec: 0 },
    businessId: "biz-1",
    requestId: "req-123",
    data,
    twilioClient,
  });

  assert.equal(result.ok, true);
  assert.equal(smsLogs.length, 1);
  assert.equal(smsLogs[0].requestId, "req-123");
  assert.match(smsLogs[0].messageBody, /RequestId: req-123/);
});

test("when booking fails auto-SMS is attempted once and logged", async () => {
  const smsLogs = [];
  const twilioClient = {
    sendSms: async () => ({ sid: "SM999" }),
  };

  const data = {
    hasSmsLogByDedupeKey: async () => false,
    logSmsAttempt: async (payload) => {
      smsLogs.push(payload);
      return true;
    },
  };

  const result = await sendAutoSmsToCaller({
    to: "+15550001111",
    businessId: "biz-1",
    requestId: "req-book-fail",
    reason: "booking_error",
    link: "https://example.com/book?business_id=biz-1",
    data,
    twilioClient,
  });

  assert.equal(result.ok, true);
  assert.equal(smsLogs.length, 1);
  assert.equal(smsLogs[0].kind, "auto_sms");
  assert.equal(smsLogs[0].reason, "booking_error");
});
