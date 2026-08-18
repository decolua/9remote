// D1 transient-error retry. "overloaded"/"Network connection lost" are
// platform-side blips (observed: same query fails then passes seconds later)
// — retrying hides them from clients instead of failing the request.
const D1_RETRY_MAX_ATTEMPTS = 3;
const D1_RETRY_BASE_MS = 500;
const TRANSIENT_D1_MARKERS = ["overloaded", "Network connection lost"];
const READ_SESSION_MODE = "first-unconstrained";
// Bound the cache so a key-enumeration flood cannot grow it without limit.
const MEMO_MAX_ENTRIES = 5000;

// Cache keys — one namespace prefix per lookup so invalidation stays surgical.
// The signaling gate is NOT here: it caches inside SignalingDO.js, which is inlined
// into the worker bundle and shares no module state with this file.
export const cacheKeys = {
  tunnel: (apiKey) => `tunnel:${apiKey}`,
};

// Short by design: invalidateCache only clears the calling isolate, so the TTL is
// the real ceiling on how long another isolate can serve a stale value. Even 10s
// collapses a reconnect storm (10+ reads/s) down to one D1 query per isolate.
export const CACHE_TTL = {
  tunnelSec: 10,
};

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

// Read-replica handle for read-only routes. "first-unconstrained" serves from the
// nearest replica without waiting for the primary's bookmark — the primary then
// only carries writes. Falls back to the plain binding on older runtimes.
export function readDb(env) {
  return typeof env.DB.withSession === "function"
    ? env.DB.withSession(READ_SESSION_MODE)
    : env.DB;
}

// Per-isolate read-through cache for hot D1 lookups. Deliberately NOT Workers KV:
// KV propagates writes (including deletes) across colos in up to 60s and is slowest
// in exactly the locations reading a key most, so an invalidated tunnelUrl could
// outlive its invalidation. An isolate-local map is stale for at most the TTL, has
// no cross-colo lag, and no per-key write limit.
//
// Only positive results are cached — a miss must always reach D1, so a row created
// moments ago is never masked by a cached "not found".
const memo = new Map();

function memoPrune(now) {
  for (const [key, entry] of memo) {
    if (entry.expires <= now) memo.delete(key);
  }

  // Still oversized after dropping expired entries — evict oldest-inserted first.
  if (memo.size > MEMO_MAX_ENTRIES) {
    const excess = memo.size - MEMO_MAX_ENTRIES;
    let i = 0;
    for (const key of memo.keys()) {
      if (i++ >= excess) break;
      memo.delete(key);
    }
  }
}

export async function cachedLookup(key, ttlSec, loader) {
  const now = Date.now();
  const hit = memo.get(key);
  if (hit && hit.expires > now) return hit.value;

  // Only the resolved value is stored, never the in-flight promise. Sharing a
  // promise across requests would dedupe concurrent misses, but a D1 promise
  // carries request-scoped I/O and reusing it throws "Cannot perform I/O on
  // behalf of a different request" — and only once traffic is high enough for
  // two requests to land in one isolate, i.e. exactly under the load this cache
  // exists to absorb. Plain data has no such binding, so a burst of simultaneous
  // misses may each hit D1 once; every request after the first fill is served
  // from memory for the whole TTL.
  const value = await loader();
  if (value !== null && value !== undefined) {
    if (memo.size >= MEMO_MAX_ENTRIES) memoPrune(now);
    memo.set(key, { value, expires: Date.now() + ttlSec * 1000 });
  }
  return value;
}

// Clears this isolate only. Other isolates still expire on their own TTL, which
// is the ceiling on staleness — keep TTLs short enough that the ceiling is safe.
export function invalidateCache(key) {
  memo.delete(key);
}
