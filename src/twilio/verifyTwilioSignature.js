import crypto from "crypto";

function toTwilioValue(value) {
  if (Array.isArray(value)) return value.map((entry) => (entry == null ? "" : String(entry))).join("");
  return value == null ? "" : String(value);
}

function computeTwilioSignature(authToken, url, params) {
  const normalizedParams = params && typeof params === "object" ? params : {};
  const data = Object.keys(normalizedParams)
    .sort()
    .reduce((acc, key) => `${acc}${key}${toTwilioValue(normalizedParams[key])}`, url);

  return crypto
    .createHmac("sha1", authToken)
    .update(Buffer.from(data, "utf-8"))
    .digest("base64");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left || "", "utf8");
  const rightBuffer = Buffer.from(right || "", "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function verifyTwilioSignature(req, res, next) {
  const signature = req.get("x-twilio-signature");
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const isProduction = process.env.NODE_ENV === "production";
  const allowInsecure = process.env.ALLOW_INSECURE_TWILIO_WEBHOOKS === "1";

  if (!authToken) {
    if (!isProduction && allowInsecure) return next();

    console.warn(JSON.stringify({
      level: "warn",
      requestId: req.requestId || null,
      path: req.path,
      method: req.method,
      ip: req.ip,
      reason: "twilio_signature_invalid",
    }));
    return res.status(403).send("Forbidden");
  }

  if (!signature) {
    console.warn(JSON.stringify({
      level: "warn",
      requestId: req.requestId || null,
      path: req.path,
      method: req.method,
      ip: req.ip,
      reason: "twilio_signature_invalid",
    }));
    return res.status(403).send("Forbidden");
  }

  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const url = `${proto}://${host}${req.originalUrl}`;

  const expectedSignature = computeTwilioSignature(authToken, url, req.body);
  if (!safeEqual(expectedSignature, signature)) {
    console.warn(JSON.stringify({
      level: "warn",
      requestId: req.requestId || null,
      path: req.path,
      method: req.method,
      ip: req.ip,
      reason: "twilio_signature_invalid",
    }));
    return res.status(403).send("Forbidden");
  }

  return next();
}

export default verifyTwilioSignature;
