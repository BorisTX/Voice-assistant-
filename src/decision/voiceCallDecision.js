const FAILED_CALL_STATUSES = new Set(["failed", "busy", "no-answer", "canceled"]);

export function decideVoiceCall(ctx) {
  const callStatus = String(ctx?.callStatus || "started").toLowerCase();
  const hasBusinessId = Boolean(ctx?.businessId);
  const sendMissedCallSms = FAILED_CALL_STATUSES.has(callStatus) && hasBusinessId;
  const sendUnavailableSms = Boolean(
    hasBusinessId
      && ctx?.afterHoursAutoSmsEnabled
      && (ctx?.isShuttingDown || !ctx?.isReady || ctx?.afterHours)
  );

  let normalizedStatus = "started";
  if (callStatus === "completed") normalizedStatus = "completed";
  if (FAILED_CALL_STATUSES.has(callStatus)) normalizedStatus = "failed";

  const unavailableReason = sendUnavailableSms
    ? (ctx?.isShuttingDown ? "shutting_down" : (!ctx?.isReady ? "not_ready" : "after_hours"))
    : null;
  const combined = sendMissedCallSms && sendUnavailableSms;

  let sms = { send: false, kind: null, reason: null };
  if (combined) {
    sms = { send: true, kind: "BOTH", reason: "failed_call_and_unavailable" };
  } else if (sendMissedCallSms) {
    sms = { send: true, kind: "MISSED_CALL", reason: "failed_call" };
  } else if (sendUnavailableSms) {
    sms = { send: true, kind: "UNAVAILABLE", reason: unavailableReason };
  }

  return {
    normalizedStatus,
    sms,
  };
}
