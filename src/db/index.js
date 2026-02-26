// src/db/index.js
import sqlite3 from "sqlite3";
import crypto from "crypto";
import { Pool } from "pg";

const DIALECT = process.env.DB_DIALECT || "sqlite";
const SQLITE_PATH = process.env.SQLITE_PATH || "./data.sqlite";
const DATABASE_URL = process.env.DATABASE_URL;

function nowIso() {
  return new Date().toISOString();
}

export async function createDb() {
  if (DIALECT === "postgres") {
    if (!DATABASE_URL) throw new Error("DATABASE_URL is missing for postgres");
    const pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // Render обычно требует ssl
    });

    return makePostgresDb(pool);
  }

  // default sqlite
  const db = new sqlite3.Database(SQLITE_PATH);
  return makeSqliteDb(db);
}

function makeSqliteDb(db) {
  const run = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.run(sql, params, function (err) {
        if (err) return reject(err);
        resolve({ changes: this.changes, lastID: this.lastID });
      });
    });

  const get = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => {
        if (err) return reject(err);
        resolve(row || null);
      });
    });

  const all = (sql, params = []) =>
    new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      });
    });

  return {
    dialect: "sqlite",
    close: () => db.close(),

    // --- businesses ---
    async ensureDefaultBusiness() {
      const name = "Default HVAC (DFW)";
      const row = await get(
        "SELECT id, name, industry, timezone, created_at_utc FROM businesses WHERE name = ? LIMIT 1",
        [name]
      );
      if (row) return { created: false, business: row };

      const id = crypto.randomUUID();
      const wh = {
        mon: [{ start: "08:00", end: "17:00" }],
        tue: [{ start: "08:00", end: "17:00" }],
        wed: [{ start: "08:00", end: "17:00" }],
        thu: [{ start: "08:00", end: "17:00" }],
        fri: [{ start: "08:00", end: "17:00" }],
        sat: [],
        sun: [],
      };

      const emergencyKeywords = ["no heat", "no cooling", "gas smell", "water leak", "flooding"];
      const now = nowIso();

      await run(
        `
        INSERT INTO businesses (
          id, name, industry, timezone, working_hours_json,
          default_duration_min, slot_granularity_min,
          buffer_before_min, buffer_after_min,
          lead_time_min, max_days_ahead, max_daily_jobs,
          emergency_enabled, emergency_keywords_json,
          created_at_utc, updated_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          id,
          name,
          "hvac",
          "America/Chicago",
          JSON.stringify(wh),
          60,
          15,
          0,
          30,
          60,
          7,
          null,
          1,
          JSON.stringify(emergencyKeywords),
          now,
          now,
        ]
      );

      const business = await get(
        "SELECT id, name, industry, timezone, created_at_utc FROM businesses WHERE id = ?",
        [id]
      );
      return { created: true, business };
    },

    async getBusiness(businessId) {
      return await get(
        "SELECT id, name, industry, timezone, working_hours_json, default_duration_min, slot_granularity_min, buffer_before_min, buffer_after_min, lead_time_min, max_days_ahead, max_daily_jobs, emergency_enabled, emergency_keywords_json, created_at_utc, updated_at_utc FROM businesses WHERE id = ?",
        [businessId]
      );
    },

    async listBusinesses() {
      return await all(
        "SELECT id, name, industry, timezone, created_at_utc FROM businesses ORDER BY created_at_utc DESC"
      );
    },

    // --- google_tokens ---
    async getGoogleTokens(businessId) {
      return await get(
        `SELECT business_id, access_token, refresh_token, scope, token_type, expiry_date_utc, updated_at_utc
         FROM google_tokens WHERE business_id = ?`,
        [businessId]
      );
    },

    async upsertGoogleTokens(businessId, tokens) {
      const {
        access_token = null,
        refresh_token = null,
        scope = null,
        token_type = null,
        expiry_date = null,
      } = tokens || {};

      const now = nowIso();
      const expiryIso = typeof expiry_date === "number" ? new Date(expiry_date).toISOString() : null;

      await run(
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
        [businessId, access_token, refresh_token, scope, token_type, expiryIso, now, now]
      );

      return true;
    },
  };
}

function makePostgresDb(pool) {
  const q = (text, params = []) => pool.query(text, params);

  return {
    dialect: "postgres",
    close: () => pool.end(),

    async ensureDefaultBusiness() {
      const name = "Default HVAC (DFW)";
      const existing = await q(
        `SELECT id, name, industry, timezone, created_at_utc
         FROM businesses WHERE name = $1 LIMIT 1`,
        [name]
      );
      if (existing.rows[0]) return { created: false, business: existing.rows[0] };

      const id = crypto.randomUUID();
      const wh = {
        mon: [{ start: "08:00", end: "17:00" }],
        tue: [{ start: "08:00", end: "17:00" }],
        wed: [{ start: "08:00", end: "17:00" }],
        thu: [{ start: "08:00", end: "17:00" }],
        fri: [{ start: "08:00", end: "17:00" }],
        sat: [],
        sun: [],
      };
      const emergencyKeywords = ["no heat", "no cooling", "gas smell", "water leak", "flooding"];
      const now = nowIso();

      await q(
        `
        INSERT INTO businesses (
          id, name, industry, timezone, working_hours_json,
          default_duration_min, slot_granularity_min,
          buffer_before_min, buffer_after_min,
          lead_time_min, max_days_ahead, max_daily_jobs,
          emergency_enabled, emergency_keywords_json,
          created_at_utc, updated_at_utc
        ) VALUES (
          $1,$2,$3,$4,$5,
          $6,$7,
          $8,$9,
          $10,$11,$12,
          $13,$14,
          $15,$16
        )
        `,
        [
          id,
          name,
          "hvac",
          "America/Chicago",
          JSON.stringify(wh),
          60,
          15,
          0,
          30,
          60,
          7,
          null,
          true,
          JSON.stringify(emergencyKeywords),
          now,
          now,
        ]
      );

      const created = await q(
        `SELECT id, name, industry, timezone, created_at_utc FROM businesses WHERE id = $1`,
        [id]
      );
      return { created: true, business: created.rows[0] };
    },

    async getBusiness(businessId) {
      const r = await q(
        `SELECT id, name, industry, timezone, working_hours_json, default_duration_min, slot_granularity_min,
                buffer_before_min, buffer_after_min, lead_time_min, max_days_ahead, max_daily_jobs,
                emergency_enabled, emergency_keywords_json, created_at_utc, updated_at_utc
         FROM businesses WHERE id = $1`,
        [businessId]
      );
      return r.rows[0] || null;
    },

    async listBusinesses() {
      const r = await q(
        `SELECT id, name, industry, timezone, created_at_utc
         FROM businesses ORDER BY created_at_utc DESC`
      );
      return r.rows;
    },

    async getGoogleTokens(businessId) {
      const r = await q(
        `SELECT business_id, access_token, refresh_token, scope, token_type, expiry_date_utc, updated_at_utc
         FROM google_tokens WHERE business_id = $1`,
        [businessId]
      );
      return r.rows[0] || null;
    },

    async upsertGoogleTokens(businessId, tokens) {
      const {
        access_token = null,
        refresh_token = null,
        scope = null,
        token_type = null,
        expiry_date = null,
      } = tokens || {};

      const now = nowIso();
      const expiryIso = typeof expiry_date === "number" ? new Date(expiry_date).toISOString() : null;

      await q(
        `
        INSERT INTO google_tokens (
          business_id, access_token, refresh_token, scope, token_type, expiry_date_utc,
          created_at_utc, updated_at_utc
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (business_id) DO UPDATE SET
          access_token    = COALESCE(EXCLUDED.access_token, google_tokens.access_token),
          refresh_token   = COALESCE(EXCLUDED.refresh_token, google_tokens.refresh_token),
          scope           = COALESCE(EXCLUDED.scope, google_tokens.scope),
          token_type      = COALESCE(EXCLUDED.token_type, google_tokens.token_type),
          expiry_date_utc = COALESCE(EXCLUDED.expiry_date_utc, google_tokens.expiry_date_utc),
          updated_at_utc  = EXCLUDED.updated_at_utc
        `,
        [businessId, access_token, refresh_token, scope, token_type, expiryIso, now, now]
      );

      return true;
    },
  };
}
