// googleAuth.js
import { google } from "googleapis";

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

  // IMPORTANT: method name is generateAuthUrl (lowercase L)
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline", // to get refresh_token
    prompt: "consent",      // ensures refresh_token on re-consent
    scope: ["https://www.googleapis.com/auth/calendar"],
    state: businessId,      // route callback to the business
  });

  return url;
}

export async function exchangeCodeAndStoreForBusiness(data, oauth2Client, code, businessId) {
  await data.assertBusinessExists(businessId);

  const { tokens } = await oauth2Client.getToken(code);
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

  // Optional: auto-refresh hook (googleapis will refresh when needed if refresh_token is set)
  return true;
}
