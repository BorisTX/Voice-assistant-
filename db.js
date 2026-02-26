// db.js (multi-tenant only; uses the db instance from openDb())

// --- tiny promise helpers ---
function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

// --- businesses ---
export async function getBusinessById(db, businessId) {
  return get(
    db,
    `SELECT id, name, industry, timezone, working_hours_json,
            default_duration_min, slot_granularity_min,
            buffer_before_min, buffer_after_min,
            lead_time_min, max_days_ahead, max_daily_jobs,
            emergency_enabled, emergency_keywords_json,
            created_at_utc, updated_at_utc
     FROM businesses
     WHERE id = ?`,
    [businessId]
  );
}

export async function getBusinessByName(db, name) {
  return get(
    db,
    `SELECT id, name, timezone
     FROM businesses
     WHERE name = ?
     LIMIT 1`,
    [name]
  );
}

export async function listBusinesses(db) {
  return all(
    db,
    `SELECT id, name, industry, timezone, created_at_utc
     FROM businesses
     ORDER BY created_at_utc DESC`
  );
}

export async function insertBusiness(db, business) {
  const now = new Date().toISOString();

  const {
    id,
    name,
    industry = "hvac",
    timezone = "America/Chicago",
    working_hours_json = "{}",
    default_duration_min = 60,
    slot_granularity_min = 15,
    buffer_before_min = 0,
    buffer_after_min = 30,
    lead_time_min = 60,
    max_days_ahead = 7,
    max_daily_jobs = null,
    emergency_enabled = 1,
    emergency_keywords_json = "[]",
  } = business;

  if (!id) throw new Error("insertBusiness: missing id");
  if (!name) throw new Error("insertBusiness: missing name");

  await run(
    db,
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
      industry,
      timezone,
      working_hours_json,
      default_duration_min,
      slot_granularity_min,
      buffer_before_min,
      buffer_after_min,
      lead_time_min,
      max_days_ahead,
      max_daily_jobs,
      emergency_enabled,
      emergency_keywords_json,
      now,
      now,
    ]
  );

  return id;
}

// --- google tokens (single source of truth) ---
export async function upsertGoogleTokens(db, businessId, tokens) {
  const {
    access_token = null,
    refresh_token = null,
    scope = null,
    token_type = null,
    expiry_date = null, // ms from google
  } = tokens || {};

  const now = new Date().toISOString();
  const expiryIso =
    typeof expiry_date === "number" ? new Date(expiry_date).toISOString() : null;

  // IMPORTANT: do not overwrite refresh_token with null
  await run(
    db,
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
    ]
  );

  return true;
}

export async function getGoogleTokens(db, businessId) {
  return get(
    db,
    `
    SELECT business_id, access_token, refresh_token, scope, token_type,
           expiry_date_utc, created_at_utc, updated_at_utc
    FROM google_tokens
    WHERE business_id = ?
    `,
    [businessId]
  );
}

export async function assertBusinessExists(db, businessId) {
  const row = await get(db, `SELECT id FROM businesses WHERE id = ?`, [businessId]);
  if (!row) throw new Error(`Unknown business_id: ${businessId}`);
  return true;
}

// --- debug helpers ---
export async function listTables(db) {
  const rows = await all(
    db,
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  );
  return rows.map((r) => r.name);
}
