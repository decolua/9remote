import { createGunzip, createInflate, createBrotliDecompress } from "zlib";
import dns from "dns/promises";
import net from "net";
import httpProxy from "http-proxy";
import { randomUUID } from "crypto";
import { SERVER_PORT } from "../lib/constants.js";
import { rewriteUrl, rewriteHtmlLinks } from "./rewriter.js";
import { getServiceWorkerScript, getSwRegistrationScript } from "./serviceWorker.js";

// Active proxy sessions addressed by unguessable ID rather than port number.
const sessionsById = new Map();
const idsByPort = new Map();
// Public-site browsing sessions: approved site hosts (host proxy mode).
const hostSessions = new Set();

function normalizePort(port) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  // Disallow proxying to agent's own port to prevent auth bypass.
  if (n === SERVER_PORT) return null;
  return n;
}

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+\.?$/i;

export function normalizeSiteHost(raw) {
  const host = String(raw || "").trim().toLowerCase().replace(/\.$/, "");
  if (!HOSTNAME_RE.test(host) || host.length > 253) return null;
  if (net.isIP(host)) return null; // literals only ever name the LAN — refuse
  return host;
}

// SSRF guard: every resolved address must be public unicast. The client picks
// the host, so this is the line between "browse a site" and "probe the LAN".
export function isPublicAddress(ip) {
  if (net.isIPv4(ip)) {
    const o = ip.split(".").map(Number);
    if (o[0] === 0 || o[0] === 10 || o[0] === 127) return false;
    if (o[0] === 169 && o[1] === 254) return false;
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return false;
    if (o[0] === 192 && o[1] === 168) return false;
    if (o[0] >= 224) return false; // multicast + reserved
    return true;
  }
  if (!net.isIPv6(ip)) return false;
  const low = ip.toLowerCase();
  if (low === "::" || low === "::1") return false;
  if (/^fe[89ab]/.test(low)) return false; // link-local
  if (/^f[cd]/.test(low)) return false; // unique-local
  if (low.startsWith("::ffff:")) return isPublicAddress(low.slice(7));
  return true;
}

async function resolvePublicSiteHost(host) {
  try {
    const records = await dns.lookup(host, { all: true });
    if (!records.length) return false;
    return records.every((r) => isPublicAddress(r.address));
  } catch {
    return false;
  }
}

export function startProxySession(target) {
  if (typeof target === "string" && !/^\d+$/.test(target.trim())) {
    const host = normalizeSiteHost(target);
    if (!host) return null;
    hostSessions.add(host);
    return `site:${host}`;
  }
  const n = normalizePort(target);
  if (n === null) return null;
  const existing = idsByPort.get(n);
  if (existing) return existing;
  const id = randomUUID();
  sessionsById.set(id, n);
  idsByPort.set(n, id);
  return id;
}

export function endProxySession(target) {
  if (typeof target === "string" && !/^\d+$/.test(target.trim())) {
    const host = normalizeSiteHost(target);
    if (host) {
      hostSessions.delete(host);
      clearSiteCookies(host);
    }
    return;
  }
  const n = normalizePort(target);
  if (n === null) return;
  const id = idsByPort.get(n);
  if (id) sessionsById.delete(id);
  idsByPort.delete(n);
  clearSiteCookies(`:${n}`);
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

// Host-mode cookie jar: pages that need a login keep their session. Keyed by
// cookie domain (suffix-matched like a real browser), cleared when the proxy
// session ends. Every connected client shares one jar — same trust boundary as
// the proxy itself. Page JS never sees these cookies: both wire directions
// strip the headers, the jar is the only store.
const siteCookieJars = new Map(); // domain -> Map(name -> {value, expires})
const JAR_MAX_DOMAINS = 50;
const JAR_MAX_COOKIES_PER_DOMAIN = 40;

export function parseSetCookie(line) {
  const [pair, ...attrs] = String(line || "").split(";");
  const eq = pair.indexOf("=");
  if (eq < 1) return null;
  const name = pair.slice(0, eq).trim();
  if (!name) return null;
  let expiresAt = NaN;
  let maxAge = -1;
  let domain = "";
  for (const attr of attrs) {
    const ck = attr.split("=");
    const key = ck[0].trim().toLowerCase();
    if (key === "max-age") maxAge = Number(ck[1]);
    else if (key === "expires") expiresAt = Date.parse(ck[1]?.trim());
    else if (key === "domain") domain = ck[1].trim().toLowerCase().replace(/^\./, "");
  }
  return { name, value: pair.slice(eq + 1).trim(), expiresAt, maxAge, domain };
}

export function storeSetCookies(host, lines) {
  const now = Date.now();
  for (const line of lines) {
    const c = parseSetCookie(line);
    if (!c) continue;
    // Domain attribute only counts when it covers the setting host — a site
    // can't plant cookies on someone else's name.
    const key = c.domain && (host === c.domain || host.endsWith(`.${c.domain}`)) ? c.domain : host;
    // -1 = session cookie, lives with the jar (epoch parses to 0, a real past time)
    const expires = c.maxAge >= 0 ? now + c.maxAge * 1000
      : Number.isFinite(c.expiresAt) ? c.expiresAt : -1;
    const isDelete = !c.value || (expires >= 0 && expires <= now);
    // One cookie per name across the jars covering this host — remove first,
    // then place, so we never send "sid=a; sid=b".
    for (const [domain, jar] of siteCookieJars) {
      if (host === domain || host.endsWith(`.${domain}`)) jar.delete(c.name);
    }
    if (isDelete) continue;
    let jar = siteCookieJars.get(key);
    if (!jar) {
      if (siteCookieJars.size >= JAR_MAX_DOMAINS) {
        siteCookieJars.delete(siteCookieJars.keys().next().value); // FIFO cap
      }
      jar = new Map();
      siteCookieJars.set(key, jar);
    }
    if (jar.size >= JAR_MAX_COOKIES_PER_DOMAIN && !jar.has(c.name)) continue;
    jar.set(c.name, { value: c.value, expires });
  }
}

export function cookieHeaderFor(host) {
  const now = Date.now();
  const parts = [];
  for (const [domain, jar] of siteCookieJars) {
    if (!(host === domain || host.endsWith(`.${domain}`))) continue;
    for (const [name, c] of jar) {
      if (c.expires >= 0 && c.expires <= now) { jar.delete(name); continue; }
      parts.push(`${name}=${c.value}`);
    }
  }
  return parts.length ? parts.join("; ") : null;
}

export function clearSiteCookies(host) {
  siteCookieJars.delete(host);
  for (const domain of [...siteCookieJars.keys()]) {
    if (host.endsWith(`.${domain}`)) siteCookieJars.delete(domain);
  }
}

// DNS verdicts cached briefly so a page's dozens of assets don't each pay a lookup.
const dnsCache = new Map(); // host -> { ok, ts }
const DNS_TTL_MS = 300000;

async function siteHostAllowed(host) {
  const hit = dnsCache.get(host);
  if (hit && Date.now() - hit.ts < DNS_TTL_MS) return hit.ok;
  const ok = await resolvePublicSiteHost(host);
  dnsCache.set(host, { ok, ts: Date.now() });
  return ok;
}

function siteChunk(socket, payload) {
  socket.emit("site:httpChunk", payload);
}

function siteError(socket, reqId, error) {
  siteChunk(socket, { reqId, seq: 0, total: 1, b64: "", done: true, error });
}

export function setupSiteRequestHandler(socket) {
  socket.on("site:httpRequest", async (data, callback) => {
    if (typeof callback === "function") callback({ ok: true });

    const { reqId, host, port, method, target, headers = {}, bodyB64 } = data || {};
    if (typeof reqId !== "string" || !reqId) return;

    let timer;
    try {
      if (!SITE_METHODS.has(method)) return siteError(socket, reqId, "bad-method");
      if (typeof target !== "string" || !target.startsWith("/")) return siteError(socket, reqId, "bad-target");
      if (typeof bodyB64 === "string" && bodyB64.length > SITE_MAX_BODY_B64_CHARS) return siteError(socket, reqId, "body-too-large");

      let baseUrl;
      // Cookie-jar key: the public host, or ":<port>" for localhost sites (exact
      // match only — a leading colon can never suffix-match a Domain attribute).
      let jarKey = null;
      let siteHost = null;
      if (host !== undefined) {
        siteHost = normalizeSiteHost(host);
        if (!siteHost) return siteError(socket, reqId, "bad-host");
        // Redirect hops (example.com → www.) land on hosts the pane never named;
        // adopt them rather than dead-end the page. The public-unicast resolve
        // below is the boundary, not a session allowlist.
        hostSessions.add(siteHost);
        if (!(await siteHostAllowed(siteHost))) return siteError(socket, reqId, "blocked-host");
        baseUrl = `https://${siteHost}`;
        jarKey = siteHost;
      } else {
        const portNum = Number(port);
        if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return siteError(socket, reqId, "bad-port");
        if (!isProxySessionActive(portNum)) return siteError(socket, reqId, "no-session");
        baseUrl = `http://localhost:${portNum}`;
        jarKey = `:${portNum}`;
      }

      const outHeaders = {};
      for (const [key, value] of Object.entries(headers || {})) {
        if (SITE_STRIP_REQUEST_HEADERS.has(key.toLowerCase())) continue;
        outHeaders[key.toLowerCase()] = value;
      }

      if (siteHost) {
        // Chromium browser fingerprint headers to avoid bot detection on public sites
        outHeaders["user-agent"] = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
        outHeaders["sec-ch-ua"] = '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"';
        outHeaders["sec-ch-ua-mobile"] = "?0";
        outHeaders["sec-ch-ua-platform"] = '"macOS"';
        if (!outHeaders["accept-language"]) {
          outHeaders["accept-language"] = "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7";
        }
        if (!outHeaders["accept"]) {
          outHeaders["accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7";
        }
        if (!outHeaders["sec-fetch-dest"]) outHeaders["sec-fetch-dest"] = "document";
        if (!outHeaders["sec-fetch-mode"]) outHeaders["sec-fetch-mode"] = "navigate";
        if (!outHeaders["sec-fetch-site"]) outHeaders["sec-fetch-site"] = "none";
        if (!outHeaders["upgrade-insecure-requests"]) outHeaders["upgrade-insecure-requests"] = "1";

        // Rewrite or strip proxy-internal referer and origin so upstream sees authentic site traffic
        if (outHeaders.referer) {
          try {
            const refUrl = new URL(outHeaders.referer);
            if (refUrl.pathname.includes("/browse/")) {
              const parts = refUrl.pathname.split("/browse/")[1];
              const slash = parts.indexOf("/");
              const cleanPath = slash !== -1 ? parts.slice(slash) : "/";
              outHeaders.referer = `https://${siteHost}${cleanPath}${refUrl.search}`;
            } else if (refUrl.origin.includes("sites.")) {
              outHeaders.referer = `https://${siteHost}/`;
            }
          } catch {
            delete outHeaders.referer;
          }
        }
        if (outHeaders.origin) {
          if (outHeaders.origin.includes("sites.")) {
            if (method === "GET" || method === "HEAD") delete outHeaders.origin;
            else outHeaders.origin = `https://${siteHost}`;
          }
        }
      }

      const jarCookie = cookieHeaderFor(jarKey);
      if (jarCookie) outHeaders.cookie = jarCookie;

      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), SITE_FETCH_TIMEOUT_MS);

      const res = await fetch(`${baseUrl}${target}`, {
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
      // Login flows ride Set-Cookie on 200s and redirects alike — jar it before
      // the strip list above drops the wire copy.
      if (jarKey && typeof res.headers.getSetCookie === "function" && res.headers.getSetCookie().length) {
        storeSetCookies(jarKey, res.headers.getSetCookie());
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
      if (timer) clearTimeout(timer);
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
