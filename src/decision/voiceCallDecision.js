const FAILED_CALL_STATUSES = new Set(["failed", "busy", "no-answer", "canceled"]);

export function decideVoiceCall(ctx) {
  const callStatus = String(ctx?.callStatus || "started").toLowerCase();
  const hasBusinessId = Boolean(ctx?.businessId);
  const shouldSendMissedCallSms = FAILED_CALL_STATUSES.has(callStatus) && hasBusinessId;
  const shouldSendUnavailableSms = Boolean(
    hasBusinessId
      && ctx?.afterHoursAutoSmsEnabled
      && (ctx?.isShuttingDown || !ctx?.isReady || ctx?.afterHours)
  );

  let normalizedStatus = "started";
  if (callStatus === "completed") normalizedStatus = "completed";
  if (FAILED_CALL_STATUSES.has(callStatus)) normalizedStatus = "failed";

  if (shouldSendMissedCallSms && shouldSendUnavailableSms) {
    return {
      action: "SEND_MISSED_AND_UNAVAILABLE_SMS",
      reason: "failed_call_and_unavailable",
      details: {
        normalizedStatus,
        unavailableReason: ctx?.isShuttingDown || !ctx?.isReady ? "not_ready" : "after_hours",
      },
    };
  }

  if (shouldSendMissedCallSms) {
    return {
      action: "SEND_MISSED_CALL_SMS",
      reason: "failed_call",
      details: { normalizedStatus },
    };
  }

  if (shouldSendUnavailableSms) {
    return {
      action: "SEND_UNAVAILABLE_SMS",
      reason: ctx?.isShuttingDown || !ctx?.isReady ? "not_ready" : "after_hours",
      details: { normalizedStatus },
    };
  }

  return {
    action: "NO_SMS",
    reason: "no_sms_conditions_met",
    details: { normalizedStatus },
  };
}
