/**
 * Lightweight config-driven HTTP router
 * - Route table with path, method, handler
 * - Public route whitelist (bypass localhost check)
 * - Auto body parsing for POST/PUT
 */

import { parse } from "url";
import { setCorsHeaders, handlePreflight, isAllowedOrigin, isLocalHost } from "../middleware/cors.js";

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => resolve(body));
  });
}

export function jsonOk(res, data = { ok: true }) {
  res.setHeader("Content-Type", "application/json");
  res.writeHead(200);
  res.end(JSON.stringify(data));
}

export function jsonErr(res, code, msg) {
  res.setHeader("Content-Type", "application/json");
  res.writeHead(code);
  res.end(JSON.stringify({ error: msg }));
}

/**
 * Parse JSON body with error handling, returns parsed object or null
 */
export async function parseJsonBody(req, res) {
  try {
    const raw = await readBody(req);
    return JSON.parse(raw || "{}");
  } catch {
    jsonErr(res, 400, "Invalid JSON");
    return null;
  }
}

/**
 * Create router from route config
 * @param {Array<{path: string, method: string, handler: Function, public?: boolean}>} routes
 * @param {Object} options
 * @param {Function} options.fallback - Called when no route matches
 * @returns {Function} HTTP request handler (req, res) => void
 */
export function createRouter(routes, { fallback } = {}) {
  // Pre-build lookup map: "METHOD:/path" → { handler, public }
  const exactMap = new Map();
  const prefixRoutes = [];

  for (const route of routes) {
    const methods = route.method === "*" ? ["GET", "POST", "PUT", "DELETE"] : [route.method];
    for (const m of methods) {
      if (route.path.endsWith("/*")) {
        prefixRoutes.push({ ...route, prefix: route.path.slice(0, -2), method: m });
      } else {
        exactMap.set(`${m}:${route.path}`, route);
      }
    }
  }

  // Collect public paths for fast localhost check
  const publicExact = new Set();
  const publicPrefixes = [];
  for (const route of routes) {
    if (!route.public) continue;
    if (route.path.endsWith("/*")) {
      publicPrefixes.push(route.path.slice(0, -2));
    } else {
      publicExact.add(route.path);
    }
  }

  function isPublic(pathname) {
    if (publicExact.has(pathname)) return true;
    return publicPrefixes.some((p) => pathname.startsWith(p));
  }

  return async (req, res) => {
    // A malformed URL (bad percent-encoding) makes parse() throw
    let parsedUrl;
    try { parsedUrl = parse(req.url, true); }
    catch { jsonErr(res, 400, "Bad request"); return; }
    const { pathname, search } = parsedUrl;
    const routeIsPublic = isPublic(pathname);
    const origin = req.headers.origin;

    // CORS before any early return, so a refusal is still readable by the UI
    // rather than surfacing as an opaque network error.
    setCorsHeaders(res, { origin, isPublic: routeIsPublic });
    if (handlePreflight(req, res)) return;

    // Localhost guard — block non-public routes from remote/tunnel
    const isTunnel = !!req.headers["cf-connecting-ip"];
    const ra = req.socket.remoteAddress;
    // Include ::ffff:127.0.0.1 (IPv4-mapped IPv6) — Node reports this for some
    // localhost connections and it would otherwise 403 the agent UI intermittently.
    const isLocal = ra === "127.0.0.1" || ra === "::1" || ra === "::ffff:127.0.0.1" || ra === "::ffff:0:0:0:1";
    if (!routeIsPublic && (isTunnel || !isLocal)) {
      jsonErr(res, 403, "Forbidden");
      return;
    }

    // The address check above cannot see this case: a page in the user's own
    // browser IS the loopback peer. Only the Origin header distinguishes the
    // agent's UI from any other site the user happens to have open.
    if (!routeIsPublic && !isAllowedOrigin(origin)) {
      jsonErr(res, 403, "Forbidden origin");
      return;
    }

    // And a rebound name defeats both of the above — same-origin to itself, so
    // no Origin at all, arriving from loopback. The Host it must keep is what
    // gives it away.
    if (!routeIsPublic && !isLocalHost(req.headers.host)) {
      jsonErr(res, 403, "Forbidden host");
      return;
    }

    // Exact match
    const key = `${req.method}:${pathname}`;
    const route = exactMap.get(key);
    if (route) {
      try {
        await route.handler(req, res, { pathname, query: parsedUrl.query, search });
      } catch (err) {
        console.error("Error:", req.url, err);
        jsonErr(res, 500, err.message);
      }
      return;
    }

    // Prefix match
    for (const pr of prefixRoutes) {
      if ((pr.method === req.method) && pathname.startsWith(pr.prefix)) {
        try {
          await pr.handler(req, res, { pathname, query: parsedUrl.query, search });
        } catch (err) {
          console.error("Error:", req.url, err);
          jsonErr(res, 500, err.message);
        }
        return;
      }
    }

    // Fallback (static files, etc.)
    if (fallback) {
      try {
        await fallback(req, res, { pathname, search });
      } catch (err) {
        console.error("Error:", req.url, err);
        jsonErr(res, 500, err.message);
      }
      return;
    }

    jsonErr(res, 404, "Not found");
  };
}
