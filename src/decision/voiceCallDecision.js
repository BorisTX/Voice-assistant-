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

  let reason = "no_sms_conditions_met";
  if (combined) reason = "failed_call_and_unavailable";
  else if (sendMissedCallSms) reason = "failed_call";
  else if (sendUnavailableSms) reason = unavailableReason;

  return {
    normalizedStatus,
    sendMissedCallSms,
    sendUnavailableSms,
    unavailableReason,
    combined,
    reason,
  };
}
