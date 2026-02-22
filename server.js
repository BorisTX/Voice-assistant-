import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const app = express();
app.use(express.urlencoded({ extended: false }));

// Health check
app.get("/", (req, res) => res.status(200).send("OK"));

// Twilio Voice webhook -> TwiML that starts bidirectional media stream
app.post("/voice", (req, res) => {
  const host = req.get("host");
  const streamUrl = 'wss://${host}/media';

  const twiml = `
<Response>
  <Say voice="Polly.Joanna">
    Thanks for calling. This is the HVAC scheduling assistant. One moment.
  </Say>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});

const server = http.createServer(app);

// WebSocket endpoint for Twilio Media Streams
const wss = new WebSocketServer({ server, path: "/media" });

wss.on("connection", (twilioWs) => {
  let streamSid = null;

  // Connect to OpenAI Realtime over WebSocket
  const openaiWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-realtime", {
  headers: {
    Authorization: 'Bearer ${process.env.OPENAI_API_KEY}',
  },
});

  openaiWs.on("open", () => {
  const msg = {
    type: "session.update",
    session: {
      instructions:
        "You are a helpful, natural-sounding voice assistant for a local HVAC company in Dallas–Fort Worth. " +
        "Your job is to collect: name, phone, service address, issue, and preferred time. " +
        "Detect emergencies (no AC, no heat, gas smell, burning smell, water leak) and tell the caller you will prioritize them. " +
        "Do not quote prices or guarantees. Keep replies short.",
      input_audio_format: "pcm_mulaw",
      output_audio_format: "pcm_mulaw",
      voice: "alloy"
    }
  };

  openaiWs.send(JSON.stringify(msg));
});

  // Receive events from OpenAI and forward audio back to Twilio
  openaiWs.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    // When the model outputs audio chunks, forward them to Twilio as media messages.  [oai_citation:5‡OpenAI Developers](https://developers.openai.com/api/docs/guides/realtime/)
    if (msg.type === "response.output_audio.delta" && msg.delta && streamSid) {
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: msg.delta },
        })
      );
      return;
    }

    // If server VAD says speech stopped, ask model to respond.
    // (In some configs the server can auto-respond; this makes it deterministic.)  [oai_citation:6‡OpenAI Developers](https://developers.openai.com/api/docs/guides/realtime-conversations/?utm_source=chatgpt.com)
    if (msg.type === "input_audio_buffer.speech_stopped") {
      openaiWs.send(
        JSON.stringify({
          type: "response.create",
          response: {
            output_modalities: ["audio"],
          },
        })
      );
    }
  });

  // Receive Twilio stream messages and send audio into OpenAI
  twilioWs.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.event === "start") {
      streamSid = msg.streamSid;
      return;
    }

    if (msg.event === "media" && msg.media?.payload) {
      // Append base64 μ-law audio to OpenAI input buffer  [oai_citation:7‡Twilio](https://www.twilio.com/docs/voice/media-streams/websocket-messages)
      openaiWs.readyState === WebSocket.OPEN &&
        openaiWs.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: msg.media.payload,
          })
