// Monotonic live-output seq per session + a ring cache of recent chunks for
// gap recovery (plans F + G).
//
// The client tracks lastSeq and detects a scrollback gap on resume from background
// (plan F). When the gap is recoverable it requests just the missing range instead
// of a full reset+replay (plan G): no white flash, no redundant tail fetch. Only LIVE
// chunks carry an advancing seq; daemon-replay chunks snapshot the current seq so
// the client can resync after a full reset+replay fallback. Optional fields — old
// clients ignore them, old agents send none.

// Ring capacity is measured in BYTES, not chunk count: a streaming TUI agent emits
// tens of small chunks per second, so a count-based ring only covered ~10s — far
// shorter than a phone app-switch, which then fell back to reset+replay and lost
// everything above the join tail.
const RING_MAX_BYTES = 4 * 1024 * 1024; // per session
// Gap packet bound in b64 wire bytes (chunks are cached as b64 strings, so c.size
// IS the wire cost). 60KB b64 + envelope stays under the 64KB SCTP message cap, so
// a refill packet never detours off the RTC control DC. A single chunk may exceed
// it (a full 45KB slice is ~61KB b64) — that packet travels alone, still under cap.
const GAP_PACKET_MAX_B64 = 60 * 1024;
const sessionSeq = new Map();
const sessionChunks = new Map(); // sessionId -> Map(seq -> { data, enc, size })
const sessionBytes = new Map();  // sessionId -> total bytes held in its ring

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
  const size = typeof data === "string" ? data.length : (data?.length || 0);
  m.set(seq, { data, enc, size });
  let bytes = (sessionBytes.get(sessionId) ?? 0) + size;
  // Ring eviction — drop the oldest seqs until under capacity (any gap spanning an
  // evicted chunk falls back to a full reset+rejoin).
  while (bytes > RING_MAX_BYTES && m.size > 1) {
    const oldest = m.keys().next().value;
    bytes -= m.get(oldest).size;
    m.delete(oldest);
  }
  sessionBytes.set(sessionId, bytes);
};

// Drop all seq state for a session — call on delete/kill, else the ring keeps
// its chunks alive for the agent's lifetime.
export const clearSession = (sessionId) => {
  sessionSeq.delete(sessionId);
  sessionChunks.delete(sessionId);
  sessionBytes.delete(sessionId);
};

// Return the chunks spanning [fromSeq..toSeq] inclusive, or null on miss (any
// chunk evicted/absent → caller falls back to full reset+replay).
// Consecutive chunks are merged into packets so a multi-minute gap travels as a
// handful of messages instead of thousands. Each packet carries the seq of its
// LAST chunk — the client only needs the range boundary to advance lastSeq, and
// dedups retransmits by that seq.
export const getGap = (sessionId, fromSeq, toSeq) => {
  const m = sessionChunks.get(sessionId);
  if (!m) return null;
  if (toSeq < fromSeq) return [];
  const out = [];
  let parts = [];
  let partsBytes = 0;
  let lastSeq = 0;
  const flush = () => {
    if (!parts.length) return;
    out.push({ seq: lastSeq, enc: "b64", data: Buffer.concat(parts).toString("base64") });
    parts = [];
    partsBytes = 0;
  };
  for (let s = fromSeq; s <= toSeq; s++) {
    const c = m.get(s);
    if (!c) return null;
    // Flush BEFORE the chunk that would cross the cap, never after — the last
    // chunk must not overshoot. c.size is the b64 string length (the wire form),
    // so the packet + envelope stays under CONTROL_RTC_MAX_BYTES.
    if (parts.length && partsBytes + c.size > GAP_PACKET_MAX_B64) flush();
    parts.push(c.enc === "b64" ? Buffer.from(c.data, "base64") : Buffer.from(c.data, "utf-8"));
    partsBytes += c.size;
    lastSeq = s;
  }
  flush();
  return out;
};
