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
  console.log("INCOMING:", req.method, req.url);
  next();
});

let db;     // raw sqlite connection (сейчас)
let data;   // data layer (sqlite сейчас, позже postgres)

// Health check
app.get("/", (req, res) => res.status(200).send("OK"));

// --------------------
// Debug: DB inspection
// --------------------
app.get("/debug/db", async (req, res) => {
  try {
    if (!db) return res.status(500).json({ ok: false, error: "DB not ready yet" });
    const tables = await data.listTables();
    res.json({ ok: true, tables });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/debug/businesses", async (req, res) => {
  try {
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
    if (!db) return res.status(500).send("DB not ready yet");
    const businessId = String(req.query.business_id || "");
    if (!businessId) return res.status(400).send("Missing business_id");

    const oauth2Client = makeOAuthClient(); // fresh instance
    const url = getAuthUrlForBusiness(oauth2Client, businessId);
    return res.redirect(url);
  } catch (e) {
    console.error("ERROR in /auth/google-business:", e);
    return res.status(500).send("OAuth error: " + String(e?.message || e));
  }
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    if (!db) return res.status(500).send("DB not ready yet");

    const code = String(req.query.code || "");
    const businessId = String(req.query.state || "");
    if (!code) return res.status(400).send("Missing code");
    if (!businessId) return res.status(400).send("Missing state (business_id)");

    const oauth2Client = makeOAuthClient(); // fresh instance
    await exchangeCodeAndStoreForBusiness(db, oauth2Client, code, businessId);

    return res.status(200).send("Business Google Calendar connected ✅");
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
    if (!db) return res.status(500).json({ ok: false, error: "DB not ready yet" });

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
    if (!db) return res.status(500).json({ ok: false, error: "DB not ready yet" });

    const businessId = String(req.query.business_id || "");
    if (!businessId) return res.status(400).json({ ok: false, error: "Missing business_id" });

    const oauth2Client = makeOAuthClient();
    await loadTokensIntoClientForBusiness(db, oauth2Client, businessId);

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
    await loadTokensIntoClientForBusiness(db, oauth2Client, businessId);

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
    const busyMergedUtc = normalizeBusyUtc(
      busy,
      Number(business.buffer_before_min || 0),
      Number(business.buffer_after_min || 0)
    );

    const slots = generateSlots({
      business,
      windowStartDate: windowStartZ,
      days,
      durationMin,
      busyMergedUtc,
    });

    res.json({
      ok: true,
      businessId,
      timezone: tz,
      from_local: windowStartZ.toISODate(),
      days,
      durationMin,
      count: slots.length,
      slots,
    });
  } catch (e) {
    console.error("available-slots error:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
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

async function start() {
  console.log("Starting server...");

  db = openDb();
  await runMigrations(db);
  console.log("✅ Migrations completed");

  const layer = makeDataLayer({ db });
  data = layer.data;
  console.log("✅ Data layer ready. dialect =", layer.dialect);

  server.listen(PORT, () => {
    console.log("Voice assistant is running 🚀 on port", PORT);
  });
}

start().catch((err) => {
  console.error("❌ Startup failed:", err);
  process.exit(1);
});
