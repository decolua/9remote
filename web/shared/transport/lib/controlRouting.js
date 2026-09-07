// Pure helpers for control-channel routing and diagnostics.
// Extracted verbatim from ProtocolManager.

// Approximate serialized size of control args — cheap upper bound for SCTP limit check.
export function controlBytes(args) {
  let bytes = 0;
  for (const a of args) bytes += valueBytes(a);
  return bytes;
}

// Binary payloads must be measured by byte length, not by JSON.stringify: a
// TypedArray serializes to {"0":1,"1":2,…} — many times its real size, which would
// push every binary control payload over the SCTP cap and force it off RTC for no
// reason. On the wire it costs its own length (v2 frame part / socket.io
// attachment). Mirrors _valueBytes in agent/transport/ProtocolManager.js.
function valueBytes(v) {
  if (v == null) return 4;
  if (typeof v === "string") return v.length;
  if (v instanceof ArrayBuffer) return v.byteLength;
  if (ArrayBuffer.isView(v)) return v.byteLength;
  if (Array.isArray(v)) {
    let n = 2;
    for (const x of v) n += valueBytes(x) + 1;
    return n;
  }
  if (typeof v === "object") {
    let n = 2;
    for (const k of Object.keys(v)) n += k.length + 3 + valueBytes(v[k]);
    return n;
  }
  return JSON.stringify(v)?.length ?? 8;
}

// Short per-tab tag appended to deviceId so concurrent tabs don't collide.
export function randomTag() {
  return Math.random().toString(36).slice(2, 10);
}


// Sum inbound traffic (bytesReceived + responsesReceived) over the nominated/selected
// ICE candidate-pairs of a RTCStatsReport. Returns null if no selected pair exists yet.
// Used by the liveness probe to verify whether bytes or STUN keepalives are flowing.
export function selectedIceTraffic(report) {
  let total = 0, found = false;
  for (const v of report.values()) {
    if (v.type === "candidate-pair" && (v.nominated || v.selected)) {
      found = true;
      total += (v.bytesReceived ?? 0) + (v.responsesReceived ?? 0);
    }
  }
  return found ? total : null;
}
export const selectedIceResponses = selectedIceTraffic;

/**
 * Pick the best ready adapter for a channel: the profile's preferred adapter if
 * it's up, else the highest-priority one that supports the channel.
 */
export function pickAdapter(adapters, profile, channel) {
  const cfg = profile.channels[channel];
  if (!cfg) return null;

  const candidates = [...adapters.values()]
    .filter((a) => a.supports(channel) && a.ready);

  if (!candidates.length) return null;

  // Dynamic priority resolution — highest score wins, extensible for any future protocol
  candidates.sort((a, b) => {
    const pB = b.getPriority ? b.getPriority(channel) : (b.constructor.priority[channel] ?? 0);
    const pA = a.getPriority ? a.getPriority(channel) : (a.constructor.priority[channel] ?? 0);
    if (pB !== pA) return pB - pA;
    // Tie-breaker: if scores are identical, use the profile preference
    if (cfg.prefer) {
      if (b.constructor.id === cfg.prefer) return 1;
      if (a.constructor.id === cfg.prefer) return -1;
    }
    return 0;
  });

  return candidates[0] || null;
}
