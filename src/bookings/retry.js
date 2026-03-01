function getErrorStatus(error) {
  return Number(error?.code) || Number(error?.response?.status) || Number(error?.status) || null;
}

function getErrorCode(error) {
  return String(error?.code || error?.errno || "").toUpperCase();
}

export function isRetryableGoogleError(error) {
  const code = getErrorCode(error);
  const status = getErrorStatus(error);

  if (code === "GOOGLE_TIMEOUT") return true;
  if (status === 429) return true;
  if (status >= 500) return true;
  if (["ECONNRESET", "ETIMEDOUT", "ENOTFOUND"].includes(code)) return true;
  if (status >= 400 && status < 500) return false;
  return false;
}

export function getRetryErrorDetails(error) {
  return {
    code: getErrorCode(error) || null,
    status: getErrorStatus(error),
    message: String(error?.message || "Unknown error"),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retry(fn, {
  label,
  maxAttempts = 3,
  baseDelayMs = 250,
  maxDelayMs = 1500,
  retryOn = isRetryableGoogleError,
  requestId = null,
  maxElapsedMs = 10000,
} = {}) {
  const started = Date.now();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      const retryable = retryOn(error);
      if (!retryable || attempt >= maxAttempts) throw error;

      const expoDelay = Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)));
      const jitter = Math.floor(Math.random() * (baseDelayMs + 1));
      const delayMs = expoDelay + jitter;
      const elapsedMs = Date.now() - started;
      if (elapsedMs + delayMs > maxElapsedMs) throw error;

      const details = getRetryErrorDetails(error);
      console.warn(JSON.stringify({
        level: "warn",
        type: "retry",
        requestId,
        label,
        attempt,
        ...details,
        delayMs,
      }));
      await sleep(delayMs);
    }
  }

  throw new Error(`retry() failed unexpectedly: ${label || "unknown"}`);
}

