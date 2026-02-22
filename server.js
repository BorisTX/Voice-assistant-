import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const app = express();
app.use(express.urlencoded({ extended: false }));

// Health check
app.get("/", (req, res) => res.status(200).send("OK"));

// Twilio webhook → returns TwiML with Media Stream
app.post("/voice", (req, res) => {
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
  const openaiWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-realtime", {
    headers: {
      Authorization: 'Bearer ${apiKey}',
      // Если вдруг у тебя аккаунт/проект ещё на beta-поведении — раскомментируй строку ниже:
      // "OpenAI-Beta": "realtime=v1",
    },
  });

  openaiWs.on("open", () => {
    console.log("Connected to OpenAI");

    // ✅ Correct session.update shape (Realtime GA)
    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          instructions:
            "You are a friendly HVAC scheduling assistant in Dallas–Fort Worth. " +
            "Keep answers short and natural. " +
            "Collect: name, phone, address, problem, preferred time window. " +
            "If emergency (no AC in extreme heat, no heat in cold, gas smell, water leak), prioritize and advise safety steps.",
          modalities: ["audio"],
          audio: {
            input: { format: "g711_ulaw" },
            output: { format: "g711_ulaw", voice: "alloy" },
          },
        },
      })
    );

    // Make assistant speak first
    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          output_modalities: ["audio"],
          instructions:
            "Say: Hi! This is the HVAC scheduling assistant. Is this an emergency, or would you like to schedule service?",
        },
      })
    );
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

  // OpenAI -> Twilio
  openaiWs.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      console.log("Bad JSON from OpenAI");
      return;
    }

    // 🔥 If OpenAI sends an error event, log it (THIS will explain the disconnect)
    if (msg.type === "error") {
      console.error("OpenAI error event:", msg);
      return;
    }

    // Stream audio chunks back to Twilio
    if (msg.type === "response.output_audio.delta" && msg.delta && streamSid) {
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: msg.delta },
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
server.listen(port, () => {
  console.log("Voice assistant is running 🚀 on port", port);
});
