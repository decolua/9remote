// D1 transient-error retry. "overloaded"/"Network connection lost" are
// platform-side blips (observed: same query fails then passes seconds later)
// — retrying hides them from clients instead of failing the request.
const D1_RETRY_MAX_ATTEMPTS = 3;
const D1_RETRY_BASE_MS = 500;
const TRANSIENT_D1_MARKERS = ["overloaded", "Network connection lost"];

export function isTransientD1Error(e) {
  const msg = e?.message || String(e);
  return TRANSIENT_D1_MARKERS.some((marker) => msg.includes(marker));
}

export async function withD1Retry(fn, { maxAttempts = D1_RETRY_MAX_ATTEMPTS, baseMs = D1_RETRY_BASE_MS } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= maxAttempts || !isTransientD1Error(e)) throw e;
      await new Promise((resolve) => setTimeout(resolve, baseMs * 2 ** (attempt - 1)));
    }
  }
}
