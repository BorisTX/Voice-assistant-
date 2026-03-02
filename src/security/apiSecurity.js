import crypto from "node:crypto";

import { getClientIp } from "./clientIp.js";

const warnedMissingApiKey = { value: false };

function getBearerToken(value) {
  if (!value) return "";
  const raw = String(value);
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function getRequestKey(req, headerName) {
  const direct = req.header(headerName);
  if (direct) return String(direct).trim();
  return getBearerToken(req.header("authorization"));
}

function createWindowLimiter({ windowMs = 60_000, cleanupAfterMs = 5 * 60_000 } = {}) {
  const entries = new Map();
  let hitCounter = 0;

  function cleanup(now) {
    for (const [key, entry] of entries.entries()) {
      if (now - entry.windowStartMs >= cleanupAfterMs) {
        entries.delete(key);
      }
    }
  }

  return {
    hit(key, limit, now = Date.now()) {
      const existing = entries.get(key);
      if (!existing || now - existing.windowStartMs >= windowMs) {
        entries.set(key, { windowStartMs: now, count: 1 });
      } else {
        existing.count += 1;
      }

      hitCounter += 1;
      if (hitCounter % 200 === 0) cleanup(now);

      const current = entries.get(key);
      const remaining = Math.max(0, limit - current.count);
      return {
        allowed: current.count <= limit,
        remaining,
        limit,
      };
    },
  };
}

function isBookingPath(path) {
  return path === "/book" || path === "/bookings";
}

function getBusinessIdForRateLimit(req) {
  const bodyId = req.body?.businessId ?? req.body?.business_id;
  const queryId = req.query?.businessId ?? req.query?.business_id;
  const value = bodyId ?? queryId;
  if (value == null) return "";
  return String(value).trim();
}

function apiKeysEqual(requestApiKey, configuredApiKey) {
  const requestBuffer = Buffer.from(String(requestApiKey || ""));
  const configuredBuffer = Buffer.from(String(configuredApiKey || ""));
  if (requestBuffer.length !== configuredBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(requestBuffer, configuredBuffer);
}

function getRouteLimit(path) {
  if (path === "/available-slots") return 60;
  if (isBookingPath(path)) return 20;
  return 120;
}

function setRateLimitHeaders(res, limit, remaining) {
  res.setHeader("X-RateLimit-Limit", String(limit));
  res.setHeader("X-RateLimit-Remaining", String(remaining));
}

export function createApiSecurityMiddleware() {
  const limiter = createWindowLimiter();

  return function apiSecurityMiddleware(req, res, next) {
    const clientIp = getClientIp(req);
    const businessId = getBusinessIdForRateLimit(req);
    const configuredApiKey = String(process.env.API_KEY || "").trim();
    const requestApiKey = getRequestKey(req, "x-api-key");
    const routeLimit = getRouteLimit(req.path);

    if (!configuredApiKey) {
      setRateLimitHeaders(res, routeLimit, routeLimit);
      if (process.env.NODE_ENV === "production") {
        return res.status(500).json({ ok: false, error: "API_KEY not configured" });
      }
      if (!warnedMissingApiKey.value) {
        warnedMissingApiKey.value = true;
        console.warn("API_KEY is not configured; allowing /api/* access in non-production mode");
      }
      return next();
    }

    if (!requestApiKey || !apiKeysEqual(requestApiKey, configuredApiKey)) {
      const bruteForceResult = limiter.hit(`auth-fail:${clientIp}`, 30);
      setRateLimitHeaders(res, bruteForceResult.limit, bruteForceResult.remaining);
      if (!bruteForceResult.allowed) {
        console.warn("auth_bruteforce_rate_limited", {
          event: "auth_bruteforce_rate_limited",
          ip: clientIp,
          ...(businessId ? { businessId } : {}),
          path: req.path,
        });
        res.setHeader("Retry-After", "60");
        return res.status(429).json({ ok: false, error: "RATE_LIMITED" });
      }
      return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    }

    let finalResult;
    let allowed = true;

    if (req.path === "/available-slots") {
      finalResult = limiter.hit(`api-slots:${clientIp}`, 60);
      allowed = finalResult.allowed;
    } else if (isBookingPath(req.path)) {
      const ipResult = limiter.hit(`api-booking-ip:${clientIp}`, 20);
      finalResult = ipResult;
      allowed = ipResult.allowed;
      if (allowed && businessId) {
        const businessResult = limiter.hit(`api-booking-business:${clientIp}:${businessId}`, 10);
        finalResult = {
          allowed: businessResult.allowed,
          remaining: Math.min(ipResult.remaining, businessResult.remaining),
          limit: Math.min(ipResult.limit, businessResult.limit),
        };
        allowed = businessResult.allowed;
      }
    } else {
      finalResult = limiter.hit(`api-general:${clientIp}`, 120);
      allowed = finalResult.allowed;
    }

    setRateLimitHeaders(res, finalResult.limit, finalResult.remaining);

    if (!allowed) {
      console.warn("rate_limited", {
        ip: clientIp,
        businessId,
        path: req.path,
      });
      return res.status(429).json({ ok: false, error: "RATE_LIMITED" });
    }

    return next();
  };
}
