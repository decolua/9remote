// Standalone STUN probe — asks a public STUN server "what is my public IP?"
// without touching the DO signaling relay or the agent. Used to decide whether a
// resume happened on a DIFFERENT network than the one that made us give up on
// RTC: a give-up must only be lifted on evidence (new public IP), never on a
// timer, or every app switch re-spams the DO with offers the NAT will refuse.
import { STUN_PROBE } from "@/shared/constants/transport";

// Parse the public IP out of an SDP candidate line ("... <ip> <port> typ srflx").
export function srflxIpOf(candidate) {
  if (!candidate || !candidate.includes("typ srflx")) return null;
  return candidate.split(" ")[4] || null;
}

/**
 * Gather a server-reflexive candidate and return its public IP.
 * Resolves null on timeout / no srflx (UDP blocked) — callers treat null as
 * "no evidence" and keep whatever state they had.
 * @param {object} [opts]
 * @param {string[]} [opts.urls] STUN urls (defaults to STUN_PROBE.urls)
 * @param {number} [opts.timeoutMs]
 * @param {Function} [opts.PeerConnection] injectable for tests
 */
export function probePublicIp({ urls, timeoutMs, PeerConnection } = {}) {
  const PC = PeerConnection || (typeof RTCPeerConnection !== "undefined" ? RTCPeerConnection : null);
  if (!PC) return Promise.resolve(null);
  const iceServers = [{ urls: urls || STUN_PROBE.urls }];
  return new Promise((resolve) => {
    let pc, timer, done = false;
    const finish = (ip) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { pc.onicecandidate = null; pc.close(); } catch {}
      resolve(ip);
    };
    try {
      pc = new PC({ iceServers, iceCandidatePoolSize: 0 });
    } catch {
      return resolve(null);
    }
    timer = setTimeout(() => finish(null), timeoutMs ?? STUN_PROBE.timeoutMs);
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return finish(null); // gathering ended with no srflx → UDP blocked
      const ip = srflxIpOf(candidate.candidate);
      if (ip) finish(ip);
    };
    // A data channel is enough to trigger ICE gathering (no media permissions).
    try {
      pc.createDataChannel("probe");
      pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => finish(null));
    } catch {
      finish(null);
    }
  });
}

// Marker for "we probed and there is no public IP" (UDP/STUN blocked). Distinct
// from null ("we don't know"), so a network that consistently blocks STUN keeps a
// stable baseline instead of looking like a change on every resume.
export const NO_PUBLIC_IP = "no-public-ip";

/**
 * Decide whether a give-up should be lifted after a resume.
 * Evidence-based: only a DIFFERENT public IP proves the network changed.
 * Both arguments should come from the SAME source (probePublicIp) so a missing
 * srflx is compared like for like.
 * @param {string|null} prevIp  public IP recorded when we gave up
 * @param {string|null} nowIp   public IP probed on resume (null = probe failed)
 * @returns {boolean}
 */
export function shouldRearmOnIpChange(prevIp, nowIp) {
  if (!nowIp) return false;  // probe failed → no evidence → keep the give-up
  if (!prevIp) return true;  // never recorded one → can't rule out a change, try once
  return nowIp !== prevIp;
}
