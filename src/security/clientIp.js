function normalizeIp(value) {
  const raw = value == null ? "" : String(value).trim();
  if (!raw) return "";
  if (raw.startsWith("::ffff:")) {
    return raw.slice(7);
  }
  return raw;
}

function parseForwardedFor(req) {
  const header = req.headers?.["x-forwarded-for"];
  if (!header) return [];
  const raw = Array.isArray(header) ? header.join(",") : String(header);
  return raw
    .split(",")
    .map((part) => normalizeIp(part))
    .filter(Boolean);
}

function hasSaneProxyChain(req) {
  const forwarded = parseForwardedFor(req);
  if (forwarded.length === 0) return true;
  if (forwarded.length > 10) return false;

  const trustedIps = Array.isArray(req.ips)
    ? req.ips.map((entry) => normalizeIp(entry)).filter(Boolean)
    : [];

  if (trustedIps.length === 0) return false;
  return trustedIps[0] === forwarded[0];
}

export function getClientIp(req) {
  const isProduction = process.env.NODE_ENV === "production";
  let ip = "";

  if (!isProduction || hasSaneProxyChain(req)) {
    ip = normalizeIp(req.ip);
  }

  if (!ip) {
    ip = normalizeIp(req.socket?.remoteAddress || req.connection?.remoteAddress);
  }

  return ip || "unknown";
}
