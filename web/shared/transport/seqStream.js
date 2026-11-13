// Sequenced control stream — one per PM, per direction.
//
// Outbound: every control envelope is logged with a per-PM monotonic seq in a
// byte-capped ring. "Sent" (a carrier accepted it) and "confirmed" (the peer's
// rs watermark covers it) are different states: a hot-path send only ships the
// never-sent tail, while a carrier event (open/close) replays the whole
// unconfirmed window — that is what survives a lane switch without duplicating
// on the happy path.
// Inbound: a one-door sequencer dedupes, orders and holds out-of-order
// envelopes, requesting the missing range from the peer's ring (NACK) —
// reorder/duplicate/loss across carriers disappear behind it.
//
// Pure logic: no timers, no network, no imports. The PM supplies deps. This
// file is a byte-identical mirror on host (host/transport) and web
// (web/shared/transport) — change both or neither.

// Events reserved for the sequenced stream itself. They ride the stream like
// any envelope (so they are ordered and re-sendable) and are routed by the
// PM's deliver() instead of application handlers.
export const STREAM_EVENTS = {
  ENV: "__env",         // WS carrier wrapper: {event, args, ackId, sq, ep, rs}
  ACK: "__ack",
  GAP: "__gap",         // args[0] = {from, to} — replay this seq range
  GAP_MISS: "__gapmiss" // args[0] = {from} — ring evicted the range; skip the hole
};

// Cap on the eager replay when a carrier (re)opens. Beyond it the receiver's
// NACK pulls the rest from the ring on demand — eager replay stays bounded
// even for a long-lived ring against a freshly connected peer.
const DEFAULT_MAX_REPLAY = 512;

export function newEpoch() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Approximate wire size of args — Buffers exact, objects flat-rated (hot path is Buffer output). */
function argsBytes(args) {
  if (!Array.isArray(args)) return 256;
  let n = 64;
  for (const a of args) {
    if (a == null) continue;
    if (typeof a === "string") n += a.length;
    else if (ArrayBuffer.isView(a) || a.type === "Buffer") n += a.length || 256;
    else if (typeof a === "object") n += 512;
    else n += 8;
  }
  return n;
}

const ENV_BYTES = 128;

export function createOutboundLog({ maxBytes, maxEntries, maxReplayEntries = DEFAULT_MAX_REPLAY }) {
  const entries = new Map(); // seq → {event, args, ackId}
  // Seqs the peer already answered: the command ran, so replaying it would run it twice.
  const acked = new Set();
  let nextSeq = 1;
  let firstSeq = 1;
  let unsentFrom = 1;   // first seq no carrier has accepted yet
  let peerApplied = 0;  // peer's rs watermark — confirmed contiguous
  let bytes = 0;
  let droppedUnsent = 0;

  const sizeOf = (e) => ENV_BYTES + argsBytes(e.args);
  const collect = (from) => {
    const out = [];
    for (let s = from; s < nextSeq; s++) {
      const e = entries.get(s);
      if (e) out.push({ ...e, sq: s });
    }
    return out;
  };

  return {
    get nextSeq() { return nextSeq; },
    get applied() { return peerApplied; },
    get droppedUnsent() { return droppedUnsent; },

    /** Log a new envelope; returns a sequenced copy ({event, args, ackId, sq}). */
    append(env) {
      const sq = nextSeq++;
      const entry = { event: env.event, args: env.args, ackId: env.ackId ?? null };
      entries.set(sq, entry);
      bytes += sizeOf(entry);
      while (entries.size > 1 && (bytes > maxBytes || entries.size > maxEntries)) {
        const oldest = entries.get(firstSeq);
        if (!oldest) { firstSeq++; continue; }
        entries.delete(firstSeq);
        acked.delete(firstSeq);
        bytes -= sizeOf(oldest);
        if (firstSeq >= unsentFrom) droppedUnsent++;
        firstSeq++;
      }
      return { ...entry, sq };
    },

    /** Peer's contiguous watermark (rs field on any inbound envelope). */
    setApplied(n) { if (Number.isInteger(n) && n > peerApplied) peerApplied = n; },

    /** sq accepted by a carrier — sends are in order, so this only moves forward. */
    markSent(sq) {
      if (!Number.isInteger(sq) || sq < unsentFrom) return;
      unsentFrom = sq + 1;
    },

    /** The peer answered this sq: the command already ran, so it leaves the replay window. */
    markAcked(sq) {
      // Past entries were already evicted — tracking them again would leak the set.
      if (Number.isInteger(sq) && sq >= firstSeq) acked.add(sq);
    },

    /** Entries [from..to] inclusive, or null when the ring no longer covers it. */
    range(from, to) {
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < firstSeq || to >= nextSeq || to < from) return null;
      const out = [];
      for (let s = from; s <= to; s++) {
        const e = entries.get(s);
        if (!e) return null;
        out.push({ ...e, sq: s });
      }
      return out;
    },

    /** Hot path: only what no carrier has taken yet (the just-appended tail). */
    unsentList() { return collect(Math.max(unsentFrom, firstSeq)); },

    /** Carrier event (open/close): everything unconfirmed, window-capped. Older
     *  gaps are pulled by the peer's NACK (range serves them from the ring). */
    replayList() {
      const from = Math.max(peerApplied + 1, firstSeq, nextSeq - maxReplayEntries);
      return acked.size ? collect(from).filter((e) => !acked.has(e.sq)) : collect(from);
    },

    clear() { entries.clear(); acked.clear(); nextSeq = 1; firstSeq = 1; unsentFrom = 1; peerApplied = 0; bytes = 0; droppedUnsent = 0; }
  };
}

export function createIntake({ holdMax, gapDeadlineMs, deliver, requestGap, onLoss, onDupe, schedule = setTimeout, clearFn = clearTimeout }) {
  let armed = false;
  let epoch = null;
  let everSequenced = false;
  let applied = 0;   // highest contiguous seq delivered
  let maxSeen = 0;   // highest sq ever seen — the baseline arm() snapshots
  const held = new Map(); // seq → envelope, waiting for a missing predecessor
  let gapTimer = null;
  let gapRequestedFor = 0;
  let paused = false;

  const minHeld = () => (held.size ? Math.min(...held.keys()) : Infinity);

  const drain = () => {
    while (held.size) {
      const env = held.get(applied + 1);
      if (!env) break;
      held.delete(applied + 1);
      applied++;
      deliver(env);
    }
  };

  const advancePastHole = () => {
    const to = minHeld() - 1;
    if (to > applied) {
      if (onLoss) onLoss(applied + 1, to);
      applied = to;
    }
    gapRequestedFor = 0;
    drain();
    checkGap();
  };

  const armDeadline = () => {
    if (gapTimer || paused) return;
    gapTimer = schedule(() => {
      gapTimer = null;
      if (paused || !held.size) return;
      // The request had gapDeadlineMs to land; skip the hole (feature layers re-fill).
      advancePastHole();
    }, gapDeadlineMs);
  };

  const checkGap = () => {
    if (!held.size) {
      if (gapTimer) { clearFn(gapTimer); gapTimer = null; }
      gapRequestedFor = 0;
      return;
    }
    const from = applied + 1;
    const to = minHeld() - 1;
    if (from > to) return;
    if (gapRequestedFor !== from) {
      gapRequestedFor = from;
      requestGap(from, to);
    }
    armDeadline();
  };

  const applyEpoch = (ep) => {
    if (ep == null || ep === epoch) return;
    if (epoch === null) { epoch = ep; return; } // identity learned, not a reset
    // Stream identity changed (peer PM restarted): resync from zero.
    epoch = ep;
    applied = 0;
    held.clear();
    gapRequestedFor = 0;
    if (gapTimer) { clearFn(gapTimer); gapTimer = null; }
  };

  return {
    get armed() { return armed; },
    get applied() { return applied; },
    get maxSeen() { return maxSeen; },

    /** Arm against envelopes that may already have passed through unarmed:
     *  count from the highest sq ever seen, so no false gap fires. */
    arm() { armed = true; applied = maxSeen; },

    /** Inbound envelope (unwrapped, any carrier). */
    push(env) {
      applyEpoch(env?.ep);
      const sq = env?.sq;
      if (!armed || !Number.isInteger(sq)) {
        if (Number.isInteger(sq) && sq > maxSeen) maxSeen = sq;
        deliver(env);
        return;
      }
      if (sq > maxSeen) maxSeen = sq;
      // First sequenced envelope ever (armed before seeing anything): baseline
      // just below it — the peer's ring replays anything older on its own.
      if (!everSequenced) {
        everSequenced = true;
        if (sq > applied + 1) applied = sq - 1;
      }
      if (sq <= applied) { if (onDupe) onDupe(sq); return; }
      if (sq === applied + 1) {
        applied++;
        deliver(env);
        drain();
        checkGap();
        return;
      }
      held.set(sq, env);
      if (held.size > holdMax) { advancePastHole(); return; }
      checkGap();
    },

    /** Sender cannot serve the requested range — skip the hole and continue. */
    gapMissed(from) {
      if (!armed || from !== applied + 1) return;
      advancePastHole();
    },

    /** No carrier ready — freeze the deadline clock (resume re-requests). */
    setPaused(p) {
      paused = p;
      if (p && gapTimer) { clearFn(gapTimer); gapTimer = null; }
      if (!p && held.size) { gapRequestedFor = 0; checkGap(); }
    },

    reset() {
      armed = false; epoch = null; everSequenced = false;
      applied = 0; maxSeen = 0;
      held.clear(); gapRequestedFor = 0;
      if (gapTimer) { clearFn(gapTimer); gapTimer = null; }
    }
  };
}
