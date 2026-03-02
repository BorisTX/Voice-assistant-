function normalizeIp(value) {
  const raw = value == null ? "" : String(value).trim();
  if (!raw) return "";
  if (raw.startsWith("::ffff:")) return raw.slice(7);
  return raw;
}

export function getClientIp(req) {
  const isProd = process.env.NODE_ENV === "production";

  // In production, rely strictly on Express trusted proxy resolution.
  if (isProd) {
    return normalizeIp(req.ip) || "unknown";
  }

  // In development, prefer Express-derived proxy chain if present.
  if (Array.isArray(req.ips) && req.ips.length > 0) {
    return normalizeIp(req.ips[0]) || "unknown";
  }

  // Fallback for local environments.
  const sockIp = req.socket?.remoteAddress || req.connection?.remoteAddress;
  return normalizeIp(sockIp) || "unknown";
}
