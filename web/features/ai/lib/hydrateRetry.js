// Re-ask ladder for a hydrate whose `ai:create` ack never came back — the one request
// whose loss leaves a chat pane empty with no other way back. The carrier retries
// ACK_RETRY_SAFE reads over WS on an ack timeout, and `ai:create` is on that list, so a
// dropped frame normally recovers at the transport. What this ladder covers is the case
// where that fallback cannot land at all: `_pickAdapter` finds no ready carrier, the
// send goes to the buffer, and nothing answers it until a "connect" that — on an RTC
// that is open but silent — never fires.
//
// Pure scheduling decisions only; the caller owns the timer and the send.

// Backoff per attempt, ~10s of cover in total. Long enough to outlive a stalled ack,
// short enough that a user staring at a half-loaded chat sees it fill in.
export const HYDRATE_RETRY_DELAYS_MS = [1200, 3000, 6000];

// Which `ai:create` ack the pane may apply. Two rules, and they are the whole of it:
//   · the newest round owns the gate — an older ack must stand down;
//   · UNLESS this round's snapshot carries events the store does not have. The release
//     timeout re-asks every ~5s, so a host slower than that supersedes every round in
//     flight: every snapshot was dropped and the pane kept the view it woke up with,
//     while the refresh button (which asks without the ladder) worked. Newer is newer,
//     whichever round asked for it.
// Two ways a superseded ack is still refused:
//   · its snapshot is at or below the watermark — applying it would walk the view
//     backwards over events already folded in;
//   · the log was replaced since it was asked for (`sameLog` false). Its seqs belong to
//     the conversation that just ended, and seq alone cannot tell: a /clear restarts at 1,
//     so the stale snapshot's HIGH seq would read as newer than the fresh log's.
export function shouldApplyHydrateAck({ isNewest, snapshotSeq = 0, appliedSeq = 0, sameLog = true }) {
  if (isNewest) return true;
  if (!sameLog) return false;
  return (snapshotSeq || 0) > (appliedSeq || 0);
}

export function createRetryLadder(delays = HYDRATE_RETRY_DELAYS_MS) {
  let attempt = 0;
  let armed = false;
  return {
    // Milliseconds to wait before re-asking, or null when there is nothing to arm.
    // `connected` false means offline: the send would only sit in the carrier's buffer,
    // and the bus "connect" trigger hydrates again once there is someone to answer.
    //
    // Past the last rung it repeats that one rather than stopping: a host that is up
    // answers in one round-trip and the ladder resets, and `requestHydrate` re-arms
    // through the one debounced door, so this costs one `ai:create` every 6s — worth it
    // against a pane that spins forever over a session the host is still holding.
    schedule(connected) {
      if (armed || !connected) return null;
      armed = true;
      return delays[Math.min(attempt++, delays.length - 1)];
    },
    // The caller's timer fired — the next failure may arm the following rung.
    fired() {
      armed = false;
    },
    // An ack landed, whenever it carried a log or not: the host was reached, so a
    // later outage starts the ladder over rather than resuming mid-way.
    answered() {
      armed = false;
      attempt = 0;
    },
    // Every rung spent: the ladder is past its backoff and repeating the last one, so
    // nothing about this ask is making progress. Drives the pane's "couldn't load" state
    // — not a stop, the re-ask keeps coming. Offline is not exhaustion; the bus "connect"
    // trigger re-arms when there is someone to ask.
    exhausted() {
      return attempt >= delays.length;
    }
  };
}
