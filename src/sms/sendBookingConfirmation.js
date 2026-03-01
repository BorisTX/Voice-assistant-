import { DateTime } from "luxon";

function getTwilioConfig() {
  return {
    accountSid: process.env.TWILIO_ACCOUNT_SID || "",
    authToken: process.env.TWILIO_AUTH_TOKEN || "",
    fromPhone: process.env.TWILIO_FROM_NUMBER || "",
  };
}

export function createTwilioClient(config = getTwilioConfig()) {
  return {
    async sendSms({ to, body }) {
      const { accountSid, authToken, fromPhone } = config;

      if (!accountSid || !authToken || !fromPhone) {
        throw new Error("Twilio is not configured");
      }

      const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
      const basicAuth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
      const payload = new URLSearchParams({ To: to, From: fromPhone, Body: body });

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basicAuth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: payload,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Twilio send failed (${response.status}): ${errText}`);
      }

      return response.json();
    },

    async makeCall({ to, twiml }) {
      const { accountSid, authToken, fromPhone } = config;

      if (!accountSid || !authToken || !fromPhone) {
        throw new Error("Twilio is not configured");
      }

      const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`;
      const basicAuth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
      const payload = new URLSearchParams({
        To: to,
        From: fromPhone,
        Twiml: twiml || "<Response><Say>Emergency HVAC booking assigned. Please check your dispatch channel immediately.</Say></Response>",
      });

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basicAuth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: payload,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Twilio call failed (${response.status}): ${errText}`);
      }

      return response.json();
    },
  };
}

function formatBookingTime(booking, timezone) {
  const dateTimeUtc = booking?.startUtc || booking?.start_utc;
  if (!dateTimeUtc) return "your scheduled time";

  const zone = timezone || booking?.timezone || "UTC";
  const dt = DateTime.fromISO(dateTimeUtc, { zone: "utc" }).setZone(zone);
  if (!dt.isValid) return dateTimeUtc;

  return dt.toFormat("ccc, LLL d 'at' h:mm a ZZZZ");
}

export async function sendBookingConfirmation({ booking, business, twilioClient = createTwilioClient() }) {
  if (booking?.status !== "confirmed") {
    return { ok: false, skipped: true, error: "Booking is not confirmed", message: null };
  }

  const phone = booking?.customer?.phone || booking?.customer_phone || null;
  const customerName = booking?.customer?.name || booking?.customer_name || "there";
  const localTime = formatBookingTime(booking, business?.timezone);
  const message = `Hi ${customerName}, your HVAC appointment is confirmed for ${localTime}. Confirmation ID: ${booking.id}`;

  if (!phone) {
    return { ok: false, error: "Customer phone is missing", message };
  }

  try {
    await twilioClient.sendSms({ to: phone, body: message });
    return { ok: true, message };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error),
      message,
    };
  }
}
