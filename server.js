import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
  console.log("INCOMING:", req.method, req.url);
  next();
});
app.use((req, res, next) => {
  console.log("INCOMING:", req.method, req.url);
  next();
});
// Health check
app.get("/", (req, res) => res.status(200).send("OK"));

// Twilio webhook → returns TwiML with Media Stream
// Browser test (GET)
app.get("/voice", (req, res) => {
  console.log("GET /voice browser test");
  res.status(200).send("VOICE OK (GET)");
});

// Twilio webhook (POST)
app.post("/voice", (req, res) => {
  console.log("POST /voice from Twilio");

  const host = req.headers.host;

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

const server = http.createServer(app);

// WebSocket endpoint for Twilio
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

  // Connect to OpenAI Realtime (GA interface)
  const openaiWs = new WebSocket(
  "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
  {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "realtime=v1"
    }
  }
);

  openaiWs.on("open", () => {
    console.log("Connected to OpenAI");

    // ✅ Correct session.update shape (Realtime GA)
    openaiWs.send(JSON.stringify({
  type: "session.update",
  session: {
    instructions:
      "You are a friendly HVAC assistant in Dallas-Fort Worth. " +
      "Ask briefly for name, phone, address, issue, and preferred time. " +
      "If emergency (no AC, no heat, gas smell, water leak), prioritize immediately. " +
      "Keep responses short and natural."
  }
}));

    // Make assistant speak first
    openaiWs.send(JSON.stringify({
  type: "response.create",
  response: {
    modalities: ["audio", "text"],
    instructions:
      "You are a friendly HVAC scheduling assistant. " +
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

 // OpenAI → Twilio
openaiWs.on("message", (data) => {
  const text = data.toString();
  console.log("OpenAI raw:", text.slice(0, 400));

  let msg;
  try {
    msg = JSON.parse(text);
  } catch (e) {
    console.log("Bad JSON from OpenAI");
    return;
  }

  if (msg.type === "response.output_audio.delta" && msg.delta) {
  if (!streamSid) return;

  twilioWs.send(JSON.stringify({
    event: "media",
    streamSid,
    media: { payload: msg.delta },
  }));
}
});

  // Cleanup
  twilioWs.on("close", () => {
    console.log("Twilio disconnected");
    try { openaiWs.close(); } catch {}
  });
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log("Voice assistant is running 🚀 on port", port);
});
