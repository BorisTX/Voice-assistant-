// googleAuth.js
import { google } from "googleapis";
import { getTokens, saveTokens } from "./db.js";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar", // full access (для MVP)
  // потом можно сузить до calendar.events если захочешь
];

export function makeOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId  !clientSecret  !redirectUri) {
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
  if (!row) return null;

  const tokens = {
    access_token: row.access_token || undefined,
    refresh_token: row.refresh_token || undefined,
    scope: row.scope || undefined,
    token_type: row.token_type || undefined,
    expiry_date: row.expiry_date || undefined,
  };

  // если refresh_token отсутствует — значит не подключили офлайн доступ
  if (!tokens.refresh_token) return null;

  oauth2Client.setCredentials(tokens);

  // Подписываемся на обновление токенов
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
