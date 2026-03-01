const NAME_KEYS = new Set([
  "customer_name",
  "caller_name",
  "client_name",
  "first_name",
  "last_name",
  "contact_name",
]);

const TEXT_KEYS = new Set(["notes", "description", "transcript"]);

function maskPhone(value) {
  const input = String(value ?? "");
  const digits = input.replace(/\D/g, "");
  if (!digits) return "";
  const visible = digits.slice(-2);
  const hidden = "*".repeat(Math.max(0, digits.length - 2));
  return `${hidden}${visible}`;
}

function maskEmail(value) {
  const input = String(value ?? "").trim();
  if (!input) return "";
  const atIdx = input.indexOf("@");
  if (atIdx <= 0) return "a***";
  const localFirst = input[0];
  const domain = input.slice(atIdx + 1) || "redacted.local";
  return `${localFirst}***@${domain}`;
}

function sanitizeValueByKey(key, value) {
  const keyLower = key.toLowerCase();
  if (keyLower.includes("phone")) return maskPhone(value);
  if (keyLower.includes("email")) return maskEmail(value);
  if (keyLower.includes("address")) return "[REDACTED_ADDRESS]";
  if (NAME_KEYS.has(keyLower)) return "[REDACTED_NAME]";
  if (TEXT_KEYS.has(keyLower)) return "[REDACTED_TEXT]";
  return null;
}

export function sanitizeDebugPayload(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDebugPayload(item));
  }

  if (value && typeof value === "object") {
    const out = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      const replacement = sanitizeValueByKey(key, nestedValue);
      if (replacement !== null) {
        out[key] = replacement;
      } else {
        out[key] = sanitizeDebugPayload(nestedValue);
      }
    }
    return out;
  }

  return value;
}
