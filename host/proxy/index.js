import { createGunzip, createInflate, createBrotliDecompress } from "zlib";
import httpProxy from "http-proxy";
import { randomUUID } from "crypto";
import { SERVER_PORT } from "../lib/constants.js";
import { rewriteUrl, rewriteHtmlLinks } from "./rewriter.js";
import { getServiceWorkerScript, getSwRegistrationScript } from "./serviceWorker.js";

// Active proxy sessions addressed by unguessable ID rather than port number.
const sessionsById = new Map();
const idsByPort = new Map();

function normalizePort(port) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  // Disallow proxying to agent's own port to prevent auth bypass.
  if (n === SERVER_PORT) return null;
  return n;
}

export function startProxySession(port) {
  const n = normalizePort(port);
  if (n === null) return null;
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

export function resolveProxySession(id) {
  return typeof id === "string" && id ? (sessionsById.get(id) ?? null) : null;
}

export function isProxySessionActive(port) {
  const n = normalizePort(port);
  return n !== null && idsByPort.has(n);
}

export function proxySessionId(port) {
  const n = normalizePort(port);
  return n === null ? null : (idsByPort.get(n) ?? null);
}

// Site requests over transport bus served via client service worker.

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
// Drop accept-encoding so upstream doesn't return compressed bodies.
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

function createDecompressor(encoding) {
  switch (encoding) {
    case "gzip": return createGunzip();
    case "deflate": return createInflate();
    case "br": return createBrotliDecompress();
    default: return null;
  }
}

function injectScript(html, script) {
  if (html.includes("<head>")) {
    return html.replace("<head>", "<head>" + script);
  }
  if (html.includes("<HEAD>")) {
    return html.replace("<HEAD>", "<HEAD>" + script);
  }
  const headMatch = html.match(/<head[^>]*>/i);
  if (headMatch) {
    return html.replace(headMatch[0], headMatch[0] + script);
  }
  return script + html;
}

export function createProxyServer() {''
  const proxy = httpProxy.createProxyServer({ selfHandleResponse: true });

  proxy.on("proxyRes", (proxyRes, req, res) => {
    const targetPort = req._proxyTargetPort;
    const sessionId = req._proxySessionId;
    const contentType = proxyRes.headers["content-type"] || "";
    const contentEncoding = proxyRes.headers["content-encoding"] || "";
    const isHtml = contentType.includes("text/html");
    const headers = { ...proxyRes.headers };

    if (headers.location) {
      headers.location = rewriteUrl(headers.location, sessionId, targetPort);
    }

    const isJson = contentType.includes("application/json") || contentType.includes("text/x-component");
    if (isJson) {
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
      return;
    }

    const isJs = contentType.includes("javascript") || contentType.includes("text/javascript");
    if (isJs) {
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
      return;
    }

    if (!isHtml) {
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
      return;
    }

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

export function handleProxyRequest(proxy, req, res, sessionId, targetPath, search) {
  const targetPort = resolveProxySession(sessionId);

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
    res.writeHead(502);
    res.end(`Bad Gateway: ${err.message}`);
  });
}
