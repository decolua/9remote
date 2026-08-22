// The sites host — a second origin whose only job is to be somewhere else.
//
// Browsed local servers render on this hostname instead of the app's, so a
// script inside one cannot reach the app's localStorage (device-trust tail),
// sessionStorage (apiKey) or cookies. Same registrable domain, so the browser
// still treats the service worker registration as same-site and does not block
// it the way it blocks cross-site ones; different origin, so storage is split.
//
// Kept deliberately thin: this host serves the proxy page, the worker, and the
// browse scope. Nothing else — no API, no app pages, no signaling.

// sites host → the one app origin allowed to frame it. The shell relays
// requests that end at the user's own localhost, so a page that could frame it
// would be reaching into their machine. proxy.html checks the sender in JS;
// this is the same rule stated where a regression in that check cannot reach.
const SITES_HOSTS = new Map([
  ["sites.9remote.cc", "https://9remote.cc"],
  ["sites-dev.9remote.cc", "https://dev.9remote.cc"],
  // `next dev` never reaches this module — it has no hostname branch — so the
  // dev entry only matters under `wrangler dev`, which serves on 3000 too.
  ["sites.localhost", "http://localhost:3000"]
]);

export function isSitesHost(hostname) {
  if (typeof hostname !== "string") return false;
  // Exact match only — a substring test would accept sites.9remote.cc.evil.tld.
  return SITES_HOSTS.has(hostname.toLowerCase().split(":")[0]);
}

export const SITES_ALLOWED_PATHS = new Set(["/", "/proxy.html", "/sw-site.js"]);

const BROWSE_PREFIX = "/browse/";

// Present on every response: Chrome decides the origin's cluster from the first
// one it sees, so an inconsistent header would leave the origin sharing a
// process with the app.
function baseHeaders(hostname) {
  const appOrigin = SITES_HOSTS.get(String(hostname || "").toLowerCase().split(":")[0]);
  return {
    "Origin-Agent-Cluster": "?1",
    // No wildcard, and no fallback when the host is unknown: an unrecognised
    // host gets 'none' and can be framed by nobody at all.
    "Content-Security-Policy": `frame-ancestors ${appOrigin || "'none'"}`
  };
}

/**
 * What, if anything, this host serves for a path.
 * Returns null for everything outside the three files and the browse scope —
 * the caller turns that into a 404 rather than falling through to the app.
 */
export function routeSitesRequest(pathname, hostname = "sites.9remote.cc") {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) return null;

  // Resolve traversal before matching, or /browse/../api/connect would pass.
  let path;
  try {
    path = new URL(pathname, "https://sites.invalid").pathname;
  } catch {
    return null;
  }

  if (path.startsWith(BROWSE_PREFIX)) {
    return { kind: "browse", headers: baseHeaders(hostname) };
  }
  if (!SITES_ALLOWED_PATHS.has(path)) return null;

  const asset = path === "/" ? "/proxy.html" : path;
  const headers = baseHeaders(hostname);
  // Scope "/" is wider than the worker's own path, so the browser needs the
  // header to allow it — without this the registration is rejected.
  if (asset === "/sw-site.js") headers["Service-Worker-Allowed"] = "/";
  return { kind: "asset", asset, headers };
}
