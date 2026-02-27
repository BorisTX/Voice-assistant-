// googleAuth.js
import { google } from "googleapis";
import crypto from "crypto";
import { signOAuthState } from "./src/security/state.js";
// ---- PKCE helpers ----

function base64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function sha256Base64url(str) {
  const hash = crypto.createHash("sha256").update(str).digest();
  return base64url(hash);
}

function makeCodeVerifier() {
  return base64url(crypto.randomBytes(32));
}
// data-layer methods expected:
// data.assertBusinessExists(businessId)
// data.getGoogleTokens(businessId)
// data.upsertGoogleTokens(businessId, tokens)

export function makeOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI");
  }

  // IMPORTANT: this returns an OAuth2Client
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  return oauth2Client;
}

export async function getAuthUrlForBusiness(data, oauth2Client, businessId) {
  await data.assertBusinessExists(businessId);

  const nonce = crypto.randomUUID();
  const ts = Date.now();

  // PKCE
  const code_verifier = makeCodeVerifier();
  const code_challenge = sha256Base64url(code_verifier);

  // state (HMAC signed payload)
  const state = signOAuthState({ businessId, nonce, ts });

  // сохраняем flow в БД (на 10 минут)
  const expires_at_utc = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  await data.createOAuthFlow({
    nonce,
    business_id: businessId,
    code_verifier,
    expires_at_utc,
  });

  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/calendar"],
    state,

    // PKCE params:
    code_challenge,
    code_challenge_method: "S256",
  });

  return url;
}
