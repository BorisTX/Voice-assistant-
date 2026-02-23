import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const app = express();
app.use(express.urlencoded({ extended: false }));


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
server.listen(port, () => {
  console.log("Voice assistant is running 🚀 on port", port);
});
