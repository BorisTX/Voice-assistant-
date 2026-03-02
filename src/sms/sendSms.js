import { createTwilioClient } from "./sendBookingConfirmation.js";

const AUTO_SMS_TEMPLATE = "Hi! We got your request for HVAC service. Reply with your preferred time, or book here: {{link}}. If this is an emergency, reply EMERGENCY.";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function withTimeout(promise, ms, label, requestId = null) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    }),
  ])
    .catch((error) => {
      console.error(JSON.stringify({ level: "error", type: "twilio", label, requestId, error: String(error?.message || error) }));
      throw error;
    })
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

export async function sendAutoSmsToCaller({
  to,
  businessId,
  requestId,
  reason,
  link,
  data,
  twilioClient = createTwilioClient(),
}) {
  if (!to || !businessId || !requestId || !reason) return { ok: false, skipped: true, error: "missing required fields" };

  const dedupeKey = `${businessId}:${requestId}:auto_sms:${reason}`;
  if (typeof data?.hasSmsLogByDedupeKey === "function") {
    const exists = await data.hasSmsLogByDedupeKey(dedupeKey);
    if (exists) return { ok: true, skipped: true, dedupeKey };
  }

  const body = AUTO_SMS_TEMPLATE.replace("{{link}}", link || "https://example.com/book");

  try {
    const twilioRes = await withTimeout(twilioClient.sendSms({ to, body }), 10_000, "auto_sms", requestId);
    await data?.logSmsAttempt?.({
      businessId,
      toNumber: to,
      messageBody: body,
      messageSid: twilioRes?.sid || null,
      kind: "auto_sms",
      reason,
      requestId,
      dedupeKey,
      type: "auto_sms",
      status: "sent",
      error: null,
    });
    return { ok: true, sid: twilioRes?.sid || null, dedupeKey };
  } catch (error) {
    const err = String(error?.message || error);
    await data?.logSmsAttempt?.({
      businessId,
      toNumber: to,
      messageBody: body,
      kind: "auto_sms",
      reason,
      requestId,
      dedupeKey,
      type: "auto_sms",
      status: "failed",
      error,
      errorMessage: err,
    });
    return { ok: false, error: err, dedupeKey };
  }
}

export async function sendEmergencyNotify({
  callerNumber,
  business,
  businessId,
  requestId,
  data,
  twilioClient = createTwilioClient(),
}) {
  const smsTo = business?.emergency_notify_sms_to || business?.emergency_phone;
  if (!smsTo) return { ok: false, skipped: true, error: "missing emergency phone" };

  const retries = Number.isFinite(Number(business?.emergency_retries)) ? Number(business.emergency_retries) : 2;
  const retryDelaySec = Number.isFinite(Number(business?.emergency_retry_delay_sec)) ? Number(business.emergency_retry_delay_sec) : 30;
  const body = `EMERGENCY lead. Caller: ${callerNumber || "unknown"}. RequestId: ${requestId}. Call back ASAP.`;

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const sms = await withTimeout(twilioClient.sendSms({ to: smsTo, body }), 10_000, "emergency_sms", requestId);
      await data?.logSmsAttempt?.({
        businessId,
        toNumber: smsTo,
        messageBody: body,
        messageSid: sms?.sid || null,
        kind: "emergency_notify",
        reason: "emergency",
        requestId,
        dedupeKey: `${businessId}:${requestId}:emergency_notify`,
        type: "emergency_notify",
        status: "sent",
      });
      if (business?.emergency_notify_call_to) {
        try {
          await withTimeout(twilioClient.makeCall({ to: business.emergency_notify_call_to }), 10_000, "emergency_call", requestId);
        } catch (callErr) {
          await data?.logCallEvent?.({
            businessId,
            toNumber: business.emergency_notify_call_to,
            fromNumber: process.env.TWILIO_FROM_NUMBER || "",
            direction: "outbound",
            status: "failed",
            requestId,
            error: String(callErr?.message || callErr),
          });
        }
      }
      return { ok: true };
    } catch (error) {
      lastErr = String(error?.message || error);
      if (attempt < retries) await sleep(retryDelaySec * 1000);
    }
  }

  await data?.logSmsAttempt?.({
    businessId,
    toNumber: smsTo,
    messageBody: body,
    kind: "emergency_notify",
    reason: "emergency",
    requestId,
    dedupeKey: `${businessId}:${requestId}:emergency_notify`,
    type: "emergency_notify",
    status: "failed",
    errorMessage: lastErr,
    error: lastErr,
  });
  return { ok: false, error: lastErr };
}
