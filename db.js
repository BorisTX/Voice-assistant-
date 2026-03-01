// db.js (multi-tenant only; uses the db instance from openDb())

// --- tiny promise helpers ---
import crypto from "crypto";
import { encryptToken, decryptToken } from "./src/security/tokens.js";

const isProd = process.env.NODE_ENV === "production";
if (!process.env.TOKENS_ENC_KEY || process.env.TOKENS_ENC_KEY.length !== 64) {
  const msg = "TOKENS_ENC_KEY missing/invalid (expected 64 hex chars).";
  if (isProd) throw new Error(msg);
  console.warn("WARN:", msg);
}
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

const BOOKING_TRANSITIONS = {
  pending: new Set(["confirmed", "failed", "cancelled"]),
  confirmed: new Set(["cancelled"]),
  failed: new Set(),
  cancelled: new Set(),
};

function buildInvalidTransitionError(fromStatus, toStatus) {
  const error = new Error(`Invalid booking status transition: ${fromStatus} -> ${toStatus}`);
  error.code = "INVALID_STATUS_TRANSITION";
  return error;
}

export async function listTables(db) {
  return all(db, `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name ASC`);
}

// --- businesses ---
export async function getBusinessById(db, businessId) {
  return get(
    db,
    `SELECT id, name, industry, timezone, working_hours_json,
            working_hours_start, working_hours_end, technician_phone,
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
    working_hours_start = "08:00",
    working_hours_end = "17:00",
    technician_phone = null,
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
      working_hours_start, working_hours_end, technician_phone,
      default_duration_min, slot_granularity_min,
      buffer_before_min, buffer_after_min,
      lead_time_min, max_days_ahead, max_daily_jobs,
      emergency_enabled, emergency_keywords_json,
      created_at_utc, updated_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      id,
      name,
      industry,
      timezone,
      working_hours_json,
      working_hours_start,
      working_hours_end,
      technician_phone,
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

export async function assertBusinessExists(db, businessId) {
  const row = await get(db, `SELECT id FROM businesses WHERE id = ? LIMIT 1`, [businessId]);
  if (!row) throw new Error(`Business not found: ${businessId}`);
  return true;
}

const DEFAULT_WORKING_HOURS = {
  mon: [{ start: "09:00", end: "17:00" }],
  tue: [{ start: "09:00", end: "17:00" }],
  wed: [{ start: "09:00", end: "17:00" }],
  thu: [{ start: "09:00", end: "17:00" }],
  fri: [{ start: "09:00", end: "17:00" }],
  sat: [{ start: "10:00", end: "14:00" }],
  sun: [],
};

const DEFAULT_SERVICE_AREA = {
  mode: "radius",
  center: { lat: 32.7767, lng: -96.7970 },
  miles: 30,
};

export const DEFAULT_BUSINESS_PROFILE = {
  timezone: "America/Chicago",
  working_hours: DEFAULT_WORKING_HOURS,
  slot_duration_min: 60,
  buffer_min: 15,
  emergency_enabled: 1,
  emergency_phone: null,
  service_area: DEFAULT_SERVICE_AREA,
};

function safeParseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function normalizeBusinessProfileRow(row) {
  if (!row) return null;
  return {
    ...row,
    working_hours: safeParseJson(row.working_hours_json, DEFAULT_WORKING_HOURS),
    service_area: safeParseJson(row.service_area_json, DEFAULT_SERVICE_AREA),
    emergency_enabled: Number(row.emergency_enabled) ? 1 : 0,
  };
}

export async function getBusinessProfile(db, businessId) {
  const row = await get(
    db,
    `SELECT business_id, timezone, working_hours_json, slot_duration_min, buffer_min,
            emergency_enabled, emergency_phone, service_area_json,
            created_at_utc, updated_at_utc
     FROM business_profiles
     WHERE business_id = ?
     LIMIT 1`,
    [businessId]
  );

  return normalizeBusinessProfileRow(row);
}

export async function upsertBusinessProfile(db, businessId, patch = {}) {
  const now = new Date().toISOString();
  const emergencyPhoneProvided = Object.prototype.hasOwnProperty.call(patch, "emergency_phone");

  await run(
    db,
    `INSERT INTO business_profiles (
      business_id,
      timezone,
      working_hours_json,
      slot_duration_min,
      buffer_min,
      emergency_enabled,
      emergency_phone,
      service_area_json,
      created_at_utc,
      updated_at_utc
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(business_id) DO UPDATE SET
      timezone = COALESCE(excluded.timezone, business_profiles.timezone),
      working_hours_json = COALESCE(excluded.working_hours_json, business_profiles.working_hours_json),
      slot_duration_min = COALESCE(excluded.slot_duration_min, business_profiles.slot_duration_min),
      buffer_min = COALESCE(excluded.buffer_min, business_profiles.buffer_min),
      emergency_enabled = COALESCE(excluded.emergency_enabled, business_profiles.emergency_enabled),
      emergency_phone = CASE
        WHEN excluded.emergency_phone IS NULL AND ? = 0 THEN business_profiles.emergency_phone
        ELSE excluded.emergency_phone
      END,
      service_area_json = COALESCE(excluded.service_area_json, business_profiles.service_area_json),
      updated_at_utc = excluded.updated_at_utc`,
    [
      businessId,
      patch.timezone ?? null,
      patch.working_hours_json ?? null,
      patch.slot_duration_min ?? null,
      patch.buffer_min ?? null,
      patch.emergency_enabled ?? null,
      patch.emergency_phone ?? null,
      patch.service_area_json ?? null,
      now,
      now,
      emergencyPhoneProvided ? 1 : 0,
    ]
  );

  return getBusinessProfile(db, businessId);
}

export async function getEffectiveBusinessProfile(db, businessId) {
  await assertBusinessExists(db, businessId);
  const row = await getBusinessProfile(db, businessId);

  return {
    business_id: businessId,
    timezone: row?.timezone || DEFAULT_BUSINESS_PROFILE.timezone,
    working_hours: row?.working_hours || DEFAULT_BUSINESS_PROFILE.working_hours,
    slot_duration_min: Number(row?.slot_duration_min || DEFAULT_BUSINESS_PROFILE.slot_duration_min),
    buffer_min: Number(row?.buffer_min ?? DEFAULT_BUSINESS_PROFILE.buffer_min),
    emergency_enabled: Number(row?.emergency_enabled ?? DEFAULT_BUSINESS_PROFILE.emergency_enabled) ? 1 : 0,
    emergency_phone: row?.emergency_phone ?? DEFAULT_BUSINESS_PROFILE.emergency_phone,
    service_area: row?.service_area || DEFAULT_BUSINESS_PROFILE.service_area,
    created_at_utc: row?.created_at_utc || null,
    updated_at_utc: row?.updated_at_utc || null,
  };
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

  // encrypt refresh token if present
  const enc = refresh_token ? encryptToken(refresh_token) : null;

  await run(
    db,
    `
    INSERT INTO google_tokens (
      business_id,
      access_token,
      refresh_token, -- legacy plaintext column (keep but NEVER insert plaintext)
      refresh_token_enc, refresh_token_iv, refresh_token_tag,
      scope, token_type, expiry_date_utc,
      created_at_utc, updated_at_utc
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(business_id) DO UPDATE SET
      access_token         = COALESCE(excluded.access_token, google_tokens.access_token),

      -- legacy plaintext handling:
      -- If we got a NEW encrypted refresh token, wipe plaintext. Otherwise keep whatever is there (but we won't use it).
      refresh_token = CASE
        WHEN excluded.refresh_token_enc IS NOT NULL THEN NULL
        ELSE google_tokens.refresh_token
      END,

      -- encrypted refresh token: only overwrite if provided
      refresh_token_enc    = COALESCE(excluded.refresh_token_enc, google_tokens.refresh_token_enc),
      refresh_token_iv     = COALESCE(excluded.refresh_token_iv,  google_tokens.refresh_token_iv),
      refresh_token_tag    = COALESCE(excluded.refresh_token_tag, google_tokens.refresh_token_tag),

      scope                = COALESCE(excluded.scope, google_tokens.scope),
      token_type           = COALESCE(excluded.token_type, google_tokens.token_type),
      expiry_date_utc      = COALESCE(excluded.expiry_date_utc, google_tokens.expiry_date_utc),
      updated_at_utc       = excluded.updated_at_utc
    `,
    [
      businessId,
      access_token,

      null, // ✅ NEVER store plaintext refresh_token

      enc?.enc || null,
      enc?.iv || null,
      enc?.tag || null,

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
  const row = await get(
    db,
    `
    SELECT
      business_id,
      access_token,
      refresh_token, -- legacy (может остаться на переходный период)
      refresh_token_enc,
      refresh_token_iv,
      refresh_token_tag,
      scope,
      token_type,
      expiry_date_utc,
      created_at_utc,
      updated_at_utc
    FROM google_tokens
    WHERE business_id = ?
    LIMIT 1
    `,
    [businessId]
  );

  if (!row) return null;

  const anyEncField =
    row.refresh_token_enc != null ||
    row.refresh_token_iv != null ||
    row.refresh_token_tag != null;

  if (anyEncField) {
    // if any exists, require all 3
    const encVal = typeof row.refresh_token_enc === "string" ? row.refresh_token_enc.trim() : "";
const ivVal  = typeof row.refresh_token_iv === "string" ? row.refresh_token_iv.trim() : "";
const tagVal = typeof row.refresh_token_tag === "string" ? row.refresh_token_tag.trim() : "";

if (!encVal || !ivVal || !tagVal) {
  throw new Error("Corrupt encrypted refresh token fields (enc/iv/tag mismatch)");
}

// use trimmed values to decrypt (optional but cleaner)
row.refresh_token_enc = encVal;
row.refresh_token_iv = ivVal;
row.refresh_token_tag = tagVal;
    try {
      row.refresh_token = decryptToken({
        enc: row.refresh_token_enc,
        iv: row.refresh_token_iv,
        tag: row.refresh_token_tag,
      });
    } catch (e) {
      throw new Error("Failed to decrypt refresh_token: " + String(e?.message || e));
    }
  } else {
    // legacy fallback (temporary). Your app should not rely on this long-term.
    row.refresh_token = null;
  }

  return row;
}
  
// cancel expired pending holds (housekeeping)
export async function cleanupExpiredPendingHolds(db) {
  const now = new Date().toISOString();

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

export async function cleanupExpiredHolds(db, businessId = null) {
  if (!businessId) return cleanupExpiredPendingHolds(db);

  const now = new Date().toISOString();
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
      AND COALESCE(overlap_start_utc, start_utc) < ?
      AND COALESCE(overlap_end_utc, end_utc) > ?
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
    overlap_start_utc = start_utc,
    overlap_end_utc = end_utc,
    hold_expires_at_utc,
    customer_name = null,
    customer_phone = null,
    customer_email = null,
    service_address = null,
    service_type = null,
    timezone = "UTC",
    job_summary = null,
    is_emergency = 0,
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
      overlap_start_utc, overlap_end_utc,
      status, hold_expires_at_utc,
      customer_name, customer_phone, customer_email,
      service_address, service_type,
      timezone,
      job_summary,
      is_emergency,
      gcal_event_id,
      created_at_utc, updated_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      id,
      business_id,
      start_utc,
      end_utc,
      overlap_start_utc,
      overlap_end_utc,
      hold_expires_at_utc,
      customer_name,
      customer_phone,
      customer_email,
      service_address,
      service_type,
      timezone,
      job_summary,
      is_emergency,
      null,
      now,
      now,
    ]
  );

  return true;
}

export async function createPendingHoldIfAvailableTx(db, payload) {
  const now = new Date().toISOString();
  const {
    id,
    business_id,
    start_utc,
    end_utc,
    overlap_start_utc = start_utc,
    overlap_end_utc = end_utc,
    hold_expires_at_utc,
    customer_name = null,
    customer_phone = null,
    customer_email = null,
    service_address = null,
    service_type = null,
    timezone = "UTC",
    job_summary = null,
    is_emergency = 0,
  } = payload;

  if (!id) throw new Error("createPendingHoldIfAvailableTx: missing id");
  if (!business_id) throw new Error("createPendingHoldIfAvailableTx: missing business_id");
  if (!start_utc || !end_utc) throw new Error("createPendingHoldIfAvailableTx: missing start/end");

  try {
    await run(db, "BEGIN IMMEDIATE");

    await run(
      db,
      `
      UPDATE bookings
      SET status = 'cancelled', hold_expires_at_utc = NULL, updated_at_utc = ?
      WHERE business_id = ?
        AND status = 'pending'
        AND hold_expires_at_utc IS NOT NULL
        AND hold_expires_at_utc <= ?
      `,
      [now, business_id, now]
    );

    const overlap = await get(
      db,
      `
      SELECT id
      FROM bookings
      WHERE business_id = ?
        AND (
          status = 'confirmed'
          OR (status = 'pending' AND (hold_expires_at_utc IS NULL OR hold_expires_at_utc > ?))
        )
        AND COALESCE(overlap_start_utc, start_utc) < ?
        AND COALESCE(overlap_end_utc, end_utc) > ?
      LIMIT 1
      `,
      [business_id, now, overlap_end_utc, overlap_start_utc]
    );

    if (overlap) {
      await run(db, "ROLLBACK");
      return { ok: false };
    }

    await run(
      db,
      `
      INSERT INTO bookings (
        id, business_id,
        start_utc, end_utc,
        overlap_start_utc, overlap_end_utc,
        status, hold_expires_at_utc,
        customer_name, customer_phone, customer_email,
        service_address, service_type,
        timezone,
        job_summary,
        is_emergency,
        gcal_event_id,
        created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        id,
        business_id,
        start_utc,
        end_utc,
        overlap_start_utc,
        overlap_end_utc,
        hold_expires_at_utc,
        customer_name,
        customer_phone,
        customer_email,
        service_address,
        service_type,
        timezone,
        job_summary,
        is_emergency,
        null,
        now,
        now,
      ]
    );

    await run(db, "COMMIT");
    return { ok: true };
  } catch (e) {
    try { await run(db, "ROLLBACK"); } catch {}
    throw e;
  }
}

export async function confirmBooking(db, bookingId, gcalEventId) {
  await updateBookingStatus(db, bookingId, "confirmed", {
    hold_expires_at_utc: null,
    gcal_event_id: gcalEventId || null,
    failure_reason: null,
  });
  return true;
}

export async function failBooking(db, bookingId, reason = null) {
  const summary = reason ? `FAILED: ${reason}` : "FAILED";
  await updateBookingStatus(db, bookingId, "failed", {
    hold_expires_at_utc: null,
    failure_reason: reason || null,
    job_summary: summary,
  });
  return true;
}

export async function cancelBooking(db, bookingId) {
  await updateBookingStatus(db, bookingId, "cancelled", {});
  return true;
}

export async function updateBookingStatus(db, bookingId, newStatus, fields = {}) {
  const booking = await getBookingById(db, bookingId);
  if (!booking) {
    const e = new Error(`Booking not found: ${bookingId}`);
    e.code = "BOOKING_NOT_FOUND";
    throw e;
  }

  const currentStatus = booking.status;
  const allowed = BOOKING_TRANSITIONS[currentStatus] || new Set();
  if (!allowed.has(newStatus)) {
    throw buildInvalidTransitionError(currentStatus, newStatus);
  }

  const now = new Date().toISOString();
  const setParts = ["status = ?", "updated_at_utc = ?"];
  const params = [newStatus, now];
  for (const [k, v] of Object.entries(fields)) {
    setParts.push(`${k} = ?`);
    params.push(v);
  }
  params.push(bookingId);

  await run(db, `UPDATE bookings SET ${setParts.join(", ")} WHERE id = ?`, params);
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

export async function logSmsAttempt(
  db,
  {
    businessId,
    bookingId = null,
    toNumber,
    fromNumber = process.env.TWILIO_FROM_NUMBER || null,
    messageBody = null,
    messageSid = null,
    type = "other",
    status,
    errorMessage = null,
  }
) {
  if (!businessId) throw new Error("logSmsAttempt: missing businessId");
  if (typeof toNumber !== "string") throw new Error("logSmsAttempt: missing toNumber");
  if (!status) throw new Error("logSmsAttempt: missing status");

  const now = new Date().toISOString();

  await run(
    db,
    `
    INSERT INTO sms_logs (
      business_id,
      booking_id,
      to_number,
      from_number,
      message_body,
      message_sid,
      type,
      status,
      error_message,
      created_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      businessId,
      bookingId,
      toNumber,
      fromNumber,
      messageBody,
      messageSid,
      type,
      status,
      errorMessage,
      now,
    ]
  );

  return true;
}

export async function logEmergencyAttempt(
  db,
  {
    businessId,
    bookingId = null,
    technicianPhone = "",
    escalationType,
    status,
    errorMessage = null,
  }
) {
  if (!businessId) throw new Error("logEmergencyAttempt: missing businessId");
  if (!escalationType) throw new Error("logEmergencyAttempt: missing escalationType");
  if (!status) throw new Error("logEmergencyAttempt: missing status");

  const now = new Date().toISOString();

  await run(
    db,
    `
    INSERT INTO emergency_logs (
      business_id,
      booking_id,
      technician_phone,
      escalation_type,
      status,
      error_message,
      created_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [businessId, bookingId, technicianPhone, escalationType, status, errorMessage, now]
  );

  return true;
}
// --- oauth flows (PKCE) ---

export async function createOAuthFlow(db, { nonce, business_id, code_verifier, expires_at_utc }) {
  const now = new Date().toISOString();

  if (!nonce) throw new Error("createOAuthFlow: missing nonce");
  if (!business_id) throw new Error("createOAuthFlow: missing business_id");
  if (!code_verifier) throw new Error("createOAuthFlow: missing code_verifier");
  if (!expires_at_utc) throw new Error("createOAuthFlow: missing expires_at_utc");

  await run(
    db,
    `
    INSERT INTO oauth_flows (nonce, business_id, code_verifier, created_at_utc, expires_at_utc)
    VALUES (?, ?, ?, ?, ?)
    `,
    [nonce, business_id, code_verifier, now, expires_at_utc]
  );

  return true;
}

// consume = получить и удалить (one-time)
export async function consumeOAuthFlow(db, nonce) {
  if (!nonce) throw new Error("consumeOAuthFlow: missing nonce");

  try {
    await run(db, "BEGIN IMMEDIATE");

    const row = await get(
      db,
      `
      SELECT nonce, business_id, code_verifier, created_at_utc, expires_at_utc
      FROM oauth_flows
      WHERE nonce = ?
      `,
      [nonce]
    );

    if (!row) {
      await run(db, "ROLLBACK");
      return null;
    }

    await run(db, `DELETE FROM oauth_flows WHERE nonce = ?`, [nonce]);

    await run(db, "COMMIT");
    return row;
  } catch (e) {
    try { await run(db, "ROLLBACK"); } catch {}
    throw e;
  }
}
// one-time migration: move legacy plaintext refresh_token -> encrypted fields
export async function migrateLegacyRefreshTokens(db) {
    if (!process.env.TOKENS_ENC_KEY || process.env.TOKENS_ENC_KEY.length !== 64) {
    throw new Error("migrateLegacyRefreshTokens: TOKENS_ENC_KEY missing/invalid");
  }
  const rows = await all(
    db,
    `
    SELECT business_id, refresh_token
    FROM google_tokens
    WHERE refresh_token IS NOT NULL
      AND TRIM(refresh_token) != ''
      AND (refresh_token_enc IS NULL OR TRIM(refresh_token_enc) = '')
    `
  );

  let migrated = 0;

  for (const r of rows) {
    const enc = encryptToken(r.refresh_token);

    await run(
      db,
      `
      UPDATE google_tokens
      SET refresh_token = NULL,
          refresh_token_enc = ?,
          refresh_token_iv = ?,
          refresh_token_tag = ?,
          updated_at_utc = ?
      WHERE business_id = ?
      `,
      [enc.enc, enc.iv, enc.tag, new Date().toISOString(), r.business_id]
    );

    migrated++;
  }

  return { ok: true, migrated };
}
export async function maybeMigrateLegacyTokens(db) {
  if (process.env.RUN_TOKEN_MIGRATION !== "1") return { ok: true, skipped: true };
  return migrateLegacyRefreshTokens(db);
}

export async function logCallEvent(
  db,
  {
    businessId,
    callSid = null,
    fromNumber = "",
    toNumber = "",
    direction = "inbound",
    status,
    durationSec = null,
    recordingUrl = null,
    metaJson = null,
  }
) {
  if (!businessId) throw new Error("logCallEvent: missing businessId");
  if (!status) throw new Error("logCallEvent: missing status");

  const now = new Date().toISOString();
  await run(
    db,
    `
    INSERT INTO call_logs (
      id, business_id, call_sid, from_number, to_number, direction, status,
      duration_sec, recording_url, meta_json, created_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      crypto.randomUUID(),
      businessId,
      callSid,
      fromNumber,
      toNumber,
      direction,
      status,
      durationSec,
      recordingUrl,
      metaJson,
      now,
    ]
  );

  return true;
}

export async function enqueueRetry(
  db,
  { businessId, bookingId = null, kind, payloadJson, maxAttempts = 5, nextAttemptAtUtc = null }
) {
  if (!businessId) throw new Error("enqueueRetry: missing businessId");
  if (!kind) throw new Error("enqueueRetry: missing kind");

  const now = new Date().toISOString();
  await run(
    db,
    `
    INSERT INTO retries (
      id, business_id, booking_id, kind, payload_json,
      attempt_count, max_attempts, next_attempt_at_utc, last_error,
      status, created_at_utc, updated_at_utc
    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, NULL, 'pending', ?, ?)
    `,
    [
      crypto.randomUUID(),
      businessId,
      bookingId,
      kind,
      typeof payloadJson === "string" ? payloadJson : JSON.stringify(payloadJson || {}),
      maxAttempts,
      nextAttemptAtUtc || now,
      now,
      now,
    ]
  );

  return true;
}

export async function listDueRetries(db, limit = 20) {
  const now = new Date().toISOString();
  return all(
    db,
    `
    SELECT * FROM retries
    WHERE status='pending' AND next_attempt_at_utc <= ?
    ORDER BY next_attempt_at_utc ASC, created_at_utc ASC
    LIMIT ?
    `,
    [now, limit]
  );
}

export async function markRetryAttempt(db, retryId, { attemptCount, nextAttemptAtUtc, status, lastError }) {
  const now = new Date().toISOString();
  await run(
    db,
    `
    UPDATE retries
    SET attempt_count = ?,
        next_attempt_at_utc = ?,
        status = ?,
        last_error = ?,
        updated_at_utc = ?
    WHERE id = ?
    `,
    [attemptCount, nextAttemptAtUtc, status, lastError || null, now, retryId]
  );
  return true;
}

export async function listRecentBookings(db, limit = 50) {
  return all(db, `SELECT * FROM bookings ORDER BY created_at_utc DESC LIMIT ?`, [limit]);
}

export async function listRecentCallLogs(db, limit = 50) {
  return all(db, `SELECT * FROM call_logs ORDER BY created_at_utc DESC LIMIT ?`, [limit]);
}

export async function listRecentSmsLogs(db, limit = 50) {
  return all(db, `SELECT * FROM sms_logs ORDER BY created_at_utc DESC LIMIT ?`, [limit]);
}

export async function listRecentRetries(db, { status = null, limit = 50 } = {}) {
  if (status) {
    return all(
      db,
      `SELECT * FROM retries WHERE status = ? ORDER BY created_at_utc DESC LIMIT ?`,
      [status, limit]
    );
  }
  return all(db, `SELECT * FROM retries ORDER BY created_at_utc DESC LIMIT ?`, [limit]);
}
