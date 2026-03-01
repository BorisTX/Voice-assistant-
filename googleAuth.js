// googleAuth.js
import { google } from "googleapis";
import crypto from "crypto";
import { performance } from "node:perf_hooks";
import { signOAuthState } from "./src/security/state.js";

// --- PKCE helpers ---
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

function nowMs() {
  return performance.now();
}

function makeCodeVerifier() {
  // 32 bytes => safe
  return base64url(crypto.randomBytes(32));
}

// data-layer methods expected:
// data.assertBusinessExists(businessId)
// data.getGoogleTokens(businessId)
// data.upsertGoogleTokens(businessId, tokens)
// data.createOAuthFlow({nonce, business_id, code_verifier, expires_at_utc})
// data.consumeOAuthFlow(nonce) -> returns row and deletes it (one-time)

export function makeOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI");
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export async function getAuthUrlForBusiness(data, oauth2Client, businessId) {
  await data.assertBusinessExists(businessId);

  const nonce = crypto.randomUUID();
  const ts = Date.now();

  // PKCE
  const code_verifier = makeCodeVerifier();
  const code_challenge = sha256Base64url(code_verifier);

  // signed state payload
  const state = signOAuthState({ businessId, nonce, ts });

  // store flow in DB (10 minutes)
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

    // PKCE:
    code_challenge,
    code_challenge_method: "S256",
  });

  return url;
}

export async function exchangeCodeAndStoreForBusiness(
  data,
  oauth2Client,
  code,
  businessId,
  codeVerifier // <-- REQUIRED for PKCE
) {
  await data.assertBusinessExists(businessId);
  if (!codeVerifier) throw new Error("Missing PKCE codeVerifier");

  // googleapis supports passing object; we pass both keys for compatibility
  const t0 = nowMs();
  let tokens;
  try {
    ({ tokens } = await oauth2Client.getToken({
      code,
      codeVerifier, // some versions
      code_verifier: codeVerifier, // spec / other versions
    }));
    const duration_ms = Math.round(nowMs() - t0);
    console.log(JSON.stringify({ op: "google.oauth.get_token", ok: true, duration_ms }));
  } catch (error) {
    const duration_ms = Math.round(nowMs() - t0);
    console.error(JSON.stringify({ op: "google.oauth.get_token", ok: false, duration_ms, error: String(error?.message || error) }));
    throw error;
  }

  await data.upsertGoogleTokens(businessId, tokens);
  return true;
}

export async function loadTokensIntoClientForBusiness(data, oauth2Client, businessId) {
  await data.assertBusinessExists(businessId);

  const row = await data.getGoogleTokens(businessId);
  if (!row?.access_token && !row?.refresh_token) {
    throw new Error("No tokens for this business");
  }

  oauth2Client.setCredentials({
    access_token: row.access_token || undefined,
    refresh_token: row.refresh_token || undefined,
    scope: row.scope || undefined,
    token_type: row.token_type || undefined,
    expiry_date: row.expiry_date_utc ? new Date(row.expiry_date_utc).getTime() : undefined,
  });

  return true;
}
