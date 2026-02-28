// server.js
import "dotenv/config";

import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import crypto from "crypto";
import { google } from "googleapis";
import { DateTime } from "luxon";
import { verifyOAuthState } from "./src/security/state.js";
import { normalizeBusyUtc, generateSlots } from "./src/slots.js";
import { openDb, runMigrations } from "./src/db/migrate.js";
import { makeDataLayer } from "./src/data/index.js";

import {
  makeOAuthClient,
  getAuthUrlForBusiness,
  loadTokensIntoClientForBusiness,
  exchangeCodeAndStoreForBusiness,
} from "./googleAuth.js";
import {
  getBusinessById,
  getBusinessByName,
  insertBusiness,
  listBusinesses,
  listTables,
  getGoogleTokens,
  upsertGoogleTokens,
  maybeMigrateLegacyTokens,
} from "./db.js";
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use((req, res, next) => {
  console.log("INCOMING:", req.method, req.url);
  next();
});

const BOOKING_HOLD_MINUTES_DEFAULT = 5;
const GOOGLE_API_TIMEOUT_MS_DEFAULT = 10000;

const BOOKING_HOLD_MINUTES = (() => {
  const value = Number(process.env.BOOKING_HOLD_MINUTES);
  return Number.isFinite(value) && value > 0 ? value : BOOKING_HOLD_MINUTES_DEFAULT;
})();

const GOOGLE_API_TIMEOUT_MS = (() => {
  const value = Number(process.env.GOOGLE_API_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : GOOGLE_API_TIMEOUT_MS_DEFAULT;
})();

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`${label} timeout after ${ms}ms`);
        err.code = "GOOGLE_TIMEOUT";
        reject(err);
      }, ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}


// Health check
app.get("/", (req, res) => res.status(200).send("OK"));

// --------------------
// Debug: DB inspection
// --------------------
app.get("/debug/db", async (req, res) => {
  try {
    if (!db) return res.status(500).json({ ok: false, error: "DB not ready yet" });

    const tables = await listTables(db);
    res.json({ ok: true, tables });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/debug/businesses", async (req, res) => {
  try {
    if (!data) return res.status(500).json({ ok: false, error: "DB not ready yet" });

    const businesses = await listBusinesses(db);
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
    if (!data) return res.status(500).json({ ok: false, error: "DB not ready yet" });

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
    const state = String(req.query.state || "");

    if (!code) return res.status(400).send("Missing code");
    if (!state) return res.status(400).send("Missing state");

    const verified = verifyOAuthState(state);
    if (!verified.ok) {
      return res.status(400).send("Invalid state: " + verified.error);
    }

    const businessId = String(verified.payload.businessId || "");
    if (!businessId) return res.status(400).send("Invalid state: missing businessId");

    const nonce = String(verified.payload.nonce || "");
    if (!nonce) return res.status(400).send("Invalid state: missing nonce");

    const flow = await data.consumeOAuthFlow(nonce);
    if (!flow) return res.status(400).send("OAuth flow expired or already used");

    if (flow.business_id !== businessId) {
      return res.status(400).send("OAuth flow business mismatch");
    }

    const oauth2Client = makeOAuthClient();

    await exchangeCodeAndStoreForBusiness(
      data,
      oauth2Client,
      code,
      businessId,
      flow.code_verifier
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
    if (!db) return res.status(500).json({ ok: false, error: "DB not ready yet" });

    const businessId = String(req.query.business_id || "");
    if (!businessId) return res.status(400).json({ ok: false, error: "Missing business_id" });

    const business = await data.getBusinessById(businessId);
    if (!business) return res.status(404).json({ ok: false, error: "Business not found" });

    const tz = business.timezone || "America/Chicago";

    const durationMin = req.query.duration_min
      ? Number(req.query.duration_min)
      : Number(business.default_duration_min || 60);

    const dur = Number(durationMin);
    if (!Number.isFinite(dur) || dur <= 0 || dur > 8 * 60) {
      return res.status(400).json({ ok: false, error: "Bad duration_min" });
    }

    const daysReq = req.query.days ? Number(req.query.days) : Number(business.max_days_ahead || 7);
    const days = Math.max(1, Math.min(daysReq, Number(business.max_days_ahead || 7)));

    const fromStr = String(req.query.from || "");
    const windowStartZ = fromStr
      ? DateTime.fromISO(fromStr, { zone: tz }).startOf("day")
      : DateTime.now().setZone(tz).startOf("day");

    if (!windowStartZ.isValid) {
      return res.status(400).json({ ok: false, error: "Bad from date (use YYYY-MM-DD)" });
    }

    const windowEndZ = windowStartZ.plus({ days });
    const timeMinUtc = windowStartZ.toUTC().toISO();
    const timeMaxUtc = windowEndZ.toUTC().toISO();

    // Google freebusy
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

    const busy = fb?.data?.calendars?.primary?.busy || [];
    const bufferBefore = Number(business.buffer_before_min || business.buffer_min || business.buffer_minutes || 0);
    const bufferAfter = Number(business.buffer_after_min || business.buffer_min || business.buffer_minutes || 0);

    const busyMergedUtc = normalizeBusyUtc(busy, bufferBefore, bufferAfter);

    const slots = generateSlots({
      business,
      windowStartDate: windowStartZ,
      days,
      durationMin: dur,
      busyMergedUtc,
    });

    return res.json({
      ok: true,
      businessId,
      timezone: tz,
      from_local: windowStartZ.toISODate(),
      days,
      durationMin: dur,
      count: slots.length,
      slots,
    });
  } catch (e) {
    console.error("available-slots error:", e);
    return res.status(500).json({ ok: false, error: "Internal error" });
  }
});

async function revalidateSlotWithGoogle({ calendar, startUtc, endUtc, timeoutMs, bookingId, businessId, log }) {
  log("freebusy", "Google freebusy revalidation start", { startUtc, endUtc });
  const fb = await withTimeout(
    calendar.freebusy.query({
      requestBody: {
        timeMin: startUtc,
        timeMax: endUtc,
        timeZone: "UTC",
        items: [{ id: "primary" }],
      },
    }),
    timeoutMs,
    "google.freebusy.query"
  );
  const busy = fb?.data?.calendars?.primary?.busy || [];
  const isBusy = busy.some((b) => b.start < endUtc && b.end > startUtc);
  log("freebusy", "Google freebusy revalidation complete", { busyCount: busy.length, isBusy });
  return { isBusy };
}

app.post("/api/book", async (req, res) => {
  let bookingIdForLog = null;
  let businessIdForLog = req?.body?.business_id || null;

  const log = (phase, msg, extra = {}) => {
    console.log(JSON.stringify({
      level: "info",
      phase,
      bookingId: bookingIdForLog,
      business_id: businessIdForLog,
      msg,
      ...extra,
    }));
  };

  const errorLog = (phase, msg, extra = {}) => {
    console.error(JSON.stringify({
      level: "error",
      phase,
      bookingId: bookingIdForLog,
      business_id: businessIdForLog,
      msg,
      ...extra,
    }));
  };

  try {
    if (!data) return res.status(500).json({ ok: false, error: "Data layer not ready" });

    const {
      business_id,
      start_local,     // ISO datetime string in business timezone (recommended)
      duration_min,
      customer_name,
      customer_phone,
      customer_email,
      address,
      job_summary,
    } = req.body || {};

    if (!business_id) return res.status(400).json({ ok: false, error: "Missing business_id" });
    if (!start_local) return res.status(400).json({ ok: false, error: "Missing start_local" });

    businessIdForLog = business_id;

    // 1) load business to get timezone + defaults
    const business = await data.getBusinessById(business_id);
    if (!business) return res.status(404).json({ ok: false, error: "Business not found" });

    const tz = business.timezone || "America/Chicago";

    const durMin = Number(
      duration_min != null ? duration_min : (business.default_duration_min || 60)
    );
    if (!Number.isFinite(durMin) || durMin <= 0 || durMin > 8 * 60) {
      return res.status(400).json({ ok: false, error: "Bad duration_min" });
    }

    // 2) parse requested slot in business timezone
    const startZ = DateTime.fromISO(String(start_local), { zone: tz });
    if (!startZ.isValid) {
      return res.status(400).json({ ok: false, error: "Bad start_local (use ISO datetime)" });
    }
    const endZ = startZ.plus({ minutes: durMin });

    const startUtc = startZ.toUTC().toISO();
    const endUtc = endZ.toUTC().toISO();

    // 3) create booking id + hold
    const bookingId = crypto.randomUUID();
    bookingIdForLog = bookingId;

    const holdExpiresUtc = DateTime.utc().plus({ minutes: BOOKING_HOLD_MINUTES }).toISO();

    // cleanup expired holds
    if (typeof data.cleanupExpiredPendingHolds === "function") {
      await data.cleanupExpiredPendingHolds();
    } else if (typeof data.cleanupExpiredPendingHolds === "undefined" && typeof data.cleanupExpiredPendingHolds !== "function") {
      // if your data layer uses a different name, rename it there to cleanupExpiredPendingHolds
      log("warn", "cleanupExpiredPendingHolds not found on data layer (skipped)");
    }

    log("hold", "Creating pending hold", { startUtc, endUtc, holdExpiresUtc });

    const holdResult = await data.createPendingHoldIfAvailableTx({
      id: bookingId,
      business_id,
      start_utc: startUtc,
      end_utc: endUtc,
      hold_expires_at_utc: holdExpiresUtc,
      customer_name: customer_name || null,
      customer_phone: customer_phone || null,
      customer_email: customer_email || null,
      job_summary: job_summary || (address ? `Address: ${address}` : null),
    });

    if (!holdResult?.ok) {
      log("hold", "Slot already taken (overlap)");
      return res.status(409).json({ ok: false, error: "Slot already taken" });
    }

    log("hold", "Pending hold created");

    // 4) Google: load tokens + revalidate busy
    const oauth2Client = makeOAuthClient();
    await loadTokensIntoClientForBusiness(data, oauth2Client, business_id);
    const calendar = google.calendar({ version: "v3", auth: oauth2Client });

    const { isBusy } = await revalidateSlotWithGoogle({
      calendar,
      startUtc,
      endUtc,
      timeoutMs: GOOGLE_API_TIMEOUT_MS,
      bookingId,
      businessId: business_id,
      log,
    });

    if (isBusy) {
      await data.failBooking(bookingId, "google_freebusy_busy");
      log("fail", "Slot busy in Google calendar");
      return res.status(409).json({ ok: false, error: "Slot busy in Google calendar" });
    }

    // 5) Create event
    log("insert", "Creating Google Calendar event");

    const created = await withTimeout(
      calendar.events.insert({
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
      }),
      GOOGLE_API_TIMEOUT_MS,
      "google.events.insert"
    );

    await data.confirmBooking(bookingId, created.data.id);
    log("confirm", "Booking confirmed", { gcal_event_id: created.data.id });

    return res.json({
      ok: true,
      bookingId,
      status: "confirmed",
      gcal_event_id: created.data.id,
      start_local: startZ.toISO(),
      end_local: endZ.toISO(),
      timezone: tz,
    });

  } catch (e) {
    errorLog("exception", "book error", { error: String(e?.message || e) });

    // best-effort: don't leave pending holds hanging
    if (bookingIdForLog && data?.failBooking) {
      try { await data.failBooking(bookingIdForLog, "server_exception"); } catch {}
    }

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
  db = await openDb();
  await runMigrations(db);

  // init data layer (sqlite now, later postgres)
  const dl = makeDataLayer({ db });
  data = dl.data;

  console.log("DB_DIALECT =", dl.dialect);
  console.log("✅ Data layer ready");
  console.log("✅ Migrations completed");

  // ✅ ONE-TIME migration for legacy plaintext refresh_token -> encrypted fields
  // controlled by RUN_TOKEN_MIGRATION=1
  const migRes = await maybeMigrateLegacyTokens(db);
  console.log("Token migration result:", migRes);

  server.listen(PORT, () => {
    console.log("Voice assistant is running 🚀 on port", PORT);
  });
}

start().catch((err) => {
  console.error("❌ Startup failed:", err);
  process.exit(1);
});
