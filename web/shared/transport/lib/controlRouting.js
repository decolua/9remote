// Pure helpers for control-channel routing and diagnostics.
// Extracted verbatim from ProtocolManager.

// Approximate serialized size of control args — cheap upper bound for SCTP limit check.
export function controlBytes(args) {
  let bytes = 0;
  for (const a of args) {
    if (a == null) bytes += 4;
    else if (typeof a === "string") bytes += a.length;
    else bytes += JSON.stringify(a).length;
  }
  return bytes;
}

// Short per-tab tag appended to deviceId so concurrent tabs don't collide.
export function randomTag() {
  return Math.random().toString(36).slice(2, 10);
}

// TEMP DIAGNOSTIC — remove once the RTC restart loop is fixed.
// Names the call site that triggered a restart/disconnect so the loop's driver
// is identifiable from the log instead of guessed.
export function callerTrace(depth = 3) {
  const lines = (new Error().stack || "").split("\n").slice(2, 2 + depth);
  return lines
    .map((l) => (l.match(/at\s+([\w.<>_$]+)/) || [])[1] || "?")
    .filter((n) => n && n !== "?")
    .join("<");
}

// Sum responsesReceived over the nominated/selected ICE candidate-pairs of a
// RTCStatsReport. Returns null if no selected pair exists yet (still gathering).
// Used by the resume probe to tell a live DC (counter grows from STUN keepalives)
// from a frozen/zombie one (counter flat) without any agent cooperation.
export function selectedIceResponses(report) {
  let total = 0, found = false;
  for (const v of report.values()) {
    if (v.type === "candidate-pair" && (v.nominated || v.selected)) {
      found = true;
      total += v.responsesReceived ?? 0;
    }
  }
  return found ? total : null;
}

/**
 * Pick the best ready adapter for a channel: the profile's preferred adapter if
 * it's up, else the highest-priority one that supports the channel.
 */
export function pickAdapter(adapters, profile, channel) {
  const cfg = profile.channels[channel];
  if (!cfg) return null;

  const candidates = [...adapters.values()]
    .filter((a) => a.supports(channel) && a.ready);

  if (cfg.prefer) {
    const preferred = candidates.find((a) => a.constructor.id === cfg.prefer);
    if (preferred) return preferred;
  }
  candidates.sort((a, b) =>
    (b.constructor.priority[channel] ?? 0) - (a.constructor.priority[channel] ?? 0)
  );
  return candidates[0] || null;
}
