/**
 * The sites host, for the host's own (embedded) copy of the web app.
 *
 * When the workspace is served by the host on localhost:2208, the browsed site
 * gets its own origin too — http://sites.localhost:<port> — for the same reason
 * the hosted deploy uses sites.9remote.cc: a dev server rendering content the
 * developer did not write must not land on the origin holding the api key or the
 * device-trust tail. Loopback does not make a page trustworthy, only local.
 *
 * This is the host-side twin of the branch web/scripts/injectSitesHost.mjs
 * injects into the Cloudflare worker, and it serves the same files and the same
 * browse scope. The difference is the surface it must keep out: here the whole
 * local API is on the same port, one request away, so an unknown host gets a 404
 * and every path outside the site surface is refused before it is routed.
 */

import { SERVER_PORT } from "./constants.js";

// Sites host → the app hostname it sits under. Loopback only, and exact: the
// hosted deploy recognises its own subdomain exactly, and a name that merely
// resembles these must not become a second way to reach a local site.
export const SITES_HOSTNAMES = new Map([
  ["sites.localhost", "localhost"],
  ["sites.127.0.0.1", "127.0.0.1"]
]);

// Exact paths, mirroring SITES_ALLOWED_PATHS on the web side.
export const SITES_ALLOWED_PATHS = new Set(["/", "/proxy.html", "/sw-site.js", "/swBridgeClaim.js"]);

const BROWSE_PREFIX = "/browse/";

/** Strip the port, keeping a bracketed IPv6 literal intact. */
function bareHost(hostname) {
  const host = String(hostname || "").trim().toLowerCase();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    // An unterminated literal is not a host we recognise either way.
    return end === -1 ? host : host.slice(0, end + 1);
  }
  return host.split(":")[0];
}

/** The ":port" on a host header, or "" when it carries none. */
function portSuffix(hostname) {
  const host = String(hostname || "");
  const i = host.lastIndexOf(":");
  // A bare IPv6 literal has colons of its own and no port.
  return i > host.lastIndexOf("]") ? host.slice(i) : "";
}

export function isSitesHost(hostname) {
  return SITES_HOSTNAMES.has(bareHost(hostname));
}

/** Every app origin that may frame the shell for this sites host. */
export function appOriginsFor(hostname, protocol = "http:") {
  const appHost = SITES_HOSTNAMES.get(bareHost(hostname));
  if (!appHost) return [];
  const port = portSuffix(hostname) || `:${SERVER_PORT}`;
  const scheme = protocol === "https:" ? "https:" : "http:";
  // The host answers on any loopback name, and the shell cannot know which one
  // the app was opened on — so all of them are named. A single fixed name would
  // leave a page opened on another loopback spelling unable to frame the shell.
  // No [::1]: frame-ancestors rejects an IPv6 literal as a source expression,
  // and Chrome then drops the whole directive.
  const names = appHost === "localhost" ? ["localhost", "127.0.0.1"] : [appHost];
  return names.map((n) => `${scheme}//${n}${port}`);
}

/**
 * What this host serves for a path, or null for everything else.
 * Returns the path to read, plus the headers no other file on this origin may
 * be served without.
 */
export function routeSitesLocalRequest(pathname, hostname) {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) return null;
  let path;
  try {
    // Resolve traversal before matching, or /browse/../api/ui/state would pass.
    path = new URL(pathname, "http://sites.invalid").pathname;
  } catch {
    return null;
  }

  const headers = {
    // Chrome decides an origin's cluster from the first response it sees, so an
    // inconsistent header leaves this origin sharing a process with the app.
    "Origin-Agent-Cluster": "?1",
    // The site is framed by the shell, and the shell by the app — a different
    // origin here, unlike the hosted deploy, so the app has to be named or the
    // load fails. Never a wildcard: the shell relays requests that end at the
    // user's own localhost.
    "Content-Security-Policy": `frame-ancestors 'self' ${appOriginsFor(hostname).join(" ")}`
  };

  if (path.startsWith(BROWSE_PREFIX)) return { kind: "browse", path: "/proxy.html", headers };
  if (!SITES_ALLOWED_PATHS.has(path)) return null;

  const asset = path === "/" ? "/proxy.html" : path;
  // Scope "/" is wider than the worker's own path, so the browser needs the
  // header to allow it — without this the registration is rejected.
  if (asset === "/sw-site.js") headers["Service-Worker-Allowed"] = "/";
  // Shell and worker are read once per load and must not survive an update.
  headers["Cache-Control"] = "no-store";
  return { kind: "asset", path: asset, headers };
}
