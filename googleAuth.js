// googleAuth.js
import { google } from "googleapis";
import { getGoogleTokens, upsertGoogleTokens } from "./db.js";

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

export function getAuthUrlForBusiness(oauth2Client, businessId) {
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state: businessId,
  });
}

export async function loadTokensIntoClientForBusiness(db, oauth2Client, businessId) {
  const row = await getGoogleTokens(db, businessId);
  if (!row || !row.access_token) throw new Error("No tokens for this business");

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

export async function exchangeCodeAndStoreForBusiness(db, oauth2Client, code, businessId) {
  const { tokens } = await oauth2Client.getToken(code);

  await upsertGoogleTokens(db, businessId, tokens);

  oauth2Client.setCredentials(tokens);

  oauth2Client.removeAllListeners("tokens");
  oauth2Client.on("tokens", async (newTokens) => {
    try {
      await upsertGoogleTokens(db, businessId, newTokens);
    } catch (e) {
      console.error("Failed to save refreshed tokens (business):", e);
    }
  });

  return tokens;
}
