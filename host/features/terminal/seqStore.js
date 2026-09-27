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
// Gap packet bound in RAW bytes, sized so the WORST wire form still fits one SCTP
// message: a legacy peer (no caps.binOut) gets the packet re-encoded to base64 at
// the send door — 45KB raw → ~60KB b64 + envelope < 64KB cap, same margin as the
// output slices. A single chunk is itself ≤ OUTPUT_SLICE_BYTES, so a lone chunk
// always fits too.
import { OUTPUT_SLICE_BYTES } from "./constants.js";
const GAP_PACKET_MAX_RAW = OUTPUT_SLICE_BYTES;
const sessionSeq = new Map();
const sessionChunks = new Map(); // sessionId -> Map(seq -> { data, size })
const sessionBytes = new Map();  // sessionId -> total bytes held in its ring

export const nextSeq = (sessionId) => {
  const n = (sessionSeq.get(sessionId) ?? 0) + 1;
  sessionSeq.set(sessionId, n);
  return n;
};

export const currentSeq = (sessionId) => sessionSeq.get(sessionId) ?? 0;

// Cache a live chunk for later gap recovery. Chunks are Buffers — the canonical
// internal form since emit; b64 only exists on the daemon leg and at the send
// door for peers that never announced caps.binOut.
export const cacheChunk = (sessionId, seq, data) => {
  let m = sessionChunks.get(sessionId);
  if (!m) { m = new Map(); sessionChunks.set(sessionId, m); }
  const size = data?.length || 0;
  m.set(seq, { data, size });
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
    out.push({ seq: lastSeq, enc: "bin", data: Buffer.concat(parts) });
    parts = [];
    partsBytes = 0;
  };
  for (let s = fromSeq; s <= toSeq; s++) {
    const c = m.get(s);
    if (!c) return null;
    // Flush BEFORE the chunk that would cross the cap, never after — the last
    // chunk must not overshoot. Bound in raw bytes so the legacy b64 re-encode
    // at the send door also stays under CONTROL_RTC_MAX_BYTES.
    if (parts.length && partsBytes + c.size > GAP_PACKET_MAX_RAW) flush();
    parts.push(c.data);
    partsBytes += c.size;
    lastSeq = s;
  }
  flush();
  return out;
};
