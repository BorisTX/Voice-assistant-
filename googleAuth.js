// googleAuth.js
import { google } from "googleapis";
import { getTokens, saveTokens } from "./db.js";
import { getTokens } from "./db.js";
const SCOPES = [
  "https://www.googleapis.com/auth/calendar", // full access (для MVP)
  // потом можно сузить до calendar.events если захочешь
];

export function makeOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI");
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function getAuthUrl(oauth2Client) {
  // prompt: 'consent' + access_type: 'offline' -> чтобы гарантированно получить refresh_token
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });
}
export async function loadTokensIntoClient(oauth2Client) {
  const row = await getTokens();

  if (!row || !row.access_token) {
    throw new Error("No tokens in DB");
  }
  oauth2Client.setCredentials({
    access_token: row.access_token,
    refresh_token: row.refresh_token,
    scope: row.scope,
    token_type: row.token_type,
    expiry_date: row.expiry_date,
  });
}
  oauth2Client.on("tokens", async (newTokens) => {
    // newTokens может содержать access_token и иногда refresh_token
    await saveTokens(newTokens);
  });

  return tokens;
}

export async function exchangeCodeAndStore(oauth2Client, code) {
  const { tokens } = await oauth2Client.getToken(code);
  await saveTokens(tokens);
  oauth2Client.setCredentials(tokens);
  return tokens;
}
