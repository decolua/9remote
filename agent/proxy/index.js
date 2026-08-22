/**
 * Proxy server setup and response handler
 */

import { createGunzip, createInflate, createBrotliDecompress } from "zlib";
import httpProxy from "http-proxy";
import { randomUUID } from "crypto";
import { SERVER_PORT } from "../lib/constants.js";
import { rewriteUrl, rewriteHtmlLinks } from "./rewriter.js";
import { getServiceWorkerScript, getSwRegistrationScript } from "./serviceWorker.js";

// Active proxy sessions — ports currently being viewed, addressed by an
// unguessable id rather than by the port itself.
//
// /proxy/* is public, so it answers anyone who reaches the tunnel hostname.
// Keying the URL on the port meant the address was 3000 or 5173 or 8080 — the
// session was the only secret and it wasn't one. The id in the path is the
// secret now, the same shape previewServer.js has always used.
const sessionsById = new Map();  // id → port (number)
const idsByPort = new Map();     // port (number) → id

function normalizePort(port) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  // Proxying to ourselves would launder a request through the agent: it arrives
  // at the private routes from loopback, with a local Host, so neither the
  // origin guard nor the host guard sees anything wrong — and /api/ui/state
  // hands back the permanent key.
  if (n === SERVER_PORT) return null;
  return n;
}

/** @returns {string|null} the session id to put in the URL, null for a bad port */
export function startProxySession(port) {
  const n = normalizePort(port);
  if (n === null) return null;
  // Reopening a window calls start again; a second id would strand the first.
  const existing = idsByPort.get(n);
  if (existing) return existing;
  const id = randomUUID();
  sessionsById.set(id, n);
  idsByPort.set(n, id);
  return id;
}

export function endProxySession(port) {
  const n = normalizePort(port);
  if (n === null) return;
  const id = idsByPort.get(n);
  if (id) sessionsById.delete(id);
  idsByPort.delete(n);
}

/** @returns {number|null} the port this id was minted for */
export function resolveProxySession(id) {
  return typeof id === "string" && id ? (sessionsById.get(id) ?? null) : null;
}

/** Port-keyed check for the bus handler, which arrives over an authed socket. */
export function isProxySessionActive(port) {
  const n = normalizePort(port);
  return n !== null && idsByPort.has(n);
}

/** The id for a port, so the caller can build the URL. */
export function proxySessionId(port) {
  const n = normalizePort(port);
  return n === null ? null : (idsByPort.get(n) ?? null);
}

// ─── Site requests over the transport bus (RTC data channel / WS) ────────────
// The web client's service worker is the consumer: it serves /browse/<port>/
// pages from responses carried here, so sites load without the tunnel HTTP origin.

const SITE_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]);
const SITE_MAX_BODY_B64_CHARS = 700000; // ~512KB binary
const SITE_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
// JSON envelope overhead must stay under the RTC control-channel max (65536)
const SITE_CHUNK_B64_CHARS = 48000;
const SITE_FETCH_TIMEOUT_MS = 60000;
// Hop-by-hop / embedding-hostile headers never pass either direction
const SITE_STRIP_HEADERS = new Set([
  "host", "connection", "cookie", "set-cookie", "content-encoding", "content-length",
  "x-frame-options", "content-security-policy", "strict-transport-security", "transfer-encoding"
]);
// Also dropped outbound: forwarding the browser's accept-encoding makes undici
// hand back a still-compressed body (it only auto-decodes its own default),
// which the client would try to parse as HTML.
const SITE_STRIP_REQUEST_HEADERS = new Set([...SITE_STRIP_HEADERS, "accept-encoding"]);

function siteChunk(socket, payload) {
  socket.emit("site:httpChunk", payload);
}

function siteError(socket, reqId, error) {
  siteChunk(socket, { reqId, seq: 0, total: 1, b64: "", done: true, error });
}

export function setupSiteRequestHandler(socket) {
  socket.on("site:httpRequest", async (data, callback) => {
    if (typeof callback === "function") callback({ ok: true });

    const { reqId, port, method, target, headers = {}, bodyB64 } = data || {};
    if (typeof reqId !== "string" || !reqId) return;
    const portNum = Number(port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return siteError(socket, reqId, "bad-port");
    // Same gate as the HTTP proxy: only ports with a live viewing session
    if (!isProxySessionActive(portNum)) return siteError(socket, reqId, "no-session");
    if (!SITE_METHODS.has(method)) return siteError(socket, reqId, "bad-method");
    if (typeof target !== "string" || !target.startsWith("/")) return siteError(socket, reqId, "bad-target");
    if (typeof bodyB64 === "string" && bodyB64.length > SITE_MAX_BODY_B64_CHARS) return siteError(socket, reqId, "body-too-large");

    const outHeaders = {};
    for (const [key, value] of Object.entries(headers || {})) {
      if (SITE_STRIP_REQUEST_HEADERS.has(key.toLowerCase())) continue;
      outHeaders[key] = value;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SITE_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`http://localhost:${portNum}${target}`, {
        method,
        headers: outHeaders,
        body: bodyB64 ? Buffer.from(bodyB64, "base64") : undefined,
        redirect: "manual",
        signal: controller.signal
      });

      const headersOut = {};
      for (const [key, value] of res.headers) {
        if (!SITE_STRIP_HEADERS.has(key.toLowerCase())) headersOut[key] = value;
      }

      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > SITE_MAX_RESPONSE_BYTES) return siteError(socket, reqId, "too-large");

      const b64 = buf.toString("base64");
      const total = Math.max(1, Math.ceil(b64.length / SITE_CHUNK_B64_CHARS));
      for (let seq = 0; seq < total; seq++) {
        siteChunk(socket, {
          reqId, seq, total,
          ...(seq === 0 ? { status: res.status, headers: headersOut } : {}),
          b64: b64.slice(seq * SITE_CHUNK_B64_CHARS, (seq + 1) * SITE_CHUNK_B64_CHARS),
          done: seq === total - 1
        });
      }
    } catch (err) {
      siteError(socket, reqId, err.name === "AbortError" ? "timeout" : err.message);
    } finally {
      clearTimeout(timer);
    }
  });
}

/**
 * Create decompression stream based on content-encoding
 */
function createDecompressor(encoding) {
  switch (encoding) {
    case "gzip": return createGunzip();
    case "deflate": return createInflate();
    case "br": return createBrotliDecompress();
    default: return null;
  }
}

/**
 * Inject script into HTML at the beginning of <head> to run before any other scripts
 */
function injectScript(html, script) {
  // Inject right after <head> to ensure it runs first
  if (html.includes("<head>")) {
    return html.replace("<head>", "<head>" + script);
  }
  if (html.includes("<HEAD>")) {
    return html.replace("<HEAD>", "<HEAD>" + script);
  }
  // Fallback: try case-insensitive
  const headMatch = html.match(/<head[^>]*>/i);
  if (headMatch) {
    return html.replace(headMatch[0], headMatch[0] + script);
  }
  // Last resort: prepend to document
  return script + html;
}

/**
 * Create and configure proxy server
 */
export function createProxyServer() {''
  const proxy = httpProxy.createProxyServer({ selfHandleResponse: true });
  
  proxy.on("proxyRes", (proxyRes, req, res) => {
    const targetPort = req._proxyTargetPort;
    const sessionId = req._proxySessionId;
    const contentType = proxyRes.headers["content-type"] || "";
    const contentEncoding = proxyRes.headers["content-encoding"] || "";
    const isHtml = contentType.includes("text/html");
    const headers = { ...proxyRes.headers };
    
    // Rewrite redirect location
    if (headers.location) {
      headers.location = rewriteUrl(headers.location, sessionId, targetPort);
    }
    
    // JSON/RSC responses: remove complex rewriting, SW will handle it
    const isJson = contentType.includes("application/json") || contentType.includes("text/x-component");
    if (isJson) {
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
      return;
    }
    
    // JavaScript files: remove complex rewriting, SW will handle it
    const isJs = contentType.includes("javascript") || contentType.includes("text/javascript");
    if (isJs) {
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
      return;
    }
    
    // Non-HTML: pipe through directly
    if (!isHtml) {
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
      return;
    }
    
    // HTML: rewrite links and inject script
    delete headers["content-length"];
    delete headers["content-encoding"];
    
    const decompressor = createDecompressor(contentEncoding);
    const sourceStream = decompressor ? proxyRes.pipe(decompressor) : proxyRes;
    const chunks = [];
    
    sourceStream.on("data", chunk => chunks.push(chunk));
    sourceStream.on("error", (err) => {
      console.error("[Proxy] Decompress error:", err.message);
      res.writeHead(502);
      res.end("Bad Gateway: Decompression failed");
    });
    sourceStream.on("end", () => {
      let html = Buffer.concat(chunks).toString("utf8");
      html = rewriteHtmlLinks(html, sessionId, targetPort);
      const script = getSwRegistrationScript(sessionId, targetPort);
      html = injectScript(html, script);
      res.writeHead(proxyRes.statusCode, headers);
      res.end(html);
    });
  });
  
  return proxy;
}

/**
 * Handle proxy request
 */
export function handleProxyRequest(proxy, req, res, sessionId, targetPath, search) {
  // The id in the path IS the credential here — this route is public, so an
  // unresolvable id is the same answer as no session at all.
  const targetPort = resolveProxySession(sessionId);

  // Serve Service Worker script
  if (targetPort && targetPath === "/sw.js") {
    const swScript = getServiceWorkerScript(sessionId, targetPort);
    res.writeHead(200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Service-Worker-Allowed": "/",
      "Cache-Control": "no-store, no-cache, must-revalidate"
    });
    res.end(swScript);
    return;
  }
  
  if (!targetPort) {
    res.writeHead(401, { "Content-Type": "text/html" });
    res.end(`
      <!DOCTYPE html>
      <html>
        <head><title>Unauthorized</title></head>
        <body style="font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1e293b; color: #94a3b8;">
          <div style="text-align: center;">
            <h1 style="color: #f87171;">401 Unauthorized</h1>
            <p>Please open site through 9Remote first.</p>
          </div>
        </body>
      </html>
    `);
    return;
  }

  req._proxyTargetPort = targetPort;
  req._proxySessionId = sessionId;
  req.url = targetPath + (search || "");
  
  proxy.web(req, res, {
    target: `http://localhost:${targetPort}`,
    changeOrigin: true
  }, (err) => {
    // console.error(`[Proxy] Error for port ${targetPort}:`, err.message);
    res.writeHead(502);
    res.end(`Bad Gateway: ${err.message}`);
  });
}
