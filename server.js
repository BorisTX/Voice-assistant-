import "dotenv/config";

import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import crypto from "crypto";
import { google } from "googleapis";
import { DateTime } from "luxon";
import { performance } from "node:perf_hooks";

import { verifyOAuthState } from "./src/security/state.js";
import { createApiSecurityMiddleware } from "./src/security/apiSecurity.js";
import { sanitizeDebugPayload } from "./src/security/pii.js";
import { normalizeBusyUtc, generateSlots } from "./src/slots.js";
import { openDb, runMigrations } from "./src/db/migrate.js";
import { makeDataLayer } from "./src/data/index.js";
import { createBookingFlow } from "./src/bookings/createBooking.js";
import { runRetriesOnce } from "./src/retries/runRetriesOnce.js";

import {
  makeOAuthClient,
  getAuthUrlForBusiness,
  loadTokensIntoClientForBusiness,
  exchangeCodeAndStoreForBusiness,
} from "./googleAuth.js";

// raw helpers only (debug + one-time token migration)
import {
  listTables,
  maybeMigrateLegacyTokens,
} from "./db.js";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use((req, res, next) => {
  console.log("INCOMING:", req.method, req.url);
  next();
});

const GOOGLE_API_TIMEOUT_MS_DEFAULT = 10000;

function nowMs() {
  return performance.now();
}

const GOOGLE_API_TIMEOUT_MS = (() => {
  const value = Number(process.env.GOOGLE_API_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : GOOGLE_API_TIMEOUT_MS_DEFAULT;
})();

function withTimeout(promise, ms, label) {
  const t0 = nowMs();
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`${label} timeout after ${ms}ms`);
        err.code = "GOOGLE_TIMEOUT";
        reject(err);
      }, ms);
    }),
  ])
    .then((result) => {
      const duration_ms = Math.round(nowMs() - t0);
      console.log(JSON.stringify({ op: label, ok: true, duration_ms }));
      return result;
    })
    .catch((error) => {
      const duration_ms = Math.round(nowMs() - t0);
      console.error(JSON.stringify({ op: label, ok: false, duration_ms, error: String(error?.message || error) }));
      throw error;
    })
    .finally(() => {
    if (timer) clearTimeout(timer);
  });
}

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseJsonInput(value) {
  if (typeof value === "string") {
    return JSON.parse(value);
  }
  return value;
}

function normalizeBusinessProfileForResponse(profile) {
  return {
    business_id: profile.business_id,
    timezone: profile.timezone,
    working_hours: profile.working_hours,
    slot_duration_min: Number(profile.slot_duration_min),
    buffer_min: Number(profile.buffer_min),
    emergency_enabled: Number(profile.emergency_enabled) ? 1 : 0,
    emergency_phone: profile.emergency_phone ?? null,
    service_area: profile.service_area,
    created_at_utc: profile.created_at_utc || null,
    updated_at_utc: profile.updated_at_utc || null,
  };
}

function validateWorkingHours(raw, details) {
  let parsed;
  try {
    parsed = parseJsonInput(raw);
  } catch {
    details.push("working_hours_json must be valid JSON");
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    details.push("working_hours_json must be an object");
    return null;
  }

  const keys = Object.keys(parsed);
  for (const key of keys) {
    if (!DAYS.includes(key)) {
      details.push(`working_hours_json has invalid day key: ${key}`);
    }
  }

  for (const day of DAYS) {
    const windows = parsed[day];
    if (windows == null) continue;
    if (!Array.isArray(windows)) {
      details.push(`working_hours_json.${day} must be an array`);
      continue;
    }

    windows.forEach((w, i) => {
      if (!w || typeof w !== "object" || Array.isArray(w)) {
        details.push(`working_hours_json.${day}[${i}] must be an object`);
        return;
      }
      const start = String(w.start || "");
      const end = String(w.end || "");
      if (!HHMM_RE.test(start) || !HHMM_RE.test(end)) {
        details.push(`working_hours_json.${day}[${i}] start/end must be HH:MM 24h`);
        return;
      }
      if (start >= end) {
        details.push(`working_hours_json.${day}[${i}] requires start < end`);
      }
    });
  }

  return parsed;
}

function validateServiceArea(raw, details) {
  let parsed;
  try {
    parsed = parseJsonInput(raw);
  } catch {
    details.push("service_area_json must be valid JSON");
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    details.push("service_area_json must be an object");
    return null;
  }

  if (parsed.mode === "radius") {
    const lat = Number(parsed?.center?.lat);
    const lng = Number(parsed?.center?.lng);
    const miles = Number(parsed?.miles);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(miles) || miles <= 0) {
      details.push("service_area_json radius requires center.lat, center.lng, miles > 0");
      return null;
    }
    return parsed;
  }

  if (parsed.mode === "zip") {
    if (!Array.isArray(parsed.zips) || parsed.zips.length === 0) {
      details.push("service_area_json zip mode requires non-empty zips[]");
      return null;
    }
    return parsed;
  }

  details.push("service_area_json.mode must be 'radius' or 'zip'");
  return null;
}

function buildBusinessProfilePatch(body) {
  const details = [];
  const patch = {};

  if (Object.prototype.hasOwnProperty.call(body, "timezone")) {
    const timezone = String(body.timezone || "").trim();
    if (!timezone) details.push("timezone must be a non-empty string");
    else patch.timezone = timezone;
  }

  if (Object.prototype.hasOwnProperty.call(body, "working_hours_json") || Object.prototype.hasOwnProperty.call(body, "working_hours")) {
    const workingHours = validateWorkingHours(
      Object.prototype.hasOwnProperty.call(body, "working_hours") ? body.working_hours : body.working_hours_json,
      details
    );
    if (workingHours) patch.working_hours_json = JSON.stringify(workingHours);
  }

  if (Object.prototype.hasOwnProperty.call(body, "slot_duration_min")) {
    const slotDuration = Number(body.slot_duration_min);
    if (!Number.isInteger(slotDuration) || slotDuration < 15 || slotDuration > 240) {
      details.push("slot_duration_min must be an integer between 15 and 240");
    } else {
      patch.slot_duration_min = slotDuration;
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, "buffer_min")) {
    const bufferMin = Number(body.buffer_min);
    if (!Number.isInteger(bufferMin) || bufferMin < 0 || bufferMin > 120) {
      details.push("buffer_min must be an integer between 0 and 120");
    } else {
      patch.buffer_min = bufferMin;
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, "emergency_enabled")) {
    const emergencyEnabledRaw = body.emergency_enabled;
    const isBool = typeof emergencyEnabledRaw === "boolean";
    const isNumericFlag = emergencyEnabledRaw === 0 || emergencyEnabledRaw === 1 || emergencyEnabledRaw === "0" || emergencyEnabledRaw === "1";
    if (!isBool && !isNumericFlag) {
      details.push("emergency_enabled must be boolean or 0/1");
    } else {
      patch.emergency_enabled = emergencyEnabledRaw === true || emergencyEnabledRaw === 1 || emergencyEnabledRaw === "1" ? 1 : 0;
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, "emergency_phone")) {
    const emergencyPhone = body.emergency_phone == null ? null : String(body.emergency_phone).trim();
    if (emergencyPhone) {
      const digits = emergencyPhone.replace(/\D/g, "");
      if (digits.length < 7) {
        details.push("emergency_phone must contain at least 7 digits");
      }
    }
    patch.emergency_phone = emergencyPhone;
  }

  if (Object.prototype.hasOwnProperty.call(body, "service_area_json") || Object.prototype.hasOwnProperty.call(body, "service_area")) {
    const serviceArea = validateServiceArea(
      Object.prototype.hasOwnProperty.call(body, "service_area") ? body.service_area : body.service_area_json,
      details
    );
    if (serviceArea) patch.service_area_json = JSON.stringify(serviceArea);
  }

  return { patch, details };
}


// Health check
app.get("/", (req, res) => res.status(200).send("OK"));

app.use("/debug", (req, res, next) => {
  if (process.env.DEBUG_ROUTES !== "1") {
    return res.status(404).send("Not Found");
  }

  if (process.env.NODE_ENV === "production") {
    const configuredDebugKey = String(process.env.DEBUG_ADMIN_KEY || "").trim();
    const directDebugKey = String(req.header("x-debug-key") || "").trim();
    const authHeader = String(req.header("authorization") || "");
    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    const bearerDebugKey = bearerMatch ? String(bearerMatch[1] || "").trim() : "";
    const requestDebugKey = directDebugKey || bearerDebugKey;

    if (!configuredDebugKey || requestDebugKey !== configuredDebugKey) {
      return res.status(404).send("Not Found");
    }
  }

  const json = res.json.bind(res);
  res.json = (payload) => json(sanitizeDebugPayload(payload));
  return next();
});

// --------------------
// Debug: DB inspection
// --------------------
app.get("/debug/db", async (req, res) => {
  try {
    if (!db) return res.status(500).json({ ok: false, error: "DB not ready yet" });

    const tables = await listTables(db);
    res.json({ ok: true, tables });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/debug/businesses", async (req, res) => {
  try {
    if (!data) return res.status(500).json({ ok: false, error: "Data layer not ready" });

    const businesses = await data.listBusinesses();
    res.json({ ok: true, count: businesses.length, businesses });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * Creates a default business once (idempotent).
 * GET /debug/create-default-business
 */
app.get("/debug/create-default-business", async (req, res) => {
  try {
    if (!data) return res.status(500).json({ ok: false, error: "DB not ready yet" });

    const name = "Default HVAC (DFW)";

    const existing = await data.getBusinessByName(name);
    if (existing) {
      return res.json({ ok: true, created: false, businessId: existing.id, business: existing });
    }

    const businessId = crypto.randomUUID();

    const workingHours = {
      mon: [{ start: "08:00", end: "17:00" }],
      tue: [{ start: "08:00", end: "17:00" }],
      wed: [{ start: "08:00", end: "17:00" }],
      thu: [{ start: "08:00", end: "17:00" }],
      fri: [{ start: "08:00", end: "17:00" }],
      sat: [],
      sun: [],
    };

    const emergencyKeywords = ["no heat", "no cooling", "gas smell", "water leak", "flooding"];

    await data.insertBusiness({
      id: businessId,
      name,
      industry: "hvac",
      timezone: "America/Chicago",
      working_hours_json: JSON.stringify(workingHours),
      default_duration_min: 60,
      slot_granularity_min: 15,
      buffer_before_min: 0,
      buffer_after_min: 30,
      lead_time_min: 60,
      max_days_ahead: 7,
      max_daily_jobs: null,
      emergency_enabled: 1,
      emergency_keywords_json: JSON.stringify(emergencyKeywords),
    });

    res.json({ ok: true, created: true, businessId });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});


app.get("/debug/bookings", async (req, res) => {
  try {
    if (!data) return res.status(500).json({ ok: false, error: "Data layer not ready" });
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const rows = await data.listRecentBookings(limit);
    res.json({ ok: true, count: rows.length, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/debug/call-logs", async (req, res) => {
  try {
    if (!data) return res.status(500).json({ ok: false, error: "Data layer not ready" });
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const rows = await data.listRecentCallLogs(limit);
    res.json({ ok: true, count: rows.length, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/debug/sms-logs", async (req, res) => {
  try {
    if (!data) return res.status(500).json({ ok: false, error: "Data layer not ready" });
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const rows = await data.listRecentSmsLogs(limit);
    res.json({ ok: true, count: rows.length, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/debug/retries", async (req, res) => {
  try {
    if (!data) return res.status(500).json({ ok: false, error: "Data layer not ready" });
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const status = req.query.status ? String(req.query.status) : null;
    const rows = await data.listRecentRetries({ status, limit });
    res.json({ ok: true, count: rows.length, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// --------------------
// OAuth (Business-only)
// --------------------
app.get("/auth/google-business", async (req, res) => {
  try {
    if (!data) return res.status(500).send("Data layer not ready");

    const businessId = String(req.query.business_id || "");
    if (!businessId) return res.status(400).send("Missing business_id");

    const oauth2Client = makeOAuthClient();

    const url = await getAuthUrlForBusiness(
      data,
      oauth2Client,
      businessId
    );

    return res.redirect(url);
  } catch (e) {
    console.error("ERROR in /auth/google-business:", e);
    return res.status(500).send("OAuth error: " + String(e?.message || e));
  }
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    if (!data) return res.status(500).send("Data layer not ready");

    const code = String(req.query.code || "");
    const state = String(req.query.state || "");

    if (!code) return res.status(400).send("Missing code");
    if (!state) return res.status(400).send("Missing state");

    const verified = verifyOAuthState(state);
    if (!verified.ok) {
      return res.status(400).send("Invalid state: " + verified.error);
    }

    const businessId = String(verified.payload.businessId || "");
    if (!businessId) return res.status(400).send("Invalid state: missing businessId");

    const nonce = String(verified.payload.nonce || "");
    if (!nonce) return res.status(400).send("Invalid state: missing nonce");

    const flow = await data.consumeOAuthFlow(nonce);
    if (!flow) return res.status(400).send("OAuth flow expired or already used");

    if (flow.business_id !== businessId) {
      return res.status(400).send("OAuth flow business mismatch");
    }

    const oauth2Client = makeOAuthClient();

    await exchangeCodeAndStoreForBusiness(
      data,
      oauth2Client,
      code,
      businessId,
      flow.code_verifier
    );

    return res.send("Business Google Calendar connected ✅");
  } catch (e) {
    console.error("OAuth callback error:", e);
    return res.status(500).send("OAuth failed: " + String(e?.message || e));
  }
});

// --------------------
// Debug: tokens & calendar
// --------------------
app.get("/debug/tokens-business", async (req, res) => {
  try {
    if (!data) return res.status(500).json({ ok: false, error: "Data layer not ready" });

    const businessId = String(req.query.business_id || "");
    if (!businessId) return res.status(400).json({ ok: false, error: "Missing business_id" });

    const row = await data.getGoogleTokens(businessId);

    res.json({
      ok: true,
      businessId,
      hasAccessToken: !!row?.access_token,
      hasRefreshToken: !!row?.refresh_token,
      scope: row?.scope,
      expiry_date_utc: row?.expiry_date_utc,
      updated_at_utc: row?.updated_at_utc,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/debug/calendar-business", async (req, res) => {
  try {
    if (!data) return res.status(500).json({ ok: false, error: "Data layer not ready" });

    const businessId = String(req.query.business_id || "");
    if (!businessId) return res.status(400).json({ ok: false, error: "Missing business_id" });

    const oauth2Client = makeOAuthClient();
    await loadTokensIntoClientForBusiness(data, oauth2Client, businessId);

    const calendar = google.calendar({ version: "v3", auth: oauth2Client });
    const now = new Date().toISOString();

    const result = await calendar.events.list({
      calendarId: "primary",
      timeMin: now,
      maxResults: 10,
      singleEvents: true,
      orderBy: "startTime",
    });

    res.json({
      ok: true,
      businessId,
      items: (result.data.items || []).map((e) => ({
        summary: e.summary,
        start: e.start?.dateTime || e.start?.date,
        end: e.end?.dateTime || e.end?.date,
      })),
    });
  } catch (e) {
    console.error("DEBUG calendar-business error:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// --------------------
// Business profile API
// --------------------
app.use("/api", createApiSecurityMiddleware());

app.get("/api/businesses/:businessId/profile", async (req, res) => {
  try {
    if (!data) return res.status(500).json({ ok: false, error: "Data layer not ready" });

    const businessId = String(req.params.businessId || "");
    const business = await data.getBusinessById(businessId);
    if (!business) return res.status(404).json({ error: "Business not found", details: [] });

    const profile = await data.getEffectiveBusinessProfile(businessId);
    return res.status(200).json({ ok: true, profile: normalizeBusinessProfileForResponse(profile) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Internal error" });
  }
});

app.put("/api/businesses/:businessId/profile", async (req, res) => {
  try {
    if (!data) return res.status(500).json({ ok: false, error: "Data layer not ready" });

    const businessId = String(req.params.businessId || "");
    const business = await data.getBusinessById(businessId);
    if (!business) return res.status(404).json({ error: "Business not found", details: [] });

    const { patch, details } = buildBusinessProfilePatch(req.body || {});
    if (details.length > 0) {
      return res.status(400).json({ error: "Validation failed", details });
    }

    if (Object.keys(patch).length > 0) {
      await data.updateBusinessProfile(businessId, patch);
    }
    const profile = await data.getEffectiveBusinessProfile(businessId);
    return res.status(200).json({ ok: true, profile: normalizeBusinessProfileForResponse(profile) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Internal error" });
  }
});

// --------------------
// Slots API
// --------------------
app.get("/api/available-slots", async (req, res) => {
  try {
    if (!data) return res.status(500).json({ ok: false, error: "Data layer not ready" });

    const businessId = String(req.query.business_id || "");
    if (!businessId) return res.status(400).json({ ok: false, error: "Missing business_id" });

    const business = await data.getBusinessById(businessId);
    if (!business) return res.status(404).json({ ok: false, error: "Business not found" });

    const profile = await data.getEffectiveBusinessProfile(businessId);
    const tz = profile.timezone || business.timezone || "America/Chicago";

    const durationMin = req.query.duration_min
      ? Number(req.query.duration_min)
      : Number(profile.slot_duration_min || business.default_duration_min || 60);

    const dur = Number(durationMin);
    if (!Number.isFinite(dur) || dur <= 0 || dur > 8 * 60) {
      return res.status(400).json({ ok: false, error: "Bad duration_min" });
    }

    const daysReq = req.query.days ? Number(req.query.days) : Number(business.max_days_ahead || 7);
    const days = Math.max(1, Math.min(daysReq, Number(business.max_days_ahead || 7)));

    const fromStr = String(req.query.from || "");
    const windowStartZ = fromStr
      ? DateTime.fromISO(fromStr, { zone: tz }).startOf("day")
      : DateTime.now().setZone(tz).startOf("day");

    if (!windowStartZ.isValid) {
      return res.status(400).json({ ok: false, error: "Bad from date (use YYYY-MM-DD)" });
    }

    const windowEndZ = windowStartZ.plus({ days });
    const timeMinUtc = windowStartZ.toUTC().toISO();
    const timeMaxUtc = windowEndZ.toUTC().toISO();

    // Google freebusy
    const oauth2Client = makeOAuthClient();
    await loadTokensIntoClientForBusiness(data, oauth2Client, businessId);

    const calendar = google.calendar({ version: "v3", auth: oauth2Client });
    const fb = await withTimeout(
      calendar.freebusy.query({
        requestBody: {
          timeMin: timeMinUtc,
          timeMax: timeMaxUtc,
          timeZone: "UTC",
          items: [{ id: "primary" }],
        },
      }),
      GOOGLE_API_TIMEOUT_MS,
      "google.freebusy.query"
    );

    const busy = fb?.data?.calendars?.primary?.busy || [];
    const profileBuffer = Number(profile.buffer_min);
    const bufferBefore = Number.isFinite(profileBuffer)
      ? profileBuffer
      : Number(business.buffer_before_min || business.buffer_min || business.buffer_minutes || 0);
    const bufferAfter = Number.isFinite(profileBuffer)
      ? profileBuffer
      : Number(business.buffer_after_min || business.buffer_min || business.buffer_minutes || 0);

    const busyMergedUtc = normalizeBusyUtc(busy, bufferBefore, bufferAfter);

    const slotsBusiness = {
      ...business,
      timezone: tz,
      working_hours_json: JSON.stringify(profile.working_hours),
      default_duration_min: Number(profile.slot_duration_min || business.default_duration_min || 60),
      buffer_before_min: bufferBefore,
      buffer_after_min: bufferAfter,
    };

    const slots = generateSlots({
      business: slotsBusiness,
      windowStartDate: windowStartZ,
      days,
      durationMin: dur,
      busyMergedUtc,
    });

    return res.json({
      ok: true,
      businessId,
      timezone: tz,
      from_local: windowStartZ.toISODate(),
      days,
      durationMin: dur,
      count: slots.length,
      slots,
    });
  } catch (e) {
    console.error("available-slots error:", e);
    return res.status(500).json({ ok: false, error: "Internal error" });
  }
});

app.post("/api/bookings", async (req, res) => {
  const result = await createBookingFlow({
    data,
    body: req.body || {},
    makeOAuthClient,
    loadTokensIntoClientForBusiness,
    google,
    googleApiTimeoutMs: GOOGLE_API_TIMEOUT_MS,
    withTimeout,
  });

  return res.status(result.status).json(result.body);
});

app.post("/api/book", async (req, res) => {
  const t0 = nowMs();
  const route = "/api/book";
  const businessId = req.body?.businessId ?? req.body?.business_id ?? null;

  try {
    const result = await createBookingFlow({
      data,
      body: req.body || {},
      makeOAuthClient,
      loadTokensIntoClientForBusiness,
      google,
      googleApiTimeoutMs: GOOGLE_API_TIMEOUT_MS,
      withTimeout,
    });

    const duration_ms = Math.round(nowMs() - t0);
    const status_code = result.status;
    const bookingId = result.body?.bookingId || null;
    console.log(JSON.stringify({ level: "info", route, status_code, duration_ms, businessId, bookingId }));
    return res.status(result.status).json(result.body);
  } catch (error) {
    const duration_ms = Math.round(nowMs() - t0);
    console.error(JSON.stringify({
      level: "error",
      route,
      status_code: 500,
      duration_ms,
      businessId,
      bookingId: null,
      error: String(error?.message || error),
    }));
    return res.status(500).json({ ok: false, error: "Internal error" });
  }
});

// --------------------
// Twilio voice webhook
// --------------------
app.get("/voice", (req, res) => {
  console.log("GET /voice browser test");
  res.status(200).send("VOICE OK (GET)");
});

app.post("/voice", async (req, res) => {
  console.log("POST /voice from Twilio");

  try {
    if (data) {
      const callStatus = String(req.body?.CallStatus || "started").toLowerCase();
      let normalizedStatus = "started";
      if (["completed"].includes(callStatus)) normalizedStatus = "completed";
      if (["failed", "busy", "no-answer", "canceled"].includes(callStatus)) normalizedStatus = "failed";

      const businessId = String(req.body?.business_id || process.env.DEFAULT_BUSINESS_ID || "");
      if (businessId) await data.logCallEvent({
        businessId,
        callSid: req.body?.CallSid || null,
        fromNumber: req.body?.From || "",
        toNumber: req.body?.To || "",
        direction: req.body?.Direction || "inbound",
        status: normalizedStatus,
        durationSec: req.body?.CallDuration ? Number(req.body.CallDuration) : null,
        recordingUrl: req.body?.RecordingUrl || null,
        metaJson: JSON.stringify(req.body || {}),
      });
    }
  } catch (e) {
    console.error("call log error", e);
  }

  const host = req.headers["x-forwarded-host"] || req.headers.host;

  const twiml = `
<Response>
  <Say>Thanks for calling. Please hold for a moment.</Say>
  <Connect>
    <Stream url="wss://${host}/media" />
  </Connect>
</Response>
  `.trim();

  res.type("text/xml").send(twiml);
});

app.use((req, res) => {
  console.log("404:", req.method, req.url);
  res.status(404).send("Not Found");
});

// --------------------
// HTTP + WebSocket server
// --------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media" });

wss.on("connection", (twilioWs) => {
  console.log("Twilio connected");
  let streamSid = null;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("OPENAI_API_KEY is missing in environment variables!");
    try { twilioWs.close(); } catch {}
    return;
  }

  const openaiWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-realtime", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  openaiWs.on("open", () => {
    console.log("Connected to OpenAI");

    openaiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        type: "realtime",
        audio: {
          input: { format: "g711_ulaw" },
          output: { format: "g711_ulaw", voice: "alloy" },
        },
        instructions:
          "You are a friendly HVAC assistant in Dallas-Fort Worth. " +
          "Ask briefly for name, phone, address, issue, and preferred time.",
      },
    }));

    openaiWs.send(JSON.stringify({
      type: "response.create",
      response: {
        instructions:
          "Say: Hi! This is the HVAC assistant. Is this an emergency or would you like to schedule service?",
      },
    }));
  });

  openaiWs.on("close", (code, reason) => {
    console.log("OpenAI disconnected", { code, reason: reason?.toString() });
  });

  openaiWs.on("error", (err) => {
    console.error("OpenAI WS error:", err);
  });

  twilioWs.on("message", (message) => {
    let msg;
    try { msg = JSON.parse(message.toString()); } catch { return; }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid;
      console.log("Stream started. streamSid =", streamSid);
      return;
    }

    if (msg.event === "media" && msg.media?.payload) {
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: msg.media.payload,
        }));
      }
      return;
    }

    if (msg.event === "stop") {
      console.log("Stream stopped");
      try { openaiWs.close(); } catch {}
      return;
    }
  });

  openaiWs.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === "response.output_audio.delta" && msg.delta) {
      if (!streamSid) return;
      twilioWs.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: msg.delta },
      }));
    }
  });

  twilioWs.on("close", () => {
    console.log("Twilio disconnected");
    try { openaiWs.close(); } catch {}
  });
});

// --------------------
// Startup
// --------------------
const PORT = process.env.PORT || 10000;

let db;    // raw connection
let data;  // data layer

async function start() {
  console.log("Starting server...");

  // init sqlite + migrations
  db = await openDb();
  await runMigrations(db);

  // init data layer (sqlite now, later postgres)
  const dl = makeDataLayer({ db });
  data = dl.data;

  console.log("DB_DIALECT =", dl.dialect);
  console.log("✅ Data layer ready");
  console.log("✅ Migrations completed");

  // ✅ ONE-TIME migration for legacy plaintext refresh_token -> encrypted fields
  // controlled by RUN_TOKEN_MIGRATION=1
  if (process.env.RUN_TOKEN_MIGRATION === "1") {
    const migRes = await maybeMigrateLegacyTokens(db);
    console.log("Legacy token migration executed");
    console.log("Token migration result:", migRes);
  } else {
    console.log("Legacy token migration skipped");
  }


  if (process.env.RUN_RETRY_WORKER === "1") {
    setInterval(() => {
      runRetriesOnce({ data, limit: 20 }).catch((e) => {
        console.error("retry worker tick failed", e);
      });
    }, 15_000);
    console.log("Retry worker enabled");
  } else {
    console.log("Retry worker disabled");
  }

  server.listen(PORT, () => {
    console.log("Voice assistant is running 🚀 on port", PORT);
  });
}

start().catch((err) => {
  console.error("❌ Startup failed:", err);
  process.exit(1);
});
