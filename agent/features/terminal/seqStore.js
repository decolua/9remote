// Monotonic live-output seq per session + a small ring cache of recent chunks for
// gap recovery (plans F + G).
//
// The client tracks lastSeq and detects a scrollback gap on resume from background
// (plan F). When the gap is small it requests just the missing range instead of a
// full reset+replay (plan G): no white flash, no redundant tail fetch. Only LIVE
// chunks carry an advancing seq; daemon-replay chunks snapshot the current seq so
// the client can resync after a full reset+replay fallback. Optional fields — old
// clients ignore them, old agents send none.

const CHUNK_RING = 500; // recent live chunks kept per session for gap recovery
const sessionSeq = new Map();
const sessionChunks = new Map(); // sessionId -> Map(seq -> { data, enc })

export const nextSeq = (sessionId) => {
  const n = (sessionSeq.get(sessionId) ?? 0) + 1;
  sessionSeq.set(sessionId, n);
  return n;
};

export const currentSeq = (sessionId) => sessionSeq.get(sessionId) ?? 0;

// Cache a live chunk for later gap recovery. `data`/`enc` are kept as-received
// from the daemon so the client decodes them exactly like a live chunk.
export const cacheChunk = (sessionId, seq, data, enc) => {
  let m = sessionChunks.get(sessionId);
  if (!m) { m = new Map(); sessionChunks.set(sessionId, m); }
  m.set(seq, { data, enc });
  // Ring eviction — drop the oldest seq when over capacity (any gap spanning an
  // evicted chunk falls back to a full reset+rejoin).
  if (m.size > CHUNK_RING) {
    const oldest = m.keys().next().value;
    m.delete(oldest);
  }
};

// Drop all seq state for a session — call on delete/kill, else the ring keeps
// up to CHUNK_RING chunks per dead session alive for the agent's lifetime.
export const clearSession = (sessionId) => {
  sessionSeq.delete(sessionId);
  sessionChunks.delete(sessionId);
};

// Return the chunks spanning [fromSeq..toSeq] inclusive, or null on miss (any
// chunk evicted/absent → caller falls back to full reset+replay).
export const getGap = (sessionId, fromSeq, toSeq) => {
  const m = sessionChunks.get(sessionId);
  if (!m) return null;
  if (toSeq < fromSeq) return [];
  const out = [];
  for (let s = fromSeq; s <= toSeq; s++) {
    const c = m.get(s);
    if (!c) return null;
    out.push({ seq: s, data: c.data, enc: c.enc });
  }
  return out;
};
