// Best-effort local cache of the AI pane's replay tail — pure decisions only.
//
// The cache is NEVER authoritative: the host's hydrate ack always replaces what it
// paints. Everything here must therefore be cheap to validate and safe to drop on
// any mismatch (schema, host, session, age, seq alignment). The actual IndexedDB
// access lives in aiCacheStore.js; this file pins the law without a DOM.

// One schema for the stored envelope; bump when the entry shape changes.
export const AI_CACHE_SCHEMA = 1;
// Mirrors the host's replay window: a tail, never the whole log.
export const AI_CACHE_MAX_BYTES = 32 * 1024;
// A tail older than a day is noise — it only pre-paints until the host hydrate lands.
export const AI_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Hard bounds: the store may never grow past these, whatever the usage pattern.
export const AI_CACHE_MAX_ENTRIES = 30;
export const AI_CACHE_TOTAL_BYTES = 1024 * 1024;

/** Stable key: sessions are host-scoped, so the same id on another host never collides. */
export function cacheKey(hostKey, sessionId) {
  return `${hostKey || "local"}:${sessionId}`;
}

/** Approximate wire size of one replay event (the reducer reads event + data). */
export function eventBytes(e) {
  let n = 16;
  if (typeof e?.event === "string") n += e.event.length;
  if (e?.data != null) {
    try { n += JSON.stringify(e.data).length; } catch { n += 256; }
  }
  return n;
}

const tailBytes = (events) => events.reduce((n, e) => n + eventBytes(e), 0);

/** Keep the newest suffix that fits; never split an event. */
export function trimTail(events, maxBytes = AI_CACHE_MAX_BYTES) {
  const kept = [];
  let bytes = 0;
  for (let i = (events?.length || 0) - 1; i >= 0; i--) {
    const size = eventBytes(events[i]);
    if (bytes + size > maxBytes) break;
    kept.unshift(events[i]);
    bytes += size;
  }
  return {
    events: kept,
    bytes,
    firstSeq: kept[0]?.seq ?? 0,
    hasMore: kept.length < (events?.length || 0)
  };
}

/** Append one live event and drop from the head to stay under the cap.
 *  Uses the tail's own byte count when present — recomputing it per token would
 *  stringify the whole tail on every delta. */
export function appendTail(tail, event, maxBytes = AI_CACHE_MAX_BYTES) {
  const events = [...(tail?.events || []), event];
  let bytes = Number.isFinite(tail?.bytes) ? tail.bytes + eventBytes(event) : tailBytes(events);
  let dropped = false;
  while (events.length && bytes > maxBytes) {
    bytes -= eventBytes(events[0]);
    events.shift();
    dropped = true;
  }
  return { events, bytes, dropped };
}

/** Build the stored envelope; null when there is nothing worth caching. */
export function buildCacheEntry({
  hostKey, sessionId, epoch, tail, taskRecords = null, lastTurnMs = 0, now = Date.now()
}) {
  if (!sessionId || typeof sessionId !== "string") return null;
  if (hostKey != null && typeof hostKey !== "string") return null;
  if (!Number.isInteger(epoch)) return null;
  const events = tail?.events || [];
  const first = events[0];
  const last = events[events.length - 1];
  if (!first || !last) return null;
  if (!Number.isInteger(first.seq) || !Number.isInteger(last.seq) || last.seq <= 0) return null;
  return {
    v: AI_CACHE_SCHEMA,
    hostKey: hostKey || "",
    sessionId,
    epoch,
    seq: last.seq,
    firstSeq: first.seq,
    hasMore: Boolean(tail?.hasMore),
    bytes: Number.isFinite(tail?.bytes) ? tail.bytes : 0,
    events,
    taskRecords: Array.isArray(taskRecords) ? taskRecords : null,
    lastTurnMs: Number.isFinite(lastTurnMs) ? lastTurnMs : 0,
    ts: now
  };
}

/** Which keys a prune should drop: oldest first, until both caps hold.
 *  The newest row is never dropped — it is the one that just arrived, and a single
 *  oversized entry must not churn the store on every write. */
export function selectPrunable(rows, {
  maxEntries = AI_CACHE_MAX_ENTRIES, maxBytes = AI_CACHE_TOTAL_BYTES
} = {}) {
  const sized = [...(rows || [])]
    .sort((a, b) => (a.ts || 0) - (b.ts || 0))
    .map((r) => ({ key: r.key, size: Number.isFinite(r.bytes) ? r.bytes : AI_CACHE_MAX_BYTES }));
  let count = sized.length;
  let total = sized.reduce((n, r) => n + r.size, 0);
  const drop = [];
  for (const row of sized) {
    if (count <= maxEntries && total <= maxBytes) break;
    if (count <= 1) break;
    drop.push(row.key);
    count -= 1;
    total -= row.size;
  }
  return drop;
}

/** Validate a stored entry (object or JSON text); null when unusable. */
export function parseCacheEntry(raw) {
  let entry = raw;
  if (typeof raw === "string") {
    try { entry = JSON.parse(raw); } catch { return null; }
  }
  if (!entry || typeof entry !== "object") return null;
  if (entry.v !== AI_CACHE_SCHEMA) return null;
  if (typeof entry.sessionId !== "string" || !entry.sessionId) return null;
  if (typeof entry.hostKey !== "string") return null;
  if (!Number.isInteger(entry.epoch)) return null;
  if (!Number.isInteger(entry.seq) || entry.seq <= 0) return null;
  if (!Number.isInteger(entry.firstSeq)) return null;
  if (!Array.isArray(entry.events) || entry.events.length === 0) return null;
  if (!Number.isFinite(entry.ts) || entry.ts <= 0) return null;
  if (entry.events[0]?.seq !== entry.firstSeq) return null;
  if (entry.events[entry.events.length - 1]?.seq !== entry.seq) return null;
  return entry;
}

/** May this entry paint the pane while the host hydrate is on its way? */
export function shouldUseCachedSnapshot(raw, {
  hostKey, sessionId, now = Date.now(), maxAgeMs = AI_CACHE_MAX_AGE_MS
} = {}) {
  const entry = parseCacheEntry(raw);
  if (!entry) return false;
  if (entry.hostKey !== (hostKey || "")) return false;
  if (entry.sessionId !== sessionId) return false;
  if (entry.ts > now + 60_000) return false; // clock skew guard, not a reason to trust newer
  if (now - entry.ts > maxAgeMs) return false;
  return true;
}
