// Pure helpers for detecting gaps in the terminal live-output seq stream.
// The agent stamps every live output chunk with a monotonic per-session seq.
// The client tracks lastSeq; on resume from background it classifies the first
// live chunk: contiguous → keep buffer (no reset, no race); leap → gap → reset
// + replay tail. Non-live chunks (replay tail / history prefix) must NOT flow
// through classifyLiveChunk — they sync lastSeq via syncAfterReplay instead.
//
// Plan F: client-side gap detection, no handshake round-trip.

export const GAP_INIT = "init";     // first ever chunk (no prior lastSeq)
export const GAP_NONE = "none";     // contiguous — no gap, fast path
export const GAP_DETECTED = "gap";  // missing chunks → reset + replay
export const GAP_STALE = "stale";   // duplicate / late / reordered ≤ lastSeq

/**
 * Classify an incoming LIVE chunk against the last rendered seq.
 * @param {number|null|undefined} lastSeq - last live seq rendered, or null on first ever.
 * @param {number} chunkSeq - seq stamped by the agent on this live chunk.
 * @returns {string} one of GAP_*
 */
export function classifyLiveChunk(lastSeq, chunkSeq) {
  if (lastSeq == null) return GAP_INIT;
  if (chunkSeq === lastSeq + 1) return GAP_NONE;
  if (chunkSeq > lastSeq + 1) return GAP_DETECTED;
  return GAP_STALE; // chunkSeq <= lastSeq — duplicate/late/reordered
}

/**
 * After a rejoin replay paints the tail, set lastSeq to the tail's final seq so
 * the next live chunk (tailSeq+1) is contiguous instead of falsely flagged gap.
 * @param {number} replayTailSeq - seq of the last byte in the replayed tail.
 * @returns {number} the new lastSeq value.
 */
export function syncAfterReplay(replayTailSeq) {
  return replayTailSeq;
}
