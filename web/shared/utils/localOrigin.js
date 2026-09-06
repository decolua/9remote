// Origin classification for pages served by the agent itself.
// Loopback + RFC1918 private ranges count as "the local network" — those pages
// get the lean local treatment (WS-direct carrier, no RTC/DO signaling).
// SECURITY: this only picks the carrier; admission still requires the key TAIL
// on every connection, and the agent's loopback auto-approve stays 127.0.0.1-only.
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** True loopback only (localhost / 127.0.0.1 / ::1) — the same machine as the agent. */
export function isLoopbackOrigin() {
  if (typeof window === "undefined") return false;
  const h = window.location.hostname;
  return h === "localhost" || h === "::1" || h === "[::1]" || h.startsWith("127.");
}

/** Loopback or a private LAN address (10/8, 172.16/12, 192.168/16). */
export function isLocalAgentNetwork() {
  if (isLoopbackOrigin()) return true;
  if (typeof window === "undefined") return false;
  const m = IPV4.exec(window.location.hostname);
  if (!m || m.slice(1).some((o) => Number(o) > 255)) return false;
  const a = Number(m[1]), b = Number(m[2]);
  if (a === 10) return true;                          // 10.0.0.0/8
  if (a === 192 && b === 168) return true;            // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
  return false;
}
