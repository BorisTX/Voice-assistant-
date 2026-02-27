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


function execSql(db, sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => {
      if (err) return reject(err);
      resolve(true);
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
// --- bookings (holds + confirm) ---

export async function cleanupExpiredHolds(db, businessId = null) {
  const now = new Date().toISOString();
  if (businessId) {
    await run(
      db,
      `
      UPDATE bookings
      SET status = 'cancelled', updated_at_utc = ?
      WHERE business_id = ?
        AND status = 'pending'
        AND hold_expires_at_utc IS NOT NULL
        AND hold_expires_at_utc <= ?
      `,
      [now, businessId, now]
    );
    return true;
  }

  await run(
    db,
    `
    UPDATE bookings
    SET status = 'cancelled', updated_at_utc = ?
    WHERE status = 'pending'
      AND hold_expires_at_utc IS NOT NULL
      AND hold_expires_at_utc <= ?
    `,
    [now, now]
  );
  return true;
}

export async function findOverlappingActiveBookings(db, businessId, startUtcIso, endUtcIso) {
  const now = new Date().toISOString();
  // overlap rule: existing.start < new.end AND existing.end > new.start
  // pending holds count only if not expired
  return all(
    db,
    `
    SELECT id, status, start_utc, end_utc, hold_expires_at_utc
    FROM bookings
    WHERE business_id = ?
      AND (
        status = 'confirmed'
        OR (status = 'pending' AND (hold_expires_at_utc IS NULL OR hold_expires_at_utc > ?))
      )
      AND start_utc < ?
      AND end_utc > ?
    ORDER BY start_utc ASC
    LIMIT 10
    `,
    [businessId, now, endUtcIso, startUtcIso]
  );
}

export async function createPendingHold(db, payload) {
  const now = new Date().toISOString();
  const {
    id,
    business_id,
    start_utc,
    end_utc,
    hold_expires_at_utc,
    customer_name = null,
    customer_phone = null,
    customer_email = null,
    job_summary = null,
  } = payload;

  if (!id) throw new Error("createPendingHold: missing id");
  if (!business_id) throw new Error("createPendingHold: missing business_id");
  if (!start_utc || !end_utc) throw new Error("createPendingHold: missing start/end");

  await run(
    db,
    `
    INSERT INTO bookings (
      id, business_id,
      start_utc, end_utc,
      status, hold_expires_at_utc,
      customer_name, customer_phone, customer_email,
      job_summary,
      gcal_event_id,
      created_at_utc, updated_at_utc
    ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, NULL, ?, ?)
    `,
    [
      id,
      business_id,
      start_utc,
      end_utc,
      hold_expires_at_utc,
      customer_name,
      customer_phone,
      customer_email,
      job_summary,
      now,
      now,
    ]
  );

  return true;
}

export async function confirmBooking(db, bookingId, gcalEventId) {
  const now = new Date().toISOString();
  await run(
    db,
    `
    UPDATE bookings
    SET status='confirmed',
        hold_expires_at_utc=NULL,
        gcal_event_id=?,
        updated_at_utc=?
    WHERE id=?
    `,
    [gcalEventId || null, now, bookingId]
  );
  return true;
}

export async function failBooking(db, bookingId, reason = null) {
  const now = new Date().toISOString();
  const summary = reason ? `FAILED: ${reason}` : "FAILED";
  await run(
    db,
    `
    UPDATE bookings
    SET status='failed',
        job_summary=COALESCE(job_summary, ?) ,
        updated_at_utc=?
    WHERE id=?
    `,
    [summary, now, bookingId]
  );
  return true;
}

export async function cancelBooking(db, bookingId) {
  const now = new Date().toISOString();
  await run(
    db,
    `
    UPDATE bookings
    SET status='cancelled',
        updated_at_utc=?
    WHERE id=?
    `,
    [now, bookingId]
  );
  return true;
}

export async function getBookingById(db, bookingId) {
  return get(
    db,
    `
    SELECT *
    FROM bookings
    WHERE id = ?
    `,
    [bookingId]
  );
}


export async function createPendingHoldIfAvailableTx(db, payload) {
  const now = new Date().toISOString();
  const {
    id,
    business_id,
    start_utc,
    end_utc,
    hold_expires_at_utc,
    customer_name = null,
    customer_phone = null,
    customer_email = null,
    job_summary = null,
  } = payload;

  if (!id) throw new Error("createPendingHoldIfAvailableTx: missing id");
  if (!business_id) throw new Error("createPendingHoldIfAvailableTx: missing business_id");
  if (!start_utc || !end_utc) throw new Error("createPendingHoldIfAvailableTx: missing start/end");

  await execSql(db, "BEGIN IMMEDIATE;");
  try {
    await cleanupExpiredHolds(db, business_id);

    const overlaps = await findOverlappingActiveBookings(db, business_id, start_utc, end_utc);
    if (overlaps.length > 0) {
      await execSql(db, "ROLLBACK;");
      return { ok: false, reason: "Slot already taken" };
    }

    await run(
      db,
      `
      INSERT INTO bookings (
        id, business_id,
        start_utc, end_utc,
        status, hold_expires_at_utc,
        customer_name, customer_phone, customer_email,
        job_summary,
        gcal_event_id,
        created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, NULL, ?, ?)
      `,
      [
        id,
        business_id,
        start_utc,
        end_utc,
        hold_expires_at_utc,
        customer_name,
        customer_phone,
        customer_email,
        job_summary,
        now,
        now,
      ]
    );

    await execSql(db, "COMMIT;");
    return { ok: true };
  } catch (err) {
    await execSql(db, "ROLLBACK;");
    throw err;
  }
}

