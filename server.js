import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import { getTokens } from "./db.js";
import { google } from "googleapis";
//import { initDb } from "./db.js";
import {
  makeOAuthClient,
  getAuthUrl,
  loadTokensIntoClient,
  exchangeCodeAndStore,
  getAuthUrlForBusiness,
  loadTokensIntoClientForBusiness,
  exchangeCodeAndStoreForBusiness,
} from "./googleAuth.js";
import { openDb, runMigrations } from "./src/db/migrate.js";
import crypto from "crypto"; // <-- ВАЖНО: если у тебя вверху нет crypto, добавь импорт
let db; // будет глобальным, чтобы эндпоинты могли использовать одну БД
//initDb();
const oauth2Client = makeOAuthClient();
const app = express();
app.use(express.urlencoded({ extended: false }));


app.use((req, res, next) => {
  console.log("INCOMING:", req.method, req.url);
  next();
});
// Health check
app.get("/", (req, res) => res.status(200).send("OK"));

app.get("/debug/create-default-business", (req, res) => {
  
  if (!db) return res.status(500).json({ ok: false, error: "DB not ready yet" });

  const name = "Default HVAC (DFW)";
  const now = new Date().toISOString();

  // 1) сначала ищем — вдруг уже есть
  db.get(
    "SELECT id, name, timezone FROM businesses WHERE name = ? LIMIT 1",
    [name],
    (err, row) => {
      if (err) return res.status(500).json({ ok: false, error: String(err) });
      if (row) return res.json({ ok: true, created: false, businessId: row.id, business: row });

      // 2) создаём новый business
      const businessId = crypto.randomUUID();

      const workingHours = {
        mon: [{ start: "08:00", end: "17:00" }],
        tue: [{ start: "08:00", end: "17:00" }],
        wed: [{ start: "08:00", end: "17:00" }],
        thu: [{ start: "08:00", end: "17:00" }],
        fri: [{ start: "08:00", end: "17:00" }],
        sat: [],
        sun: []
      };

      const emergencyKeywords = ["no heat", "no cooling", "gas smell", "water leak", "flooding"];

      const sql = `
        INSERT INTO businesses (
          id, name, industry, timezone, working_hours_json,
          default_duration_min, slot_granularity_min,
          buffer_before_min, buffer_after_min,
          lead_time_min, max_days_ahead, max_daily_jobs,
          emergency_enabled, emergency_keywords_json,
          created_at_utc, updated_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      const params = [
        businessId,
        name,
        "hvac",
        "America/Chicago",
        JSON.stringify(workingHours),
        60,   // default_duration_min
        15,   // slot_granularity_min
        0,    // buffer_before_min
        30,   // buffer_after_min
        60,   // lead_time_min
        7,    // max_days_ahead
        null, // max_daily_jobs
        1,    // emergency_enabled
        JSON.stringify(emergencyKeywords),
        now,
        now
      ];

      db.run(sql, params, function (err2) {
        if (err2) return res.status(500).json({ ok: false, error: String(err2) });
        return res.json({ ok: true, created: true, businessId });
      });
    }
  );
});
app.get("/debug/db", (req, res) => {
  if (!db) return res.status(500).json({ ok: false, error: "DB not ready yet" });

  db.all(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    (err, rows) => {
      if (err) return res.status(500).json({ ok: false, error: String(err) });
      res.json({ ok: true, tables: rows.map((r) => r.name) });
    }
  );
});
app.get("/debug/businesses", (req, res) => {
  if (!db) return res.status(500).json({ ok: false, error: "DB not ready yet" });

  db.all(
    "SELECT id, name, industry, timezone, created_at_utc FROM businesses ORDER BY created_at_utc DESC",
    (err, rows) => {
      if (err) return res.status(500).json({ ok: false, error: String(err) });
      res.json({ ok: true, count: rows.length, businesses: rows });
    }
  );
});

app.get("/auth/google", (req, res) => {
  try {
    const url = getAuthUrl(oauth2Client);
    console.log("AUTH URL:", url);
    if (!url || typeof url !== "string") {
      return res.status(500).send("getAuthUrl() returned empty URL. Check env vars.");
    }
    return res.redirect(url);
  } catch (e) {
    console.error("ERROR in /auth/google:", e);
    return res.status(500).send("OAuth error: " + (e?.message || String(e)));
  }
});
app.get("/auth/google-business", (req, res) => {
  try {
    const businessId = req.query.business_id;
    if (!businessId) return res.status(400).send("Missing business_id");

    const url = getAuthUrlForBusiness(oauth2Client, String(businessId));
    return res.redirect(url);
  } catch (e) {
    console.error("ERROR in /auth/google-business:", e);
    return res.status(500).send("OAuth error: " + (e?.message || String(e)));
  }
});

//app.get("/debug/tokens", async (req, res) => {
const row = await getTokens();
res.json({
  hasAccessToken: !!row?.access_token,
  hasRefreshToken: !!row?.refresh_token,
  scope: row?.scope,
  expiry_date: row?.expiry_date,
  updated_at: row?.updated_at,
});
});
// ...

// Twilio webhook → returns TwiML with Media Stream
// Browser test (GET)
app.get("/voice", (req, res) => {
  console.log("GET /voice browser test");
  res.status(200).send("VOICE OK (GET)");
});
app.get("/auth/google/callback", async (req, res) => {
  try {
    const code = req.query.code;
    const state = req.query.state; // тут businessId, если это business flow
    if (!code) return res.status(400).send("Missing code");

    if (state) {
      // ВАЖНО: порядок аргументов как в ТВОЕМ googleAuth.js
      await exchangeCodeAndStoreForBusiness(oauth2Client, String(state), String(code));
      return res.status(200).send("Business Google Calendar connected ✅");
    }

    await exchangeCodeAndStore(oauth2Client, String(code));
    return res.status(200).send("Google Calendar connected ✅");
  } catch (e) {
    console.error("OAuth callback error:", e);
    return res.status(500).send("OAuth failed: " + String(e?.message || e));
  }
});


//app.get("/debug/calendar", async (req, res) => {
  try {
    await loadTokensIntoClient(oauth2Client);

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
      items: (result.data.items || []).map((e) => ({
        summary: e.summary,
        start: e.start?.dateTime || e.start?.date,
        end: e.end?.dateTime || e.end?.date,
      })),
    });
  } catch (e) {
    console.error("DEBUG calendar error:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
app.get("/debug/calendar-business", async (req, res) => {
  try {
    const businessId = req.query.business_id;
    if (!businessId) return res.status(400).json({ ok: false, error: "Missing business_id" });

    await loadTokensIntoClientForBusiness(oauth2Client, String(businessId));

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
// Twilio webhook (POST)
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
// 404 logger (ставь ПОСЛЕ всех маршрутов)
app.use((req, res) => {
  console.log("404:", req.method, req.url);
  res.status(404).send("Not Found");
});
const server = http.createServer(app);

// WebSocket endpoint for Twilio
const wss = new WebSocketServer({ server, path: "/media" });
// ===== PCM16 -> (24k->8k) -> G711 μ-law helpers =====
function pcm16leToInt16(buf) {
  const out = new Int16Array(buf.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

// 24k -> 8k = берем каждый 3-й сэмпл (быстро и достаточно)
function downsample24kTo8k(int16Samples) {
  const factor = 3;
  const outLen = Math.floor(int16Samples.length / factor);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = int16Samples[i * factor];
  return out;
}

// G.711 μ-law encoder
function linearToMulawSample(sample) {
  const MULAW_MAX = 0x1FFF;
  const BIAS = 0x84;

  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > MULAW_MAX) sample = MULAW_MAX;

  sample += BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }

  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  const mulaw = ~(sign | (exponent << 4) | mantissa);
  return mulaw & 0xff;
}

function int16ToMulawBuffer(int16Samples) {
  const out = Buffer.alloc(int16Samples.length);
  for (let i = 0; i < int16Samples.length; i++) out[i] = linearToMulawSample(int16Samples[i]);
  return out;
}
// ===== end helpers =====
wss.on("connection", (twilioWs) => {
  console.log("Twilio connected");

  let streamSid = null;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("OPENAI_API_KEY is missing in environment variables!");
    try { twilioWs.close(); } catch {}
    return;
  }

  // Connect to OpenAI Realtime (GA interface)
  const openaiWs = new WebSocket(
  "wss://api.openai.com/v1/realtime?model=gpt-realtime",
  {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  }
);

  openaiWs.on("open", () => {
    console.log("Connected to OpenAI");

    // ✅ Correct session.update shape (Realtime GA)
    openaiWs.send(JSON.stringify({
  type: "session.update",
  session: {
    type: "realtime",
    audio: {
      input: {
        format: "g711_ulaw"
      },
      output: {
        format: "g711_ulaw",
        voice: "alloy"
      }
    },
    instructions:
      "You are a friendly HVAC assistant in Dallas-Fort Worth. " +
      "Ask briefly for name, phone, address, issue, and preferred time."
  }
}));

    // Make assistant speak first
    openaiWs.send(JSON.stringify({
  type: "response.create",
  response: {
    instructions:
      "Say: Hi! This is the HVAC assistant. Is this an emergency or would you like to schedule service?"
  }
}));
  });
  // Helpful debug logs
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
            audio: msg.media.payload,
          })
        );
      }
      return;
    }

    if (msg.event === "stop") {
      console.log("Stream stopped");
      try { openaiWs.close(); } catch {}
      return;
    }
  });

 // OpenAI → Twilio (CONVERT PCM -> μ-law 8k so Twilio plays clean audio)
openaiWs.on("message", (data) => {
  const text = data.toString();
  console.log("OpenAI raw:", text.slice(0, 400));

  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    console.log("Bad JSON from OpenAI");
    return;
  }

  if (msg.type === "response.output_audio.delta" && msg.delta) {
    if (!streamSid) return;

    const raw = Buffer.from(msg.delta, "base64");
    console.log("AUDIO DELTA BYTES:", raw.length);

    // Assume PCM16LE 24k from OpenAI -> downsample to 8k -> μ-law encode
    const pcm16 = pcm16leToInt16(raw);
    const pcm8k = downsample24kTo8k(pcm16);
    const mulawBuf = int16ToMulawBuffer(pcm8k);

    twilioWs.send(
      JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: mulawBuf.toString("base64") },
      })
    );
  }
});

  // Cleanup
  twilioWs.on("close", () => {
    console.log("Twilio disconnected");
    try { openaiWs.close(); } catch {}
  });
});
const port = process.env.PORT || 3000;

async function start() {
  console.log("Starting server...");

  // 1️⃣ Открываем БД
  db = openDb();

  // 2️⃣ Прогоняем миграции
  await runMigrations(db);

  console.log("✅ Migrations completed");

  // 3️⃣ Запускаем HTTP + WebSocket
  server.listen(port, () => {
    console.log("Voice assistant is running 🚀 on port", port);
  });
}

start().catch((err) => {
  console.error("❌ Startup failed:", err);
  process.exit(1);
});

