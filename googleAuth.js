// src/googleAuth.js
import { google } from "googleapis";
import {
  getTokens as dbGetTokens,
  saveTokens as dbSaveTokens,
  getGoogleTokens,
  upsertGoogleTokens,
} from "./db.js";
// Для MVP: полный доступ к календарю.
// Позже можно сузить до: "https://www.googleapis.com/auth/calendar.events"
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

export function getAuthUrl(oauth2Client) {
  // prompt=consent + access_type=offline -> чтобы гарантированно получить refresh_token
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });
}

export async function loadTokensIntoClient(oauth2Client) {
  const row = await dbGetTokens();

  if (!row || !row.access_token) {
    throw new Error("No tokens in DB");
  }

  oauth2Client.setCredentials({
    access_token: row.access_token,
    refresh_token: row.refresh_token || undefined,
    scope: row.scope || undefined,
    token_type: row.token_type || undefined,
    expiry_date: row.expiry_date || undefined,
  });

  return row;
}

export async function exchangeCodeAndStore(oauth2Client, code) {
  const { tokens } = await oauth2Client.getToken(code);

  // сохраняем то, что пришло (может прийти refresh_token только 1 раз)
  await dbSaveTokens(tokens);

  oauth2Client.setCredentials(tokens);

  // если Google обновит токены позже (refresh), сохраним в DB
  oauth2Client.on("tokens", async (newTokens) => {
    try {
      await dbSaveTokens(newTokens);
    } catch (e) {
      console.error("Failed to save refreshed tokens:", e);
    }
  });

  return tokens;
}
