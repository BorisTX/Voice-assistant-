// src/googleAuth.js
import { google } from "googleapis";
import {
  assertBusinessExists,
  getGoogleTokens,
  upsertGoogleTokens,
} from "./db.js";

// Full calendar access for MVP.
// Later you can narrow to: https://www.googleapis.com/auth/calendar.events
const SCOPES = ["https://www.googleapis.com/auth/calendar"];

export function makeOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI");
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/**
 * Generates OAuth URL for a specific business.
 * We pass businessId in `state` so callback can route tokens correctly.
 */
export async function getAuthUrlForBusiness(db, oauth2Client, businessId) {
  if (!businessId) throw new Error("Missing businessId");
  await assertBusinessExists(db, businessId);

  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // ensures refresh_token on first consent (and on re-consent)
    scope: SCOPES,
    state: businessId,
  });
}

/**
 * Loads tokens for business into the provided OAuth client.
 * IMPORTANT: do NOT reuse the same oauth2Client across different businesses concurrently.
 * Create a fresh client per request/flow.
 */
export async function loadTokensIntoClientForBusiness(db, oauth2Client, businessId) {
  if (!businessId) throw new Error("Missing businessId");
  await assertBusinessExists(db, businessId);

  const row = await getGoogleTokens(db, businessId);
  if (!row || !row.access_token) {
    throw new Error("No tokens for this business");
  }

  const expiryMs = row.expiry_date_utc ? Date.parse(row.expiry_date_utc) : undefined;

  oauth2Client.setCredentials({
    access_token: row.access_token,
    refresh_token: row.refresh_token || undefined,
    scope: row.scope || undefined,
    token_type: row.token_type || undefined,
    expiry_date: expiryMs || undefined,
  });

  return row;
}

/**
 * Exchanges auth code and stores tokens for the given business.
 * Also installs a safe tokens listener that persists refreshes *for this business*.
 * NOTE: This is safe ONLY if you use a dedicated oauth2Client instance per business flow.
 */
export async function exchangeCodeAndStoreForBusiness(db, oauth2Client, code, businessId) {
  if (!code) throw new Error("Missing code");
  if (!businessId) throw new Error("Missing businessId");
  await assertBusinessExists(db, businessId);

  const { tokens } = await oauth2Client.getToken(code);

  await upsertGoogleTokens(db, businessId, tokens);
  oauth2Client.setCredentials(tokens);

  // Persist future refreshes for THIS business.
  // Do NOT call removeAllListeners here (it can break other flows if you ever reuse the client).
  oauth2Client.on("tokens", async (newTokens) => {
    try {
      await upsertGoogleTokens(db, businessId, newTokens);
    } catch (e) {
      console.error("Failed to save refreshed tokens (business):", e);
    }
  });

  return tokens;
}
