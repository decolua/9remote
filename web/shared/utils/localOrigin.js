// Origin classification for pages served by the host itself.
// Loopback + RFC1918 private ranges count as "the local network" — those pages
// get the lean local treatment (WS-direct carrier, no RTC/DO signaling).
// SECURITY: this only picks the carrier; admission still requires the key TAIL
// on every connection, and the host's loopback auto-approve stays 127.0.0.1-only.
import { AGENT_PORT, LOCAL_HOST_ORIGIN, LOCAL_AGENT_ORIGIN } from "@/shared/constants/API";

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** True loopback only (localhost / 127.0.0.1 / ::1) — the same machine as the host. */
export function isLoopbackOrigin() {
  if (typeof window === "undefined") return false;
  const h = window.location.hostname;
  return h === "localhost" || h === "::1" || h === "[::1]" || h.startsWith("127.") || h.endsWith(".localhost");
}

/** Check if running on the same machine as the host (loopback or Tauri desktop app). */
export function isSameMachine() {
  if (typeof window === "undefined") return false;
  return isLoopbackOrigin() || !!window.__TAURI__;
}

/** Check if running inside host workspace (Tauri app, agent port, or static host build). */
export function isHostEnvironment() {
  if (typeof window === "undefined") return false;
  return (
    !!window.__TAURI__ ||
    window.location.port === String(AGENT_PORT) ||
    process.env.NEXT_PUBLIC_STATIC_EXPORT === "1" ||
    // Dev escape hatch for hot-reload work on host-env UI (tab/data are proxied
    // to a local host by next.config rewrites). No build pipeline sets this.
    // NEXT_PUBLIC_DEV_AGENT is the legacy spelling, kept so old shells still work.
    process.env.NEXT_PUBLIC_DEV_HOST === "1" || process.env.NEXT_PUBLIC_DEV_AGENT === "1"
  );
}
export const isAgentEnvironment = isHostEnvironment;

/** Loopback or a private LAN address (10/8, 172.16/12, 192.168/16). */
export function isLocalHostNetwork() {
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
export const isLocalAgentNetwork = isLocalHostNetwork;

/**
 * Host endpoint a page on this machine must address itself by, or null when
 * the caller should keep its own origin.
 *
 * A page the host serves IS the host: its own origin, nothing to override.
 * A page on the web dev server is loopback but is NOT the host — its origin
 * hosts no host API, so a login there would fall through to the Worker and
 * then be blocked by a dead tunnel. Point it at the host directly.
 *
 * `data` is the host's own /api/ui/state, whose loopbackOrigin is the address
 * the host knows itself by; the constant is the fallback for the one case that
 * has no payload yet (a fresh dev page that never asked).
 *
 * ponytail: same-machine only. A browser on another LAN host reaches
 * 127.0.0.1 as itself — that needs localIp plus LOCAL_UI_ORIGINS widened;
 * add when a remote browser is actually a case.
 */
export function hostOriginFrom(data) {
  if (typeof window === "undefined") return null;
  // Only a loopback page can reach a loopback host; a LAN or tunnel page keeps
  // its own origin (the host there is reached through the tunnel, not 127.0.0.1).
  if (!isLoopbackOrigin()) return null;
  // Listening on the host's own port means the host is serving this page:
  // it IS the host, so its own origin is already the right answer.
  if (window.location.port === String(AGENT_PORT)) return null;
  return data?.loopbackOrigin || LOCAL_HOST_ORIGIN || LOCAL_AGENT_ORIGIN;
}
export const agentOriginFrom = hostOriginFrom;
