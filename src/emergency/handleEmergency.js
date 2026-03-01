import { DateTime } from "luxon";
import { createTwilioClient } from "../sms/sendBookingConfirmation.js";

function resolveTechnicianPhone(business = {}) {
  return (
    business.technician_phone ||
    business.technicianPhone ||
    business.dispatch_phone ||
    business.dispatchPhone ||
    process.env.EMERGENCY_TECHNICIAN_PHONE ||
    ""
  );
}

function formatLocalTime(utcIso, timezone) {
  if (!utcIso) return "unknown time";
  const dt = DateTime.fromISO(utcIso, { zone: "utc" }).setZone(timezone || "UTC");
  if (!dt.isValid) return utcIso;
  return dt.toFormat("ccc, LLL d 'at' h:mm a ZZZZ");
}

function buildEmergencyMessage({ booking, business }) {
  return [
    "🚨 EMERGENCY HVAC JOB",
    `Customer: ${booking?.customer_name || booking?.customer?.name || "Unknown"}`,
    `Phone: ${booking?.customer_phone || booking?.customer?.phone || "Unknown"}`,
    `Address: ${booking?.customer_address || booking?.customer?.address || "Unknown"}`,
    `Time: ${formatLocalTime(booking?.start_utc || booking?.startUtc, business?.timezone)}`,
    `Booking ID: ${booking?.id || "unknown"}`,
  ].join("\n");
}

export async function handleEmergency({ booking, business, data, twilioClient = createTwilioClient() }) {
  const technicianPhone = resolveTechnicianPhone(business);
  const message = buildEmergencyMessage({ booking, business });

  const result = {
    escalated: false,
    sms: { ok: false, error: null },
    call: { attempted: false, ok: false, error: null },
  };

  if (!technicianPhone) {
    const missingPhoneError = "Technician phone is missing";
    if (typeof data?.logEmergencyAttempt === "function") {
      await data.logEmergencyAttempt({
        businessId: booking?.business_id,
        bookingId: booking?.id,
        technicianPhone: "",
        escalationType: "sms",
        status: "failed",
        errorMessage: missingPhoneError,
      });
    }

    return {
      ...result,
      error: missingPhoneError,
    };
  }

  try {
    await twilioClient.sendSms({ to: technicianPhone, body: message });
    result.sms = { ok: true, error: null };
    result.escalated = true;

    if (typeof data?.logEmergencyAttempt === "function") {
      await data.logEmergencyAttempt({
        businessId: booking?.business_id,
        bookingId: booking?.id,
        technicianPhone,
        escalationType: "sms",
        status: "sent",
        errorMessage: null,
      });
    }
  } catch (error) {
    const errMsg = String(error?.message || error);
    result.sms = { ok: false, error: errMsg };

    if (typeof data?.logEmergencyAttempt === "function") {
      await data.logEmergencyAttempt({
        businessId: booking?.business_id,
        bookingId: booking?.id,
        technicianPhone,
        escalationType: "sms",
        status: "failed",
        errorMessage: errMsg,
      });
    }
  }

  if (process.env.TWILIO_EMERGENCY_AUTO_CALL === "1") {
    result.call.attempted = true;
    try {
      await twilioClient.makeCall({ to: technicianPhone });
      result.call.ok = true;
      result.escalated = true;

      if (typeof data?.logEmergencyAttempt === "function") {
        await data.logEmergencyAttempt({
          businessId: booking?.business_id,
          bookingId: booking?.id,
          technicianPhone,
          escalationType: "call",
          status: "sent",
          errorMessage: null,
        });
      }
    } catch (error) {
      const errMsg = String(error?.message || error);
      result.call.ok = false;
      result.call.error = errMsg;

      if (typeof data?.logEmergencyAttempt === "function") {
        await data.logEmergencyAttempt({
          businessId: booking?.business_id,
          bookingId: booking?.id,
          technicianPhone,
          escalationType: "call",
          status: "failed",
          errorMessage: errMsg,
        });
      }
    }
  }

  return result;
}
