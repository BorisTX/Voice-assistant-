import crypto from "crypto";
import { DateTime } from "luxon";
import { sendBookingConfirmation } from "../sms/sendBookingConfirmation.js";

function toSafeErrorCode(error) {
  const message = String(error?.message || "");
  if (message.includes("No tokens for this business")) return "NO_GOOGLE_TOKENS";
  if (message.includes("Missing GOOGLE_CLIENT_ID") || message.includes("Missing GOOGLE_CLIENT_SECRET")) {
    return "GOOGLE_OAUTH_NOT_CONFIGURED";
  }
  return "UNEXPECTED_ERROR";
}

function normalizeInput(body) {
  const businessId = body?.businessId ?? body?.business_id;
  const startLocal = body?.startLocal ?? body?.start_local;
  const timezone = body?.timezone;
  const durationMinsRaw = body?.durationMins ?? body?.duration_min;
  const bufferMinsRaw = body?.bufferMins ?? body?.buffer_min;

  const customer = body?.customer || {
    name: body?.customer_name,
    phone: body?.customer_phone,
    email: body?.customer_email,
    address: body?.address,
  };

  return {
    businessId: businessId != null ? String(businessId) : "",
    startLocal: startLocal != null ? String(startLocal) : "",
    timezone: timezone != null ? String(timezone) : "",
    durationMinsRaw,
    bufferMinsRaw,
    service: body?.service ? String(body.service) : null,
    customer,
    notes: body?.notes ? String(body.notes) : null,
  };
}

function validateAndBuildSchedule({ input, business }) {
  const errors = [];
  if (!input.businessId) errors.push("Missing businessId");
  if (!input.startLocal) errors.push("Missing startLocal");
  if (!input.timezone) errors.push("Missing timezone");

  const durationMins = Number(
    input.durationMinsRaw != null ? input.durationMinsRaw : business.default_duration_min || 60
  );
  if (!Number.isFinite(durationMins) || durationMins <= 0 || durationMins > 8 * 60) {
    errors.push("Invalid durationMins");
  }

  const defaultBuffer = Number(business.buffer_before_min || business.buffer_min || business.buffer_minutes || 0);
  const bufferMins = Number(input.bufferMinsRaw != null ? input.bufferMinsRaw : defaultBuffer);
  if (!Number.isFinite(bufferMins) || bufferMins < 0 || bufferMins > 24 * 60) {
    errors.push("Invalid bufferMins");
  }

  const startZ = DateTime.fromISO(input.startLocal, { zone: input.timezone, setZone: true });
  if (!startZ.isValid) errors.push("Invalid startLocal/timezone");

  if (errors.length > 0) return { ok: false, errors };

  const endZ = startZ.plus({ minutes: durationMins });
  const holdStartZ = startZ.minus({ minutes: bufferMins });
  const holdEndZ = endZ.plus({ minutes: bufferMins });

  return {
    ok: true,
    startUtcIso: startZ.toUTC().toISO(),
    endUtcIso: endZ.toUTC().toISO(),
    holdStartUtcIso: holdStartZ.toUTC().toISO(),
    holdEndUtcIso: holdEndZ.toUTC().toISO(),
  };
}

function buildCalendarDescription({ bookingId, customer, notes }) {
  return [
    bookingId ? `bookingId: ${bookingId}` : null,
    customer?.name ? `Name: ${customer.name}` : null,
    customer?.phone ? `Phone: ${customer.phone}` : null,
    customer?.email ? `Email: ${customer.email}` : null,
    customer?.address ? `Address: ${customer.address}` : null,
    notes ? `Notes: ${notes}` : null,
  ].filter(Boolean).join("\n");
}

export async function createBookingFlow({
  data,
  body,
  makeOAuthClient,
  loadTokensIntoClientForBusiness,
  google,
  googleApiTimeoutMs,
  withTimeout,
  sendBookingConfirmationFn = sendBookingConfirmation,
}) {
  let bookingId = null;
  const input = normalizeInput(body);
  const businessId = input.businessId;

  const log = (level, phase, msg, extra = {}) => {
    const logger = level === "error" ? console.error : console.log;
    logger(JSON.stringify({ level, phase, businessId, bookingId, msg, ...extra }));
  };

  try {
    if (!data) return { status: 500, body: { ok: false, error: "Data layer not ready" } };

    const business = input.businessId ? await data.getBusinessById(input.businessId) : null;
    if (!business && input.businessId) {
      return { status: 404, body: { ok: false, error: "Business not found" } };
    }

    const schedule = validateAndBuildSchedule({ input, business: business || {} });
    if (!schedule.ok) {
      return { status: 400, body: { ok: false, error: schedule.errors.join("; ") } };
    }

    if (typeof data.cleanupExpiredHolds === "function") {
      await data.cleanupExpiredHolds(input.businessId);
    }

    bookingId = crypto.randomUUID();
    log("info", "hold", "Creating pending hold", {
      startUtc: schedule.startUtcIso,
      endUtc: schedule.endUtcIso,
      holdStartUtc: schedule.holdStartUtcIso,
      holdEndUtc: schedule.holdEndUtcIso,
    });

    const hold = await data.createPendingHoldIfAvailableTx({
      id: bookingId,
      business_id: input.businessId,
      start_utc: schedule.startUtcIso,
      end_utc: schedule.endUtcIso,
      overlap_start_utc: schedule.holdStartUtcIso,
      overlap_end_utc: schedule.holdEndUtcIso,
      hold_expires_at_utc: DateTime.utc().plus({ minutes: 5 }).toISO(),
      customer_name: input.customer?.name || null,
      customer_phone: input.customer?.phone || null,
      customer_email: input.customer?.email || null,
      customer_address: input.customer?.address || null,
      service: input.service,
      notes: input.notes,
      job_summary: input.service || "HVAC",
    });

    if (!hold?.ok) {
      return { status: 409, body: { ok: false, error: "Slot not available" } };
    }

    const oauth2Client = makeOAuthClient();

    try {
      await loadTokensIntoClientForBusiness(data, oauth2Client, input.businessId);
    } catch (error) {
      const reason = toSafeErrorCode(error);
      await data.failBooking(bookingId, reason);
      return { status: 403, body: { ok: false, error: "Google Calendar is not connected" } };
    }

    const calendar = google.calendar({ version: "v3", auth: oauth2Client });
    const created = await withTimeout(
      calendar.events.insert({
        calendarId: "primary",
        requestBody: {
          summary: `${input.service || "HVAC"} - ${input.customer?.name || "Customer"}`,
          description: buildCalendarDescription({ bookingId, customer: input.customer, notes: input.notes }),
          start: {
            dateTime: schedule.startUtcIso,
            timeZone: input.timezone,
          },
          end: {
            dateTime: schedule.endUtcIso,
            timeZone: input.timezone,
          },
        },
      }),
      googleApiTimeoutMs,
      "google.events.insert"
    );

    await data.confirmBooking(bookingId, created?.data?.id || null);
    log("info", "confirm", "Booking confirmed", { gcalEventId: created?.data?.id || null });

    const bookingForSms = {
      id: bookingId,
      status: "confirmed",
      startUtc: schedule.startUtcIso,
      timezone: input.timezone,
      customer: {
        name: input.customer?.name || null,
        phone: input.customer?.phone || null,
      },
    };

    Promise.resolve()
      .then(async () => {
        const smsResult = await sendBookingConfirmationFn({ booking: bookingForSms, business });
        const status = smsResult?.ok ? "sent" : "failed";

        if (typeof data.logSmsAttempt === "function") {
          await data.logSmsAttempt({
            businessId: input.businessId,
            bookingId,
            phone: input.customer?.phone ? String(input.customer.phone) : "",
            message: smsResult?.message || null,
            status,
            errorMessage: smsResult?.ok ? null : smsResult?.error || "Unknown SMS error",
          });
        }

        log("info", "sms", "SMS confirmation attempted", { status });
      })
      .catch((smsError) => {
        log("error", "sms", "SMS flow failed", { error: String(smsError?.message || smsError) });
      });

    return {
      status: 200,
      body: {
        ok: true,
        bookingId,
        status: "confirmed",
        gcalEventId: created?.data?.id || null,
        startUtc: schedule.startUtcIso,
        endUtc: schedule.endUtcIso,
      },
    };
  } catch (error) {
    const reason = toSafeErrorCode(error);
    log("error", "exception", "createBooking failed", { reason, error: String(error?.message || error) });

    if (bookingId) {
      try {
        await data.failBooking(bookingId, reason);
      } catch (failError) {
        log("error", "fail", "Could not mark booking failed", { error: String(failError?.message || failError) });
      }
    }

    return { status: 500, body: { ok: false, error: "Internal error" } };
  }
}
