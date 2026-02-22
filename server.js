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
  <Connect>
    <Stream url="wss://${host}/media" />
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});

const server = http.createServer(app);

// WebSocket endpoint for Twilio
const wss = new WebSocketServer({ server, path: "/media" });

wss.on("connection", (twilioWs) => {
  console.log("Twilio connected");

  let streamSid = null;

  // Connect to OpenAI Realtime
  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-realtime",
    {
      headers: {
        Authorization: Bearer ${process.env.OPENAI_API_KEY},
      },
    }
  );

  // When OpenAI socket opens
  openaiWs.on("open", () => {
    console.log("Connected to OpenAI");

    // Configure session
    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          instructions:
            "You are a friendly HVAC assistant in Dallas-Fort Worth. " +
            "Ask briefly for name, phone, address, issue, and preferred time. " +
            "If emergency (no AC, no heat, gas smell, water leak), prioritize immediately. " +
            "Keep responses short and natural.",
          input_audio_format: "pcm_mulaw",
          output_audio_format: "pcm_mulaw",
          voice: "alloy",
        },
      })
    );

    // Make assistant speak first (debug sanity check)
    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          output_modalities: ["audio"],
          instructions:
            "Say: Hi! This is the HVAC assistant. Is this an emergency, or would you like to schedule service?",
        },
      })
    );
  });

  // Twilio -> OpenAI
  twilioWs.on("message", (message) => {
    let msg;

    try {
      msg = JSON.parse(message.toString());
    } catch (e) {
      console.log("Bad JSON from Twilio:", message.toString().slice(0, 200));
      return;
    }

    if (msg.event === "start") {
      streamSid = msg.streamSid || msg.start?.streamSid;
      console.log("Stream started. streamSid =", streamSid);
      return;
    }

    if (msg.event === "media" && msg.media && msg.media.payload) {
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
      try {
        openaiWs.close();
      } catch {}
      return;
    }
  });

  // OpenAI -> Twilio
  openaiWs.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

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
    try {
      openaiWs.close();
    } catch {}
  });

  openaiWs.on("close", () => {
    console.log("OpenAI disconnected");
  });

  openaiWs.on("error", (err) => {
    console.error("OpenAI error:", err);
  });
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log("Voice assistant is running 🚀 on port", port);
});
