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
    </Response>
  `;

  res.type("text/xml");
  res.send(twiml);
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
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
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

    // Make assistant speak first
    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          output_modalities: ["audio"],
          instructions:
            "Say: Hi! This is the HVAC assistant. Is this an emergency or would you like to schedule service?",
        },
      })
    );
  });

  // Twilio → OpenAI
  twilioWs.on("message", (message) => {
    const msg = JSON.parse(message);

    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
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
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(
          JSON.stringify({ type: "input_audio_buffer.commit" })
        );

        openaiWs.send(
          JSON.stringify({ type: "response.create" })
        );
      }
    }
  });

  // OpenAI → Twilio
  openaiWs.on("message", (data) => {
    const msg = JSON.parse(data);

    // Stream audio chunks back to Twilio
    if (msg.type === "response.output_audio.delta" && msg.delta) {
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
    openaiWs.close();
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
