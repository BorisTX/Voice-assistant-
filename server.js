// server.js
import "dotenv/config";

import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import crypto from "crypto";
import { google } from "googleapis";

import { openDb, runMigrations } from "./db/migrate.js";
import {
  makeOAuthClient,
  getAuthUrlForBusiness,
  loadTokensIntoClientForBusiness,
  exchangeCodeAndStoreForBusiness,
} from "./googleAuth.js";
import {
  getBusinessByName,
  insertBusiness,
  listBusinesses,
  listTables,
  getGoogleTokens,
} from "./db.js";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use((req, res, next) => {
  console.log("INCOMING:", req.method, req.url);
  next();
});

let db; // single DB connection for the whole process

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
    if (!db) return res.status(500).json({ ok: false, error: "DB not ready yet" });
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
    if (!db) return res.status(500).json({ ok: false, error: "DB not ready yet" });

    const name = "Default HVAC (DFW)";

    const existing = await getBusinessByName(db, name);
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

    await insertBusiness(db, {
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
/**
 * Start OAuth for business:
 * GET /auth/google-business?business_id=<uuid>
 */
app.get("/auth/google-business", async (req, res) => {
  try {
    if (!db) return res.status(500).send("DB not ready yet");
    const businessId = String(req.query.business_id || "");
    if (!businessId) return res.status(400).send("Missing business_id");

    const oauth2Client = makeOAuthClient(); // IMPORTANT: fresh instance
    const url = await getAuthUrlForBusiness(db, oauth2Client, businessId);
    return res.redirect(url);
  } catch (e) {
    console.error("ERROR in /auth/google-business:", e);
    return res.status(500).send("OAuth error: " + String(e?.message || e));
  }
});

/**
 * OAuth callback (business routed by `state`)
 * GET /auth/google/callback?code=...&state=<businessId>
 */
app.get("/auth/google/callback", async (req, res) => {
  try {
    if (!db) return res.status(500).send("DB not ready yet");

    const code = String(req.query.code || "");
    const businessId = String(req.query.state || "");
    if (!code) return res.status(400).send("Missing code");
    if (!businessId) return res.status(400).send("Missing state (business_id)");

    const oauth2Client = makeOAuthClient(); // IMPORTANT: fresh instance
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

    const row = await getGoogleTokens(db, businessId);
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

    const oauth2Client = makeOAuthClient(); // fresh instance per request
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
// Twilio voice webhook
// --------------------
// Browser test (GET)
app.get("/voice", (req, res) => {
  console.log("GET /voice browser test");
  res.status(200).send("VOICE OK (GET)");
});

// Twilio webhook (POST) -> TwiML with Media Stream
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

// 404 logger (AFTER all routes)
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
    try {
      twilioWs.close();
    } catch {}
    return;
  }

  // OpenAI Realtime WebSocket
  const openaiWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-realtime", {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  openaiWs.on("open", () => {
    console.log("Connected to OpenAI");

    // IMPORTANT: Use g711_ulaw in/out so Twilio can play it directly (no conversion)
    openaiWs.send(
      JSON.stringify({
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
      })
    );

    // Make assistant speak first
    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          instructions:
            "Say: Hi! This is the HVAC assistant. Is this an emergency or would you like to schedule service?",
        },
      })
    );
  });

  openaiWs.on("close", (code, reason) => {
    console.log("OpenAI disconnected", { code, reason: reason?.toString() });
  });

  openaiWs.on("error", (err) => {
    console.error("OpenAI WS error:", err);
  });

  // Twilio -> OpenAI
  twilioWs.on("message", (message) => {
    let msg;
    try {
      msg = JSON.parse(message.toString());
    } catch {
      console.log("Bad JSON from Twilio");
      return;
    }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid;
      console.log("Stream started. streamSid =", streamSid);
      return;
    }

    if (msg.event === "media" && msg.media?.payload) {
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: msg.media.payload, // already base64 g711_ulaw
          })
        );
      }
      return;
    }

    if (msg.event === "stop") {
      console.log("Stream stopped");
      try {
        openaiWs.close();
      } catch {}
      return;
    }
  });

  // OpenAI -> Twilio (g711_ulaw passthrough)
  openaiWs.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === "response.output_audio.delta" && msg.delta) {
      if (!streamSid) return;

      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: msg.delta }, // already base64 g711_ulaw
        })
      );
    }
  });

  twilioWs.on("close", () => {
    console.log("Twilio disconnected");
    try {
      openaiWs.close();
    } catch {}
  });
});

// --------------------
// Startup
// --------------------
const port = process.env.PORT || 3000;

async function start() {
  console.log("Starting server...");

  db = openDb();
  await runMigrations(db);
  console.log("✅ Migrations completed");

  server.listen(port, () => {
    console.log("Voice assistant is running 🚀 on port", port);
  });
}

start().catch((err) => {
  console.error("❌ Startup failed:", err);
  process.exit(1);
});
