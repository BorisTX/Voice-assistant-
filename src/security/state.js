import crypto from "crypto";

function base64urlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64urlDecode(str) {
  let s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

export function signOAuthState(payloadObj) {
  const secret = process.env.OAUTH_STATE_SECRET;
  if (!secret) throw new Error("Missing OAUTH_STATE_SECRET");

  const payloadJson = JSON.stringify(payloadObj);
  const payloadB64 = base64urlEncode(payloadJson);

  const sig = crypto.createHmac("sha256", secret).update(payloadB64).digest();
  const sigB64 = base64urlEncode(sig);

  return `${payloadB64}.${sigB64}`;
}

export function verifyOAuthState(state) {
  const secret = process.env.OAUTH_STATE_SECRET;
  if (!secret) throw new Error("Missing OAUTH_STATE_SECRET");

  const [payloadB64, sigB64] = String(state || "").split(".");
  if (!payloadB64 || !sigB64) return { ok: false, error: "bad_format" };

  const expectedSig = crypto.createHmac("sha256", secret).update(payloadB64).digest();
  const expectedSigB64 = base64urlEncode(expectedSig);

  // timing-safe compare must be same length
  const a = Buffer.from(sigB64);
  const b = Buffer.from(expectedSigB64);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: "bad_sig" };
  }

  let payload;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64).toString("utf8"));
  } catch {
    return { ok: false, error: "bad_payload" };
  }

  const ttlSec = Number(process.env.OAUTH_STATE_TTL_SEC || 600);
  const ts = Number(payload?.ts || 0);
  if (!ts) return { ok: false, error: "missing_ts" };

  const ageMs = Date.now() - ts;
  if (ageMs < -60_000) return { ok: false, error: "ts_in_future" }; // small skew guard
  if (ageMs > ttlSec * 1000) return { ok: false, error: "expired" };

  return { ok: true, payload };
}
