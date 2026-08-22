/**
 * CORS + origin guard for the local HTTP API.
 *
 * The router gates non-public routes on the peer being loopback. A browser IS
 * loopback, so that check never excluded the case that matters: a page the user
 * has open in another tab, posting to localhost:2208. Every response also
 * carried Access-Control-Allow-Origin: *, which meant such a page could read
 * the reply — enough to mint a pairing code, read it back, enable auto-approve,
 * and pair itself.
 *
 * Requests with no Origin header are allowed through. That is not a hole: the
 * header is added by browsers, and the same-origin policy this defends only
 * exists in a browser. The agent's own Node callers — the CLI's health poll,
 * hookManager's notify — have no Origin and are unaffected by CORS either way.
 */

import { LOCAL_UI_ORIGINS } from "../lib/constants.js";

/** Is this a request a browser may make to a private route? */
export function isAllowedOrigin(origin) {
  if (origin == null || origin === "") return true; // not a browser
  return LOCAL_UI_ORIGINS.includes(origin);         // exact, including scheme and port
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

/**
 * Was this request addressed to us by a local name?
 *
 * The Origin check above has a gap the address check cannot see either: DNS
 * rebinding. A page served from evil.com, whose A record then flips to
 * 127.0.0.1, reaches this server with requests that are SAME-origin to itself —
 * so no Origin header at all, and a peer address that is loopback. Both guards
 * pass and it reads whatever it likes, including the permanent key.
 *
 * What it cannot change is the Host header: the page has to keep calling itself
 * evil.com for the rebind to be same-origin. So a Host that is not a local name
 * is the signature of that attack, and nothing legitimate produces it — the UI,
 * the CLI's own polling and the Tauri shell all address localhost or 127.0.0.1.
 * The tunnel sends its own hostname, which is why this only gates private routes.
 */
export function isLocalHost(hostHeader) {
  if (!hostHeader) return true; // HTTP/1.0 or a raw socket — not a browser
  const host = String(hostHeader).trim().toLowerCase();
  // Strip the port, keeping bracketed IPv6 intact.
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return LOCAL_HOSTNAMES.has(name);
}

/**
 * The value for Access-Control-Allow-Origin, or null to send none.
 *
 * Never "*". Public routes are called cross-origin by the web app, whose origin
 * varies per deploy, so the caller's own origin is echoed back — which grants
 * exactly the caller, not everyone. Private routes grant only the local UI.
 */
export function corsOriginFor(origin, isPublic) {
  if (!origin) return null;
  // A real browser never sends these, but echoing one back would hand out the
  // wildcard this exists to remove, or name an origin nothing can match.
  if (origin === "*" || origin === "null") return null;
  if (isPublic) return origin;
  return LOCAL_UI_ORIGINS.includes(origin) ? origin : null;
}

export function setCorsHeaders(res, { origin, isPublic } = {}) {
  const allow = corsOriginFor(origin, isPublic);
  if (allow) {
    res.setHeader("Access-Control-Allow-Origin", allow);
    // The allowed origin now varies by caller, so caches must key on it.
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

export function handlePreflight(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return true;
  }
  return false;
}
