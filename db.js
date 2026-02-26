// db.js
import sqlite3 from "sqlite3";

const DB_PATH = process.env.SQLITE_PATH || "./data.sqlite";
const db = new sqlite3.Database(DB_PATH);

export function initDb() {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        id INTEGER PRIMARY KEY,
        access_token TEXT,
        refresh_token TEXT,
        scope TEXT,
        token_type TEXT,
        expiry_date INTEGER,
        updated_at INTEGER
      )
    `);

    // гарантируем 1 строку
    db.run(
      `INSERT OR IGNORE INTO oauth_tokens (id, updated_at)
       VALUES (1, strftime('%s','now'))`
    );
  });
}

export function getTokens() {
  return new Promise((resolve, reject) => {
    db.get(`SELECT * FROM oauth_tokens WHERE id = 1`, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

export function saveTokens(tokens) {
  const {
    access_token = null,
    refresh_token = null,
    scope = null,
    token_type = null,
    expiry_date = null,
  } = tokens || {};

  const updated_at = Math.floor(Date.now() / 1000);

  return new Promise((resolve, reject) => {
    // refresh_token может прийти только один раз — если null, оставляем старый
    db.run(
      `
      UPDATE oauth_tokens
      SET
        access_token = COALESCE(?, access_token),
        refresh_token = COALESCE(?, refresh_token),
        scope = COALESCE(?, scope),
        token_type = COALESCE(?, token_type),
        expiry_date = COALESCE(?, expiry_date),
        updated_at = ?
      WHERE id = 1
      `,
      [access_token, refresh_token, scope, token_type, expiry_date, updated_at],
      (err) => {
        if (err) return reject(err);
        resolve(true);
      }
    );
  });
}

export function upsertGoogleTokens(businessId, tokens) {
  const {
    access_token = null,
    refresh_token = null,
    scope = null,
    token_type = null,
    expiry_date = null,
  } = tokens || {};

  const now = new Date().toISOString();

  // expiry_date приходит как число (ms). Храним как ISO string.
  const expiryIso = typeof expiry_date === "number" ? new Date(expiry_date).toISOString() : null;

  return new Promise((resolve, reject) => {
    db.run(
      `
      INSERT INTO google_tokens (
        business_id, access_token, refresh_token, scope, token_type, expiry_date_utc,
        created_at_utc, updated_at_utc
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(business_id) DO UPDATE SET
        access_token    = COALESCE(excluded.access_token, google_tokens.access_token),
        refresh_token   = COALESCE(excluded.refresh_token, google_tokens.refresh_token),
        scope           = COALESCE(excluded.scope, google_tokens.scope),
        token_type      = COALESCE(excluded.token_type, google_tokens.token_type),
        expiry_date_utc = COALESCE(excluded.expiry_date_utc, google_tokens.expiry_date_utc),
        updated_at_utc  = excluded.updated_at_utc
      `,
      [
        businessId,
        access_token,
        refresh_token,
        scope,
        token_type,
        expiryIso,
        now,
        now,
      ],
      (err) => {
        if (err) return reject(err);
        resolve(true);
      }
    );
  });
}
export function getGoogleTokens(businessId) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT business_id, access_token, refresh_token, scope, token_type, expiry_date_utc, updated_at_utc
       FROM google_tokens
       WHERE business_id = ?`,
      [businessId],
      (err, row) => {
        if (err) return reject(err);
        resolve(row || null);
      }
    );
  });
}
