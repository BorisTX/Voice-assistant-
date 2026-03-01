import crypto from "crypto";
import { DateTime } from "luxon";
import { sendBookingConfirmation } from "../sms/sendBookingConfirmation.js";
import { handleEmergency } from "../emergency/handleEmergency.js";
import { isOutsideBusinessHours } from "../emergency/businessHours.js";
import { getRetryErrorDetails, isRetryableGoogleError, retry } from "./retry.js";

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
    emergencyFlag: body?.isEmergency === true || body?.is_emergency === true || body?.emergency === true,
    customer,
    notes: body?.notes ? String(body.notes) : null,
  };
}

function validateAndBuildSchedule({ input, business, businessProfile }) {
  const errors = [];
  if (!input.businessId) errors.push("Missing businessId");
  if (!input.startLocal) errors.push("Missing startLocal");
  if (!input.timezone) errors.push("Missing timezone");

  const durationMins = Number(
    input.durationMinsRaw != null ? input.durationMinsRaw : businessProfile?.slot_duration_min || business.default_duration_min || 60
  );
  if (!Number.isFinite(durationMins) || durationMins <= 0 || durationMins > 8 * 60) {
    errors.push("Invalid durationMins");
  }

  const defaultBuffer = Number(
    businessProfile?.buffer_min ?? business.buffer_before_min ?? business.buffer_min ?? business.buffer_minutes ?? 0
  );
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
    durationMins,
    startUtcIso: startZ.toUTC().toISO(),
    endUtcIso: endZ.toUTC().toISO(),
    holdStartUtcIso: holdStartZ.toUTC().toISO(),
    holdEndUtcIso: holdEndZ.toUTC().toISO(),
  };
}

function normalizePhoneDigits(phone) {
  return String(phone || "").replace(/\D/g, "");
}

function buildBookingIdempotencyKey({ businessId, startUtcIso, durationMins, phoneDigits }) {
  const keyInput = `${businessId}|${startUtcIso}|${durationMins}|${phoneDigits}`;
  return crypto.createHash("sha256").update(keyInput).digest("hex").slice(0, 32);
}

function validateBookingTimeWindow({ input, business, businessProfile, nowDt }) {
  const timezone = businessProfile?.timezone || business?.timezone || input.timezone || "America/Chicago";
  const leadTimeMin = Math.max(
    0,
    Number(
      businessProfile?.lead_time_min ?? business?.lead_time_min ?? 60
    ) || 0
  );
  const maxDaysAhead = Math.max(
    0,
    Number(
      businessProfile?.max_days_ahead ?? business?.max_days_ahead ?? 14
    ) || 0
  );

  const requestedStartBusiness = DateTime.fromISO(input.startLocal, { zone: timezone });
  if (!requestedStartBusiness.isValid) {
    return { ok: true, details: [] };
  }

  const nowBusiness = nowDt.setZone(timezone);
  const earliestAllowed = nowBusiness.plus({ minutes: leadTimeMin });
  const latestAllowed = nowBusiness.plus({ days: maxDaysAhead }).endOf("day");
  const details = [];

  if (requestedStartBusiness < earliestAllowed) {
    details.push({
      reason: "START_TOO_SOON",
      policyTimezone: timezone,
      requestedStartLocal: requestedStartBusiness.toISO(),
      earliestAllowedLocal: earliestAllowed.toISO(),
      leadTimeMin,
    });
  }

  if (requestedStartBusiness > latestAllowed) {
    details.push({
      reason: "START_TOO_FAR",
      policyTimezone: timezone,
      requestedStartLocal: requestedStartBusiness.toISO(),
      latestAllowedLocal: latestAllowed.toISO(),
      maxDaysAhead,
      latestAllowedRule: "end_of_day_in_business_timezone",
    });
  }

  return { ok: details.length === 0, details };
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

function validateFoundEventMatchesSchedule({ event, idempotencyKey, schedule }) {
  const foundKey = event?.extendedProperties?.private?.idempotencyKey;
  if (foundKey !== idempotencyKey) {
    return { ok: false, reason: "idempotency-key-mismatch" };
  }

  const eventStartDateTime = event?.start?.dateTime;
  const eventEndDateTime = event?.end?.dateTime;
  const eventStartDate = event?.start?.date;
  const eventEndDate = event?.end?.date;

  const expectedStartUtc = DateTime.fromISO(schedule.startUtcIso, { zone: "utc" });
  const expectedEndUtc = DateTime.fromISO(schedule.endUtcIso, { zone: "utc" });
  if (!expectedStartUtc.isValid || !expectedEndUtc.isValid) {
    return { ok: false, reason: "expected-schedule-invalid" };
  }

  if (eventStartDateTime || eventEndDateTime) {
    const foundStartUtc = DateTime.fromISO(eventStartDateTime || "", { setZone: true }).toUTC();
    const foundEndUtc = DateTime.fromISO(eventEndDateTime || "", { setZone: true }).toUTC();
    if (!foundStartUtc.isValid || !foundEndUtc.isValid) {
      return { ok: false, reason: "found-event-datetime-invalid" };
    }

    const startDiffMinutes = Math.abs(foundStartUtc.diff(expectedStartUtc, "minutes").minutes);
    const endDiffMinutes = Math.abs(foundEndUtc.diff(expectedEndUtc, "minutes").minutes);
    if (startDiffMinutes > 2 || endDiffMinutes > 2) {
      return { ok: false, reason: "datetime-outside-tolerance" };
    }

    return { ok: true };
  }

  if (eventStartDate || eventEndDate) {
    const expectedStartDate = expectedStartUtc.toISODate();
    const expectedEndDate = expectedEndUtc.toISODate();
    if (eventStartDate !== expectedStartDate || eventEndDate !== expectedEndDate) {
      return { ok: false, reason: "all-day-date-mismatch" };
    }
    return { ok: true };
  }

  return { ok: false, reason: "found-event-missing-start-end" };
}

export async function createBookingFlow({
  data,
  body,
  makeOAuthClient,
  loadTokensIntoClientForBusiness,
  google,
  googleApiTimeoutMs,
  withTimeout,
  nowFn = () => DateTime.now(),
  sendBookingConfirmationFn = sendBookingConfirmation,
  handleEmergencyFn = handleEmergency,
  requestId = null,
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

    const businessProfile = input.businessId ? await data.getEffectiveBusinessProfile(input.businessId) : null;

    const schedule = validateAndBuildSchedule({ input, business: business || {}, businessProfile });
    if (!schedule.ok) {
      return { status: 400, body: { ok: false, error: schedule.errors.join("; ") } };
    }

    const windowValidation = validateBookingTimeWindow({
      input,
      business: business || {},
      businessProfile,
      nowDt: nowFn(),
    });
    if (!windowValidation.ok) {
      return {
        status: 400,
        body: {
          ok: false,
          error: "INVALID_BOOKING_TIME_WINDOW",
          details: windowValidation.details,
        },
      };
    }

    const idempotencyKey = buildBookingIdempotencyKey({
      businessId: input.businessId,
      startUtcIso: schedule.startUtcIso,
      durationMins: schedule.durationMins,
      phoneDigits: normalizePhoneDigits(input.customer?.phone),
    });

    if (typeof data.cleanupExpiredHolds === "function") {
      await data.cleanupExpiredHolds(input.businessId);
    }

    const existingBooking = await data.getBookingByIdempotencyKey(input.businessId, idempotencyKey);
    if (existingBooking) {
      if (existingBooking.status === "confirmed") {
        return {
          status: 200,
          body: { ok: true, status: "confirmed", bookingId: existingBooking.id },
        };
      }

      return {
        status: 202,
        body: { ok: true, status: "pending", bookingId: existingBooking.id },
      };
    }

    const isEmergencyService = (input.service || "").toLowerCase() === "emergency";
    const isAfterHours = isOutsideBusinessHours({
      startUtc: schedule.startUtcIso,
      businessProfile: {
        timezone: businessProfile?.timezone || business?.timezone,
        working_hours_start: business?.working_hours_start,
        working_hours_end: business?.working_hours_end,
        working_hours_json: businessProfile?.working_hours
          ? JSON.stringify(businessProfile.working_hours)
          : business?.working_hours_json,
      },
    });

    const isEmergency = isEmergencyService || isAfterHours || input.emergencyFlag;
    const slotKey = `${input.businessId}:${schedule.startUtcIso}`;
    log("info", "hold", "Creating pending hold", {
      startUtc: schedule.startUtcIso,
      endUtc: schedule.endUtcIso,
      holdStartUtc: schedule.holdStartUtcIso,
      holdEndUtc: schedule.holdEndUtcIso,
      slotKey,
      isEmergency,
      isAfterHours,
      isEmergencyService,
    });

    let txOpen = false;
    let created;

    const oauth2Client = makeOAuthClient();
    try {
      await loadTokensIntoClientForBusiness(data, oauth2Client, input.businessId);
    } catch {
      return { status: 403, body: { ok: false, error: "Google Calendar is not connected" } };
    }

    const calendar = google.calendar({ version: "v3", auth: oauth2Client });
    const googleOpTimeoutMs = Math.min(googleApiTimeoutMs, 2500);
    const freeBusy = await retry(
      () => withTimeout(
        calendar.freebusy.query({
          requestBody: {
            timeMin: schedule.startUtcIso,
            timeMax: schedule.endUtcIso,
            items: [{ id: "primary" }],
          },
        }),
        googleOpTimeoutMs,
        "google.freebusy"
      ),
      {
        label: "google.freebusy",
        maxAttempts: 3,
        baseDelayMs: 250,
        maxDelayMs: 1500,
        retryOn: isRetryableGoogleError,
        requestId,
        maxElapsedMs: 4500,
      }
    );

    const busyRanges = freeBusy?.data?.calendars?.primary?.busy || [];
    if (busyRanges.length > 0) {
      return { status: 409, body: { ok: false, error: "SLOT_ALREADY_BOOKED" } };
    }

    bookingId = crypto.randomUUID();

    try {
      await data.beginImmediateTransaction();
      txOpen = true;

      await data.createPendingBookingLock({
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
        service_address: input.customer?.address || null,
        service_type: input.service || "HVAC",
        timezone: input.timezone,
        slot_key: slotKey,
        idempotency_key: idempotencyKey,
        service: input.service,
        notes: input.notes,
        job_summary: isEmergency ? `[EMERGENCY] ${input.service || "HVAC"}` : input.service || "HVAC",
        is_emergency: isEmergency ? 1 : 0,
      });

      await data.commitTransaction();
      txOpen = false;
    } catch (error) {
      if (txOpen) {
        try {
          await data.rollbackTransaction();
        } catch {}
      }

      const isSqliteConstraint = String(error?.code || "") === "SQLITE_CONSTRAINT";
      const message = String(error?.message || "");
      const isIdempotencyConstraint = message.includes("uniq_bookings_active_idempotency_key")
        || message.includes("bookings.idempotency_key");
      if (isSqliteConstraint && isIdempotencyConstraint) {
        const existingOnConflict = await data.getBookingByIdempotencyKey(input.businessId, idempotencyKey);
        if (existingOnConflict?.status === "confirmed") {
          return {
            status: 200,
            body: { ok: true, status: "confirmed", bookingId: existingOnConflict.id },
          };
        }
        if (existingOnConflict?.status === "pending") {
          return {
            status: 202,
            body: { ok: true, status: "pending", bookingId: existingOnConflict.id },
          };
        }
      }

      if (isSqliteConstraint || message.includes("UNIQUE")) {
        return { status: 409, body: { ok: false, error: "SLOT_ALREADY_BOOKED" } };
      }
      return { status: 500, body: { ok: false, error: "Internal error" } };
    }

    const insertParams = {
      calendarId: "primary",
      requestBody: {
        summary: `${isEmergency ? "🚨 " : ""}${input.service || "HVAC"} - ${input.customer?.name || "Customer"}`,
        description: `${buildCalendarDescription({ bookingId, customer: input.customer, notes: input.notes })}\nIdempotency-Key: ${idempotencyKey}`,
        extendedProperties: { private: { idempotencyKey } },
        start: {
          dateTime: schedule.startUtcIso,
          timeZone: input.timezone,
        },
        end: {
          dateTime: schedule.endUtcIso,
          timeZone: input.timezone,
        },
      },
    };

    let bookingAlreadyConfirmed = false;
    for (let insertAttempt = 1; insertAttempt <= 2; insertAttempt += 1) {
      try {
        created = await withTimeout(
          calendar.events.insert(insertParams),
          googleOpTimeoutMs,
          "google.events.insert"
        );
        break;
      } catch (insertError) {
        const transientInsert = isRetryableGoogleError(insertError);
        if (!idempotencyKey || !transientInsert || insertAttempt >= 2) {
          await data.failBooking(bookingId, "GOOGLE_EVENTS_INSERT_FAILED");
          return { status: 500, body: { ok: false, error: "Internal error" } };
        }

        const details = getRetryErrorDetails(insertError);
        console.warn(JSON.stringify({
          level: "warn",
          type: "insert-failed-transient",
          requestId,
          bookingId,
          idempotencyKey,
          ...details,
        }));

        const startUtc = DateTime.fromISO(schedule.startUtcIso, { zone: "utc" });
        const endUtc = DateTime.fromISO(schedule.endUtcIso, { zone: "utc" });
        const durationMinutes = Math.ceil(endUtc.diff(startUtc, "minutes").minutes);
        const padMinutes = Math.max(60, Math.min(24 * 60, durationMinutes + 60));
        const timeMinIso = startUtc.minus({ minutes: padMinutes }).toISO();
        const timeMaxIso = endUtc.plus({ minutes: padMinutes }).toISO();

        let existingEvent = null;
        try {
          const existingEventSearch = await retry(
            () => withTimeout(
              calendar.events.list({
                calendarId: "primary",
                timeMin: timeMinIso,
                timeMax: timeMaxIso,
                singleEvents: true,
                privateExtendedProperty: `idempotencyKey=${idempotencyKey}`,
              }),
              googleOpTimeoutMs,
              "google.events.list.idempotency"
            ),
            {
              label: "google.events.list.idempotency",
              maxAttempts: 2,
              baseDelayMs: 250,
              maxDelayMs: 1000,
              retryOn: isRetryableGoogleError,
              requestId,
              maxElapsedMs: 2500,
            }
          );
          existingEvent = existingEventSearch?.data?.items?.[0] || null;
        } catch {}

        if (existingEvent?.id) {
          const matchValidation = validateFoundEventMatchesSchedule({
            event: existingEvent,
            idempotencyKey,
            schedule,
          });
          if (!matchValidation.ok) {
            console.warn(JSON.stringify({
              level: "warn",
              type: "idempotency-mismatch",
              requestId,
              bookingId,
              idempotencyKey,
              foundEventId: existingEvent.id,
              foundStart: existingEvent?.start?.dateTime || existingEvent?.start?.date || null,
              foundEnd: existingEvent?.end?.dateTime || existingEvent?.end?.date || null,
              expectedStart: schedule.startUtcIso,
              expectedEnd: schedule.endUtcIso,
              reason: matchValidation.reason,
            }));
            existingEvent = null;
          }
        }

        if (existingEvent?.id) {
          console.log(JSON.stringify({
            level: "info",
            type: "insert-detected-existing-event",
            requestId,
            bookingId,
            gcalEventId: existingEvent.id,
          }));
          await data.confirmBooking(bookingId, existingEvent.id);
          bookingAlreadyConfirmed = true;
          created = { data: { id: existingEvent.id } };
          break;
        }

        console.warn(JSON.stringify({
          level: "warn",
          type: "retry",
          requestId,
          label: "google.events.insert",
          attempt: insertAttempt,
          ...details,
        }));
      }
    }

    if (!bookingAlreadyConfirmed) {
      await data.confirmBooking(bookingId, created?.data?.id || null);
    }

    log("info", "confirm", "Booking confirmed", { gcalEventId: created?.data?.id || null, isEmergency });

    const bookingForSms = {
      id: bookingId,
      business_id: input.businessId,
      status: "confirmed",
      startUtc: schedule.startUtcIso,
      start_utc: schedule.startUtcIso,
      timezone: input.timezone,
      is_emergency: isEmergency,
      customer: {
        name: input.customer?.name || null,
        phone: input.customer?.phone || null,
        address: input.customer?.address || null,
      },
      customer_name: input.customer?.name || null,
      customer_phone: input.customer?.phone || null,
      customer_address: input.customer?.address || null,
    };

    Promise.resolve()
      .then(async () => {
        if (typeof data.logSmsAttempt === "function") {
          await data.logSmsAttempt({
            businessId: input.businessId,
            bookingId,
            toNumber: input.customer?.phone ? String(input.customer.phone) : "",
            messageBody: null,
            type: "confirmation",
            status: "queued",
            errorMessage: null,
          });
        }

        const smsResult = await sendBookingConfirmationFn({ booking: bookingForSms, business });
        const status = smsResult?.ok ? "sent" : "failed";

        if (typeof data.logSmsAttempt === "function") {
          await data.logSmsAttempt({
            businessId: input.businessId,
            bookingId,
            toNumber: input.customer?.phone ? String(input.customer.phone) : "",
            messageBody: smsResult?.message || null,
            type: "confirmation",
            status: smsResult?.ok ? "sent" : "failed",
            errorMessage: smsResult?.ok ? null : smsResult?.error || "Unknown SMS error",
          });
        }

        if (!smsResult?.ok && typeof data.enqueueRetry === "function") {
          await data.enqueueRetry({
            businessId: input.businessId,
            bookingId,
            kind: "twilio_sms",
            payloadJson: {
              to: input.customer?.phone ? String(input.customer.phone) : "",
              body: smsResult?.message || null,
            },
          });
        }

        log("info", "sms", "SMS confirmation attempted", { status });
      })
      .catch((smsError) => {
        log("error", "sms", "SMS flow failed", { error: String(smsError?.message || smsError) });
      });

    let emergencyEscalated = false;

    if (isEmergency) {
      Promise.resolve()
        .then(async () => {
          const emergencyResult = await handleEmergencyFn({
            booking: bookingForSms,
            business,
            data,
          });

          log("info", "emergency", "Emergency escalation attempted", {
            escalated: Boolean(emergencyResult?.escalated),
            smsOk: Boolean(emergencyResult?.sms?.ok),
            callAttempted: Boolean(emergencyResult?.call?.attempted),
            callOk: Boolean(emergencyResult?.call?.ok),
          });
        })
        .catch((emergencyError) => {
          log("error", "emergency", "Emergency escalation failed", {
            error: String(emergencyError?.message || emergencyError),
          });
        });

      emergencyEscalated = true;
    }

    return {
      status: 200,
      body: {
        ok: true,
        bookingId,
        status: "confirmed",
        gcalEventId: created?.data?.id || null,
        startUtc: schedule.startUtcIso,
        endUtc: schedule.endUtcIso,
        isEmergency,
        emergencyEscalated,
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
