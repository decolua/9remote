// Stream start params and link heuristics for the browser pane.
// Local (LAN/loopback) links keep a crisp 1.25x raster without saturating the
// data channel (2x quadruples tile count and causes frame drops).
export const STREAM_QUALITY_LOCAL = 85;
/** Stream start params a local link earns; {} keeps the host defaults (1.2x, q85). */
export function localStreamParams(isLocal) {
  return isLocal ? { scale: Math.min(1.25, window.devicePixelRatio || 1), quality: STREAM_QUALITY_LOCAL } : {};
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
// Client-side QoL heuristic (NOT a security control): same-machine web origin
// or a LAN adapter link — both can carry the sharp stream.
export const isLocalLink = (connectionMode) =>
  connectionMode === "local"
  || LOOPBACK_HOSTS.has(typeof window !== "undefined" ? window.location.hostname : "");
