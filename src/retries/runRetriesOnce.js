import { google } from "googleapis";
import { createTwilioClient } from "../sms/sendBookingConfirmation.js";
import { makeOAuthClient, loadTokensIntoClientForBusiness } from "../../googleAuth.js";

function computeDelaySeconds(attemptCount) {
  const base = 30;
  const cap = 30 * 60;
  return Math.min(base * (2 ** Math.max(0, attemptCount - 1)), cap);
}

function toIsoAfter(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

async function executeRetry(data, retry) {
  const payload = JSON.parse(retry.payload_json || "{}");

  if (retry.kind === "twilio_sms") {
    const twilio = createTwilioClient();
    await twilio.sendSms({ to: payload.to, body: payload.body });
    if (payload.logOnSuccess) {
      await data.logSmsAttempt(payload.logOnSuccess);
    }
    return;
  }

  if (retry.kind === "gcal_create") {
    const booking = await data.getBookingById(retry.booking_id);
    if (!booking) throw new Error(`Booking not found for retry: ${retry.booking_id}`);

    const oauth2Client = makeOAuthClient();
    await loadTokensIntoClientForBusiness(data, oauth2Client, retry.business_id);
    const calendar = google.calendar({ version: "v3", auth: oauth2Client });

    const event = await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary: payload.summary || booking.job_summary || "HVAC appointment",
        description: payload.description || `bookingId: ${booking.id}`,
        start: { dateTime: booking.start_utc, timeZone: booking.timezone || "UTC" },
        end: { dateTime: booking.end_utc, timeZone: booking.timezone || "UTC" },
      },
    });

    if (booking.status === "failed") {
      await data.updateBookingStatus(booking.id, "confirmed", {
        gcal_event_id: event?.data?.id || null,
        failure_reason: null,
      });
    }
    return;
  }

  if (retry.kind === "gcal_delete") {
    const oauth2Client = makeOAuthClient();
    await loadTokensIntoClientForBusiness(data, oauth2Client, retry.business_id);
    const calendar = google.calendar({ version: "v3", auth: oauth2Client });
    await calendar.events.delete({ calendarId: "primary", eventId: payload.eventId });
    return;
  }

  throw new Error(`Unsupported retry kind: ${retry.kind}`);
}

export async function runRetriesOnce({ data, limit = 20 } = {}) {
  if (!data) {
    console.error("runRetriesOnce: data layer missing");
    return { ok: false, processed: 0, reason: "data-layer-missing" };
  }

  let processed = 0;

  try {
    const retries = await data.listDueRetries(limit);

    for (const retry of retries) {
      const attemptCount = Number(retry.attempt_count || 0) + 1;
      processed += 1;

      try {
        await executeRetry(data, retry);
        await data.markRetryAttempt(retry.id, {
          attemptCount,
          nextAttemptAtUtc: retry.next_attempt_at_utc,
          status: "succeeded",
          lastError: null,
        });
      } catch (error) {
        const lastError = String(error?.message || error);
        const maxAttempts = Number(retry.max_attempts || 5);
        const exhausted = attemptCount >= maxAttempts;
        await data.markRetryAttempt(retry.id, {
          attemptCount,
          nextAttemptAtUtc: exhausted
            ? retry.next_attempt_at_utc
            : toIsoAfter(computeDelaySeconds(attemptCount)),
          status: exhausted ? "failed" : "pending",
          lastError,
        });
        console.error("Retry failed", { retryId: retry.id, kind: retry.kind, attemptCount, lastError });
      }
    }
  } catch (error) {
    console.error("runRetriesOnce global error", error);
  }

  return { ok: true, processed };
}
