// Pure helpers for control-channel routing and diagnostics.
// Extracted verbatim from ProtocolManager.

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
