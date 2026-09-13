// Re-ask ladder for a hydrate whose `ai:create` ack never came back. The carrier only
// replays a handful of safe reads on an ack timeout (pmMessaging ACK_RETRY_SAFE) and
// `ai:create` is not one of them, so on a zombie RTC a single dropped frame leaves the
// pane without the host's tail — and with it the load-older affordance — for good, since
// hydrate has no other trigger once the socket is already up.
//
// Pure scheduling decisions only; the caller owns the timer and the send.

// Backoff per attempt, ~10s of cover in total. Long enough to outlive a stalled ack,
// short enough that a user staring at a half-loaded chat sees it fill in.
export const HYDRATE_RETRY_DELAYS_MS = [1200, 3000, 6000];

export function createRetryLadder(delays = HYDRATE_RETRY_DELAYS_MS) {
  let attempt = 0;
  let armed = false;
  return {
    // Milliseconds to wait before re-asking, or null when there is nothing to arm.
    // `connected` false means offline: the send would only sit in the carrier's buffer,
    // and the bus "connect" trigger hydrates again once there is someone to answer.
    schedule(connected) {
      if (armed || !connected || attempt >= delays.length) return null;
      armed = true;
      return delays[attempt++];
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
    }
  };
}
