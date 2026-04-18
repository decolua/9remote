/**
 * Lightweight config-driven HTTP router
 * - Route table with path, method, handler
 * - Public route whitelist (bypass localhost check)
 * - Auto body parsing for POST/PUT
 */

import { parse } from "url";

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
    const parsedUrl = parse(req.url, true);
    const { pathname, search } = parsedUrl;

    // Localhost guard — block non-public routes from remote/tunnel
    const isTunnel = !!req.headers["cf-connecting-ip"];
    const isLocal = req.socket.remoteAddress === "127.0.0.1" || req.socket.remoteAddress === "::1";
    if (!isPublic(pathname) && (isTunnel || !isLocal)) {
      jsonErr(res, 403, "Forbidden");
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
