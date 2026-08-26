import { RTC_RESTART, ADAPTER_STATE } from "@/shared/constants/transport";

// Pure decision logic for RTC recovery — no `this`, no timers, no side effects.
// Extracted verbatim from ProtocolManager so the scheduler's cost model is
// testable without standing up a peer connection.

/**
 * Pick the next restart delay and advance the ladder counters.
 *
 * Two-phase recovery: fast backoff (1s/2s/4s) right after failure, then a slow
 * probe ladder that keeps trying P2P while the tunnel carries data. After
 * classifyAfterProbes probes the NAT is classified — "hard" gives up (WS-only),
 * soft/unknown resets the probe cadence so one bad stretch doesn't lock us at
 * the cap forever.
 *
 * @param {{attempts:number, probeAttempts:number, verdict:() => string}} state
 * @returns {{giveUp:true} | {delay:number, isProbe:boolean, attempts:number, probeAttempts:number, verdict?:string}}
 */
export function nextRestartStep({ attempts, probeAttempts, verdict }) {
  const isProbe = attempts >= RTC_RESTART.maxAttempts;
  let delay;
  let nextProbeAttempts = probeAttempts;
  let usedVerdict;

  if (isProbe) {
    delay = RTC_RESTART.probeBackoffMs[probeAttempts] ?? RTC_RESTART.probeBackoffMs.at(-1);
    nextProbeAttempts = probeAttempts + 1;
    // After enough failed probes, classify the NAT. "hard" → give up (WS-only).
    // Soft/unknown → reset the probe cadence.
    if (nextProbeAttempts >= RTC_RESTART.classifyAfterProbes) {
      usedVerdict = verdict?.() ?? "unknown";
      if (usedVerdict === "hard") return { giveUp: true, verdict: usedVerdict, probeAttempts: nextProbeAttempts };
      nextProbeAttempts = 0; // soft/unknown → let the cadence climb again from the first step
    }
  } else {
    delay = RTC_RESTART.backoffMs[attempts] ?? RTC_RESTART.backoffMs.at(-1);
  }

  return {
    delay,
    isProbe,
    attempts: attempts + 1,
    probeAttempts: nextProbeAttempts,
    verdict: usedVerdict
  };
}

/**
 * A peer still inside its natural connect timeout is mid-ICE — killing it on the
 * first tick restarted the loop forever. "wait" reschedules, "teardown" replaces it.
 *
 * The deadline comes from the peer itself. Deriving it here from connectingSince
 * + RTC_CONNECT_TIMEOUT_MS assumed every peer is judged on the 4s answer clock,
 * but one that HAS been answered swaps in the 15s ICE clock — so a peer five
 * seconds into a fifteen-second budget read as expired and was torn down two
 * thirds of the way through the window ICE was deliberately given. That is why
 * a network reporting natVerdict="ok" still climbed to attempt 14.
 * connectingSince is the fallback for an adapter that publishes no deadline.
 *
 * @returns {"wait" | "teardown" | "restart"}
 */
export function restartTimerAction({ state, connectingSince, connectDeadline, now, connectTimeoutMs }) {
  if (state !== ADAPTER_STATE.connecting) return "restart";
  return now < peerDeadline({ connectingSince, connectDeadline, connectTimeoutMs }) ? "wait" : "teardown";
}

/** When this peer's own clock runs out. The caller re-arms to exactly this
 *  instant, so it must not be a second copy of the same formula. */
export function peerDeadline({ connectingSince, connectDeadline, connectTimeoutMs }) {
  return connectDeadline ?? ((connectingSince ?? 0) + connectTimeoutMs);
}

/**
 * Guard for _restartRtc: another recovery path may already have a peer in flight,
 * and a hard-NAT give-up must stand every path down.
 * @returns {"skip-test-disabled" | "skip-given-up" | "skip-in-flight" | "start-fresh" | "restart"}
 */
export function restartRtcAction({ testDisabled, givenUp, rtcState, hasRtc }) {
  if (testDisabled) return "skip-test-disabled";
  if (givenUp) return "skip-given-up";
  if (hasRtc && (rtcState === ADAPTER_STATE.connecting || rtcState === ADAPTER_STATE.open)) return "skip-in-flight";
  if (!hasRtc) return "start-fresh";
  return "restart";
}

// Carrier NAT pools give neighbour IPs for the same network. Compare on the
// /24 so a flip-flop between two STUN egresses isn't treated as a handover.
export function sameNetwork(a, b) {
  const pa = (a || "").split(".");
  const pb = (b || "").split(".");
  return pa.length === 4 && pb.length === 4 && pa[0] === pb[0] && pa[1] === pb[1] && pa[2] === pb[2];
}
