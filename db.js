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
      INSERT OR IGNORE INTO oauth_tokens (id, updated_at) VALUES (1, strftime('%s','now'))
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
    // ВАЖНО: refresh_token может приходить только один раз.
    // Поэтому сохраняем refresh_token только если он пришёл, иначе оставляем старый.
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
