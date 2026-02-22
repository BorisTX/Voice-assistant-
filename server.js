import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const app = express();
app.use(express.urlencoded({ extended: false }));

app.get("/", (req, res) => res.status(200).send("OK"));

app.post("/voice", (req, res) => {
  const host = req.get("host");
  const streamUrl = wss://${host}/media;

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
const wss = new WebSocketServer({ server, path: "/media" });

wss.on("connection", (twilioWs) => {
  let streamSid = null;

  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-realtime",
    {
      headers: {
        Authorization: Bearer ${process.env.OPENAI_API_KEY},
      },
    }
  );

  openaiWs.on("open", () => {
    // Minimal, valid session config (mulaw passthrough)
    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          instructions:
            "You are a friendly HVAC scheduling assistant in Dallas–Fort Worth. " +
            "Ask short questions to collect: name, phone, address, issue, preferred time. " +
            "If emergency (no AC/no heat/gas smell/burning smell/water leak), say you will prioritize and offer to connect to a tech. " +
            "Do not quote prices. Keep it brief.",
          input_audio_format: "pcm_mulaw",
          output_audio_format: "pcm_mulaw",
          voice: "alloy",
        },
      })
    );

    // Make the assistant speak first (quick sanity check)
    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          output_modalities: ["audio"],
          instructions:
            "Say: 'Hi! This is the HVAC assistant. Is this an emergency, or do you want to schedule service?'",
        },
      })
    );
  });

  // Twilio -> OpenAI
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
      try {
        openaiWs.close();
      } catch {}
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

  const cleanup = () => {
    try {
      openaiWs.close();
    } catch {}
    try {
      twilioWs.close();
    } catch {}
  };

  twilioWs.on("close", cleanup);
  openaiWs.on("close", cleanup);
  openaiWs.on("error", (e) => console.error("OpenAI WS error:", e));
});

const port = process.env.PORT || 3000;
server.listen(port, () => console.log("Server listening on", port));
