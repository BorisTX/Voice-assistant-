const warnedMissingApiKey = { value: false };

function getClientIp(req) {
  return req.ip || req.headers["x-forwarded-for"] || "unknown";
}

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
      return current.count <= limit;
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

export function createApiSecurityMiddleware() {
  const limiter = createWindowLimiter();

  return function apiSecurityMiddleware(req, res, next) {
    const clientIp = getClientIp(req);
    const configuredApiKey = String(process.env.API_KEY || "").trim();
    const requestApiKey = getRequestKey(req, "x-api-key");

    if (!configuredApiKey) {
      if (process.env.NODE_ENV === "production") {
        return res.status(500).json({ ok: false, error: "API_KEY not configured" });
      }
      if (!warnedMissingApiKey.value) {
        warnedMissingApiKey.value = true;
        console.warn("API_KEY is not configured; allowing /api/* access in non-production mode");
      }
      return next();
    }

    if (!requestApiKey || requestApiKey !== configuredApiKey) {
      const bruteForceAllowed = limiter.hit(`auth-fail:${clientIp}`, 30);
      if (!bruteForceAllowed) {
        console.warn("auth_bruteforce_rate_limited", { ip: clientIp });
      }
      return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    }

    let allowed = true;
    if (req.path === "/available-slots") {
      allowed = limiter.hit(`api-slots:${clientIp}`, 60);
    } else if (isBookingPath(req.path)) {
      allowed = limiter.hit(`api-booking-ip:${clientIp}`, 20);
      const businessId = getBusinessIdForRateLimit(req);
      if (allowed && businessId) {
        allowed = limiter.hit(`api-booking-business:${clientIp}:${businessId}`, 10);
      }
    } else {
      allowed = limiter.hit(`api-general:${clientIp}`, 120);
    }

    if (!allowed) {
      return res.status(429).json({ ok: false, error: "RATE_LIMITED" });
    }

    return next();
  };
}
