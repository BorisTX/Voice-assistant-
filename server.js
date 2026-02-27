// server.js
import "dotenv/config";

import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import crypto from "crypto";
import { google } from "googleapis";
import { DateTime } from "luxon";

import { normalizeBusyUtc, generateSlots } from "./src/slots.js";
import { openDb, runMigrations } from "./src/db/migrate.js";
import { makeDataLayer } from "./src/data/index.js";

import {
  makeOAuthClient,
  getAuthUrlForBusiness,
  loadTokensIntoClientForBusiness,
  exchangeCodeAndStoreForBusiness,
} from "./googleAuth.js";
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  const startAt = Date.now();
  console.log(`[req:${req.requestId}] -> ${req.method} ${req.url}`);
  res.on("finish", () => {
    console.log(`[req:${req.requestId}] <- ${res.statusCode} ${req.method} ${req.url} (${Date.now() - startAt}ms)`);
  });
  next();
});

function ensureDebugEnabled(req, res) {
  if (process.env.ENABLE_DEBUG_ROUTES === "1") return true;
  res.status(403).json({ ok: false, error: "Debug routes are disabled" });
  return false;
}


// Health check
app.get("/", (req, res) => res.status(200).send("OK"));

// --------------------
// Debug: DB inspection
// --------------------
app.get("/debug/db", async (req, res) => {
  try {
    if (!ensureDebugEnabled(req, res)) return;
    if (!db) return res.status(500).json({ ok: false, error: "DB not ready yet" });

    const tables = await data.listTables();
    res.json({ ok: true, tables });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/debug/businesses", async (req, res) => {
  try {
    if (!ensureDebugEnabled(req, res)) return;
    if (!db) return res.status(500).json({ ok: false, error: "DB not ready yet" });

    const businesses = await data.listBusinesses();
    res.json({ ok: true, count: businesses.length, businesses });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * Creates a default business once (idempotent).
 * GET /debug/create-default-business
 */
app.get("/debug/create-default-business", async (req, res) => {
  try {
    if (!ensureDebugEnabled(req, res)) return;
    if (!db) return res.status(500).json({ ok: false, error: "DB not ready yet" });

    const name = "Default HVAC (DFW)";

    const existing = await data.getBusinessByName(name);
    if (existing) {
      return res.json({ ok: true, created: false, businessId: existing.id, business: existing });
    }

    const businessId = crypto.randomUUID();

    const workingHours = {
      mon: [{ start: "08:00", end: "17:00" }],
      tue: [{ start: "08:00", end: "17:00" }],
      wed: [{ start: "08:00", end: "17:00" }],
      thu: [{ start: "08:00", end: "17:00" }],
      fri: [{ start: "08:00", end: "17:00" }],
      sat: [],
      sun: [],
    };

    const emergencyKeywords = ["no heat", "no cooling", "gas smell", "water leak", "flooding"];

    await data.insertBusiness({
      id: businessId,
      name,
      industry: "hvac",
      timezone: "America/Chicago",
      working_hours_json: JSON.stringify(workingHours),
      default_duration_min: 60,
      slot_granularity_min: 15,
      buffer_before_min: 0,
      buffer_after_min: 30,
      lead_time_min: 60,
      max_days_ahead: 7,
      max_daily_jobs: null,
      emergency_enabled: 1,
      emergency_keywords_json: JSON.stringify(emergencyKeywords),
    });

    res.json({ ok: true, created: true, businessId });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// --------------------
// OAuth (Business-only)
// --------------------
app.get("/auth/google-business", async (req, res) => {
  try {
    if (!data) return res.status(500).send("Data layer not ready");

    const businessId = String(req.query.business_id || "");
    if (!businessId) return res.status(400).send("Missing business_id");

    const oauth2Client = makeOAuthClient();

    const url = await getAuthUrlForBusiness(
      data,
      oauth2Client,
      businessId
    );

    return res.redirect(url);
  } catch (e) {
    console.error("ERROR in /auth/google-business:", e);
    return res.status(500).send("OAuth error: " + String(e?.message || e));
  }
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    if (!data) return res.status(500).send("Data layer not ready");

    const code = String(req.query.code || "");
    const businessId = String(req.query.state || "");

    if (!code) return res.status(400).send("Missing code");
    if (!businessId) return res.status(400).send("Missing state");

    const oauth2Client = makeOAuthClient();

    await exchangeCodeAndStoreForBusiness(
      data,
      oauth2Client,
      code,
      businessId
    );

    return res.send("Business Google Calendar connected ✅");
  } catch (e) {
    console.error("OAuth callback error:", e);
    return res.status(500).send("OAuth failed: " + String(e?.message || e));
  }
});

// --------------------
// Debug: tokens & calendar
// --------------------
app.get("/debug/tokens-business", async (req, res) => {
  try {
    if (!ensureDebugEnabled(req, res)) return;
    if (!data) return res.status(500).json({ ok: false, error: "Data layer not ready" });

    const businessId = String(req.query.business_id || "");
    if (!businessId) return res.status(400).json({ ok: false, error: "Missing business_id" });

    const row = await data.getGoogleTokens(businessId);

    res.json({
      ok: true,
      businessId,
      hasAccessToken: !!row?.access_token,
      hasRefreshToken: !!row?.refresh_token,
      scope: row?.scope,
      expiry_date_utc: row?.expiry_date_utc,
      updated_at_utc: row?.updated_at_utc,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/debug/calendar-business", async (req, res) => {
  try {
    if (!ensureDebugEnabled(req, res)) return;
    if (!data) return res.status(500).json({ ok: false, error: "Data layer not ready" });

    const businessId = String(req.query.business_id || "");
    if (!businessId) return res.status(400).json({ ok: false, error: "Missing business_id" });

    const oauth2Client = makeOAuthClient();
    await loadTokensIntoClientForBusiness(data, oauth2Client, businessId);

    const calendar = google.calendar({ version: "v3", auth: oauth2Client });
    const now = new Date().toISOString();

    const result = await calendar.events.list({
      calendarId: "primary",
      timeMin: now,
      maxResults: 10,
      singleEvents: true,
      orderBy: "startTime",
    });

    res.json({
      ok: true,
      businessId,
      items: (result.data.items || []).map((e) => ({
        summary: e.summary,
        start: e.start?.dateTime || e.start?.date,
        end: e.end?.dateTime || e.end?.date,
      })),
    });
  } catch (e) {
    console.error("DEBUG calendar-business error:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// --------------------
// Slots API
// --------------------
app.get("/api/available-slots", async (req, res) => {
  try {
    if (!data) return res.status(500).json({ ok: false, error: "Data layer not ready" });

    const businessId = String(req.query.business_id || "").trim();
    if (!businessId) return res.status(400).json({ ok: false, error: "business_id is required" });

    const business = await data.getBusinessById(businessId);
    if (!business) return res.status(404).json({ ok: false, error: "Business not found" });

    const timezone = business.timezone || "America/Chicago";
    const durationMinRaw = req.query.duration_min ?? business.default_duration_min ?? 60;
    const durationMin = Number(durationMinRaw);
    if (!Number.isFinite(durationMin) || durationMin <= 0 || durationMin > 8 * 60) {
      return res.status(400).json({ ok: false, error: "duration_min must be between 1 and 480" });
    }

    const maxDaysAhead = Number(business.max_days_ahead || 7);
    const daysReq = req.query.days ? Number(req.query.days) : maxDaysAhead;
    const days = Math.max(1, Math.min(Number.isFinite(daysReq) ? daysReq : maxDaysAhead, maxDaysAhead));

    const fromStr = String(req.query.from || "").trim();
    const windowStartLocal = fromStr
      ? DateTime.fromISO(fromStr, { zone: timezone }).startOf("day")
      : DateTime.now().setZone(timezone).startOf("day");

    if (!windowStartLocal.isValid) {
      return res.status(400).json({ ok: false, error: "from must be valid ISO date (YYYY-MM-DD)" });
    }

    const nowLocal = DateTime.now().setZone(timezone).startOf("day");
    if (windowStartLocal < nowLocal || windowStartLocal > nowLocal.plus({ days: maxDaysAhead })) {
      return res.status(400).json({ ok: false, error: `from is outside allowed window (0-${maxDaysAhead} days)` });
    }

    const windowEndLocal = windowStartLocal.plus({ days });
    const timeMinUtc = windowStartLocal.toUTC().toISO();
    const timeMaxUtc = windowEndLocal.toUTC().toISO();

    let busy = [];
    let warning = null;

    try {
      const oauth2Client = makeOAuthClient();
      await loadTokensIntoClientForBusiness(data, oauth2Client, businessId);

      const calendar = google.calendar({ version: "v3", auth: oauth2Client });
      const fb = await calendar.freebusy.query({
        requestBody: {
          timeMin: timeMinUtc,
          timeMax: timeMaxUtc,
          timeZone: "UTC",
          items: [{ id: "primary" }],
        },
      });
      busy = fb?.data?.calendars?.primary?.busy || [];
    } catch (googleErr) {
      warning = "Calendar busy lookup unavailable; using DB-only availability";
      console.warn("[available-slots] freebusy fallback", {
        businessId,
        message: String(googleErr?.message || googleErr),
      });
    }

    const bufferBefore = Number(business.buffer_before_min || 0);
    const bufferAfter = Number(business.buffer_after_min || 0);
    const busyMergedUtc = normalizeBusyUtc(busy, bufferBefore, bufferAfter);

    let slots = generateSlots({
      business,
      windowStartDate: windowStartLocal,
      days,
      durationMin,
      busyMergedUtc,
    });

    const maxDailyJobs = Number(business.max_daily_jobs || 0);
    if (Number.isFinite(maxDailyJobs) && maxDailyJobs > 0) {
      const filtered = [];
      const confirmedCounts = new Map();
      for (let d = windowStartLocal; d < windowEndLocal; d = d.plus({ days: 1 })) {
        const dayStart = d.startOf("day").toUTC().toISO();
        const dayEnd = d.endOf("day").toUTC().toISO();
        const booked = await data.findOverlappingActiveBookings(businessId, dayStart, dayEnd);
        const confirmed = booked.filter((b) => b.status === "confirmed").length;
        confirmedCounts.set(d.toISODate(), confirmed);
      }

      for (const slot of slots) {
        const slotDay = DateTime.fromISO(slot.start_local, { zone: timezone }).toISODate();
        if ((confirmedCounts.get(slotDay) || 0) < maxDailyJobs) {
          filtered.push(slot);
        }
      }
      slots = filtered;
    }

    return res.status(200).json({
      business_id: businessId,
      timezone,
      window_start_local: windowStartLocal.toISO(),
      window_end_local: windowEndLocal.toISO(),
      duration_min: durationMin,
      granularity_min: Number(business.slot_granularity_min || 15),
      slots,
      ...(warning ? { error: warning } : {}),
    });
  } catch (e) {
    console.error(`[req:${req.requestId}] available-slots error:`, e);
    return res.status(500).json({ ok: false, error: "Internal error" });
  }
});

app.post("/api/book", async (req, res) => {
  try {
    if (!data) return res.status(500).json({ ok: false, error: "Data layer not ready" });

    const {
      business_id,
      start_local,
      duration_min,
      customer_name,
      customer_phone,
      customer_email,
      address,
      job_summary,
    } = req.body || {};

    if (!business_id) return res.status(400).json({ ok: false, error: "Missing business_id" });
    if (!start_local) return res.status(400).json({ ok: false, error: "Missing start_local" });

    const business = await data.getBusinessById(business_id);
    if (!business) return res.status(404).json({ ok: false, error: "Business not found" });

    const tz = business.timezone || "America/Chicago";
    const durMin = Number(duration_min || business.default_duration_min || 60);
    if (!Number.isFinite(durMin) || durMin <= 0 || durMin > 8 * 60) {
      return res.status(400).json({ ok: false, error: "Bad duration_min" });
    }

    const startZ = DateTime.fromISO(start_local, { zone: tz });
    if (!startZ.isValid) {
      return res.status(400).json({ ok: false, error: "Bad start_local" });
    }

    const endZ = startZ.plus({ minutes: durMin });
    const startUtc = startZ.toUTC().toISO();
    const endUtc = endZ.toUTC().toISO();

    const bookingId = crypto.randomUUID();
    const holdExpiresUtc = DateTime.utc().plus({ minutes: 5 }).toISO();

    const holdResult = await data.createPendingHoldIfAvailableTx({
      id: bookingId,
      business_id,
      start_utc: startUtc,
      end_utc: endUtc,
      hold_expires_at_utc: holdExpiresUtc,
      customer_name,
      customer_phone,
      customer_email,
      job_summary: job_summary || (address ? `Address: ${address}` : null),
    });

    if (!holdResult.ok) {
      return res.status(409).json({ ok: false, error: holdResult.reason || "Slot already taken" });
    }

    try {
      const oauth2Client = makeOAuthClient();
      await loadTokensIntoClientForBusiness(data, oauth2Client, business_id);
      const calendar = google.calendar({ version: "v3", auth: oauth2Client });

      const created = await calendar.events.insert({
        calendarId: "primary",
        requestBody: {
          summary: job_summary || "HVAC Service",
          description: [
            customer_name ? `Name: ${customer_name}` : null,
            customer_phone ? `Phone: ${customer_phone}` : null,
            customer_email ? `Email: ${customer_email}` : null,
            address ? `Address: ${address}` : null,
          ].filter(Boolean).join("\n"),
          start: { dateTime: startZ.toISO(), timeZone: tz },
          end: { dateTime: endZ.toISO(), timeZone: tz },
        },
      });

      await data.confirmBooking(bookingId, created.data.id);

      return res.status(200).json({
        ok: true,
        booking_id: bookingId,
        status: "confirmed",
        gcal_event_id: created.data.id,
      });
    } catch (calendarError) {
      await data.failBooking(bookingId, String(calendarError?.message || calendarError));
      await data.cancelBooking(bookingId);

      console.error("book calendar error:", {
        bookingId,
        business_id,
        message: String(calendarError?.message || calendarError),
      });

      return res.status(502).json({
        ok: false,
        error: "Could not create calendar event; booking hold released",
      });
    }
  } catch (e) {
    console.error(`[req:${req.requestId}] book error:`, e);
    return res.status(500).json({ ok: false, error: "Internal error" });
  }
});

// --------------------
// Twilio voice webhook
// --------------------
app.get("/voice", (req, res) => {
  console.log("GET /voice browser test");
  res.status(200).send("VOICE OK (GET)");
});

app.post("/voice", (req, res) => {
  console.log("POST /voice from Twilio");

  const host = req.headers["x-forwarded-host"] || req.headers.host;

  const twiml = `
<Response>
  <Say>Thanks for calling. Please hold for a moment.</Say>
  <Connect>
    <Stream url="wss://${host}/media" />
  </Connect>
</Response>
  `.trim();

  res.type("text/xml").send(twiml);
});

app.use((req, res) => {
  console.log("404:", req.method, req.url);
  res.status(404).send("Not Found");
});

// --------------------
// HTTP + WebSocket server
// --------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media" });

wss.on("connection", (twilioWs) => {
  console.log("Twilio connected");
  let streamSid = null;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("OPENAI_API_KEY is missing in environment variables!");
    try { twilioWs.close(); } catch {}
    return;
  }

  const openaiWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-realtime", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  openaiWs.on("open", () => {
    console.log("Connected to OpenAI");

    openaiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        type: "realtime",
        audio: {
          input: { format: "g711_ulaw" },
          output: { format: "g711_ulaw", voice: "alloy" },
        },
        instructions:
          "You are a friendly HVAC assistant in Dallas-Fort Worth. " +
          "Ask briefly for name, phone, address, issue, and preferred time.",
      },
    }));

    openaiWs.send(JSON.stringify({
      type: "response.create",
      response: {
        instructions:
          "Say: Hi! This is the HVAC assistant. Is this an emergency or would you like to schedule service?",
      },
    }));
  });

  openaiWs.on("close", (code, reason) => {
    console.log("OpenAI disconnected", { code, reason: reason?.toString() });
  });

  openaiWs.on("error", (err) => {
    console.error("OpenAI WS error:", err);
  });

  twilioWs.on("message", (message) => {
    let msg;
    try { msg = JSON.parse(message.toString()); } catch { return; }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid;
      console.log("Stream started. streamSid =", streamSid);
      return;
    }

    if (msg.event === "media" && msg.media?.payload) {
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: msg.media.payload,
        }));
      }
      return;
    }

    if (msg.event === "stop") {
      console.log("Stream stopped");
      try { openaiWs.close(); } catch {}
      return;
    }
  });

  openaiWs.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === "response.output_audio.delta" && msg.delta) {
      if (!streamSid) return;
      twilioWs.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: msg.delta },
      }));
    }
  });

  twilioWs.on("close", () => {
    console.log("Twilio disconnected");
    try { openaiWs.close(); } catch {}
  });
});

// --------------------
// Startup
// --------------------
const PORT = process.env.PORT || 10000;

let db;    // raw connection
let data;  // data layer

async function start() {
  console.log("Starting server...");

  // init sqlite + migrations
  db = openDb();
  await runMigrations(db);

  // init data layer (sqlite now, later postgres)
  const dl = makeDataLayer({ db });
  data = dl.data;

  console.log("DB_DIALECT =", dl.dialect);
  console.log("✅ Data layer ready");
  console.log("✅ Migrations completed");

  server.listen(PORT, () => {
    console.log("Voice assistant is running 🚀 on port", PORT);
  });
}

start().catch((err) => {
  console.error("❌ Startup failed:", err);
  process.exit(1);
});
